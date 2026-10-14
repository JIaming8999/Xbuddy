// server/fuyao.js — 扶摇（同花顺金融数据 API）Provider 适配层
// 文档：https://fuyao.aicubes.cn/docs/api-reference/overview/  ·  MCP：https://fuyao.aicubes.cn/docs/mcp/overview
//
// 设计原则（对齐 v4 Evidence-first 硬约束）：
//  · 所有真实取数经 callApi，统一 X-api-key 头 + 超时 + ≥500ms 节流 + 限流退避重试 1 次
//  · 响应信封 {code,message,request_id,data}；业务错误 HTTP 200 + code≠0 → 抛 FuyaoError
//  · mapError 为纯函数：错误码 → {category, fallback, hint}；fallback 仅 network/timeout/2001/5xx 为 true
//  · 3001/3002/3004/2003（标的不存在/未就绪/类型不支持/无权限）绝不回退 mock，诚实降级为缺失
//  · deriveReportPeriod 为纯函数：按披露滞后保守推算最近"已完整披露"的报告期 yyyy-N
//  · key 只从环境变量读取，绝不落日志、绝不入库、绝不入 git
//
// 降级开关：FUYAO_FALLBACK_MOCK=1 时，仅对 fallback=true 的失败允许回落 mock（显式 label=mock）；
//           否则一律诚实缺失。数据缺失不编数、失败不静默。

const BASE = () => (process.env.FUYAO_BASE_URL || "https://fuyao.aicubes.cn").replace(/\/+$/, "");
const KEY = () => process.env.FUYAO_API_KEY || "";

// ---------- 节流（≥500ms 间隔） ----------
const MIN_GAP_MS = 500;
let lastCallAt = 0;
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function throttle() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

// ---------- 错误对象 ----------
export class FuyaoError extends Error {
  constructor(code, message, extra = {}) {
    super(message || String(code));
    this.name = "FuyaoError";
    this.code = code; // number（业务码）或字符串（"NETWORK"/"TIMEOUT"/"HTTP_429"/"BAD_RESPONSE"）
    this.request_id = extra.request_id || null;
    this.endpoint = extra.endpoint || null;
    this.httpStatus = extra.httpStatus ?? null;
  }
}

// ---------- mapError：错误码 → 降级决策（纯函数） ----------
// fallback=true 的类别才允许在 FUYAO_FALLBACK_MOCK=1 时回落 mock；其余一律诚实缺失。
const ERROR_MAP = {
  // 参数类（调用方 bug）——不回退，应修正入参
  1001: { category: "param_error", fallback: false, hint: "必填参数缺失" },
  1002: { category: "param_error", fallback: false, hint: "参数格式非法" },
  1003: { category: "param_error", fallback: false, hint: "参数取值越界" },
  1004: { category: "param_error", fallback: false, hint: "参数相互冲突" },
  // 认证/权限
  2001: { category: "auth_error", fallback: true, hint: "API Key 缺失或无效，可回落 mock（需开启 FUYAO_FALLBACK_MOCK）" },
  2003: { category: "permission_error", fallback: false, hint: "该数据能力未开放外部接入，不回退、诚实标注缺失" },
  2004: { category: "permission_error", fallback: false, hint: "该数据为同花顺AI客户端专用，未开放外部接入，不回退、诚实标注缺失" },
  // 数据可用性——绝不回退（回退即编数）
  3001: { category: "not_found", fallback: false, hint: "标的不存在，诚实标注缺失" },
  3002: { category: "not_ready", fallback: false, hint: "数据尚未就绪，诚实标注缺失" },
  3003: { category: "unsupported", fallback: false, hint: "查询暂不支持" },
  3004: { category: "unsupported", fallback: false, hint: "数据类型不支持，诚实标注缺失" },
  // 限流
  4001: { category: "rate_limit", fallback: false, hint: "触发限流，退避后重试，不回退" },
  // 上游异常——可回退
  5001: { category: "upstream_error", fallback: true, hint: "上游异常，可回落 mock（需开启 FUYAO_FALLBACK_MOCK）" },
  5002: { category: "upstream_error", fallback: true, hint: "上游超时，可回落 mock（需开启 FUYAO_FALLBACK_MOCK）" },
  5003: { category: "upstream_error", fallback: true, hint: "上游返回异常，可回落 mock（需开启 FUYAO_FALLBACK_MOCK）" },
  // 传输层
  NETWORK: { category: "network", fallback: true, hint: "网络不可达，可回落 mock（需开启 FUYAO_FALLBACK_MOCK）" },
  TIMEOUT: { category: "timeout", fallback: true, hint: "请求超时，可回落 mock（需开启 FUYAO_FALLBACK_MOCK）" },
  BAD_RESPONSE: { category: "bad_response", fallback: true, hint: "响应无法解析，可回落 mock（需开启 FUYAO_FALLBACK_MOCK）" },
  HTTP_429: { category: "rate_limit", fallback: false, hint: "HTTP 429 限流，退避后重试，不回退" },
  HTTP_401: { category: "auth_error", fallback: true, hint: "HTTP 401 未认证，可回落 mock（需开启 FUYAO_FALLBACK_MOCK）" },
  HTTP_403: { category: "permission_error", fallback: false, hint: "HTTP 403 无权限，诚实标注缺失" },
};

export function mapError(code) {
  const entry = ERROR_MAP[code];
  if (entry) return { code, ...entry };
  // 未识别码：默认不回退（宁可缺失，不可编数）
  return { code, category: "unknown", fallback: false, hint: `未识别错误码 ${code}，按不回退处理` };
}

/** 该失败是否允许回落 mock（需显式开启 FUYAO_FALLBACK_MOCK=1 且类别可回退） */
export function allowMockFallback(code) {
  const m = mapError(code);
  return m.fallback && process.env.FUYAO_FALLBACK_MOCK === "1";
}

// ---------- deriveReportPeriod：报告期保守推算（纯函数） ----------
// 报告期格式 yyyy-N：N=1 一季报(约4月底披露)、2 中报(约8月底)、3 三季报(约10月底)、4 年报(次年4月底)。
// 保守取"最近已完整披露"的报告期，避免拿未披露期编数：
//   1-4 月 → (Y-1)-3   上年三季报（上年10月底已披露；上年年报、本年一季报均可能未出）
//   5-8 月 → Y-1       本年一季报（4月底已披露）
//   9-10月 → Y-2       本年中报（8月底已披露）
//   11-12月→ Y-3       本年三季报（10月底已披露）
export function deriveReportPeriod(date = new Date()) {
  const Y = date.getFullYear();
  const M = date.getMonth() + 1;
  if (M <= 4) return `${Y - 1}-3`;
  if (M <= 8) return `${Y}-1`;
  if (M <= 10) return `${Y}-2`;
  return `${Y}-3`;
}

// ---------- callApi：统一 HTTP 客户端 ----------
export async function callApi(path, query = {}, opts = {}) {
  const key = KEY();
  if (!key) {
    throw new FuyaoError(2001, "未配置 FUYAO_API_KEY", { endpoint: path });
  }
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxRetries = opts.retries ?? 1; // 限流退避重试 1 次

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    await throttle();
    const url = new URL(BASE() + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url.toString(), {
        method: "GET",
        headers: { "X-api-key": key, Accept: "application/json" },
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const code = e && (e.name === "AbortError" || e.code === "ABORT_ERR") ? "TIMEOUT" : "NETWORK";
      if (attempt <= maxRetries && code === "TIMEOUT") continue; // 超时退避重试一次
      throw new FuyaoError(code, `请求 ${path} 失败：${e && e.message ? e.message : code}`, { endpoint: path });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      if (attempt <= maxRetries) {
        await sleep(1200); // 限流退避
        continue;
      }
      throw new FuyaoError("HTTP_429", "HTTP 429 限流", { endpoint: path, httpStatus: 429 });
    }
    if (res.status === 401 || res.status === 403) {
      throw new FuyaoError(`HTTP_${res.status}`, `HTTP ${res.status}`, { endpoint: path, httpStatus: res.status });
    }
    if (res.status >= 500) {
      if (attempt <= maxRetries) {
        await sleep(800);
        continue;
      }
      throw new FuyaoError("BAD_RESPONSE", `HTTP ${res.status}`, { endpoint: path, httpStatus: res.status });
    }

    let env;
    try {
      env = await res.json();
    } catch {
      throw new FuyaoError("BAD_RESPONSE", "响应无法解析为 JSON", { endpoint: path, httpStatus: res.status });
    }

    const code = env && typeof env.code === "number" ? env.code : null;
    if (code === 0) {
      return { code: 0, message: env.message, request_id: env.request_id || null, data: env.data, endpoint: path };
    }
    // 业务错误（HTTP 200 + code≠0）
    const bizCode = code === null ? "BAD_RESPONSE" : code;
    if ((bizCode === 4001) && attempt <= maxRetries) {
      await sleep(1200);
      continue;
    }
    throw new FuyaoError(bizCode, (env && env.message) || `业务错误 code=${bizCode}`, {
      request_id: env && env.request_id, endpoint: path, httpStatus: res.status,
    });
  }
}

// ---------- 端点封装（返回 {code,message,request_id,data,endpoint}） ----------
// 行情
export const getSnapshot = (thscodes, opts) =>
  callApi("/api/a-share/prices/snapshot", { thscodes: Array.isArray(thscodes) ? thscodes.join(",") : thscodes }, opts);

export const getHistorical = (thscode, start, end, adjust = "forward", opts) =>
  callApi("/api/a-share/prices/historical", { thscode, interval: "1d", start, end, adjust }, opts);

// 财务
export const getIndicators = (thscode, report = deriveReportPeriod(), opts) =>
  callApi("/api/a-share/financials/indicators", { thscode, report }, opts);

export const getIncomeStatements = (thscode, period = "annual", limit = 4, opts) =>
  callApi("/api/a-share/financials/income-statements", { thscode, period, limit }, opts);

// 标的检索 / 消歧
export const searchTickers = (q, { asset_type = "a-share", limit = 10, exchange } = {}, opts) =>
  callApi("/api/meta/tickers/search", { q, asset_type, limit, exchange }, opts);

// 指数
export const getIndexCatalog = (tag = "cn_concept", opts) =>
  callApi("/api/a-share-index/catalog/ths-index-list", { tag }, opts);

export const getIndexConstituents = (thscode, opts) =>
  callApi("/api/a-share-index/constituents/ths-stock-list", { thscode }, opts);

export const getIndexSnapshot = (thscodes, opts) =>
  callApi("/api/a-share-index/prices/snapshot", { thscodes: Array.isArray(thscodes) ? thscodes.join(",") : thscodes }, opts);

export const getIndexHistorical = (thscode, start, end, opts) =>
  callApi("/api/a-share-index/prices/historical", { thscode, interval: "1d", start, end }, opts);

// 特色数据（市场情绪）
export const getHotStockList = (period = "day", opts) =>
  callApi("/api/a-share/special-data/hot-stock-list", { period }, opts);

export const getSkyrocketList = (period = "day", opts) =>
  callApi("/api/a-share/special-data/skyrocket-list", { period }, opts);

export const getDragonTiger = (board_type = "all", date, opts) =>
  callApi("/api/a-share/special-data/dragon-tiger-list", { board_type, date }, opts);

export const getAnomalyStock = (thscodes, opts) =>
  callApi("/api/a-share/special-data/anomaly-analysis-stock", { thscodes: Array.isArray(thscodes) ? thscodes.join(",") : thscodes }, opts);

// 资讯事件库（注意：文档标注"暂未开放外部接入"，真实调用大概率 2003；search_news 走诚实降级）
export const searchEvents = (query, opts) =>
  callApi("/api/news/events/search", { query, search_param: "event_name", size: 20 }, opts);

// 除复权事件流（分红/送股/配股）——get_events 的最接近替代证据面
export const getAdjustmentFactors = (thscode, opts) =>
  callApi("/api/a-share/corporate-actions/adjustment-factors", { thscode }, opts);

// ---------- 启动自检 / 状态 ----------
/** 轻量健康检查：用 tickers/search 探活，返回 {ok, request_id, latencyMs} 或抛错 */
export async function ping() {
  const t0 = Date.now();
  const env = await searchTickers("600519", { limit: 1 }, { timeoutMs: 6000 });
  return { ok: true, request_id: env.request_id, latencyMs: Date.now() - t0, count: (env.data && env.data.item || []).length };
}

/** 数据源状态（供 /api/data-source-status）：不泄露 key 明文 */
export function describeProvider() {
  const key = KEY();
  return {
    provider: "fuyao",
    base_url: BASE(),
    key_configured: Boolean(key),
    key_fingerprint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
    fallback_mock: process.env.FUYAO_FALLBACK_MOCK === "1",
  };
}
