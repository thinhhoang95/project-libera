import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as format } from "../../src/app/api/ai-format/route";
import { POST as rewrite } from "../../src/app/api/ai-rewrite/route";
import { POST as chat } from "../../src/app/api/document-chat/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { getAiFunctionOptions } from "../../src/lib/ai-preferences";
import { generateLatex } from "../../src/lib/latex-export";

const functions = ["formatting", "rewrite", "chat", "latex"] as const;

test("each AI endpoint uses its own model and effort; chat overrides remain local", async () => {
  const keys = ["OPENROUTER_API_KEY", "LIBERA_OPENROUTER_MODEL", ...functions.flatMap((name) => [`LIBERA_AI_${name.toUpperCase()}_MODEL`, `LIBERA_AI_${name.toUpperCase()}_REASONING_EFFORT`])];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const efforts = { formatting: "low", rewrite: "high", chat: "xhigh", latex: "max" };
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.LIBERA_OPENROUTER_MODEL = "legacy/model";
  for (const name of functions) {
    process.env[`LIBERA_AI_${name.toUpperCase()}_MODEL`] = `custom/${name}`;
    process.env[`LIBERA_AI_${name.toUpperCase()}_REASONING_EFFORT`] = efforts[name];
  }
  const calls: { model: string; reasoning: { effort: string } }[] = [];
  globalThis.fetch = async (_input, init) => { calls.push(JSON.parse(String(init?.body))); return Response.json({ choices: [{ message: { content: "A response" } }] }); };
  const request = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await format(request({ text: "Markdown text" }))).status, 200);
    assert.equal((await rewrite(request({ text: "Markdown text", prompt: "Shorten" }))).status, 200);
    const messages = [{ id: "1", role: "user", text: "Explain" }];
    assert.equal((await chat(request({ messages }))).status, 200);
    assert.equal((await chat(request({ messages, reasoningEffort: "medium" }))).status, 200);
    assert.deepEqual(calls.map(({ model, reasoning }) => [model, reasoning.effort]), [
      ["custom/formatting", "low"], ["custom/rewrite", "high"], ["custom/chat", "xhigh"], ["custom/chat", "medium"],
    ]);
    let parts = 0;
    await generateLatex([], new AbortController().signal, () => {}, async (_messages, options) => {
      assert.equal(options?.model, "custom/latex");
      assert.equal(options?.reasoning?.effort, "max");
      return { content: ++parts === 1 ? "\\documentclass{article}\n\\begin{document}\n<to be continued>" : "Complete\n\\end{document}", finishReason: "stop" };
    });
    assert.equal(parts, 2);
    assert.equal(getAiFunctionOptions("chat").reasoning.effort, "xhigh");
    delete process.env.LIBERA_AI_FORMATTING_MODEL;
    process.env.LIBERA_AI_FORMATTING_REASONING_EFFORT = "invalid";
    assert.deepEqual(getAiFunctionOptions("formatting"), { model: "legacy/model", reasoning: { effort: "medium" } });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
