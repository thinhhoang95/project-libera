const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  OPENROUTER_MODELS_CACHE_FILE_NAME,
  OPENROUTER_MODELS_CACHE_TTL_MS,
  normalizeOpenRouterModels,
  createOpenRouterModelCatalog,
} = require('../../electron/openrouter-models.cjs');

const RESPONSE = {
  data: [
    { id: 'openai/gpt-5.6-luna', name: 'OpenAI: GPT-5.6 Luna', context_length: 400000, architecture: { input_modalities: ['text', 'image'] } },
    { id: 'google/gemini-3.5-flash', name: 'Google: Gemini 3.5 Flash', context_length: 1048576, architecture: { input_modalities: ['text'] } },
    { id: 'google/gemini-3.5-flash', name: 'Duplicate' },
    { id: 'bad id' },
    { name: 'No id' },
  ],
};

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body };
}

test('OpenRouter models are normalized, deduplicated, and sorted by slug', () => {
  assert.deepEqual(normalizeOpenRouterModels(RESPONSE), [
    { id: 'google/gemini-3.5-flash', name: 'Google: Gemini 3.5 Flash', contextLength: 1048576, vision: false },
    { id: 'openai/gpt-5.6-luna', name: 'OpenAI: GPT-5.6 Luna', contextLength: 400000, vision: true },
  ]);
  assert.deepEqual(normalizeOpenRouterModels(undefined), []);
});

test('OpenRouter model catalog caches in memory and on disk until the TTL expires', async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'libera-openrouter-models-'));
  let clock = 1_000_000;
  let calls = 0;
  let available = true;
  const fetchImpl = async () => {
    calls += 1;
    if (!available) throw new Error('offline');
    return jsonResponse(RESPONSE);
  };
  try {
    const catalog = createOpenRouterModelCatalog({ cacheDir, fetchImpl, now: () => clock });
    const first = await catalog.list();
    assert.equal(first.models.length, 2);
    assert.equal(first.stale, false);
    await catalog.list();
    assert.equal(calls, 1);

    const persisted = JSON.parse(readFileSync(path.join(cacheDir, OPENROUTER_MODELS_CACHE_FILE_NAME), 'utf8'));
    assert.equal(persisted.fetchedAt, clock);

    // A new process reuses the disk cache without hitting the network.
    const restarted = createOpenRouterModelCatalog({ cacheDir, fetchImpl, now: () => clock });
    assert.equal((await restarted.list()).models.length, 2);
    assert.equal(calls, 1);

    await restarted.list({ refresh: true });
    assert.equal(calls, 2);

    // Expired and offline: serve the last list, marked stale.
    clock += OPENROUTER_MODELS_CACHE_TTL_MS + 1;
    available = false;
    const stale = await restarted.list();
    assert.equal(stale.stale, true);
    assert.equal(stale.models.length, 2);
    assert.equal(calls, 3);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('OpenRouter model catalog reports failures when nothing is cached', async () => {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'libera-openrouter-models-'));
  try {
    const catalog = createOpenRouterModelCatalog({ cacheDir, fetchImpl: async () => jsonResponse({}, false) });
    await assert.rejects(catalog.list(), /503/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
