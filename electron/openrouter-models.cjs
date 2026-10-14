const fsp = require("node:fs/promises");
const path = require("node:path");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_MODELS_CACHE_FILE_NAME = "openrouter-models-cache.json";
const OPENROUTER_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const OPENROUTER_MODELS_FETCH_TIMEOUT_MS = 15_000;
const MAX_OPENROUTER_MODELS = 2000;

function normalizeOpenRouterModels(input) {
  const entries = Array.isArray(input?.data) ? input.data : Array.isArray(input) ? input : [];
  const seen = new Set();
  const models = [];

  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f\s]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry.name === "string" ? entry.name.trim().slice(0, 200) : "";
    const inputModalities = entry.architecture?.input_modalities ?? entry.inputModalities;
    models.push({
      id,
      name: name || id,
      contextLength: Number.isFinite(entry.context_length ?? entry.contextLength)
        ? Number(entry.context_length ?? entry.contextLength)
        : 0,
      vision: Array.isArray(inputModalities) ? inputModalities.includes("image") : entry.vision === true,
    });
    if (models.length >= MAX_OPENROUTER_MODELS) break;
  }

  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Lists OpenRouter models for Preferences autocomplete. Results are cached in
 * memory and on disk for a day; when OpenRouter is unreachable the last cached
 * list is returned (marked stale) so suggestions keep working offline.
 */
function createOpenRouterModelCatalog({ cacheDir, fetchImpl = globalThis.fetch, now = Date.now }) {
  const cacheFile = path.join(cacheDir, OPENROUTER_MODELS_CACHE_FILE_NAME);
  let memory = null;
  let inflight = null;

  async function readDiskCache() {
    try {
      const parsed = JSON.parse(await fsp.readFile(cacheFile, "utf8"));
      const models = normalizeOpenRouterModels(parsed.models);
      return Number.isFinite(parsed.fetchedAt) && models.length ? { fetchedAt: parsed.fetchedAt, models } : null;
    } catch {
      return null;
    }
  }

  async function fetchRemote() {
    const response = await fetchImpl(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OPENROUTER_MODELS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}.`);
    const models = normalizeOpenRouterModels(await response.json());
    if (!models.length) throw new Error("OpenRouter returned no models.");
    const entry = { fetchedAt: now(), models };
    memory = entry;
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(entry)).catch(() => {});
    return entry;
  }

  async function list({ refresh = false } = {}) {
    memory ??= await readDiskCache();
    const fresh = memory && now() - memory.fetchedAt < OPENROUTER_MODELS_CACHE_TTL_MS;
    if (fresh && !refresh) return { ...memory, stale: false };

    inflight ??= fetchRemote().finally(() => { inflight = null; });
    try {
      return { ...(await inflight), stale: false };
    } catch (error) {
      if (memory) return { ...memory, stale: true };
      throw error;
    }
  }

  return { list };
}

module.exports = {
  OPENROUTER_MODELS_CACHE_FILE_NAME,
  OPENROUTER_MODELS_CACHE_TTL_MS,
  normalizeOpenRouterModels,
  createOpenRouterModelCatalog,
};
