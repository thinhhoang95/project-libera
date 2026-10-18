import { readSseData } from "./text-stream";
import { parseOpenRouterUsage, type TokenUsage } from "./chat-token-usage";
import { getPromptCacheRouting, withGeminiPromptCacheBreakpoint, withPromptCacheBreakpoints } from "./openrouter-prompt-cache";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.5-flash";

const OPENROUTER_API_KEY_ENV_NAMES = [
  "OPENROUTER_API_KEY",
  "OPEN_ROUTER_API_KEY",
  "OPENROUTER_KEY",
];
const OPENROUTER_KEY_PREFIX = "sk-or-";

type OpenRouterContentPart =
  | {
      type: "text";
      text: string;
      cache_control?: { type: "ephemeral" };
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string | OpenRouterContentPart[];
};

type OpenRouterMessageContent =
  | string
  | Array<
      | string
      | {
          type?: string;
          text?: string;
        }
    >;

type OpenRouterResponse = {
  id?: string;
  provider?: string;
  usage?: unknown;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: OpenRouterMessageContent;
      annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string; content?: string } }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

export function getOpenRouterApiKey() {
  for (const envName of OPENROUTER_API_KEY_ENV_NAMES) {
    const value = process.env[envName];

    if (value) {
      return value;
    }
  }

  const openAiCompatibleKey = process.env.OPENAI_API_KEY;

  if (openAiCompatibleKey?.startsWith(OPENROUTER_KEY_PREFIX)) {
    return openAiCompatibleKey;
  }

  return "";
}

export function getOpenRouterModel() {
  return process.env.LIBERA_OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
}

function extractMessageContent(content: OpenRouterMessageContent | undefined) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      return part.text ?? "";
    })
    .join("");
}

export function normalizeMarkdownOutput(content: string) {
  const fencedMatch = content.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fencedMatch?.[1] ?? content;
}

async function readOpenRouterError(response: Response) {
  const payload = (await response.json().catch(() => null)) as OpenRouterResponse | null;

  if (payload?.error?.message) {
    return payload.error.message;
  }

  return response.statusText || "OpenRouter request failed.";
}

/** A web page the model consulted through OpenRouter's web plugin. */
export type WebCitation = { url: string; title?: string; content?: string };

/** Which OpenRouter generation served a request, and the provider OpenRouter routed it to. */
export type OpenRouterGeneration = { id?: string; provider?: string };

type CompletionOptions = {
  model?: string; promptCaching?: boolean; sessionId?: string; reasoning?: { effort: "low" | "medium" | "high" | "xhigh" | "max" }; maxTokens?: number; signal?: AbortSignal; onUsage?: (usage: TokenUsage, generation: OpenRouterGeneration) => void;
  /** Let the model search the web through OpenRouter's web plugin. Results come back as `webCitations`. */
  webSearch?: { maxResults?: number };
};

async function requestOpenRouterCompletion(
  messages: OpenRouterMessage[], options: CompletionOptions, stream = false,
) {
  const apiKey = getOpenRouterApiKey();

  if (!apiKey) {
    throw new Error(
      `Configure one of: ${OPENROUTER_API_KEY_ENV_NAMES.join(
        ", ",
      )}, or set OPENAI_API_KEY to an OpenRouter key.`,
    );
  }

  const model = options.model ?? getOpenRouterModel();
  const caching = options.promptCaching ? await getPromptCacheRouting(model, apiKey, options.signal) : undefined;
  const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Libera",
    },
    signal: options.signal,
    body: JSON.stringify({
      model,
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(caching ? { provider: caching.provider } : {}),
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.webSearch ? { plugins: [{ id: "web", ...(options.webSearch.maxResults ? { max_results: options.webSearch.maxResults } : {}) }] } : {}),
      messages: caching?.breakpoints === "gemini" ? withGeminiPromptCacheBreakpoint(messages)
        : caching?.breakpoints === "rolling" ? withPromptCacheBreakpoints(messages) : messages,
      temperature: 0,
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(await readOpenRouterError(response));
  }

  return response;
}

export async function createOpenRouterCompletion(messages: OpenRouterMessage[], options: CompletionOptions = {}): Promise<{ content: string; finishReason?: string; usage?: TokenUsage; webCitations?: WebCitation[]; generation?: OpenRouterGeneration }> {
  const response = await requestOpenRouterCompletion(messages, options);
  const payload = (await response.json()) as OpenRouterResponse;
  if (payload.error) throw new Error(payload.error.message || "OpenRouter request failed.");
  const message = payload.choices?.[0]?.message;
  const webCitations = (message?.annotations ?? []).flatMap((annotation) => {
    const citation = annotation.type === "url_citation" ? annotation.url_citation : undefined;
    return citation?.url ? [{ url: citation.url, ...(citation.title ? { title: citation.title } : {}), ...(citation.content ? { content: citation.content } : {}) }] : [];
  });
  return {
    content: extractMessageContent(message?.content),
    finishReason: payload.choices?.[0]?.finish_reason,
    usage: parseOpenRouterUsage(payload.usage),
    ...(webCitations.length ? { webCitations } : {}),
    generation: { id: payload.id, provider: payload.provider },
  };
}

export async function createOpenRouterMarkdownCompletion(messages: OpenRouterMessage[], options: Parameters<typeof createOpenRouterCompletion>[1] = {}) {
  return normalizeMarkdownOutput((await createOpenRouterCompletion(messages, options)).content);
}

export async function* streamOpenRouterCompletion(messages: OpenRouterMessage[], options: CompletionOptions = {}) {
  const response = await requestOpenRouterCompletion(messages, options, true);
  if (!response.body) throw new Error("The model returned no response stream.");
  const generation: OpenRouterGeneration = {};
  for await (const data of readSseData(response.body, options.signal)) {
    if (data.trim() === "[DONE]") return;
    const payload = JSON.parse(data) as {
      id?: string;
      provider?: string;
      usage?: unknown;
      error?: { message?: string };
      choices?: { delta?: { content?: OpenRouterMessageContent }; finish_reason?: string }[];
    };
    if (payload.error) throw new Error(payload.error.message || "The model stream failed.");
    if (typeof payload.id === "string") generation.id ??= payload.id;
    if (typeof payload.provider === "string") generation.provider ??= payload.provider;
    const usage = parseOpenRouterUsage(payload.usage);
    if (usage) options.onUsage?.(usage, { ...generation });
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === "error") throw new Error("The model stream failed.");
    const text = extractMessageContent(choice?.delta?.content);
    if (text) yield text;
  }
  throw new Error("The model connection ended before the response was complete.");
}
