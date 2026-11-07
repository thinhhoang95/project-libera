import { readFileSync } from "node:fs";
import { LOCAL_LLM_PRESETS, describeLocalLlmFailure, isLocalModel, localAlias, localErrorDetail, localLlmHeaders, normalizeLocalLlms, readLocalError, type LocalLlmEndpoint } from "../../electron/local-llms.cjs";
import { parseOpenRouterUsage, type TokenUsage } from "./chat-token-usage";
import type { OpenRouterGeneration, OpenRouterMessage } from "./openrouter";
import { readSseData } from "./text-stream";

// Preferences → Local LLMs: OpenAI-compatible servers (Ollama, LM Studio,
// llama-server) under `local/<alias>`. openrouter.ts and agent/model.ts send
// any such model here, so it works wherever an OpenRouter slug does. Every
// request streams, even when the caller wants the whole reply: a slow model
// would otherwise send nothing until it finished, past Node's five-minute
// wait for response headers.

export { isLocalModel };

/** Local servers do not report their window; this keeps the agent's trimming conservative. */
export const LOCAL_CONTEXT_LENGTH = 32_768;

export class LocalLlmError extends Error {
  constructor(message: string, readonly kind: string, readonly retryable = false) { super(message); }
}

/** Read on each request, like routing, so a new alias needs no restart. */
export function getLocalEndpoints(): LocalLlmEndpoint[] {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (configPath) {
    try {
      return normalizeLocalLlms((JSON.parse(readFileSync(configPath, "utf8")) as { aiFunctions?: { localLlms?: unknown } }).aiFunctions?.localLlms);
    } catch { /* Fall back to the environment. */ }
  }
  try { return normalizeLocalLlms(JSON.parse(process.env.LIBERA_AI_LOCAL_LLMS ?? "null")); }
  catch { return []; }
}

function resolveEndpoint(model: string) {
  const alias = localAlias(model).toLowerCase();
  const endpoint = getLocalEndpoints().find((item) => item.alias.toLowerCase() === alias);
  if (!endpoint) throw new LocalLlmError(`${model} is not set up. Add it in Preferences → Local LLMs, or choose another model.`, "config");
  if (!endpoint.model) throw new LocalLlmError(`${model} has no model name. Choose one in Preferences → Local LLMs.`, "config");
  return endpoint;
}

function failure(endpoint: LocalLlmEndpoint, details: Parameters<typeof describeLocalLlmFailure>[1]) {
  const { message, kind, retryable } = describeLocalLlmFailure(endpoint, details);
  return new LocalLlmError(message, kind, retryable);
}

/** An error a server reported inside its stream, after answering 200. */
export function localStreamFailure(model: string, payload: unknown) {
  return failure(resolveEndpoint(model), { status: 500, detail: localErrorDetail(payload) });
}

type LocalMessage = { role: string; content: unknown; reasoning_details?: unknown } & Record<string, unknown>;
type LocalPart = { type?: string; text?: string; cache_control?: unknown };

/** The messages without OpenRouter's extras. Text-only parts become a plain string, which every server takes. */
function localMessages(model: string, messages: readonly unknown[]) {
  return (messages as LocalMessage[]).map((original) => {
    const message = { ...original };
    delete message.reasoning_details;
    if (!Array.isArray(message.content)) return message;
    const parts = (message.content as LocalPart[]).map((part) => {
      const plain = { ...part };
      delete plain.cache_control;
      return plain;
    });
    if (parts.some((part) => part.type === "file")) throw new LocalLlmError(`${model} cannot read PDF files: local servers take text and images only. Choose an OpenRouter model for this.`, "unsupported");
    return { ...message, content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text ?? "").join("\n\n") : parts };
  });
}

/** A dropped connection fails partway through reading, where the fetch's own handling cannot name it. */
function guardedBody(endpoint: LocalLlmEndpoint, body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(signal?.aborted ? error : cutOff(endpoint));
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

function cutOff(endpoint: LocalLlmEndpoint) {
  const preset = LOCAL_LLM_PRESETS[endpoint.preset];
  return new LocalLlmError(`${preset.subject ?? preset.label} stopped before the reply was complete. It may have run out of memory or been shut down; check the server, then try again.`, "cut-off");
}

type LocalRequest = { model: string; messages: readonly unknown[]; tools?: readonly unknown[]; maxTokens?: number; signal?: AbortSignal };

/** Opens a streamed chat completion; the body is OpenAI's SSE format. */
async function openStream(endpoint: LocalLlmEndpoint, request: LocalRequest) {
  const messages = localMessages(request.model, request.messages);
  let response: Response;
  try {
    response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: localLlmHeaders(endpoint),
      signal: request.signal,
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        temperature: 0,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw failure(endpoint, { error });
  }
  if (!response.ok) throw failure(endpoint, { status: response.status, detail: await readLocalError(response) });
  if (!response.body) throw cutOff(endpoint);
  return guardedBody(endpoint, response.body, request.signal);
}

export function openLocalStream(request: LocalRequest) {
  return openStream(resolveEndpoint(request.model), request);
}

/** Leaves out a leading <think>…</think> block, which some models write into the reply itself. */
function thinkingFilter() {
  let state: "start" | "thinking" | "gap" | "text" = "start";
  let held = "";
  return {
    push(text: string) {
      if (state === "text") return text;
      held += text;
      if (state === "start") {
        const start = held.trimStart();
        if (start.length < "<think>".length && "<think>".startsWith(start)) return "";
        if (!start.startsWith("<think>")) { state = "text"; return held; }
        state = "thinking";
      }
      if (state === "thinking") {
        const end = held.indexOf("</think>");
        if (end < 0) return "";
        held = held.slice(end + "</think>".length);
        state = "gap";
      }
      const rest = held.trimStart();
      held = "";
      if (rest) state = "text";
      return rest;
    },
    /** Text still held when the reply ended. A reply cut off while thinking has none. */
    flush: () => state === "start" ? held : "",
  };
}

type LocalCompletionOptions = {
  model: string;
  maxTokens?: number;
  signal?: AbortSignal;
  webSearch?: unknown;
  onUsage?: (usage: TokenUsage, generation: OpenRouterGeneration) => void;
};

type LocalChunk = { usage?: unknown; error?: unknown; choices?: { delta?: { content?: unknown }; finish_reason?: string | null }[] };

type LocalReport = { finishReason?: string; usage?: TokenUsage; generation?: OpenRouterGeneration };

async function* readText(messages: OpenRouterMessage[], options: LocalCompletionOptions, report: LocalReport) {
  if (options.webSearch) throw new LocalLlmError(`${options.model} cannot search the web; that needs an OpenRouter model.`, "unsupported");
  const endpoint = resolveEndpoint(options.model);
  const body = await openStream(endpoint, { model: options.model, messages, maxTokens: options.maxTokens, signal: options.signal });
  const generation = { provider: LOCAL_LLM_PRESETS[endpoint.preset].label };
  report.generation = generation;
  const filter = thinkingFilter();
  let done = false;
  for await (const data of readSseData(body, options.signal)) {
    if (data.trim() === "[DONE]") { done = true; break; }
    let payload: LocalChunk;
    try { payload = JSON.parse(data); }
    catch { continue; }
    if (payload.error) throw failure(endpoint, { status: 500, detail: localErrorDetail(payload) });
    const usage = parseOpenRouterUsage(payload.usage);
    if (usage) {
      report.usage = usage;
      options.onUsage?.(usage, generation);
    }
    const choice = payload.choices?.[0];
    if (choice?.finish_reason) report.finishReason = choice.finish_reason;
    const text = typeof choice?.delta?.content === "string" ? filter.push(choice.delta.content) : "";
    if (text) yield text;
  }
  if (!done && !report.finishReason) throw cutOff(endpoint);
  const rest = filter.flush();
  if (rest) yield rest;
}

export async function* streamLocalCompletion(messages: OpenRouterMessage[], options: LocalCompletionOptions) {
  yield* readText(messages, options, {});
}

export async function createLocalCompletion(messages: OpenRouterMessage[], options: LocalCompletionOptions) {
  const report: LocalReport = {};
  let content = "";
  for await (const text of readText(messages, options, report)) content += text;
  return { content, finishReason: report.finishReason, usage: report.usage, generation: report.generation };
}
