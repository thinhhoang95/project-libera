const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODEL = "google/gemini-3.5-flash";

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
  role: "system" | "user";
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

export async function createOpenRouterMarkdownCompletion(messages: OpenRouterMessage[]) {
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
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(await readOpenRouterError(response));
  }

  const payload = (await response.json()) as OpenRouterResponse;
  return normalizeMarkdownOutput(
    extractMessageContent(payload.choices?.[0]?.message?.content),
  );
}
