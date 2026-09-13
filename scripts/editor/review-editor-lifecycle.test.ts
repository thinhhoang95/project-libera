import "./setup.cjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { anchorAt, newReview, syncReview, type ReviewDocument } from "../../src/lib/markdown-review";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import type { OpenTab } from "../../src/components/libera/types";

async function settle(ms: number) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mountReview() {
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
  let stored: ReviewDocument = { ...newReview("Notes/review.md", source, "review-id"), enabled: true,
    threads: [{ id: "comment-id", anchor: anchorAt(source, { start: 0, end: 11 }), status: "open", messages: [{ id: "message-id", text: "Existing comment", createdAt: "2026-09-12" }] }],
  };
  const originalFetch = globalThis.fetch;
  let failSync = false, holdSync = false, holdReload = false;
  let finishSync: (() => void) | undefined, finishReload: (() => void) | undefined;
  const calls: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const action = body?.action ?? "reload";
    calls.push(action);
    if (action === "reload") {
      const response = structuredClone(stored);
      if (holdReload) await new Promise<void>((resolve) => { finishReload = resolve; });
      return Response.json(response);
    }
    if (action === "load") {
      if (body.key !== stored.key) stored = { ...newReview(body.key, body.snapshot, "other-review-id"), enabled: true };
      return Response.json(stored);
    }
    if (action === "sync") {
      if (holdSync) await new Promise<void>((resolve) => { finishSync = resolve; });
      if (failSync) { failSync = false; stored = { ...stored, revision: stored.revision + 1 }; return Response.json({ error: "Review changed in another window. Reload review before retrying." }, { status: 409 }); }
    }
    assert.equal(body.revision, stored.revision, "Review mutations must use the current revision");
    stored = syncReview(structuredClone(stored), body.snapshot);
    if (action === "comment") stored.threads.push({ id: `comment-${stored.revision}`, anchor: anchorAt(body.snapshot, body.range), status: "open", messages: [{ id: "new-message", text: body.text, createdAt: "2026-09-12" }] });
    stored.revision++;
    return Response.json(stored);
  };
  const { TiptapMarkdownEditor } = await import("../../src/components/libera/tiptap-markdown-editor");
  let review!: NonNullable<ReturnType<typeof useMarkdownReview>>;
  let activeId = "Notes/review.md";
  let setId!: (id: string) => void;
  function Probe() { review = useMarkdownReview()!; return null; }
  function Harness() {
    const [draft, setDraft] = useState(source);
    const [id, changeId] = useState(activeId);
    setId = changeId; activeId = id;
    const draftRef = useRef(source);
    const tab = { id, draft, saved: source, status: "dirty", file: { fileType: "markdown", path: id } } as OpenTab;
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
    dom, editor, calls, get review() { return review; },
    holdSync() { holdSync = true; }, finishSync() { holdSync = false; finishSync!(); },
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

test("comment sync waits for IME composition without raising a reload error", async () => {
  const h = await mountReview();
  try {
    await act(async () => { h.editor.view.focus(); h.editor.commands.insertContent("a"); });
    await settle(300);
    await act(async () => { h.editor.view.dom.dispatchEvent(new h.dom.window.CompositionEvent("compositionstart", { bubbles: true })); });
    await settle(1000);
    assert.equal(h.calls.filter((action) => action === "sync").length, 0);
    assert.equal(h.review.error, "");
    assert.equal(h.editor.isEditable, true);
    await act(async () => { h.editor.commands.insertContent("Tiếng Việt"); h.editor.view.dom.dispatchEvent(new h.dom.window.CompositionEvent("compositionend", { bubbles: true })); });
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
    await settle(300); await settle(950);
    assert.match(h.review.error, /Reload review/);
    const syncCount = h.calls.filter((action) => action === "sync").length;
    await settle(1000);
    assert.equal(h.calls.filter((action) => action === "sync").length, syncCount, "Failed sync must not endlessly retry a stale revision");
    h.holdReload();
    let reloading!: Promise<void>;
    await act(async () => { reloading = h.review.reload(); });
    assert.equal(h.review.locked, false);
    await settle(1000);
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
