import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getAiFunctionOptions } from "../../src/lib/ai-preferences";
import { createOpenRouterCompletion } from "../../src/lib/openrouter";
import { getOpenRouterRouting, normalizeRouting, toOpenRouterProvider } from "../../src/lib/openrouter-routing";

test("routing maps to OpenRouter's provider object and defaults to the cheapest provider", () => {
  assert.deepEqual(toOpenRouterProvider(normalizeRouting(undefined)), { sort: "price" });
  assert.deepEqual(toOpenRouterProvider(normalizeRouting({ sort: "default" })), {});
  assert.deepEqual(toOpenRouterProvider(normalizeRouting({
    sort: "throughput", maxPromptPrice: 0.5, maxCompletionPrice: "1.5", minThroughput: 40, maxLatency: 3,
    allowFallbacks: false, dataCollection: "deny", zdr: true, ignore: ["DeepInfra", "not a slug"],
  })), {
    sort: "throughput", max_price: { prompt: 0.5, completion: 1.5 }, preferred_min_throughput: 40, preferred_max_latency: 3,
    allow_fallbacks: false, data_collection: "deny", zdr: true, ignore: ["deepinfra"],
  });
});

test("each function's routing is read from the config file on every request, else the environment", async () => {
  const keys = ["LIBERA_CONFIG_PATH", "LIBERA_AI_ROUTING", "LIBERA_OPENROUTER_MAX_PROMPT_PRICE", "OPENROUTER_API_KEY"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const directory = await mkdtemp(path.join(tmpdir(), "libera-routing-"));
  const originalFetch = globalThis.fetch;
  try {
    for (const key of keys) delete process.env[key];
    process.env.LIBERA_AI_ROUTING = JSON.stringify({ chat: { sort: "latency" } });
    assert.deepEqual(getOpenRouterRouting("chat"), { sort: "latency" });
    // The global price ceilings still apply where a function sets none.
    process.env.LIBERA_OPENROUTER_MAX_PROMPT_PRICE = "4";
    assert.deepEqual(getOpenRouterRouting("formatting"), { sort: "price", max_price: { prompt: 4 } });

    const configPath = path.join(directory, "config.json");
    process.env.LIBERA_CONFIG_PATH = configPath;
    await writeFile(configPath, JSON.stringify({ aiFunctions: { routing: { formatting: { sort: "throughput", maxCompletionPrice: 2 } } } }));
    assert.deepEqual(getAiFunctionOptions("formatting").provider, { sort: "throughput", max_price: { completion: 2 } });
    // The config file wins over the environment, so the chat falls back to the default.
    assert.deepEqual(getOpenRouterRouting("chat"), { sort: "price", max_price: { prompt: 4 } });

    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let body: { provider?: unknown } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as typeof fetch;
    await createOpenRouterCompletion([{ role: "user", content: "Hi" }], getAiFunctionOptions("formatting"));
    assert.deepEqual(body.provider, { sort: "throughput", max_price: { completion: 2 } });
    await createOpenRouterCompletion([{ role: "user", content: "Hi" }], { model: "any/model" });
    assert.deepEqual(body.provider, { sort: "price", max_price: { prompt: 4 } });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(directory, { recursive: true, force: true });
  }
});
