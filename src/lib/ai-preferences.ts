import { readFileSync } from "node:fs";
import { getOpenRouterModel } from "./openrouter";
import { getOpenRouterRouting, type OpenRouterProviderPreferences } from "./openrouter-routing";

export type AiFunction = "formatting" | "rewrite" | "write" | "chat" | "review" | "recordingRecap" | "imageToMarkdown" | "latex" | "references";
export type AiReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);
const ENV_NAMES: Record<AiFunction, string> = {
  formatting: "FORMATTING",
  rewrite: "REWRITE",
  write: "WRITE",
  chat: "CHAT",
  review: "REVIEW",
  recordingRecap: "RECORDING_RECAP",
  imageToMarkdown: "IMAGE_TO_MARKDOWN",
  latex: "LATEX",
  references: "REFERENCES",
};
/** Functions split off one they used to share: unset, they keep its settings (see electron/ai-preferences.cjs). */
const PARENTS: Partial<Record<AiFunction, AiFunction>> = { write: "rewrite", review: "chat", recordingRecap: "formatting" };

function normalizeAlternativeModels(value: unknown, defaultModel: string) {
  const entries = Array.isArray(value) ? value : [];
  return Array.from(new Set(entries
    .map((model) => typeof model === "string" ? model.trim() : "")
    .filter((model) => model && model !== defaultModel && model.length <= 200 && !/[\u0000-\u001f\u007f\s]/.test(model))))
    .slice(0, 50);
}

/** A function's model settings and its OpenRouter provider routing, read fresh for each request. */
export function getAiFunctionOptions(name: AiFunction): { model: string; reasoning: { effort: AiReasoningEffort }; promptCaching: boolean; provider: OpenRouterProviderPreferences } {
  return { ...getModelOptions(name), provider: getOpenRouterRouting(name) };
}

function getModelOptions(name: AiFunction): { model: string; reasoning: { effort: AiReasoningEffort }; promptCaching: boolean } {
  const prefix = `LIBERA_AI_${ENV_NAMES[name]}`;
  const parentName = PARENTS[name];
  const parent = parentName ? getModelOptions(parentName) : undefined;
  // References default to the formatting model: both turn text into structured output.
  const model = process.env[`${prefix}_MODEL`]?.trim() || parent?.model || (name === "latex" ? "openai/gpt-5.6-luna" : name === "references" ? getModelOptions("formatting").model : getOpenRouterModel());
  const configuredEffort = process.env[`${prefix}_REASONING_EFFORT`];
  const lowEffort = name === "latex" || name === "references" || name === "recordingRecap";
  const effort: AiReasoningEffort = configuredEffort && EFFORTS.has(configuredEffort) ? configuredEffort as AiReasoningEffort : lowEffort ? "low" : parent?.reasoning.effort ?? "medium";
  const configuredCaching = process.env[`${prefix}_PROMPT_CACHING`];
  const promptCaching = configuredCaching === "true" ? true : configuredCaching === "false" ? false : name === "recordingRecap" ? false : parent?.promptCaching ?? (name === "chat" || name === "rewrite");
  return { model, reasoning: { effort }, promptCaching };
}

export function getAiChatModels() {
  const defaultModel = getModelOptions("chat").model;
  const environmentValue = process.env.LIBERA_AI_CHAT_ALTERNATIVE_MODELS;

  if (typeof environmentValue === "string") {
    try {
      return [defaultModel, ...normalizeAlternativeModels(JSON.parse(environmentValue), defaultModel)];
    } catch {
      return [defaultModel];
    }
  }

  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return [defaultModel];

  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      aiFunctions?: { chat?: { alternativeModels?: unknown } };
    };
    return [defaultModel, ...normalizeAlternativeModels(config.aiFunctions?.chat?.alternativeModels, defaultModel)];
  } catch {
    return [defaultModel];
  }
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
