// Replying to a suggestion (Suggestions panel → Reply) on a real host and
// server: the reply is a comment thread in the shared comment store,
// anchored on the suggestion's range, and the suggestion lists the thread in
// its threadIds, so the server's thread says which suggestion it is about.
// An inline Reply (as the CodeMirror widget sends it) opens the same box.

import { dom, createProject, installBridge, installRendererFetch, openWindow, startClient, statusStoreFor, until, type Client, type Window } from "./support/p3b-harness";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { setSharedDocRegistry } from "../../src/lib/collab/client/registry";
import { setCollabStatusStore } from "../../src/lib/collab/ui/status-store";
import { getSuggestion } from "../../src/lib/collab/suggestions/model";
import type { Thread } from "../../src/lib/collab/protocol/api";
import { newReview } from "../../src/lib/markdown-review";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import { ReviewComments } from "../../src/components/libera/markdown-review-ui";
import { CommentsWithSuggestions } from "../../src/components/libera/collab/suggestions";
import type { OpenTab } from "../../src/components/libera/types";
import { removeDataDir, startServerProcess } from "./support/server-process";

after(() => dom.window.close());

const PATH = "Team/reply.md";
const TEXT = "# Reply\n\nThe quick brown fox jumps.\n\nAnother paragraph.\n";

type Review = NonNullable<ReturnType<typeof useMarkdownReview>>;
const probe: { review: Review | null } = { review: null };
function Probe() {
  const value = useMarkdownReview();
  useEffect(() => { probe.review = value; });
  return null;
}
const flush = async (rounds = 3) => { for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
function type(element: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

test("Reply on a suggestion creates a comment thread on its range, linked to it", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p3b-reply-"));
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

    // Bob suggests "slow" for "quick".
    const quick = TEXT.indexOf("quick");
    const created = bobWin.controller.suggest(quick, quick + 5, "slow");
    assert.ok(created.ok);
    const suggestionId = created.ids[0];
    await until(() => !!aliceWin.controller.group(suggestionId), "Alice to receive Bob's suggestion");

    setSharedDocRegistry(aliceWin.registry);
    setCollabStatusStore(statusStoreFor(alice));
    const bridge = installBridge(alice);
    const fetches = installRendererFetch(alice, {
      "POST /api/markdown-reviews": (body) => ({ ...newReview(PATH, (body as { snapshot?: string }).snapshot ?? TEXT, "local-review"), enabled: true }),
    });
    let commentsOpened = 0;
    const container = document.createElement("div");
    document.body.append(container);
    const reactRoot = createRoot(container);
    unmount = async () => { await act(async () => reactRoot.unmount()); container.remove(); bridge.remove(); fetches.restore(); };
    const tab = { id: aliceWin.tabId, draft: TEXT, saved: TEXT, status: "clean", file: { fileType: "markdown", path: PATH, name: "reply.md", notebook: "Team" } } as unknown as OpenTab;
    await act(async () => {
      // eslint-disable-next-line react/no-children-prop
      reactRoot.render(createElement(MarkdownReviewProvider, { activeTab: tab, getDraft: () => aliceWin.text(), applyDraft: () => false, recoverDraft: () => {}, openChat: () => {}, openComments: () => { commentsOpened += 1; }, children: [
        createElement(Probe, { key: "probe" }),
        createElement(CommentsWithSuggestions, { key: "rail", tabId: aliceWin.tabId, comments: createElement(ReviewComments) }),
      ] }));
    });
    await until(async () => { await flush(1); return !!probe.review?.shared?.projection.loaded; }, "Alice's shared review to load");

    // Reply from the panel.
    const suggestionsTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((element) => element.textContent?.startsWith("Suggestions"))!;
    await act(async () => { suggestionsTab.click(); });
    await flush();
    const card = () => container.querySelector<HTMLElement>(`[data-suggestion-group="${suggestionId}"]`);
    assert.ok(card(), "Bob's suggestion is listed");
    await act(async () => { card()!.querySelector<HTMLButtonElement>('button[data-action="reply"]')!.click(); });
    await flush();
    assert.equal(commentsOpened, 1, "the shell is asked to show the rail");
    const box = card()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply to this suggestion"]');
    assert.ok(box, "the Reply box opens on the card");
    await act(async () => { type(box!, "Why slow? The fox is fast."); });
    await act(async () => { [...card()!.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.includes("Send reply"))!.click(); });
    await until(async () => { await flush(1); return !card()?.querySelector('textarea[aria-label="Reply to this suggestion"]'); }, "the box to close after sending");

    // The thread is anchored on the suggestion's range and linked from it.
    const thread = probe.review!.shared!.projection.threads.find((item) => item.messages[0].text === "Why slow? The fox is fast.")!;
    assert.ok(thread, "the reply is a thread in Alice's store");
    assert.equal(aliceWin.text().slice(thread.anchor.start, thread.anchor.end), "quick");
    await until(() => getSuggestion(bobWin.session.replica.annotations, suggestionId)?.threadIds?.includes(thread.id) === true, "the suggestion to link the thread (Bob's replica)");
    let stored: Thread | undefined;
    await until(async () => { stored = (await bob.client.request<Thread[]>("GET", `/docs/${doc.docId}/threads`)).find((item) => item.id === thread.id); return !!stored?.suggestionIds.includes(suggestionId); }, "the server's thread to name the suggestion");
    assert.equal(stored!.quote, "quick");
    assert.equal(stored!.createdBy.id, alice.userId);

    // An inline Reply (the editor widget) opens the same box, which forces the Suggestions view.
    const commentsTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((element) => element.textContent === "Comments")!;
    await act(async () => { commentsTab.click(); });
    await flush();
    assert.equal(card(), null, "the Comments view is shown");
    await act(async () => { aliceWin.controller.reply(suggestionId); });
    await flush();
    assert.ok(card()?.querySelector('textarea[aria-label="Reply to this suggestion"]'), "the inline Reply shows the box in the rail");
    assert.equal(commentsOpened, 2);
  } finally {
    await unmount?.();
    setSharedDocRegistry(null);
    setCollabStatusStore(null);
    for (const window of windows) window.close();
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* left for the OS */ }
  }
});
