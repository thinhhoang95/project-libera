import { getOpenRouterApiKey } from "@/lib/openrouter";
import { getOpenRouterRouting } from "@/lib/openrouter-routing";
import { getPromptCacheRouting, withGeminiPromptCacheBreakpoint } from "@/lib/openrouter-prompt-cache";
import { parseOpenRouterUsage, type TokenUsage } from "@/lib/chat-token-usage";
import { recordOpenRouterUsage } from "@/lib/storage/usage-ledger";
import { readSseData } from "@/lib/text-stream";

// OpenAI-compatible chat completions with tool calls, streamed from
// OpenRouter. One message format for every model; provider differences
// (caching markers, reasoning passthrough) are handled here.

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export type ContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image_url"; image_url: { url: string } };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type AgentMessage =
  | { role: "system"; content: string | ContentPart[] }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string | ContentPart[] };

export type ToolSchema = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ModelReply = {
  message: Extract<AgentMessage, { role: "assistant" }>;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: TokenUsage;
};

export type ModelEndpoint = { tag: string; parameters: string[] };

export type ModelProfile = {
  /** Largest context window among the model's endpoints. */
  contextLength: number;
  supportsTools: boolean;
  /** False when OpenRouter could not be asked; parameters are then sent unchecked. */
  known: boolean;
  /** Each provider endpoint and the request parameters it accepts. */
  endpoints?: ModelEndpoint[];
};

const DEFAULT_CONTEXT_LENGTH = 128_000;
const profiles = new Map<string, { expires: number; profile: ModelProfile }>();

type Endpoint = { tag?: unknown; context_length?: unknown; supported_parameters?: unknown };

/** Capabilities from OpenRouter's endpoint list; never from a hard-coded model list. */
export async function getModelProfile(model: string, signal?: AbortSignal): Promise<ModelProfile> {
  const cached = profiles.get(model);
  if (cached && cached.expires > Date.now()) return cached.profile;
  const apiKey = getOpenRouterApiKey();
  const unknown: ModelProfile = { contextLength: DEFAULT_CONTEXT_LENGTH, supportsTools: true, known: false };
  try {
    const modelPath = model.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`https://openrouter.ai/api/v1/models/${modelPath}/endpoints`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (!response.ok) return unknown;
    const payload = await response.json() as { data?: { context_length?: unknown; endpoints?: Endpoint[] } };
    const endpoints = Array.isArray(payload.data?.endpoints) ? payload.data.endpoints : [];
    if (!endpoints.length) return unknown;
    const parameters = (endpoint: Endpoint) => Array.isArray(endpoint.supported_parameters) ? endpoint.supported_parameters as string[] : [];
    const lengths = [payload.data?.context_length, ...endpoints.map((endpoint) => endpoint.context_length)]
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    const profile: ModelProfile = {
      contextLength: lengths.length ? Math.max(...lengths) : DEFAULT_CONTEXT_LENGTH,
      supportsTools: endpoints.some((endpoint) => parameters(endpoint).includes("tools")),
      known: true,
      endpoints: endpoints.map((endpoint) => ({ tag: typeof endpoint.tag === "string" ? endpoint.tag : "", parameters: parameters(endpoint) })),
    };
    if (profiles.size >= 100) profiles.clear();
    profiles.set(model, { expires: Date.now() + 10 * 60_000, profile });
    return profile;
  } catch (error) {
    if (signal?.aborted) throw error;
    return unknown;
  }
}

function withCacheMarker(message: AgentMessage): AgentMessage {
  if (message.role === "assistant") return message;
  const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  const last = content.findLastIndex((part) => part.type === "text" && part.text.length > 0);
  if (last < 0) return message;
  return { ...message, content: content.map((part, index) => index === last ? { ...part, cache_control: { type: "ephemeral" as const } } : part) } as AgentMessage;
}

/**
 * Explicit-cache providers (Claude) get markers on the system prompt and on the
 * two latest user or tool messages, so each loop iteration reads the whole
 * previous prefix from cache. That stays under Anthropic's four-marker limit.
 */
export function withAgentCacheBreakpoints(messages: AgentMessage[]): AgentMessage[] {
  const marked = new Set<number>([messages.findIndex((message) => message.role === "system")]);
  for (let index = messages.length - 1; index >= 0 && marked.size < 3; index--) {
    if (messages[index].role === "user" || messages[index].role === "tool") marked.add(index);
  }
  return messages.map((message, index) => marked.has(index) ? withCacheMarker(message) : message);
}

type ReasoningDetail = Record<string, unknown> & { index?: number; type?: string };

/** Streamed reasoning details arrive in fragments keyed by index; join them back into whole blocks. */
function mergeReasoningDetails(target: ReasoningDetail[], fragments: unknown) {
  if (!Array.isArray(fragments)) return;
  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== "object") continue;
    const detail = fragment as ReasoningDetail;
    const existing = typeof detail.index === "number"
      ? target.find((item) => item.index === detail.index && item.type === detail.type)
      : undefined;
    if (!existing) { target.push({ ...detail }); continue; }
    for (const [key, value] of Object.entries(detail)) {
      if ((key === "text" || key === "summary" || key === "data") && typeof value === "string" && typeof existing[key] === "string") existing[key] = existing[key] + value;
      else if (value !== undefined && value !== null) existing[key] = value;
    }
  }
}

class ModelRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

async function readError(response: Response) {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  const message = payload?.error?.message || response.statusText || "OpenRouter request failed.";
  if (response.status === 401) return `OpenRouter rejected the API key (${message}). Check the key in Preferences.`;
  if (response.status === 402) return `OpenRouter reports insufficient credits (${message}).`;
  return message;
}

function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, milliseconds);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * With require_parameters, every optional parameter sent must be accepted by
 * the provider that serves the request, or no provider is eligible. Many tool
 * models refuse temperature, so it is sent only when every eligible provider
 * accepts it; reasoning when at least one does, since the user chose an effort.
 */
export function optionalParameters(model: string, profile: ModelProfile, cachingProviders?: string[]) {
  if (!profile.known || !profile.endpoints?.length) return { reasoning: true, temperature: true };
  const eligible = profile.endpoints.filter((endpoint) => endpoint.parameters.includes("tools") &&
    (!cachingProviders || cachingProviders.some((tag) => endpoint.tag === tag || endpoint.tag.startsWith(`${tag}/`))));
  if (!eligible.length) {
    throw new ModelRequestError(`None of the prompt-caching providers for ${model} can call tools. Choose another model, or turn off prompt caching for chat in Preferences.`, false);
  }
  return {
    reasoning: eligible.some((endpoint) => endpoint.parameters.includes("reasoning")),
    temperature: eligible.every((endpoint) => endpoint.parameters.includes("temperature")),
  };
}

export type CallModelOptions = {
  model: string;
  messages: AgentMessage[];
  tools: ToolSchema[];
  profile: ModelProfile;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  promptCaching?: boolean;
  sessionId?: string;
  signal: AbortSignal;
  onTextDelta?: (text: string) => void;
};

async function openStream(options: CallModelOptions) {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) throw new ModelRequestError("Configure an OpenRouter API key in Preferences to use Agent mode.", false);
  const caching = options.promptCaching ? await getPromptCacheRouting(options.model, apiKey, options.signal) : undefined;
  const messages = caching?.breakpoints === "gemini"
    ? withGeminiPromptCacheBreakpoint(options.messages as Parameters<typeof withGeminiPromptCacheBreakpoint>[0]) as AgentMessage[]
    : caching?.breakpoints === "rolling" ? withAgentCacheBreakpoints(options.messages) : options.messages;
  const { reasoning, temperature } = optionalParameters(options.model, options.profile, caching?.provider.only);
  const provider = {
    // The agent runs on AI Chat's settings, routing included.
    ...getOpenRouterRouting("chat"),
    ...(caching ? caching.provider : {}),
    // Only route to providers that honor every parameter, tools included;
    // otherwise a request can land where tools are silently ignored.
    ...(options.profile.known ? { require_parameters: true } : {}),
  };
  let response: Response;
  try {
    response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_NAME ?? "Libera",
      },
      signal: options.signal,
      body: JSON.stringify({
        model: options.model,
        ...(options.sessionId ? { session_id: options.sessionId } : {}),
        ...(Object.keys(provider).length ? { provider } : {}),
        ...(reasoning && options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
        messages,
        tools: options.tools,
        ...(temperature ? { temperature: 0 } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new ModelRequestError(error instanceof Error ? error.message : "Could not reach OpenRouter.", true);
  }
  if (!response.ok) {
    throw new ModelRequestError(await readError(response), response.status === 408 || response.status === 429 || response.status >= 500);
  }
  if (!response.body) throw new ModelRequestError("The model returned no response stream.", true);
  return response.body;
}

/** One model turn. Retries rate limits, server errors and empty replies before any text is shown. */
export async function callModel(options: CallModelOptions): Promise<ModelReply> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await sleep(Math.min(8_000, 1_000 * 2 ** (attempt - 1)) + Math.random() * 400, options.signal);
    let streamedText = false;
    try {
      const reply = await readReply(await openStream(options), options, () => { streamedText = true; });
      const empty = !reply.message.content.trim() && !reply.toolCalls.length;
      if (empty && reply.finishReason !== "length" && attempt < 1) { lastError = new ModelRequestError("The model returned an empty response.", true); continue; }
      if (empty && reply.finishReason !== "length") throw new ModelRequestError("The model returned an empty response. Try again or choose another model.", false);
      return reply;
    } catch (error) {
      if (options.signal.aborted) throw error;
      // Text already shown cannot be withdrawn; a retry would duplicate it.
      if (!(error instanceof ModelRequestError) || !error.retryable || streamedText) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The model request failed.");
}

async function readReply(body: ReadableStream<Uint8Array>, options: CallModelOptions, onText: () => void): Promise<ModelReply> {
  let content = "";
  let finishReason = "";
  let usage: TokenUsage | undefined;
  let done = false;
  const reasoningDetails: ReasoningDetail[] = [];
  const calls: { id: string; name: string; arguments: string }[] = [];
  for await (const data of readSseData(body, options.signal)) {
    if (data.trim() === "[DONE]") { done = true; break; }
    let payload: {
      provider?: string;
      usage?: unknown;
      error?: { message?: string; code?: number };
      choices?: { delta?: { content?: unknown; reasoning_details?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
    };
    try { payload = JSON.parse(data); }
    catch { continue; }
    if (payload.error) throw new ModelRequestError(payload.error.message || "The model stream failed.", !content && (payload.error.code === undefined || payload.error.code === 429 || payload.error.code >= 500));
    const reported = parseOpenRouterUsage(payload.usage);
    if (reported) {
      usage = reported;
      recordOpenRouterUsage(options.model, payload.usage, typeof payload.provider === "string" ? payload.provider : undefined);
    }
    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (typeof delta?.content === "string" && delta.content) {
      content += delta.content;
      onText();
      options.onTextDelta?.(delta.content);
    }
    mergeReasoningDetails(reasoningDetails, delta?.reasoning_details);
    for (const fragment of delta?.tool_calls ?? []) {
      const index = typeof fragment.index === "number" ? fragment.index : calls.length;
      calls[index] ??= { id: "", name: "", arguments: "" };
      if (fragment.id) calls[index].id = fragment.id;
      if (fragment.function?.name) calls[index].name += fragment.function.name;
      if (fragment.function?.arguments) calls[index].arguments += fragment.function.arguments;
    }
    if (choice.finish_reason === "error") throw new ModelRequestError("The model stream failed.", !content);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (!done && !finishReason) throw new ModelRequestError("The model connection ended before the response was complete.", !content);
  const toolCalls: ToolCall[] = calls.filter(Boolean).filter((call) => call.name).map((call, index) => ({
    id: call.id || `call_${Date.now().toString(36)}_${index}`,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
  return {
    message: {
      role: "assistant",
      content,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
    },
    toolCalls,
    finishReason: finishReason || (toolCalls.length ? "tool_calls" : "stop"),
    usage,
  };
}
