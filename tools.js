// server/tools.js — 能力/工具注册表 + 数据 Provider 适配层
// 设计（方案 v2 M1/M8.1/M11）：
//  · 工具契约：名称/描述/入参 schema/风险等级/超时/数据源标签/MCP 对应工具名
//  · MockProvider 返回构造数据，全部显式标注 label='mock'（README 与 UI 均展示）
//  · 异常注入开关：timeout/missing/conflict/stale/fail 五种，对应五条降级路径，供测试与演示
//  · 真实数据源（扶摇）：DATA_PROVIDER=fuyao 时走 server/fuyao.js 真实取数，label='real'，证据卡带 endpoint+request_id
//  · 降级：仅 network/timeout/2001/5xx 且 FUYAO_FALLBACK_MOCK=1 才回落 mock（label='mock'）；
//          3001/3002/3004/2003 等绝不回退，诚实降级为缺失（数据缺失不编数、失败不静默）
import * as fuyao from "./fuyao.js";

// ---------- 构造数据集（demo_dataset，非真实行情，仅用于演示） ----------
const DATASET = {
  "000001.SZ": { name: "平安银行", price: 11.28, change_pct: 0.62, volume_wan: 8921, pe: 4.9, pb: 0.52, roe: 10.8, revenue_yoy: -3.2, net_profit_yoy: 1.1, debt_ratio: 91.2 },
  "600519.SH": { name: "贵州茅台", price: 1502.5, change_pct: -0.84, volume_wan: 321, pe: 22.6, pb: 8.1, roe: 31.2, revenue_yoy: 12.4, net_profit_yoy: 11.8, debt_ratio: 16.4 },
  "600309.SH": { name: "万华化学", price: 78.36, change_pct: 1.24, volume_wan: 1450, pe: 14.2, pb: 2.6, roe: 18.9, revenue_yoy: 5.6, net_profit_yoy: -8.3, debt_ratio: 58.7 },
  "600036.SH": { name: "招商银行", price: 34.72, change_pct: 0.31, volume_wan: 4522, pe: 6.1, pb: 0.89, roe: 15.4, revenue_yoy: -2.8, net_profit_yoy: 0.6, debt_ratio: 90.1 },
  "000300.SH": { name: "沪深300", price: 3712.4, change_pct: 0.42, volume_wan: 15230, pe: 11.8, pb: 1.24, roe: 10.1, revenue_yoy: 4.1, net_profit_yoy: 3.2, debt_ratio: null },
};

const NEWS_POOL = [
  { title: "公司发布三季度业绩预告，归母净利润同比小幅增长", sentiment: "neutral", source: "构造资讯A", date: "2026-10-08" },
  { title: "行业产能投放放缓，主要产品价格环比企稳", sentiment: "positive", source: "构造资讯B", date: "2026-10-05" },
  { title: "公司公告拟注销部分回购股份", sentiment: "neutral", source: "构造公告", date: "2026-09-28" },
  { title: "监管就行业规范征求意见，短期或影响渠道库存", sentiment: "negative", source: "构造资讯C", date: "2026-09-20" },
  { title: "机构调研热度环比上升，关注新产品线进展", sentiment: "positive", source: "构造资讯D", date: "2026-09-12" },
];

const ANNOUNCE_POOL = [
  { title: "2026 年第三季度报告", type: "定期报告", date: "2026-10-25" },
  { title: "关于回购注销部分股份的公告", type: "公司治理", date: "2026-09-28" },
  { title: "对外投资设立控股子公司的公告", type: "投资并购", date: "2026-09-10" },
];

// ---------- 异常注入（方案 v2 M11） ----------
export const anomalyState = { mode: "none" }; // none | timeout | missing | conflict | stale | fail
export function setAnomaly(mode) {
  anomalyState.mode = ["none", "timeout", "missing", "conflict", "stale", "fail"].includes(mode) ? mode : "none";
}

const NOW = "2026-10-13";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 工具契约 ----------
// mcp 字段标注该工具对应的扶摇 MCP 工具名（https://fuyao.aicubes.cn/docs/mcp/overview），便于双向映射。
// 注：get_valuation / get_announcements / get_events 在扶摇暂无直接对应端点（见 executeFuyao 诚实降级）。
export const TOOL_CONTRACTS = [
  {
    name: "get_quote",
    mcp: "get_a_share_prices_snapshot",
    description: "查询股票或指数的行情快照（最新价、涨跌幅、成交量）。用于回答'现在价格/涨跌'类问题。",
    risk: "read",
    timeoutMs: 5000,
    params: { type: "object", properties: { symbol: { type: "string", description: "证券代码，如 000001.SZ / 600519.SH / 000300.SH" } }, required: ["symbol"] },
  },
  {
    name: "get_kline",
    mcp: "get_a_share_prices_historical",
    description: "查询历史日K线（近 N 个交易日收盘价序列）。用于描述近期走势特征。",
    risk: "read",
    timeoutMs: 6000,
    params: { type: "object", properties: { symbol: { type: "string" }, days: { type: "number", description: "交易日数量，默认 20" } }, required: ["symbol"] },
  },
  {
    name: "get_financials",
    mcp: "get_a_share_financials_indicators",
    description: "查询财务摘要（营收/净利同比、ROE、资产负债率）。用于基本面梳理。",
    risk: "read",
    timeoutMs: 5000,
    params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "get_valuation",
    mcp: null,
    description: "查询估值指标（PE/PB）。支持多源对比，可用于核对不同数据源的口径差异。（扶摇无估值端点时诚实降级）",
    risk: "read",
    timeoutMs: 5000,
    params: { type: "object", properties: { symbol: { type: "string" }, with_sources: { type: "boolean", description: "是否返回多源对比，默认 true" } }, required: ["symbol"] },
  },
  {
    name: "search_news",
    mcp: "get_news_events_search",
    description: "检索与证券相关的资讯/新闻，返回标题、情感倾向、来源与日期。",
    risk: "read",
    timeoutMs: 7000,
    params: { type: "object", properties: { symbol: { type: "string" }, keyword: { type: "string", description: "可选检索关键词" } }, required: ["symbol"] },
  },
  {
    name: "get_announcements",
    mcp: null,
    description: "查询公司公告列表（标题、类型、日期）。（扶摇暂无公告端点时诚实降级）",
    risk: "read",
    timeoutMs: 5000,
    params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "get_events",
    mcp: "get_a_share_corporate_actions_adjustment_factors",
    description: "查询事件日历（业绩披露、解禁、分红等预定事件）。",
    risk: "read",
    timeoutMs: 5000,
    params: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
  {
    name: "calc",
    mcp: null,
    description: "对给定数值做简单计算（同比、占比、区间涨幅等），返回计算过程与结果。避免口算出错。",
    risk: "read",
    timeoutMs: 3000,
    params: { type: "object", properties: { expression: { type: "string", description: "算式，如 (12.4-11.8)/11.8*100" }, purpose: { type: "string" } }, required: ["expression"] },
  },
  {
    name: "export_report",
    mcp: null,
    description: "将研究备忘录导出并发送到外部（演示用外部动作）。需要用户审批。",
    risk: "external",
    timeoutMs: 5000,
    params: { type: "object", properties: { format: { type: "string" }, target: { type: "string", description: "导出目标标识（演示用）" } }, required: ["format"] },
  },
  // —— 新增（扶摇真实数据能力，P2）——
  {
    name: "resolve_ticker",
    mcp: "get_meta_tickers_search",
    description: "按名称/代码跨市场检索并消歧证券标的，返回候选 thscode/名称/市场。用于把'贵州茅台'等中文名解析为标准代码。",
    risk: "read",
    timeoutMs: 6000,
    params: { type: "object", properties: { query: { type: "string", description: "名称或代码关键词，如 贵州茅台 / 600519" }, asset_type: { type: "string", description: "资产类型过滤，默认 a-share" } }, required: ["query"] },
  },
  {
    name: "get_market_sentiment",
    mcp: "get_a_share_special_data_hot_stock_list / get_a_share_special_data_dragon_tiger_list / get_a_share_special_data_anomaly_analysis_stock",
    description: "查询市场情绪面：热股榜、龙虎榜、个股异动。用于短线情绪与资金关注度梳理。可选按个股查异动。",
    risk: "read",
    timeoutMs: 8000,
    params: { type: "object", properties: { symbol: { type: "string", description: "可选，个股 thscode；给定则附带该股当日异动原因" }, scope: { type: "string", description: "market=全市场情绪（默认）" } }, required: [] },
  },
  {
    name: "get_index_overview",
    mcp: "get_a_share_index_catalog_ths_index_list / get_a_share_index_constituents_ths_stock_list / get_a_share_index_prices_snapshot",
    description: "查询指数/板块概览：行情快照、成分股数量与前若干大权重。用于行业/主题景气与结构分析。",
    risk: "read",
    timeoutMs: 8000,
    params: { type: "object", properties: { symbol: { type: "string", description: "指数 thscode，如 000300.SH / 886042.TI" }, tag: { type: "string", description: "可选，板块标签 cn_concept/industry/region/tszs" } }, required: ["symbol"] },
  },
];

// 仅走构造数据、不依赖 DATASET 单标的查找的工具
const STANDALONE_TOOLS = new Set(["resolve_ticker", "get_market_sentiment", "get_index_overview"]);

// ---------- 工具执行（含异常注入与降级标注） ----------
// 总入口：按 DATA_PROVIDER 分流。mock（或未配置）→ executeMock（构造数据）；fuyao → executeFuyao（真实取数）。
export async function executeTool(name, args, ctx = {}) {
  const contract = TOOL_CONTRACTS.find((t) => t.name === name);
  if (!contract) return { ok: false, error: `未知工具: ${name}`, degraded: true };
  if (process.env.DATA_PROVIDER === "fuyao") return executeFuyao(name, args, contract);
  return executeMock(name, args, contract);
}

// ---------- Mock Provider（构造数据）：DATA_PROVIDER=mock 或 fuyao 降级回退时执行 ----------
async function executeMock(name, args, contract) {
  // 新增 3 工具不依赖 DATASET 单标的查找，走独立分支
  if (STANDALONE_TOOLS.has(name)) return mockStandalone(name, args);

  const label = process.env.DATA_PROVIDER === "mock" ? "mock" : "real";
  const mode = anomalyState.mode;

  if (mode === "timeout") {
    await sleep(Math.min(contract.timeoutMs + 400, 2500));
    return { ok: false, error: `工具 ${name} 调用超时（> ${contract.timeoutMs}ms）`, degraded: true, notice: { level: "warn", category: "tool_failure", message: `${name} 超时，已降级跳过并记录，不生成'正常'结论` } };
  }
  if (mode === "fail") {
    return { ok: false, error: `工具 ${name} 返回 500（注入故障）`, degraded: true, notice: { level: "warn", category: "tool_failure", message: `${name} 调用失败，已降级跳过并记录` } };
  }

  const symRaw = (args.symbol || "000001.SZ").toUpperCase();
  const sym = normalizeSymbol(symRaw);
  const row = DATASET[sym];
  if (!row) {
    return {
      ok: true, degraded: true, label, source: name,
      notice: { level: "warn", category: "data_missing", message: `代码 ${sym} 不在构造数据集中，数据缺失，已标注` },
      data: { missing: true, symbol: sym, hint: "构造数据集覆盖 000001.SZ / 600519.SH / 600309.SH / 600036.SH / 000300.SH" },
    };
  }

  if (mode === "missing") {
    return {
      ok: true, degraded: true, label, source: name,
      notice: { level: "warn", category: "data_missing", message: `${sym} 的${name}字段缺失（注入），已标注为数据缺失` },
      data: { missing_fields: ["roe", "debt_ratio"], symbol: sym, partial: true },
    };
  }
  if (mode === "stale") {
    return {
      ok: true, degraded: true, label, source: name,
      metric: "stale_data", value_text: `${sym} 的${name}数据时点为 2025-06-30（已过期）`, unit: "", caliber: "过期数据，口径未更新", as_of: "2025-06-30",
      notice: { level: "warn", category: "data_stale", message: `${sym} 的${name}数据已过期（时点 2025-06-30，注入），已标注为过期数据，不作为最新口径使用` },
      data: { stale: true, symbol: sym, as_of: "2025-06-30" },
    };
  }

  switch (name) {
    case "get_quote":
      return okOut(label, name, sym, "price", `收盘价 ${row.price}（${NOW}）`, `${row.price}`, "元", "日线收盘价", {
        symbol: sym, name: row.name, price: row.price, change_pct: row.change_pct, volume_wan: row.volume_wan, as_of: NOW,
      });
    case "get_kline": {
      const days = Math.min(Number(args.days || args.limit) || 20, 60);
      const closes = synthKline(row.price, days);
      return okOut(label, name, sym, "close_series", `近${days}个交易日收盘价序列（末值 ${closes[closes.length - 1]}）`, `${closes[closes.length - 1]}`, "元", "前复权日收盘", {
        symbol: sym, days, closes, as_of: NOW,
      });
    }
    case "get_financials":
      return okOut(label, name, sym, "financials", `营收同比 ${row.revenue_yoy}%，净利同比 ${row.net_profit_yoy}%，ROE ${row.roe}%`, `${row.net_profit_yoy}`, "%", "最近报告期同比", {
        symbol: sym, name: row.name, revenue_yoy: row.revenue_yoy, net_profit_yoy: row.net_profit_yoy, roe: row.roe, debt_ratio: row.debt_ratio, as_of: "2026-09-30",
      });
    case "get_valuation": {
      const withSources = args.with_sources !== false;
      const base = { symbol: sym, pe: row.pe, pb: row.pb, as_of: NOW, caliber: "TTM" };
      if (withSources && mode === "conflict") {
        return {
          ok: true, degraded: true, label, source: name, metric: "pe", value_text: `PE(TTM) 源A=${row.pe} 源B=${(row.pe * 1.08).toFixed(2)}（冲突）`,
          unit: "倍", caliber: "TTM vs 静态口径不一致", as_of: NOW,
          notice: { level: "conflict", category: "data_conflict", message: `PE 指标多源不一致：源A ${row.pe}（TTM）vs 源B ${(row.pe * 1.08).toFixed(2)}（静态），已陈列双方数值并标记冲突，需用户指定主源或按口径解释`, detail: { source_a: { value: row.pe, caliber: "TTM" }, source_b: { value: Number((row.pe * 1.08).toFixed(2)), caliber: "静态" } } },
          data: { ...base, conflict: true, source_a: { value: row.pe, caliber: "TTM" }, source_b: { value: Number((row.pe * 1.08).toFixed(2)), caliber: "静态" } },
        };
      }
      return okOut(label, name, sym, "pe", `PE(TTM) ${row.pe}，PB ${row.pb}`, `${row.pe}`, "倍", "TTM", base);
    }
    case "search_news": {
      const items = NEWS_POOL.map((n) => ({ ...n, symbol: sym }));
      return okOut(label, name, sym, "news", `检索到 ${items.length} 条构造资讯`, `${items.length}`, "条", "标题级资讯，未含全文", { symbol: sym, items, as_of: NOW });
    }
    case "get_announcements": {
      const items = ANNOUNCE_POOL.map((n) => ({ ...n, symbol: sym }));
      return okOut(label, name, sym, "announcements", `近 ${items.length} 条构造公告`, `${items.length}`, "条", "公告标题与类型", { symbol: sym, items, as_of: NOW });
    }
    case "get_events":
      return okOut(label, name, sym, "events", "近期事件日历", "3", "项", "预定事件", {
        symbol: sym, items: [
          { date: "2026-10-25", event: "三季报披露（预定）", type: "业绩" },
          { date: "2026-11-02", event: "限售股解禁 1.2 亿股（构造）", type: "解禁" },
          { date: "2026-11-15", event: "股东大会（构造）", type: "治理" },
        ], as_of: NOW,
      });
    case "calc": {
      const expr = String(args.expression || "");
      const sanitized = expr.replace(/[^0-9+\-*/(). %]/g, "");
      let value;
      try {
        // 受限求值：仅允许纯算式
        value = Function(`"use strict";return (${sanitized || 0})`)();
      } catch {
        return { ok: false, error: "算式无法解析", degraded: true };
      }
      return okOut(label, name, null, "calc", `${expr} = ${round2(value)}`, `${round2(value)}`, "", "纯算式计算", { expression: expr, value: round2(value), purpose: args.purpose || "" });
    }
    case "export_report":
      return okOut(label, name, null, "export", `报告已模拟导出（${args.format || "md"}）`, "1", "次", "外部动作演示", { format: args.format, target: args.target, simulated: true, as_of: NOW });
    default:
      return { ok: false, error: `未实现工具: ${name}`, degraded: true };
  }
}

// ---------- 新增 3 工具的 Mock 分支（构造数据，供演示/测试/降级回退） ----------
function mockStandalone(name, args) {
  const label = "mock";
  if (name === "resolve_ticker") {
    const q = String(args.query || "").trim();
    const hits = Object.entries(DATASET)
      .filter(([code, row]) => !q || code.includes(q.toUpperCase()) || row.name.includes(q))
      .map(([code, row]) => ({ thscode: code, name: row.name, asset_type: code.endsWith(".SH") || code.endsWith(".SZ") ? "a-share" : "index" }));
    return {
      ok: true, degraded: hits.length === 0, label, source: name, symbol: null, metric: "ticker_candidates",
      value_text: hits.length ? `匹配到 ${hits.length} 个标的` : `未检索到 '${q}' 的标的（构造数据集范围）`,
      value: String(hits.length), unit: "个", caliber: "构造数据集内检索", as_of: NOW,
      content: { query: q, candidates: hits, as_of: NOW },
      ...(hits.length === 0 ? { notice: { level: "warn", category: "data_missing", message: `构造数据集未覆盖 '${q}'` } } : {}),
    };
  }
  if (name === "get_market_sentiment") {
    const movers = Object.entries(DATASET).sort((a, b) => b[1].change_pct - a[1].change_pct);
    const hot = movers.slice(0, 3).map(([code, row], i) => ({ thscode: code, name: row.name, rank: i + 1, heat: "构造热度" }));
    return okOut(label, name, null, "market_sentiment", `构造市场情绪：热股 ${hot.length} 只、龙虎榜构造`, `${hot.length}`, "只", "构造盘面情绪数据", {
      hot_list: hot, dragon_tiger_count: 3, anomaly_note: "构造异动摘要", as_of: NOW,
    });
  }
  // get_index_overview
  const sym = normalizeSymbol(args.symbol || "000300.SH");
  const row = DATASET[sym] || DATASET["000300.SH"];
  return okOut(label, name, sym, "index_overview", `构造指数概览：${row.name} 点位 ${row.price}（${row.change_pct}%）`, `${row.price}`, "点", "构造指数快照", {
    symbol: sym, name: row.name, price: row.price, change_pct: row.change_pct, constituent_count: 300, top_weights: ["构造权重A", "构造权重B"], as_of: NOW,
  });
}

// ---------- Fuyao Provider（扶摇真实数据）：DATA_PROVIDER=fuyao 时执行 ----------
// 真实取数成功 → label='real'（证据卡带 endpoint+request_id）；
// 失败 → mapError 决策：仅 allowMockFallback 时回退 executeMock（label='mock'+notice）；其余诚实缺失。
async function executeFuyao(name, args, contract) {
  try {
    return await fuyaoReal(name, args);
  } catch (e) {
    return fuyaoDegrade(name, args, contract, e);
  }
}

function fuyaoDegrade(name, args, contract, e) {
  const code = e && e.code !== undefined ? e.code : "NETWORK";
  const m = fuyao.mapError(code);
  const sym = args.symbol ? normalizeSymbol(args.symbol) : null;
  const provenance = { provider: "fuyao", endpoint: e && e.endpoint, request_id: e && e.request_id };
  if (fuyao.allowMockFallback(code)) {
    // 回落构造数据：显式 label='mock'，绝不冒充真实
    return executeMock(name, args, contract).then((r) => ({
      ...r,
      label: "mock",
      fallback_from: "fuyao",
      provenance,
      notice: {
        level: "warn", category: "fallback_mock",
        message: `扶摇取数失败（${m.category}），已回退构造数据（mock），非真实行情，不作真实口径使用`,
        detail: { code, hint: m.hint, endpoint: e && e.endpoint, request_id: e && e.request_id },
      },
    }));
  }
  // 诚实缺失：不编数、不静默
  return {
    ok: true, degraded: true, label: "real", source: name, symbol: sym, metric: "unavailable",
    value_text: `数据缺失（${m.category}）`, value: null, unit: "", caliber: m.hint, as_of: NOW,
    notice: {
      level: "warn", category: noticeCategory(m.category),
      message: `扶摇取数失败（${m.category}）：${m.hint}。已诚实标注缺失，不生成'正常'结论。`,
      detail: { code, hint: m.hint, endpoint: e && e.endpoint, request_id: e && e.request_id },
    },
    content: { missing: true, symbol: sym, code, category: m.category, hint: m.hint, as_of: NOW },
    data: { missing: true, symbol: sym, code, category: m.category, ...provenance },
    provenance,
  };
}

function noticeCategory(category) {
  if (["not_found", "not_ready", "unsupported"].includes(category)) return "data_missing";
  if (category === "permission_error") return "data_gap";
  return "tool_failure";
}

function realOut(source, symbol, metric, summary, value, unit, caliber, content, env) {
  const prov = { provider: "fuyao", endpoint: env && env.endpoint, request_id: env && env.request_id };
  return {
    ok: true, degraded: false, label: "real", source, symbol, metric,
    value_text: summary, value, unit, caliber, as_of: (content && content.as_of) || NOW,
    content: { ...(content || {}), provenance: prov },
    provenance: prov,
  };
}

function gapRecord(name, symbol, metric, gap, message, alternative) {
  return {
    ok: true, degraded: true, label: "real", source: name, symbol, metric,
    value_text: `数据缺失（能力缺口：${gap}）`, value: null, unit: "", caliber: message, as_of: NOW,
    notice: {
      level: "warn", category: "data_gap",
      message: `${message}${alternative ? `；替代证据面：${alternative}` : ""}。已诚实标注缺失，不编数。`,
      detail: { gap, alternative: alternative || null },
    },
    content: { missing: true, gap, symbol, alternative: alternative || null, hint: message, as_of: NOW },
    data: { missing: true, gap, symbol, alternative: alternative || null },
    provenance: { provider: "fuyao", endpoint: null, request_id: null },
  };
}

async function fuyaoReal(name, args) {
  switch (name) {
    case "get_quote": {
      const sym = normalizeSymbol(args.symbol || "");
      const env = await fuyao.getSnapshot(sym);
      const it = ((env.data && env.data.item) || [])[0];
      if (!it) throw new fuyao.FuyaoError(3001, `无 ${sym} 行情快照`, { endpoint: env.endpoint, request_id: env.request_id });
      const asOf = env.data.timestamp ? new Date(env.data.timestamp).toISOString().slice(0, 10) : NOW;
      return realOut(name, sym, "price", `最新价 ${it.last_price}（${it.price_change_ratio_pct >= 0 ? "+" : ""}${round2(it.price_change_ratio_pct)}%，${asOf}）`,
        String(it.last_price), "元", "实时/最近快照价", {
        symbol: sym, ticker: it.ticker, price: it.last_price, change_pct: it.price_change_ratio_pct,
        price_change: it.price_change, open_price: it.open_price, high_price: it.high_price, low_price: it.low_price,
        prev_price: it.prev_price, volume: it.volume, turnover: it.turnover, as_of: asOf,
      }, env);
    }
    case "get_kline": {
      const sym = normalizeSymbol(args.symbol || "");
      const days = Math.min(Number(args.days || args.limit) || 20, 60);
      const end = Date.now();
      const start = end - (days * 2 + 15) * 86400000;
      const env = await fuyao.getHistorical(sym, start, end, "forward");
      const items = (env.data && env.data.item) || [];
      if (!items.length) throw new fuyao.FuyaoError(3002, `无 ${sym} 历史K线`, { endpoint: env.endpoint, request_id: env.request_id });
      const slice = items.slice(-days);
      const closes = slice.map((x) => x.close_price);
      return realOut(name, sym, "close_series", `近${closes.length}个交易日收盘价序列（末值 ${closes[closes.length - 1]}）`,
        String(closes[closes.length - 1]), "元", "前复权日收盘", {
        symbol: sym, days: closes.length, closes, dates: slice.map((x) => new Date(x.date_ms).toISOString().slice(0, 10)), as_of: NOW,
      }, env);
    }
    case "get_financials": {
      const sym = normalizeSymbol(args.symbol || "");
      const report = fuyao.deriveReportPeriod();
      const env = await fuyao.getIndicators(sym, report);
      const abil = (env.data && env.data.abilities) || [];
      const flat = [];
      for (const a of abil) for (const ind of a.indicators || []) flat.push(ind);
      const pick = (...needles) => {
        for (const n of needles) {
          const hit = flat.find((x) => x.index_id && x.index_id.includes(n) && x.value !== null && x.value !== undefined);
          if (hit) return Number(hit.value);
        }
        return null;
      };
      const revenue_yoy = pick("operating_income_yoy", "revenue_yoy");
      const net_profit_yoy = pick("net_profit_yoy");
      const roe = pick("index_weighted_avg_roe", "weighted_avg_roe");
      const debt_ratio = pick("assets_debt_ratio");
      const missing = [];
      if (revenue_yoy === null) missing.push("revenue_yoy");
      if (net_profit_yoy === null) missing.push("net_profit_yoy");
      if (roe === null) missing.push("roe");
      if (debt_ratio === null) missing.push("debt_ratio");
      const out = realOut(name, sym, "financials",
        `营收同比 ${fmt(revenue_yoy)}%，净利同比 ${fmt(net_profit_yoy)}%，ROE ${fmt(roe)}%（报告期 ${report}）`,
        net_profit_yoy === null ? null : String(net_profit_yoy), "%", `扶摇财务指标·报告期 ${report}`, {
        symbol: sym, report, revenue_yoy, net_profit_yoy, roe, debt_ratio, missing_fields: missing, as_of: NOW,
      }, env);
      if (missing.length) {
        out.degraded = true;
        out.notice = { level: "warn", category: "data_missing", message: `部分财务字段缺失（${missing.join(", ")}），已标注，不编数`, detail: { missing } };
      }
      return out;
    }
    case "get_events": {
      // 扶摇无独立事件日历端点；以除权除息事件流（分红/送股）作为最接近的真实证据面，覆盖范围有限并如实标注。
      const sym = normalizeSymbol(args.symbol || "");
      const env = await fuyao.getAdjustmentFactors(sym);
      const items = (env.data && env.data.item) || [];
      const events = items.slice(0, 8).map((x) => ({
        date: x.ex_date_ms ? new Date(x.ex_date_ms).toISOString().slice(0, 10) : null,
        event: `每股派现 ${x.dividend_per_share ?? 0} 元${x.per_share_bonus ? `，每股送股 ${x.per_share_bonus}` : ""}`,
        type: x.per_share_bonus ? "分红送股" : "分红",
      }));
      return realOut(name, sym, "events", `除权除息事件 ${events.length} 条（分红/送股口径）`, String(events.length), "项",
        "除权除息事件流（不含解禁/股东大会）", {
        symbol: sym, items: events, scope_note: "扶摇事件能力仅覆盖分红/送股，未含解禁/股东大会", as_of: NOW,
      }, env);
    }
    case "search_news": {
      // 资讯事件库文档标注"暂未开放外部接入"；真实尝试，失败（多为 2003）时诚实降级，不回退编数。
      const sym = args.symbol ? normalizeSymbol(args.symbol) : null;
      const q = args.keyword || (args.symbol ? String(args.symbol) : "");
      const env = await fuyao.searchEvents(q);
      const items = (env.data && env.data.items) || (env.data && env.data.item) || [];
      return realOut(name, sym, "news", `检索到 ${items.length} 条资讯事件`, String(items.length), "条", "资讯事件库（标题/摘要级）", {
        symbol: sym, items: items.map((x) => ({ title: x.event_name, summary: x.event_summary, date: x.standard_time, grade: x.event_grading && x.event_grading.score })), as_of: NOW,
      }, env);
    }
    case "get_market_sentiment": {
      const [hot, dragon] = await Promise.all([
        fuyao.getHotStockList("day"),
        fuyao.getDragonTiger("all", undefined),
      ]);
      const hotItems = (hot.data && hot.data.item) || [];
      const dragonData = dragon.data || {};
      let anomaly = null;
      if (args.symbol) {
        try { anomaly = await fuyao.getAnomalyStock([normalizeSymbol(args.symbol)]); } catch { /* 异动可选，失败不阻断 */ }
      }
      const anomalyItems = anomaly ? ((anomaly.data && anomaly.data.item) || []) : [];
      return realOut(name, args.symbol ? normalizeSymbol(args.symbol) : null, "market_sentiment",
        `市场情绪：热股榜 ${hotItems.length} 只、龙虎榜上榜 ${dragonData.stock_count ?? (dragonData.stock_items || []).length} 只`,
        String(hotItems.length), "只", "扶摇盘面情绪（热榜/龙虎榜/异动）", {
        hot_list: hotItems.slice(0, 10).map((x) => ({ thscode: x.thscode, name: x.name, rank: x.rank, heat: x.heat, rank_trend: x.rank_trend })),
        dragon_tiger: { count: dragonData.count, stock_count: dragonData.stock_count, trade_date: dragonData.trade_date, top: (dragonData.stock_items || []).slice(0, 5).map((x) => ({ name: x.name, thscode: x.thscode, net_rate: x.net_rate, limit_reason: x.limit_reason })) },
        anomaly: anomalyItems.map((x) => ({ name: x.stock_name, tag: x.tag_name, content: x.analysis_content })),
        as_of: NOW,
      }, hot);
    }
    case "get_index_overview": {
      const sym = normalizeSymbol(args.symbol || "000300.SH");
      const env = await fuyao.getIndexSnapshot(sym);
      const it = ((env.data && env.data.item) || [])[0];
      if (!it) throw new fuyao.FuyaoError(3001, `无 ${sym} 指数快照`, { endpoint: env.endpoint, request_id: env.request_id });
      let constituents = [];
      try {
        const cEnv = await fuyao.getIndexConstituents(sym);
        constituents = (cEnv.data && cEnv.data.item) || [];
      } catch { /* 成分股可选 */ }
      return realOut(name, sym, "index_overview",
        `指数概览：${sym} 点位 ${it.last_price}（${it.price_change_ratio_pct >= 0 ? "+" : ""}${round2(it.price_change_ratio_pct)}%），成分股 ${constituents.length} 只`,
        String(it.last_price), "点", "扶摇指数快照+成分股", {
        symbol: sym, price: it.last_price, change_pct: it.price_change_ratio_pct, prev_price: it.prev_price,
        constituent_count: constituents.length, top_weights: constituents.slice(0, 10).map((x) => ({ thscode: x.thscode, name: x.name })), as_of: NOW,
      }, env);
    }
    case "resolve_ticker": {
      const q = String(args.query || "").trim();
      const env = await fuyao.searchTickers(q, { asset_type: args.asset_type || "a-share", limit: 10 });
      const items = (env.data && env.data.item) || [];
      const out = realOut(name, null, "ticker_candidates",
        items.length ? `匹配到 ${items.length} 个标的` : `未检索到 '${q}' 的标的（可能未上市或名称不匹配）`, String(items.length), "个",
        "扶摇标的检索", {
        query: q, candidates: items.map((x) => ({ thscode: x.thscode, ticker: x.ticker, name: x.name, exchange: x.exchange, asset_type: x.asset_type })), as_of: NOW,
      }, env);
      if (!items.length) {
        // 空结果=诚实缺失（如未上市标的长鑫存储），不编数、不静默
        out.degraded = true;
        out.notice = { level: "warn", category: "data_missing", message: `未检索到 '${q}' 的标的，可能未上市或名称不匹配，已标注数据缺失`, detail: { query: q } };
      }
      return out;
    }
    // calc / export_report 为本地能力，与数据源无关：沿用 mock 实现（但标注 real 无意义，标 local）
    case "calc":
    case "export_report":
      return executeMock(name, args, TOOL_CONTRACTS.find((t) => t.name === name));
    // 无真实端点的能力缺口：诚实降级
    case "get_valuation":
      return gapRecord(name, normalizeSymbol(args.symbol || ""), "pe", "valuation_endpoint",
        "扶摇未提供估值（PE/PB）端点，无法取数", "get_financials 的盈利能力/ROE");
    case "get_announcements":
      return gapRecord(name, normalizeSymbol(args.symbol || ""), "announcements", "announcement_endpoint",
        "扶摇暂无公司公告端点，无法取数", "search_news / get_events（分红送股）");
    default:
      return { ok: false, error: `未实现工具: ${name}`, degraded: true };
  }
}

function parseNum(v) { return v === null || v === undefined || v === "" ? null : Number(v); }
function fmt(v) { return v === null || v === undefined ? "--" : round2(v); }

/** 证券代码归一化：LLM 常传不带后缀的代码（如 600519），补全市场后缀 */
function normalizeSymbol(raw) {
  const s = String(raw).toUpperCase().trim();
  if (s.includes(".")) return s;
  if (DATASET[s]) return s;
  if (/^6/.test(s)) return `${s}.SH`;
  if (/^(000300|000905|000852)/.test(s)) return `${s}.SH`;
  if (/^[03]/.test(s)) return `${s}.SZ`;
  return s;
}

function okOut(label, source, symbol, metric, summary, value, unit, caliber, content) {
  return { ok: true, degraded: false, label, source, symbol, metric, value_text: summary, value, unit, caliber, as_of: content.as_of || NOW, content };
}

function synthKline(base, days) {
  // 确定性伪随机序列（构造数据）：保证多次运行一致，便于演示与测试断言
  const out = [];
  let v = base * 0.96;
  let seed = base * 13 + days;
  for (let i = 0; i < days; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    const drift = (seed / 233280 - 0.5) * 0.02;
    v = v * (1 + drift) + base * 0.001;
    out.push(round2(v));
  }
  out[out.length - 1] = base;
  return out;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** 供 LLM 使用的工具清单（function calling 格式） */
export function toolsForLLM() {
  return TOOL_CONTRACTS.map((t) => ({
    type: "function",
    function: { name: t.name, description: `[风险:${t.risk}] ${t.description}`, parameters: t.params },
  }));
}
