import { readFileSync } from "node:fs";
import { normalizeAiPreferences, normalizeModelPool, type DefinitionsPreferences, type NormalizedAiPreferences } from "../../electron/ai-preferences.cjs";
import { isLocalModel } from "./local-llm";
import { getOpenRouterModel } from "./openrouter";
import { getOpenRouterRouting, type OpenRouterProviderPreferences } from "./openrouter-routing";

export type AiFunction = "formatting" | "rewrite" | "write" | "chat" | "review" | "recordingRecap" | "imageToMarkdown" | "latex" | "references";
export type AiReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** The editor actions whose model and effort can be changed from their context menu. */
export type AiTask = "formatting" | "rewrite" | "write";
/** Everything that can carry a custom system prompt (Preferences → AI). */
export type AiPromptFunction = AiFunction | "definitions" | "whereWasI" | "pdfToMarkdown";

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
const PROMPT_ENV_NAMES: Record<AiPromptFunction, string> = { ...ENV_NAMES, definitions: "DEFINITIONS", whereWasI: "WHERE_WAS_I", pdfToMarkdown: "PDF_TO_MARKDOWN" };
/** Functions split off one they used to share: unset, they keep its settings (see electron/ai-preferences.cjs). */
const PARENTS: Partial<Record<AiFunction, AiFunction>> = { write: "rewrite", review: "chat", recordingRecap: "formatting" };

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
  return { model, reasoning: { effort }, promptCaching: promptCaching && !isLocalModel(model) };
}

/** The raw and normalized AI settings in the config file, which the server reads on each request. */
function readAiConfig(): { raw: Record<string, { customInstruction?: unknown } | undefined>; normalized: NormalizedAiPreferences } | null {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (!configPath) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { aiFunctions?: Record<string, { customInstruction?: unknown } | undefined>; openRouterModel?: unknown };
    const fallback = typeof config.openRouterModel === "string" && config.openRouterModel.trim() ? config.openRouterModel.trim() : undefined;
    return { raw: config.aiFunctions ?? {}, normalized: normalizeAiPreferences(config.aiFunctions, fallback) };
  } catch {
    return null;
  }
}

/** Preferences → AI → Model Pool: the models the pool's functions can use. */
export function getAiModelPool(): string[] {
  const configured = readAiConfig();
  if (configured) return configured.normalized.modelPool;
  try { return normalizeModelPool(JSON.parse(process.env.LIBERA_AI_MODEL_POOL ?? "[]")); }
  catch { return []; }
}

export function getAiChatModels() {
  const defaultModel = getModelOptions("chat").model;
  return [defaultModel, ...getAiModelPool().filter((model) => model !== defaultModel)];
}

/** A request named a model or effort it may not use. */
export class AiTaskChoiceError extends Error {}

/** A task's settings with the model and effort its context menu chose, which must come from the pool. */
export function getAiTaskOptions(name: AiTask, choice: { model?: unknown; reasoningEffort?: unknown }) {
  const options = getAiFunctionOptions(name);
  const model = choice.model === undefined ? options.model : choice.model;
  if (typeof model !== "string" || (model !== options.model && !getAiModelPool().includes(model))) {
    throw new AiTaskChoiceError(`${String(model)} is no longer in the Model Pool. Choose another model.`);
  }
  if (choice.reasoningEffort !== undefined && !EFFORTS.has(String(choice.reasoningEffort))) throw new AiTaskChoiceError("Invalid reasoning effort.");
  return {
    ...options,
    model,
    reasoning: { effort: (choice.reasoningEffort ?? options.reasoning.effort) as AiReasoningEffort },
    promptCaching: options.promptCaching && !isLocalModel(model),
  };
}

/** What an editor's context menu offers: the pool, and each task's default. */
export function getAiModelChoices() {
  const tasks = Object.fromEntries((["formatting", "rewrite", "write"] as const).map((name) => {
    const { model, reasoning } = getModelOptions(name);
    return [name, { model, reasoningEffort: reasoning.effort }];
  })) as Record<AiTask, { model: string; reasoningEffort: AiReasoningEffort }>;
  return { pool: Array.from(new Set([...getAiModelPool(), ...Object.values(tasks).map((task) => task.model)])), tasks };
}

/**
 * Preferences → AI → Generate Definitions: what the Agent starts with when
 * the Definitions tab asks for cards. Empty values use the AI panel's.
 */
export function getDefinitionsOptions(): Pick<DefinitionsPreferences, "model" | "reasoningEffort"> {
  const configured = readAiConfig()?.normalized.definitions;
  if (configured) return { model: configured.model, reasoningEffort: configured.reasoningEffort };
  const effort = process.env.LIBERA_AI_DEFINITIONS_REASONING_EFFORT ?? "";
  return { model: process.env.LIBERA_AI_DEFINITIONS_MODEL?.trim() ?? "", reasoningEffort: EFFORTS.has(effort) ? effort as AiReasoningEffort : "" };
}

function readCustomInstruction(name: AiPromptFunction) {
  const environmentValue = process.env[`LIBERA_AI_${PROMPT_ENV_NAMES[name]}_CUSTOM_INSTRUCTION`];
  if (typeof environmentValue === "string") return environmentValue;
  const value = readAiConfig()?.raw[name]?.customInstruction;
  return typeof value === "string" ? value : "";
}

/** A function's custom system prompt. Write with AI without one of its own uses AI Rewrite's. */
export function getAiCustomInstruction(name: AiPromptFunction) {
  const own = readCustomInstruction(name);
  return name === "write" && !own.trim() ? readCustomInstruction("rewrite") : own;
}

/** A built-in system prompt with the function's custom one after it. */
export function withAiCustomInstruction(system: string, name: AiPromptFunction) {
  const custom = getAiCustomInstruction(name).trim();
  return custom ? `${system}\n\nUser-configured custom instructions:\n${custom}` : system;
}
