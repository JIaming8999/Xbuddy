// tests/run-tests.mjs — 自动化测试（v4）：合规拦截 / 目标充分性 / 问题树校验 / 报告校验 / diff / 异常降级 / 集成 / 视图模型契约
// 运行：npm test（单元用例纯本地断言，无需 LLM key；集成用例需先启动服务，未启动则自动跳过）
import {
  interceptIntent, assessGoal, assessGoalSmart, hasExplicitTarget, validatePlan, validateReport, artifactDiff, complianceFilter,
} from "../server/agent.js";
import { executeTool, setAnomaly, TOOL_CONTRACTS, toolsForLLM } from "../server/tools.js";
import { deriveReportPeriod, mapError, allowMockFallback } from "../server/fuyao.js";

let pass = 0, fail = 0;
function assert(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

console.log("\n[1] 输入侧合规拦截（M9）");
assert("拦截荐股请求", interceptIntent("帮我推荐几只股票").blocked);
assert("拦截买卖建议", interceptIntent("现在可以买入茅台吗").blocked);
assert("拦截涨跌预测", interceptIntent("茅台明天会涨吗").blocked);
assert("拦截收益承诺", interceptIntent("有什么保本稳赚的标的").blocked);
assert("拦截仓位建议", interceptIntent("我该给多少仓位").blocked);
assert("放行合规任务", !interceptIntent("梳理贵州茅台近季度经营变化与风险点").blocked);

console.log("\n[2] 目标充分性判断与澄清反问（§4.2）");
const a1 = assessGoal("梳理贵州茅台近 1 年经营变化与风险点");
assert("要素齐全不反问", a1.sufficient === true);
const a2 = assessGoal("帮我看看这家公司");
assert("缺要素触发反问（1~2 个问题）", !a2.sufficient && a2.questions.length >= 1 && a2.questions.length <= 2);
assert("反问带可点选项", a2.questions.every((q) => Array.isArray(q.options) && q.options.length > 0));
const a3 = assessGoal("对比茅台和五粮液近 3 年的盈利能力");
assert("带标的/时间/视角不反问", a3.sufficient === true);

// 方案C（v4.1）：LLM 槽位抽取 + 确认式反问；replay/无 LLM/失败 → 规则回退（assessGoal 契约不动）
assert("hasExplicitTarget 识别公司后缀标的（长鑫存储）", hasExplicitTarget("梳理长鑫存储本季度的机会点和风险点"));
assert("hasExplicitTarget 无标的不误判", !hasExplicitTarget("帮我看看最近怎么样"));
const asr1 = await assessGoalSmart({ mode: "replay" }, "随便看看");
assert("assessGoalSmart 演示模式确定性回退规则", asr1.source === "rule" && !asr1.sufficient && asr1.questions.length >= 1);
const asr2 = await assessGoalSmart({ mode: "replay" }, "梳理贵州茅台近 1 年经营变化与风险点");
assert("assessGoalSmart 规则已充分时直接通过（反问为 0）", asr2.sufficient === true && asr2.questions.length === 0);
assert("assessGoalSmart 输出保持反问 ≤2 且带选项", asr1.questions.length <= 2 && asr1.questions.every((q) => Array.isArray(q.options) && q.options.length > 0));

console.log("\n[3] 问题树前置校验（M2.1，校验不通过回炉重生成）");
const goodSteps = [
  { seq: 1, title: "取财务", sub_question: "基本面如何", kind: "tool", tool_name: "get_financials", args: { symbol: "600519.SH" }, depends_on: [] },
  { seq: 2, title: "归纳", sub_question: "风险点有哪些", kind: "analysis", args: {}, depends_on: [1] },
];
assert("合法问题树通过", validatePlan(goodSteps).ok);
const dupV = validatePlan([
  goodSteps[0], { seq: 2, title: "再取一次财务", sub_question: "x", kind: "tool", tool_name: "get_financials", args: { symbol: "600519.SH" }, depends_on: [] },
]);
assert("拦截重复调用", !dupV.ok);
assert("校验错误文案指向问题树", /问题树/.test(JSON.stringify(dupV.errors)));
assert("允许两个不同子问题的 analysis 节点", validatePlan([
  goodSteps[0], goodSteps[1], { seq: 3, title: "再归纳", sub_question: "另一个不同子问题", kind: "analysis", args: {}, depends_on: [1] },
]).ok);
assert("拦截缺少必填参数", !validatePlan([
  { seq: 1, title: "取财务", sub_question: "基本面", kind: "tool", tool_name: "get_financials", args: {}, depends_on: [] },
]).ok);
assert("拦截不存在的工具", !validatePlan([
  { seq: 1, title: "乱来", sub_question: "x", kind: "tool", tool_name: "hack_tool", args: {}, depends_on: [] },
]).ok);
assert("拦截 calc 自然语言入参", !validatePlan([
  { seq: 1, title: "计算", sub_question: "x", kind: "tool", tool_name: "calc", args: { expression: "用步骤1的数值计算同比" }, depends_on: [] },
]).ok);
assert("拦截循环依赖", !validatePlan([
  { seq: 1, title: "A", sub_question: "a", kind: "analysis", args: {}, depends_on: [2] },
  { seq: 2, title: "B", sub_question: "b", kind: "analysis", args: {}, depends_on: [1] },
]).ok);

console.log("\n[4] 报告确定性校验器（§6.2 硬约束）");
const evMap = new Map([
  [1, { id: 1, value_text: "170.7亿", raw_snippet: "" }],
  [2, { id: 2, value_text: "38%", raw_snippet: "" }],
]);
const rc1 = validateReport({
  summary: [{ text: "营收 170.7 亿", refs: [1] }],
  facts: [
    { id: "F1", text: "2026Q3 营收 170.7 亿元", refs: [1] },
    { id: "F2", text: "无引用结论", refs: [] },
    { id: "F3", text: "毛利率 92%", refs: [1] },
  ],
  inferences: [{ id: "I1", text: "某推断", refs: [2] }],
  unverified: [], data_quality: [],
}, evMap);
assert("有引用且数值一致的事实保留", rc1.content.facts.some((f) => f.id === "F1"));
assert("无引用事实强制移入待验证区", !rc1.content.facts.some((f) => f.id === "F2") && rc1.content.unverified.some((u) => u.text.includes("【移入待验证】")));
assert("数值与证据不一致的事实移入待验证区", !rc1.content.facts.some((f) => f.id === "F3"));
assert("推断未给置信度自动补低并预警", rc1.content.inferences[0].confidence === "低" && rc1.report.warnings.length > 0);
assert("未给反驳条件自动补占位", !!rc1.content.inferences[0].counter_conditions);
const rc2 = validateReport({
  summary: [], facts: [],
  inferences: [{ id: "I1", text: "无引用推断", refs: [] }],
  unverified: [], data_quality: [],
}, evMap);
assert("无引用推断强制标注『未验证推断』", rc2.content.inferences[0].text.includes("【未验证推断】"));

console.log("\n[5] 版本 diff 计算（蓝/灰呈现，禁红绿）");
const oldC = {
  summary: [], facts: [{ id: "F1", text: "旧事实", refs: [1] }, { id: "F2", text: "将被删除", refs: [1] }],
  inferences: [{ id: "I1", text: "旧推断", refs: [] }], unverified: [], data_quality: [],
};
const newC = {
  summary: [], facts: [{ id: "F1", text: "新事实", refs: [1] }, { id: "F3", text: "新增事实", refs: [2] }],
  inferences: [{ id: "I1", text: "旧推断", refs: [] }], unverified: [], data_quality: [],
};
const d = artifactDiff(oldC, newC);
assert("识别新增条目", d.added.some((x) => x.id === "F3"));
assert("识别删除条目", d.removed.some((x) => x.id === "F2"));
assert("识别修改条目（含新旧文本）", d.changed.some((x) => x.id === "F1" && x.old_text === "旧事实" && x.new_text === "新事实"));
// v4.1 narrative 差异（同样蓝灰呈现）
const dN1 = artifactDiff({ ...oldC, narrative: "" }, { ...newC, narrative: "新正文" });
assert("narrative 空→有识别为新增", dN1.added.some((x) => x.section === "narrative"));
const dN2 = artifactDiff({ ...oldC, narrative: "旧正文" }, { ...newC, narrative: "新正文" });
assert("narrative 变更识别为修改（含新旧文本）", dN2.changed.some((x) => x.section === "narrative" && x.old_text === "旧正文" && x.new_text === "新正文"));

console.log("\n[6] 输出合规过滤（M8）");
const f1 = complianceFilter({
  summary: "建议买入该股，目标价 2000 元", facts: [], inferences: [{ text: "该股必然上涨", refs: [1] }], risks: [],
});
assert("移除买卖建议/目标价", f1.report.blocked.length > 0 && !String(f1.content.summary).includes("建议买入"));
assert("移除确定性涨跌表述", !f1.content.inferences[0].text.includes("必然上涨"));
assert("空风险提示自动补合规声明", f1.content.risks.length > 0);
const f2 = complianceFilter({
  summary: [{ text: "x", refs: [1] }], facts: [], inferences: [{ text: "某推断", refs: [] }], risks: [],
});
assert("无引用推断强制标注『未验证推断』", f2.content.inferences[0].text.includes("未验证推断"));
assert("数组概要兼容处理", Array.isArray(f2.content.summary));
const f3 = complianceFilter({
  narrative: "整体稳健，但建议买入该股，目标价 2000 元", summary: [], facts: [], inferences: [], risks: [],
});
assert("narrative 连贯正文同样过合规红线过滤", f3.report.blocked.length > 0 && !String(f3.content.narrative).includes("建议买入"));

console.log("\n[7] 工具异常注入与降级（M11，含 stale）");
setAnomaly("conflict");
const rConflict = await executeTool("get_valuation", { symbol: "600519.SH", with_sources: true });
assert("冲突模式：双源数值陈列且标记 conflict", rConflict.ok && rConflict.degraded && rConflict.notice?.category === "data_conflict" && rConflict.data.conflict === true);
setAnomaly("missing");
const rMissing = await executeTool("get_financials", { symbol: "600519.SH" });
assert("缺失模式：显式标注缺失而非静默", rMissing.ok && rMissing.degraded && rMissing.notice?.category === "data_missing");
setAnomaly("stale");
const rStale = await executeTool("get_valuation", { symbol: "600519.SH" });
assert("过期模式：标时点且发 data_stale 通知", rStale.ok && rStale.degraded && rStale.notice?.category === "data_stale" && !!rStale.as_of);
setAnomaly("timeout");
const rTimeout = await executeTool("get_quote", { symbol: "600519.SH" });
assert("超时模式：失败并显式记录", !rTimeout.ok && rTimeout.degraded && rTimeout.notice?.category === "tool_failure");
setAnomaly("fail");
const rFail = await executeTool("get_quote", { symbol: "600519.SH" });
assert("报错模式：失败并显式记录", !rFail.ok && rFail.degraded);
setAnomaly("none");
const rOk = await executeTool("get_quote", { symbol: "600519" });
assert("证券代码归一化（600519 → 600519.SH）", rOk.ok && rOk.content.symbol === "600519.SH");
const rUnknown = await executeTool("get_quote", { symbol: "999999.SZ" });
assert("未知代码：数据缺失显式标注", rUnknown.ok && rUnknown.degraded && rUnknown.notice?.category === "data_missing");

console.log("\n[7b] 扶摇数据源降级决策（确定性纯函数，无网络）");
// deriveReportPeriod：按披露滞后保守推算报告期
assert("报告期推算 1-4月→上年三季报", deriveReportPeriod(new Date("2026-02-10")) === "2025-3");
assert("报告期推算 5-8月→本年一季报", deriveReportPeriod(new Date("2026-06-15")) === "2026-1");
assert("报告期推算 9-10月→本年中报", deriveReportPeriod(new Date("2026-10-13")) === "2026-2");
assert("报告期推算 11-12月→本年三季报", deriveReportPeriod(new Date("2026-12-01")) === "2026-3");
// mapError：错误码 → 降级决策（fallback 仅 network/timeout/2001/5xx）
assert("3001 标的不存在：不回退（诚实缺失）", mapError(3001).fallback === false && mapError(3001).category === "not_found");
assert("2004 客户端专用：不回退（诚实缺口）", mapError(2004).fallback === false && mapError(2004).category === "permission_error");
assert("2003 无权限：不回退", mapError(2003).fallback === false && mapError(2003).category === "permission_error");
assert("4001 限流：不回退", mapError(4001).fallback === false && mapError(4001).category === "rate_limit");
assert("2001 未认证：可回退", mapError(2001).fallback === true && mapError(2001).category === "auth_error");
assert("TIMEOUT 超时：可回退", mapError("TIMEOUT").fallback === true && mapError("TIMEOUT").category === "timeout");
assert("NETWORK 网络：可回退", mapError("NETWORK").fallback === true && mapError("NETWORK").category === "network");
assert("未识别码默认不回退（宁缺失不编数）", mapError(9999).fallback === false && mapError(9999).category === "unknown");
// allowMockFallback：仅可回退类 + 显式开启 FUYAO_FALLBACK_MOCK=1 才回落 mock
assert("可回退类但未开启开关→不回退", allowMockFallback("TIMEOUT") === false);
process.env.FUYAO_FALLBACK_MOCK = "1";
assert("可回退类+开启开关→允许回退 mock", allowMockFallback("TIMEOUT") === true && allowMockFallback(2001) === true);
assert("不可回退类+开启开关仍不回退（3001/2004）", allowMockFallback(3001) === false && allowMockFallback(2004) === false);
delete process.env.FUYAO_FALLBACK_MOCK;
// 新增 3 工具契约 + MCP 命名对齐
assert("新增 resolve_ticker/get_market_sentiment/get_index_overview 契约齐全",
  ["resolve_ticker", "get_market_sentiment", "get_index_overview"].every((n) => TOOL_CONTRACTS.some((t) => t.name === n)));
assert("工具契约总数 12 且全量暴露给规划器", TOOL_CONTRACTS.length === 12 && toolsForLLM().length === 12);
assert("契约标注 MCP 对应工具名（get_quote 对齐 prices_snapshot）",
  TOOL_CONTRACTS.find((t) => t.name === "get_quote").mcp === "get_a_share_prices_snapshot");
assert("无端点能力契约标注 mcp=null（get_valuation/get_announcements）",
  TOOL_CONTRACTS.find((t) => t.name === "get_valuation").mcp === null && TOOL_CONTRACTS.find((t) => t.name === "get_announcements").mcp === null);
// mock 模式下新工具确定性可用
const mrt = await executeTool("resolve_ticker", { query: "茅台" });
assert("mock resolve_ticker 命中构造标的", mrt.ok && mrt.content.candidates.some((c) => c.thscode === "600519.SH"));
const mms = await executeTool("get_market_sentiment", {});
assert("mock get_market_sentiment 可用", mms.ok && mms.label === "mock");
const mio = await executeTool("get_index_overview", { symbol: "000300.SH" });
assert("mock get_index_overview 可用", mio.ok && mio.content.symbol === "000300.SH");

// ---------- 集成（需服务 :3210） ----------
const BASE = "http://localhost:3210";
const post = (path, body) => fetch(`${BASE}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
}).then((r) => r.json());
const get = (path) => fetch(`${BASE}${path}`).then((r) => r.json());

let integrationOk = false;
console.log("\n[8] 集成链路（演示模式重放，需服务运行于 :3210，否则自动跳过）");
try {
  const meta = await get("/api/meta");
  assert("meta 接口可用（含工具契约/模型选项）", Array.isArray(meta.tools) && meta.tools.length >= 8 && Array.isArray(meta.llmDefaults?.modelOptions));
  integrationOk = true;

  const created = await post("/api/threads", { goal: "自动化测试：演示链路回归", mode: "replay" });
  assert("创建线程（自动挂主题）", created.ok === true, JSON.stringify(created));
  const tid = created.id;

  // 目标要素不全 → 应触发澄清反问
  const created2 = await post("/api/threads", { goal: "随便看看", mode: "replay" });
  assert("目标不全自动进入澄清阶段", created2.ok && created2.need_clarify === true && created2.questions.length >= 1);
  const clarified = await post(`/api/threads/${created2.id}/clarify`, { answers: {} });
  assert("澄清后自动生成问题树（含提纲消息）", clarified.ok === true);
  const det2 = await get(`/api/threads/${created2.id}`);
  assert("对话流出现澄清卡与提纲卡", det2.messages.some((m) => m.kind === "clarify") && det2.messages.some((m) => m.kind === "outline"));

  const planned = await post(`/api/threads/${tid}/plan`);
  assert("演示模式问题树入库且校验通过", planned.ok && planned.validation.ok);
  await post(`/api/threads/${tid}/run`);
  await new Promise((r) => setTimeout(r, 16000));

  const detail = await get(`/api/threads/${tid}`);
  assert("步骤执行有成有降（降级不静默）", detail.steps.some((s) => s.status === "succeeded") && detail.steps.some((s) => s.status === "degraded"));
  assert("步骤为视图模型（含中文状态与友好错误）", detail.steps.every((s) => s.status_label && "friendly_error" in s));
  assert("证据卡带来源/时点/口径字段", detail.evidence.length >= 3 && detail.evidence.every((e) => "as_of" in e && "caliber" in e && "status" in e));
  assert("证据状态机字段可用（ok/missing/stale/conflict）", detail.evidence.some((e) => ["ok", "missing", "stale", "conflict"].includes(e.status)));
  assert("数据冲突显式通知", detail.notices.some((n) => n.category === "data_conflict"));
  assert("工具失败显式通知", detail.notices.some((n) => n.category === "tool_failure"));
  assert("产物为四分区视图模型", (() => {
    const a = detail.current_artifact;
    return a && Array.isArray(a.facts) && Array.isArray(a.inferences) && Array.isArray(a.unverified) && Array.isArray(a.data_quality) && a.risks.length > 0;
  })());
  assert("事实区条目句句挂引用", detail.current_artifact.facts.every((f) => (f.refs || []).length > 0));
  assert("候选记忆需确认（默认 candidate）", detail.memories.every((m) => m.status === "candidate" || m.status === "active"));
  assert("线程挂主题（主题为一级对象）", detail.thread.topic_id !== null && detail.thread.topic_id !== undefined);

  // 检查点 / trace 仅开发者模式
  const dev = await get(`/api/threads/${tid}?view=dev`);
  assert("检查点逐落库（仅 dev 视图）", Array.isArray(dev.dev?.checkpoints) && dev.dev.checkpoints.length >= 4);
  assert("trace 仅 dev 视图暴露", Array.isArray(dev.dev?.traces) && dev.dev.traces.length > 0);

  // 人工补充证据同权入库
  const evAdd = await post(`/api/threads/${tid}/evidence`, {
    metric: "渠道批价", value_text: "2650 元/瓶", as_of: "2026-09-30", caliber: "周度均值", source: "渠道调研纪要",
  });
  assert("手动补充证据入库", evAdd.ok === true);
  const detail3 = await get(`/api/threads/${tid}`);
  assert("补充证据与工具证据同视图呈现", detail3.evidence.some((e) => e.type === "user_upload" && e.metric === "渠道批价"));

  // v4.1：报告连贯正文（narrative）+ 问题树编号规范化
  assert("报告含连贯正文 narrative（主阅读面）",
    typeof detail.current_artifact.narrative === "string" && detail.current_artifact.narrative.length > 50,
    JSON.stringify(detail.current_artifact?.narrative || "").slice(0, 40));
  assert("问题树编号规范化（node_id 连续 Q1..Qn）",
    detail.steps.every((s, i) => s.node_id === `Q${i + 1}`),
    detail.steps.map((s) => s.node_id).join(","));
  const nodeAdd = await post(`/api/threads/${tid}/nodes`, { title: "补充问题：渠道价跟踪", sub_question: "渠道价近期变化如何", kind: "analysis" });
  assert("添加节点可用", nodeAdd.ok === true);
  const detA = await get(`/api/threads/${tid}`);
  assert("添加后编号仍连续（Q1..Qn+1）", detA.steps.every((s, i) => s.node_id === `Q${i + 1}`), detA.steps.map((s) => s.node_id).join(","));
  await fetch(`${BASE}/api/nodes/${nodeAdd.node.id}`, { method: "DELETE" });
  const detB = await get(`/api/threads/${tid}`);
  assert("删除后编号仍连续（不留断层）",
    detB.steps.length === detA.steps.length - 1 && detB.steps.every((s, i) => s.node_id === `Q${i + 1}`),
    detB.steps.map((s) => s.node_id).join(","));
} catch (err) {
  console.log(`  - 跳过集成用例（服务未运行：${err.message}）`);
}

console.log("\n[9] 前端视图模型契约（§9 硬约束：普通视图零裸 JSON）");
if (integrationOk) {
  try {
    const tid = (await get("/api/threads"))[0]?.id;
    const detail = await get(`/api/threads/${tid}`);
    const offenders = [];
    (function walk(node, path) {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (/_json$/.test(k) || ["payload", "stack", "trace", "args_json", "content_json"].includes(k)) offenders.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    })(detail, "$");
    assert("普通视图响应不含 *_json / payload / stack / trace", offenders.length === 0, offenders.slice(0, 5).join(","));
    assert("普通视图不含 dev 调试块", detail.dev === undefined);
    const txt = JSON.stringify(detail);
    assert("普通视图不含测试脏串（DSFSensf）", !txt.includes("DSFSensf"));
  } catch (err) {
    assert("视图模型契约检查", false, err.message);
  }
} else {
  console.log("  - 跳过（服务未运行）");
}

console.log("\n[10] LLM 配置（用户自填 key/接口/模型，需服务 :3210）");
if (integrationOk) {
  try {
    const TEST_KEY = "tp-unit-test-key-abcdefgh12345678";
    const bad = await post("/api/threads", {
      goal: "配置校验测试", mode: "real", llm_cfg: { base_url: "ftp://非法协议", api_key: TEST_KEY },
    });
    assert("拦截非法接口地址（非 http(s)）", bad.ok === false && /http/.test(bad.error || ""));
    const badModel = await post("/api/threads", {
      goal: "配置校验测试", mode: "real", llm_cfg: { api_key: TEST_KEY, model: "bad model; rm -rf" },
    });
    assert("拦截非法模型名", badModel.ok === false && /模型名/.test(badModel.error || ""));
    const createdCfg = await post("/api/threads", {
      goal: "配置入库测试：LLM 自定义配置", mode: "real",
      llm_cfg: { base_url: "https://example.com/v1", api_key: TEST_KEY, model: "mimo-v2.6-flash" },
    });
    assert("带自定义配置创建线程", createdCfg.ok === true, JSON.stringify(createdCfg));
    const det = await get(`/api/threads/${createdCfg.id}`);
    assert("配置透传（base_url/model 可读）", det.thread.llm?.base_url === "https://example.com/v1" && det.thread.llm?.model === "mimo-v2.6-flash");
    assert("API Key 脱敏返回（不回传明文）", String(det.thread.llm?.api_key_masked || "").includes("…") && !String(det.thread.llm?.api_key_masked || "").includes(TEST_KEY));
    const testBad = await fetch(`${BASE}/api/llm/test`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: "not-a-url", api_key: TEST_KEY }),
    });
    assert("连接测试校验接口地址格式", testBad.status === 400);
  } catch (err) {
    console.log(`  - 跳过 LLM 配置用例（${err.message}）`);
  }
} else {
  console.log("  - 跳过（服务未运行）");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
