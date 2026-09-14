import { readFileSync } from "node:fs";
import { getOpenRouterModel } from "./openrouter";

export type AiFunction = "formatting" | "rewrite" | "chat" | "imageToMarkdown" | "latex";
export type AiReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);
const ENV_NAMES: Record<AiFunction, string> = {
  formatting: "FORMATTING",
  rewrite: "REWRITE",
  chat: "CHAT",
  imageToMarkdown: "IMAGE_TO_MARKDOWN",
  latex: "LATEX",
};

export function getAiFunctionOptions(name: AiFunction) {
  const prefix = `LIBERA_AI_${ENV_NAMES[name]}`;
  const model = process.env[`${prefix}_MODEL`]?.trim() || (name === "latex" ? "openai/gpt-5.6-luna" : getOpenRouterModel());
  const configuredEffort = process.env[`${prefix}_REASONING_EFFORT`];
  const effort: AiReasoningEffort = configuredEffort && EFFORTS.has(configuredEffort) ? configuredEffort as AiReasoningEffort : name === "latex" ? "low" : "medium";
  const configuredCaching = process.env[`${prefix}_PROMPT_CACHING`];
  const promptCaching = configuredCaching === "true" ? true : configuredCaching === "false" ? false : name === "chat";
  return { model, reasoning: { effort }, promptCaching };
}

function getAiCustomInstruction(name: "rewrite" | "chat") {
  const environmentName = `LIBERA_AI_${ENV_NAMES[name]}_CUSTOM_INSTRUCTION`;
  if (typeof process.env[environmentName] === "string") {
    return process.env[environmentName];
  }

  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return "";

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      aiFunctions?: Partial<Record<"rewrite" | "chat", { customInstruction?: unknown }>>;
    };
    const customInstruction = config.aiFunctions?.[name]?.customInstruction;

    return typeof customInstruction === "string" ? customInstruction : "";
  } catch {
    return "";
  }
}

export function getAiChatCustomInstruction() {
  return getAiCustomInstruction("chat");
}

export function getAiRewriteCustomInstruction() {
  return getAiCustomInstruction("rewrite");
}
