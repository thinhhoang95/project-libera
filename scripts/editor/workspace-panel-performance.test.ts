import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { normalizeMarkdownPreferences } from "../../src/lib/markdown-preferences";
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


test("pane bodies skip unrelated drafts and scrolling while callbacks and link positions stay current", async () => {
  const dom = setupDom();
  const require = createRequire(import.meta.url);
  const bodies = new Map<string, { renders: number; onChange: (text: string) => void; readOpenTabs?: () => OpenTab[] }>();
  function EditorProbe(props: { documentPath?: string; activeFilePath?: string; onChange: (text: string) => void; readOpenTabs?: () => OpenTab[] }) {
    const id = (props.documentPath ?? props.activeFilePath)!;
    bodies.set(id, { renders: (bodies.get(id)?.renders ?? 0) + 1, onChange: props.onChange, readOpenTabs: props.readOpenTabs });
    return createElement("div", null, id);
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
    tabs: [], textareaRef: { current: null }, onAiFormatSelection: asyncNoOp, onAiImageToMarkdown: asyncNoOp,
    onAiRewriteSelection: asyncNoOp, onAiWriteAt: asyncNoOp, onCreateMarkdown: asyncNoOp, onCreateSlides: asyncNoOp, onCreateNotebook: noOp,
    onCancelScreenshotSnip: noOp, onCompleteScreenshotSnip: asyncNoOp, onInsertExistingImage: asyncNoOp,
    onInsertFileLink: noOp, onInsertFileLinkPlaceholder: noOp, onInsertImage: asyncNoOp, onInsertMarkdown: noOp,
    onOpenFile: asyncNoOp, onSave: asyncNoOp, onSetDraft: noOp, onSetViewState: noOp,
    onOpenMarkdownFileLink: async () => false, onStartScreenshotSnip: noOp,

  };

  const root = createRoot(document.getElementById("root")!);
  const edits: { id: string; epoch: number; text: string }[] = [];
  let a = tab("Notes/a.md"), b = tab("Notes/b.md");
  let epoch = 0;
  async function render(mode: "source" | "visual") {
    const capturedEpoch = ++epoch;
    await act(async () => root.render(createElement("div", null, ...[a, b].map((activeTab) => createElement(WorkspacePanel, {
      ...props, key: activeTab.id, activeTab, tabs: [a, b], markdownEditorMode: mode,
      focused: activeTab.id === b.id,
      onSetDraft: (text) => edits.push({ id: activeTab.id, epoch: capturedEpoch, text }),
      onSetViewState: () => {}, onSave: async () => {}, onOpenFile: async () => {},
    })))));
  }
  try {
    for (const mode of ["visual", "source"] as const) {
      await render(mode);
      const before = bodies.get(a.id)!.renders;
      for (let i = 0; i < 5; i++) {
        b = { ...b, draft: `${b.draft}x`, viewState: { markdown: { visualScrollTop: i * 100 } } };
        await render(mode);
      }
      assert.equal(bodies.get(a.id)!.renders, before, `${mode}: unchanged pane must not render`);
      bodies.get(a.id)!.onChange("latest callback");
      assert.deepEqual(edits.at(-1), { id: a.id, epoch, text: "latest callback" });
      if (mode === "source") {
        assert.equal(bodies.get(a.id)!.readOpenTabs!()[1], b, "Link insertion reads the current view position without rerendering the editor");
      }
      a = { ...a, draft: `${a.draft} edited` };
      await render(mode);
      assert.equal(bodies.get(a.id)!.renders, before + 1, "Own-document edits still render");
    }
  } finally {
    await act(async () => root.unmount());
    saved.forEach(({ id, module }) => { if (module) require.cache[id] = module; else delete require.cache[id]; });
    dom.window.close();
  }
});
