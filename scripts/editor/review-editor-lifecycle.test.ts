import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { anchorAt, newReview, syncReview, type ReviewDocument } from "../../src/lib/markdown-review";
import { tiptapReviewKey } from "../../src/lib/tiptap-review";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import type { OpenTab } from "../../src/components/libera/types";
import { flushPendingState } from "../../src/components/libera/deferred-save";

async function settle(ms: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mountReview(untitled = false) {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    innerHeight: 768, innerWidth: 1024,
  });
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
  const source = "Hello there\n\nSecond paragraph";
  const stored: ReviewDocument = { ...newReview(untitled ? "draft:Notes/review.md" : "Notes/review.md", source, "review-id"), enabled: true,
    threads: [{ id: "comment-id", anchor: anchorAt(source, { start: 0, end: 11 }), status: "open", messages: [{ id: "message-id", text: "Existing comment", createdAt: "2026-09-12" }] }],
  };
  const documents = new Map([[stored.id, stored]]);
  const originalFetch = globalThis.fetch;
  let failSync = false, holdSync = false, holdReload = false;
  let heldAction = "", failedAction = "";
  let finishAction: (() => void) | undefined;
  let finishSync: (() => void) | undefined, finishReload: (() => void) | undefined;
  const calls: string[] = [];
  let syncEdits: unknown;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const action = body?.action ?? "reload";
    calls.push(action);
    if (action === "sync") syncEdits = body.edits;
    if (action === "reload") {
      const response = structuredClone(documents.get(new URL(String(url), "http://localhost").searchParams.get("id")!)!);
      if (holdReload) await new Promise<void>((resolve) => { finishReload = resolve; });
      return Response.json(response);
    }
    if (action === "load") {
      const existing = [...documents.values()].find((doc) => doc.key === body.key);
      const doc = existing ?? { ...newReview(body.key, body.snapshot, `other-${documents.size}`), enabled: true };
      documents.set(doc.id, doc);
      return Response.json(doc);
    }
    if (action === "migrate-path") {
      for (const doc of documents.values()) if (doc.key === body.from) { doc.key = body.to; doc.revision++; }
      return Response.json({ migrated: true });
    }
    if (action === heldAction) await new Promise<void>((resolve) => { finishAction = resolve; });
    if (action === failedAction) { failedAction = ""; return Response.json({ error: "Review write failed." }, { status: 500 }); }
    if (action === "sync") {
      if (holdSync) await new Promise<void>((resolve) => { finishSync = resolve; });
      if (failSync) { failSync = false; documents.get(body.id)!.revision++; return Response.json({ error: "Review changed in another window. Reload review before retrying." }, { status: 409 }); }
    }
    const current = documents.get(body.id)!;
    assert.equal(body.revision, current.revision, "Review mutations must use the current revision");
    const next = syncReview(structuredClone(current), body.snapshot);
    if (action === "comment") next.threads.push({ id: `comment-${next.revision}`, anchor: anchorAt(body.snapshot, body.range), status: "open", messages: [{ id: "new-message", text: body.text, createdAt: "2026-09-12" }] });
    if (action === "decision") next.snapshot += "\n\nAccepted.";
    next.revision++;
    documents.set(next.id, next);
    return Response.json(next);
  };
  const { TiptapMarkdownEditor } = await import("../../src/components/libera/tiptap-markdown-editor");
  let review!: NonNullable<ReturnType<typeof useMarkdownReview>>;
  let activeId = "Notes/review.md";
  let setId!: (id: string) => void;
  let saveAs!: (path: string) => void;
  let markClean!: () => void;
  function Probe() { review = useMarkdownReview()!; return null; }
  function Harness() {
    const [draft, setDraft] = useState(source);
    const [id, changeId] = useState(activeId);
    const [savedPath, setSavedPath] = useState<string | null>(null);
    const [status, setStatus] = useState("dirty");
    markClean = () => setStatus("clean");
    saveAs = setSavedPath;
    setId = changeId; activeId = id;
    const draftRef = useRef(source);
    const tab = { id, draft, saved: source, status, untitled: untitled && id === "Notes/review.md" && !savedPath, file: { fileType: "markdown", path: savedPath ?? id } } as OpenTab;
    // createElement requires the provider's declared children prop for type checking.
    // eslint-disable-next-line react/no-children-prop
    return createElement(MarkdownReviewProvider, {
      activeTab: tab, getDraft: () => draftRef.current,
      applyDraft: (_id, before, after) => { if (before !== draftRef.current) return false; draftRef.current = after; setDraft(after); return true; },
      recoverDraft: () => {}, openChat: () => {}, openComments: () => {},
      children: [createElement(Probe, { key: "probe" }), createElement(TiptapMarkdownEditor, {
        key: id, documentPath: id, value: draft, fontSizePx: 16, lineHeight: 1.5, markdownZoom: 100,
        onMarkdownZoomChange: () => {}, onChange: (text) => { draftRef.current = text; setDraft(text); }, onSave: async () => {}, onOpenFileLink: async () => false,
      })],
    });
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => { root.render(createElement(StrictMode, null, createElement(Harness))); });
  await settle(50);
  const editor = (document.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  return {
    dom, editor, calls, documents, markClean: () => markClean(), saveAs: (path: string) => saveAs(path), get review() { return review; }, get syncEdits() { return syncEdits; },
    holdSync() { holdSync = true; }, finishSync() { holdSync = false; finishSync!(); },
    holdAction(name: string) { heldAction = name; }, failAction(name: string) { failedAction = name; }, finishAction() { heldAction = ""; finishAction!(); },
    // Leaving the window is one of the moments a review is stored.
    blur() { return act(async () => { dom.window.dispatchEvent(new dom.window.Event("blur")); }); },
    holdReload() { holdReload = true; }, finishReload() { holdReload = false; finishReload!(); },
    failSync() { failSync = true; }, switchTab(id: string) { setId(id); },
    async dispose() { await act(async () => root.unmount()); dom.window.close(); globalThis.fetch = originalFetch; },
  };
}

test("background comment sync keeps Visual focus, selection and editability while typing continues", async () => {
  const h = await mountReview();
  try {
    const { editor } = h;
    h.holdSync();
    await act(async () => { editor.commands.setTextSelection(6); editor.view.focus(); editor.commands.insertContent(" edit"); });
    await settle(300);
    await settle(950);
    assert.equal(h.calls.filter((action) => action === "sync").length, 0, "Typing alone does not store the review");
    await h.blur();
    assert.equal(h.review.busy, "sync");
    assert.equal(h.review.locked, false);
    assert.equal(editor.isEditable, true);
    assert.equal(editor.view.dom.getAttribute("contenteditable"), "true");
    assert.equal(document.activeElement, editor.view.dom);
    await act(async () => editor.commands.insertContent(" during sync"));
    const selection = editor.state.selection;
    const doc = editor.state.doc;
    await act(async () => h.finishSync());
    assert.equal(editor.state.doc, doc, "Sync must not replace the live document");
    assert.equal(editor.state.selection, selection);
    assert.equal(document.activeElement, editor.view.dom);
    await act(async () => editor.commands.insertContent(" more typing"));
    assert.match(editor.getText(), /more typing/);
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("review UI updates reuse projected anchors and visual decorations when text is unchanged", async () => {
  const h = await mountReview();
  try {
    await act(async () => { h.editor.commands.setTextSelection(6); h.editor.commands.insertContent(" edit"); });
    await settle(300);
    const projected = h.review.doc;
    const decorations = tiptapReviewKey.getState(h.editor.state);
    assert.match(projected!.snapshot, /edit/);
    await act(async () => { h.review.selectThread("comment-id"); });
    assert.equal(h.review.doc, projected, "An unrelated provider render must not resynchronize anchors");
    assert.equal(tiptapReviewKey.getState(h.editor.state), decorations, "Do not rebuild visual comment decorations");
  } finally { await h.dispose(); }
});

test("comment sync waits for IME composition without raising a reload error", async () => {
  const h = await mountReview();
  try {
    await act(async () => { h.editor.view.focus(); h.editor.commands.insertContent("a"); });
    await settle(300);
    await act(async () => { h.editor.view.dom.dispatchEvent(new h.dom.window.CompositionEvent("compositionstart", { bubbles: true })); });
    await h.blur();
    await settle(1000);
    assert.equal(h.calls.filter((action) => action === "sync").length, 0);
    assert.equal(h.review.error, "");
    assert.equal(h.editor.isEditable, true);
    await act(async () => { h.editor.commands.insertContent("Tiếng Việt"); h.editor.view.dom.dispatchEvent(new h.dom.window.CompositionEvent("compositionend", { bubbles: true })); });
    await h.blur();
    await settle(350);
    assert.ok(h.calls.includes("sync"));
    assert.equal(h.review.error, "");
    assert.equal(document.activeElement, h.editor.view.dom);
  } finally { await h.dispose(); }
});

test("formatted live selections can add comments; reload recovers a conflict without switching editor modes", async () => {
  const h = await mountReview();
  try {
    const { editor } = h;
    await act(async () => { editor.chain().setTextSelection({ from: 1, to: 7 }).toggleBold().run(); });
    const liveDoc = editor.state.doc;
    await act(async () => { editor.view.dom.dispatchEvent(new h.dom.window.MouseEvent("mouseup", { bubbles: true })); });
    assert.equal(h.review.error, "");
    assert.ok(h.review.selection, "A bold trailing space must not block adding a comment");
    await act(async () => { assert.equal(await h.review.action("comment", { range: h.review.selection!.range, text: "New comment" }), true); });
    assert.equal(h.review.doc?.threads.length, 2);
    assert.equal(editor.state.doc, liveDoc, "Commenting must not normalize the live editor");
    h.failSync();
    await act(async () => { editor.commands.insertContent("change"); });
    await settle(300); await h.blur(); await settle(50);
    assert.match(h.review.error, /Reload review/);
    const syncCount = h.calls.filter((action) => action === "sync").length;
    await h.blur(); await settle(1000);
    assert.equal(h.calls.filter((action) => action === "sync").length, syncCount, "Failed sync must not endlessly retry a stale revision");
    h.holdReload();
    let reloading!: Promise<void>;
    await act(async () => { reloading = h.review.reload(); });
    assert.equal(h.review.locked, false);
    await h.blur(); await settle(1000);
    assert.equal(h.calls.filter((action) => action === "sync").length, syncCount, "Reload is serialized with background review writes");
    await act(async () => { h.finishReload(); await reloading; });
    assert.equal(h.review.error, "");
    await act(async () => { editor.commands.setTextSelection({ from: 1, to: 3 }); editor.view.dom.dispatchEvent(new h.dom.window.MouseEvent("mouseup", { bubbles: true })); });
    assert.ok(h.review.selection);
    await act(async () => { assert.equal(await h.review.action("comment", { range: h.review.selection!.range, text: "After reload" }), true); });
    assert.equal(h.review.doc?.threads.length, 3);
    assert.equal(editor.isDestroyed, false);
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("a delayed review reload cannot replace the next tab's comments", async () => {
  const h = await mountReview();
  try {
    h.holdReload();
    let reloading!: Promise<void>;
    await act(async () => { reloading = h.review.reload(); });
    await act(async () => h.switchTab("Notes/other.md"));
    await settle(50);
    assert.equal(h.review.doc?.key, "Notes/other.md");
    await act(async () => { h.finishReload(); await reloading; });
    assert.equal(h.review.doc?.key, "Notes/other.md");
    assert.equal(h.review.busy, "");
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("leaving a tab stores its review, with the edits made, before the next tab loads", async () => {
  const h = await mountReview();
  try {
    await act(async () => { h.editor.commands.setTextSelection(6); h.editor.commands.insertContent(" edit"); });
    await settle(300);
    assert.equal(h.calls.includes("sync"), false);
    await act(async () => h.switchTab("Notes/other.md"));
    await settle(50);
    assert.deepEqual(h.calls.slice(-2), ["sync", "load"]);
    assert.deepEqual(h.syncEdits, [{ start: 6, end: 6, text: "edit " }]);
    assert.equal(h.review.doc?.key, "Notes/other.md");
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("leaving during a sync drains edits typed in flight before loading the next tab", async () => {
  const h = await mountReview();
  try {
    h.holdSync();
    await act(async () => { h.editor.commands.setTextSelection(6); h.editor.commands.insertContent(" edit"); });
    await settle(300); await h.blur();
    await act(async () => h.editor.commands.insertContent(" later"));
    await settle(300);
    const latest = h.review.doc!.snapshot;
    const loads = h.calls.filter((action) => action === "load").length;
    await act(async () => h.switchTab("Notes/other.md"));
    assert.equal(h.calls.filter((action) => action === "load").length, loads);
    await act(async () => h.finishSync());
    await settle(50);
    assert.equal(h.documents.get("review-id")!.snapshot, latest);
    assert.equal(h.calls.filter((action) => action === "sync").length, 2);
    assert.equal(h.review.doc?.key, "Notes/other.md");
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("quit waits for a running sync then stores the newer draft", async () => {
  const h = await mountReview();
  try {
    h.holdSync();
    await act(async () => h.editor.commands.insertContent("first "));
    await settle(300); await h.blur();
    await act(async () => h.editor.commands.insertContent("second "));
    await settle(300);
    const latest = h.review.doc!.snapshot;
    let flushing!: Promise<void>;
    await act(async () => { flushing = flushPendingState(); });
    await act(async () => { h.finishSync(); await flushing; });
    assert.equal(h.documents.get("review-id")!.snapshot, latest);
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("quit captures Visual typing before the draft debounce publishes it", async () => {
  const h = await mountReview();
  try {
    await act(async () => h.editor.commands.insertContent("quick "));
    await act(async () => flushPendingState());
    assert.match(h.documents.get("review-id")!.snapshot, /quick/);
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("quit reports a failed in-flight comment write", async () => {
  const h = await mountReview();
  try {
    h.holdAction("comment"); h.failAction("comment");
    let operation!: Promise<boolean>, flushing!: Promise<void>;
    await act(async () => { operation = h.review.action("comment", { range: { start: 0, end: 5 }, text: "Must save" }); });
    await act(async () => { flushing = flushPendingState(); void flushing.catch(() => undefined); });
    await act(async () => { h.finishAction(); await assert.rejects(flushing, /Review write failed/); assert.equal(await operation, false); });
  } finally { await h.dispose(); }
});

test("leaving during a decision waits for it and preserves the accepted text", async () => {
  const h = await mountReview();
  try {
    await act(async () => h.editor.commands.insertContent("draft "));
    await settle(300);
    h.holdAction("decision");
    let operation!: Promise<boolean>;
    await act(async () => { operation = h.review.action("decision"); });
    await act(async () => h.switchTab("Notes/other.md"));
    await act(async () => { h.finishAction(); await operation; });
    await settle(50);
    assert.match(h.documents.get("review-id")!.snapshot, /Accepted\.$/);
    assert.equal(h.review.doc?.key, "Notes/other.md");
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("leaving before the Visual draft debounce preserves the outgoing editor's text", async () => {
  const h = await mountReview();
  try {
    await act(async () => { h.editor.commands.insertContent("quick "); h.switchTab("Notes/other.md"); });
    await settle(50);
    assert.match(h.documents.get("review-id")!.snapshot, /quick/);
    assert.equal(h.review.doc?.key, "Notes/other.md");
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("saving a draft to a path drains its edits and keeps its review identity", async () => {
  const h = await mountReview(true);
  try {
    await act(async () => h.editor.commands.insertContent("saved "));
    await settle(300);
    const latest = h.review.doc!.snapshot;
    await act(async () => h.saveAs("Notes/saved.md"));
    await settle(50);
    assert.equal(h.review.doc?.id, "review-id");
    assert.equal(h.review.doc?.key, "Notes/saved.md");
    assert.equal(h.review.doc?.snapshot, latest);
    assert.equal(h.review.error, "");
    assert.equal(h.documents.size, 1);
  } finally { await h.dispose(); }
});

test("saving during a sync stores edits that arrived while it was running", async () => {
  const h = await mountReview();
  try {
    h.holdSync();
    await act(async () => h.editor.commands.insertContent("first "));
    await settle(300); await h.blur();
    await act(async () => h.editor.commands.insertContent("second "));
    await settle(300);
    const latest = h.review.doc!.snapshot;
    await act(async () => h.markClean());
    await act(async () => h.finishSync());
    await settle(50);
    assert.equal(h.documents.get("review-id")!.snapshot, latest);
    assert.equal(h.calls.filter((action) => action === "sync").length, 2);
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("a draft path migrated before tab cleanup retains the leave sync and its identity", async () => {
  const h = await mountReview(true);
  try {
    await act(async () => h.editor.commands.insertContent("saved "));
    await settle(300);
    const latest = h.review.doc!.snapshot;
    const stored = h.documents.get("review-id")!;
    stored.key = "Notes/saved.md"; stored.revision++;
    await act(async () => h.switchTab("Notes/saved.md"));
    await settle(50);
    assert.equal(h.documents.get("review-id")!.snapshot, latest);
    assert.equal(h.review.doc?.id, "review-id");
    assert.equal(h.review.doc?.key, "Notes/saved.md");
    assert.equal(h.review.error, "");
    assert.equal(h.documents.size, 1);
  } finally { await h.dispose(); }
});

test("a leave sync retries a changed revision instead of silently discarding the draft", async () => {
  const h = await mountReview();
  try {
    await act(async () => h.editor.commands.insertContent("leaving "));
    await settle(300);
    const latest = h.review.doc!.snapshot;
    h.failSync();
    await act(async () => h.switchTab("Notes/other.md"));
    await settle(50);
    assert.equal(h.documents.get("review-id")!.snapshot, latest);
    assert.equal(h.calls.filter((action) => action === "sync").length, 2);
    assert.equal(h.review.error, "");
  } finally { await h.dispose(); }
});

test("a leave sync never overwrites a different snapshot stored by another window", async () => {
  const h = await mountReview();
  try {
    await act(async () => h.editor.commands.insertContent("my draft "));
    await settle(300);
    const stored = h.documents.get("review-id")!;
    const remote = { ...stored, revision: stored.revision + 1, snapshot: "Accepted text from another window." };
    h.documents.set(stored.id, remote);
    await act(async () => h.switchTab("Notes/other.md"));
    await settle(50);
    assert.equal(h.documents.get(stored.id)!.snapshot, remote.snapshot);
    assert.equal(h.calls.includes("sync"), false);
    assert.match(h.review.error, /Review text changed in another window/);
  } finally { await h.dispose(); }
});
