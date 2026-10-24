import type { AccountUsage, ModelInfo, ModelPricing } from "./spending";
import { getOpenRouterApiKey } from "./openrouter";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const KEY_URL = "https://openrouter.ai/api/v1/key";
const CATALOG_TTL = 6 * 60 * 60_000;

let catalog: { expires: number; models: Map<string, ModelInfo> } | null = null;
let loading: Promise<Map<string, ModelInfo>> | null = null;

function price(value: unknown) {
  const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

async function loadCatalog(): Promise<Map<string, ModelInfo>> {
  const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`OpenRouter model list: ${response.status}`);
  const payload = await response.json() as { data?: { id?: unknown; name?: unknown; pricing?: Record<string, unknown> }[] };
  const models = new Map<string, ModelInfo>();
  for (const model of payload.data ?? []) {
    if (typeof model.id !== "string") continue;
    const prompt = price(model.pricing?.prompt);
    const completion = price(model.pricing?.completion);
    const cacheRead = price(model.pricing?.input_cache_read);
    const cacheWrite = price(model.pricing?.input_cache_write);
    const pricing: ModelPricing | undefined = prompt !== undefined && completion !== undefined
      ? { prompt, completion, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) }
      : undefined;
    models.set(model.id, { ...(typeof model.name === "string" ? { name: model.name } : {}), ...(pricing ? { pricing } : {}) });
  }
  return models;
}

/**
 * Names and per-token prices for the given models, from OpenRouter's public
 * model list (cached for a few hours). Models it no longer lists, or a failed
 * fetch, simply come back without prices; the Spending page then splits the
 * reported cost by typical weights instead.
 */
export async function getModelInfo(ids: Iterable<string>): Promise<Record<string, ModelInfo>> {
  if (!catalog || catalog.expires < Date.now()) {
    loading ??= loadCatalog().finally(() => { loading = null; });
    try {
      catalog = { expires: Date.now() + CATALOG_TTL, models: await loading };
    } catch {
      // Keep a stale catalog rather than none; retry in a minute.
      catalog = { expires: Date.now() + 60_000, models: catalog?.models ?? new Map() };
    }
  }
  const result: Record<string, ModelInfo> = {};
  for (const id of ids) {
    // ":free", ":nitro" and other variants share the base model's name.
    const info = catalog.models.get(id) ?? catalog.models.get(id.replace(/:[^/]+$/, ""));
    if (info) result[id] = info;
  }
  return result;
}

/** The OpenRouter key's own usage counters (every app using the key, in UTC days, weeks and months). */
export async function getAccountUsage(): Promise<AccountUsage | null> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) return null;
  const response = await fetch(KEY_URL, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(response.status === 401 ? "OpenRouter did not accept the API key." : `OpenRouter key details: ${response.status}`);
  const { data } = await response.json() as { data?: Record<string, unknown> };
  if (!data) return null;
  const amount = (value: unknown) => price(value) ?? 0;
  const optional = (value: unknown) => price(value) ?? null;
  return {
    ...(typeof data.label === "string" ? { label: data.label } : {}),
    usage: amount(data.usage),
    daily: amount(data.usage_daily),
    weekly: amount(data.usage_weekly),
    monthly: amount(data.usage_monthly),
    limit: optional(data.limit),
    remaining: optional(data.limit_remaining),
    reset: typeof data.limit_reset === "string" ? data.limit_reset : null,
  };
}
