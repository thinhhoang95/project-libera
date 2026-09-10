import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/document-chat/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";

test("chat authenticates, validates input, and uses the configured Preferences model", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.LIBERA_OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.LIBERA_OPENROUTER_MODEL = "test/preferences-model";
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, "test/preferences-model");
    assert.equal(payload.reasoning.effort, "xhigh");
    assert.equal(payload.messages[0].role, "system");
    assert.ok(payload.messages[1].content.includes("Unsaved content"));
    return Response.json({ choices: [{ message: { content: "Answer from configured model" } }] });
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
    assert.deepEqual(await response.json(), { text: "Answer from configured model", model: "test/preferences-model" });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.LIBERA_OPENROUTER_MODEL; else process.env.LIBERA_OPENROUTER_MODEL = originalModel;
  }
});
