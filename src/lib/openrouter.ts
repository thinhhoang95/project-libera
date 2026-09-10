import { readSseData } from "./text-stream";

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
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: OpenRouterMessageContent;
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

type CompletionOptions = { model?: string; reasoning?: { effort: "low" | "medium" | "high" | "xhigh" | "max" }; maxTokens?: number; signal?: AbortSignal };

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
      model: options.model ?? getOpenRouterModel(),
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      messages,
      temperature: 0,
      ...(stream ? { stream: true } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(await readOpenRouterError(response));
  }

  return response;
}

export async function createOpenRouterCompletion(messages: OpenRouterMessage[], options: CompletionOptions = {}) {
  const response = await requestOpenRouterCompletion(messages, options);
  const payload = (await response.json()) as OpenRouterResponse;
  if (payload.error) throw new Error(payload.error.message || "OpenRouter request failed.");
  return {
    content: extractMessageContent(payload.choices?.[0]?.message?.content),
    finishReason: payload.choices?.[0]?.finish_reason,
  };
}

export async function createOpenRouterMarkdownCompletion(messages: OpenRouterMessage[], options: Parameters<typeof createOpenRouterCompletion>[1] = {}) {
  return normalizeMarkdownOutput((await createOpenRouterCompletion(messages, options)).content);
}

export async function* streamOpenRouterCompletion(messages: OpenRouterMessage[], options: CompletionOptions = {}) {
  const response = await requestOpenRouterCompletion(messages, options, true);
  if (!response.body) throw new Error("The model returned no response stream.");
  for await (const data of readSseData(response.body, options.signal)) {
    if (data.trim() === "[DONE]") return;
    const payload = JSON.parse(data) as {
      error?: { message?: string };
      choices?: { delta?: { content?: OpenRouterMessageContent }; finish_reason?: string }[];
    };
    if (payload.error) throw new Error(payload.error.message || "The model stream failed.");
    const choice = payload.choices?.[0];
    if (choice?.finish_reason === "error") throw new Error("The model stream failed.");
    const text = extractMessageContent(choice?.delta?.content);
    if (text) yield text;
  }
  throw new Error("The model connection ended before the response was complete.");
}
