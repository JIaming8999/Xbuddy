/* 投资 X Buddy 前端 —— v4 Evidence-first 对话式投研工作台
 * 视图模型契约：只消费 presenter 产出的字段；任何 *_json / payload / stack / trace 不得在此渲染（开发者模式除外）。 */
"use strict";

// ============ 工具 ============
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ============ 状态 ============
const S = {
  meta: null,
  topics: [],
  topicId: null,
  threads: [],
  threadId: null,
  detail: null,          // GET /threads/:id 视图模型
  dev: false,
  activeTab: "evidence",
  evFilter: "all",
  evQuery: "",
  hlEv: null,            // 高亮的证据 id
  viewVersion: null,     // Canvas 查看的历史版本
  selText: "",           // Canvas 选中文字
  es: null,              // EventSource
  refreshTimer: null,
  busy: false,
  pending: null,         // 在途动作单一状态源：{ label, kind, until }（until="plan"/"message" 时由 SSE 事件清除）
  nodeEdit: { mode: "add", id: null },
};

// ============ 忙碌态三件套（#14）：点击即置灰+「◌ 正在进行…」、刷新不覆盖、失败显式可重试 ============
function isBusy() {
  return !!S.pending || S.busy;
}

/** 统一异步动作包装：单一在途（连点幂等）+ 状态条持续显示 + 失败显式反馈（含重试提示）
 *  opts.until: "plan" | "message" —— 长任务 202 受理后由 SSE 对应事件清除忙碌态 */
async function runBusy(kind, label, fn, opts = {}) {
  if (S.pending) return; // 连点幂等：同一时刻只允许一个在途动作
  S.busy = true;
  S.pending = { label, kind, until: opts.until || null };
  renderActivity();
  renderChat();
  try {
    await fn();
  } catch (err) {
    S.pending = null;
    S.busy = false;
    alert(`${String(label).replace(/^正在/, "")}失败：${err.message}\n可以点原按钮重试；如反复失败，开开发者模式查看 trace。`);
    renderAll();
    return;
  }
  S.busy = false;
  if (!S.pending) { renderAll(); return; }
  if (!S.pending.until) {
    S.pending = null;
    renderAll();
  } else {
    renderAll(); // 长任务已受理：保持置灰与「◌」，等 SSE 事件清除
  }
}

function clearPending() {
  S.pending = null;
  S.busy = false;
  const send = $("#btnSend");
  if (send) { send.disabled = false; send.textContent = "发送"; }
}

// ============ 启动 ============
async function boot() {
  try {
    S.meta = await api("/api/meta");
  } catch (e) {
    alert("无法连接服务端：" + e.message);
    return;
  }
  $("#dataBadge").textContent = `数据源：${S.meta.dataLabel}`;
  if (!S.meta.llmConfigured) $("#dataBadge").title = "服务端未配置 LLM_API_KEY，请在新建研究时填写 LLM 配置";
  // 数据源自检状态（扶摇真实源连通性）——失败不阻断启动，仅补充徽章状态
  try {
    const ds = await api("/api/data-source-status");
    const st = ds.status || {};
    const base = `数据源：${S.meta.dataLabel}`;
    if (st.mode === "fuyao") {
      const ok = st.ok === true;
      $("#dataBadge").textContent = `${base} ${ok ? "· 已连通" : "· 未连通"}`;
      $("#dataBadge").title = ok
        ? `扶摇自检通过（${st.latencyMs}ms）`
        : `扶摇自检失败：${st.error || "未知"} — ${st.hint || ""}`;
    } else {
      $("#dataBadge").title = "构造数据（mock），非真实行情";
    }
  } catch { /* 状态查询失败不影响主流程 */ }

  // 模型选择器（输入区 + LLM 配置）
  const models = S.meta.llmDefaults?.modelOptions || ["mimo-v2.6-pro"];
  $("#modelSelect").innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  $("#cfgModel").innerHTML = $("#modelSelect").innerHTML;
  // 工具选项（节点编辑）
  const tools = S.meta.tools || [];
  $("#nodeTool").innerHTML = `<option value="">（归纳型，不调用工具）</option>` +
    tools.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}（风险:${esc(t.risk)}）</option>`).join("");
  $("#anomalySelect").value = S.meta.anomaly || "none";

  await loadTopics(true);
  wireEvents();
}

async function loadTopics(autoSelect) {
  S.topics = await api("/api/topics");
  const sel = $("#topicSelect");
  sel.innerHTML = S.topics.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("") ||
    `<option value="">（暂无主题）</option>`;
  if (autoSelect || !S.topicId) S.topicId = S.topics[0]?.id ?? null;
  sel.value = S.topicId ?? "";
  renderTopics();
  await loadThreads(true);
}

async function loadThreads(autoSelect) {
  if (!S.topicId) { S.threads = []; S.threadId = null; S.detail = null; renderAll(); return; }
  const topicDetail = await api(`/api/topics/${S.topicId}`);
  S.threads = topicDetail.threads || [];
  S.topic = topicDetail.topic;
  if (autoSelect || !S.threads.some((t) => t.id === S.threadId)) {
    S.threadId = S.threads[0]?.id ?? null;
    S.viewVersion = null;
    await loadThread();
  }
  renderAll();
}

async function loadThread() {
  if (!S.threadId) { S.detail = null; return; }
  const q = S.dev ? "?view=dev" : "";
  S.detail = await api(`/api/threads/${S.threadId}${q}`);
  // 输入区模型选择器跟随当前线程配置
  const m = S.detail?.thread?.llm?.model;
  if (m && [...$("#modelSelect").options].some((o) => o.value === m)) $("#modelSelect").value = m;
  connectSSE();
  renderAll();
}

function scheduleRefresh() {
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(async () => {
    try { await loadThread(); } catch { /* 线程可能已切换 */ }
  }, 350);
}

function connectSSE() {
  if (S.es) { S.es.close(); S.es = null; }
  if (!S.threadId) return;
  const es = new EventSource(`/api/threads/${S.threadId}/events`);
  es.onmessage = (e) => {
    let ev = {};
    try { ev = JSON.parse(e.data); } catch { return; }
    // 忙碌态清除（长任务 202 受理后由对应事件收口；失败也收口并保留错误消息可见）
    const p = S.pending;
    if (p?.until === "plan" && (ev.type === "plan_ready" || ev.type === "plan_failed")) {
      clearPending();
    }
    if (p?.until === "message" && (ev.type === "message_ready" ||
        (ev.type === "message" && ev.message?.role === "assistant"))) {
      clearPending();
    }
    if (ev.type === "plan_progress" && p?.until === "plan") {
      // 刷新不覆盖：进行中状态由 S.pending 单一状态源渲染，这里只更新细节文案
      p.label = ev.attempt > 1 ? `正在生成研究提纲（第 ${ev.attempt} 次校验回炉）` : "正在生成研究提纲";
      renderActivity();
      return;
    }
    if (ev.type === "message_progress" && p?.until === "message") {
      p.label = ev.action === "revise" ? "正在修订报告"
        : ev.action === "tree_edit" ? "正在修改提纲"
        : "正在思考回复";
      renderActivity();
      return;
    }
    if (ev.type === "run_started" || ev.type === "run_finished" || ev.type === "run_error" ||
        ev.type === "step_updated" || ev.type === "evidence" || ev.type === "artifact" ||
        ev.type === "message" || ev.type === "plan_ready" || ev.type === "notice" ||
        ev.type === "memories_proposed" || ev.type === "compress" || ev.type === "restored") {
      scheduleRefresh();
    }
  };
  S.es = es;
}

// ============ 渲染 ============
function renderAll() {
  renderTopbar();
  renderTopics();
  renderThreads();
  renderActivity();
  renderChat();
  renderCanvas();
  renderRight();
  renderDev();
}

function renderTopbar() {
  const t = S.detail?.thread;
  const badge = $("#modeBadge");
  if (t?.mode === "replay") {
    badge.textContent = "演示模式 · 轨迹重放（非实时调用）";
    badge.className = "badge badge-blue";
  } else {
    badge.textContent = "真实模式 · 实时调用 LLM";
    badge.className = "badge badge-blue";
  }
}

function renderTopics() {
  $("#topicList").innerHTML = S.topics.map((t) => `
    <li data-act="pick-topic" data-id="${t.id}" class="${t.id === S.topicId ? "active" : ""}" title="${esc(t.note || "")}">
      ${esc(t.name)}
      <span class="t-meta" style="float:right">${t.evidence_count ?? 0} 证据</span>
    </li>`).join("") || `<li class="hint">暂无主题，点「＋ 新建主题」</li>`;
  const tp = S.topic;
  $("#leftFoot").textContent = tp ? `证据 ${tp.evidence_count ?? 0} 条 · 记忆 ${tp.memory_count ?? 0} 条 · 线程 ${tp.thread_count ?? 0} 个` : "";
}

function renderThreads() {
  $("#threadList").innerHTML = S.threads.map((t) => `
    <li data-act="pick-thread" data-id="${t.id}" class="${t.id === S.threadId ? "active" : ""}">
      <span class="t-title">${esc(t.title)}</span>
      <span class="t-meta">${esc(stageLabel(t.stage))} · ${fmtTime(t.updated_at || t.created_at)}${t.mode === "replay" ? " · 演示" : ""}</span>
    </li>`).join("") || `<li class="hint">暂无线程，点「＋ 新研究」</li>`;
}

function stageLabel(stage) {
  return { new: "待规划", clarifying: "澄清中", outline: "提纲就绪", running: "研究中", report: "报告就绪", done: "已完成" }[stage] || "待规划";
}

function renderActivity() {
  const d = S.detail;
  const bar = $("#activityBar");
  // 忙碌态优先（#14）：在途动作期间状态条持续显示「◌」，任何刷新不得覆盖
  if (S.pending) {
    $("#actMain").textContent = `◌ ${S.pending.label}…`;
    if (d) {
      $("#actProgress").textContent = d.thread.progress ? `进度 ${d.thread.progress}` : "";
      const pct = d.thread.context_usage ?? 0;
      $("#ctxFill").style.width = `${pct}%`;
      $("#ctxPct").textContent = `${pct}%`;
      const warnN = (d.notices || []).filter((n) => n.level !== "info").length;
      $("#actWarn").textContent = `⚠ ${warnN} 条异常`;
    }
    return;
  }
  if (!d) {
    $("#actMain").textContent = "待命 · 输入研究目标开始";
    $("#actProgress").textContent = "";
    $("#ctxFill").style.width = "0%";
    $("#ctxPct").textContent = "0%";
    $("#actWarn").textContent = "⚠ 0 条异常";
    return;
  }
  const steps = d.steps || [];
  const running = steps.find((s) => s.status === "running");
  const waiting = steps.find((s) => s.status === "waiting_approval");
  let main;
  if (d.running) main = waiting ? `⏸ 等待你确认：${waiting.title}` : `▶ ${running ? `正在取「${running.title}」…` : "研究进行中…"}`;
  else if (steps.length && steps.every((s) => ["succeeded", "degraded", "skipped"].includes(s.status))) main = "✓ 研究完成，报告已生成";
  else if (steps.length) main = `提纲就绪 · ${steps.length} 个问题，点「开始研究」`;
  else if (d.thread.stage === "clarifying") main = "等待你回答澄清问题";
  else main = "待命 · 输入研究目标开始";
  $("#actMain").textContent = main;
  $("#actProgress").textContent = d.thread.progress ? `进度 ${d.thread.progress}` : "";
  const pct = d.thread.context_usage ?? 0;
  $("#ctxFill").style.width = `${pct}%`;
  $("#ctxPct").textContent = `${pct}%`;
  const warnN = (d.notices || []).filter((n) => n.level !== "info").length;
  $("#actWarn").textContent = `⚠ ${warnN} 条异常`;
}

// ---------- 对话流（5 类消息） ----------
function renderChat() {
  const box = $("#chatStream");
  const d = S.detail;
  if (!d) {
    box.innerHTML = `<div class="empty">
      <div class="title">开始一项研究</div>
      <div>左上「＋ 新研究」输入研究目标，系统会先澄清范围（必要时），再自动生成问题树提纲。<br>
      证据卡会逐张落入右栏，报告句句可溯源。</div>
    </div>`;
    return;
  }
  const html = (d.messages || []).map((m) => renderMessage(m, d)).join("");
  box.innerHTML = html || `<div class="empty"><div class="title">输入研究目标开始</div></div>`;
  box.scrollTop = box.scrollHeight;
}

function renderMessage(m, d) {
  const c = m.content || {};
  const time = `<div class="time">${fmtTime(m.created_at)}</div>`;
  if (m.kind === "clarify") {
    return `<div class="card clarify">
      <h4>🔍 ${esc(c.title || "先确认一下研究范围")}</h4>
      <div class="hint">目标要素不全时先反问，最多 2 个问题；也可跳过按默认进行。</div>
      ${(c.questions || []).map((q, qi) => `
        <div class="clarify-q" data-qid="${esc(q.id)}">
          <div class="q-title">${qi + 1}. ${esc(q.question)}</div>
          <div class="opt-row">${(q.options || []).map((o) => `<span class="opt" data-act="clarify-opt">${esc(o)}</span>`).join("")}</div>
          <input class="clarify-free" placeholder="或直接输入…" style="width:100%;margin-top:6px" />
        </div>`).join("")}
      <div class="clarify-actions">
        <button class="btn primary" data-act="clarify-submit" ${isBusy() ? "disabled" : ""}>${S.pending ? "◌ 正在进行…" : "提交回答，生成提纲"}</button>
        <button class="btn ghost" data-act="clarify-skip" ${isBusy() ? "disabled" : ""}>${esc(c.skip_label || "跳过，按默认来")}</button>
      </div>
    </div>`;
  }
  if (m.kind === "outline") {
    return renderOutlineCard(c, d);
  }
  if (m.kind === "decision") {
    return renderDecisionCard(m, c);
  }
  if (m.kind === "intercept") {
    return `<div class="card intercept">
      <h4>这个问题我不能回答</h4>
      <div>${esc(c.reason || "")}</div>
      ${c.suggestion ? `<div class="card-note">💡 换个问法试试：${esc(c.suggestion)}</div>` : ""}
    </div>`;
  }
  // 文本：用户气泡 / 助手回复
  const cls = m.role === "user" ? "user" : "assistant";
  return `<div class="msg ${cls}">${esc(c.text || "")}${time}</div>`;
}

function renderOutlineCard(c, d) {
  const steps = d.steps || [];
  const scope = c.scope || {};
  const scopeChips = [scope.time_range, scope.view, scope.caliber].filter((x) => x && x !== "-")
    .map((x) => `<span class="scope-chip">${esc(x)}</span>`).join("");
  // 展示按 seq 平铺（=「问题 N」编号顺序），parent_id 仅决定缩进层级（层级遍历会让编号视觉跳号）；
  // 父子经 node_id 字符串关联，深度沿父链计算并做环/悬空防护
  const byNid = new Map(steps.map((s) => [s.node_id, s]));
  const depthOf = (s) => {
    let d = 0, cur = s;
    const seen = new Set([s.node_id]);
    while (cur && cur.parent_id && byNid.has(cur.parent_id) && !seen.has(cur.parent_id)) {
      seen.add(cur.parent_id);
      cur = byNid.get(cur.parent_id);
      d += 1;
    }
    return d;
  };

  const renderNode = (s) => {
    const stCls = { succeeded: "st-ok", running: "st-run", degraded: "st-warn", failed: "st-warn", waiting_approval: "st-warn", skipped: "st-skip", pending: "" }[s.status] || "";
    const stIcon = { succeeded: "✓", running: "▶", degraded: "⚠", failed: "⚠", waiting_approval: "⏸", skipped: "○", pending: "○" }[s.status] || "○";
    const locked = d.running || isBusy();
    // 编号规范化后 node_id 连续 Q1..Qn：主显「问题 N」，node_id 作小字标签（技术标识）
    const num = String(s.node_id || "").replace(/^Q/i, "") || s.seq;
    const dep = depthOf(s);
    return `<div class="node ${dep ? "child" : ""}" style="margin-left:${Math.min(dep, 3) * 22}px">
      <input type="checkbox" data-act="toggle-node" data-id="${s.id}" ${s.selected ? "checked" : ""} ${locked ? "disabled" : ""} />
      <div class="n-main">
        <div class="n-title"><b>问题 ${esc(num)}</b> ${esc(s.title)} <span class="hint n-id">${esc(s.node_id)}</span></div>
        ${s.hypothesis ? `<div class="n-sub">假设：${esc(s.hypothesis)}</div>` : ""}
        <div class="n-tags">
          ${s.kind === "tool" ? `<span class="tag tool">${esc(s.tool_name || "")}</span>` : `<span class="tag">归纳</span>`}
          <span class="tag ${stCls}">${stIcon} ${esc(s.status_label)}</span>
          ${s.source === "user_added" ? `<span class="tag you">你添加</span>` : `<span class="tag">AI 生成</span>`}
          ${(s.data_needed || []).slice(0, 3).map((x) => `<span class="tag">${esc(x)}</span>`).join("")}
          ${s.friendly_error ? `<span class="tag st-warn">${esc(s.friendly_error)}</span>` : ""}
        </div>
      </div>
      ${locked ? "" : `<div class="node-actions">
        <button class="btn ghost sm" data-act="move-node" data-dir="up" data-id="${s.id}" title="上移">↑</button>
        <button class="btn ghost sm" data-act="move-node" data-dir="down" data-id="${s.id}" title="下移">↓</button>
        <button class="btn ghost sm" data-act="edit-node" data-id="${s.id}">编辑</button>
        <button class="btn ghost sm" data-act="del-node" data-id="${s.id}">删除</button>
      </div>`}
    </div>`;
  };

  return `<div class="card outline">
    <h4>📋 ${esc(c.title || "研究提纲（问题树）")}</h4>
    ${scopeChips ? `<div class="outline-scope">${scopeChips}</div>` : ""}
    <div class="node-list">
      ${steps.map((s) => renderNode(s)).join("") ||
        `<div class="hint">提纲为空，可添加问题或重新生成</div>`}
    </div>
    ${d.running ? `<div class="outline-actions"><span class="hint">研究进行中，提纲暂不可编辑</span></div>` : `
    <div class="outline-actions">
      <button class="btn primary" data-act="start-run" ${isBusy() ? "disabled" : ""}>${S.pending ? "◌ 正在进行…" : "开始研究"}</button>
      <button class="btn ghost" data-act="add-node" ${isBusy() ? "disabled" : ""}>＋ 添加问题</button>
      <button class="btn ghost" data-act="regen-plan" ${isBusy() ? "disabled" : ""}>${S.pending?.kind === "plan" ? "◌ 正在生成提纲…" : "重新生成提纲"}</button>
      <span class="grow"></span>
      <span class="hint">${esc(c.note || "可勾选 / 增删问题，或直接说「去掉估值部分」")}</span>
    </div>`}
  </div>`;
}

function renderDecisionCard(m, c) {
  const opts = (c.options || []).map((o) =>
    `<button class="btn ${o.id === "approved" || o.id === "source_a" ? "primary" : "ghost"}"
      data-act="decision" data-type="${esc(c.type)}" data-approval="${c.approval_id || ""}"
      data-ev="${(c.evidence_ids || [])[0] || ""}" data-opt="${esc(o.id)}">${esc(o.label)}</button>`).join("");
  let extra = "";
  if (c.type === "conflict" && c.detail) {
    const side = (k, label) => {
      const s = c.detail[k] || {};
      return `<div class="conflict-side">
        <div class="cs-head">${label}${s.source ? ` · ${esc(s.source)}` : ""}</div>
        <div>数值：${esc(s.value_text ?? "-")}</div>
        <div>口径：${esc(s.caliber ?? "-")}</div>
        <div>时点：${esc(s.as_of ?? "-")}</div>
      </div>`;
    };
    extra = `<div class="conflict-compare">${side("source_a", "源 A")}${side("source_b", "源 B")}</div>`;
  }
  return `<div class="card decision">
    <h4>⚠ ${esc(c.title || "需要你决策")}</h4>
    <div>${esc(c.description || c.reason || "")}</div>
    ${c.risk_level ? `<div class="decision-meta">
      <span class="tag">风险等级：${esc(c.risk_level)}</span>
      ${c.cost_estimate ? `<span class="tag">预估成本：${esc(c.cost_estimate)}</span>` : ""}
      ${c.data_volume ? `<span class="tag">数据量：${esc(c.data_volume)}</span>` : ""}
    </div>` : ""}
    ${extra}
    <div class="outline-actions">${opts}</div>
  </div>`;
}

// ---------- Canvas 产物区 ----------
function renderCanvas() {
  const d = S.detail;
  const wrap = $("#canvasWrap");
  const art = pickArtifact();
  if (!d || !art) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $("#canvasVersion").textContent = art.is_current
    ? `v${art.version}（当前版本） · 生成于 ${fmtTime(art.created_at)}`
    : `v${art.version}（历史版本查看中） · ${fmtTime(art.created_at)} · <a href="javascript:void 0" data-act="back-current">回到当前版本</a>`;
  $("#btnCanvasDiff").hidden = !art.diff;

  const refs = (arr) => (arr || []).map((r) => `<span class="ref-chip" data-act="jump-ev" data-ev="${r}">E${r}</span>`).join("");
  const itemText = (it) => esc(it.text || "");

  const summaryHtml = (art.summary || []).map((s) =>
    `<p>${itemText(s)}${refs(s.refs)}</p>`).join("") || `<p class="hint">（暂无概要）</p>`;

  const factsHtml = (art.facts || []).map((f) =>
    `<div class="r-item" data-id="${esc(f.id)}">${itemText(f)}${refs(f.refs)}
      <div class="r-meta"><span class="conf-badge">${esc(f.id)}</span></div></div>`).join("") ||
    `<div class="hint">（暂无事实；无引用的结论只会出现在待验证区）</div>`;

  const infHtml = (art.inferences || []).map((i) =>
    `<div class="r-item" data-id="${esc(i.id)}">${itemText(i)}${refs(i.refs)}
      <div class="r-meta">
        <span class="conf-badge">${esc(i.id)}</span>
        <span class="conf-badge">置信度：${esc(i.confidence || "未标注")}</span>
        ${i.counter_conditions ? `<span>反驳条件：${esc(i.counter_conditions)}</span>` : ""}
      </div></div>`).join("") || `<div class="hint">（暂无推断）</div>`;

  const unvHtml = (art.unverified || []).map((u) =>
    `<div class="r-item" data-id="${esc(u.id)}">${itemText(u)}${refs(u.refs)}</div>`).join("") ||
    `<div class="hint">（暂无待验证假设）</div>`;

  const dqHtml = (art.data_quality || []).map((q) =>
    `<div class="r-item">${itemText(q)}${refs(q.refs)}</div>`).join("") ||
    `<div class="hint">（数据质量良好，无缺失/冲突登记）</div>`;

  const compliance = art.compliance || {};
  const complianceHtml = (compliance.blocked?.length || compliance.rewrites?.length)
    ? `<div class="r-footer">合规过滤：${(compliance.blocked || []).map((b) => `已拦截「${esc(b)}」`).join("；")}${(compliance.rewrites || []).map((r) => `已改写「${esc(r)}」`).join("；")}</div>`
    : "";

  $("#canvasBody").innerHTML = `
    <div class="r-narrative">
      <b>研究正文（连贯阅读）</b>
      ${narrativeHtml(art.narrative)}
    </div>
    <details class="r-appendix">
      <summary>依据附录 · 四分区明细（事实清单 / 归纳与推断 / 待验证假设 / 数据质量，点击展开核对）</summary>
      <div class="r-summary">
        <b>概要</b>${summaryHtml}
      </div>
      <div class="r-section"><h5>① 事实清单（句句可溯源）</h5>${factsHtml}</div>
      <div class="r-section"><h5>② 归纳与推断</h5>${infHtml}</div>
      <div class="r-section"><h5>③ 待验证假设</h5>${unvHtml}</div>
      <div class="r-section"><h5>④ 数据质量说明</h5>${dqHtml}</div>
    </details>
    ${art.risks?.length ? `<div class="r-section"><h5>风险提示</h5>${art.risks.map((r) => `<div class="r-item">${esc(typeof r === "string" ? r : r.text || "")}</div>`).join("")}</div>` : ""}
    <div class="r-footer">
      数据来源：${esc(uniqueSources(art).join("、") || "见右栏证据库")} · 统计口径：见各证据卡口径字段 · 生成时间：${fmtTime(art.created_at)}
      ${complianceHtml}
      <div class="disc">免责声明：本报告为研究分析，不构成任何投资建议。</div>
    </div>`;
}

/** 连贯正文 → 段落 HTML（行内 [E?] 转可点证据引用，点击跳右栏证据卡） */
function narrativeHtml(narr) {
  if (!narr) return `<p class="hint">（本版报告无连贯正文，请展开下方依据附录核对明细）</p>`;
  return String(narr).split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const withRefs = esc(p).replace(/\[E(\d+)\]/g, (_m, id) =>
      `<span class="ref-chip" data-act="jump-ev" data-ev="${id}">E${id}</span>`);
    return `<p>${withRefs}</p>`;
  }).join("");
}

function uniqueSources(art) {
  const set = new Set();
  const add = (arr) => (arr || []).forEach((it) => {
    const ev = (S.detail?.evidence || []).find((e) => (it.refs || []).includes(e.id));
    if (ev?.source) set.add(ev.source);
  });
  add(art.summary); add(art.facts); add(art.inferences); add(art.data_quality);
  return [...set];
}

function pickArtifact() {
  const d = S.detail;
  if (!d) return null;
  if (S.viewVersion != null) {
    const v = (d.artifacts || []).find((a) => a.version === S.viewVersion);
    if (v) return v;
  }
  return d.current_artifact || (d.artifacts || [])[0] || null;
}

// ---------- 右栏 ----------
function renderRight() {
  renderEvidence();
  renderMemory();
  renderVersions();
  $$(".right .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === S.activeTab));
  $("#evidencePane").hidden = S.activeTab !== "evidence";
  $("#memoryPane").hidden = S.activeTab !== "memory";
  $("#versionPane").hidden = S.activeTab !== "version";
}

function renderEvidence() {
  const d = S.detail;
  let list = d ? [...(d.topic_evidence || [])] : [];
  if (S.evQuery) {
    const q = S.evQuery.toLowerCase();
    list = list.filter((e) => [e.metric, e.value_text, e.source, e.label, e.raw_snippet].join(" ").toLowerCase().includes(q));
  }
  if (S.evFilter === "conflict") list = list.filter((e) => e.status === "conflict");
  else if (S.evFilter === "missing") list = list.filter((e) => e.status === "missing");
  else if (S.evFilter === "stale") list = list.filter((e) => e.status === "stale");
  else if (S.evFilter === "user_upload") list = list.filter((e) => e.type === "user_upload");

  const conflicts = list.filter((e) => e.status === "conflict");
  const missing = list.filter((e) => e.status === "missing");
  const rest = list.filter((e) => e.status !== "conflict" && e.status !== "missing");

  const card = (e) => {
    const stCls = `st-${e.status}`;
    return `<div class="ev-card ${S.hlEv === e.id ? "highlight" : ""}" id="ev-${e.id}">
      <div class="ev-head">
        <span class="ev-ref" data-act="jump-ev" data-ev="${e.id}">${esc(e.ref)}</span>
        <span>${esc(e.metric || e.label)}</span>
        ${e.starred ? "⭐" : ""}
        ${e.primary_source ? `<span class="tag you">主源</span>` : ""}
      </div>
      <div class="ev-val">${esc(e.value_text || "-")} ${esc(e.unit || "")}</div>
      <div class="ev-line">时点 ${esc(e.as_of || "-")} · 口径 ${esc(e.caliber || "-")}</div>
      <div class="ev-line">来源 ${esc(e.source || "-")}${e.source_detail ? ` · ${esc(e.source_detail)}` : ""} · <span class="st ${stCls}">${esc(e.status_label)}</span></div>
      ${e.conflict_with ? `<div class="ev-line">与 ${esc(e.conflict_with)} 冲突</div>` : ""}
      ${e.raw_snippet ? `<div class="ev-snippet" data-act="toggle-snippet">${esc(e.raw_snippet)}</div>` : ""}
      <div class="ev-actions">
        <button class="btn ghost sm" data-act="star-ev" data-id="${e.id}">${e.starred ? "取消星标" : "星标"}</button>
        ${e.status === "conflict" ? `<button class="btn ghost sm" data-act="primary-ev" data-id="${e.id}">指定为主源</button>` : ""}
        ${e.type === "user_upload" ? `<span class="tag you">你补充的</span>` : ""}
      </div>
    </div>`;
  };

  $("#evList").innerHTML =
    (conflicts.length ? `<div class="ev-group-title">⚑ 数据冲突 ${conflicts.length} 条（双源陈列，请指定主源）</div>` + conflicts.map(card).join("") : "") +
    (missing.length ? `<div class="ev-group-title">⚑ 缺失登记 ${missing.length} 条</div>` + missing.map(card).join("") : "") +
    (rest.length ? `<div class="pane-sub">全部证据 ${rest.length} 条</div>` + rest.map(card).join("") : "") ||
    `<div class="hint">暂无证据。执行研究后每条取数会先落证据卡；也可点左下「补充证据」手动登记。</div>`;
}

function renderMemory() {
  const mems = S.detail?.memories || [];
  const cand = mems.filter((m) => m.status === "candidate");
  const active = mems.filter((m) => m.status === "active");
  $("#memCandidateList").innerHTML = cand.map((m) => `
    <div class="mem-card">
      <div>${esc(m.content)}</div>
      <div class="mem-actions">
        <button class="btn primary sm" data-act="mem-accept" data-id="${m.id}">确认写入</button>
        <button class="btn ghost sm" data-act="mem-reject" data-id="${m.id}">丢弃</button>
      </div>
    </div>`).join("") || `<div class="hint">暂无候选记忆。研究完成后系统会提炼候选，经你确认才写入，防止污染主题记忆。</div>`;
  $("#memActiveList").innerHTML = active.map((m) => `
    <div class="mem-card"><div>${esc(m.content)}</div><div class="hint">${fmtTime(m.created_at)}</div></div>`).join("") ||
    `<div class="hint">暂无已确认记忆。</div>`;
}

function renderVersions() {
  const arts = S.detail?.artifacts || [];
  $("#versionList").innerHTML = arts.map((a) => `
    <div class="ver-card ${a.is_current ? "current" : ""}">
      <div class="ver-head">v${a.version} ${a.is_current ? '<span class="tag you">当前</span>' : ""} <span class="hint">${fmtTime(a.created_at)}</span></div>
      <div>${esc(a.changelog || "初始版本")}</div>
      <div class="ver-actions">
        <button class="btn ghost sm" data-act="view-ver" data-v="${a.version}">查看</button>
        ${a.diff ? `<button class="btn ghost sm" data-act="diff-ver" data-v="${a.version}">diff</button>` : ""}
        ${!a.is_current ? `<button class="btn ghost sm" data-act="rollback-ver" data-v="${a.version}">回滚到此版</button>` : ""}
      </div>
      <div class="diff-box" id="diff-${a.version}" hidden></div>
    </div>`).join("") || `<div class="hint">暂无产物版本。研究完成后自动生成四分区报告（v1）。</div>`;
}

function renderDiff(version) {
  const art = (S.detail?.artifacts || []).find((a) => a.version === version);
  const box = $(`#diff-${version}`);
  if (!art?.diff || !box) return;
  const d = art.diff;
  const secName = { narrative: "研究正文", summary: "概要", facts: "事实", inferences: "推断", unverified: "待验证", data_quality: "数据质量" };
  box.innerHTML = `
    <div class="hint" style="margin:6px 0">diff（新增=蓝 / 删除=灰，禁红绿）</div>
    ${(d.added || []).map((x) => `<div class="diff-added">＋ [${secName[x.section] || x.section}] ${esc(x.text)}</div>`).join("")}
    ${(d.removed || []).map((x) => `<div class="diff-removed">－ [${secName[x.section] || x.section}] ${esc(x.text)}</div>`).join("")}
    ${(d.changed || []).map((x) => `<div class="diff-changed">
      <span class="old">－ ${esc(x.old_text)}</span><span class="new">＋ ${esc(x.new_text)}</span>
    </div>`).join("")}
    ${(!d.added?.length && !d.removed?.length && !d.changed?.length) ? `<div class="hint">与上一版无差异</div>` : ""}`;
}

// ---------- 开发者面板 ----------
function renderDev() {
  $("#devPanel").hidden = !S.dev;
  if (!S.dev) return;
  const d = S.detail;
  const t = d?.thread;
  $("#devStats").textContent = t
    ? `model=${t.llm?.model || "-"} · key=${t.llm?.api_key_masked || "未配置"} · tokens ${t.tokens_in}/${t.tokens_out} · cost $${Number(t.cost_usd || 0).toFixed(3)}`
    : "";
  const ckpts = d?.dev?.checkpoints || [];
  $("#ckptList").innerHTML = ckpts.map((c) => `
    <li><span>ckpt#${c.id}（至步骤 ${c.upto_seq}）</span><span class="hint">${esc(c.note || "")}</span>
      <span class="grow"></span><button class="btn ghost sm" data-act="restore-ckpt" data-id="${c.id}">恢复</button></li>`).join("") ||
    `<li class="hint">暂无检查点（每步执行后自动落点）</li>`;
  const traces = d?.dev?.traces || [];
  $("#traceList").innerHTML = traces.map((tr) => `
    <li title="payload 仅开发者模式可见">
      <span class="tag">${esc(tr.kind)}</span>
      <span>${esc(tr.summary || "")}</span>
      <span class="grow"></span>
      <span class="hint">${tr.tokens_in ?? 0}/${tr.tokens_out ?? 0} tok · ${tr.latency_ms ?? 0}ms</span>
    </li>`).join("") || `<li class="hint">暂无 trace</li>`;
}

// ============ 交互 ============
function wireEvents() {
  document.addEventListener("click", onDocClick);
  $("#actWarn").addEventListener("click", () => {
    const notices = S.detail?.notices || [];
    $("#noticeList").innerHTML = notices.map((n) =>
      `<div class="notice-item ${esc(n.level)}">[${esc(n.category)}] ${esc(n.friendly_message || n.message)}<span class="hint"> · ${fmtTime(n.created_at)}</span></div>`
    ).join("") || `<div class="hint">暂无系统事件</div>`;
    openModal("noticeModal");
  });
  $("#devToggle").addEventListener("change", async (e) => {
    S.dev = e.target.checked;
    await loadThread();
  });
  $("#btnNewTopic").addEventListener("click", () => openModal("topicModal"));
  $("#btnNewThread").addEventListener("click", () => openModal("threadModal"));
  $("#btnAddEvidence").addEventListener("click", () => openModal("evidenceModal"));
  $("#btnSend").addEventListener("click", sendMessage);
  $("#msgInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
  });
  $("#topicSelect").addEventListener("change", async (e) => {
    S.topicId = Number(e.target.value) || null;
    S.threadId = null;
    await loadThreads(true);
  });
  $("#btnCreateTopic").addEventListener("click", createTopic);
  $("#btnCreateThread").addEventListener("click", createThread);
  $("#btnSaveEvidence").addEventListener("click", saveEvidence);
  $("#btnSaveNode").addEventListener("click", saveNode);
  $("#btnTestLlm").addEventListener("click", testLlm);
  $("#btnApplyAnomaly").addEventListener("click", () => {
    runBusy("anomaly", "正在设置故障注入", async () => {
      await api("/api/anomaly", { method: "POST", body: { mode: $("#anomalySelect").value } });
      alert(`故障注入已设为：${$("#anomalySelect").value}`);
    });
  });
  $("#btnCompress").addEventListener("click", () => {
    if (!S.threadId) return;
    runBusy("compress", "正在压缩上下文", async () => {
      await api(`/api/threads/${S.threadId}/compress`, { method: "POST" });
      await loadThread();
    });
  });
  $("#btnRefreshDev").addEventListener("click", loadThread);
  $("#btnCollapseRight").addEventListener("click", () => {
    $(".layout").classList.toggle("right-collapsed");
    $("#rightPanel").style.overflow = $(".layout").classList.contains("right-collapsed") ? "hidden" : "";
  });
  $("#btnCanvasDiff").addEventListener("click", () => {
    S.activeTab = "version";
    renderRight();
    const art = pickArtifact();
    if (art) {
      const box = $(`#diff-${art.version}`);
      if (box) { box.hidden = false; renderDiff(art.version); }
    }
  });
  $$(".right .tab").forEach((t) => t.addEventListener("click", () => {
    S.activeTab = t.dataset.tab;
    renderRight();
  }));
  $$(".chip[data-evf]").forEach((c) => c.addEventListener("click", () => {
    S.evFilter = c.dataset.evf;
    $$(".chip[data-evf]").forEach((x) => x.classList.toggle("active", x === c));
    renderEvidence();
  }));
  $("#evSearch").addEventListener("input", (e) => {
    S.evQuery = e.target.value.trim();
    renderEvidence();
  });
  // Canvas 选中文字 → 浮层工具条
  $("#canvasBody").addEventListener("mouseup", onSelectInCanvas);
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#selToolbar")) $("#selToolbar").hidden = true;
  });
  $$("#selToolbar button").forEach((b) => b.addEventListener("click", () => {
    const clip = S.selText.slice(0, 40);
    if (b.dataset.sel === "revise") {
      $("#msgInput").value = `改这段（“${clip}…”）：`;
      $("#msgInput").focus();
    } else if (b.dataset.sel === "ask") {
      $("#msgInput").value = `追问这个（“${clip}…”）：`;
      $("#msgInput").focus();
    } else {
      S.activeTab = "evidence";
      renderRight();
    }
    $("#selToolbar").hidden = true;
  }));
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
}

function onDocClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const id = Number(t.dataset.id);

  if (act === "pick-topic") { $("#topicSelect").value = id; $("#topicSelect").dispatchEvent(new Event("change")); return; }
  if (act === "pick-thread") { selectThread(id); return; }
  if (act === "clarify-opt") {
    const row = t.closest(".clarify-q");
    $$(".opt", row).forEach((o) => o.classList.toggle("selected", o === t));
    return;
  }
  if (act === "clarify-submit" || act === "clarify-skip") { submitClarify(act === "clarify-skip"); return; }
  if (act === "toggle-node") { toggleNode(t); return; }
  if (act === "move-node") {
    runBusy("move-node", "正在调整顺序", async () => {
      await api(`/api/nodes/${id}`, { method: "PATCH", body: { move: t.dataset.dir } });
      await loadThread();
    });
    return;
  }
  if (act === "edit-node") { openNodeModal("edit", id); return; }
  if (act === "del-node") { deleteNode(id); return; }
  if (act === "add-node") { openNodeModal("add"); return; }
  if (act === "start-run") { startRun(); return; }
  if (act === "regen-plan") { regenPlan(); return; }
  if (act === "decision") { decide(t); return; }
  if (act === "jump-ev") { jumpEvidence(Number(t.dataset.ev)); return; }
  if (act === "toggle-snippet") { t.classList.toggle("open"); return; }
  if (act === "star-ev") {
    const ev = (S.detail?.topic_evidence || []).find((x) => x.id === id);
    runBusy("star-ev", "正在更新星标", async () => {
      await api(`/api/evidence/${id}`, { method: "PATCH", body: { starred: !ev?.starred } });
      await loadThread();
    });
    return;
  }
  if (act === "primary-ev") {
    runBusy("primary-ev", "正在指定主源", async () => {
      await api(`/api/evidence/${id}/primary`, { method: "POST", body: { side: "source_a" } });
      await loadThread();
    });
    return;
  }
  if (act === "mem-accept") {
    runBusy("mem", "正在写入记忆", async () => {
      await api(`/api/memories/${id}`, { method: "POST", body: { accept: true } });
      await loadThread();
    });
    return;
  }
  if (act === "mem-reject") {
    runBusy("mem", "正在丢弃候选记忆", async () => {
      await api(`/api/memories/${id}`, { method: "POST", body: { accept: false } });
      await loadThread();
    });
    return;
  }
  if (act === "view-ver") {
    S.viewVersion = Number(t.dataset.v);
    renderCanvas();
    return;
  }
  if (act === "back-current") { S.viewVersion = null; renderCanvas(); return; }
  if (act === "diff-ver") {
    const v = Number(t.dataset.v);
    const box = $(`#diff-${v}`);
    box.hidden = !box.hidden;
    if (!box.hidden) renderDiff(v);
    return;
  }
  if (act === "rollback-ver") {
    if (!confirm(`回滚到 v${t.dataset.v}？当前版本会保留在历史中。`)) return;
    runBusy("rollback", "正在回滚版本", async () => {
      await api(`/api/threads/${S.threadId}/artifact/rollback`, { method: "POST", body: { version: Number(t.dataset.v) } });
      S.viewVersion = null;
      await loadThread();
    });
    return;
  }
  if (act === "restore-ckpt") {
    if (!confirm("恢复到该检查点？之后的步骤状态会回退（证据卡保留）。")) return;
    runBusy("restore", "正在恢复检查点", async () => {
      await api(`/api/threads/${S.threadId}/checkpoints/${id}/restore`, { method: "POST" });
      await loadThread();
    });
    return;
  }
}

async function selectThread(id) {
  S.threadId = id;
  S.viewVersion = null;
  S.hlEv = null;
  await loadThread();
}

// ---------- 创建 ----------
async function createTopic() {
  const name = $("#topicName").value.trim();
  if (!name) return alert("主题名不能为空");
  await runBusy("create-topic", "正在创建主题", async () => {
    const r = await api("/api/topics", { method: "POST", body: { name, symbol: $("#topicSymbol").value.trim(), note: $("#topicNote").value.trim() } });
    closeModal("topicModal");
    await loadTopics(false);
    S.topicId = r.id;
    $("#topicSelect").value = r.id;
    await loadThreads(true);
  });
}

async function createThread() {
  const goal = $("#goalInput").value.trim();
  if (!goal) return alert("研究目标不能为空");
  const body = {
    goal,
    mode: $("#threadMode").value,
    topic_id: S.topicId,
    llm_cfg: { base_url: $("#cfgBaseUrl").value.trim(), api_key: $("#cfgApiKey").value.trim(), model: $("#cfgModel").value },
  };
  await runBusy("create", "正在创建研究任务", async () => {
    let r;
    try {
      r = await api("/api/threads", { method: "POST", body });
    } catch (err) {
      throw new Error(err.message);
    }
    if (!r.ok) {
      throw new Error(r.intercepted ? `该输入已被合规拦截：${r.reason}\n建议问法：${r.suggestion}` : r.error || "创建失败");
    }
    closeModal("threadModal");
    $("#goalInput").value = "";
    await loadThreads(false);
    S.threadId = r.id;
    await loadThread();
    // 目标已充分 → 无需点按钮，自动生成问题树（§4.3）；202 受理后由 SSE plan_ready/plan_failed 收口
    if (!r.need_clarify) {
      S.pending = { label: "正在生成研究提纲", kind: "plan", until: "plan" };
      renderActivity();
      try {
        await api(`/api/threads/${r.id}/plan`, { method: "POST", body: {} });
      } catch (err) {
        clearPending();
        alert("提纲生成启动失败：" + err.message + "\n可到提纲卡点「重新生成提纲」重试。");
      }
      renderAll();
    }
  });
}

// ---------- 澄清 ----------
async function submitClarify(skip) {
  if (S.pending) return; // 连点幂等
  const answers = {};
  if (!skip) {
    $$("#chatStream .clarify-q").forEach((row) => {
      const qid = row.dataset.qid;
      const sel = $(".opt.selected", row);
      const free = $(".clarify-free", row)?.value.trim();
      if (free) answers[qid] = free;
      else if (sel) answers[qid] = sel.textContent.trim();
    });
  }
  S.pending = { label: "正在生成研究提纲", kind: "plan", until: "plan" };
  renderActivity();
  renderChat();
  try {
    await api(`/api/threads/${S.threadId}/clarify`, { method: "POST", body: { answers } });
  } catch (err) {
    clearPending();
    alert("提纲生成启动失败：" + err.message + "\n可点「重新生成提纲」重试。");
    renderAll();
    return;
  }
  renderAll();
}

// ---------- 提纲编辑 ----------
function openNodeModal(mode, id) {
  S.nodeEdit = { mode, id };
  $("#nodeModalTitle").textContent = mode === "add" ? "添加问题（human-in-the-loop 计划纠偏）" : "编辑问题";
  const s = (S.detail?.steps || []).find((x) => x.id === id);
  $("#nodeTitle").value = s?.title || "";
  $("#nodeHypothesis").value = s?.hypothesis || "";
  $("#nodeTool").value = s?.tool_name || "";
  const args = [];
  try {
    const raw = s ? (s.args_display || "") : "";
    const m = raw.match(/\((.*)\)/);
    if (m) args.push(m[1]);
  } catch { /* 忽略 */ }
  $("#nodeArgs").value = args.join("") || "";
  openModal("nodeModal");
}

function parseArgs(str) {
  const args = {};
  String(str || "").split(/[,，]/).map((x) => x.trim()).filter(Boolean).forEach((pair) => {
    const i = pair.indexOf("=");
    if (i > 0) args[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return args;
}

async function saveNode() {
  const body = {
    title: $("#nodeTitle").value.trim() || "未命名问题",
    sub_question: $("#nodeTitle").value.trim(),
    hypothesis: $("#nodeHypothesis").value.trim(),
    tool_name: $("#nodeTool").value || null,
    args: parseArgs($("#nodeArgs").value),
    kind: $("#nodeTool").value ? "tool" : "analysis",
    selected: true,
  };
  await runBusy("save-node", "正在保存问题", async () => {
    if (S.nodeEdit.mode === "add") {
      await api(`/api/threads/${S.threadId}/nodes`, { method: "POST", body });
    } else {
      await api(`/api/nodes/${S.nodeEdit.id}`, { method: "PATCH", body });
    }
    closeModal("nodeModal");
    await loadThread();
  });
}

async function toggleNode(input) {
  await runBusy("toggle-node", "正在更新勾选", async () => {
    await api(`/api/nodes/${input.dataset.id}`, { method: "PATCH", body: { selected: input.checked } });
    await loadThread();
  });
}

async function deleteNode(id) {
  if (!confirm("删除该问题？")) return;
  await runBusy("del-node", "正在删除问题", async () => {
    await api(`/api/nodes/${id}`, { method: "DELETE" });
    await loadThread();
  });
}

async function regenPlan() {
  if (S.pending) return; // 连点幂等
  S.pending = { label: "正在生成研究提纲", kind: "plan", until: "plan" };
  renderActivity();
  renderChat();
  try {
    await api(`/api/threads/${S.threadId}/plan`, { method: "POST", body: {} });
  } catch (err) {
    clearPending();
    alert("提纲生成启动失败：" + err.message + "\n可再点「重新生成提纲」重试。");
    renderAll();
    return;
  }
  renderAll();
}

// ---------- 执行 / 决策 ----------
async function startRun() {
  await runBusy("run", "正在启动研究执行", async () => {
    await api(`/api/threads/${S.threadId}/run`, { method: "POST" });
    await loadThread();
  });
}

async function decide(btn) {
  const type = btn.dataset.type;
  const opt = btn.dataset.opt;
  await runBusy("decision", "正在提交决策", async () => {
    if (type === "approval") {
      await api(`/api/threads/${S.threadId}/approvals/${btn.dataset.approval}`, { method: "POST", body: { decision: opt } });
    } else if (type === "conflict") {
      await api(`/api/evidence/${btn.dataset.ev}/primary`, { method: "POST", body: { side: opt } });
    }
    await loadThread();
  });
}

// ---------- 对话消息 ----------
async function sendMessage() {
  const input = $("#msgInput");
  const text = input.value.trim();
  if (isBusy()) return; // 连点幂等：在途动作期间忽略
  if (!text) return;
  if (!S.threadId) return alert("请先在左上「＋ 新研究」创建研究任务");
  input.value = "";
  // 点击即置灰 + 「◌ 正在进行…」；长任务 202 受理，SSE 助手回复/失败回执到达后收口
  const send = $("#btnSend");
  if (send) { send.disabled = true; send.textContent = "◌ 正在进行…"; }
  S.pending = { label: "正在思考回复", kind: "message", until: "message" };
  renderActivity();
  renderChat();
  try {
    await api(`/api/threads/${S.threadId}/messages`, {
      method: "POST",
      body: { text, model: $("#modelSelect").value },
    });
    renderAll();
  } catch (err) {
    clearPending();
    alert("消息发送失败：" + err.message + "\n可重新发送；如反复失败，开开发者模式查看 trace。");
    renderAll();
  }
}

// ---------- 证据 ----------
async function saveEvidence() {
  const body = {
    metric: $("#evMetric").value.trim(),
    value_text: $("#evValue").value.trim(),
    unit: $("#evUnit").value.trim(),
    as_of: $("#evAsOf").value.trim(),
    caliber: $("#evCaliber").value.trim(),
    source: $("#evSource").value.trim() || "用户补充",
    raw_snippet: $("#evSnippet").value.trim(),
  };
  await runBusy("add-ev", "正在入库证据", async () => {
    await api(`/api/threads/${S.threadId}/evidence`, { method: "POST", body });
    ["#evMetric", "#evValue", "#evUnit", "#evAsOf", "#evCaliber", "#evSource", "#evSnippet"].forEach((s) => ($(s).value = ""));
    closeModal("evidenceModal");
    S.activeTab = "evidence";
    await loadThread();
  });
}

function jumpEvidence(evNum) {
  S.activeTab = "evidence";
  S.hlEv = evNum;
  S.evFilter = "all";
  renderRight();
  const card = $(`#ev-${evNum}`);
  if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
}

// ---------- Canvas 选中 ----------
function onSelectInCanvas() {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text || text.length < 2) { $("#selToolbar").hidden = true; return; }
  const range = sel.getRangeAt(0);
  if (!$("#canvasBody").contains(range.commonAncestorContainer)) return;
  S.selText = text;
  const rect = range.getBoundingClientRect();
  const bar = $("#selToolbar");
  bar.hidden = false;
  bar.style.left = `${Math.min(window.innerWidth - 240, rect.left + window.scrollX)}px`;
  bar.style.top = `${rect.top + window.scrollY - 44}px`;
}

// ---------- LLM 连接测试 ----------
async function testLlm() {
  const out = $("#llmTestResult");
  out.textContent = "◌ 测试中…";
  await runBusy("llm-test", "正在测试 LLM 连接", async () => {
    try {
      const r = await api("/api/llm/test", {
        method: "POST",
        body: { base_url: $("#cfgBaseUrl").value.trim(), api_key: $("#cfgApiKey").value.trim(), model: $("#cfgModel").value },
      });
      out.textContent = r.ok ? `✓ 连接成功（${r.model}，${r.latencyMs}ms）` : `✗ ${r.error}`;
    } catch (e) {
      out.textContent = `✗ ${e.message}`;
    }
  });
}

// ---------- 弹层 ----------
function openModal(id) { $(`#${id}`).hidden = false; }
function closeModal(id) { $(`#${id}`).hidden = true; }

boot();
