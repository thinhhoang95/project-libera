// Formal review (plan M3.5) with real hosts and the real server: Alice (owner)
// requests a review of a selected passage from the tab bar's dialog; Bob
// (editor, assignee) approves; an edit outside the passage leaves the
// approval current, one inside marks it outdated; a decision made while
// Bob's host is offline is queued and replayed; checkpoint mode shows the
// base revision with "N changes since this revision"; Alice closes it; and
// a review notification opens the review.

import { dom, createProject, hostEvents, installBridge, installRendererFetch, networkSwitch, openWindow, sleep, startClient, statusStoreFor, until, type Client, type Window } from "./support/p3b-harness";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";

import { setSharedDocRegistry } from "../../src/lib/collab/client/registry";
import { createReviewsApi, requestOpenReview, reviewsFor, type ReviewsController } from "../../src/lib/collab/client/reviews";
import { readAnchor } from "../../src/lib/collab/anchors";
import { AnnotationKeys, type ReviewScopeRecord } from "../../src/lib/collab/protocol/schema";
import type { Review } from "../../src/lib/collab/protocol/api";
import { setCollabStatusStore } from "../../src/lib/collab/ui/status-store";
import { newReview } from "../../src/lib/markdown-review";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import { RequestReviewButton, ReviewsPanel } from "../../src/components/libera/collab/reviews";
import { CommentsWithSuggestions } from "../../src/components/libera/collab/suggestions";
import { forgetProjectMembers } from "../../src/components/libera/collab/mentions/mention-textarea";
import type { OpenTab } from "../../src/components/libera/types";
import { removeDataDir, startServerProcess } from "./support/server-process";

after(() => dom.window.close());

const PATH = "Team/spec.md";
const TEXT = "# Spec\n\nIntro paragraph stays.\n\nThe API returns JSON.\n\nClosing words.\n";
const SCOPE = "The API returns JSON.";

type ReviewContext = NonNullable<ReturnType<typeof useMarkdownReview>>;
const probe: { review: ReviewContext | null } = { review: null };
function Probe({ selection }: { selection: { start: number; end: number } }) {
  const value = useMarkdownReview();
  useEffect(() => { probe.review = value; });
  // The editor's selection, as an editor's review bridge reports it.
  const register = value?.register;
  useEffect(() => register?.({ isComposing: () => false, snapshot: () => "", apply: () => {}, focus: () => {}, selection: () => selection }), [register, selection]);
  return null;
}
const flush = async (rounds = 3) => { for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
// Matches the visible text, or the accessible label of an icon-only button.
const button = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === text || element.getAttribute("aria-label") === text);

/**
 * The real UI in a window of its own on `client`'s host (its own registry
 * and replica): setSharedDocRegistry destroys the registry it replaces, so
 * the test's windows stay out of it.
 */
async function mount(client: Client, resolved: Parameters<typeof openWindow>[1], children: (window: Window) => ReactNode) {
  const window = await openWindow(client, resolved, { tabId: `ui-${client.name}-${Math.random().toString(36).slice(2, 8)}` });
  setSharedDocRegistry(window.registry);
  setCollabStatusStore(statusStoreFor(client));
  const bridge = installBridge(client);
  const fetches = installRendererFetch(client, {
    "POST /api/markdown-reviews": (body) => ({ ...newReview(PATH, (body as { snapshot?: string }).snapshot ?? TEXT, "local-review"), enabled: true }),
  });
  forgetProjectMembers();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const tab = { id: window.tabId, draft: TEXT, saved: TEXT, status: "clean", file: { fileType: "markdown", path: PATH, name: "spec.md", notebook: "Team" } } as unknown as OpenTab;
  // eslint-disable-next-line react/no-children-prop
  await act(async () => { root.render(createElement(MarkdownReviewProvider, { activeTab: tab, getDraft: () => window.text(), applyDraft: () => false, recoverDraft: () => {}, openChat: () => {}, openComments: () => {}, children: children(window) })); });
  await flush();
  return {
    container,
    window,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
      bridge.remove();
      fetches.restore();
      setSharedDocRegistry(null);
      setCollabStatusStore(null);
      window.close();
    },
  };
}

function controllerFor(client: Client, window: Window): ReviewsController {
  return reviewsFor(window.session, { api: createReviewsApi(client.client), subscribeEvents: hostEvents(client), localUserId: () => client.userId });
}

test("review requests: selection scope, approvals bound to revisions, outdated, offline replay, checkpoint mode, close", { timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p3b-reviews-"));
  const server = await startServerProcess();
  const network = networkSwitch();
  const clients: Client[] = [];
  const windows: Window[] = [];
  let mounted: Awaited<ReturnType<typeof mount>> | null = null;
  try {
    const alice = await startClient(root, "alice", server.url);
    clients.push(alice);
    const project = await createProject(alice, "Team", server.url);
    const bob = await startClient(root, "bob", server.url, { network, invitationToken: await project.invite("bob@example.test", "editor") });
    clients.push(bob);
    const doc = await project.addDoc(PATH, TEXT, [[alice, "owner"], [bob, "editor"]]);
    const aliceWin = await openWindow(alice, doc, { role: "owner" });
    const bobWin = await openWindow(bob, { ...doc, role: "editor" }, { role: "editor" });
    windows.push(aliceWin, bobWin);
    const aliceReviews = controllerFor(alice, aliceWin);
    const bobReviews = controllerFor(bob, bobWin);
    const start = TEXT.indexOf(SCOPE);
    let review!: Review;
    const bobView = () => bobReviews.review(review.id);
    const bobAssignment = () => bobView()?.assignments.find((assignment) => assignment.reviewer.id === bob.userId);

    await t.test("Request review… with the selection: an anchored range scope", async () => {
      mounted = await mount(alice, doc, (window) => [createElement(Probe, { key: "probe", selection: { start, end: start + SCOPE.length } }), createElement(RequestReviewButton, { key: "request", tabId: window.tabId })]);
      await until(async () => { await flush(1); return !!button(mounted!.container, "Request review"); }, "the tab bar button for an owner");
      await act(async () => { button(mounted!.container, "Request review")!.click(); });
      await until(async () => { await flush(1); return [...document.querySelectorAll("form[aria-label=\"Review request\"] label")].some((label) => label.textContent?.includes("Bob")); }, "the dialog with the members");
      const form = document.querySelector<HTMLFormElement>('form[aria-label="Review request"]')!;
      const radios = form.querySelectorAll<HTMLInputElement>('input[type="radio"]');
      assert.equal(radios[1].checked, true, "the selection is the default scope");
      assert.match(form.textContent ?? "", /The API returns JSON\./);
      const bobBox = [...form.querySelectorAll("label")].find((label) => label.textContent?.includes("Bob"))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      await act(async () => { bobBox.click(); });
      const note = form.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note for the reviewers"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Is JSON right?");
        note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await act(async () => { button(document, "Request review")!.click(); });
      await until(async () => { await flush(1); return !document.querySelector('form[aria-label="Review request"]'); }, "the dialog to close");
      await mounted.unmount();
      mounted = null;
      await aliceReviews.load();
      review = aliceReviews.getSnapshot().reviews![0];
      assert.equal(review.scope.kind, "range");
      assert.equal(review.scope.kind === "range" ? review.scope.quote : "", SCOPE);
      assert.equal(review.note, "Is JSON right?");
      assert.deepEqual(review.assignments.map((assignment) => assignment.reviewer.id), [bob.userId]);
      // The server names the scope's anchor under the review id.
      const scopes = aliceWin.session.replica.annotations.getMap<ReviewScopeRecord>(AnnotationKeys.reviewScopes);
      await until(() => !!scopes.get(review.id), "the review's scope record");
      const record = scopes.get(review.id)!;
      assert.equal(record.createdBy, alice.userId);
      assert.equal(readAnchor(aliceWin.session.replica.annotations, record.anchorId)?.kind, "review-scope");
      await until(async () => { await bobReviews.load(); return !!bobView(); }, "Bob to see the review");
      await until(() => !!bobWin.session.replica.annotations.getMap(AnnotationKeys.reviewScopes).get(review.id), "the scope to sync");
    });

    await t.test("approve, then an edit outside the scope leaves it current and one inside makes it outdated", async () => {
      const decided = await bobReviews.decide(review.id, "approved");
      assert.equal(decided.queued, false);
      assert.equal(bobAssignment()?.decision, "approved");
      assert.equal(bobAssignment()?.outdated, false);
      assert.ok(bobAssignment()?.decidedRevisionId, "bound to a revision");
      // Outside: the intro paragraph.
      const intro = aliceWin.text().indexOf("stays");
      aliceWin.session.replica.ytext.insert(intro, "really ");


      await until(async () => (await bob.client.request<{ text: string }>("GET", `/docs/${doc.docId}/text`)).text.includes("really stays"), "the edit to reach the server");
      await sleep(600);
      await bobReviews.load();
      assert.equal(bobAssignment()?.outdated, false, "an edit next to the scope does not outdate it");
      // Inside: the reviewed sentence.
      const json = aliceWin.text().indexOf("JSON");
      aliceWin.session.replica.ytext.insert(json, "compact ");
      await until(async () => { await bobReviews.load(); return bobAssignment()?.outdated === true; }, "the approval to be outdated");
      assert.ok((bobView()?.changesSinceBase ?? 0) >= 1);
    });

    await t.test("a decision made offline is queued and replayed on reconnect", async () => {
      network.set(false);
      await until(() => bob.app.runtime.host.connectionState !== "connected", "Bob's host to go offline");
      const queued = await bobReviews.decide(review.id, "changes-requested", { comment: "Say which JSON." });
      assert.equal(queued.queued, true);
      assert.equal(bobReviews.getSnapshot().pending[review.id]?.phase, "queued");
      network.set(true);
      await until(() => !bobReviews.getSnapshot().pending[review.id], "the queued decision to settle");
      await until(async () => { await bobReviews.load(); return bobAssignment()?.decision === "changes-requested"; }, "the replayed decision on the server");
      assert.equal(bobAssignment()?.outdated, false, "a fresh decision on the latest revision");
    });

    await t.test("checkpoint mode: the base revision, the count of changes since, and decisions bound to it", async () => {
      mounted = await mount(bob, { ...doc, role: "editor" }, (window) => [createElement(Probe, { key: "probe", selection: { start: 0, end: 1 } }), createElement(ReviewsPanel, { key: "reviews", session: window.session })]);
      const card = () => mounted!.container.querySelector<HTMLElement>(`[data-review-id="${review.id}"]`);
      await until(async () => { await flush(1); return !!card(); }, "the review card");
      assert.match(card()!.textContent ?? "", /Requested changes/);
      await act(async () => { card()!.querySelector<HTMLButtonElement>('button[data-action="open-review"]')!.click(); });
      const revisionText = () => { const element = document.querySelector<HTMLElement>('[aria-label="Revision text"] .cm-editor'); return element ? EditorView.findFromDOM(element)?.state.doc.toString() ?? "" : ""; };
      await until(async () => { await flush(1); return !!document.querySelector('[data-testid="review-checkpoint-banner"]') && revisionText() === TEXT; }, "checkpoint mode with the base revision");
      const banner = document.querySelector('[data-testid="review-checkpoint-banner"]')!.textContent ?? "";
      const count = bobView()!.changesSinceBase;
      assert.ok(count >= 1);
      assert.match(banner, new RegExp(`${count} changes? since this revision`));
      assert.ok(aliceWin.text().includes("compact JSON") && !revisionText().includes("compact"), "the revision is the one the review was requested on, while the live text moved on");
      const checkpoint = document.querySelector<HTMLElement>('[data-testid="review-checkpoint"]')!;
      await act(async () => { checkpoint.querySelector<HTMLButtonElement>('button[data-action="approve"]')!.click(); });
      await until(async () => { await flush(1); return bobAssignment()?.decision === "approved"; }, "the approval from checkpoint mode");
      assert.equal(bobAssignment()?.decidedRevisionId, review.baseRevisionId, "bound to the base revision");
      await until(async () => { await bobReviews.load(); await flush(1); return bobAssignment()?.outdated === true; }, "an approval of an older revision whose scope changed is outdated");
      await act(async () => { button(document, "Close")!.click(); });
      await mounted.unmount();
      mounted = null;
    });

    await t.test("a review notification opens the Reviews tab, in checkpoint mode for the assignee", async () => {
      mounted = await mount(bob, { ...doc, role: "editor" }, (window) => [createElement(Probe, { key: "probe", selection: { start: 0, end: 1 } }), createElement(CommentsWithSuggestions, { key: "rail", tabId: window.tabId, comments: createElement("p", null, "comments") })]);
      await act(async () => { requestOpenReview(doc.docId, review.id); });
      await until(async () => { await flush(1); return !!document.querySelector('[data-testid="review-checkpoint"]'); }, "checkpoint mode from the notification");
      const tab = [...mounted.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((element) => element.textContent?.startsWith("Reviews"))!;
      assert.equal(tab.getAttribute("aria-selected"), "true");
      await act(async () => { button(document, "Close")!.click(); });
      await mounted.unmount();
      mounted = null;
    });

    await t.test("close", async () => {
      const closed = await aliceReviews.close(review.id);
      assert.equal(closed.status, "closed");
      await until(async () => { await bobReviews.load(); return bobView()?.status === "closed"; }, "Bob to see it closed");
    });
  } finally {
    await (mounted as Awaited<ReturnType<typeof mount>> | null)?.unmount().catch(() => undefined);
    for (const window of windows) window.close();
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* left for the OS */ }
  }
});
