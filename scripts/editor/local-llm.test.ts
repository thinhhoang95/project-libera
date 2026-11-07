import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { NextRequest } from "next/server";
import { GET as aiModels } from "../../src/app/api/ai-models/route";
import { POST as format } from "../../src/app/api/ai-format/route";
import { POST as rewrite } from "../../src/app/api/ai-rewrite/route";
import { POST as chat } from "../../src/app/api/document-chat/route";
import { callModel, getModelProfile } from "../../src/lib/agent/model";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { getAiCustomInstruction, getAiFunctionOptions, getAiModelChoices, getDefinitionsOptions, withAiCustomInstruction } from "../../src/lib/ai-preferences";
import { LocalLlmError } from "../../src/lib/local-llm";
import { createOpenRouterCompletion, modelAvailable, streamOpenRouterCompletion } from "../../src/lib/openrouter";

type Received = { url: string; authorization?: string; body: Record<string, unknown> & { messages: { role: string; content: unknown }[] } };
type Reply = (response: ServerResponse, received: Received) => void | Promise<void>;

const sse = (chunk: unknown) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`;
const textChunk = (content: string, finish?: string) => sse({ choices: [{ delta: { content }, ...(finish ? { finish_reason: finish } : {}) }] });

function streamReply(...parts: string[]): Reply {
  return (response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.end([...parts, sse("[DONE]")].join(""));
  };
}

function errorReply(status: number, message: string): Reply {
  return (response) => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ error: { message } }));
  };
}

/** A stand-in for Ollama, LM Studio or llama-server. `reply` can change between requests. */
async function fakeServer(t: TestContext, first: Reply) {
  const state = { reply: first, requests: [] as Received[] };
  const server: Server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const received = { url: request.url ?? "", authorization: request.headers.authorization, body: JSON.parse(text || "{}") };
      state.requests.push(received);
      void state.reply(response, received);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { ...state, state, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

const ENV = ["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY", "OPENROUTER_KEY", "OPENAI_API_KEY", "LIBERA_CONFIG_PATH", "LIBERA_AI_LOCAL_LLMS", "LIBERA_AI_MODEL_POOL", "LIBERA_AI_FORMATTING_MODEL", "LIBERA_AI_REWRITE_MODEL", "LIBERA_AI_CHAT_MODEL", "LIBERA_AI_DEFINITIONS_MODEL", "LIBERA_AI_DEFINITIONS_REASONING_EFFORT", "LIBERA_AI_REWRITE_CUSTOM_INSTRUCTION", "LIBERA_AI_WRITE_CUSTOM_INSTRUCTION", "LIBERA_AI_LATEX_CUSTOM_INSTRUCTION", "LIBERA_USAGE_LEDGER"];

/** No OpenRouter key on purpose: nothing here may need one, or reach OpenRouter. */
function useEndpoint(t: TestContext, baseUrl: string, overrides: Record<string, string> = {}) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  process.env.LIBERA_USAGE_LEDGER = "off";
  process.env.LIBERA_AI_LOCAL_LLMS = JSON.stringify([{ alias: "myllm", preset: "ollama", baseUrl, model: "llama3.2", apiKey: "secret" }]);
  Object.assign(process.env, overrides);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input).includes("openrouter.ai"), false, `A local model must not reach OpenRouter: ${String(input)}`);
    return realFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify(body) });
}

test("a local alias works like a model slug, without an OpenRouter key", async (t) => {
  const server = await fakeServer(t, streamReply(textChunk("Hello "), textChunk("there", "stop"), sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })));
  useEndpoint(t, server.baseUrl);
  assert.equal(modelAvailable("local/myllm"), true);
  assert.equal(modelAvailable("openai/gpt-6-luna"), false);
  const result = await createOpenRouterCompletion([
    { role: "system", content: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: "Hi" },
  ], { model: "local/myllm", reasoning: { effort: "high" }, sessionId: "session", provider: { sort: "price" }, promptCaching: true, maxTokens: 50 });
  assert.equal(result.content, "Hello there");
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage?.inputTokens, 12);
  assert.equal(result.generation?.provider, "Ollama");
  const [{ url, authorization, body }] = server.state.requests;
  assert.equal(url, "/v1/chat/completions");
  assert.equal(authorization, "Bearer secret");
  assert.equal(body.model, "llama3.2");
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 50);
  // OpenRouter's own fields would be rejected or misread by a local server.
  for (const field of ["provider", "session_id", "reasoning", "plugins"]) assert.equal(field in body, false, field);
  assert.equal(body.messages[0].content, "Be brief.");
});

test("tokens reach the caller while the model is still writing", async (t) => {
  let finish = () => {};
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const server = await fakeServer(t, async (response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.write(textChunk("first"));
    await held;
    response.end(textChunk(" second", "stop") + sse("[DONE]"));
  });
  useEndpoint(t, server.baseUrl);
  const stream = streamOpenRouterCompletion([{ role: "user", content: "Hi" }], { model: "local/myllm" });
  // The server has not finished, so this resolves only if the first token streams through.
  assert.deepEqual(await stream.next(), { done: false, value: "first" });
  finish();
  assert.deepEqual(await stream.next(), { done: false, value: " second" });
  assert.equal((await stream.next()).done, true);
});

test("a thinking block written into the reply never reaches the document", async (t) => {
  const server = await fakeServer(t, streamReply(textChunk("<thi"), textChunk("nk>Let me plan</th"), textChunk("ink>\n\n"), textChunk("The answer", "stop")));
  useEndpoint(t, server.baseUrl);
  assert.equal((await createOpenRouterCompletion([{ role: "user", content: "Hi" }], { model: "local/myllm" })).content, "The answer");
  server.state.reply = streamReply(textChunk("<b>bold</b> stays", "stop"));
  assert.equal((await createOpenRouterCompletion([{ role: "user", content: "Hi" }], { model: "local/myllm" })).content, "<b>bold</b> stays");
});

test("common failures come back as advice, not as raw errors", async (t) => {
  const server = await fakeServer(t, errorReply(404, "model \"llama3.2\" not found, try pulling it first"));
  useEndpoint(t, server.baseUrl);
  const complete = (options: Parameters<typeof createOpenRouterCompletion>[1] = {}, content: Parameters<typeof createOpenRouterCompletion>[0][number]["content"] = "Hi") =>
    createOpenRouterCompletion([{ role: "user", content }], { model: "local/myllm", ...options });

  await assert.rejects(complete(), /Ollama does not have llama3\.2 ready\. Download it with `ollama pull llama3\.2`/);
  server.state.reply = errorReply(400, "the request exceeds the available context size");
  await assert.rejects(complete(), /too long for llama3\.2's context window/);
  server.state.reply = errorReply(401, "bad key");
  await assert.rejects(complete(), /rejected the API key for local\/myllm/);
  server.state.reply = streamReply(sse({ error: { message: "the input length exceeds the context length" } }));
  await assert.rejects(complete(), /too long for llama3\.2's context window/);
  server.state.reply = (response) => { response.setHeader("Content-Type", "text/event-stream"); response.end(textChunk("Half a sent")); };
  await assert.rejects(complete(), /stopped before the reply was complete/);
  server.state.reply = (response) => { response.write(textChunk("Half a sent")); setTimeout(() => response.destroy(), 10); };
  await assert.rejects(complete(), /stopped before the reply was complete/);

  await assert.rejects(complete({ model: "local/missing" }), /local\/missing is not set up\. Add it in Preferences → Local LLMs/);
  await assert.rejects(complete({ webSearch: {} }), /cannot search the web/);
  await assert.rejects(complete({}, [{ type: "file", file: { filename: "a.pdf", file_data: "x" } }]), /cannot read PDF files/);

  process.env.LIBERA_AI_LOCAL_LLMS = JSON.stringify([{ alias: "myllm", preset: "lmstudio", baseUrl: "http://127.0.0.1:9/v1", model: "qwen" }]);
  await assert.rejects(complete(), /Could not reach LM Studio at http:\/\/127\.0\.0\.1:9\/v1.*Is the server running\?/);
});

test("the agent streams text and tool calls from a local model", async (t) => {
  const toolCall = { index: 0, id: "call_1", function: { name: "Read", arguments: "{\"path\":" } };
  const server = await fakeServer(t, streamReply(
    textChunk("Reading. "),
    sse({ choices: [{ delta: { tool_calls: [toolCall] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a.md\"}" } }] }, finish_reason: "tool_calls" }] }),
  ));
  useEndpoint(t, server.baseUrl);
  const profile = await getModelProfile("local/myllm");
  assert.deepEqual(profile, { contextLength: 32_768, supportsTools: true, known: false });
  const seen: string[] = [];
  const tools = [{ type: "function" as const, function: { name: "Read", description: "Reads a file.", parameters: { type: "object" } } }];
  const reply = await callModel({
    model: "local/myllm", profile, tools, reasoningEffort: "high", promptCaching: true, sessionId: "session",
    messages: [{ role: "assistant", content: "Earlier", reasoning_details: [{ type: "reasoning.text" }] }, { role: "user", content: [{ type: "text", text: "Go", cache_control: { type: "ephemeral" } }] }],
    signal: new AbortController().signal, onTextDelta: (text) => seen.push(text),
  });
  assert.deepEqual(seen, ["Reading. "]);
  assert.deepEqual(reply.toolCalls, [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{\"path\":\"a.md\"}" } }]);
  const { body } = server.state.requests[0];
  assert.deepEqual(body.tools, tools);
  assert.equal("reasoning" in body, false);
  assert.equal("reasoning_details" in body.messages[0], false);
  assert.equal(body.messages[1].content, "Go");

  server.state.reply = errorReply(400, "registry.ollama.ai/library/gemma does not support tools");
  await assert.rejects(callModel({ model: "local/myllm", profile, tools, messages: [{ role: "user", content: "Go" }], signal: new AbortController().signal }), /cannot call tools/);
});

test("the agent does not retry a server that is down", async (t) => {
  const server = await fakeServer(t, streamReply());
  useEndpoint(t, "http://127.0.0.1:9/v1");
  const profile = await getModelProfile("local/myllm");
  const started = Date.now();
  await assert.rejects(callModel({ model: "local/myllm", profile, tools: [], messages: [{ role: "user", content: "Go" }], signal: new AbortController().signal }), /Could not reach Ollama/);
  assert.ok(Date.now() - started < 900, "no backoff");
  assert.equal(server.state.requests.length, 0);
});

test("AI Chat streams a local model through its route", async (t) => {
  const server = await fakeServer(t, streamReply(textChunk("Local "), textChunk("answer", "stop")));
  useEndpoint(t, server.baseUrl, { LIBERA_AI_CHAT_MODEL: "local/myllm", LIBERA_AI_MODEL_POOL: JSON.stringify(["local/myllm"]) });
  assert.equal(getAiFunctionOptions("chat").promptCaching, false);
  const response = await chat(post("/api/document-chat", { stream: true, messages: [{ id: "1", role: "user", text: "Hi" }] }));
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string; text?: string; model?: string });
  assert.deepEqual(events.filter((event) => event.type === "delta").map((event) => event.text), ["Local ", "answer"]);
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.at(-1)?.model, "local/myllm");
});

test("a menu's model and effort choice is honoured, and must come from the pool", async (t) => {
  const server = await fakeServer(t, streamReply(textChunk("Rewritten by the local model", "stop")));
  useEndpoint(t, server.baseUrl, { LIBERA_AI_REWRITE_MODEL: "cloud/default", LIBERA_AI_FORMATTING_MODEL: "cloud/default", LIBERA_AI_MODEL_POOL: JSON.stringify(["cloud/default", "local/myllm"]) });

  const choices = getAiModelChoices();
  assert.deepEqual(choices.pool, ["cloud/default", "local/myllm"]);
  assert.equal(choices.tasks.rewrite.model, "cloud/default");
  const listed = await aiModels(new NextRequest("http://localhost/api/ai-models", { headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } }));
  assert.deepEqual((await listed.json() as { pool: string[] }).pool, choices.pool);
  assert.equal((await aiModels(new NextRequest("http://localhost/api/ai-models"))).status, 401);

  const response = await rewrite(post("/api/ai-rewrite", { text: "Original", prompt: "Shorter", model: "local/myllm", thread: { id: "thread-12345", turns: [] } }));
  assert.equal(response.status, 200);
  const payload = await response.json() as { rewrittenText: string; thread: { caching: boolean } };
  assert.equal(payload.rewrittenText, "Rewritten by the local model");
  // A local model has no prompt cache, so the client ends the thread.
  assert.equal(payload.thread.caching, false);
  assert.equal(server.state.requests[0].body.model, "llama3.2");

  const refused = await rewrite(post("/api/ai-rewrite", { text: "Original", prompt: "Shorter", model: "other/model" }));
  assert.equal(refused.status, 400);
  assert.match((await refused.json() as { error: string }).error, /no longer in the Model Pool/);
  assert.equal((await rewrite(post("/api/ai-rewrite", { text: "Original", prompt: "Shorter", reasoningEffort: "huge" }))).status, 400);

  const formatted = await format(post("/api/ai-format", { text: "Original", model: "local/myllm" }));
  assert.equal(formatted.status, 200);
  assert.equal((await format(post("/api/ai-format", { text: "Original", model: "other/model" }))).status, 400);
});

test("custom system prompts follow the built-in one, and Write with AI falls back to AI Rewrite's", (t) => {
  useEndpoint(t, "http://127.0.0.1:9/v1", { LIBERA_AI_REWRITE_CUSTOM_INSTRUCTION: "Keep the voice.", LIBERA_AI_LATEX_CUSTOM_INSTRUCTION: "Use the article class." });
  assert.equal(getAiCustomInstruction("write"), "Keep the voice.");
  process.env.LIBERA_AI_WRITE_CUSTOM_INSTRUCTION = "Write plainly.";
  assert.equal(getAiCustomInstruction("write"), "Write plainly.");
  assert.equal(withAiCustomInstruction("Built in.", "latex"), "Built in.\n\nUser-configured custom instructions:\nUse the article class.");
  assert.equal(withAiCustomInstruction("Built in.", "review"), "Built in.");
});

test("Generate Definitions reads its model and effort from Preferences", (t) => {
  useEndpoint(t, "http://127.0.0.1:9/v1");
  assert.deepEqual(getDefinitionsOptions(), { model: "", reasoningEffort: "" });
  process.env.LIBERA_AI_DEFINITIONS_MODEL = "local/myllm";
  process.env.LIBERA_AI_DEFINITIONS_REASONING_EFFORT = "high";
  assert.deepEqual(getDefinitionsOptions(), { model: "local/myllm", reasoningEffort: "high" });
});

test("LocalLlmError carries whether a retry can help", () => {
  assert.equal(new LocalLlmError("Loading.", "loading", true).retryable, true);
  assert.equal(new LocalLlmError("Down.", "unreachable").retryable, false);
});
