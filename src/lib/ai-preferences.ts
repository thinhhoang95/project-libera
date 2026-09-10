import { getOpenRouterModel } from "./openrouter";

export type AiFunction = "formatting" | "rewrite" | "chat" | "latex";
export type AiReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

export function getAiFunctionOptions(name: AiFunction) {
  const prefix = `LIBERA_AI_${name.toUpperCase()}`;
  const model = process.env[`${prefix}_MODEL`]?.trim() || (name === "latex" ? "openai/gpt-5.6-luna" : getOpenRouterModel());
  const configuredEffort = process.env[`${prefix}_REASONING_EFFORT`];
  const effort: AiReasoningEffort = configuredEffort && EFFORTS.has(configuredEffort) ? configuredEffort as AiReasoningEffort : name === "latex" ? "low" : "medium";
  return { model, reasoning: { effort } };
}
