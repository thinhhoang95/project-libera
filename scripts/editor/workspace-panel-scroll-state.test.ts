import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { normalizeMarkdownPreferences } from "../../src/lib/markdown-preferences";
import type { MarkdownTabViewState, OpenTab, OpenTabViewState } from "../../src/components/libera/types";
import { captureCanvasViewState } from "../../src/components/libera/canvas-view-state";

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


test("visual scroll positions are stored when scrolling pauses, not on every frame", async () => {
  const dom = setupDom();
  const require = createRequire(import.meta.url);
  let report: (patch: MarkdownTabViewState) => void = () => {};
  function EditorProbe(props: { onViewStateChange?: (patch: MarkdownTabViewState) => void }) {
    if (props.onViewStateChange) report = props.onViewStateChange;
    return createElement("div");
  }
  const mocks = [
    ["../../src/components/libera/tiptap-markdown-editor", { TiptapMarkdownEditor: EditorProbe }],
    ["../../src/components/libera/markdown-editor", { MarkdownEditor: EditorProbe }],
    ["../../src/components/libera/markdown-worker-preview", { MarkdownWorkerPreview: () => null }],
  ] as const;
  const saved = mocks.map(([path]) => { const id = require.resolve(path); return { id, module: require.cache[id] }; });
  mocks.forEach(([, exports], i) => { require.cache[saved[i].id] = { exports } as NodeModule; });
  const { WorkspacePanel } = await import("../../src/components/libera/workspace-panel");
  const noOp = () => {};
  const asyncNoOp = async () => {};
  const props: ComponentProps<typeof WorkspacePanel> = {
    markdownEditorMode: "source", activePreviewTabId: null, onActivePreviewTabIdChange: noOp,
    files: [], aiFormatting: false, canStartScreenshotSnip: false, firstNotebook: "", imageMarkdownConverting: false,
    yourName: "", markdownPreferences: normalizeMarkdownPreferences({}), recentFiles: [], screenshotSnipSession: null,
    tabs: [], textareaRef: { current: null }, onAiFormatSelection: asyncNoOp, onShiftMarkdownList: noOp, onAiImageToMarkdown: asyncNoOp,
    onAiRewriteSelection: asyncNoOp, onAiWriteAt: asyncNoOp, onCreateMarkdown: asyncNoOp, onCreateSlides: asyncNoOp, onCreateNotebook: noOp, fileTags: {}, onEditFileTags: noOp,
    onCancelScreenshotSnip: noOp, onCompleteScreenshotSnip: asyncNoOp, onInsertExistingImage: asyncNoOp,
    onFinishVisualInsertion: noOp, onCreateMarkdownBesidePdf: async () => { throw new Error("unused"); }, onWriteConvertedMarkdown: asyncNoOp,
    onInsertFileLink: noOp, onInsertFileLinkPlaceholder: noOp, onInsertImage: asyncNoOp, onInsertMarkdown: noOp, onInsertMarkdownTable: noOp,
    onOpenFile: asyncNoOp, onSave: asyncNoOp, onSetDraft: noOp, onSetViewState: noOp,
    onOpenMarkdownFileLink: async () => false, onStartScreenshotSnip: noOp,

  };
  const root = createRoot(document.getElementById("root")!);
  let active = tab("Notes/a.md");
  const stored: { markdown?: MarkdownTabViewState; tabId?: string }[] = [];
  // The workspace's own merge: each stored patch lands in the tab's view state.
  const onSetViewState = (viewState: OpenTabViewState, tabId?: string) => {
    stored.push({ markdown: viewState.markdown, tabId });
    active = { ...active, viewState: { ...active.viewState, markdown: { ...active.viewState?.markdown, ...viewState.markdown } } };
  };
  const render = () => act(async () => root.render(createElement(WorkspacePanel, { ...props, activeTab: active, tabs: [active], markdownEditorMode: "visual", focused: true, onSetViewState })));
  const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
  try {
    await render();
    for (let frame = 1; frame <= 5; frame++) report({ visualScrollLeft: 0, visualScrollTop: frame * 40, visualScrollAnchorPos: frame, visualScrollAnchorOffset: 2 });
    assert.equal(stored.length, 0, "scroll frames alone store nothing");
    await pause(250);
    assert.deepEqual(stored, [{ markdown: { visualScrollLeft: 0, visualScrollTop: 200, visualScrollAnchorPos: 5, visualScrollAnchorOffset: 2 }, tabId: active.id }], "a pause stores the latest position once");

    // The outline's line is stored at once, carrying the position held so far.
    stored.length = 0;
    report({ visualScrollTop: 240, visualScrollAnchorPos: undefined, visualScrollAnchorOffset: undefined });
    report({ visualScrollTop: 280, line: 7 });
    assert.deepEqual(stored, [{ markdown: { visualScrollTop: 280, visualScrollAnchorPos: undefined, visualScrollAnchorOffset: undefined, line: 7 }, tabId: active.id }]);
    assert.ok("visualScrollAnchorPos" in stored[0].markdown!, "a cleared anchor stays cleared");
    await render();

    // The same line again is not news: the frame waits like any other.
    stored.length = 0;
    report({ visualScrollTop: 320, line: 7 });
    assert.equal(stored.length, 0);
    captureCanvasViewState();
    assert.deepEqual(stored, [{ markdown: { visualScrollTop: 320 }, tabId: active.id }], "a canvas capture stores what is held");
    await pause(250);
    assert.equal(stored.length, 1, "nothing is stored twice");

    // Any other update goes through at once and wins over older held positions.
    stored.length = 0;
    report({ visualScrollTop: 360 });
    report({ visualSelection: { type: "text", anchor: 1, head: 1 }, visualScrollTop: 400 });
    assert.deepEqual(stored, [{ markdown: { visualScrollTop: 400, visualSelection: { type: "text", anchor: 1, head: 1 } }, tabId: active.id }]);

    stored.length = 0;
    report({ visualScrollTop: 440 });
    await act(async () => root.render(null));
    assert.deepEqual(stored, [{ markdown: { visualScrollTop: 440 }, tabId: active.id }], "closing the pane stores what is held");
  } finally {
    await act(async () => root.unmount());
    saved.forEach(({ id, module }) => { if (module) require.cache[id] = module; else delete require.cache[id]; });
    dom.window.close();
  }
});
