import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "../../src/app/api/agent/route";
import { POST as UNDO } from "../../src/app/api/agent/undo/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { readAgentEvents } from "../../src/components/libera/chat-stream-client";
import { optionalParameters } from "../../src/lib/agent/model";
import { runAgent } from "../../src/lib/agent/runner";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import { toolsForPermission, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent } from "../../src/lib/agent/types";

type Call = { id: string; name: string; args: unknown; rawArguments?: string };

function sse(chunks: unknown[], done = true) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "Content-Type": "text/event-stream" } });
}

/** A streamed reply: text, then tool calls whose ids, names and arguments arrive in fragments. */
function reply({ text = "", calls = [], finish, reasoning }: { text?: string; calls?: Call[]; finish?: string; reasoning?: string[] }) {
  const chunks: unknown[] = [];
  for (const [index, part] of (reasoning ?? []).entries()) chunks.push({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: part, ...(index === 0 ? { format: "test" } : { signature: "sig" }) }] } }] });
  if (text) for (const piece of [text.slice(0, 4), text.slice(4)]) if (piece) chunks.push({ choices: [{ delta: { content: piece } }] });
  calls.forEach((call, index) => {
    const raw = call.rawArguments ?? JSON.stringify(call.args);
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] } }] });
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: raw.slice(0, 7) } }] } }] });
    chunks.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: raw.slice(7) } }] } }] });
  });
  chunks.push({ choices: [{ delta: {}, finish_reason: finish ?? (calls.length ? "tool_calls" : "stop") }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } } });
  return sse(chunks);
}

const endpoints = (parameters = ["tools", "reasoning", "temperature"]) => Response.json({ data: { context_length: 200_000, endpoints: [{ tag: "test", supports_implicit_caching: true, context_length: 200_000, supported_parameters: parameters }] } });

async function withLibrary(run: (root: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-agent-route-"));
  const saved = { data: process.env.LIBERA_DATA_DIR, key: process.env.OPENROUTER_API_KEY, model: process.env.LIBERA_OPENROUTER_MODEL, alternatives: process.env.LIBERA_AI_CHAT_ALTERNATIVE_MODELS, instruction: process.env.LIBERA_AI_CHAT_CUSTOM_INSTRUCTION };
  const originalFetch = globalThis.fetch;
  process.env.LIBERA_DATA_DIR = directory;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.LIBERA_OPENROUTER_MODEL = "test/agent-model";
  process.env.LIBERA_AI_CHAT_ALTERNATIVE_MODELS = JSON.stringify(["test/no-tools"]);
  process.env.LIBERA_AI_CHAT_CUSTOM_INSTRUCTION = "Answer in British English.";
  const root = path.join(directory, "users", "admin");
  try {
    await mkdir(path.join(root, "Research", "ideas"), { recursive: true });
    await mkdir(path.join(root, "Personal"), { recursive: true });
    await writeFile(path.join(root, "Research", "plan.md"), "# Plan\n\nThe Q3 budget is 40k.\n");
    await writeFile(path.join(root, "Research", "ideas", "atlas.md"), "# Atlas\n");
    await writeFile(path.join(root, "Research", "AGENT_NOTES.md"), "Tags use #kebab-case.\n");
    await run(root);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ LIBERA_DATA_DIR: saved.data, OPENROUTER_API_KEY: saved.key, LIBERA_OPENROUTER_MODEL: saved.model, LIBERA_AI_CHAT_ALTERNATIVE_MODELS: saved.alternatives, LIBERA_AI_CHAT_CUSTOM_INSTRUCTION: saved.instruction })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function request(url: string, body: unknown, authenticated = true) {
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers: authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {}, body: JSON.stringify(body) });
}

const userMessage = (text: string) => ({ id: crypto.randomUUID(), role: "user", text });

test("an agent run searches, reads in parallel, edits, streams events, and can be undone", async () => {
  await withLibrary(async (root) => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [
      () => reply({ text: "Let me look.", reasoning: ["Think ", "carefully."], calls: [
        { id: "call_grep", name: "Grep", args: { pattern: "budget", output_mode: "content" } },
        { id: "call_read", name: "Read", args: { file_path: "Research/plan.md" } },
      ] }),
      () => reply({ calls: [{ id: "call_edit", name: "Edit", args: { file_path: "Research/plan.md", old_string: "40k", new_string: "50k" } }] }),
      () => reply({ text: "Updated the budget in Research/plan.md." }),
    ];
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/endpoints")) return endpoints();
      bodies.push(JSON.parse(String(init?.body)));
      return replies.shift()!();
    };

    assert.equal((await POST(request("/api/agent", { permission: "notebook", messages: [userMessage("Hi")] }, false))).status, 401);
    assert.equal((await POST(request("/api/agent", { permission: "everything", messages: [userMessage("Hi")] }))).status, 400);
    assert.equal((await POST(request("/api/agent", { permission: "notebook", messages: [userMessage("Hi")] }))).status, 400);
    assert.equal((await POST(request("/api/agent", { permission: "notebook", model: "test/unlisted", notebook: "Research", messages: [userMessage("Hi")] }))).status, 400);

    const response = await POST(request("/api/agent", {
      permission: "notebook", sessionId: "chat-1", reasoningEffort: "high",
      activeFile: "Research/plan.md", openFiles: ["Research/plan.md", "untitled-1"],
      messages: [
        { id: "1", role: "user", text: "What is the budget?", contexts: [{ kind: "document", path: "Research/plan.md", name: "plan.md", text: "# Plan (old attached copy)" }] },
        { id: "2", role: "assistant", text: "It is 40k.", agent: { runId: "previous-run-1", permission: "read-only", steps: [], tasks: [], changes: [] } },
        { id: "3", role: "user", text: "Raise it to 50k.", contexts: [{ kind: "selection", path: "Research/plan.md", name: "plan.md", text: "The Q3 budget is 40k." }] },
      ],
    }));
    assert.equal(response.status, 200);
    const events: AgentEvent[] = [];
    await readAgentEvents(response, new AbortController().signal, (event) => events.push(event));

    assert.equal(await readFile(path.join(root, "Research", "plan.md"), "utf8"), "# Plan\n\nThe Q3 budget is 50k.\n");
    const types = events.map((event) => event.type);
    assert.equal(types[0], "run_started");
    assert.deepEqual(events.at(-1), { type: "done", outcome: "completed" });
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => (event as { text: string }).text).join(""), "Let me look.Updated the budget in Research/plan.md.");
    const started = events.filter((event): event is Extract<AgentEvent, { type: "tool_started" }> => event.type === "tool_started");
    assert.deepEqual(started.map((event) => [event.id, event.name, event.summary]), [
      ["call_grep", "Grep", "Searching for “budget”"],
      ["call_read", "Read", "Reading Research/plan.md"],
      ["call_edit", "Edit", "Editing Research/plan.md"],
    ]);
    assert.deepEqual(started[2].diff, { removed: "40k", added: "50k" });
    assert.ok(events.some((event) => event.type === "file_changed" && event.path === "Research/plan.md" && !event.created));
    assert.equal(events.filter((event) => event.type === "usage").length, 3);

    // The first request: tools, routing, prompt and conversation.
    const first = bodies[0] as { model: string; tools: { function: { name: string } }[]; provider: Record<string, unknown>; reasoning: unknown; session_id: string; messages: { role: string; content: string }[] };
    assert.equal(first.model, "test/agent-model");
    assert.deepEqual(first.tools.map((tool) => tool.function.name), ["Glob", "Grep", "Read", "Edit", "Write", "TaskCreate", "TaskUpdate"]);
    assert.deepEqual(first.provider, { only: ["test"], require_parameters: true });
    assert.deepEqual(first.reasoning, { effort: "high" });
    assert.equal(first.session_id, "chat-1");
    assert.match(first.messages[0].content, /# Permission: Modify all files in Notebook\/Folder/);
    assert.match(first.messages[0].content, /Answer in British English\./);
    assert.match(first.messages[1].content, /<referenced_file path="Research\/plan\.md" \/>/);
    assert.ok(!first.messages[1].content.includes("old attached copy"));
    assert.equal(first.messages[2].content, "It is 40k.");
    assert.match(first.messages[3].content, /^<environment>[\s\S]*Current notebook: Research[\s\S]*File the user is viewing: Research\/plan\.md[\s\S]*Open in the editor: Research\/plan\.md \(active\)\n[\s\S]*You may modify: any file in the notebook "Research"/);
    assert.match(first.messages[3].content, /<notebook_conventions path="Research\/AGENT_NOTES\.md">\nTags use #kebab-case\./);
    assert.match(first.messages[3].content, /<selection from="Research\/plan\.md">\nThe Q3 budget is 40k\.\n<\/selection>[\s\S]*Raise it to 50k\.$/);

    // The second request carries the reply, merged reasoning, and one result per call, in order.
    const second = bodies[1] as { messages: { role: string; content: string; tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; reasoning_details?: unknown }[] };
    const assistant = second.messages[4];
    assert.equal(assistant.content, "Let me look.");
    assert.deepEqual(assistant.tool_calls?.map((call) => [call.id, call.function.name, JSON.parse(call.function.arguments)]), [
      ["call_grep", "Grep", { pattern: "budget", output_mode: "content" }],
      ["call_read", "Read", { file_path: "Research/plan.md" }],
    ]);
    assert.deepEqual(assistant.reasoning_details, [{ type: "reasoning.text", index: 0, text: "Think carefully.", format: "test", signature: "sig" }]);
    assert.deepEqual(second.messages.slice(5).map((message) => [message.role, message.tool_call_id]), [["tool", "call_grep"], ["tool", "call_read"]]);
    assert.match(second.messages[5].content, /Research\/plan\.md:3:The Q3 budget is 40k\./);
    assert.match(second.messages[6].content, /^ {5}1\t# Plan/);
    const third = bodies[2] as { messages: { role: string; content: string }[] };
    assert.match(third.messages.at(-1)!.content, /^Edited Research\/plan\.md\.\nEdited region:[\s\S]*3\tThe Q3 budget is 50k\./);

    const runId = (events[0] as { runId: string }).runId;
    const undone = await UNDO(request("/api/agent/undo", { runId }));
    assert.deepEqual((await undone.json()).results, [{ path: "Research/plan.md", status: "restored", content: "# Plan\n\nThe Q3 budget is 40k.\n" }]);
    assert.equal(await readFile(path.join(root, "Research", "plan.md"), "utf8"), "# Plan\n\nThe Q3 budget is 40k.\n");
    assert.equal((await UNDO(request("/api/agent/undo", { runId: "../escape" }))).status, 400);
  });
});

test("unsaved drafts are what the agent reads and edits, and models without tools are refused", async () => {
  await withLibrary(async (root) => {
    const replies = [
      () => reply({ calls: [{ id: "a", name: "Read", args: { file_path: "Research/plan.md" } }] }),
      () => reply({ calls: [{ id: "b", name: "Edit", args: { file_path: "Research/plan.md", old_string: "Unsaved", new_string: "Saved by agent" } }] }),
      () => reply({ text: "Done." }),
    ];
    let toolless = false;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/endpoints")) return toolless ? endpoints(["temperature"]) : endpoints();
      return replies.shift()!();
    };
    const response = await POST(request("/api/agent", {
      permission: "open-files", activeFile: "Research/plan.md", openFiles: ["Research/plan.md"],
      drafts: { "Research/plan.md": "# Plan\n\nUnsaved text.\n", "Research/ideas/atlas.md": "ignored: not open" },
      messages: [userMessage("Polish it.")],
    }));
    const events: AgentEvent[] = [];
    await readAgentEvents(response, new AbortController().signal, (event) => events.push(event));
    assert.deepEqual(events.at(-1), { type: "done", outcome: "completed" });
    assert.equal(await readFile(path.join(root, "Research", "plan.md"), "utf8"), "# Plan\n\nSaved by agent text.\n");
    const runId = (events[0] as { runId: string }).runId;
    const [result] = (await (await UNDO(request("/api/agent/undo", { runId }))).json()).results;
    assert.deepEqual(result, { path: "Research/plan.md", status: "restored", content: "# Plan\n\nThe Q3 budget is 40k.\n", draft: "# Plan\n\nUnsaved text.\n" });

    toolless = true;
    const refused: AgentEvent[] = [];
    await readAgentEvents(await POST(request("/api/agent", { permission: "read-only", model: "test/no-tools", messages: [userMessage("Hi")] })), new AbortController().signal, (event) => refused.push(event));
    assert.equal(refused.length, 1);
    assert.match((refused[0] as { message: string }).message, /cannot call tools/);
  });
});

function loopContext(root: string, events: AgentEvent[]): ToolContext {
  void root;
  return {
    permission: "read-only", notebook: "Research", notebooks: ["Personal", "Research"], openFiles: new Set(), drafts: new Map(), fileState: new Map(),
    tasks: [], snapshots: new RunSnapshots("loop-run-0001"), changed: new Map(), maxResultChars: 40_000,
    signal: new AbortController().signal, emit: (event) => events.push(event),
  };
}

test("the loop answers malformed calls with errors, never runs cut-off calls, nudges open tasks, and stops when stuck", async () => {
  await withLibrary(async (root) => {
    const sent: { messages: { role: string; content: string; tool_call_id?: string }[] }[] = [];
    const replies = [
      () => reply({ calls: [
        { id: "x1", name: "Bash", args: { command: "ls" } },
        { id: "x2", name: "read", args: {}, rawArguments: "{\"file_path\": " },
        { id: "x3", name: "TaskCreate", args: { subject: "Check notes" } },
      ] }),
      () => reply({ calls: [{ id: "cut", name: "Read", args: { file_path: "Research/plan.md" } }], finish: "length" }),
      () => reply({ text: "All done." }),
      () => reply({ calls: [{ id: "t1", name: "TaskUpdate", args: { taskId: "1", status: "completed" } }] }),
      () => reply({ text: "Finished." }),
    ];
    globalThis.fetch = async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return replies.shift()!(); };
    const events: AgentEvent[] = [];
    const context = loopContext(root, events);
    const profile = { contextLength: 200_000, supportsTools: true, known: true };
    const result = await runAgent({ model: "test/agent-model", profile, system: "System", messages: [{ role: "user", content: "Go" }], tools: toolsForPermission("read-only"), context, emit: (event) => events.push(event), signal: new AbortController().signal });
    assert.deepEqual(result, { outcome: "completed" });
    const toolResults = sent[1].messages.filter((message) => message.role === "tool");
    assert.match(toolResults[0].content, /^Error: There is no tool named "Bash"\. Available tools: Glob, Grep, Read, TaskCreate, TaskUpdate\./);
    assert.match(toolResults[1].content, /^Error: Could not parse the Read arguments as JSON/);
    assert.match(toolResults[2].content, /Created task #1/);
    assert.match(sent[2].messages.at(-1)!.content, /^Error: Your reply was cut off/);
    assert.ok(!events.some((event) => event.type === "tool_started" && event.id === "cut"));
    assert.match(sent[3].messages.at(-1)!.content, /^\[Libera\] You still have open tasks \(#1 Check notes\)/);
    assert.equal(sent.length, 5);

    const repeating = Array.from({ length: 8 }, (_, index) => () => reply({ calls: [{ id: `r${index}`, name: "Glob", args: { pattern: "*.md" } }] }));
    globalThis.fetch = async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return repeating.shift()!(); };
    sent.length = 0;
    const stuck = await runAgent({ model: "test/agent-model", profile, system: "System", messages: [{ role: "user", content: "Go" }], tools: toolsForPermission("read-only"), context: loopContext(root, []), emit: () => undefined, signal: new AbortController().signal });
    assert.equal(stuck.outcome, "stuck");
    assert.equal(sent.length, 5);
    assert.match(sent[3].messages.at(-1)!.content, /You are repeating the same tool call/);

    globalThis.fetch = async () => Response.json({ error: { message: "Insufficient credits" } }, { status: 402 });
    const failed = await runAgent({ model: "test/agent-model", profile, system: "System", messages: [{ role: "user", content: "Go" }], tools: toolsForPermission("read-only"), context: loopContext(root, []), emit: () => undefined, signal: new AbortController().signal });
    assert.equal(failed.outcome, "error");
    assert.match(failed.message ?? "", /insufficient credits/i);

    const controller = new AbortController();
    globalThis.fetch = async (_input, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const stopping = runAgent({ model: "test/agent-model", profile, system: "System", messages: [{ role: "user", content: "Go" }], tools: toolsForPermission("read-only"), context: loopContext(root, []), emit: () => undefined, signal: controller.signal });
    controller.abort();
    assert.deepEqual(await stopping, { outcome: "stopped" });
  });
});

test("optional parameters are sent only where the model's tool providers accept them", () => {
  const endpoint = (tag: string, ...parameters: string[]) => ({ tag, parameters: ["tools", ...parameters] });
  const profile = (endpoints: { tag: string; parameters: string[] }[]) => ({ contextLength: 1_000_000, supportsTools: true, known: true, endpoints });
  // Reasoning-only models (no temperature) still route.
  assert.deepEqual(optionalParameters("openai/x", profile([endpoint("openai", "reasoning"), endpoint("azure", "reasoning")])), { reasoning: true, temperature: false });
  // Temperature on only some providers would narrow routing, so it is left out.
  assert.deepEqual(optionalParameters("google/x", profile([endpoint("google-ai-studio", "reasoning", "temperature"), endpoint("google-vertex/global", "reasoning")])), { reasoning: true, temperature: false });
  assert.deepEqual(optionalParameters("m/x", profile([endpoint("a", "temperature"), endpoint("b", "temperature")])), { reasoning: false, temperature: true });
  // Caching providers narrow the eligible set; a root tag covers its variants.
  assert.deepEqual(optionalParameters("m/x", profile([endpoint("a/eu", "temperature"), endpoint("b")]), ["a"]), { reasoning: false, temperature: true });
  assert.throws(() => optionalParameters("m/x", profile([{ tag: "a", parameters: ["temperature"] }, endpoint("b")]), ["a"]), /None of the prompt-caching providers for m\/x can call tools/);
  assert.deepEqual(optionalParameters("m/x", { contextLength: 1, supportsTools: true, known: false }), { reasoning: true, temperature: true });
});
