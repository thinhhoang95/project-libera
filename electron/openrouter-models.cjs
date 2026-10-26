const fsp = require("node:fs/promises");
const path = require("node:path");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
// The default listing leaves out speech-to-text models.
const OPENROUTER_TRANSCRIPTION_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=transcription";
// Text-to-speech models, for Read aloud.
const OPENROUTER_SPEECH_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=speech";
const OPENROUTER_MODELS_CACHE_FILE_NAME = "openrouter-models-cache.json";
const OPENROUTER_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const OPENROUTER_MODELS_FETCH_TIMEOUT_MS = 15_000;
const MAX_OPENROUTER_MODELS = 2000;

function voiceList(input) {
  return Array.isArray(input)
    ? input.filter((voice) => typeof voice === "string" && voice.trim() && voice.length <= 120).map((voice) => voice.trim()).slice(0, 500)
    : [];
}

/** OpenRouter lists USD per token; Preferences shows and routes by USD per million tokens. */
function modelPrice(entry) {
  if (entry.price && Number.isFinite(entry.price.prompt) && Number.isFinite(entry.price.completion)) {
    return { prompt: entry.price.prompt, completion: entry.price.completion };
  }
  const prompt = Number(entry.pricing?.prompt);
  const completion = Number(entry.pricing?.completion);
  if (entry.pricing?.prompt === undefined || !Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return null;
  const perMillion = (value) => Math.round(value * 1_000_000 * 10_000) / 10_000;
  return { prompt: perMillion(prompt), completion: perMillion(completion) };
}

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
    const price = modelPrice(entry);
    models.push({
      id,
      name: name || id,
      contextLength: Number.isFinite(entry.context_length ?? entry.contextLength)
        ? Number(entry.context_length ?? entry.contextLength)
        : 0,
      vision: Array.isArray(inputModalities) ? inputModalities.includes("image") : entry.vision === true,
      // Routing's price ceilings are judged against it.
      ...(price ? { price } : {}),
      // Text-to-speech models name their voices, for Read aloud's voice suggestions.
      ...(voiceList(entry.supported_voices ?? entry.voices).length ? { voices: voiceList(entry.supported_voices ?? entry.voices) } : {}),
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
function createOpenRouterModelCatalog({
  cacheDir,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  url = OPENROUTER_MODELS_URL,
  cacheFileName = OPENROUTER_MODELS_CACHE_FILE_NAME,
}) {
  const cacheFile = path.join(cacheDir, cacheFileName);
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
    const response = await fetchImpl(url, {
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
  OPENROUTER_SPEECH_MODELS_URL,
  OPENROUTER_TRANSCRIPTION_MODELS_URL,
  OPENROUTER_MODELS_CACHE_TTL_MS,
  normalizeOpenRouterModels,
  createOpenRouterModelCatalog,
};
