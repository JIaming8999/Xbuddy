// server/llm.js — LLM 网关：OpenAI 兼容 chat completions，含重试、超时、token 记账
import "dotenv/config";

const BASE_URL = process.env.LLM_BASE_URL || "https://token-plan-cn.xiaomimimo.com/v1";
const API_KEY = process.env.LLM_API_KEY || "";
export const MODEL_PLANNER = process.env.LLM_MODEL_PLANNER || "mimo-v2.6-pro"; // 注意：该接口的模型名必须全小写
export const MODEL_LIGHT = process.env.LLM_MODEL_LIGHT || "mimo-v2.6-flash";

export function llmConfigured(cfg) {
  const key = cfg?.api_key || API_KEY;
  return key.length > 0 && !key.startsWith("sk-your-key");
}

export async function chat({ messages, model = MODEL_PLANNER, tools = null, toolChoice = "auto", maxTokens = 2048, temperature = 0.3, timeoutMs = 90000, cfg = null }) {
  const baseUrl = (cfg?.base_url || BASE_URL).replace(/\/$/, "");
  const apiKey = cfg?.api_key || API_KEY;
  const effModel = cfg?.model || model;
  const body = { model: effModel, messages, max_tokens: maxTokens, temperature };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  const started = Date.now();
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = await res.json();
      const choice = json.choices?.[0] ?? {};
      return {
        content: choice.message?.content ?? "",
        toolCalls: choice.message?.tool_calls ?? null,
        finishReason: choice.finish_reason,
        usage: json.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
        latencyMs: Date.now() - started,
        model: json.model || model,
      };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** 从模型输出中提取 JSON（容忍 markdown 代码块包裹） */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function estimateCost(tokensIn, tokensOut) {
  // 仅用于成本可观测性展示的粗略估算（美元），不代表实际计费
  return Math.round((tokensIn * 0.0003 + tokensOut * 0.0012) / 1000 * 1e6) / 1e6;
}
