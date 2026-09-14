import assert from "node:assert/strict";
import test from "node:test";
import { createOpenRouterCompletion, streamOpenRouterCompletion, type OpenRouterMessage } from "../../src/lib/openrouter";
import { getAiFunctionOptions } from "../../src/lib/ai-preferences";

test("prompt caching restricts providers, preserves models, handles explicit caching and fails closed", async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  const requests: { model: string; provider?: { only: string[] }; messages: { content: { cache_control?: { type: string } }[] }[] }[] = [];
  let lookups = 0;
  let endpoints: unknown[] = [
    { tag: "deepseek", supports_implicit_caching: true },
    { tag: "uncached", supports_implicit_caching: false },
    { tag: "unknown" },
    { tag: "invalid", pricing: { input_cache_read: null } },
    { tag: "read-price-only", supports_implicit_caching: false, pricing: { input_cache_read: "0.000000006" } },
    { tag: "mixed", supports_implicit_caching: true },
    { tag: "mixed/turbo", supports_implicit_caching: false },
    { tag: "regional/eu", supports_implicit_caching: true },
  ];
  let lookupStatus = 200;
  const messages: OpenRouterMessage[] = [
    { role: "system", content: "Stable instructions" },
    { role: "user", content: [{ type: "text", text: "Document context" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
    { role: "assistant", content: "Previous answer" },
    { role: "user", content: "Follow-up question" },
  ];
  const originalMessages = structuredClone(messages);
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/endpoints")) {
      lookups++;
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      return Response.json({ data: { endpoints } }, { status: lookupStatus });
    }
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return body.stream
      ? new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n')
      : Response.json({ choices: [{ message: { content: "Answer" } }] });
  };
  try {
    const model = "deepseek/deepseek-v4.1-flash";
    await createOpenRouterCompletion(messages, { model, promptCaching: true });
    assert.equal(requests[0].model, model);
    assert.deepEqual(requests[0].provider, { only: ["deepseek", "regional/eu"] });
    assert.deepEqual(requests[0].messages, messages);
    let answer = "";
    for await (const text of streamOpenRouterCompletion(messages, { model, promptCaching: true })) answer += text;
    assert.equal(answer, "Answer");
    assert.deepEqual(requests[1].provider, requests[0].provider);
    assert.equal(lookups, 1, "reuse provider metadata for follow-up requests");

    await createOpenRouterCompletion(messages, { model, promptCaching: false });
    assert.equal(requests[2].provider, undefined);
    assert.deepEqual(requests[2].messages, messages);
    assert.equal(lookups, 1, "disabled caching does not discover providers");

    endpoints = [
      { tag: "explicit", supported_parameters: ["cache_control"] },
      { tag: "free-cache", pricing: { input_cache_read: "0", input_cache_write: "0" } },
      { tag: "no-cache", pricing: { input_cache_read: "" } },
    ];
    await createOpenRouterCompletion(messages, { model: "test/explicit-cache", promptCaching: true });
    const explicit = requests.at(-1)!;
    assert.deepEqual(explicit.provider?.only, ["explicit", "free-cache"]);
    assert.deepEqual(explicit.messages[0].content[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(explicit.messages[1], messages[1], "retain multimodal context");
    assert.deepEqual(explicit.messages[2].content[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(explicit.messages[3].content[0].cache_control, { type: "ephemeral" });
    assert.deepEqual(messages, originalMessages, "do not mutate caller messages");

    endpoints = [{ tag: "unsupported" }];
    const completionCount = requests.length;
    await assert.rejects(createOpenRouterCompletion(messages, { model: "test/no-cache", promptCaching: true }), /No verified prompt caching providers/);
    lookupStatus = 503;
    await assert.rejects(createOpenRouterCompletion(messages, { model: "test/unavailable", promptCaching: true }), /Cannot verify prompt caching providers/);
    assert.equal(requests.length, completionCount, "never silently send unrestricted requests");
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(createOpenRouterCompletion(messages, { model, promptCaching: true, signal: cancellation.signal }), { name: "AbortError" });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test("each function honors true and false caching preferences without changing its model", () => {
  const names = { formatting: "FORMATTING", rewrite: "REWRITE", chat: "CHAT", imageToMarkdown: "IMAGE_TO_MARKDOWN", latex: "LATEX" } as const;
  for (const [name, env] of Object.entries(names)) {
    const key = `LIBERA_AI_${env}_PROMPT_CACHING`;
    const original = process.env[key];
    try {
      const fn = name as keyof typeof names;
      const model = getAiFunctionOptions(fn).model;
      for (const enabled of [true, false]) {
        process.env[key] = String(enabled);
        assert.equal(getAiFunctionOptions(fn).promptCaching, enabled);
        assert.equal(getAiFunctionOptions(fn).model, model);
      }
      process.env[key] = "invalid";
      assert.equal(getAiFunctionOptions(fn).promptCaching, name === "chat");
    } finally {
      if (original === undefined) delete process.env[key]; else process.env[key] = original;
    }
  }
});
