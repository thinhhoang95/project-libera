// Agentic review on a shared document (plan M3.4), through the real Review
// provider, the real review routes (the model stubbed) and a real host and
// server: the plan addresses the shared comment threads, each proposal
// becomes one overlay group with an AI actor acting for the requester (its
// title, reason and threads), a proposal whose passage a collaborator changed
// meanwhile comes out stale, "Request revision" withdraws the old group and
// creates the new one, and accepting is a server decision every replica
// sees. The plan conversation stays in the requester's local review file.

import { dom, createProject, installBridge, installRendererFetch, nextRoute, openWindow, startClient, statusStoreFor, until, type Client, type Window } from "./support/p3b-harness";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { act, createElement, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { POST as REVIEWS_POST } from "../../src/app/api/markdown-reviews/route";
import { POST as AGENTIC_POST } from "../../src/app/api/document-review/route";
import { agenticGroupId } from "../../src/lib/collab/client/agentic-review";
import { setSharedDocRegistry } from "../../src/lib/collab/client/registry";
import { setCollabStatusStore } from "../../src/lib/collab/ui/status-store";
import { SharedReviewStore } from "../../src/lib/collab/review-store/shared";
import { createThreadApi } from "../../src/lib/collab/review-store/api";
import { listSuggestions } from "../../src/lib/collab/suggestions/model";
import { readReviewDocuments } from "../../src/lib/storage/review-files";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import type { OpenTab } from "../../src/components/libera/types";
import { removeDataDir, startServerProcess } from "./support/server-process";

after(() => dom.window.close());

const PATH = "Team/plan.md";
const TEXT = "# Plan\n\nFirst paragraph is wordy and long.\n\nSecond paragraph is vague.\n";

type Review = NonNullable<ReturnType<typeof useMarkdownReview>>;
const probe: { review: Review | null } = { review: null };
function Probe() {
  const value = useMarkdownReview();
  useEffect(() => { probe.review = value; });
  return null;
}
const review = () => probe.review!;
const flush = async (rounds = 3) => { for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };

/** The workspace's part: the tab's draft mirrors the shared text, as useSharedTabs does. */
function Workspace({ window }: { window: Window }) {
  const [draft, setDraft] = useState(() => window.text());
  useEffect(() => {
    const ytext = window.session.replica.ytext;
    const update = () => setDraft(ytext.toString());
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [window]);
  const tab = useMemo(() => ({ id: window.tabId, draft, saved: draft, status: "clean", file: { fileType: "markdown", path: PATH, name: "plan.md", notebook: "Team" } }) as unknown as OpenTab, [window, draft]);
  // eslint-disable-next-line react/no-children-prop
  return createElement(MarkdownReviewProvider, { activeTab: tab, getDraft: () => window.text(), applyDraft: () => false, recoverDraft: () => {}, openChat: () => {}, openComments: () => {}, children: createElement(Probe) });
}

interface ModelContext {
  target: { markdown: string; blocks: { id: string; text: string }[] };
  comments: { id: string; messages: { text: string }[] }[];
  reviseOnly?: { id: string };
}

test("agentic review proposals become AI suggestion groups that collaborators see and editors decide", { timeout: 240_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p3b-agentic-"));
  const env = { LIBERA_DATA_DIR: process.env.LIBERA_DATA_DIR, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, LIBERA_OPENROUTER_MODEL: process.env.LIBERA_OPENROUTER_MODEL, LIBERA_CONFIG_PATH: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = path.join(root, "libera-data");
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.LIBERA_OPENROUTER_MODEL = "test/model";
  process.env.LIBERA_CONFIG_PATH = path.join(root, "missing-config.json");
  const server = await startServerProcess();
  const clients: Client[] = [];
  const windows: Window[] = [];
  let unmount: (() => Promise<void>) | null = null;
  try {
    const alice = await startClient(root, "alice", server.url);
    clients.push(alice);
    const project = await createProject(alice, "Team", server.url);
    const bob = await startClient(root, "bob", server.url, { invitationToken: await project.invite("bob@example.test", "editor") });
    clients.push(bob);
    const doc = await project.addDoc(PATH, TEXT, [[alice, "owner"], [bob, "editor"]]);
    const aliceWin = await openWindow(alice, doc, { role: "owner" });
    const bobWin = await openWindow(bob, { ...doc, role: "editor" }, { role: "editor" });
    windows.push(aliceWin, bobWin);

    // Bob leaves the comments the review will address.
    const bobStore = new SharedReviewStore({
      docId: doc.docId, projectId: doc.projectId, key: PATH, replica: bobWin.session.replica,
      me: () => bob.account, role: () => "editor", online: () => true,
      api: createThreadApi(bob.client.request), subscribeEvents: (listener) => { bob.listeners.add(listener); return () => { bob.listeners.delete(listener); }; },
    });
    await bobStore.load();
    const first = TEXT.indexOf("First paragraph"), second = TEXT.indexOf("Second paragraph");
    await bobStore.comment({ range: { start: first, end: first + "First paragraph is wordy and long.".length }, text: "Too long." });
    const firstThread = bobStore.lastCreatedThreadId()!;
    await bobStore.comment({ range: { start: second, end: second + "Second paragraph is vague.".length }, text: "Be precise." });
    const secondThread = bobStore.lastCreatedThreadId()!;

    // The model: a plan per comment; proposals for both; a revision of the first.
    let duringGenerate: (() => Promise<void>) | null = null;
    const seen: ModelContext[] = [];
    const model = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/endpoints")) return Response.json({ data: { endpoints: [{ tag: "test", supports_implicit_caching: true }] } });
      if (url.endsWith("/models")) return Response.json({ data: [{ id: "test/model", context_length: 200_000 }] });
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const context = JSON.parse(body.messages[1].content) as ModelContext;
      seen.push(context);
      const block = (start: string) => context.target.blocks.find((item) => item.text.startsWith(start))!;
      let content: unknown;
      if (body.messages[0].content.includes("stage is PLAN")) {
        content = { summary: "Tighten both paragraphs", steps: context.comments.map((comment) => ({ commentIds: [comment.id], targetBlockIds: [block(comment.id === firstThread ? "First" : "Second").id], proposedChange: "Tighten", rationale: comment.messages[0].text })), dispositions: [], blockingQuestions: [], revisionSummary: "" };
      } else if (context.reviseOnly) {
        content = { proposals: [{ title: "Shorter first paragraph", reason: "Bob asked for brevity; keeps the new wording.", commentIds: [firstThread], edits: [{ targetBlockId: block("First").id, before: block("First").text, after: "First paragraph, short." }] }], summary: "Revised." };
      } else {
        await duringGenerate?.();
        content = { proposals: [
          { title: "Trim the first paragraph", reason: "It says the same thing twice.", commentIds: [firstThread], edits: [{ targetBlockId: block("First").id, before: "wordy and long", after: "brief" }] },
          { title: "Make the second precise", reason: "Both words must change together to keep the sentence grammatical.", commentIds: [secondThread], edits: [{ targetBlockId: block("Second").id, before: "Second", after: "Next" }, { targetBlockId: block("Second").id, before: "vague", after: "precise" }] },
        ], summary: "Two changes." };
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    };

    setSharedDocRegistry(aliceWin.registry);
    setCollabStatusStore(statusStoreFor(alice));
    const bridge = installBridge(alice);
    const fetches = installRendererFetch(alice, {
      "POST /api/markdown-reviews": nextRoute(REVIEWS_POST, "/api/markdown-reviews"),
      "POST /api/document-review": nextRoute(AGENTIC_POST, "/api/document-review"),
    }, { external: (url, init) => (url.startsWith("https://openrouter.ai/") ? model(url, init) : null) });
    const container = document.createElement("div");
    document.body.append(container);
    const reactRoot = createRoot(container);
    unmount = async () => { await act(async () => reactRoot.unmount()); container.remove(); bridge.remove(); fetches.restore(); };
    await act(async () => { reactRoot.render(createElement(Workspace, { window: aliceWin })); });
    await until(async () => { await flush(1); return (review().doc?.threads.length ?? 0) === 2 && !!review().shared && !review().doc!.id.startsWith("shared:"); }, "Alice to see Bob's two comments and her local review to load");

    let sessionId = "";
    let trim = "", precise = "";
    await t_step("the plan addresses the shared threads, privately", async () => {
      const planned = await act(() => review().generate("plan", "Tighten the prose", [firstThread, secondThread]));
      await flush(1);
      assert.equal(planned, true, `${review().error} busy=${review().busy}`);
      assert.deepEqual(seen.at(-1)!.comments.map((comment) => comment.id), [firstThread, secondThread]);
      assert.equal(seen.at(-1)!.comments[0].messages[0].text, "Too long.");
      sessionId = review().doc!.session!.id;
      // Nothing reached collaborators: the plan is in Alice's local review file only.
      assert.equal(listSuggestions(bobWin.session.replica.annotations).length, 0);
      const index = readdirSync(process.env.LIBERA_DATA_DIR!, { recursive: true }).map(String).find((name) => name.endsWith(path.join(".libera", "reviews", "index.json")))!;
      const documents = await readReviewDocuments<{ id: string; key: string; threads: unknown[] }>(path.join(process.env.LIBERA_DATA_DIR!, index, "..", "..", ".."));
      assert.match(JSON.stringify(documents), /Tighten both paragraphs/);
      const stored = documents.find((item) => item.key === PATH)!;
      assert.deepEqual(stored.threads, [], "shared threads are planned against, never stored as local comments");
    });

    await t_step("confirm makes one AI group per proposal; a passage Bob changed meanwhile is stale", async () => {
      // Bob edits the first paragraph while the model works.
      duringGenerate = async () => {
        const at = bobWin.text().indexOf("wordy and long");
        bobWin.session.replica.ytext.delete(at, "wordy and long".length);
        bobWin.session.replica.ytext.insert(at, "rather wordy");
        await until(() => aliceWin.text().includes("rather wordy"), "Bob's edit to reach Alice");
        // Edits above the second paragraph shift it; the mapping follows.
        bobWin.session.replica.ytext.insert(0, "Intro by Bob.\n\n");
        await until(() => aliceWin.text().startsWith("Intro by Bob."), "Bob's intro to reach Alice");
      };
      assert.equal(await act(() => review().generate("generate", "Confirm the current plan and generate changes.")), true, review().error);
      duringGenerate = null;
      const proposals = review().doc!.session!.suggestions;
      assert.equal(proposals.length, 2);
      [trim, precise] = proposals.map((proposal) => proposal.id);
      await until(async () => { await flush(1); return listSuggestions(bobWin.session.replica.annotations).length === 3; }, "Bob to receive three overlay suggestions");
      const records = listSuggestions(bobWin.session.replica.annotations);
      const preciseGroup = records.filter((record) => record.groupId === agenticGroupId(precise));
      assert.equal(preciseGroup.length, 2, "linked edits share one group");
      for (const record of records) {
        assert.deepEqual(record.actor, { kind: "ai", onBehalfOf: alice.userId, clientId: record.actor.kind === "ai" ? record.actor.clientId : undefined, feature: "agentic-review", runId: sessionId });
        assert.equal(record.createdBy, alice.userId);
      }
      assert.deepEqual(preciseGroup.map((record) => [record.baseQuote, record.replacement, record.status]).sort(), [["Second", "Next", "pending"], ["vague", "precise", "pending"]]);
      assert.equal(preciseGroup[0].title, "Make the second precise");
      assert.match(preciseGroup[0].reason ?? "", /grammatical/);
      assert.deepEqual(preciseGroup[0].threadIds, [secondThread]);
      const trimRecord = records.find((record) => record.groupId === agenticGroupId(trim))!;
      assert.equal(trimRecord.baseQuote, "wordy and long", "the stale suggestion keeps what the AI saw");
      // The cards read their status from the overlay.
      await until(async () => { await flush(1); return review().doc!.session!.suggestions.find((proposal) => proposal.id === trim)?.status === "conflicted"; }, "the trimmed proposal to show as conflicted");
      assert.equal(review().doc!.session!.suggestions.find((proposal) => proposal.id === precise)?.status, "pending");
      const bobGroup = bobWin.controller.group(agenticGroupId(precise))!;
      assert.equal(bobGroup.label, "AI · on behalf of Alice");
      assert.equal(bobGroup.state, "pending");
      assert.equal(bobWin.controller.group(agenticGroupId(trim))!.state, "stale");
    });

    await t_step("Request revision withdraws the old group and creates the new one", async () => {
      assert.equal(await act(() => review().generate("revise", "Keep Bob's new wording", undefined, undefined, trim)), true, review().error);
      const proposals = review().doc!.session!.suggestions;
      const revised = proposals.find((proposal) => proposal.status === "pending" && proposal.commentIds.includes(firstThread))!;
      assert.ok(revised && revised.id !== trim);
      await until(async () => { await flush(1); return bobWin.controller.group(agenticGroupId(trim))?.status === "withdrawn" && bobWin.controller.group(agenticGroupId(revised.id))?.state === "pending"; }, "the old group withdrawn and the new one pending for Bob");
      assert.equal(bobWin.controller.group(agenticGroupId(revised.id))!.items[0].record.baseQuote, "First paragraph is rather wordy.");
      assert.equal(proposals.find((proposal) => proposal.id === trim)?.status, "superseded");

      // Bob (an editor) accepts the revision through the server.
      const outcomes = await bobWin.controller.decide([agenticGroupId(revised.id)], "accept").settled;
      assert.equal([...outcomes.values()][0].kind, "applied");
      await until(async () => { await flush(1); return aliceWin.text().includes("First paragraph, short.") && review().doc!.session!.suggestions.find((proposal) => proposal.id === revised.id)?.status === "accepted"; }, "Alice's card to read accepted");
    });

    await t_step("accept in the review chat is a server decision every replica sees", async () => {
      assert.equal(await act(() => review().action("decision", { ids: [precise], decision: "accept" })), true, review().error);
      const expected = "Intro by Bob.\n\n# Plan\n\nFirst paragraph, short.\n\nNext paragraph is precise.\n";
      await until(() => aliceWin.text() === expected && bobWin.text() === expected, "the accepted group on both replicas");
      await until(async () => { await flush(1); return review().doc!.session!.suggestions.find((proposal) => proposal.id === precise)?.status === "accepted"; }, "the card to read accepted");
      assert.equal(review().doc!.session!.phase, "completed");
      assert.equal(review().doc!.undo.length, 0, "nothing was applied locally");
      // A reopen has no server form.
      assert.equal(await act(() => review().action("decision", { ids: [precise], decision: "reopen" })), false);
      assert.match(review().error, /cannot be reopened/);
    });
    bobStore.destroy();
  } finally {
    await unmount?.();
    setSharedDocRegistry(null);
    setCollabStatusStore(null);
    for (const window of windows) window.close();
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* left for the OS */ }
  }
});

/** A labelled step: failures name the step. */
async function t_step(label: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) error.message = `${label}: ${error.message}`;
    throw error;
  }
}
