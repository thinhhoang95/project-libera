import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { WorkspacePanel } from "../../src/components/libera/workspace-panel";
import { MarkdownReviewProvider, useMarkdownReview } from "../../src/components/libera/markdown-review-context";
import { normalizeMarkdownPreferences } from "../../src/lib/markdown-preferences";
import { newReview } from "../../src/lib/markdown-review";
import type { OpenTab } from "../../src/components/libera/types";

function setupDom() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
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
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: false }) });
  dom.window.HTMLElement.prototype.setPointerCapture = () => {};
  return dom;
}

function tab(id: string): OpenTab {
  return { id, draft: `# Document ${id}\n\nText for ${id}`, saved: "", status: "dirty",
    file: { path: id, name: id, fileType: "markdown", notebook: "Notes", createdAt: "2026-09-14", updatedAt: "2026-09-14" } as OpenTab["file"] };
}

test("repeated Source/Visual tab switches release workers, editors, draft readers and interrupted resize listeners", async () => {
  const dom = setupDom();
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers: TestWorker[] = [];
  class TestWorker {
    onmessage = null;
    onerror = null;
    requests: { markdown: string }[] = [];
    terminated = false;
    constructor() { workers.push(this); }
    postMessage(request: { markdown: string }) { this.requests.push(request); }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const readers = new Map<string, () => string>();
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
  window.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (["pointermove", "pointerup", "pointercancel"].includes(type)) {
      const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set);
    }
    add(type, listener, options);
  };
  window.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
    listeners.get(type)?.delete(listener); remove(type, listener, options);
  };
  const noOp = () => {};
  const asyncNoOp = async () => {};
  const props: ComponentProps<typeof WorkspacePanel> = {
    markdownEditorMode: "source", activePreviewTabId: null, onActivePreviewTabIdChange: noOp,
    files: [], aiFormatting: false, canStartScreenshotSnip: false, firstNotebook: "", imageMarkdownConverting: false,
    yourName: "", markdownPreferences: normalizeMarkdownPreferences({}), recentFiles: [], screenshotSnipSession: null,
    tabs: [], textareaRef: { current: null }, onAiFormatSelection: asyncNoOp, onAiImageToMarkdown: asyncNoOp,
    onAiRewriteSelection: asyncNoOp, onCreateMarkdown: asyncNoOp, onCreateSlides: asyncNoOp, onCreateNotebook: noOp,
    onCancelScreenshotSnip: noOp, onCompleteScreenshotSnip: asyncNoOp, onInsertExistingImage: asyncNoOp,
    onInsertFileLink: noOp, onInsertFileLinkPlaceholder: noOp, onInsertImage: asyncNoOp, onInsertMarkdown: noOp,
    onOpenFile: asyncNoOp, onSave: asyncNoOp, onSetDraft: noOp, onSetViewState: noOp,
    onOpenMarkdownFileLink: async () => false, onStartScreenshotSnip: noOp,
    onRegisterEditorDraft: (id, read) => { readers.set(id, read); return () => { if (readers.get(id) === read) readers.delete(id); }; },
  };
  async function render(activeTab?: OpenTab, mode: "source" | "visual" = "source") {
    await act(async () => root.render(createElement(StrictMode, null, createElement(WorkspacePanel, {
      ...props, activeTab, tabs: activeTab ? [activeTab] : [], markdownEditorMode: mode,
    }))));
  }
  function startDrag() {
    const separator = host.querySelector('[role="separator"]')!;
    separator.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 50 }));
  }
  function assertReleased() {
    assert.equal(workers.filter(worker => !worker.terminated).length, 0);
    assert.equal(readers.size, 0);
    for (const set of listeners.values()) assert.equal(set.size, 0, "Interrupted resize must release window listeners");
  }
  try {
    for (let i = 0; i < 6; i++) {
      const first = tab(`Notes/first-${i}.md`), second = tab(`Notes/second-${i}.md`);
      await render(first);
      await act(async () => startDrag());
      assert.equal(listeners.get("pointermove")?.size, 1);
      await render(second);
      assert.equal(listeners.get("pointermove")?.size, 0);
      const activeWorkers = workers.filter(worker => !worker.terminated);
      assert.equal(activeWorkers.length, 1);
      assert.deepEqual(activeWorkers[0].requests.map(request => request.markdown), [second.draft], "New preview must never parse the previous tab");
      assert.deepEqual([...readers.keys()], [second.id]);
      await act(async () => startDrag());
      await render(second, "visual");
      assert.equal(listeners.get("pointermove")?.size, 0);
      const editor = (host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
      await act(async () => editor.commands.insertContent(" pending"));
      await render(first);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
      assert.equal(editor.isDestroyed, true);
      assert.equal(workers.filter(worker => !worker.terminated).length, 1);
      await act(async () => startDrag());
      await render();
      assertReleased();
    }
    await render(tab("Notes/unmount.md"));
    await act(async () => startDrag());
    await act(async () => root.unmount());
    assertReleased();
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("review loads abort on switch/close and delayed responses cannot revive a closed tab", async () => {
  const dom = setupDom();
  const root = createRoot(document.getElementById("root")!);
  const originalFetch = globalThis.fetch;
  const requests: { signal: AbortSignal | null | undefined; finish: () => void }[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    await new Promise<void>(resolve => requests.push({ signal: init?.signal, finish: resolve }));
    return Response.json(newReview(body.key, body.snapshot, body.key));
  };
  let review: ReturnType<typeof useMarkdownReview>;
  function Probe() { review = useMarkdownReview(); return null; }
  async function render(activeTab?: OpenTab) {
    // The provider's children prop is required by createElement's overload.
    // eslint-disable-next-line react/no-children-prop
    await act(async () => root.render(createElement(MarkdownReviewProvider, {
      activeTab, getDraft: () => activeTab?.draft ?? "", applyDraft: () => false, recoverDraft: () => {},
      openChat: () => {}, openComments: () => {}, children: createElement(Probe),
    })));
  }
  try {
    await render(tab("Notes/first.md"));
    await render(tab("Notes/second.md"));
    assert.equal(requests[0].signal?.aborted, true);
    assert.equal(requests[1].signal?.aborted, false);
    await act(async () => { requests[1].finish(); });
    assert.equal(review!.doc?.key, "Notes/second.md");
    await render();
    assert.equal(requests[1].signal?.aborted, true);
    await act(async () => { requests[0].finish(); });
    assert.equal(review!.doc, null);
    assert.equal(review!.error, "");
    await render(tab("Notes/unmount.md"));
    await act(async () => root.unmount());
    assert.equal(requests[2].signal?.aborted, true);
    await act(async () => { requests[2].finish(); });
  } finally {
    requests.forEach(request => request.finish());
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
