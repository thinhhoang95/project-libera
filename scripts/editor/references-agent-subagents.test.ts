import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../../src/lib/agent/runner";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import { runSubagents, validateJsonSchema, type SubagentTask } from "../../src/lib/agent/subagents";
import { ALL_TOOLS, ok, ToolError, toolsForPermission, type AgentTool, type ToolContext } from "../../src/lib/agent/tools";
import { compactAgentRunRecord, validateAgentRunRecord, type AgentEvent, type AgentRunRecord } from "../../src/lib/agent/types";

type Call = { id: string; name: string; args: unknown };
type ModelBody = { model: string; messages: { role: string; content: string; tool_call_id?: string }[]; tools?: { function: { name: string } }[] };

function sse(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

function reply({ text = "", calls = [], input = 1000 }: { text?: string; calls?: Call[]; input?: number }) {
  const chunks: unknown[] = [];
  if (text) chunks.push({ choices: [{ delta: { content: text } }] });
  calls.forEach((call, index) => chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }));
  chunks.push({ choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
  chunks.push({ choices: [], usage: { prompt_tokens: input, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 } } });
  return sse(chunks);
}

const profile = { contextLength: 200_000, supportsTools: true, known: true };

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-subagents-"));
  const previous = { data: process.env.LIBERA_DATA_DIR, key: process.env.OPENROUTER_API_KEY };
  const originalFetch = globalThis.fetch;
  process.env.LIBERA_DATA_DIR = directory;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    await mkdir(path.join(directory, "users", "admin", "Research"), { recursive: true });
    await writeFile(path.join(directory, "users", "admin", "Research", "smith2020.md"), "Smith (2020) found a 12% gain.\n");
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ LIBERA_DATA_DIR: previous.data, OPENROUTER_API_KEY: previous.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

/** Replies chosen by the child's prompt (its first user message) and turn number. */
function scriptedModel(script: (prompt: string, turn: number, body: ModelBody) => Response | Promise<Response>) {
  const turns = new Map<string, number>();
  const bodies: ModelBody[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as ModelBody;
    bodies.push(body);
    const prompt = body.messages.find((message) => message.role === "user")!.content;
    const turn = turns.get(prompt) ?? 0;
    turns.set(prompt, turn + 1);
    return script(prompt, turn, body);
  };
  return bodies;
}

function parentContext(events: AgentEvent[], patch: Partial<ToolContext> = {}): ToolContext {
  return {
    permission: "notebook", skills: [], loadedSkills: new Set(["some-skill"]), skillState: new Map([["some-skill", { parent: true }]]),
    notebook: "Research", notebooks: ["Research"], openFiles: new Set(["Research/smith2020.md"]), drafts: new Map(),
    fileState: new Map([["Research/plan.md", { hash: "x", partial: false }]]), tasks: [{ id: "1", subject: "Parent task", status: "pending" }],
    snapshots: new RunSnapshots("parent-run-0001"), changed: new Map(), maxResultChars: 40_000,
    signal: new AbortController().signal, emit: (event) => events.push(event),
    runConfig: { model: "test/agent-model", profile }, budget: { maxInputTokens: 1_000_000, inputTokens: 0 }, usage: { inputTokens: 0, outputTokens: 0 },
    ...patch,
  };
}

const verdictTool: AgentTool = {
  name: "SubmitVerdicts",
  kind: "read",
  description: "Submit the verdicts.",
  parameters: {
    type: "object",
    properties: {
      verdicts: { type: "array", minItems: 1, items: { type: "object", properties: { id: { type: "string" }, verdict: { type: "string", enum: ["supported", "not-supported"] } }, required: ["id", "verdict"], additionalProperties: false } },
    },
    required: ["verdicts"],
    additionalProperties: false,
  },
  describe: () => "Submitting verdicts",
  async run(args) {
    // Beyond the schema: the tool itself may refuse a result.
    if ((args.verdicts as { id: string }[]).some((item) => item.id === "c9")) throw new ToolError("There is no occurrence c9.");
    return ok("Verdicts received.", "Submitted");
  },
};

test("runAgent returns the final text and the summed usage of every turn", async () => {
  await withLibrary(async () => {
    const replies = [
      () => reply({ text: "Looking.", calls: [{ id: "g", name: "Glob", args: { pattern: "*.md" } }] }),
      () => reply({ text: "All done." }),
    ];
    globalThis.fetch = async () => replies.shift()!();
    const events: AgentEvent[] = [];
    const context = parentContext(events, { permission: "read-only", tasks: [], budget: undefined, usage: undefined });
    const result = await runAgent({ model: "test/agent-model", profile, system: "S", messages: [{ role: "user", content: "Go" }], tools: toolsForPermission("read-only"), context, emit: (event) => events.push(event), signal: context.signal });
    assert.deepEqual(result, { outcome: "completed", finalText: "All done.", usage: { inputTokens: 2000, outputTokens: 100, cachedTokens: 800 } });
    assert.deepEqual(context.usage, result.usage);
  });
});

test("child runs are isolated, forward only steps and usage, and return validated submissions", async () => {
  await withLibrary(async () => {
    const seen: ToolContext[] = [];
    const probe: AgentTool = { name: "Probe", kind: "read", description: "Probe.", parameters: { type: "object", properties: {} }, describe: () => "Probing", async run(_args, context) { seen.push(context); return ok("probed", "Probed"); } };
    scriptedModel((prompt, turn) => {
      if (prompt === "Check smith2020") {
        return [
          () => reply({ text: "Reading the source.", calls: [{ id: "r1", name: "Read", args: { file_path: "Research/smith2020.md" } }, { id: "p1", name: "Probe", args: {} }] }),
          () => reply({ calls: [{ id: "s1", name: "SubmitVerdicts", args: { verdicts: [{ id: "c1", verdict: "supported" }] } }] }),
        ][turn]();
      }
      return [
        () => reply({ calls: [{ id: "p2", name: "Probe", args: {} }] }),
        () => reply({ text: "Lee checked; nothing to submit." }),
      ][turn]();
    });
    const events: AgentEvent[] = [];
    const drafts = new Map([["Research/smith2020.md", "Smith (2020) found a 12% gain.\n"]]);
    const parent = parentContext(events, { drafts, allowWebSearch: false });
    const read = ALL_TOOLS.find((tool) => tool.name === "Read")!;
    const tasks: SubagentTask[] = [
      { label: "Checking smith2020", system: "Verify.", prompt: "Check smith2020", tools: [read, probe], submitTool: verdictTool },
      { label: "Checking lee2021", system: "Verify.", prompt: "Check lee2021", tools: [probe] },
    ];
    const [smith, lee] = await runSubagents(parent, tasks);

    assert.equal(smith.ok, true);
    assert.deepEqual(smith.ok && smith.value, { verdicts: [{ id: "c1", verdict: "supported" }] });
    assert.equal(smith.outcome, "completed");
    assert.equal(smith.steps, 3);
    assert.equal(smith.finalText, "Reading the source.");
    assert.deepEqual(smith.usage, { inputTokens: 2000, outputTokens: 100, cachedTokens: 800 });
    // Without a submit tool, the final text is the result.
    assert.equal(lee.ok, true);
    assert.equal(lee.ok && lee.value, "Lee checked; nothing to submit.");

    // Isolation: fresh working state, read-only, sharing only the listed things.
    assert.equal(seen.length, 2);
    for (const child of seen) {
      assert.notEqual(child, parent);
      assert.equal(child.permission, "read-only");
      assert.notEqual(child.fileState, parent.fileState);
      assert.notEqual(child.skillState, parent.skillState);
      assert.notEqual(child.loadedSkills, parent.loadedSkills);
      assert.notEqual(child.tasks, parent.tasks);
      assert.notEqual(child.changed, parent.changed);
      assert.notEqual(child.snapshots, parent.snapshots);
      assert.deepEqual(child.skills, []);
      assert.equal(child.drafts, parent.drafts);
      assert.equal(child.openFiles, parent.openFiles);
      assert.equal(child.signal, parent.signal);
      assert.equal(child.budget, parent.budget);
      assert.equal(child.maxResultChars, parent.maxResultChars);
    }
    assert.deepEqual(seen.map((child) => child.fileState.has("Research/smith2020.md")).sort(), [false, true], "the child's Read is recorded in its own state only");
    assert.deepEqual([...parent.fileState.keys()], ["Research/plan.md"], "the parent's state is untouched");
    assert.deepEqual([...parent.skillState.keys()], ["some-skill"]);
    assert.equal(parent.tasks.length, 1);
    await assert.rejects(seen[1].snapshots.recordOriginal("Research/x.md", "x"), /Child runs cannot change files/);

    // Events: started, tool steps (running then finished), usage, finished; never the child's text.
    assert.ok(!events.some((event) => event.type === "text_delta"));
    const smithEvents = events.filter((event) => "id" in event && event.id === smith.id);
    assert.deepEqual(smithEvents.map((event) => event.type), ["subagent_started", "subagent_step", "subagent_step", "subagent_step", "subagent_step", "subagent_step", "subagent_step", "subagent_finished"]);
    assert.deepEqual(smithEvents[0], { type: "subagent_started", id: smith.id, label: "Checking smith2020" });
    const steps = smithEvents.filter((event): event is Extract<AgentEvent, { type: "subagent_step" }> => event.type === "subagent_step").map((event) => [event.step.id, event.step.name, event.step.summary, event.step.status]);
    assert.deepEqual(steps.slice(0, 2), [["r1", "Read", "Reading Research/smith2020.md", "running"], ["p1", "Probe", "Probing", "running"]]);
    assert.deepEqual(steps.at(-1), ["s1", "SubmitVerdicts", "Submitting verdicts", "ok"]);
    assert.deepEqual(smithEvents.at(-1), { type: "subagent_finished", id: smith.id, label: "Checking smith2020", outcome: "completed", usage: smith.usage });
    // Usage reaches the parent's stream turn by turn, and its total.
    assert.equal(events.filter((event) => event.type === "usage").length, 4);
    assert.deepEqual(parent.usage, { inputTokens: 4000, outputTokens: 200, cachedTokens: 1600 });
    assert.equal(parent.budget!.inputTokens, 4000);
  });
});

test("an invalid submission gets one repair round; a missing one one reminder", async () => {
  await withLibrary(async () => {
    const bodies = scriptedModel((prompt, turn) => {
      const submit = (args: unknown, id = `s${turn}`) => reply({ calls: [{ id, name: "SubmitVerdicts", args }] });
      if (prompt === "repairs") return [() => submit({ verdicts: [{ id: "c1", verdict: "maybe" }] }), () => submit({ verdicts: [{ id: "c1", verdict: "not-supported" }] })][turn]();
      if (prompt === "never valid") return [() => submit({ verdicts: [] }), () => submit({ verdicts: [{ id: "c9", verdict: "supported" }] }), () => reply({ text: "unreachable" })][turn]();
      if (prompt === "forgets") return [() => reply({ text: "Done checking." }), () => reply({ text: "Really done." })][turn]();
      return [() => reply({ text: "Oops." }), () => submit({ verdicts: [{ id: "c2", verdict: "supported" }] })][turn]();
    });
    const events: AgentEvent[] = [];
    const task = (prompt: string): SubagentTask => ({ label: prompt, system: "Verify.", prompt, tools: [], submitTool: verdictTool });
    const [repaired, invalid, missing, reminded] = await runSubagents(parentContext(events), [task("repairs"), task("never valid"), task("forgets"), task("reminded")]);

    assert.equal(repaired.ok, true);
    assert.deepEqual(repaired.ok && repaired.value, { verdicts: [{ id: "c1", verdict: "not-supported" }] });
    const repairBody = bodies.find((body) => body.messages[1].content === "repairs" && body.messages.some((message) => message.role === "tool"))!;
    assert.match(repairBody.messages.at(-1)!.content, /^Error: SubmitVerdicts was not accepted:\n- arguments\.verdicts\[0\]\.verdict must be one of "supported", "not-supported"\.\nFix these/);

    assert.equal(invalid.ok, false);
    assert.match(!invalid.ok ? invalid.reason : "", /SubmitVerdicts was still invalid after a repair round: There is no occurrence c9\./);
    assert.equal(bodies.filter((body) => body.messages[1].content === "never valid").length, 2, "the run ends after the second invalid submission");

    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.reason, "The check finished without calling SubmitVerdicts.");
    const nudged = bodies.filter((body) => body.messages[1].content === "forgets");
    assert.equal(nudged.length, 2);
    assert.match(nudged[1].messages.at(-1)!.content, /^\[Libera\] You have not called SubmitVerdicts yet\./);

    assert.equal(reminded.ok, true, "a reminded child that then submits succeeds");
    assert.deepEqual(validateJsonSchema(verdictTool.parameters, { verdicts: [{ id: 3, verdict: "supported", extra: true }], more: 1 }), [
      "arguments.verdicts[0].id must be string, not integer.",
      "arguments.verdicts[0] has an unknown property \"extra\".",
      "arguments has an unknown property \"more\".",
    ]);
  });
});

test("children run at most `concurrency` at once", async () => {
  await withLibrary(async () => {
    let running = 0;
    let peak = 0;
    scriptedModel(async (prompt) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running--;
      return reply({ text: `answer to ${prompt}` });
    });
    const tasks = Array.from({ length: 5 }, (_, index): SubagentTask => ({ label: `Task ${index}`, system: "S", prompt: `task ${index}`, tools: [] }));
    const results = await runSubagents(parentContext([]), tasks, { concurrency: 2 });
    assert.equal(peak, 2);
    assert.deepEqual(results.map((result) => result.ok && result.value), tasks.map((task) => `answer to ${task.prompt}`), "results keep task order");

    peak = 0;
    await runSubagents(parentContext([]), Array.from({ length: 6 }, (_, index): SubagentTask => ({ label: `T${index}`, system: "S", prompt: `again ${index}`, tools: [] })));
    assert.equal(peak, 4, "the default limit is 4");
  });
});

test("a used-up budget keeps pending children from starting; Stop ends them all", async () => {
  await withLibrary(async () => {
    scriptedModel(() => reply({ text: "ok", input: 1000 }));
    const events: AgentEvent[] = [];
    const parent = parentContext(events, { budget: { maxInputTokens: 1500, inputTokens: 0 } });
    const tasks = ["a", "b", "c"].map((name): SubagentTask => ({ label: name, system: "S", prompt: name, tools: [] }));
    const results = await runSubagents(parent, tasks, { concurrency: 1 });
    assert.deepEqual(results.map((result) => result.outcome), ["completed", "completed", "budget"]);
    assert.equal(!results[2].ok && results[2].reason, "Not started: the run's token budget was used up.");
    assert.deepEqual(events.filter((event) => event.type === "subagent_finished").map((event) => (event as { outcome: string }).outcome), ["completed", "completed", "budget"]);
    // A run that shares the budget stops at its next turn once it is used up.
    const over = await runAgent({ model: "m", profile, system: "S", messages: [{ role: "user", content: "x" }], tools: [], context: parentContext([], { budget: parent.budget }), emit: () => undefined, signal: new AbortController().signal });
    assert.equal(over.outcome, "limit");
    assert.match(over.message ?? "", /token budget \(1,500 input tokens, child runs included\) is used up/);

    const controller = new AbortController();
    let started = 0;
    globalThis.fetch = async (_input, init) => {
      started++;
      queueMicrotask(() => controller.abort());
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    };
    const stopped = await runSubagents(parentContext([], { signal: controller.signal }), tasks, { concurrency: 1 });
    assert.deepEqual(stopped.map((result) => result.outcome), ["stopped", "stopped", "stopped"]);
    assert.equal(started, 1, "nothing starts after Stop");
  });
});

test("run records with subagent steps and suggested edits validate, as do older records", () => {
  const old: AgentRunRecord = { runId: "run-1", permission: "read-only", steps: [{ kind: "text", text: "Hi" }, { kind: "tool", id: "t", name: "Read", summary: "Reading a.md", status: "ok" }], tasks: [], changes: [], comments: [{ path: "a.md", count: 1 }], outcome: "completed" };
  assert.equal(validateAgentRunRecord(old), true);
  const run: AgentRunRecord = {
    ...old,
    steps: [...old.steps, {
      kind: "subagent", id: "sub-1", label: "Checking smith2020, lee2021", status: "finished", outcome: "budget", stepCount: 3,
      steps: [{ id: "r1", name: "Read", summary: "Reading smith.pdf", status: "ok", result: "Pages 1-3" }], usage: { inputTokens: 10, outputTokens: 2 },
    }],
    suggestions: [{ path: "a.md", count: 2 }],
  };
  assert.equal(validateAgentRunRecord(run), true);
  assert.equal(validateAgentRunRecord({ ...run, suggestions: [{ path: "a.md", count: -1 }] }), false);
  assert.equal(validateAgentRunRecord({ ...run, steps: [{ ...run.steps[2], status: "done" }] }), false);
  assert.equal(validateAgentRunRecord({ ...run, steps: [{ ...run.steps[2], outcome: "maybe" }] }), false);
  assert.equal(validateAgentRunRecord({ ...run, steps: [{ ...run.steps[2], steps: [{ id: "x", name: "Read", summary: "s", status: "nope" }] }] }), false);
  // Compaction drops old tool steps first and keeps subagent lines.
  const long: AgentRunRecord = { ...run, steps: [...Array.from({ length: 400 }, (_, index) => ({ kind: "tool" as const, id: `t${index}`, name: "Read", summary: "r", status: "ok" as const })), run.steps[2]] };
  const compacted = compactAgentRunRecord(long);
  assert.equal(compacted.steps.length, 400);
  assert.equal(compacted.steps.at(-1)!.kind, "subagent");
  assert.equal(validateAgentRunRecord(compacted), true);
});
