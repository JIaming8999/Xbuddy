// server/index.js — Web 服务：REST API + SSE + 静态前端（v4 Evidence-first）
// 普通视图默认走 presenter（view model 契约，无 *_json）；?view=dev 才暴露调试明细
import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { db, lastInsertId } from "./db.js";
import { TOOL_CONTRACTS, anomalyState, setAnomaly } from "./tools.js";
import { describeProvider, ping as fuyaoPing, mapError as fuyaoMapError } from "./fuyao.js";
import { chat, MODEL_LIGHT } from "./llm.js";
import {
  bus, running, interceptIntent, assessGoal, assessGoalSmart, scopeFromAnswers, defaultScope,
  generateIssueTree, saveTree, renumberTree, toggleTreeNode, addTreeNode, updateTreeNode, removeTreeNode,
  runThread, stopThread, restoreCheckpoint, compressNow, decideMemory,
  synthesizeArtifact, reviseArtifact, rollbackArtifact, artifactDiff, addMessage,
  PLAYBOOKS, LIMITS, llmConfigured,
} from "./agent.js";
import {
  presentThread, presentStep, presentEvidence, presentMessage, presentNotice,
  presentArtifact, presentMemory, presentCheckpoint, presentApproval, presentTopic,
  presentTraceDev,
} from "./presenter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const REPLAY_FILE = path.join(__dirname, "replays", "demo-risk-scan.json");

// ---------- LLM 配置 ----------
const MODEL_OPTIONS = ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro", "mimo-v2.5"];
function sanitizeLlmCfg(raw) {
  if (!raw || typeof raw !== "object") return { cfg: {} };
  const cfg = {};
  const base = String(raw.base_url || "").trim();
  if (base) {
    if (!/^https?:\/\//.test(base)) return { error: "接口地址必须以 http(s):// 开头" };
    cfg.base_url = base.replace(/\/+$/, "");
  }
  const key = String(raw.api_key || "").trim();
  if (key) {
    if (key.length < 8) return { error: "API Key 过短，请检查填写" };
    cfg.api_key = key;
  }
  const model = String(raw.model || "").trim();
  if (model) {
    if (!/^[a-zA-Z0-9._:-]+$/.test(model)) return { error: "模型名含非法字符" };
    cfg.model = model;
  }
  return { cfg };
}

// ---------- 数据源状态（启动自检 + 运行时查询） ----------
const isFuyao = () => process.env.DATA_PROVIDER === "fuyao";
const providerTag = () => (isFuyao() ? "真实数据（扶摇）" : "构造数据（mock）");
let dataSourceStatus = { checked: false, ok: null, mode: isFuyao() ? "fuyao" : "mock", latencyMs: null, error: null, hint: null, at: null };

async function selfCheckDataSource() {
  if (!isFuyao()) {
    dataSourceStatus = { checked: true, ok: true, mode: "mock", latencyMs: null, error: null, hint: null, at: Date.now() };
    return;
  }
  try {
    const p = await fuyaoPing();
    dataSourceStatus = { checked: true, ok: true, mode: "fuyao", latencyMs: p.latencyMs, request_id: p.request_id, error: null, hint: null, at: Date.now() };
    console.log(`[data-source] 扶摇自检通过（${p.latencyMs}ms，request_id=${p.request_id}）`);
  } catch (e) {
    const m = fuyaoMapError(e && e.code);
    dataSourceStatus = { checked: true, ok: false, mode: "fuyao", latencyMs: null, error: m.category, hint: m.hint, at: Date.now() };
    console.log(`[data-source] 扶摇自检失败：${m.category} — ${m.hint}`);
  }
}

app.get("/api/data-source-status", async (req, res) => {
  if (req.query.refresh === "1") await selfCheckDataSource();
  res.json({ provider: describeProvider(), status: dataSourceStatus, dataLabel: providerTag() });
});

// ---------- meta ----------
app.get("/api/meta", (_req, res) => {
  res.json({
    tools: TOOL_CONTRACTS,
    playbooks: PLAYBOOKS,
    limits: LIMITS,
    llmConfigured: llmConfigured(),
    anomaly: anomalyState.mode,
    dataLabel: providerTag(),
    models: { planner: process.env.LLM_MODEL_PLANNER, light: process.env.LLM_MODEL_LIGHT },
    llmDefaults: {
      base_url: process.env.LLM_BASE_URL || "https://token-plan-cn.xiaomimimo.com/v1",
      model: MODEL_OPTIONS[0],
      modelOptions: MODEL_OPTIONS,
    },
    modes: [{ id: "real", label: "真实模式（实时调用 LLM）" }, { id: "replay", label: "演示模式（轨迹重放，非实时）" }],
  });
});

app.post("/api/anomaly", (req, res) => {
  setAnomaly(req.body?.mode || "none");
  res.json({ ok: true, anomaly: anomalyState.mode });
});

app.post("/api/llm/test", async (req, res) => {
  const parsed = sanitizeLlmCfg(req.body || {});
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  const cfg = parsed.cfg;
  if (!cfg.api_key && !llmConfigured()) {
    return res.status(400).json({ ok: false, error: "缺少 API Key（请填写，或在服务端环境变量中配置）" });
  }
  try {
    const t0 = Date.now();
    const r = await chat({
      messages: [{ role: "user", content: "ping" }],
      model: cfg.model || undefined, maxTokens: 32, temperature: 0, timeoutMs: 20000,
      cfg: Object.keys(cfg).length ? cfg : null,
    });
    res.json({ ok: true, model: r.model, latencyMs: Date.now() - t0 });
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err).slice(0, 300) });
  }
});

// ---------- topics（一级对象：公司/研究主题，长期存活） ----------
app.get("/api/topics", (_req, res) => {
  const topics = db.prepare("SELECT * FROM topics WHERE archived = 0 ORDER BY id DESC").all();
  res.json(topics.map((t) => {
    const counts = {
      threads: db.prepare("SELECT COUNT(*) AS n FROM threads WHERE topic_id = ?").get(t.id).n,
      evidence: db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE topic_id = ? AND invalid = 0").get(t.id).n,
      memories: db.prepare("SELECT COUNT(*) AS n FROM memories WHERE topic_id = ? AND status = 'active'").get(t.id).n,
    };
    return presentTopic(t, counts);
  }));
});

app.post("/api/topics", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "主题名不能为空" });
  const info = db.prepare("INSERT INTO topics(name, symbol, note) VALUES (?,?,?)")
    .run(name, req.body?.symbol || null, req.body?.note || "");
  res.json({ ok: true, id: lastInsertId(info) });
});

app.post("/api/topics/:id/archive", (req, res) => {
  db.prepare("UPDATE topics SET archived = 1 WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/topics/:id", (req, res) => {
  const id = Number(req.params.id);
  const topic = db.prepare("SELECT * FROM topics WHERE id = ?").get(id);
  if (!topic) return res.status(404).json({ error: "主题不存在" });
  res.json({
    topic: presentTopic(topic),
    threads: db.prepare("SELECT * FROM threads WHERE topic_id = ? AND status != 'archived' ORDER BY id DESC").all(id).map((t) => presentThread(t)),
    evidence: db.prepare("SELECT * FROM evidence WHERE topic_id = ? AND invalid = 0 ORDER BY id DESC").all(id).map(presentEvidence),
    memories: db.prepare("SELECT * FROM memories WHERE topic_id = ? ORDER BY id DESC").all(id).map(presentMemory),
  });
});

// ---------- threads ----------
app.get("/api/threads", (req, res) => {
  const topicId = req.query.topic_id ? Number(req.query.topic_id) : null;
  const rows = topicId
    ? db.prepare("SELECT * FROM threads WHERE topic_id = ? AND status != 'archived' ORDER BY id DESC").all(topicId)
    : db.prepare("SELECT * FROM threads WHERE status != 'archived' ORDER BY id DESC").all();
  res.json(rows.map((t) => presentThread(t)));
});

app.post("/api/threads", async (req, res) => {
  const goal = String(req.body?.goal || "").trim();
  const mode = req.body?.mode === "replay" ? "replay" : "real";
  if (!goal) return res.status(400).json({ ok: false, error: "研究目标不能为空" });

  const check = interceptIntent(goal);
  if (check.blocked) {
    return res.json({ ok: false, intercepted: true, reason: check.reason, suggestion: check.suggestion });
  }
  const parsed = sanitizeLlmCfg(req.body?.llm_cfg);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
  const cfg = parsed.cfg;
  if (mode === "real" && !cfg.api_key && !llmConfigured()) {
    return res.status(400).json({ ok: false, error: "真实模式需要 API Key：请在 LLM 配置中填写，或配置服务端环境变量 LLM_API_KEY" });
  }

  // 主题：没给就落到「默认研究区」（主题是一级对象，线程必须挂主题）
  let topicId = Number(req.body?.topic_id) || null;
  if (!topicId) {
    let t = db.prepare("SELECT * FROM topics WHERE name = '默认研究区'").get();
    if (!t) {
      const info = db.prepare("INSERT INTO topics(name, note) VALUES (?,?)").run("默认研究区", "未指定主题的研究任务");
      t = { id: lastInsertId(info) };
    }
    topicId = t.id;
  }
  // §3.2：演示/测试数据统一命名前缀「演示：」，禁止脏串进入普通视图
  const title = (mode === "replay" ? "演示：" : "") + (goal.length > 24 ? goal.slice(0, 24) + "…" : goal);
  const info = db.prepare("INSERT INTO threads(topic_id, title, goal, mode, llm_cfg_json, stage) VALUES (?,?,?,?,?,?)")
    .run(topicId, title, goal, mode, JSON.stringify(cfg), "new");
  const id = lastInsertId(info);
  addMessage(id, "user", "text", { text: goal });

  // 目标充分性判断（§4.2 + 方案C）：LLM 槽位抽取（标的/时间/视角），缺失才反问、确认式文案引用目标原文；
  // 演示模式/无 LLM/抽取失败 → assessGoal 规则回退（确定性）
  const assess = await assessGoalSmart({ id, mode, llm_cfg_json: JSON.stringify(cfg) }, goal);
  db.prepare("INSERT INTO traces(thread_id, kind, summary, payload_json) VALUES (?,?,?,?)")
    .run(id, "llm_call", `目标槽位抽取（${assess.source === "llm" ? "LLM" : "规则回退"}）：${assess.sufficient ? "要素齐全" : `缺 ${assess.missing.join("/")}`}`,
      JSON.stringify({ source: assess.source, slots: assess.slots || null, fallback_reason: assess.fallback_reason || null }));
  if (assess.sufficient) {
    db.prepare("UPDATE threads SET stage = 'outline' WHERE id = ?").run(id);
  } else {
    db.prepare("UPDATE threads SET stage = 'clarifying' WHERE id = ?").run(id);
    addMessage(id, "assistant", "clarify", {
      title: "先确认一下研究范围",
      questions: assess.questions,
      allow_skip: true,
      skip_label: "跳过，按默认来（近 1 年 · 经营+风险）",
    });
  }
  res.json({ ok: true, id, need_clarify: !assess.sufficient, questions: assess.questions });
});

function threadOr404(req, res) {
  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(Number(req.params.id));
  if (!thread) { res.status(404).json({ error: "线程不存在" }); return null; }
  return thread;
}

// 详情（view=normal 默认；view=dev 附调试明细）
app.get("/api/threads/:id", (req, res) => {
  const thread = threadOr404(req, res);
  if (!thread) return;
  const id = thread.id;
  const dev = req.query.view === "dev";
  const plan = db.prepare("SELECT * FROM plans WHERE thread_id = ? ORDER BY version DESC LIMIT 1").get(id);
  const steps = plan ? db.prepare("SELECT * FROM steps WHERE plan_id = ? ORDER BY seq").all(plan.id) : [];
  const presentedSteps = steps.map(presentStep);
  const doneCount = presentedSteps.filter((s) => ["succeeded", "degraded", "skipped"].includes(s.status)).length;
  const contextUsage = Math.min(100, Math.round((thread.context_summary || "").length / LIMITS.compressThresholdChars * 100));

  const artifacts = db.prepare("SELECT * FROM artifacts WHERE thread_id = ? ORDER BY version DESC").all(id);
  const presentedArtifacts = artifacts.map((a, i) => {
    const prev = artifacts[i + 1] || null;
    const diff = prev ? artifactDiff(JSON.parse(prev.content_json), JSON.parse(a.content_json)) : null;
    return presentArtifact(a, diff);
  });

  const out = {
    thread: presentThread(thread, {
      progress: plan ? `${doneCount}/${presentedSteps.length}` : null,
      context_usage: contextUsage,
      defaultModel: MODEL_OPTIONS[0],
    }),
    messages: db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY id").all(id).map(presentMessage),
    plan: plan ? { id: plan.id, version: plan.version, status: plan.status, playbook: plan.playbook, scope: JSON.parse(plan.scope_json || "{}") } : null,
    steps: presentedSteps,
    evidence: db.prepare("SELECT * FROM evidence WHERE thread_id = ? ORDER BY id").all(id).map(presentEvidence),
    topic_evidence: db.prepare("SELECT * FROM evidence WHERE topic_id = ? AND invalid = 0 ORDER BY id DESC").all(thread.topic_id ?? -1).map(presentEvidence),
    notices: db.prepare("SELECT * FROM notices WHERE thread_id = ? ORDER BY id DESC LIMIT 50").all(id).map(presentNotice),
    artifacts: presentedArtifacts,
    current_artifact: presentedArtifacts.find((a) => a.is_current) || null,
    memories: db.prepare("SELECT * FROM memories WHERE topic_id = ? OR thread_id = ? ORDER BY id DESC").all(thread.topic_id ?? -1, id).map(presentMemory),
    approvals: db.prepare("SELECT * FROM approvals WHERE thread_id = ? ORDER BY id DESC").all(id).map(presentApproval),
    running: running.has(id),
  };
  if (dev) {
    out.dev = {
      checkpoints: db.prepare("SELECT id, upto_seq, note, created_at FROM checkpoints WHERE thread_id = ? ORDER BY id DESC").all(id).map(presentCheckpoint),
      traces: db.prepare("SELECT * FROM traces WHERE thread_id = ? ORDER BY id DESC LIMIT 100").all(id).map(presentTraceDev),
    };
  }
  res.json(out);
});

// ---------- 澄清回答 → 生成问题树（自动，无需按钮） ----------
app.post("/api/threads/:id/clarify", async (req, res) => {
  const thread = threadOr404(req, res);
  if (!thread) return;
  const answers = req.body?.answers || {};
  if (Object.keys(answers).length) {
    addMessage(thread.id, "user", "text", { text: Object.entries(answers).map(([k, v]) => `${k}: ${v}`).join("；") });
  }
  const scope = Object.keys(answers).length ? scopeFromAnswers(answers) : defaultScope();
  db.prepare("UPDATE threads SET stage = 'outline' WHERE id = ?").run(thread.id);
  return generateAndSaveTree(req, res, thread, scope);
});

// ---------- 生成/重新生成问题树 ----------
app.post("/api/threads/:id/plan", async (req, res) => {
  const thread = threadOr404(req, res);
  if (!thread) return;
  return generateAndSaveTree(req, res, thread, scopeFromAnswers(req.body?.answers || {}));
});

// 真实模式提纲生成的在途登记（连点幂等：同一时刻只允许一次生成）
const planGenerating = new Set();

async function generateAndSaveTree(req, res, thread, scope) {
  // 演示模式：预置轨迹读取是本地快速操作，同步返回（确定性 + 自动化测试依赖响应体）
  if (thread.mode === "replay") {
    try {
      const traj = JSON.parse(fs.readFileSync(REPLAY_FILE, "utf8"));
      const v = { ok: true, errors: [], warnings: [] };
      const maxVer = db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM plans WHERE thread_id = ?").get(thread.id).v;
      const info = db.prepare("INSERT INTO plans(thread_id, version, status, playbook, scope_json) VALUES (?,?,?,?,?)")
        .run(thread.id, maxVer + 1, "validated", traj.plan.playbook, JSON.stringify(traj.plan.scope || {}));
      saveTree(thread.id, lastInsertId(info), { nodes: traj.plan.steps });
      addMessage(thread.id, "assistant", "outline", {
        title: "研究提纲（演示模式：来自预置轨迹，未实时调用 LLM）",
        plan_id: lastInsertId(info), playbook: traj.plan.playbook, scope: traj.plan.scope || {},
      });
      bus.emit(`thread:${thread.id}`, { type: "plan_ready", validation: v });
      return res.json({ ok: true, plan_id: lastInsertId(info), validation: v, replay: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // 真实模式：立即受理（202），后台生成 + SSE 推送进度/结果（避免 3 轮回炉长任务顶到网关 60s → HTTP 504）
  if (planGenerating.has(thread.id)) {
    return res.status(409).json({ ok: false, error: "提纲生成已在进行中，请等待当前生成完成（活动条可见进度）" });
  }
  res.status(202).json({ ok: true, accepted: true, pending: "plan" });
  runPlanGeneration(thread, scope);
}

async function runPlanGeneration(thread, scope) {
  planGenerating.add(thread.id);
  try {
    bus.emit(`thread:${thread.id}`, { type: "plan_progress", phase: "generating", attempt: 0 });
    const gen = await generateIssueTree(thread, scope, (p) => {
      bus.emit(`thread:${thread.id}`, { type: "plan_progress", phase: p.phase, attempt: p.attempt });
    });
    if (!gen.tree || !gen.validation?.ok) {
      const errs = (gen.validation?.errors || ["模型未返回合法问题树"]).join("；");
      addMessage(thread.id, "assistant", "text", {
        text: `提纲生成失败（已尝试 ${gen.attempts || 3} 次，未静默）：${errs}。可点「重新生成提纲」重试，或调整研究目标后重试。`,
      });
      bus.emit(`thread:${thread.id}`, { type: "plan_failed", error: errs });
      return;
    }
    db.prepare("INSERT INTO traces(thread_id, kind, summary, payload_json) VALUES (?,?,?,?)")
      .run(thread.id, "plan_validate", `问题树校验：通过（${gen.validation.warnings.length} 预警）`, JSON.stringify(gen.validation));

    const maxVer = db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM plans WHERE thread_id = ?").get(thread.id).v;
    const info = db.prepare("INSERT INTO plans(thread_id, version, status, playbook, scope_json) VALUES (?,?,?,?,?)")
      .run(thread.id, maxVer + 1, "validated", gen.tree.playbook, JSON.stringify(gen.tree.scope || scope));
    const planId = lastInsertId(info);
    saveTree(thread.id, planId, gen.tree);
    addMessage(thread.id, "assistant", "outline", {
      title: "研究提纲（问题树）",
      plan_id: planId, playbook: gen.tree.playbook, scope: gen.tree.scope || scope,
      note: "勾选/编辑要研究的问题，或直接说「去掉估值部分」，然后点「开始研究」",
    });
    bus.emit(`thread:${thread.id}`, { type: "plan_ready", validation: gen.validation, plan_id: planId, attempts: gen.attempts });
  } catch (err) {
    addMessage(thread.id, "assistant", "text", {
      text: `提纲生成失败（已显式记录，未静默）：${err.message}。可点「重新生成提纲」重试。`,
    });
    bus.emit(`thread:${thread.id}`, { type: "plan_failed", error: err.message });
  } finally {
    planGenerating.delete(thread.id);
  }
}

// ---------- 问题树编辑（human-in-the-loop） ----------
app.post("/api/threads/:id/nodes", (req, res) => {
  try {
    const node = addTreeNode(Number(req.params.id), req.body || {});
    res.json({ ok: true, node: presentStep(node) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.patch("/api/nodes/:id", (req, res) => {
  const { title, sub_question, hypothesis, args, tool_name, selected, move } = req.body || {};
  // 提纲改序（human-in-the-loop）：上移/下移交换执行顺序
  if (move === "up" || move === "down") {
    const node = db.prepare("SELECT * FROM steps WHERE id = ?").get(Number(req.params.id));
    if (!node) return res.status(404).json({ ok: false, error: "节点不存在" });
    const sibs = db.prepare("SELECT id, seq FROM steps WHERE plan_id = ? ORDER BY seq").all(node.plan_id);
    const i = sibs.findIndex((s) => s.id === node.id);
    const j = move === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < sibs.length) {
      db.prepare("UPDATE steps SET seq = -1 WHERE id = ?").run(node.id);
      db.prepare("UPDATE steps SET seq = ? WHERE id = ?").run(node.seq, sibs[j].id);
      db.prepare("UPDATE steps SET seq = ? WHERE id = ?").run(sibs[j].seq, node.id);
    }
    renumberTree(node.plan_id); // 改序后编号规范化：Q1..Qn 按新执行顺序连续
    return res.json({ ok: true, node: presentStep(db.prepare("SELECT * FROM steps WHERE id = ?").get(node.id)) });
  }
  if (selected !== undefined && title === undefined && args === undefined && hypothesis === undefined && tool_name === undefined) {
    return res.json({ ok: true, node: presentStep(toggleTreeNode(Number(req.params.id), selected)) });
  }
  try {
    const node = updateTreeNode(Number(req.params.id), { title, sub_question, hypothesis, args, tool_name });
    if (selected !== undefined) toggleTreeNode(node.id, selected);
    res.json({ ok: true, node: presentStep(db.prepare("SELECT * FROM steps WHERE id = ?").get(Number(req.params.id))) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/nodes/:id", (req, res) => {
  removeTreeNode(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- 会话消息（意图入口：修订报告 / 改提纲 / 问答回复） ----------
// 在途消息处理登记（连点幂等：同一时刻只允许一条消息在处理）
const msgProcessing = new Set();

app.post("/api/threads/:id/messages", async (req, res) => {
  const thread = threadOr404(req, res);
  if (!thread) return;
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ ok: false, error: "消息不能为空" });

  const check = interceptIntent(text);
  if (check.blocked) {
    addMessage(thread.id, "user", "text", { text });
    addMessage(thread.id, "assistant", "intercept", { reason: check.reason, suggestion: check.suggestion });
    return res.json({ ok: true, intercepted: true });
  }
  if (msgProcessing.has(thread.id)) {
    return res.status(409).json({ ok: false, error: "上一条消息还在处理中，请等回复出来再发（按钮已置灰，防止重复触发）" });
  }
  // 输入区模型选择器：把所选模型落到线程级 LLM 配置（后续 LLM 调用均透传）
  const model = String(req.body?.model || "").trim();
  if (model) {
    const parsedModel = sanitizeLlmCfg({ model });
    if (parsedModel.error) return res.status(400).json({ ok: false, error: parsedModel.error });
    const cfg = JSON.parse(thread.llm_cfg_json || "{}");
    cfg.model = parsedModel.cfg.model;
    db.prepare("UPDATE threads SET llm_cfg_json = ? WHERE id = ?").run(JSON.stringify(cfg), thread.id);
    thread.llm_cfg_json = JSON.stringify(cfg);
  }
  addMessage(thread.id, "user", "text", { text });

  // 立即受理（202）：修订/问答回复含 LLM 长调用，后台执行 + SSE 推送，避免 HTTP 504
  res.status(202).json({ ok: true, accepted: true, pending: "message" });
  processMessage(thread, text);
});

async function processMessage(thread, text) {
  msgProcessing.add(thread.id);
  try {
    const art = db.prepare("SELECT * FROM artifacts WHERE thread_id = ? AND is_current = 1").get(thread.id);
    const plan = db.prepare("SELECT * FROM plans WHERE thread_id = ? ORDER BY version DESC LIMIT 1").get(thread.id);
    const steps = plan ? db.prepare("SELECT * FROM steps WHERE plan_id = ? ORDER BY seq").all(plan.id) : [];
    const hasRun = steps.some((s) => s.status !== "pending");

    const reviseIntent = /(修改|改一下|改这|改成|调整|重写|补充|加上|删掉|删除|压缩|压到|置信度|反驳条件|版本)/.test(text);
    const questionIntent = /(吗|？|\?|为什么|什么是|怎么理解|解释)/.test(text);

    if (art && (reviseIntent || !questionIntent)) {
      bus.emit(`thread:${thread.id}`, { type: "message_progress", action: "revise" });
      const result = await reviseArtifact(thread.id, text);
      addMessage(thread.id, "assistant", "text", {
        text: `已更新至 v${result.version}：${result.changelog}。可在右侧「产物版本」切换历史版本。`,
        artifact_version: result.version,
      });
      bus.emit(`thread:${thread.id}`, { type: "message_ready", action: "revised", version: result.version, diff: result.diff });
      return;
    }

    if (plan && !hasRun && /(去掉|删除|移除|不要|加|新增|补一个|补一条|添)/.test(text)) {
      bus.emit(`thread:${thread.id}`, { type: "message_progress", action: "tree_edit" });
      const handled = handleTreeEdit(thread, text);
      if (handled) {
        bus.emit(`thread:${thread.id}`, { type: "message_ready", action: "tree_edited", ...handled });
        return;
      }
    }

    // 一般问答：基于目标与证据简短回复
    bus.emit(`thread:${thread.id}`, { type: "message_progress", action: "answer" });
    const answer = await answerWithLLM(thread, text);
    addMessage(thread.id, "assistant", "text", { text: answer });
    bus.emit(`thread:${thread.id}`, { type: "message_ready", action: "answered" });
  } catch (err) {
    // 失败不静默：对话流显式留痕 + 可重试提示
    addMessage(thread.id, "assistant", "text", { text: `处理失败：${err.message}。可以换个说法重试，或到开发者模式查看 trace。` });
    bus.emit(`thread:${thread.id}`, { type: "message_ready", action: "failed", error: err.message });
  } finally {
    msgProcessing.delete(thread.id);
  }
}

function handleTreeEdit(thread, text) {
  const steps = db.prepare(`SELECT s.* FROM steps s JOIN plans p ON s.plan_id = p.id WHERE p.thread_id = ? AND p.version = (SELECT MAX(version) FROM plans WHERE thread_id = ?)`)
    .all(thread.id, thread.id);
  if (/(去掉|删除|移除|不要)/.test(text)) {
    // 指代解析：Q3 / 问题 3 / 第三个（编号已规范化为连续 Q1..Qn，「问题 N」= Q N）
    const qMatch = text.match(/Q\s*(\d+)/i) || text.match(/问题\s*(\d+)/) || text.match(/第\s*([0-9一二三四五六七八九十]+)\s*个?/);
    let target = null;
    if (qMatch) {
      const numMap = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
      const raw = qMatch[1];
      const n = /^\d+$/.test(raw) ? Number(raw) : numMap[raw];
      target = steps.find((s) => (s.node_id || "").toUpperCase() === `Q${n}`) || steps.find((s) => s.seq === n);
    }
    if (!target) target = steps.find((s) => text.includes((s.title || "").slice(0, 4)) || text.includes((s.sub_question || "").slice(0, 4)));
    if (target) {
      removeTreeNode(target.id);
      addMessage(thread.id, "assistant", "text", { text: `已从提纲移除「${target.title}」。` });
      bus.emit(`thread:${thread.id}`, { type: "plan_ready" });
      return { removed: target.id };
    }
    addMessage(thread.id, "assistant", "text", { text: "没找到要移除的问题，请指明节点编号（如 Q2）或关键词。" });
    return { removed: null };
  }
  if (/(加|新增|补一个|补一条|添)/.test(text)) {
    const title = text.replace(/^.*?(加|新增|补一个|补一条|添)(一个|一条|一步)?/, "").trim() || text;
    const node = addTreeNode(thread.id, { title, sub_question: title, kind: "tool", tool_name: "search_news", args: { symbol: "600519.SH" } });
    addMessage(thread.id, "assistant", "text", { text: `已添加问题「${node.title}」（你添加）。可编辑其工具与入参，或直接开始研究。` });
    bus.emit(`thread:${thread.id}`, { type: "plan_ready" });
    return { added: node.id };
  }
  return null;
}

async function answerWithLLM(thread, text) {
  const evidence = db.prepare("SELECT id, metric, value_text, as_of, source FROM evidence WHERE thread_id = ? AND invalid = 0 ORDER BY id DESC LIMIT 12").all(thread.id);
  const evBlock = evidence.map((e) => `[E${e.id}] ${e.metric} = ${e.value_text} @${e.as_of} 来源:${e.source}`).join("\n") || "（暂无证据）";
  const res = await chat({
    messages: [
      { role: "system", content: "你是投研助手。仅基于给定证据与研究目标简短回答（5 句以内），需要时用 [E?] 标注引用。禁止涨跌预测、买卖建议、收益承诺；证据不支持的判断显式标注『未验证推断』。" },
      { role: "user", content: `研究目标：${thread.goal}\n\n证据：\n${evBlock}\n\n用户问题：${text}` },
    ],
    model: MODEL_LIGHT, maxTokens: 600, temperature: 0.3,
    cfg: JSON.parse(thread.llm_cfg_json || "{}"),
  });
  return res.content || "（暂无法回答）";
}

// ---------- run / stop / SSE ----------
app.post("/api/threads/:id/run", (req, res) => {
  const thread = threadOr404(req, res);
  if (!thread) return;
  res.json({ ok: true, started: true });
  const replay = thread.mode === "replay" ? JSON.parse(fs.readFileSync(REPLAY_FILE, "utf8")) : null;
  runThread(thread.id, { replay });
});

app.post("/api/threads/:id/stop", (req, res) => {
  stopThread(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/threads/:id/events", (req, res) => {
  const id = Number(req.params.id);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const onEvent = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  bus.on(`thread:${id}`, onEvent);
  req.on("close", () => bus.off(`thread:${id}`, onEvent));
});

// ---------- 报告修订 / 回滚 / 重新合成 ----------
app.post("/api/threads/:id/artifact/revise", async (req, res) => {
  try {
    const instruction = String(req.body?.instruction || "").trim();
    if (!instruction) return res.status(400).json({ ok: false, error: "修订指令不能为空" });
    const result = await reviseArtifact(Number(req.params.id), instruction);
    res.json({ ok: true, artifact: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/threads/:id/artifact/rollback", (req, res) => {
  try {
    const target = rollbackArtifact(Number(req.params.id), Number(req.body?.version));
    res.json({ ok: true, version: target.version });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/threads/:id/artifact", async (req, res) => {
  try {
    res.json({ ok: true, artifact: await synthesizeArtifact(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- 审批 ----------
app.post("/api/threads/:id/approvals/:aid", (req, res) => {
  const decision = req.body?.decision === "approved" ? "approved" : "rejected";
  db.prepare("UPDATE approvals SET status = ? WHERE id = ? AND thread_id = ?").run(decision, Number(req.params.aid), Number(req.params.id));
  res.json({ ok: true, status: decision });
});

// ---------- 证据（人工补充与冲突处理） ----------
app.post("/api/threads/:id/evidence", (req, res) => {
  const thread = threadOr404(req, res);
  if (!thread) return;
  const { source, metric, value_text, as_of, unit, caliber, content, raw_snippet } = req.body || {};
  const info = db.prepare(
    `INSERT INTO evidence(topic_id, thread_id, kind, label, type, source, source_detail, as_of, unit, caliber, metric, value_text, raw_ref, raw_snippet, status, content_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(thread.topic_id ?? null, thread.id, "user", "user", "user_upload", source || "用户补充", "用户补充材料",
    as_of || null, unit || "", caliber || "", metric || "用户补充证据", value_text || "",
    "user://upload", (raw_snippet || value_text || "").slice(0, 600), "ok", JSON.stringify(content || {}));
  const ev = { id: lastInsertId(info) };
  bus.emit(`thread:${thread.id}`, { type: "evidence", evidence_id: ev.id });
  res.json({ ok: true, ...ev });
});

app.patch("/api/evidence/:id", (req, res) => {
  const { starred, invalid } = req.body || {};
  db.prepare("UPDATE evidence SET starred = COALESCE(?, starred), invalid = COALESCE(?, invalid) WHERE id = ?")
    .run(starred === undefined ? null : starred ? 1 : 0, invalid === undefined ? null : invalid ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});

// 冲突指定主源（§6.1 冲突状态机）
app.post("/api/evidence/:id/primary", (req, res) => {
  const ev = db.prepare("SELECT * FROM evidence WHERE id = ?").get(Number(req.params.id));
  if (!ev) return res.status(404).json({ error: "证据不存在" });
  db.prepare("UPDATE evidence SET primary_source = 0 WHERE thread_id = ?").run(ev.thread_id);
  db.prepare("UPDATE evidence SET primary_source = 1 WHERE id = ?").run(ev.id);
  const side = req.body?.side === "source_b" ? "源B" : "源A";
  db.prepare("INSERT INTO notices(thread_id, level, category, message, detail_json) VALUES (?,?,?,?,?)")
    .run(ev.thread_id, "info", "system", `数据冲突已处理：用户指定${side}为主源，报告按主源陈列并保留双源对照`, "{}");
  bus.emit(`thread:${ev.thread_id}`, { type: "evidence", evidence_id: ev.id });
  res.json({ ok: true });
});

// ---------- 检查点 / 压缩 / 记忆 ----------
app.post("/api/threads/:id/checkpoints/:cid/restore", (req, res) => {
  try {
    restoreCheckpoint(Number(req.params.id), Number(req.params.cid));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/threads/:id/compress", async (req, res) => {
  try {
    res.json({ ok: true, result: await compressNow(Number(req.params.id)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/memories", (req, res) => {
  const topicId = req.query.topic_id ? Number(req.query.topic_id) : null;
  const rows = topicId
    ? db.prepare("SELECT * FROM memories WHERE topic_id = ? ORDER BY id DESC LIMIT 50").all(topicId)
    : db.prepare("SELECT * FROM memories ORDER BY id DESC LIMIT 50").all();
  res.json(rows.map(presentMemory));
});

app.post("/api/memories/:id", (req, res) => {
  res.json({ ok: true, memory: presentMemory(decideMemory(Number(req.params.id), req.body?.accept !== false)) });
});

// §3.2：历史脏线程（测试脏串）在新版本首次启动时归档，不物理删除
function archiveJunkThreads() {
  const JUNK = /DSFSensf|自动化测试|演示链路回归|冒烟|e2e|loadtest|test-thread/i;
  const rows = db.prepare("SELECT id, title FROM threads WHERE status != 'archived'").all();
  for (const r of rows) {
    if (JUNK.test(r.title || "")) {
      db.prepare("UPDATE threads SET status = 'archived' WHERE id = ?").run(r.id);
    }
  }
}
archiveJunkThreads();

const PORT = Number(process.env.PORT || 3210);
app.listen(PORT, () => {
  console.log(`X-Buddy v4 running at http://localhost:${PORT}`);
  console.log(`LLM configured: ${llmConfigured()} | Data: ${providerTag()}`);
  selfCheckDataSource(); // 启动自检（异步，不阻塞监听）
});
