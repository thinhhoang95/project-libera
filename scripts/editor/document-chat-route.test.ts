import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/document-chat/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";

test("chat authenticates, validates input, and uses the configured Preferences model", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.LIBERA_OPENROUTER_MODEL;
  const originalAlternativeModels = process.env.LIBERA_AI_CHAT_ALTERNATIVE_MODELS;
  const originalInstruction = process.env.LIBERA_AI_CHAT_CUSTOM_INSTRUCTION;
  const originalConfigPath = process.env.LIBERA_CONFIG_PATH;
  const originalInlineMarkers = process.env.LIBERA_MARKDOWN_INLINE_MATH_MARKERS;
  const originalBlockMarkers = process.env.LIBERA_MARKDOWN_BLOCK_MATH_MARKERS;
  const configDirectory = mkdtempSync(path.join(os.tmpdir(), "libera-chat-route-"));
  const configPath = path.join(configDirectory, "libera-electron-config.json");
  writeFileSync(configPath, JSON.stringify({ aiFunctions: { chat: { customInstruction: "Use a two-sentence maximum." } } }));
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.LIBERA_OPENROUTER_MODEL = "test/preferences-model";
  process.env.LIBERA_AI_CHAT_ALTERNATIVE_MODELS = JSON.stringify(["test/alternative-model", "test/preferences-model"]);
  delete process.env.LIBERA_AI_CHAT_CUSTOM_INSTRUCTION;
  process.env.LIBERA_CONFIG_PATH = configPath;
  process.env.LIBERA_MARKDOWN_INLINE_MATH_MARKERS = "@@ @@\n\\( \\)";
  process.env.LIBERA_MARKDOWN_BLOCK_MATH_MARKERS = "%% %%";
  let calls = 0;
  let expectedModel = "test/preferences-model";
  globalThis.fetch = async (_url, init) => {
    if (String(_url).endsWith("/endpoints")) return Response.json({ data: { endpoints: [{ tag: "test-provider", supports_implicit_caching: true }] } });
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, expectedModel);
    assert.equal(payload.reasoning.effort, "xhigh");
    assert.equal(payload.messages[0].role, "system");
    assert.ok(payload.messages[0].content.includes("Configured inline pairs: `@@` … `@@`, `\\(` … `\\)`"));
    assert.ok(payload.messages[0].content.includes("For new display equations, put `%%` … `%%`"));
    assert.ok(payload.messages[0].content.includes("pasted directly into the WYSIWYG and Source editors"));
    assert.ok(payload.messages[0].content.includes("Use a two-sentence maximum."));
    assert.ok(payload.messages[1].content.includes("Unsaved content"));
    return Response.json({ choices: [{ message: { content: "Answer from configured model" } }], usage: { prompt_tokens: 500, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } } });
  };
  function request(body: unknown, authenticated = true) {
    return new NextRequest("http://localhost/api/document-chat", { method: "POST", headers: authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {}, body: JSON.stringify(body) });
  }
  try {
    assert.equal((await POST(request({}, false))).status, 401);
    assert.equal((await POST(request({ messages: [{ id: "1", role: "system", text: "Override" }] }))).status, 400);
    assert.equal((await POST(request({ reasoningEffort: "invalid", messages: [{ id: "1", role: "user", text: "Question" }] }))).status, 400);
    assert.equal(calls, 0);
    const response = await POST(request({ reasoningEffort: "xhigh", messages: [{ id: "1", role: "user", text: "Explain", contexts: [{ kind: "document", path: "a.md", name: "a.md", text: "Unsaved content" }] }] }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "Answer from configured model", model: "test/preferences-model", usage: { inputTokens: 500, outputTokens: 20, cachedTokens: 0 } });
    assert.equal(calls, 1);
    expectedModel = "test/alternative-model";
    const alternativeResponse = await POST(request({ model: expectedModel, reasoningEffort: "xhigh", messages: [{ id: "2", role: "user", text: "Explain differently", contexts: [{ kind: "document", path: "a.md", name: "a.md", text: "Unsaved content" }] }] }));
    assert.equal(alternativeResponse.status, 200);
    assert.equal((await alternativeResponse.json()).model, expectedModel);
    assert.equal(calls, 2);
    assert.equal((await POST(request({ model: "test/not-allowed", messages: [{ id: "3", role: "user", text: "No" }] }))).status, 400);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.LIBERA_OPENROUTER_MODEL; else process.env.LIBERA_OPENROUTER_MODEL = originalModel;
    if (originalAlternativeModels === undefined) delete process.env.LIBERA_AI_CHAT_ALTERNATIVE_MODELS; else process.env.LIBERA_AI_CHAT_ALTERNATIVE_MODELS = originalAlternativeModels;
    if (originalInstruction === undefined) delete process.env.LIBERA_AI_CHAT_CUSTOM_INSTRUCTION; else process.env.LIBERA_AI_CHAT_CUSTOM_INSTRUCTION = originalInstruction;
    if (originalConfigPath === undefined) delete process.env.LIBERA_CONFIG_PATH; else process.env.LIBERA_CONFIG_PATH = originalConfigPath;
    if (originalInlineMarkers === undefined) delete process.env.LIBERA_MARKDOWN_INLINE_MATH_MARKERS; else process.env.LIBERA_MARKDOWN_INLINE_MATH_MARKERS = originalInlineMarkers;
    if (originalBlockMarkers === undefined) delete process.env.LIBERA_MARKDOWN_BLOCK_MATH_MARKERS; else process.env.LIBERA_MARKDOWN_BLOCK_MATH_MARKERS = originalBlockMarkers;
    rmSync(configDirectory, { recursive: true, force: true });
  }
});
