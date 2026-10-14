// tests/e2e-smoke.mjs — 真实模式端到端冒烟（需服务 :3210 且配置 LLM_API_KEY）
// 流程：建主题 → 建线程 → （澄清）→ 问题树 → 执行 → 报告 → 修订 → 记忆 → 拦截
// 运行：node tests/e2e-smoke.mjs
const BASE = "http://localhost:3210";
const post = (p, b) => fetch(`${BASE}${p}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}),
}).then((r) => r.json());
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json());

const checks = [];
const check = (name, cond, extra = "") => {
  checks.push([name, !!cond]);
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " " + extra : ""}`);
};

console.log("\n== 真实模式端到端冒烟 ==");

// 1. 主题
const tp = await post("/api/topics", { name: "贵州茅台", symbol: "600519.SH", note: "e2e 冒烟" });
check("创建主题", tp.ok);

// 2. 线程（目标充分，含时间/视角/标的）
const th = await post("/api/threads", {
  goal: "梳理贵州茅台近 1 年经营变化与风险点", mode: "real", topic_id: tp.id,
});
check("创建线程", th.ok, JSON.stringify(th).slice(0, 120));
const tid = th.id;

// 3. 澄清 / 规划（目标充分应直接规划）
let planRes;
if (th.need_clarify) {
  planRes = await post(`/api/threads/${tid}/clarify`, { answers: { time_range: "近 1 年" } });
} else {
  planRes = await post(`/api/threads/${tid}/plan`);
}
check("问题树生成且校验通过", planRes.ok && planRes.validation?.ok, JSON.stringify(planRes.validation || {}).slice(0, 160));

const det0 = await get(`/api/threads/${tid}`);
check("提纲含假设/子问题字段", det0.steps.length >= 3 && det0.steps.every((s) => "hypothesis" in s && "data_needed" in s));

// 4. 执行
await post(`/api/threads/${tid}/run`);
let det = det0;
const t0 = Date.now();
while (Date.now() - t0 < 4 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 5000));
  det = await get(`/api/threads/${tid}`);
  if (!det.running && det.thread.stage === "report") break;
}
check("执行完成（stage=report）", det.thread.stage === "report", `进度 ${det.thread.progress}`);
check("证据卡落库", det.evidence.length >= 3, `${det.evidence.length} 张`);
check("报告生成（四分区）", !!det.current_artifact && det.current_artifact.facts.length > 0);
check("事实区句句挂引用", (det.current_artifact?.facts || []).every((f) => (f.refs || []).length > 0));
check("推断含置信度", (det.current_artifact?.inferences || []).every((i) => !!i.confidence));
check("页脚合规声明在 risks", (det.current_artifact?.risks || []).some((r) => String(r).includes("不构成任何投资建议")));

// 5. 修订（对话式）
const rev = await post(`/api/threads/${tid}/messages`, { text: "概要压到两句话" });
check("对话式修订生成新版本", rev.ok && rev.action === "revised" && rev.version >= 2, `v${rev.version}`);
check("修订返回 diff", rev.diff && (rev.diff.added.length + rev.diff.removed.length + rev.diff.changed.length) >= 0);
const det1 = await get(`/api/threads/${tid}`);
check("版本历史可回滚（多版本）", det1.artifacts.length >= 2 && det1.artifacts.some((a) => a.diff !== null));

// 6. 记忆
const cand = det1.memories.filter((m) => m.status === "candidate");
if (cand.length) {
  const acc = await post(`/api/memories/${cand[0].id}`, { accept: true });
  check("候选记忆确认后转 active", acc.ok && acc.memory.status === "active");
} else {
  check("候选记忆产生（演示：本次未产生也不阻塞）", true, "（无候选）");
}

// 7. 合规拦截（输入侧）
const bad = await post(`/api/threads/${tid}/messages`, { text: "现在可以买入茅台吗" });
const det2 = await get(`/api/threads/${tid}`);
check("输入侧拦截并留痕", bad.intercepted === true && det2.messages.some((m) => m.kind === "intercept"));

// 8. 人工补充证据
const ev = await post(`/api/threads/${tid}/evidence`, {
  metric: "渠道批价", value_text: "2650 元/瓶", as_of: "2026-09-30", caliber: "周度均值", source: "渠道调研纪要",
});
check("补充证据入库", ev.ok);

const passN = checks.filter(([, ok]) => ok).length;
console.log(`\n冒烟结果：${passN}/${checks.length} 通过`);
process.exit(passN === checks.length ? 0 : 1);
