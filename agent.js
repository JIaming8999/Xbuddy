// server/agent.js — Agent Harness 核心（v4 Evidence-first）
// 流程：合规拦截 → 目标充分性（澄清反问）→ 问题树规划（校验+回炉）→ 执行（证据落库/重试/降级/审批/检查点）
//       → 四分区报告（确定性校验器）→ 对话式修订（vN+diff）→ 候选记忆
import { EventEmitter } from "node:events";
import { db, lastInsertId } from "./db.js";
import { chat, extractJson, estimateCost, MODEL_PLANNER, MODEL_LIGHT, llmConfigured } from "./llm.js";
import { toolsForLLM, executeTool, TOOL_CONTRACTS, setAnomaly } from "./tools.js";

export const bus = new EventEmitter();
export const running = new Map(); // threadId -> { stopped, startedAt }

const LIMITS = { maxSteps: 12, maxCostUsd: 0.5, maxWallMs: 5 * 60 * 1000, compressThresholdChars: 4000 };

// ============ 事件与消息 ============
function emit(threadId, event) {
  bus.emit(`thread:${threadId}`, event);
}
export function addMessage(threadId, role, kind, content) {
  const info = db.prepare("INSERT INTO messages(thread_id, role, kind, content_json) VALUES (?,?,?,?)")
    .run(threadId, role, kind, JSON.stringify(content || {}));
  const message = { id: lastInsertId(info), thread_id: threadId, role, kind, content, created_at: new Date().toISOString() };
  emit(threadId, { type: "message", message });
  return message;
}
function notice(threadId, level, category, message, detail = {}) {
  const info = db.prepare("INSERT INTO notices(thread_id, level, category, message, detail_json) VALUES (?,?,?,?,?)")
    .run(threadId, level, category, message, JSON.stringify(detail));
  emit(threadId, { type: "notice", notice: { id: lastInsertId(info), level, category, message, detail } });
}
function trace(threadId, stepId, kind, summary, payload = {}, usage = {}, latencyMs = 0) {
  db.prepare("INSERT INTO traces(thread_id, step_id, kind, summary, payload_json, tokens_in, tokens_out, latency_ms) VALUES (?,?,?,?,?,?,?,?)")
    .run(threadId, stepId, kind, summary, JSON.stringify(payload), usage.prompt_tokens || 0, usage.completion_tokens || 0, latencyMs);
}
function addTokens(threadId, usage, latencyMs = 0) {
  const cost = estimateCost(usage.prompt_tokens || 0, usage.completion_tokens || 0);
  db.prepare("UPDATE threads SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, cost_usd = cost_usd + ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(usage.prompt_tokens || 0, usage.completion_tokens || 0, cost, threadId);
}
function setStage(threadId, stage) {
  db.prepare("UPDATE threads SET stage = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(stage, threadId);
}
function cfgOf(thread) {
  try {
    const c = JSON.parse(thread?.llm_cfg_json || "{}");
    return c && (c.base_url || c.api_key || c.model) ? c : null;
  } catch {
    return null;
  }
}

// ============ M9 输入侧合规拦截 ============
const BANNED_INTENTS = [
  { re: /(推荐|介绍|给).{0,8}(股票|个股|牛股|标的)/, tip: "荐股/个股推荐" },
  { re: /(买入|卖出|建仓|清仓|加仓).{0,6}(建议|吗|？|\?)/, tip: "买卖建议" },
  { re: /(明天|下周|未来|接下来).{0,8}(涨|跌|涨停|走势)/, tip: "涨跌预测" },
  { re: /(保证|稳赚|包赚|收益承诺|翻倍)/, tip: "收益承诺" },
  { re: /(仓位|抄底|逃顶).{0,6}(建议|多少|怎么|配置)|(多少|怎么|如何|给).{0,4}仓位/, tip: "仓位建议" },
];
export function interceptIntent(goal) {
  for (const b of BANNED_INTENTS) {
    if (b.re.test(goal)) {
      return {
        blocked: true,
        reason: `检测到${b.tip}类请求。本产品不提供确定性涨跌预测、收益承诺或直接买卖建议（合规红线）。`,
        suggestion: "可以改用合规任务类型：① 公司/行业事实梳理与风险点扫描 ② 多标的指标对比（仅陈述数据）③ 事件与公告归因整理。",
      };
    }
  }
  return { blocked: false };
}

// ============ §4.2 目标充分性判断与澄清反问 ============
const TIME_RE = /(近|过去|最近)\s*[0-9一二三四五六七八九十半]?\s*(个)?(季度|月|年|日|周)|20\d{2}\s*年|20\d{2}\s*Q[1-4]|三季报|中报|年报|一季报|半年报/;
const SCOPE_RE = /经营|财务|估值|风险|现金流|营收|利润|对比|比较|事件|公告|政策|舆情|基本面|行情|走势|渠道|增长|毛利|净利|负债|分红|解禁/;
const TARGET_HINTS = ["600519", "000001", "600309", "600036", "000300", "茅台", "平安", "万华", "招商银行", "沪深300"];

export function assessGoal(goal) {
  const g = String(goal || "");
  const hasTime = TIME_RE.test(g);
  const hasScope = SCOPE_RE.test(g);
  const hasTarget = TARGET_HINTS.some((h) => g.includes(h)) || /\d{6}/.test(g);
  const questions = [];
  if (!hasTarget) {
    questions.push({ id: "target", question: "研究哪个标的？（未指定时默认围绕贵州茅台演示）", options: ["贵州茅台（600519.SH）", "宁德时代（600309.SH 为演示标的）", "沪深300（000300.SH）"] });
  }
  if (!hasTime) {
    questions.push({ id: "time_range", question: "研究时间范围是？", options: ["近 1 个季度", "近 1 年", "近 3 年"] });
  }
  if (!hasScope && questions.length < 2) {
    questions.push({ id: "view", question: "关注哪些方面？", options: ["经营 + 风险", "财务 + 估值", "全面梳理"] });
  }
  return { sufficient: questions.length === 0, missing: questions.map((q) => q.id), questions: questions.slice(0, 2) };
}

// ---------- 方案C：LLM 槽位抽取 + 确认式反问（assessGoal 规则版保留为确定性回退，测试契约不动） ----------
// 识别显式标的：证券代码 / 已知标的词 / 公司后缀词（长鑫存储、宁德时代 等）
const TARGET_SUFFIX_RE = /(公司|集团|股份|银行|证券|保险|存储|科技|电子|半导体|药业|医药|生物|能源|材料|重工|电力|汽车|智能|时代|实业|控股|光电|通信|软件|网络|食品|白酒|家电|地产|物流|航空|钢铁|煤炭|石油|化工|光伏|风电|电池|芯片)/;
export function hasExplicitTarget(goal) {
  const g = String(goal || "");
  return TARGET_HINTS.some((h) => g.includes(h)) || /\d{6}/.test(g) || TARGET_SUFFIX_RE.test(g);
}

/** 槽位 → 反问：缺失才问；缺失但目标里有候选 → 确认式反问（文案动态引用目标原文），≤2 问、可跳过 */
function slotQuestions(slots) {
  const q = [];
  if (!slots.target) {
    q.push(slots.target_hint
      ? { id: "target", question: `目标中提到「${slots.target_hint}」，就以它为研究标的？`, options: [slots.target_hint, "贵州茅台（600519.SH）", "沪深300（000300.SH）"] }
      : { id: "target", question: "研究哪个标的？（未指定时默认围绕贵州茅台演示）", options: ["贵州茅台（600519.SH）", "宁德时代（600309.SH 为演示标的）", "沪深300（000300.SH）"] });
  }
  if (!slots.time_range) {
    q.push(slots.time_hint
      ? { id: "time_range", question: `目标中提到「${slots.time_hint}」，就按这个时间范围？`, options: [slots.time_hint, "近 1 年", "近 3 年"] }
      : { id: "time_range", question: "研究时间范围是？", options: ["近 1 个季度", "近 1 年", "近 3 年"] });
  }
  if (!slots.view && q.length < 2) {
    q.push(slots.view_hint
      ? { id: "view", question: `目标中提到「${slots.view_hint}」，就按这个视角研究？`, options: [slots.view_hint, "经营 + 风险", "全面梳理"] }
      : { id: "view", question: "关注哪些方面？", options: ["经营 + 风险", "财务 + 估值", "全面梳理"] });
  }
  return q.slice(0, 2);
}

/**
 * 智能目标充分性判断（方案C）：轻量 LLM 抽取 标的/时间/视角 槽位，只对缺失槽位反问。
 * 回退：规则已判充分 / 演示模式（replay）/ 无 LLM 配置 / LLM 调用失败 → assessGoal 原规则结果（确定性）。
 */
export async function assessGoalSmart(thread, goal) {
  const rule = assessGoal(goal);
  const cfg = cfgOf(thread);
  if (rule.sufficient || thread?.mode === "replay" || (!cfg && !llmConfigured())) {
    return { ...rule, source: "rule" };
  }
  try {
    const res = await chat({
      messages: [
        {
          role: "system",
          content: `从研究目标中抽取研究槽位。只输出一个 JSON 对象，不要解释：
{"target":"研究标的名称，未提到则空","target_hint":"目标文本中出现但不确定是否为标的的候选，无则空","time_range":"时间范围，未提到则空","time_hint":"疑似时间表述但不确定，无则空","view":"研究视角，未提到则空"}
规则：原词抽取（如「本季度」「近 1 年」「长鑫存储」「机会点和风险点」），不要改写或翻译；没提到的槽位留空字符串。`,
        },
        { role: "user", content: goal },
      ],
      model: MODEL_LIGHT, maxTokens: 300, temperature: 0, timeoutMs: 15000, cfg,
    });
    const raw = extractJson(res.content) || {};
    const norm = (v) => String(v || "").trim().replace(/[。，,.]$/, "").slice(0, 20);
    const slots = {
      target: norm(raw.target), target_hint: norm(raw.target_hint),
      time_range: norm(raw.time_range), time_hint: norm(raw.time_hint),
      view: norm(raw.view), view_hint: norm(raw.view_hint),
    };
    const questions = slotQuestions(slots);
    return { sufficient: questions.length === 0, missing: questions.map((x) => x.id), questions, slots, source: "llm" };
  } catch (err) {
    return { ...rule, source: "rule", fallback_reason: String(err.message || err).slice(0, 120) };
  }
}

export function defaultScope() {
  return { time_range: "近 1 年", view: "经营 + 风险", caliber: "-" };
}
export function scopeFromAnswers(answers = {}) {
  const s = defaultScope();
  if (answers.time_range) s.time_range = String(answers.time_range);
  if (answers.view) s.view = String(answers.view);
  if (answers.caliber) s.caliber = String(answers.caliber);
  if (answers.target) s.target = String(answers.target);
  return s;
}

// ============ §5 问题树：校验（M2.1） ============
export function validatePlan(steps) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, errors: ["问题树为空"], warnings };
  if (steps.length > LIMITS.maxSteps) errors.push(`问题树节点数 ${steps.length} 超过上限 ${LIMITS.maxSteps}，请精简`);

  const seen = new Set();
  for (const s of steps) {
    const key = s.kind === "analysis"
      ? `analysis:${String(s.sub_question || s.title).trim()}`
      : `${s.tool_name}:${JSON.stringify(s.args || {})}`;
    if (seen.has(key)) errors.push(`问题树节点「${s.title}」与前序节点重复（同工具同入参/同子问题），属无效重复调用`);
    seen.add(key);
    if (s.kind === "tool") {
      const contract = TOOL_CONTRACTS.find((t) => t.name === s.tool_name);
      if (!contract) errors.push(`问题树节点「${s.title}」引用了不存在的工具 ${s.tool_name}`);
      else {
        for (const req of contract.params.required || []) {
          if (!s.args || s.args[req] === undefined) errors.push(`问题树节点「${s.title}」缺少工具 ${s.tool_name} 必填参数 ${req}`);
        }
        if (s.tool_name === "calc" && s.args?.expression !== undefined && !/^[\d+\-*/(). %]+$/.test(String(s.args.expression))) {
          errors.push(`问题树节点「${s.title}」的 calc 入参不合理：expression 必须是纯算式，不能是自然语言描述`);
        }
      }
    }
    if (!s.sub_question || String(s.sub_question).trim().length < 4) {
      warnings.push(`节点「${s.title}」未声明其服务的子问题，存在偏离研究目标风险`);
    }
    if (!s.hypothesis || String(s.hypothesis).trim().length < 2) {
      warnings.push(`节点「${s.title}」未声明研究假设（hypothesis）`);
    }
  }
  // 依赖环检测
  const seqMap = new Map(steps.map((s, i) => [s.seq ?? i + 1, i]));
  const state = new Array(steps.length).fill(0);
  function dfs(i) {
    state[i] = 1;
    for (const dep of steps[i].depends_on || []) {
      const j = seqMap.get(dep);
      if (j === undefined) continue;
      if (state[j] === 1) errors.push("问题树存在循环依赖");
      else if (state[j] === 0) dfs(j);
    }
    state[i] = 2;
  }
  steps.forEach((_, i) => { if (state[i] === 0) dfs(i); });

  return { ok: errors.length === 0, errors, warnings };
}

// ============ 研究剧本（问题域框架，M13） ============
export const PLAYBOOKS = {
  risk_scan: { label: "风险梳理", hint: "经营端 → 财务端 → 估值端 → 风险端，交叉核对异常项" },
  peer_compare: { label: "多标的对比", hint: "每个标的先财务与估值 → 统一口径汇总 → 差异与不可比口径" },
  event_attribution: { label: "事件归因", hint: "事件/公告时间线 → 事件前后行情 → 资讯检索 → 区间变动与口径核对" },
};
export function pickPlaybook(goal) {
  if (/对比|比较|vs|谁更/i.test(goal)) return "peer_compare";
  if (/事件|归因|为什么(涨|跌)|公告影响/i.test(goal)) return "event_attribution";
  return "risk_scan";
}

// ============ §5 问题树生成（规划 + 校验 + 回炉） ============
export async function generateIssueTree(thread, scope = defaultScope(), onProgress = null) {
  const playbookKey = pickPlaybook(thread.goal);
  const playbook = PLAYBOOKS[playbookKey];
  const toolDesc = TOOL_CONTRACTS.map((t) => `- ${t.name} [风险:${t.risk}]: ${t.description}`).join("\n");

  const sys = `你是投研 Agent 的规划器。围绕用户的研究目标，产出「假设驱动的问题树」（研究提纲）。
要求：
1. 只做事实梳理与数据核对，禁止输出涨跌预测、买卖建议、收益承诺。
2. 问题树拆的是「研究问题」而不是工具步骤：3~${Math.min(8, LIMITS.maxSteps)} 个节点，每个节点必须声明 sub_question（子问题）与 hypothesis（待验证假设）。
3. 每个节点声明 data_needed（需要哪些数据）、kind（tool 调用工具取数 / analysis 基于证据归纳）、tool_name/args（kind=tool 时）、depends_on（依赖的 node_id，必须无环）。
4. 不得安排重复调用（同工具同入参）。
5. 参考剧本的问题域框架：${playbook.label} —— ${playbook.hint}
可用工具：
${toolDesc}
输出严格 JSON：
{"playbook":"${playbookKey}","scope":{"time_range":"...","view":"...","caliber":"..."},"nodes":[{"node_id":"Q1","parent_id":null,"sub_question":"...","hypothesis":"...","data_needed":["..."],"kind":"tool","tool_name":"get_financials","args":{"symbol":"..."},"depends_on":[]}]}`;

  // 附注收窄（方案C）：目标已识别出标的（代码/公司后缀/已知标的词）就不追加「默认茅台演示」附注
  const userGoal = hasExplicitTarget(thread.goal) ? thread.goal : `${thread.goal}\n（若目标未指明标的，默认围绕 600519.SH 贵州茅台 进行演示）`;
  const userMsg = `研究目标：${userGoal}\n研究范围：时间=${scope.time_range}，视角=${scope.view}，口径=${scope.caliber}${scope.target ? `，标的=${scope.target}` : ""}`;
  const messages = [{ role: "system", content: sys }, { role: "user", content: userMsg }];

  let parsed = null;
  let validation = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    onProgress?.({ phase: "attempt", attempt: attempt + 1 });
    const res = await chat({ messages, model: MODEL_PLANNER, maxTokens: 2048, temperature: 0.2, cfg: cfgOf(thread) });
    trace(thread.id, null, "llm_call", `问题树生成（第 ${attempt + 1} 次）`, { model: MODEL_PLANNER, playbook: playbookKey }, res.usage, res.latencyMs);
    addTokens(thread.id, res.usage, res.latencyMs);

    parsed = extractJson(res.content);
    const nodes = parsed && Array.isArray(parsed.nodes) ? parsed.nodes : null;
    if (!nodes) {
      messages.push({ role: "assistant", content: (res.content || "(空)").slice(0, 2000) });
      messages.push({ role: "user", content: "输出不是合法问题树 JSON。请只输出符合格式的完整 JSON。" });
      continue;
    }
    const translated = translateNodes(nodes);
    validation = validatePlan(translated);
    if (validation.ok) {
      return { tree: { playbook: playbookKey, scope: parsed.scope || scope, nodes }, validation, attempts: attempt + 1 };
    }
    messages.push({ role: "assistant", content: JSON.stringify(parsed).slice(0, 4000) });
    messages.push({ role: "user", content: `问题树未通过前置校验，请修正后重新输出完整 JSON：\n${validation.errors.join("\n")}` });
  }
  return { tree: parsed && parsed.nodes ? { playbook: playbookKey, scope: parsed.scope || scope, nodes: parsed.nodes } : null, validation, attempts: 3 };
}

/** 问题树节点 → 执行投影（step 形状，供校验与执行引擎使用）
 * 编号规范化：node_id 一律按序重排为连续 Q1..Qn（LLM 自命名仅用于解析 depends_on/parent_id 映射） */
export function translateNodes(nodes) {
  const id2seq = new Map(nodes.map((n, i) => [n.node_id || `Q${i + 1}`, i + 1]));
  return nodes.map((n, i) => ({
    seq: i + 1,
    node_id: `Q${i + 1}`,
    parent_id: n.parent_id ? (id2seq.has(n.parent_id) ? `Q${id2seq.get(n.parent_id)}` : null) : null,
    title: String(n.sub_question || n.title || `节点${i + 1}`).slice(0, 40),
    sub_question: n.sub_question || "",
    hypothesis: n.hypothesis || "",
    data_needed: Array.isArray(n.data_needed) ? n.data_needed : [],
    kind: n.kind === "analysis" ? "analysis" : "tool",
    tool_name: n.kind === "analysis" ? null : n.tool_name,
    args: n.args || n.tool_params || {},
    depends_on: (n.depends_on || []).map((d) => (typeof d === "number" ? d : id2seq.get(d))).filter((x) => x !== undefined),
  }));
}

/** 编号规范化：树内增删/改序后重排 node_id 为连续 Q1..Qn（按 seq 序），并重写 parent_id 映射、清理悬空 depends_on */
export function renumberTree(planId) {
  const rows = db.prepare("SELECT * FROM steps WHERE plan_id = ? ORDER BY seq").all(planId);
  const validSeqs = new Set(rows.map((r) => r.seq));
  const node2new = new Map(rows.map((r, i) => [r.node_id, `Q${i + 1}`]));
  rows.forEach((r, i) => {
    let deps = [];
    try { deps = JSON.parse(r.depends_on || "[]"); } catch { /* 忽略脏数据 */ }
    deps = deps.filter((d) => validSeqs.has(d));
    const parent = r.parent_id ? (node2new.get(r.parent_id) ?? null) : null;
    db.prepare("UPDATE steps SET node_id = ?, parent_id = ?, depends_on = ? WHERE id = ?")
      .run(`Q${i + 1}`, parent, JSON.stringify(deps), r.id);
  });
  return rows.length;
}

/** 把问题树写入 steps 表（执行投影） */
export function saveTree(threadId, planId, tree) {
  const rows = translateNodes(tree.nodes);
  for (const r of rows) {
    db.prepare(`INSERT INTO steps(plan_id, seq, node_id, parent_id, title, sub_question, hypothesis, data_needed_json, kind, tool_name, args_json, depends_on, source, selected)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(planId, r.seq, r.node_id, r.parent_id, r.title, r.sub_question, r.hypothesis, JSON.stringify(r.data_needed),
        r.kind, r.tool_name, JSON.stringify(r.args), JSON.stringify(r.depends_on), "ai_generated", 1);
  }
  return rows;
}

// ============ 提纲编辑（human-in-the-loop 计划纠偏权） ============
export function toggleTreeNode(stepId, selected) {
  db.prepare("UPDATE steps SET selected = ? WHERE id = ?").run(selected ? 1 : 0, stepId);
  return db.prepare("SELECT * FROM steps WHERE id = ?").get(stepId);
}
export function addTreeNode(threadId, { title, sub_question, hypothesis, kind, tool_name, args, data_needed }) {
  const plan = db.prepare("SELECT * FROM plans WHERE thread_id = ? ORDER BY version DESC LIMIT 1").get(threadId);
  if (!plan) throw new Error("尚无提纲，无法添加节点");
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq),0) AS s FROM steps WHERE plan_id = ?").get(plan.id).s;
  const info = db.prepare(`INSERT INTO steps(plan_id, seq, node_id, title, sub_question, hypothesis, data_needed_json, kind, tool_name, args_json, source, selected)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`)
    .run(plan.id, maxSeq + 1, `Q${maxSeq + 1}`, String(title || "新问题").slice(0, 40), sub_question || title || "用户添加的研究问题",
      hypothesis || "（用户添加，未声明假设）", JSON.stringify(data_needed || []),
      kind === "analysis" ? "analysis" : "tool", tool_name || null, JSON.stringify(args || {}), "user_added");
  const id = lastInsertId(info);
  renumberTree(plan.id); // 编号规范化：插入后 Q1..Qn 连续
  return db.prepare("SELECT * FROM steps WHERE id = ?").get(id);
}
export function updateTreeNode(stepId, patch = {}) {
  const s = db.prepare("SELECT * FROM steps WHERE id = ?").get(stepId);
  if (!s) throw new Error("节点不存在");
  db.prepare("UPDATE steps SET title = COALESCE(?, title), sub_question = COALESCE(?, sub_question), hypothesis = COALESCE(?, hypothesis), tool_name = COALESCE(?, tool_name), args_json = COALESCE(?, args_json) WHERE id = ?")
    .run(patch.title || null, patch.sub_question || null, patch.hypothesis || null, patch.tool_name || null,
      patch.args ? JSON.stringify(patch.args) : null, stepId);
  return db.prepare("SELECT * FROM steps WHERE id = ?").get(stepId);
}
export function removeTreeNode(stepId) {
  const s = db.prepare("SELECT * FROM steps WHERE id = ?").get(stepId);
  db.prepare("DELETE FROM steps WHERE id = ?").run(stepId);
  if (s) renumberTree(s.plan_id); // 编号规范化：删除后 Q1..Qn 连续（不留断层）
}

// ============ 检查点（M5） ============
export function writeCheckpoint(threadId, planId, uptoSeq, note) {
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
  const steps = db.prepare("SELECT * FROM steps WHERE plan_id = ? ORDER BY seq").all(planId);
  const evRefs = db.prepare("SELECT id, metric, value_text, source, as_of FROM evidence WHERE thread_id = ? ORDER BY id").all(threadId);
  const snapshot = {
    plan: steps.map((s) => ({ seq: s.seq, title: s.title, status: s.status, result_summary: s.result_summary })),
    context_summary: t.context_summary,
    evidence_refs: evRefs,
    tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd,
  };
  const info = db.prepare("INSERT INTO checkpoints(thread_id, plan_id, upto_seq, snapshot_json, note) VALUES (?,?,?,?,?)")
    .run(threadId, planId, uptoSeq, JSON.stringify(snapshot), note || `完成至第 ${uptoSeq} 步`);
  const cp = { id: lastInsertId(info), upto_seq: uptoSeq, note };
  trace(threadId, null, "checkpoint", `检查点 #${cp.id}（完成至第 ${uptoSeq} 步）`, snapshot, {}, 0);
  emit(threadId, { type: "checkpoint", checkpoint: cp });
  return cp;
}

export function restoreCheckpoint(threadId, checkpointId) {
  const cp = db.prepare("SELECT * FROM checkpoints WHERE id = ? AND thread_id = ?").get(checkpointId, threadId);
  if (!cp) throw new Error("检查点不存在");
  const snap = JSON.parse(cp.snapshot_json);
  const plan = db.prepare("SELECT * FROM plans WHERE thread_id = ? ORDER BY version DESC LIMIT 1").get(threadId);
  for (const s of snap.plan) {
    if (s.seq <= cp.upto_seq) {
      db.prepare("UPDATE steps SET status = 'succeeded', result_summary = ? WHERE plan_id = ? AND seq = ?").run(s.result_summary, plan.id, s.seq);
    } else {
      db.prepare("UPDATE steps SET status = 'pending', error = NULL, result_summary = NULL WHERE plan_id = ? AND seq = ?").run(plan.id, s.seq);
    }
  }
  db.prepare("UPDATE threads SET context_summary = ?, status = 'active', stage = 'outline' WHERE id = ?").run(snap.context_summary, threadId);
  notice(threadId, "info", "system", `已从检查点 #${cp.id} 恢复（完成至第 ${cp.upto_seq} 步之前的进度），未完成节点回到待执行`);
  trace(threadId, null, "checkpoint", `从检查点 #${cp.id} 恢复`, { checkpoint_id: cp.id }, {}, 0);
  emit(threadId, { type: "restored", checkpoint_id: cp.id });
  return cp;
}

// ============ M3 上下文压缩（外置化 + 白名单 + 引用完整性校验） ============
export function maybeCompress(threadId) {
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
  if ((t.context_summary || "").length < LIMITS.compressThresholdChars) return null;
  return compressNow(threadId);
}

export async function compressNow(threadId) {
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
  const evidence = db.prepare("SELECT id, metric, value_text, unit, as_of, source FROM evidence WHERE thread_id = ? AND invalid = 0 ORDER BY id").all(threadId);
  const protectedBlock = evidence.map((e) => `[E${e.id}] ${e.metric} = ${e.value_text} (${e.unit || ""}) @${e.as_of} 来源:${e.source}`).join("\n");
  const res = await chat({
    messages: [
      { role: "system", content: "把工作记忆压缩为更短的摘要。硬性约束：证据引用行（[E?] 开头）必须原样保留在输出中，不得改写或删除任何数值、单位、时点；只压缩过程性叙述。" },
      { role: "user", content: `【证据（禁止压缩）】\n${protectedBlock}\n\n【工作记忆（可压缩）】\n${t.context_summary}` },
    ],
    model: MODEL_LIGHT, maxTokens: 1500, temperature: 0, cfg: cfgOf(t),
  });
  trace(threadId, null, "compress", `上下文压缩：${t.context_summary.length} → ${res.content.length} 字符`, { before: t.context_summary.length, after: res.content.length }, res.usage, res.latencyMs);
  addTokens(threadId, res.usage, res.latencyMs);

  const cited = [...res.content.matchAll(/\[E(\d+)\]/g)].map((m) => Number(m[1]));
  const validIds = new Set(evidence.map((e) => e.id));
  const lost = cited.filter((id) => !validIds.has(id));
  const droppedOriginal = evidence.filter((e) => !cited.includes(e.id));
  if (lost.length > 0) {
    notice(threadId, "warn", "system", "压缩结果未通过引用完整性校验（出现悬空引用），已回滚本次压缩");
    emit(threadId, { type: "compress", status: "rolled_back" });
    return { ok: false, reason: "dangling_refs" };
  }
  if (droppedOriginal.length > 0) {
    const append = "\n" + droppedOriginal.map((e) => `[E${e.id}] ${e.metric} = ${e.value_text} (${e.unit || ""}) @${e.as_of} 来源:${e.source}`).join("\n");
    db.prepare("UPDATE threads SET context_summary = ? WHERE id = ?").run(res.content + append, threadId);
    notice(threadId, "info", "system", `已自动压缩并补回 ${droppedOriginal.length} 条被压缩丢弃的证据引用（白名单保护），引用完整`);
  } else {
    db.prepare("UPDATE threads SET context_summary = ? WHERE id = ?").run(res.content, threadId);
    notice(threadId, "info", "system", `上下文已自动压缩（${t.context_summary.length} → ${res.content.length} 字符），证据引用完整`);
  }
  emit(threadId, { type: "compress", status: "done" });
  return { ok: true };
}

// ============ 审批（M6） ============
function approvalNeeded(step) {
  const contract = TOOL_CONTRACTS.find((t) => t.name === step.tool_name);
  if (!contract) return null;
  if (contract.risk === "external") {
    return { risk_level: "external", reason: "该操作为外部动作（对外导出/发送），按权限策略必须用户确认", cost_estimate: "低", data_volume: "产物 1 份" };
  }
  const days = step.args_json ? (JSON.parse(step.args_json).days || 0) : 0;
  if (days > 40) {
    return { risk_level: "costly", reason: "大批量数据拉取（>40 个交易日序列），成本/数据量较高，需用户确认", cost_estimate: "中", data_volume: `${days} 条序列` };
  }
  return null;
}

// ============ 主执行循环 ============
export async function runThread(threadId, { replay = null } = {}) {
  if (running.has(threadId)) return { ok: false, error: "该线程已在运行" };
  running.set(threadId, { stopped: false, startedAt: Date.now() });

  try {
    if (replay) return await runReplay(threadId, replay);

    const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
    const plan = db.prepare("SELECT * FROM plans WHERE thread_id = ? ORDER BY version DESC LIMIT 1").get(threadId);
    if (!plan) throw new Error("尚未生成问题树");
    db.prepare("UPDATE plans SET status = 'running' WHERE id = ?").run(plan.id);
    db.prepare("UPDATE threads SET status = 'active', stage = 'running' WHERE id = ?").run(threadId);
    emit(threadId, { type: "run_started" });

    let steps = db.prepare("SELECT * FROM steps WHERE plan_id = ? ORDER BY seq").all(plan.id);
    for (const step of steps) {
      const ctl = running.get(threadId);
      if (ctl.stopped) { notice(threadId, "warn", "system", "用户触发停止规则，任务优雅收尾（已完成部分保留）"); break; }
      const wall = Date.now() - ctl.startedAt;
      const tNow = db.prepare("SELECT cost_usd FROM threads WHERE id = ?").get(threadId);
      if (steps.filter((s) => s.status === "succeeded").length >= LIMITS.maxSteps) { notice(threadId, "warn", "system", "达到最大节点数上限，优雅收尾"); break; }
      if (tNow.cost_usd > LIMITS.maxCostUsd) { notice(threadId, "warn", "system", `累计成本 ${tNow.cost_usd} 超过预算上限 ${LIMITS.maxCostUsd}，优雅收尾`); break; }
      if (wall > LIMITS.maxWallMs) { notice(threadId, "warn", "system", "达到最大时延上限，优雅收尾"); break; }

      if (step.status === "succeeded" || step.status === "skipped") continue;
      if (!step.selected) {
        db.prepare("UPDATE steps SET status = 'skipped', error = '用户未勾选该问题' WHERE id = ?").run(step.id);
        emit(threadId, { type: "step_updated", step_id: step.id, status: "skipped" });
        continue;
      }

      // 审批门（升级为对话流决策卡）
      const need = approvalNeeded(step);
      if (need && step.status !== "waiting_approval") {
        const info = db.prepare("INSERT INTO approvals(thread_id, step_id, action, risk_level, reason, cost_estimate, data_volume) VALUES (?,?,?,?,?,?,?)")
          .run(threadId, step.id, `${step.title}（${step.tool_name}）`, need.risk_level, need.reason, need.cost_estimate, need.data_volume);
        const aid = lastInsertId(info);
        db.prepare("UPDATE steps SET status = 'waiting_approval' WHERE id = ?").run(step.id);
        emit(threadId, { type: "approval_required", approval: { id: aid, step_id: step.id, action: step.title, risk_level: need.risk_level, reason: need.reason } });
        addMessage(threadId, "system", "decision", {
          type: "approval", approval_id: aid, title: `需要你确认：${step.title}`,
          reason: need.reason, risk_level: need.risk_level, cost_estimate: need.cost_estimate, data_volume: need.data_volume,
          options: [{ id: "approved", label: "批准执行" }, { id: "rejected", label: "拒绝" }],
        });
        const approved = await waitForApproval(threadId, step.id, 60000);
        if (!approved) {
          db.prepare("UPDATE steps SET status = 'skipped', error = '未获审批/审批超时' WHERE id = ?").run(step.id);
          notice(threadId, "warn", "system", `节点「${step.title}」未获审批，已跳过`);
          continue;
        }
      }

      await executeStep(threadId, plan, step);
      writeCheckpoint(threadId, plan.id, step.seq, null);
      maybeCompress(threadId);
      steps = db.prepare("SELECT * FROM steps WHERE plan_id = ? ORDER BY seq").all(plan.id);
    }

    // 产物（四分区报告 + 确定性校验 + 合规过滤）
    const doneSteps = db.prepare("SELECT * FROM steps WHERE plan_id = ? AND status IN ('succeeded','degraded') ORDER BY seq").all(plan.id);
    if (doneSteps.length > 0) {
      await synthesizeArtifact(threadId);
      await proposeMemories(threadId);
    }
    db.prepare("UPDATE plans SET status = 'done' WHERE id = ?").run(plan.id);
    db.prepare("UPDATE threads SET status = 'completed', stage = 'report' WHERE id = ?").run(threadId);
    emit(threadId, { type: "run_finished" });
    return { ok: true };
  } catch (err) {
    notice(threadId, "warn", "system", `执行异常：${err.message}（已保留已完成进度，可从检查点恢复）`);
    trace(threadId, null, "error", err.message, { stack: String(err.stack || "").slice(0, 500) }, {}, 0);
    emit(threadId, { type: "run_error", error: err.message });
    return { ok: false, error: err.message };
  } finally {
    running.delete(threadId);
  }
}

async function waitForApproval(threadId, stepId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = db.prepare("SELECT a.status FROM approvals a WHERE a.thread_id = ? AND a.step_id = ? ORDER BY a.id DESC LIMIT 1").get(threadId, stepId);
    if (row && row.status === "approved") return true;
    if (row && row.status === "rejected") return false;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

// ============ 单节点执行（证据优先：先落证据卡） ============
const TYPE_BY_TOOL = {
  get_quote: "market_data", get_kline: "market_data", get_financials: "financial",
  get_valuation: "valuation", search_news: "news", get_announcements: "news",
  get_events: "macro", calc: "derived", export_report: "external",
};

async function executeStep(threadId, plan, step) {
  db.prepare("UPDATE steps SET status = 'running', started_at = datetime('now','localtime') WHERE id = ?").run(step.id);
  emit(threadId, { type: "step_updated", step_id: step.id, status: "running" });

  const args = JSON.parse(step.args_json || "{}");
  const t0 = Date.now();
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);

  try {
    let result;
    if (step.kind === "tool" && step.tool_name) {
      result = await executeTool(step.tool_name, args);
      trace(threadId, step.id, "tool_call", `${step.tool_name}(${JSON.stringify(args)}) → ${result.ok ? "ok" : "error"}`, { args, ok: result.ok, degraded: result.degraded || false }, {}, Date.now() - t0);
    } else {
      // analysis 节点：基于证据归纳（产出不是证据，不落证据卡；结论带 [E?] 引用）
      const evidence = db.prepare("SELECT id, metric, value_text, unit, as_of, source, caliber FROM evidence WHERE thread_id = ? AND invalid = 0 ORDER BY id").all(threadId);
      const evBlock = evidence.map((e) => `[E${e.id}] ${e.metric} = ${e.value_text} (${e.unit || ""}) @${e.as_of} 口径:${e.caliber || "-"} 来源:${e.source}`).join("\n") || "（暂无证据）";
      const res = await chat({
        messages: [
          { role: "system", content: "你是投研分析助手。仅基于给定证据做归纳，输出 3~5 条要点，每条要点后用 [E?] 标注引用的证据编号。禁止预测涨跌、禁止买卖建议；证据不支持的判断必须显式标注为『未验证推断』。" },
          { role: "user", content: `研究目标：${thread.goal}\n子问题：${step.sub_question || step.title}\n假设：${step.hypothesis || "-"}\n\n证据：\n${evBlock}` },
        ],
        model: MODEL_PLANNER, maxTokens: 1200, cfg: cfgOf(thread),
      });
      addTokens(threadId, res.usage, res.latencyMs);
      trace(threadId, step.id, "llm_call", "分析节点归纳", {}, res.usage, res.latencyMs);
      result = { ok: true, analysis: true, value_text: res.content.slice(0, 200), content: { points: res.content } };
    }

    const latency = Date.now() - t0;
    if (!result.ok) {
      const retry = step.retry_count + 1;
      db.prepare("UPDATE steps SET retry_count = ?, error = ? WHERE id = ?").run(retry, result.error, step.id);
      if (retry <= 1 && result.degraded) {
        emit(threadId, { type: "step_retry", step_id: step.id, error: result.error });
        await new Promise((r) => setTimeout(r, 600));
        return executeStep(threadId, plan, step);
      }
      db.prepare("UPDATE steps SET status = 'degraded', degrade_reason = ?, finished_at = datetime('now','localtime') WHERE id = ?").run(result.error, step.id);
      emit(threadId, { type: "step_updated", step_id: step.id, status: "degraded", error: result.error });
      if (result.notice) notice(threadId, result.notice.level, result.notice.category, result.notice.message, result.notice.detail || {});
      appendContext(threadId, `节点「${step.title}」降级：${result.error}（不据此下结论）`);
      return;
    }

    if (result.notice) notice(threadId, result.notice.level, result.notice.category, result.notice.message, result.notice.detail || {});

    let evId = null;
    if (!result.analysis) {
      // 证据卡落库（v4 §6.1 Schema：值+来源+时点+单位+口径+原文引用+状态）
      const status = result.notice?.category === "data_missing" ? "missing"
        : result.notice?.category === "data_conflict" ? "conflict"
        : result.notice?.category === "data_stale" ? "stale" : "ok";
      const rawRef = `tool://${step.tool_name}?${new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)])).toString()}`;
      const rawSnippet = JSON.stringify(result.data ?? result.content ?? {}).slice(0, 600);
      const evInfo = db.prepare(
        `INSERT INTO evidence(topic_id, thread_id, step_id, kind, label, type, source, source_detail, as_of, unit, caliber, metric, value_text, raw_ref, raw_snippet, status, content_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        thread.topic_id ?? null, threadId, step.id, "tool", result.label || "mock",
        TYPE_BY_TOOL[step.tool_name] || "market_data", result.source || step.tool_name,
        `${step.tool_name}(${JSON.stringify(args)})`, result.as_of || null, result.unit || "", result.caliber || "",
        result.metric || step.title, result.value_text || "", rawRef, rawSnippet, status,
        JSON.stringify(result.data ?? result.content ?? {})
      );
      evId = lastInsertId(evInfo);
      // 证据 id 挂回节点（执行投影）
      const ids = JSON.parse(step.evidence_ids_json || "[]");
      ids.push(evId);
      db.prepare("UPDATE steps SET evidence_ids_json = ? WHERE id = ?").run(JSON.stringify(ids), step.id);
      emit(threadId, { type: "evidence", evidence_id: evId });

      // 数据冲突 → 对话流决策卡（指定主源）
      if (status === "conflict") {
        const detail = result.notice?.detail || {};
        addMessage(threadId, "system", "decision", {
          type: "conflict", title: "数据冲突，需要你指定主源",
          description: result.notice?.message || "同一指标多源不一致，已双源陈列",
          evidence_ids: [evId], detail,
          options: [
            { id: "source_a", label: `以源A 为主源（${detail.source_a?.caliber || "A"}）` },
            { id: "source_b", label: `以源B 为主源（${detail.source_b?.caliber || "B"}）` },
          ],
        });
      }
    }

    db.prepare("UPDATE steps SET status = ?, result_summary = ?, finished_at = datetime('now','localtime'), latency_ms = ? WHERE id = ?")
      .run(result.degraded ? "degraded" : "succeeded", result.value_text || "完成", latency, step.id);
    emit(threadId, { type: "step_updated", step_id: step.id, status: result.degraded ? "degraded" : "succeeded", result_summary: result.value_text, evidence_id: evId });
    appendContext(threadId, `节点「${step.title}」完成：${result.value_text || ""}${evId ? `（引用 [E${evId}]）` : ""}`);
  } catch (err) {
    db.prepare("UPDATE steps SET status = 'degraded', degrade_reason = ?, finished_at = datetime('now','localtime') WHERE id = ?").run(err.message, step.id);
    emit(threadId, { type: "step_updated", step_id: step.id, status: "degraded", error: err.message });
    notice(threadId, "warn", "tool_failure", `节点「${step.title}」执行异常已降级：${err.message}`);
  }
}

function appendContext(threadId, line) {
  const t = db.prepare("SELECT context_summary FROM threads WHERE id = ?").get(threadId);
  const next = (t.context_summary ? t.context_summary + "\n" : "") + line;
  db.prepare("UPDATE threads SET context_summary = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(next, threadId);
}

// ============ §6.2 报告产物（四分区 + 确定性校验器 + 合规过滤） ============
const REPORT_SECTIONS = ["summary", "facts", "inferences", "unverified", "data_quality"];

function nums(text) {
  return new Set((String(text || "").match(/\d+(?:\.\d+)?/g) || []).map((n) => String(Number(n))));
}

/** 确定性校验器：无引用不进事实区 / 数值与证据一致 / 置信度必填 / 悬空引用清理 */
export function validateReport(content, validIds) {
  const moved = [];
  const warnings = [];
  content.summary = Array.isArray(content.summary) ? content.summary : [{ text: String(content.summary || ""), refs: [] }];
  content.facts = Array.isArray(content.facts) ? content.facts : [];
  content.inferences = Array.isArray(content.inferences) ? content.inferences : [];
  content.unverified = Array.isArray(content.unverified) ? content.unverified : [];
  content.data_quality = Array.isArray(content.data_quality) ? content.data_quality : [];

  const keepFact = (item) => {
    const refs = (item.refs || []).filter((r) => validIds.has(Number(r)));
    if (refs.length === 0) return { ok: false, reason: "无有效证据引用" };
    // 数值一致性：事实句含数字时，必须与至少一条引用证据的数字对得上
    const textNums = nums(item.text);
    if (textNums.size > 0) {
      const evNums = new Set();
      for (const r of refs) {
        const ev = validIds.get(Number(r));
        for (const n of nums(ev?.value_text + " " + (ev?.raw_snippet || ""))) evNums.add(n);
      }
      if (evNums.size > 0 && [...textNums].every((n) => !evNums.has(n))) return { ok: false, reason: "数值与证据不一致" };
    }
    item.refs = refs;
    return { ok: true };
  };

  content.facts = content.facts.filter((f) => {
    const r = keepFact(f);
    if (!r.ok) {
      moved.push({ id: f.id, reason: r.reason });
      content.unverified.push({ id: f.id || `U${content.unverified.length + 1}`, text: `【移入待验证】${f.text}`, refs: [] });
      return false;
    }
    return true;
  });
  content.summary = content.summary.filter((f) => {
    const r = keepFact(f);
    if (!r.ok) {
      if (f.text) content.unverified.push({ id: `U${content.unverified.length + 1}`, text: `【移入待验证】${f.text}`, refs: [] });
      return false;
    }
    return true;
  });
  content.inferences.forEach((inf) => {
    inf.refs = (inf.refs || []).filter((r) => validIds.has(Number(r)));
    if (!inf.confidence) { inf.confidence = "低"; warnings.push(`推断「${String(inf.text).slice(0, 12)}…」未给置信度，已默认为低`); }
    if (!inf.counter_conditions) inf.counter_conditions = "（未给反驳条件）";
    if (inf.refs.length === 0) inf.text = `【未验证推断】${inf.text}`;
  });
  content.unverified.forEach((u) => {
    u.refs = (u.refs || []).filter((r) => validIds.has(Number(r)));
  });
  return { content, report: { moved, warnings } };
}

const BANNED_OUTPUT = [
  { re: /(建议|推荐).{0,6}(买入|卖出|加仓|清仓)/g, label: "买卖建议" },
  { re: /(一定|必然|肯定|必将).{0,6}(涨|跌|上涨|下跌)/g, label: "确定性涨跌表述" },
  { re: /(目标价|预期收益|收益承诺|稳赚|保底收益)/g, label: "收益承诺/目标价" },
];

export function complianceFilter(content) {
  const report = { blocked: [], rewrites: [], passed: true };
  const scan = (text) => {
    let out = String(text || "");
    for (const b of BANNED_OUTPUT) {
      b.re.lastIndex = 0;
      if (b.re.test(out)) {
        b.re.lastIndex = 0;
        out = out.replace(b.re, "[已按合规要求移除表述]");
        report.blocked.push(b.label);
        report.passed = false;
      }
    }
    return out;
  };
  const scanList = (arr, rewritesUnverified) => (arr || []).forEach((f) => {
    f.text = scan(f.text || "");
    if (rewritesUnverified && (!f.refs || f.refs.length === 0) && !String(f.text).startsWith("【")) {
      f.text = `【未验证推断】${f.text}`;
      report.rewrites.push("无证据引用的判断已强制标注『未验证推断』");
    }
  });
  if (Array.isArray(content.summary)) scanList(content.summary);
  else content.summary = scan(content.summary || "");
  if (typeof content.narrative === "string") content.narrative = scan(content.narrative);
  scanList(content.facts);
  scanList(content.inferences, true);
  scanList(content.unverified);
  scanList(content.data_quality);
  if (Array.isArray(content.risks)) {
    content.risks.forEach((r, i) => (content.risks[i] = scan(r)));
    if (content.risks.length === 0) content.risks.push("本报告为研究分析，不构成任何投资建议；数据为构造数据（演示环境），请以真实数据源为准。");
  } else content.risks = ["本报告为研究分析，不构成任何投资建议；数据为构造数据（演示环境），请以真实数据源为准。"];
  return { content, report };
}

export async function synthesizeArtifact(threadId) {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
  const evidence = db.prepare("SELECT * FROM evidence WHERE thread_id = ? AND invalid = 0 ORDER BY id").all(threadId);
  const notices = db.prepare("SELECT * FROM notices WHERE thread_id = ? ORDER BY id DESC LIMIT 10").all(threadId);
  const plan = db.prepare("SELECT * FROM plans WHERE thread_id = ? ORDER BY version DESC LIMIT 1").get(threadId);
  const scope = plan ? JSON.parse(plan.scope_json || "{}") : {};
  const evBlock = evidence.map((e) => `[E${e.id}] ${e.metric} = ${e.value_text} (${e.unit || ""}) @${e.as_of} 口径:${e.caliber || "-"} 来源:${e.source} 状态:${e.status}${e.kind === "user" ? "/用户补充" : ""}`).join("\n") || "（无证据）";
  const validIds = new Map(evidence.map((e) => [e.id, e]));

  const res = await chat({
    messages: [
      {
        role: "system",
        content: `你是投研助手，输出结构化研究报告。产物包含两层：narrative（连贯正文，主阅读面）+ 四分区明细（事实清单 / 归纳与推断 / 待验证假设 / 数据质量说明，作核对附录）。硬性合规约束：
1. 禁止出现涨跌预测、买卖建议、收益承诺、目标价；2. facts 与 summary 每条必须带 refs（[E?] 证据编号数组），无法溯源的内容只能进 unverified；3. inferences 必须给 confidence（高/中/低）与 counter_conditions（反驳条件）；4. 必须如实列出数据缺失/冲突/降级情况。
5. narrative 写成连贯的研究短文（导语一段 + 若干连续段落，800~1500 字）：正文里行内用 [E?] 标注证据引用（如「营收同比 +12.4% [E1]」），推断性表述在句末加「（推断）」，无证据支撑的判断写明「（未验证）」；不要输出小标题堆砌或条目列表，要让不看附录的读者也能读懂结论与风险。
输出 JSON：
{"title":"","narrative":"",
 "summary":[{"text":"","refs":[]}],
 "facts":[{"id":"F1","text":"","refs":[1]}],
 "inferences":[{"id":"I1","text":"","refs":[1],"confidence":"高/中/低","counter_conditions":""}],
 "unverified":[{"id":"U1","text":"","refs":[]}],
 "data_quality":[{"text":"","refs":[]}]}`,
      },
      { role: "user", content: `研究目标：${thread.goal}\n研究范围：${JSON.stringify(scope)}\n\n证据：\n${evBlock}\n\n运行通知（数据质量线索）：\n${notices.map((n) => `- [${n.level}/${n.category}] ${n.message}`).join("\n")}` },
    ],
    model: MODEL_PLANNER, maxTokens: 4096, cfg: cfgOf(thread),
  });
  addTokens(threadId, res.usage, res.latencyMs);
  trace(threadId, null, "llm_call", "报告合成", { scope }, res.usage, res.latencyMs);

  let content = extractJson(res.content) || {
    title: "研究报告", narrative: "（报告生成失败：模型输出无法解析为 JSON，原始输出见开发者模式 trace。以下为仅有的可核对内容。）",
    summary: [], facts: [], inferences: [],
    unverified: [{ id: "U1", text: "（生成失败，原始输出见开发者模式 trace）", refs: [] }], data_quality: [],
  };
  const validated = validateReport(content, validIds);
  content = validated.content;
  const compliance = complianceFilter(content);
  content = compliance.content;

  const maxVer = db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM artifacts WHERE thread_id = ?").get(threadId).v;
  db.prepare("UPDATE artifacts SET is_current = 0 WHERE thread_id = ?").run(threadId);
  const info = db.prepare("INSERT INTO artifacts(thread_id, version, template, content_json, compliance_json, changelog, is_current) VALUES (?,?,?,?,?,?,1)")
    .run(threadId, maxVer + 1, pickPlaybook(thread.goal), JSON.stringify(content), JSON.stringify(compliance.report), `v${maxVer + 1}: 首次生成`);
  const artifact = { id: lastInsertId(info), version: maxVer + 1, content, compliance: compliance.report, validation: validated.report };
  if (validated.report.moved.length) {
    notice(threadId, "warn", "compliance", `确定性校验器将 ${validated.report.moved.length} 条无引用/数值不符的内容移入「待验证假设」`);
  }
  emit(threadId, { type: "artifact", artifact });
  return artifact;
}

// ============ §4.3/§7 对话式修订（字段级 patch + 版本 + diff） ============
export function artifactDiff(oldC, newC) {
  const diff = { added: [], removed: [], changed: [] };
  for (const sec of REPORT_SECTIONS) {
    const olds = oldC?.[sec] || [];
    const news = newC?.[sec] || [];
    const key = (it, i) => it.id || `${sec[0].toUpperCase()}${i + 1}`;
    const oldMap = new Map(olds.map((it, i) => [key(it, i), it]));
    const newMap = new Map(news.map((it, i) => [key(it, i), it]));
    for (const [id, it] of newMap) {
      if (!oldMap.has(id)) diff.added.push({ section: sec, id, text: it.text });
      else if (oldMap.get(id).text !== it.text || JSON.stringify(oldMap.get(id).refs) !== JSON.stringify(it.refs)) {
        diff.changed.push({ section: sec, id, old_text: oldMap.get(id).text, new_text: it.text });
      }
    }
    for (const [id, it] of oldMap) {
      if (!newMap.has(id)) diff.removed.push({ section: sec, id, text: it.text });
    }
  }
  // 连贯正文（narrative）整体差异：空→有=新增，有→空=删除，均有但不同=修改（截断展示）
  const oldN = String(oldC?.narrative || "");
  const newN = String(newC?.narrative || "");
  const clip = (t) => (t.length > 160 ? `${t.slice(0, 160)}…` : t);
  if (oldN !== newN) {
    if (!oldN) diff.added.push({ section: "narrative", id: "N0", text: clip(newN) });
    else if (!newN) diff.removed.push({ section: "narrative", id: "N0", text: clip(oldN) });
    else diff.changed.push({ section: "narrative", id: "N0", old_text: clip(oldN), new_text: clip(newN) });
  }
  return diff;
}

export async function reviseArtifact(threadId, instruction) {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
  const cur = db.prepare("SELECT * FROM artifacts WHERE thread_id = ? AND is_current = 1 ORDER BY version DESC LIMIT 1").get(threadId);
  if (!cur) throw new Error("尚无可修订的报告");
  const oldContent = JSON.parse(cur.content_json);
  const evidence = db.prepare("SELECT * FROM evidence WHERE thread_id = ? AND invalid = 0 ORDER BY id").all(threadId);
  const validIds = new Map(evidence.map((e) => [e.id, e]));
  const evBlock = evidence.map((e) => `[E${e.id}] ${e.metric} = ${e.value_text} (${e.unit || ""}) @${e.as_of} 来源:${e.source} 状态:${e.status}`).join("\n") || "（无证据）";

  const sysPrompt = `你是投研助手，按用户指令对研究报告做「字段级修订」。硬性约束：
1. 输出修订后的完整报告 JSON（schema：title/narrative/summary/facts/inferences/unverified/data_quality，各项带 id/text/refs，inferences 另带 confidence/counter_conditions）；
2. narrative 是连贯的研究正文（导语+连续段落，行内 [E?] 引用、推断句末加「（推断）」），修订涉及内容变化时必须同步改写 narrative，保持与分区明细一致；
3. 禁止涨跌预测、买卖建议、收益承诺、目标价；事实必须带 refs，无法溯源的内容放 unverified；
4. changelog 用一句话概括改了什么。
输出 JSON：{"report":{...},"changelog":""}`;

  // 校验回炉：解析失败重试 ≤2 次（Harness 约定：失败重试→再失败显式报错，不静默）
  let parsed = null;
  for (let attempt = 0; attempt <= 2 && !parsed; attempt++) {
    const res = await chat({
      messages: [
        {
          role: "system",
          content: attempt === 0
            ? sysPrompt
            : `${sysPrompt}\n注意：上一次输出无法解析为 JSON。这次只输出一个完整 JSON 对象，从第一个字符 { 开始、以 } 结束，不要 markdown 代码块、不要解释文字、不要省略括号；各项 text 尽量精炼（每条 ≤60 字），确保 JSON 完整收尾。`,
        },
        { role: "user", content: `研究目标：${thread.goal}\n\n当前报告：\n${JSON.stringify(oldContent)}\n\n修订指令：${instruction}\n\n可用证据：\n${evBlock}` },
      ],
      model: MODEL_PLANNER, maxTokens: 4096, cfg: cfgOf(thread),
    });
    addTokens(threadId, res.usage, res.latencyMs);
    trace(threadId, null, "llm_call", `报告修订${attempt > 0 ? `(回炉${attempt})` : ""}：${String(instruction).slice(0, 40)}`, { attempt }, res.usage, res.latencyMs);
    parsed = extractJson(res.content);
    if (parsed && !parsed.report) parsed = null;
    if (!parsed && attempt < 2) {
      notice(threadId, "warn", "system", `报告修订输出解析失败，已自动回炉重试（第 ${attempt + 1} 次）`);
    }
  }
  if (!parsed) throw new Error("修订输出不是合法 JSON（已回炉 2 次仍失败，请调整指令后重试）");
  const validated = validateReport(parsed.report, validIds);
  const compliance = complianceFilter(validated.content);
  const newContent = compliance.content;
  const diff = artifactDiff(oldContent, newContent);

  const version = cur.version + 1;
  const changelog = parsed.changelog || `v${version}: ${String(instruction).slice(0, 40)}`;
  db.prepare("UPDATE artifacts SET is_current = 0 WHERE thread_id = ?").run(threadId);
  const info = db.prepare("INSERT INTO artifacts(thread_id, version, template, content_json, compliance_json, changelog, is_current) VALUES (?,?,?,?,?,?,1)")
    .run(threadId, version, cur.template, JSON.stringify(newContent), JSON.stringify(compliance.report), changelog);
  const artifact = { id: lastInsertId(info), version, content: newContent, compliance: compliance.report, changelog, diff };
  notice(threadId, "info", "system", `报告已修订为 v${version}：${changelog}`);
  emit(threadId, { type: "artifact", artifact });
  return artifact;
}

export function rollbackArtifact(threadId, version) {
  const target = db.prepare("SELECT * FROM artifacts WHERE thread_id = ? AND version = ?").get(threadId, version);
  if (!target) throw new Error("目标版本不存在");
  db.prepare("UPDATE artifacts SET is_current = 0 WHERE thread_id = ?").run(threadId);
  db.prepare("UPDATE artifacts SET is_current = 1 WHERE id = ?").run(target.id);
  notice(threadId, "info", "system", `报告已回滚到 v${version}`);
  emit(threadId, { type: "artifact", artifact: { id: target.id, version: target.version } });
  return target;
}

// ============ 记忆（M4 候选记忆，挂主题） ============
export async function proposeMemories(threadId) {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
  const res = await chat({
    messages: [
      { role: "system", content: "从本次研究任务中提炼 0~3 条值得长期记住的用户偏好或事实结论，输出 JSON：{\"memories\":[\"...\"]}。不确定或可能是错误事实的不要输出。" },
      { role: "user", content: `目标：${thread.goal}\n工作记忆：${(thread.context_summary || "").slice(0, 1500)}` },
    ],
    model: MODEL_LIGHT, maxTokens: 600, cfg: cfgOf(thread),
  });
  addTokens(threadId, res.usage, res.latencyMs);
  const parsed = extractJson(res.content);
  const items = (parsed && Array.isArray(parsed.memories) ? parsed.memories : []).slice(0, 3);
  for (const m of items) {
    db.prepare("INSERT INTO memories(topic_id, thread_id, scope, status, content) VALUES (?,?,?,?,?)")
      .run(thread.topic_id ?? null, threadId, "user", "candidate", m);
  }
  if (items.length) {
    notice(threadId, "info", "system", `已生成 ${items.length} 条候选记忆，等待用户确认后才会写入主题记忆（防记忆污染）`);
    emit(threadId, { type: "memories_proposed" });
  }
  return items;
}

export function decideMemory(id, accept) {
  db.prepare("UPDATE memories SET status = ? WHERE id = ?").run(accept ? "active" : "archived", id);
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
}

// ============ 演示模式（轨迹重放，显式区分） ============
async function runReplay(threadId, traj) {
  emit(threadId, { type: "run_started", replay: true });
  notice(threadId, "info", "system", "当前为【演示模式：轨迹重放】——以下执行为预置轨迹回放，非实时 LLM 调用；界面徽章与 README 已声明");
  db.prepare("UPDATE threads SET stage = 'running' WHERE id = ?").run(threadId);
  const plan = db.prepare("SELECT * FROM plans WHERE thread_id = ? ORDER BY version DESC LIMIT 1").get(threadId);
  const replayEvIds = []; // 重放期间实际落库的证据 id（按顺序），用于产物引用重映射
  for (const ev of traj.events) {
    const ctl = running.get(threadId);
    if (ctl && ctl.stopped) break;
    await new Promise((r) => setTimeout(r, ev.delay_ms ?? 700));
    trace(threadId, null, `replay:${ev.type}`, `重放事件 ${ev.type}${ev.status ? " → " + ev.status : ""}`, { replay: true, type: ev.type }, {}, ev.delay_ms ?? 700);
    if (ev.type === "step_updated") {
      db.prepare("UPDATE steps SET status = ?, result_summary = COALESCE(?, result_summary), error = COALESCE(?, error) WHERE plan_id = ? AND seq = ?")
        .run(ev.status, ev.result_summary || null, ev.error || null, plan.id, ev.seq);
    } else if (ev.type === "notice") {
      notice(threadId, ev.level || "info", ev.category || "system", ev.message);
      continue;
    } else if (ev.type === "evidence") {
      const e = ev.evidence;
      const t = db.prepare("SELECT topic_id FROM threads WHERE id = ?").get(threadId);
      const info = db.prepare(
        `INSERT INTO evidence(topic_id, thread_id, step_id, kind, label, type, source, source_detail, as_of, unit, caliber, metric, value_text, raw_ref, raw_snippet, status, content_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(t.topic_id ?? null, threadId, e.step_seq ? db.prepare("SELECT id FROM steps WHERE plan_id = ? AND seq = ?").get(plan.id, e.step_seq)?.id || null : null,
        "tool", e.label || "mock", e.type || "market_data", e.source || "replay", e.source_detail || "演示轨迹", e.as_of || null,
        e.unit || "", e.caliber || "", e.metric || "", e.value_text || "", e.raw_ref || "replay://demo", (e.raw_snippet || "").slice(0, 600),
        e.status || "ok", JSON.stringify(e.content || {}));
      replayEvIds.push(lastInsertId(info));
      emit(threadId, { type: "evidence", evidence_id: lastInsertId(info) });
      continue;
    } else if (ev.type === "checkpoint") {
      writeCheckpoint(threadId, plan.id, ev.seq, ev.note || "重放检查点");
      continue;
    } else if (ev.type === "artifact") {
      const evidence = db.prepare("SELECT * FROM evidence WHERE thread_id = ? AND invalid = 0 ORDER BY id").all(threadId);
      const validIds = new Map(evidence.map((e) => [e.id, e]));
      // 引用重映射：轨迹里的 refs 是顺序编号（1..n），映射为本次重放实际落库的证据 id
      const remapRefs = (item) => {
        item.refs = (item.refs || []).map((r) => replayEvIds[Number(r) - 1]).filter((x) => x !== undefined);
        return item;
      };
      const c = ev.artifact.content || {};
      (Array.isArray(c.summary) ? c.summary : []).forEach(remapRefs);
      (c.facts || []).forEach(remapRefs);
      (c.inferences || []).forEach(remapRefs);
      (c.unverified || []).forEach(remapRefs);
      (c.data_quality || []).forEach(remapRefs);
      // 连贯正文里的行内 [E?] 引用同样按顺序重映射为本次落库证据 id
      if (typeof c.narrative === "string") {
        c.narrative = c.narrative.replace(/\[E(\d+)\]/g, (m, n) => {
          const nid = replayEvIds[Number(n) - 1];
          return nid === undefined ? m : `[E${nid}]`;
        });
      }
      const validated = validateReport(c, validIds);
      const compliance = complianceFilter(validated.content);
      const maxVer = db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM artifacts WHERE thread_id = ?").get(threadId).v;
      db.prepare("UPDATE artifacts SET is_current = 0 WHERE thread_id = ?").run(threadId);
      const info = db.prepare("INSERT INTO artifacts(thread_id, version, template, content_json, compliance_json, changelog, is_current) VALUES (?,?,?,?,?,?,1)")
        .run(threadId, maxVer + 1, ev.artifact.template || "risk_scan", JSON.stringify(compliance.content), JSON.stringify(compliance.report), `v${maxVer + 1}: 演示轨迹产物`);
      emit(threadId, { type: "artifact", artifact: { id: lastInsertId(info), version: maxVer + 1, content: compliance.content, compliance: compliance.report } });
      continue;
    } else if (ev.type === "memory") {
      db.prepare("INSERT INTO memories(topic_id, thread_id, scope, status, content) VALUES (?,?,?,?,?)")
        .run(db.prepare("SELECT topic_id FROM threads WHERE id = ?").get(threadId).topic_id ?? null, threadId, "user", "candidate", ev.content);
      continue;
    }
    emit(threadId, ev);
  }
  db.prepare("UPDATE plans SET status = 'done' WHERE id = ?").run(plan.id);
  db.prepare("UPDATE threads SET status = 'completed', stage = 'report' WHERE id = ?").run(threadId);
  emit(threadId, { type: "run_finished", replay: true });
  return { ok: true, replay: true };
}

export function stopThread(threadId) {
  const ctl = running.get(threadId);
  if (ctl) ctl.stopped = true;
  db.prepare("UPDATE threads SET status = 'stopped' WHERE id = ?").run(threadId);
  emit(threadId, { type: "stopped" });
}

export { LIMITS, setAnomaly, llmConfigured };
