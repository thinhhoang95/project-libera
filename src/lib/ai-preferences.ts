import { readFileSync } from "node:fs";
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

export function getAiChatCustomInstruction() {
  if (typeof process.env.LIBERA_AI_CHAT_CUSTOM_INSTRUCTION === "string") {
    return process.env.LIBERA_AI_CHAT_CUSTOM_INSTRUCTION;
  }

  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return "";

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      aiFunctions?: { chat?: { customInstruction?: unknown } };
    };
    const customInstruction = config.aiFunctions?.chat?.customInstruction;

    return typeof customInstruction === "string" ? customInstruction : "";
  } catch {
    return "";
  }
}
