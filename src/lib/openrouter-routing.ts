import { readFileSync } from "node:fs";

// Preferences → AI → Routing: how OpenRouter picks a provider for each AI
// function (OpenRouter's `provider` request object). Read from the desktop
// config file on each request, like Where Was I, so a change applies without
// a restart; the environment Electron passes to the server is the fallback.

export const ROUTING_FUNCTIONS = [
  "formatting", "imageToMarkdown", "pdfToMarkdown", "rewrite", "write", "chat", "review", "latex", "recordingRecap", "references", "whereWasI",
] as const;
export type RoutingFunction = (typeof ROUTING_FUNCTIONS)[number];
export type RoutingSort = "default" | "price" | "throughput" | "latency";

export type RoutingPreferences = {
  /** "default" leaves OpenRouter's own load balancing (price-weighted, avoiding outages). */
  sort: RoutingSort;
  /** USD per million tokens; providers above either ceiling are not used. */
  maxPromptPrice?: number;
  maxCompletionPrice?: number;
  /** Tokens per second; providers below are tried last, not excluded. */
  minThroughput?: number;
  /** Seconds to the first token; providers above are tried last, not excluded. */
  maxLatency?: number;
  allowFallbacks: boolean;
  dataCollection: "allow" | "deny";
  zdr: boolean;
  /** Provider slugs never to use, e.g. "deepinfra". */
  ignore: string[];
};

export type OpenRouterProviderPreferences = {
  sort?: "price" | "throughput" | "latency";
  max_price?: { prompt?: number; completion?: number };
  preferred_min_throughput?: number;
  preferred_max_latency?: number;
  allow_fallbacks?: false;
  data_collection?: "deny";
  zdr?: true;
  ignore?: string[];
};

/** Cheapest first: what Libera did before routing was configurable. */
export const DEFAULT_ROUTING: RoutingPreferences = { sort: "price", allowFallbacks: true, dataCollection: "allow", zdr: false, ignore: [] };
const SORTS = new Set<string>(["default", "price", "throughput", "latency"]);
const PROVIDER_SLUG = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;

function positive(value: unknown, max: number) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 && number <= max ? number : undefined;
}

export function normalizeRouting(input: unknown): RoutingPreferences {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const optional = (key: keyof RoutingPreferences, number: number | undefined) => number === undefined ? {} : { [key]: number };
  return {
    sort: typeof value.sort === "string" && SORTS.has(value.sort) ? value.sort as RoutingSort : DEFAULT_ROUTING.sort,
    ...optional("maxPromptPrice", positive(value.maxPromptPrice, 10_000)),
    ...optional("maxCompletionPrice", positive(value.maxCompletionPrice, 10_000)),
    ...optional("minThroughput", positive(value.minThroughput, 100_000)),
    ...optional("maxLatency", positive(value.maxLatency, 600)),
    allowFallbacks: typeof value.allowFallbacks === "boolean" ? value.allowFallbacks : true,
    dataCollection: value.dataCollection === "deny" ? "deny" : "allow",
    zdr: value.zdr === true,
    ignore: Array.isArray(value.ignore)
      ? [...new Set(value.ignore.filter((slug): slug is string => typeof slug === "string").map((slug) => slug.trim().toLowerCase()).filter((slug) => PROVIDER_SLUG.test(slug)))].slice(0, 50)
      : [],
  };
}

function storedRouting(): Record<string, unknown> | undefined {
  const configPath = process.env.LIBERA_CONFIG_PATH;
  if (configPath) {
    try {
      const stored = (JSON.parse(readFileSync(configPath, "utf8")) as { aiFunctions?: { routing?: unknown } }).aiFunctions?.routing;
      if (stored && typeof stored === "object") return stored as Record<string, unknown>;
    } catch { /* Fall back to the environment. */ }
  }
  try {
    const environment = JSON.parse(process.env.LIBERA_AI_ROUTING ?? "null") as unknown;
    return environment && typeof environment === "object" ? environment as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function getRoutingPreferences(name: RoutingFunction): RoutingPreferences {
  return normalizeRouting(storedRouting()?.[name]);
}

/** Global price ceilings from the environment, used when a function sets none of its own. */
function environmentCeilings() {
  const ceiling = (name: string) => positive(process.env[name], 10_000);
  return { prompt: ceiling("LIBERA_OPENROUTER_MAX_PROMPT_PRICE"), completion: ceiling("LIBERA_OPENROUTER_MAX_COMPLETION_PRICE") };
}

export function toOpenRouterProvider(routing: RoutingPreferences): OpenRouterProviderPreferences {
  const ceilings = routing.maxPromptPrice || routing.maxCompletionPrice
    ? { prompt: routing.maxPromptPrice, completion: routing.maxCompletionPrice }
    : environmentCeilings();
  const maxPrice = { ...(ceilings.prompt ? { prompt: ceilings.prompt } : {}), ...(ceilings.completion ? { completion: ceilings.completion } : {}) };
  return {
    ...(routing.sort !== "default" ? { sort: routing.sort } : {}),
    ...(Object.keys(maxPrice).length ? { max_price: maxPrice } : {}),
    ...(routing.minThroughput ? { preferred_min_throughput: routing.minThroughput } : {}),
    ...(routing.maxLatency ? { preferred_max_latency: routing.maxLatency } : {}),
    ...(routing.allowFallbacks ? {} : { allow_fallbacks: false as const }),
    ...(routing.dataCollection === "deny" ? { data_collection: "deny" as const } : {}),
    ...(routing.zdr ? { zdr: true as const } : {}),
    ...(routing.ignore.length ? { ignore: routing.ignore } : {}),
  };
}

/** The `provider` object for one AI function's requests. Prompt caching may add `only` on top. */
export function getOpenRouterRouting(name: RoutingFunction): OpenRouterProviderPreferences {
  return toOpenRouterProvider(getRoutingPreferences(name));
}
