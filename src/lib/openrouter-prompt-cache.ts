import type { OpenRouterMessage } from "./openrouter";

type Endpoint = {
  tag?: string;
  supports_implicit_caching?: boolean;
  supported_parameters?: string[];
  pricing?: { input_cache_read?: string | number | null; input_cache_write?: string | number | null };
};
type CacheRouting = { provider: { only: string[] }; breakpoints: "none" | "rolling" | "gemini" };
const routes = new Map<string, { expires: number; routing: CacheRouting }>();

function hasPrice(price: string | number | null | undefined) {
  return price !== undefined && price !== null && String(price).trim() !== "" &&
    Number.isFinite(Number(price)) && Number(price) >= 0;
}

function supportsCaching(endpoint: Endpoint) {
  // A read price alone is not proof: some endpoints advertise discounted
  // reads but explicitly report no implicit caching. Explicit providers
  // advertise cache writes as well (e.g. Claude), or cache_control support.
  return endpoint.supports_implicit_caching === true ||
    endpoint.supported_parameters?.includes("cache_control") === true ||
    (hasPrice(endpoint.pricing?.input_cache_read) && hasPrice(endpoint.pricing?.input_cache_write));
}

// Endpoint tags and cache capabilities come from OpenRouter, never from a
// hard-coded model/provider list. Failure must not allow uncached fallback.
export async function getPromptCacheRouting(model: string, apiKey: string, signal?: AbortSignal): Promise<CacheRouting> {
  signal?.throwIfAborted();
  const cached = routes.get(model);
  if (cached && cached.expires > Date.now()) return cached.routing;
  routes.delete(model);
  const modelPath = model.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://openrouter.ai/api/v1/models/${modelPath}/endpoints`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Cannot verify prompt caching providers for ${model}. Try again or disable prompt caching in Preferences.`);
  const payload = await response.json() as { data?: { endpoints?: Endpoint[] } };
  const endpoints = payload.data?.endpoints;
  const eligible = Array.isArray(endpoints) ? endpoints.filter((endpoint) => {
    if (!endpoint.tag || !supportsCaching(endpoint)) return false;
    // A root tag also matches its region/turbo variants. Exclude it if any
    // matching endpoint lacks caching, including duplicate tags.
    return endpoints.every((other) => !(other.tag === endpoint.tag || other.tag?.startsWith(`${endpoint.tag}/`)) || supportsCaching(other));
  }) : [];
  if (!eligible.length) throw new Error(`No verified prompt caching providers are available for ${model}. Disable prompt caching in Preferences to use unrestricted routing.`);
  // OpenRouter accepts explicit Gemini breakpoints even though Gemini
  // endpoints advertise implicit caching rather than cache_control.
  const geminiExplicit = /^google\/gemini-/.test(model) && eligible.every((endpoint) => hasPrice(endpoint.pricing?.input_cache_write));
  const breakpoints: CacheRouting["breakpoints"] = geminiExplicit ? "gemini"
    : eligible.some((endpoint) => endpoint.supports_implicit_caching !== true) ? "rolling" : "none";
  const routing: CacheRouting = {
    provider: { only: [...new Set(eligible.map((endpoint) => endpoint.tag!))] },
    breakpoints,
  };
  if (routes.size >= 100) routes.clear();
  routes.set(model, { expires: Date.now() + 5 * 60_000, routing });
  return routing;
}

export function withPromptCacheBreakpoints(messages: OpenRouterMessage[]): OpenRouterMessage[] {
  // Cache the stable instructions and advancing conversation prefix, staying
  // below Anthropic's four-breakpoint limit. Preserve images and caller data.
  const indices = new Set([messages.findIndex((message) => message.role === "system"), messages.length - 2, messages.length - 1]);
  return messages.map((message, index) => {
    if (!indices.has(index)) return message;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    const lastText = content.findLastIndex((part) => part.type === "text" && part.text.length > 0);
    if (lastText < 0) return message;
    return { ...message, content: content.map((part, i) => i === lastText ? { ...part, cache_control: { type: "ephemeral" as const } } : part) };
  });
}

export function withGeminiPromptCacheBreakpoint(messages: OpenRouterMessage[]): OpenRouterMessage[] {
  // Keep the breakpoint on the first user message so a growing chat can read
  // the same cached prefix on every follow-up. Gemini uses the last marker.
  const firstUser = messages.findIndex((message) => message.role === "user");
  return messages.map((message, index) => {
    if (index !== firstUser) return message;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    const lastText = content.findLastIndex((part) => part.type === "text" && part.text.length > 0);
    if (lastText < 0) return message;
    return { ...message, content: content.map((part, i) => i === lastText ? { ...part, cache_control: { type: "ephemeral" as const } } : part) };
  });
}
