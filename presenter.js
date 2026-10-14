// server/presenter.js — 前端视图模型契约（v4 §9 硬约束）
// 规则：普通视图（view=normal）只消费本层产出的 view model；
//      任何 *_json / payload / stack / trace 字段不得直接出现在普通视图响应里；开发者模式（view=dev）为唯一例外。

const FRIENDLY_STATUS = {
  pending: "待执行", running: "进行中", succeeded: "完成", degraded: "部分数据缺失，已标记",
  failed: "失败", skipped: "已跳过", waiting_approval: "待确认",
};
const FRIENDLY_EV_STATUS = { ok: "正常", missing: "数据缺失", stale: "数据过期", conflict: "多源冲突" };

export function presentThread(t, cfg = {}) {
  let llmCfg = {};
  try { llmCfg = JSON.parse(t.llm_cfg_json || "{}"); } catch { /* 忽略 */ }
  return {
    id: t.id, topic_id: t.topic_id ?? null, title: t.title, goal: t.goal,
    mode: t.mode, stage: t.stage, status: t.status,
    progress: cfg.progress ?? null,
    context_usage: cfg.context_usage ?? null,
    tokens_in: t.tokens_in, tokens_out: t.tokens_out, cost_usd: t.cost_usd,
    llm: {
      model: llmCfg.model || cfg.defaultModel || "",
      base_url: llmCfg.base_url || "",
      api_key_masked: maskKey(llmCfg.api_key),
    },
    created_at: t.created_at, updated_at: t.updated_at,
  };
}

function maskKey(k) {
  if (!k) return "";
  if (k.length < 12) return "***";
  return `${k.slice(0, 6)}…***${k.slice(-4)}`;
}

export function presentStep(s) {
  let args = {}, dataNeeded = [], evidenceIds = [];
  try { args = JSON.parse(s.args_json || "{}"); } catch { /* 忽略 */ }
  try { dataNeeded = JSON.parse(s.data_needed_json || "[]"); } catch { /* 忽略 */ }
  try { evidenceIds = JSON.parse(s.evidence_ids_json || "[]"); } catch { /* 忽略 */ }
  return {
    id: s.id, seq: s.seq, node_id: s.node_id || `Q${s.seq}`, parent_id: s.parent_id || null,
    title: s.title, sub_question: s.sub_question || "", hypothesis: s.hypothesis || "",
    data_needed: dataNeeded, kind: s.kind, tool_name: s.tool_name || null,
    args_display: s.kind === "tool" ? `${s.tool_name}(${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(", ")})` : "基于证据归纳",
    source: s.source, selected: !!s.selected,
    status: s.status, status_label: FRIENDLY_STATUS[s.status] || s.status,
    result_summary: s.result_summary || "", friendly_error: friendlyError(s),
    evidence_ids: evidenceIds, degrade_reason: s.degrade_reason || "",
  };
}

function friendlyError(s) {
  if (!s.error && !s.degrade_reason) return "";
  const raw = s.degrade_reason || s.error;
  if (/超时/.test(raw)) return "这步调用超时，已跳过并记录，不影响其他结论";
  if (/500|失败|error/i.test(raw)) return "这步数据源返回错误，已跳过并记录，不影响其他结论";
  if (/未获审批/.test(raw)) return "这步未获确认，已跳过";
  if (/未勾选/.test(raw)) return "你未勾选该问题";
  return String(raw).slice(0, 120);
}

export function presentEvidence(e) {
  return {
    id: e.id, ref: `E${e.id}`, topic_id: e.topic_id ?? null, thread_id: e.thread_id,
    kind: e.kind, label: e.label, type: e.type,
    metric: e.metric || "", value_text: e.value_text || "",
    unit: e.unit || "", as_of: e.as_of || "", caliber: e.caliber || "",
    source: e.source || "", source_detail: e.source_detail || "",
    raw_ref: e.raw_ref || "", raw_snippet: e.raw_snippet || "",
    status: e.status || "ok", status_label: FRIENDLY_EV_STATUS[e.status] || "正常",
    conflict_with: e.conflict_with || "", primary_source: !!e.primary_source,
    starred: !!e.starred, invalid: !!e.invalid, created_at: e.created_at,
  };
}

export function presentMessage(m) {
  let content = {};
  try { content = JSON.parse(m.content_json || "{}"); } catch { /* 忽略 */ }
  return { id: m.id, role: m.role, kind: m.kind, content, created_at: m.created_at };
}

export function presentNotice(n) {
  return {
    id: n.id, level: n.level, category: n.category,
    message: n.message, friendly_message: n.message,
    created_at: n.created_at,
  };
}

export function presentArtifact(a, diff = null) {
  let content = {}, compliance = {};
  try { content = JSON.parse(a.content_json || "{}"); } catch { /* 忽略 */ }
  try { compliance = JSON.parse(a.compliance_json || "{}"); } catch { /* 忽略 */ }
  return {
    id: a.id, version: a.version, template: a.template, is_current: !!a.is_current,
    changelog: a.changelog || "", created_at: a.created_at,
    title: content.title || "研究报告",
    narrative: content.narrative || "",
    summary: content.summary || [], facts: content.facts || [],
    inferences: content.inferences || [], unverified: content.unverified || [],
    data_quality: content.data_quality || [], risks: content.risks || [],
    compliance: {
      passed: compliance.passed !== false,
      blocked: compliance.blocked || [], rewrites: compliance.rewrites || [],
    },
    diff,
  };
}

export function presentMemory(m) {
  return { id: m.id, topic_id: m.topic_id ?? null, thread_id: m.thread_id ?? null, status: m.status, content: m.content, created_at: m.created_at };
}

export function presentCheckpoint(c) {
  return { id: c.id, upto_seq: c.upto_seq, note: c.note || "", created_at: c.created_at };
}

export function presentApproval(a) {
  return {
    id: a.id, step_id: a.step_id, action: a.action, risk_level: a.risk_level,
    reason: a.reason, cost_estimate: a.cost_estimate, data_volume: a.data_volume,
    status: a.status, created_at: a.created_at,
  };
}

export function presentTopic(topic, counts = {}) {
  return {
    id: topic.id, name: topic.name, symbol: topic.symbol || "", note: topic.note || "",
    archived: !!topic.archived, thread_count: counts.threads || 0,
    evidence_count: counts.evidence || 0, memory_count: counts.memories || 0,
    created_at: topic.created_at,
  };
}

/** 开发者模式专用：trace 等原始调试信息（唯一允许暴露 payload 的通道） */
export function presentTraceDev(t) {
  return { id: t.id, kind: t.kind, summary: t.summary, payload: t.payload_json, tokens_in: t.tokens_in, tokens_out: t.tokens_out, latency_ms: t.latency_ms, created_at: t.created_at };
}
