// Shared comments in the real Review UI (the bug the end-to-end run found):
// Alice adds a comment from the passage popover on a shared note in the
// Visual editor, with a real host and server underneath. Her own Comments
// panel must list it, and Bob's store must get it through thread.changed.
//
// Two things the app does differently from Node made this fail in Electron:
// browsers refuse `queueMicrotask` called as a method of another object, so
// the shared store's projection froze at its first, empty build; and a
// collaborator's edit (a "remote" bridge transaction) closed the popover
// between a real mousedown and its click. The test runs with the browser's
// queueMicrotask check and a remote edit landing mid-click, and then again in
// a window that learns only after mounting that the tab is shared.

import { dom, createProject, installBridge, installRendererFetch, openWindow, startClient, statusStoreFor, strictBrowserGlobals, until, type Client, type Window } from "./support/p3b-harness";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { act, createElement, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";

import { SharedDocRegistry, setSharedDocRegistry } from "../../src/lib/collab/client/registry";
import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { browserPort } from "./support/wire-harness";
import { sharedVisualSource } from "../../src/lib/collab/bindings/react-visual";
import { setCollabStatusStore } from "../../src/lib/collab/ui/status-store";
import { SharedReviewStore } from "../../src/lib/collab/review-store/shared";
import { createThreadApi } from "../../src/lib/collab/review-store/api";
import { newReview } from "../../src/lib/markdown-review";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapCollabHistory } from "../../src/lib/collab/bindings/tiptap-history";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import { ReviewComments, ReviewPopover } from "../../src/components/libera/markdown-review-ui";
import { useTiptapReview } from "../../src/components/libera/use-editor-review";
import type { OpenTab } from "../../src/components/libera/types";
import { removeDataDir, startServerProcess } from "./support/server-process";

after(() => dom.window.close());

const PATH = "Team/note.md";
const TEXT = "# Team\n\nFirst paragraph about cats.\n\nSecond paragraph about dogs.\n";

type Review = NonNullable<ReturnType<typeof useMarkdownReview>>;
const probe: { review: Review | null } = { review: null };
function Probe() {
  const value = useMarkdownReview();
  useEffect(() => { probe.review = value; });
  return null;
}

/** The Visual editor's review wiring on a shared tab, as the app mounts it. */
function VisualEditor({ window, onEditor }: { window: Window; onEditor: (editor: Editor) => void }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const lastValue = useRef(TEXT);
  useEffect(() => {
    if (!element) return;
    const created = new Editor({ element, extensions: [...createMarkdownExtensions(PATH), TiptapCollabHistory], content: "", contentType: "markdown" });
    const handle = sharedVisualSource(window.session).attach(created);
    // The editor exists only once its element is mounted, as in the app's editors.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditor(created);
    onEditor(created);
    return () => { handle.destroy(); created.destroy(); };
  }, [element, window, onEditor]);
  const read = useCallback(() => window.session.replica.text(), [window]);
  const replace = useCallback(() => {}, []);
  useTiptapReview(editor, lastValue, read, replace);
  return createElement("div", { ref: setElement, className: "visual-host" });
}

function tab(id: string): OpenTab {
  return { id, draft: TEXT, saved: TEXT, status: "clean", file: { fileType: "markdown", path: PATH, name: "note.md", notebook: "Team" } } as unknown as OpenTab;
}

/**
 * A real mouse click: pointerdown and mousedown first, and unless one was
 * prevented, focus moves off whatever had it (the editor blurs). `between`
 * runs after the mousedown, before mouseup and click, as a collaborator's
 * edit can.
 */
async function realClick(target: HTMLElement, between?: () => Promise<void>) {
  const init = { bubbles: true, cancelable: true, button: 0, view: dom.window };
  await act(async () => {
    target.dispatchEvent(new dom.window.MouseEvent("pointerdown", init));
    const down = new dom.window.MouseEvent("mousedown", init);
    target.dispatchEvent(down);
    if (!down.defaultPrevented) {
      (document.activeElement as HTMLElement | null)?.blur();
      target.focus();
    }
  });
  if (between) await between();
  await act(async () => {
    // The browser fires click only on the element both presses hit; a target
    // React removed meanwhile gets nothing.
    if (!target.isConnected) return;
    target.dispatchEvent(new dom.window.MouseEvent("mouseup", init));
    target.dispatchEvent(new dom.window.MouseEvent("click", init));
  });
}

function type(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(element, value);
  element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

const buttonNamed = (name: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === name);
const flush = async (rounds = 4) => { for (let index = 0; index < rounds; index++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };

test("a comment added from the popover lists for its author and reaches a collaborator live", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p3b-comments-"));
  const server = await startServerProcess();
  const clients: Client[] = [];
  const windows: Window[] = [];
  const restoreGlobals = strictBrowserGlobals();
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

    // Bob's comments, as his own window would hold them.
    const bobStore = new SharedReviewStore({
      docId: doc.docId, projectId: doc.projectId, key: PATH, replica: bobWin.session.replica,
      me: () => bob.account, role: () => "editor", online: () => true,
      api: createThreadApi(bob.client.request), subscribeEvents: (listener) => { bob.listeners.add(listener); return () => { bob.listeners.delete(listener); }; },
    });
    await bobStore.load();

    // Alice's window: the real provider, panel, popover and Visual editor.
    setSharedDocRegistry(aliceWin.registry);
    setCollabStatusStore(statusStoreFor(alice));
    const bridge = installBridge(alice);
    const fetches = installRendererFetch(alice, {
      "POST /api/markdown-reviews": (body) => ({ ...newReview(PATH, (body as { snapshot?: string }).snapshot ?? TEXT, "local-review"), enabled: true }),
    });
    let editor: Editor | null = null;
    const container = document.createElement("div");
    document.body.append(container);
    const reactRoot = createRoot(container);
    unmount = async () => { await act(async () => reactRoot.unmount()); container.remove(); bridge.remove(); fetches.restore(); };
    const children: ReactNode[] = [
      createElement(Probe, { key: "probe" }),
      createElement(VisualEditor, { key: "visual", window: aliceWin, onEditor: (created: Editor) => { editor = created; } }),
      createElement(ReviewComments, { key: "comments" }),
      createElement(ReviewPopover, { key: "popover" }),
    ];
    await act(async () => {
      // eslint-disable-next-line react/no-children-prop
      reactRoot.render(createElement(MarkdownReviewProvider, { activeTab: tab(aliceWin.tabId), getDraft: () => aliceWin.text(), applyDraft: () => false, recoverDraft: () => {}, openChat: () => {}, openComments: () => {}, children }));
    });
    await until(async () => { await flush(1); return !!probe.review?.shared?.projection.loaded && !!editor && editor.getText().includes("Second paragraph"); }, "the shared review and the Visual editor to load");
    assert.match(container.textContent ?? "", /0 open/);

    // Select the second paragraph in Visual and release the mouse: the popover opens.
    const visual = editor!;
    let from = -1, to = -1;
    visual.state.doc.descendants((node, pos) => { if (node.isTextblock && node.textContent.startsWith("Second")) { from = pos + 1; to = pos + 1 + node.content.size; } });
    await act(async () => {
      visual.commands.setTextSelection({ from, to });
      visual.view.dom.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, clientX: 40, clientY: 80 }));
    });
    await flush();
    const popover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Passage review"]');
    assert.ok(popover(), "the passage popover opens");
    const second = TEXT.indexOf("Second paragraph");
    assert.deepEqual(probe.review!.selection?.range, { start: second, end: second + "Second paragraph about dogs.".length });

    // Bob types at the top while Alice presses "Add comment": the remote edit
    // must neither close the popover nor leave the selection on stale offsets.
    await realClick(buttonNamed("Add comment", popover()!)!, async () => {
      bobWin.session.replica.ytext.insert(0, "Bob was here.\n\n");
      await until(async () => { await flush(1); return aliceWin.text().startsWith("Bob was here."); }, "Bob's edit to reach Alice");
      await flush();
    });
    assert.ok(popover(), "the popover survived the collaborator's edit");
    const box = popover()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="New review comment"]');
    assert.ok(box, "the comment box opened from a real click");
    const shifted = aliceWin.text().indexOf("Second paragraph");
    assert.deepEqual(probe.review!.selection?.range, { start: shifted, end: shifted + "Second paragraph about dogs.".length }, "the selection followed the edit");

    await act(async () => { box!.focus(); type(box!, "Should we say wolves?"); });
    await realClick(buttonNamed("Add comment", popover()!)!);
    await until(async () => { await flush(1); return !popover(); }, "the popover to close after adding");

    // Alice's own panel lists it, confirmed (no pending chip) and anchored on the paragraph.
    await until(async () => { await flush(1); return /1 open/.test(container.textContent ?? "") && /Should we say wolves\?/.test(container.textContent ?? ""); }, "Alice's panel to list her comment");
    const card = [...container.querySelectorAll<HTMLElement>("article.review-comment-card")].find((element) => element.textContent?.includes("wolves"))!;
    await until(async () => { await flush(1); return !card.isConnected || !card.querySelector(".review-comment-pending"); }, "the server to confirm the thread");
    const thread = probe.review!.doc!.threads[0];
    assert.equal(aliceWin.text().slice(thread.anchor.start, thread.anchor.end), "Second paragraph about dogs.");
    const stored = await alice.client.request<{ id: string; createdBy: { id: string } }[]>("GET", `/docs/${doc.docId}/threads`);
    assert.deepEqual(stored.map((item) => [item.id, item.createdBy.id]), [[thread.id, alice.userId]]);

    // Bob's store hears thread.changed and resolves the anchor in his replica.
    await until(() => bobStore.getProjection().threads.some((item) => item.id === thread.id && item.anchor.state === "attached"), "Bob to see Alice's thread");
    const seen = bobStore.getProjection().threads.find((item) => item.id === thread.id)!;
    assert.equal(seen.messages[0].text, "Should we say wolves?");
    assert.equal(seen.messages[0].shared.author.id, alice.userId);
    bobStore.destroy();

    // A window that learns late that the tab is shared (the status store read
    // failed at first, the path resolves after the panel mounted) must switch
    // to the shared store and list what the server has.
    await unmount();
    unmount = null;
    const hub = alice.app.runtime.host.acquire(doc.docId, { projectId: doc.projectId });
    let resolveLater!: (value: typeof doc | null) => void;
    const lateRegistry = new SharedDocRegistry({
      resolve: () => new Promise((resolve) => { resolveLater = resolve; }),
      attach: async () => { const pair = createMemoryPortPair(); hub.attachReplica(pair.hub); return browserPort(pair.replica); },
      subscribeEvents: () => () => {},
      replicaOptions: { schedule: (run) => queueMicrotask(run) },
      available: () => true,
    });
    const lateStatus = statusStoreFor(alice);
    const signedIn = lateStatus.getSnapshot().status!;
    lateStatus.setStatus({ ...signedIn, connection: "connecting", account: null });
    setSharedDocRegistry(lateRegistry);
    setCollabStatusStore(lateStatus);
    const lateBridge = installBridge(alice);
    const lateFetch = installRendererFetch(alice, {
      "POST /api/markdown-reviews": (body) => ({ ...newReview(PATH, (body as { snapshot?: string }).snapshot ?? TEXT, "local-review"), enabled: true }),
    });
    const lateContainer = document.createElement("div");
    document.body.append(lateContainer);
    const lateRoot = createRoot(lateContainer);
    unmount = async () => { await act(async () => lateRoot.unmount()); lateContainer.remove(); lateBridge.remove(); lateFetch.restore(); lateRegistry.destroy(); alice.app.runtime.host.release(doc.docId); };
    await act(async () => {
      // eslint-disable-next-line react/no-children-prop
      lateRoot.render(createElement(MarkdownReviewProvider, { activeTab: tab("late-tab"), getDraft: () => aliceWin.text(), applyDraft: () => false, recoverDraft: () => {}, openChat: () => {}, openComments: () => {}, children: [createElement(Probe, { key: "probe" }), createElement(ReviewComments, { key: "comments" })] }));
    });
    await flush();
    const binding = lateRegistry.bindTab("late-tab", PATH);
    await flush();
    assert.equal(probe.review!.shared, null, "not shared while the path is unresolved");
    assert.match(lateContainer.textContent ?? "", /0 open/);
    resolveLater(doc);
    await binding;
    await act(async () => { lateStatus.setStatus(signedIn); });
    await until(async () => { await flush(1); return /1 open/.test(lateContainer.textContent ?? "") && /Should we say wolves\?/.test(lateContainer.textContent ?? ""); }, "the late shared panel to list the thread");
    assert.equal(probe.review!.shared?.projection.me?.id, alice.userId, "the account learned later is used");
  } finally {
    await unmount?.();
    restoreGlobals();
    setSharedDocRegistry(null);
    setCollabStatusStore(null);
    for (const window of windows) window.close();
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* left for the OS */ }
  }
});
