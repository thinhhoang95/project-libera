export type TokenUsage = { inputTokens: number; outputTokens: number; cachedTokens?: number };
export type ChatUsageRequest = { id: string; messageId: string; usage?: TokenUsage };

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as TokenUsage;
  return isTokenCount(usage.inputTokens) && isTokenCount(usage.outputTokens) &&
    (usage.cachedTokens === undefined || isTokenCount(usage.cachedTokens));
}

export function parseOpenRouterUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null };
  if (!isTokenCount(raw.prompt_tokens) || !isTokenCount(raw.completion_tokens)) return undefined;
  const cached = raw.prompt_tokens_details?.cached_tokens;
  return { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens,
    ...(isTokenCount(cached) ? { cachedTokens: cached } : {}) };
}

export function validateUsageRequests(value: unknown): value is ChatUsageRequest[] {
  return Array.isArray(value) && value.every((item) => item && typeof item.id === "string" &&
    typeof item.messageId === "string" && (item.usage === undefined || isTokenUsage(item.usage))) &&
    new Set(value.map((item) => item.id)).size === value.length;
}

// Legacy replies have unknown usage; never infer API token counts from text.
export function chatUsageRequests(chat: { usageRequests?: ChatUsageRequest[]; messages: { id: string; role: string }[] }): ChatUsageRequest[] {
  return chat.usageRequests ?? chat.messages.flatMap((message, index) => message.role === "assistant"
    ? [{ id: message.id, messageId: chat.messages[index - 1]?.id ?? message.id }] : []);
}

export function totalChatUsage(requests: ChatUsageRequest[]) {
  return requests.reduce((total, request) => {
    if (request.usage) {
      total.inputTokens += request.usage.inputTokens;
      total.outputTokens += request.usage.outputTokens;
      total.reported++;
      if (request.usage.cachedTokens !== undefined) {
        total.cachedTokens += request.usage.cachedTokens;
        total.cacheReported++;
      }
    }
    return total;
  }, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reported: 0, cacheReported: 0 });
}
