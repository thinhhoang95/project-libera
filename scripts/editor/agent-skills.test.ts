import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentConversation } from "../../src/lib/agent/conversation";
import { buildAgentSystemPrompt } from "../../src/lib/agent/prompt";
import { CommentSyntaxError, locateComments, parseReviewCopy, placeComments, renderReviewCopy } from "../../src/lib/agent/review-comments";
import { runAgent } from "../../src/lib/agent/runner";
import { AGENT_SKILLS } from "../../src/lib/agent/skills";
import { RunSnapshots } from "../../src/lib/agent/snapshots";
import { activeTools, ALL_TOOLS, toolsForPermission, type AgentTool, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent, AgentPermission } from "../../src/lib/agent/types";
import type { ReviewDocument } from "../../src/lib/markdown-review";

const PLAN = "# Plan\n\nThe Q3 budget is 40k.\nAtlas launches in May.\n\n- Hire\n- Ship\n";

async function withLibrary(run: (root: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-agent-skills-"));
  const previous = { data: process.env.LIBERA_DATA_DIR, key: process.env.OPENROUTER_API_KEY };
  const originalFetch = globalThis.fetch;
  process.env.LIBERA_DATA_DIR = directory;
  process.env.OPENROUTER_API_KEY = "test-key";
  const root = path.join(directory, "users", "admin");
  try {
    await mkdir(path.join(root, "Research"), { recursive: true });
    await writeFile(path.join(root, "Research", "plan.md"), PLAN);
    await writeFile(path.join(root, "Research", "notes.txt"), "Plain notes.\n");
    await writeFile(path.join(root, "Research", "marked.md"), "Intro.\n\n:::comment\nAlready here.\n:::\n");
    await run(root);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of Object.entries({ LIBERA_DATA_DIR: previous.data, OPENROUTER_API_KEY: previous.key })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function makeContext(permission: AgentPermission = "read-only") {
  const events: AgentEvent[] = [];
  const context: ToolContext = {
    permission, skills: AGENT_SKILLS, loadedSkills: new Set(), skillState: new Map(),
    notebook: "Research", notebooks: ["Research"], openFiles: new Set(), drafts: new Map(), fileState: new Map(),
    tasks: [], snapshots: new RunSnapshots(`run-${Math.random().toString(36).slice(2, 12)}`), changed: new Map(), maxResultChars: 40_000,
    signal: new AbortController().signal, emit: (event) => events.push(event),
  };
  return { context, events };
}

async function call(context: ToolContext, name: string, args: Record<string, unknown>) {
  const tool = activeTools(ALL_TOOLS, context).find((candidate: AgentTool) => candidate.name === name)!;
  try { return await tool.run(args, context); }
  catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true, result: "" }; }
}

async function reviews(root: string) {
  return (JSON.parse(await readFile(path.join(root, ".libera", "markdown-reviews.json"), "utf8")) as { documents: ReviewDocument[] }).documents;
}

const block = (text: string) => `:::comment\n${text}\n:::`;

test("review copies parse comment blocks and map them back to the original text", () => {
  const offset = PLAN.indexOf("May.") + 4;
  const rendered = renderReviewCopy(PLAN, [{ offset, text: "Which year?" }]);
  assert.equal(rendered, PLAN.replace("May.\n", `May.\n\n${block("Which year?")}\n`));
  assert.deepEqual(locateComments(PLAN, rendered), [{ offset, text: "Which year?" }]);

  // The model's own spacing and quote style do not matter; comments may be one line.
  const quoted = "He said “go”.\n\nNext.\n";
  assert.deepEqual(locateComments(quoted, `He said "go".\n:::comment Too terse. :::\nNext.\n`), [{ offset: quoted.indexOf("\n"), text: "Too terse." }]);
  assert.deepEqual(parseReviewCopy("A\n:::comment\nB\n\nC\n:::\nD").comments, ["B\n\nC"]);

  assert.throws(() => locateComments(PLAN, rendered.replace("40k", "45k")), (error: unknown) => error instanceof CommentSyntaxError && /changes the document on line 3, where the document has “The Q3 budget is 40k\.”, but your text has “The Q3 budget is 45k\.”/.test(error.message));
  assert.throws(() => locateComments(PLAN, rendered.replace("- Ship\n", "")), /leaves out document text from line 7 on: “- Ship”/);
  assert.throws(() => parseReviewCopy("A\n:::comment\nB\n"), /opened on line 2 of your review copy has no closing ":::" line/);
  assert.throws(() => parseReviewCopy("A\n:::comment\nB\n:::comment\nC\n:::"), /opened on line 2 is not closed before the next ":::comment" on line 4/);
  assert.throws(() => parseReviewCopy("A\n:::comment\n\n:::"), /is empty/);
  assert.throws(() => parseReviewCopy("A :::comment B :::"), /must start its own line/);
});

test("comments attach to the block above them, and misplaced ones are explained", () => {
  const at = (text: string) => PLAN.indexOf(text) + text.length;
  const [paragraph, middle, item, list, heading, top] = placeComments(PLAN, [
    { offset: at("May."), text: "a" }, { offset: at("40k."), text: "b" }, { offset: at("- Hire"), text: "c" },
    { offset: at("- Ship"), text: "d" }, { offset: at("# Plan"), text: "e" }, { offset: 0, text: "f" },
  ], "markdown").sort((left, right) => left.text.localeCompare(right.text));
  assert.deepEqual(paragraph.anchor, { start: PLAN.indexOf("The Q3"), end: at("May.") });
  assert.match(middle.problem!, /^is inside the paragraph on lines 3-4\. Move it below the paragraph's last line \(line 4\)\.$/);
  assert.deepEqual(item.anchor, { start: PLAN.indexOf("- Hire"), end: at("- Hire") });
  assert.deepEqual(list.anchor, { start: PLAN.indexOf("- Ship"), end: at("- Ship") });
  assert.deepEqual(heading.anchor, { start: 0, end: at("# Plan") });
  assert.match(top.problem!, /^has no paragraph directly above it/);

  const code = "Intro.\n\n```js\nrun();\nstop();\n```\n";
  assert.match(placeComments(code, [{ offset: code.indexOf("run();") + 6, text: "x" }], "markdown")[0].problem!, /inside the code block on lines 3-6/);
  const latex = "\\section{A}\n\nOne\ntwo.\n\nThree.";
  const [inside, after] = placeComments(latex, [{ offset: latex.indexOf("One") + 3, text: "x" }, { offset: latex.indexOf("two.") + 4, text: "y" }], "latex");
  assert.match(inside.problem!, /inside the paragraph on lines 3-4/);
  assert.deepEqual(after.anchor, { start: latex.indexOf("One"), end: latex.indexOf("two.") + 4 });
});

test("skills are listed by name and loaded on demand, and their tools appear once loaded", async () => {
  const system = buildAgentSystemPrompt({ permission: "read-only", mathInstruction: "Use $.", skills: AGENT_SKILLS });
  assert.match(system, /# Skills\n[\s\S]*\n- leave-review-comments: Review a Markdown or LaTeX document/);
  assert.ok(!system.includes(":::comment"), "instructions stay out of the system prompt");

  await withLibrary(async () => {
    const { context } = makeContext();
    assert.ok(!activeTools(toolsForPermission("read-only"), context).some((tool) => tool.name === "LeaveComment"));
    assert.match((await call(context, "Skill", { name: "review" })).text, /There is no skill named "review"\. Available skills: leave-review-comments, fact-check-citations./);
    const loaded = await call(context, "Skill", { name: "leave-review-comments" });
    assert.match(loaded.text, /^<skill name="leave-review-comments">\n# Leaving review comments[\s\S]*<\/skill>\n\n\(Tools now available: LeaveComment, SuggestEdit\.\)$/);
    assert.deepEqual(activeTools(toolsForPermission("read-only"), context).map((tool) => tool.name), ["Glob", "Grep", "Read", "TaskCreate", "TaskUpdate", "Skill", "References", "LeaveComment", "SuggestEdit"]);
    assert.equal((await call(context, "Skill", { name: "leave-review-comments" })).result, "Already loaded");
  });
});

test("LeaveComment edits only a review copy, reports placement at once, and compiles into agent review threads", async () => {
  await withLibrary(async (root) => {
    const { context, events } = makeContext();
    await call(context, "Skill", { name: "leave-review-comments" });
    assert.match((await call(context, "LeaveComment", { file_path: "Research/plan.md", old_string: "40k.", new_string: `40k.\n${block("Check this figure.")}` })).text, /Read Research\/plan\.md before commenting on it/);
    await call(context, "Read", { file_path: "Research/plan.md" });
    await call(context, "Read", { file_path: "Research/notes.txt" });
    await call(context, "Read", { file_path: "Research/marked.md" });
    assert.match((await call(context, "LeaveComment", { file_path: "Research/notes.txt", old_string: "Plain", new_string: "x" })).text, /not a Markdown or LaTeX file/);
    assert.match((await call(context, "LeaveComment", { file_path: "Research/marked.md", old_string: "Intro.", new_string: `Intro.\n${block("x")}` })).text, /itself contains ":::comment" lines/);

    const misplaced = await call(context, "LeaveComment", { file_path: "Research/plan.md", old_string: "The Q3 budget is 40k.", new_string: `The Q3 budget is 40k.\n\n${block("Check this figure.")}` });
    assert.equal(misplaced.isError, false);
    assert.equal(misplaced.result, "1 comment to fix");
    assert.match(misplaced.text, /Comment 1 \(“Check this figure\.”\) is inside the paragraph on lines 3-4\. Move it below the paragraph's last line \(line 4\)\./);
    assert.match(misplaced.text, /Review copy now:\n[\s\S]*The Q3 budget is 40k\.\n\n:::comment\nCheck this figure\.\n:::\nAtlas launches in May\./);
    assert.equal(await readFile(path.join(root, "Research", "plan.md"), "utf8"), PLAN, "the file never changes");

    const changed = await call(context, "LeaveComment", { file_path: "Research/plan.md", old_string: "Atlas launches in May.", new_string: `Atlas launches in June.\n${block("x")}` });
    assert.match(changed.text, /^Nothing was changed\. Only :::comment blocks may be added, moved or removed/);

    // Moving the comment uses the block as LeaveComment showed it.
    const moved = await call(context, "LeaveComment", {
      file_path: "Research/plan.md",
      old_string: `The Q3 budget is 40k.\n\n${block("Check this figure.")}\nAtlas launches in May.`,
      new_string: `The Q3 budget is 40k.\nAtlas launches in May.\n\n${block("Check this figure.")}`,
    });
    assert.equal(moved.result, "1 comment placed");
    assert.match(moved.text, /attaches to lines 3-4: “The Q3 budget is 40k\.”/);
    await call(context, "LeaveComment", { file_path: "Research/plan.md", old_string: "- Ship", new_string: `- Ship\n\n${block("Ship what, and when?")}\n\n${block("Ship what, and when?")}` });

    assert.equal(await AGENT_SKILLS[0].finishPass!(context, { final: false }), null);
    const [review] = await reviews(root);
    assert.equal(review.key, "Research/plan.md");
    assert.equal(review.enabled, true);
    assert.deepEqual(review.threads.map((thread) => [thread.anchor.quote, thread.messages[0].text, thread.messages[0].author, thread.status]), [
      ["The Q3 budget is 40k.\nAtlas launches in May.", "Check this figure.", "agent", "open"],
      ["- Ship", "Ship what, and when?", "agent", "open"],
    ]);
    assert.ok(events.some((event) => event.type === "comments_added" && event.path === "Research/plan.md" && event.count === 2));
    assert.ok(events.some((event) => event.type === "tool_finished" && event.status === "ok" && event.result === "2 comments added"));
    assert.equal((context.skillState.get("leave-review-comments") as Map<string, unknown>).size, 0);
  });
});

function reply({ text = "", calls = [] }: { text?: string; calls?: { id: string; name: string; args: unknown }[] }) {
  const chunks: unknown[] = [];
  if (text) chunks.push({ choices: [{ delta: { content: text } }] });
  calls.forEach((item, index) => chunks.push({ choices: [{ delta: { tool_calls: [{ index, id: item.id, type: "function", function: { name: item.name, arguments: JSON.stringify(item.args) } }] } }] }));
  chunks.push({ choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}

type SentBody = { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
const profile = { contextLength: 200_000, supportsTools: true, known: true };
const misplace = { file_path: "Research/plan.md", old_string: "The Q3 budget is 40k.", new_string: `The Q3 budget is 40k.\n\n${block("Check this figure.")}` };

test("the loop compiles comments when the model finishes and sends misplaced ones back to fix", async () => {
  await withLibrary(async (root) => {
    const sent: SentBody[] = [];
    const replies = [
      () => reply({ calls: [
        { id: "s1", name: "Skill", args: { name: "leave-review-comments" } },
        { id: "r1", name: "Read", args: { file_path: "Research/plan.md" } },
        { id: "early", name: "LeaveComment", args: misplace },
      ] }),
      () => reply({ calls: [{ id: "c1", name: "LeaveComment", args: misplace }] }),
      () => reply({ text: "Left one comment." }),
      () => reply({ calls: [{ id: "c2", name: "LeaveComment", args: {
        file_path: "Research/plan.md",
        old_string: `40k.\n\n${block("Check this figure.")}\nAtlas launches in May.`,
        new_string: `40k.\nAtlas launches in May.\n\n${block("Check this figure.")}`,
      } }] }),
      () => reply({ text: "Fixed." }),
    ];
    globalThis.fetch = async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return replies.shift()!(); };
    const { context, events } = makeContext("read-only");
    const result = await runAgent({ model: "test/agent-model", profile, system: "System", messages: [{ role: "user", content: "Review my plan." }], tools: toolsForPermission("read-only"), context, emit: context.emit, signal: new AbortController().signal });

    assert.equal(result.outcome, "completed");
    assert.equal(sent.length, 5);
    assert.ok(!sent[0].tools.some((tool) => tool.function.name === "LeaveComment"));
    assert.ok(sent[1].tools.some((tool) => tool.function.name === "LeaveComment"));
    assert.match(sent[1].messages.at(-1)!.content, /^Error: LeaveComment belongs to the leave-review-comments skill/);
    assert.match(sent[3].messages.at(-1)!.content, /^\[Libera\] Your review comments are not finished: 1 comment cannot be attached where you put it\.\nResearch\/plan\.md:\n- Comment 1 \(“Check this figure\.”\) is inside the paragraph on lines 3-4/);
    const checks = events.filter((event) => event.type === "tool_finished" && event.id.startsWith("comments-"));
    assert.deepEqual(checks.map((event) => (event as { status: string; result: string }).result), ["1 comment to fix", "1 comment added"]);
    const [review] = await reviews(root);
    assert.deepEqual(review.threads.map((thread) => [thread.anchor.quote, thread.messages[0].author]), [["The Q3 budget is 40k.\nAtlas launches in May.", "agent"]]);
  });
});

test("after the feedback rounds, or when a run ends early, placed comments are kept and the rest reported", async () => {
  await withLibrary(async (root) => {
    const replies = [
      () => reply({ calls: [{ id: "s1", name: "Skill", args: { name: "leave-review-comments" } }, { id: "r1", name: "Read", args: { file_path: "Research/plan.md" } }] }),
      () => reply({ calls: [
        { id: "c1", name: "LeaveComment", args: misplace },
        { id: "c2", name: "LeaveComment", args: { file_path: "Research/plan.md", old_string: "- Ship", new_string: `- Ship\n\n${block("When?")}` } },
      ] }),
      ...Array.from({ length: 4 }, () => () => reply({ text: "Done." })),
    ];
    globalThis.fetch = async () => replies.shift()!();
    const { context, events } = makeContext();
    const result = await runAgent({ model: "test/agent-model", profile, system: "System", messages: [{ role: "user", content: "Review." }], tools: toolsForPermission("read-only"), context, emit: context.emit, signal: new AbortController().signal });
    assert.equal(result.outcome, "completed");
    assert.equal(replies.length, 0);
    const final = events.filter((event): event is Extract<AgentEvent, { type: "tool_finished" }> => event.type === "tool_finished").at(-1)!;
    assert.equal(final.status, "error");
    assert.equal(final.result, "1 comment added; 1 could not be placed");
    assert.match(final.detail!, /Comment 1 \(“Check this figure\.”\) is inside the paragraph[\s\S]*\n\nCheck this figure\.$/);
    assert.deepEqual((await reviews(root))[0].threads.map((thread) => thread.messages[0].text), ["When?"]);
  });

  await withLibrary(async (root) => {
    // The run hits its step limit before the model finishes; placed comments are still saved.
    const replies = [
      () => reply({ calls: [{ id: "s1", name: "Skill", args: { name: "leave-review-comments" } }, { id: "r1", name: "Read", args: { file_path: "Research/plan.md" } }] }),
      () => reply({ calls: [{ id: "c1", name: "LeaveComment", args: { file_path: "Research/plan.md", old_string: "May.", new_string: `May.\n\n${block("Which year?")}` } }] }),
    ];
    globalThis.fetch = async () => replies.shift()!();
    const { context, events } = makeContext();
    const result = await runAgent({ model: "test/agent-model", profile, system: "System", messages: [{ role: "user", content: "Review." }], tools: toolsForPermission("read-only"), context, emit: context.emit, signal: new AbortController().signal, limits: { maxIterations: 2 } });
    assert.equal(result.outcome, "limit");
    assert.ok(events.some((event) => event.type === "comments_added" && event.count === 1));
    assert.deepEqual((await reviews(root))[0].threads.map((thread) => thread.messages[0].text), ["Which year?"]);
  });
});

test("later turns are told which files got comments", () => {
  const [, assistant] = agentConversation([
    { id: "1", role: "user", text: "Review my plan." },
    { id: "2", role: "assistant", text: "Left two comments.", agent: { runId: "run-1", permission: "read-only", steps: [], tasks: [], changes: [], comments: [{ path: "Research/plan.md", count: 2 }] } },
    { id: "3", role: "user", text: "Thanks." },
  ], "<environment />", () => true);
  assert.equal(assistant.content, "Left two comments.\n\n[Review comments added in this turn: Research/plan.md (2)]");
});
