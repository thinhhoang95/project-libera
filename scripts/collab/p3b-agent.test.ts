// The agent in shared notebooks (plan M3.4) with real hosts and the real
// server: Bob is a commenter, and his agent (Libera's Next code on his host)
// suggests instead of editing. The text changes only when Alice, the owner,
// accepts; "Suggest in notebook" reaches files that are not open; undo
// withdraws what is still pending and reports what was accepted; Read Only
// offers no write tools at all; the review-comments skill leaves shared
// threads with an AI actor that collaborators see as "AI · requested by Bob".

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_SKILLS } from "../../src/lib/agent/skills";
import { RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { ALL_TOOLS, toolsForPermission, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent, AgentPermission } from "../../src/lib/agent/types";
import { ControlRoutes, type DecideSuggestionsLocalResponse, type DocText } from "../../src/lib/collab/local-api";
import type { SuggestionInfo, Thread } from "../../src/lib/collab/protocol/api";
import { commentAuthorLabel } from "../../src/lib/collab/review-store/authors";
import { invalidateSharedNotebookCache } from "../../src/lib/collab/shared-notebook";
import { joinNotebook, resolvePath, shareNotebook, startPeer, until, type P2Peer } from "./support/p2-peers";
import { removeDataDir, startServerProcess } from "./support/server-process";

const ENV_KEYS = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;

function tool(name: string, context?: ToolContext) {
  const found = [...ALL_TOOLS, ...(context?.skills ?? []).flatMap((skill) => skill.tools ?? [])].find((candidate) => candidate.name === name);
  assert.ok(found, name);
  return found;
}

function agentContext(permission: AgentPermission, notebook: string, openFiles: string[]): { context: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    context: {
      permission, skills: [], loadedSkills: new Set(), skillState: new Map(), notebook, notebooks: [notebook],
      openFiles: new Set(openFiles), drafts: new Map(), fileState: new Map(), tasks: [],
      snapshots: new RunSnapshots(`run-${Math.random().toString(36).slice(2, 12)}`), changed: new Map(),
      maxResultChars: 40_000, signal: new AbortController().signal, emit: (event) => events.push(event), model: "test/p3b-agent",
    },
  };
}

test("a commenter's agent suggests in shared notebooks; text changes only on accept; undo withdraws", { timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p3b-agent-"));
  const dataDir = path.join(root, "bob-data");
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const server = await startServerProcess();
  const peers: P2Peer[] = [];
  try {
    const alice = await startPeer(root, "Alice", server);
    // Bob's host serves the library Libera's Next code uses in this process.
    const bob = await startPeer(root, "Bob", server, { library: path.join(dataDir, "users", "admin") });
    peers.push(alice, bob);
    const projectId = await shareNotebook(alice, "Shared", { "notes.md": "Hello world.\n\nSecond line.\n", "other.md": "Other note.\n" });
    const notebook = await joinNotebook(alice, bob, projectId, "commenter");
    const notes = await resolvePath(bob, `${notebook}/notes.md`);
    const other = await resolvePath(bob, `${notebook}/other.md`);
    process.env.LIBERA_DATA_DIR = dataDir;
    process.env.LIBERA_COLLAB_HOST_URL = bob.app.address.url;
    process.env.LIBERA_COLLAB_HOST_TOKEN = bob.app.address.token;
    invalidateSharedNotebookCache();
    const text = async (docId: string) => (await alice.call<DocText>("GET", ControlRoutes.docText(docId))).body.text;
    const overlay = async (docId: string) => (await alice.call<SuggestionInfo[]>("GET", ControlRoutes.docSuggestions(docId))).body;
    await until(async () => (await text(notes.docId)) === "Hello world.\n\nSecond line.\n", "Alice's host to load the note");

    const { context, events } = agentContext("open-files", notebook, [`${notebook}/notes.md`]);
    let suggestionId = "";
    await t.test("Edit by a commenter's agent creates a pending AI suggestion and leaves the text", async () => {
      const read = await tool("Read").run({ file_path: `${notebook}/notes.md` }, context);
      assert.match(read.text, /become suggestions/);
      const edited = await tool("Edit").run({ file_path: `${notebook}/notes.md`, old_string: "Hello world.", new_string: "Hello, team." }, context);
      assert.equal(edited.isError, false, edited.text);
      assert.match(edited.text, /suggested, pending review \(1 suggestion: ([\w-]+)\)/);
      suggestionId = /suggestion: ([\w-]+)\)/.exec(edited.text)![1];
      assert.ok(events.some((event) => event.type === "file_changed" && event.suggested === true));
      await until(async () => (await overlay(notes.docId)).some((info) => info.id === suggestionId && info.status === "pending"), "the server to mirror the suggestion");
      const info = (await overlay(notes.docId)).find((item) => item.id === suggestionId)!;
      assert.deepEqual([info.actor.kind, info.createdBy.id, info.baseQuote, info.replacement], ["ai", bob.account.id, " world", ", team"], "a minimal edit");
      assert.equal(await text(notes.docId), "Hello world.\n\nSecond line.\n", "unchanged until accepted");
      // The commenter can neither edit directly nor decide; the server agrees.
      const decided = await bob.call<{ error: { code: string } }>("POST", ControlRoutes.docSuggestionDecisions(notes.docId), { decisions: [{ suggestionId, decision: "accept" }] });
      assert.equal(decided.status, 403);
    });

    await t.test("the owner accepts it and the text changes for everyone", async () => {
      const accepted = await alice.call<DecideSuggestionsLocalResponse>("POST", ControlRoutes.docSuggestionDecisions(notes.docId), { decisions: [{ suggestionId, decision: "accept" }] });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      await until(async () => (await text(notes.docId)) === "Hello, team.\n\nSecond line.\n", "the accepted text");
      await until(async () => (await tool("Read").run({ file_path: `${notebook}/notes.md` }, context)).text.includes("Hello, team."), "Bob's agent to read the accepted text");
    });

    await t.test("Suggest in notebook reaches files that are not open; creating files is refused", async () => {
      const wide = agentContext("notebook", notebook, []).context;
      wide.snapshots = context.snapshots;
      await tool("Read").run({ file_path: `${notebook}/other.md` }, wide);
      const edited = await tool("Edit").run({ file_path: `${notebook}/other.md`, old_string: "Other note.", new_string: "Another note." }, wide);
      assert.match(edited.text, /suggested, pending review/);
      await until(async () => (await overlay(other.docId)).some((info) => info.status === "pending"), "the suggestion on the closed file");
      await assert.rejects(tool("Write").run({ file_path: `${notebook}/new.md`, content: "x" }, wide), /cannot create files there/);
      // Open-files mode still refuses files that are not open.
      await assert.rejects(tool("Edit").run({ file_path: `${notebook}/other.md`, old_string: "Other note.", new_string: "x" }, context), /only modify files that are open/);
    });

    await t.test("undo withdraws the pending suggestions and reports the accepted one", async () => {
      const results = await undoRun(context.snapshots.runId);
      const byPath = new Map(results.map((result) => [result.path, result]));
      assert.equal(byPath.get(`${notebook}/other.md`)?.status, "restored");
      assert.equal(byPath.get(`${notebook}/other.md`)?.withdrawn, 1);
      assert.equal(byPath.get(`${notebook}/notes.md`)?.status, "conflict");
      assert.match(byPath.get(`${notebook}/notes.md`)?.message ?? "", /already accepted/);
      await until(async () => (await overlay(other.docId)).every((info) => info.status === "withdrawn"), "the server to see the withdrawal");
      assert.equal(await text(other.docId), "Other note.\n");
    });

    await t.test("the review-comments skill leaves AI-authored shared threads, even in Read Only", async () => {
      const reviewer = agentContext("read-only", notebook, []).context;
      reviewer.skills = AGENT_SKILLS;
      await tool("Skill", reviewer).run({ name: "leave-review-comments" }, reviewer);
      await tool("Read", reviewer).run({ file_path: `${notebook}/notes.md` }, reviewer);
      const placed = await tool("LeaveComment", reviewer).run({ file_path: `${notebook}/notes.md`, old_string: "Second line.", new_string: "Second line.\n\n:::comment\nSay more here.\n:::" }, reviewer);
      assert.equal(placed.isError, false, placed.text);
      assert.equal(await AGENT_SKILLS[0].finishPass!(reviewer, { final: true }), null);
      let threads: Thread[] = [];
      await until(async () => { threads = await alice.threads.list(notes.docId); return threads.length === 1; }, "Alice to list the AI thread");
      const [thread] = threads;
      assert.equal(thread.quote, "Second line.");
      assert.deepEqual([thread.actor.kind, thread.actor.kind === "ai" ? thread.actor.feature : null, thread.createdBy.id], ["ai", "review-comments", bob.account.id]);
      assert.equal(commentAuthorLabel(thread.messages[0].actor, thread.messages[0].author), "AI · requested by Bob");
      // Its anchor is in the shared annotations, so Alice's replica resolves it.
      const replica = await alice.replica(notes.docId);
      const store = alice.store({ ...notes, role: "owner" }, replica);
      await store.load();
      await until(() => store.getProjection().threads[0]?.anchor.state === "attached", "the anchor to resolve on Alice's side");
      assert.equal(replica.text().slice(store.getProjection().threads[0].anchor.start, store.getProjection().threads[0].anchor.end), "Second line.");
    });

    await t.test("Read Only offers no write tools", () => {
      const names = toolsForPermission("read-only").map((candidate) => candidate.name);
      assert.ok(!names.includes("Edit") && !names.includes("Write"));
    });
  } finally {
    for (const peer of peers) await peer.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    invalidateSharedNotebookCache();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* left for the OS */ }
  }
});
