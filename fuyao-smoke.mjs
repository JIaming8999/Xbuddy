// tests/fuyao-smoke.mjs — 扶摇真实数据源冒烟（真实网络调用，非 run-tests 一部分）
// 运行：node --env-file=.env tests/fuyao-smoke.mjs
// 未配置 FUYAO_API_KEY 时自动跳过（exit 0），不阻断 CI；配置后校验真实取数 + 诚实降级。
import "dotenv/config";
import { executeTool } from "../server/tools.js";

const KEY = process.env.FUYAO_API_KEY;
if (!KEY) {
  console.log("⏭  未配置 FUYAO_API_KEY，跳过扶摇真实冒烟。");
  process.exit(0);
}
process.env.DATA_PROVIDER = "fuyao";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const hasProv = (r) => r.provenance && r.provenance.endpoint && r.provenance.request_id;

console.log("\n[fuyao-smoke] 真实取数：证据卡须带 label=real + endpoint + request_id");

const quote = await executeTool("get_quote", { symbol: "600519" });
ok("get_quote 真实行情+来源可溯", quote.ok && quote.label === "real" && hasProv(quote) && !!quote.value, JSON.stringify(quote.provenance));

const kline = await executeTool("get_kline", { symbol: "600519", days: 5 });
ok("get_kline 真实K线序列", kline.ok && kline.label === "real" && Array.isArray(kline.content.closes) && kline.content.closes.length === 5);

const fin = await executeTool("get_financials", { symbol: "600519" });
ok("get_financials 真实财务指标（含报告期）", fin.ok && fin.label === "real" && !!fin.content.report && hasProv(fin), fin.value_text);

const idx = await executeTool("get_index_overview", { symbol: "886042.TI" });
ok("get_index_overview 真实指数快照", idx.ok && idx.label === "real" && !!idx.content.price, idx.value_text);

const senti = await executeTool("get_market_sentiment", {});
ok("get_market_sentiment 真实情绪面", senti.ok && senti.label === "real" && Array.isArray(senti.content.hot_list), senti.value_text);

const rt = await executeTool("resolve_ticker", { query: "贵州茅台" });
ok("resolve_ticker 真实消歧命中", rt.ok && rt.label === "real" && rt.content.candidates.length > 0);

console.log("\n[fuyao-smoke] 诚实降级：无端点/未开放/不存在 → 显式缺失，绝不编数、绝不回退 mock");

const val = await executeTool("get_valuation", { symbol: "600519" });
ok("get_valuation 无估值端点→诚实缺口（data_gap）", val.ok && val.degraded && val.notice?.category === "data_gap" && val.data.missing === true);

const ann = await executeTool("get_announcements", { symbol: "600519" });
ok("get_announcements 无公告端点→诚实缺口", ann.ok && ann.degraded && ann.notice?.category === "data_gap");

const news = await executeTool("search_news", { symbol: "600519", keyword: "茅台" });
ok("search_news 未开放外部→诚实缺口（不回退 mock）",
  news.ok && news.degraded && ["data_gap", "data_missing", "tool_failure"].includes(news.notice?.category) && news.label !== "mock",
  `notice=${news.notice?.category} label=${news.label}`);

const changxin = await executeTool("resolve_ticker", { query: "长鑫存储" });
ok("长鑫存储（未上市）→检索为空且标注缺失", changxin.ok && changxin.degraded && changxin.notice?.category === "data_missing" && changxin.content.candidates.length === 0);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
