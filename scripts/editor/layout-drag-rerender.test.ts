import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Profiler, useState, type ComponentProps } from "react";
import { normalizeMarkdownPreferences } from "../../src/lib/markdown-preferences";
import type { OpenTab } from "../../src/components/libera/types";

type WorkspacePanelType = typeof import("../../src/components/libera/workspace-panel").WorkspacePanel;

// Frames run only when a test says so, so "once per frame" is observable.
function setupDom() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "Event", "DOMParser", "MutationObserver"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  const requestFrame = (callback: () => void) => { frames.set(nextFrame, callback); return nextFrame++; };
  const cancelFrame = (id: number) => { frames.delete(id); };
  Object.assign(dom.window, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame,
    innerHeight: 768, innerWidth: 1024,
  });
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  Object.assign(dom.window.HTMLElement.prototype, { setPointerCapture: () => {}, releasePointerCapture: () => {}, hasPointerCapture: () => true });
  const runFrames = async () => {
    const due = [...frames.values()];
    frames.clear();
    await act(async () => { due.forEach((callback) => callback()); });
  };
  return { dom, runFrames };
}

function documentTab(id: string, fileType: "markdown" | "text" = "markdown"): OpenTab {
  return { id, draft: `# Document ${id}`, saved: "", status: "dirty",
    file: { path: id, name: id, fileType, notebook: "Notes", createdAt: "2026-09-14", updatedAt: "2026-09-14" } as OpenTab["file"] };
}

async function withProbedEditors(run: (WorkspacePanel: WorkspacePanelType) => Promise<void>) {
  const require = createRequire(import.meta.url);
  const EditorProbe = () => createElement("div");
  const mocks = [
    ["../../src/components/libera/tiptap-markdown-editor", { TiptapMarkdownEditor: EditorProbe }],
    ["../../src/components/libera/markdown-editor", { MarkdownEditor: EditorProbe }],
    ["../../src/components/libera/markdown-worker-preview", { MarkdownWorkerPreview: () => null }],
  ] as const;
  const saved = mocks.map(([path]) => { const id = require.resolve(path); return { id, module: require.cache[id] }; });
  mocks.forEach(([, exports], i) => { require.cache[saved[i].id] = { exports } as NodeModule; });
  try {
    const { WorkspacePanel } = await import("../../src/components/libera/workspace-panel");
    await run(WorkspacePanel);
  } finally {
    saved.forEach(({ id, module }) => { if (module) require.cache[id] = module; else delete require.cache[id]; });
  }
}

function panelProps(WorkspacePanel: WorkspacePanelType, activeTab: OpenTab): ComponentProps<WorkspacePanelType> {
  const noOp = () => {};
  const asyncNoOp = async () => {};
  return {
    markdownEditorMode: "source", activePreviewTabId: null, onActivePreviewTabIdChange: noOp,
    files: [], aiFormatting: false, canStartScreenshotSnip: false, firstNotebook: "", imageMarkdownConverting: false,
    yourName: "", markdownPreferences: normalizeMarkdownPreferences({}), recentFiles: [], screenshotSnipSession: null,
    tabs: [activeTab], textareaRef: { current: null }, onAiFormatSelection: asyncNoOp, onShiftMarkdownList: noOp, onAiImageToMarkdown: asyncNoOp,
    onAiRewriteSelection: asyncNoOp, onAiWriteAt: asyncNoOp, onCreateMarkdown: asyncNoOp, onCreateSlides: asyncNoOp, onCreateNotebook: noOp, fileTags: {}, onEditFileTags: noOp,
    onCancelScreenshotSnip: noOp, onCompleteScreenshotSnip: asyncNoOp, onInsertExistingImage: asyncNoOp,
    onFinishVisualInsertion: noOp, onCreateMarkdownBesidePdf: async () => { throw new Error("unused"); }, onWriteConvertedMarkdown: asyncNoOp,
    onInsertFileLink: noOp, onInsertFileLinkPlaceholder: noOp, onInsertImage: asyncNoOp, onInsertMarkdown: noOp, onInsertMarkdownTable: noOp,
    onOpenFile: asyncNoOp, onSave: asyncNoOp, onSetDraft: noOp, onSetViewState: noOp,
    onOpenMarkdownFileLink: async () => false, onStartScreenshotSnip: noOp,
    activeTab, focused: true,
  };
}

function dragSlider(slider: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(slider, String(value));
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("dragging the zoom slider re-renders only panes that show the zoom, and saves once at release", async () => {
  const { dom } = setupDom();
  const puts: string[] = [];
  Object.assign(globalThis, { fetch: async (url: string, init?: RequestInit) => { if (String(url).includes("/api/preferences/markdown-display")) puts.push(String(init?.body)); return new Response("{}", { status: 200 }); } });
  // React reads the DOM at load time, so it loads after the DOM exists.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await withProbedEditors(async (WorkspacePanel) => {
      const { MarkdownDisplayPreferencesProvider, useMarkdownDisplayPreference, useMarkdownDisplayPreferenceActions } = await import("../../src/components/libera/markdown-display-preferences");
      const { MarkdownDisplayZoom } = await import("../../src/components/libera/markdown-display-zoom");
      const commits = { text: 0, markdown: 0 };
      function Slider() {
        const zoom = useMarkdownDisplayPreference("textScale");
        const { updatePreferences } = useMarkdownDisplayPreferenceActions();
        return createElement(MarkdownDisplayZoom, { markdownBaseFontSize: 16, markdownZoom: zoom, onMarkdownZoomChange: (value: number) => updatePreferences({ textScale: value }) });
      }
      const textTab = documentTab("Notes/pic.txt", "text");
      const mdTab = documentTab("Notes/a.md");
      await act(async () => root.render(createElement(MarkdownDisplayPreferencesProvider, null,
        createElement(Slider),
        createElement(Profiler, { id: "text", onRender: () => { commits.text++; } }, createElement(WorkspacePanel, panelProps(WorkspacePanel, textTab))),
        createElement(Profiler, { id: "markdown", onRender: () => { commits.markdown++; } }, createElement(WorkspacePanel, panelProps(WorkspacePanel, mdTab))),
      )));
      const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      const before = { ...commits };
      const steps = [105, 110, 115, 120, 125, 130, 135, 140];
      for (const step of steps) await act(async () => dragSlider(slider, step));
      assert.equal(commits.text - before.text, 0, "a pane that shows no zoom stays still during the drag");
      // The pane shows the zoom, so it follows each step (plus a settling commit at most).
      assert.ok(commits.markdown - before.markdown <= steps.length + 2, "the Markdown pane renders about once per step");
      assert.equal(puts.length, 0, "nothing is saved while dragging");
      await act(async () => { slider.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)); });
      assert.equal(puts.length, 1, "release saves once");
      assert.equal(JSON.parse(puts[0]).textScale, 140, "the saved zoom is the last value");
      assert.equal(slider.value, "140");
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("dragging the Markdown editor/preview splitter paints a CSS variable per frame and commits once at release", async (context) => {
  const { dom, runFrames } = setupDom();
  // React reads the DOM at load time, so it loads after the DOM exists.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    await withProbedEditors(async (WorkspacePanel) => {
      let commits = 0;
      const tab = documentTab("Notes/a.md");
      await act(async () => root.render(createElement(Profiler, { id: "panel", onRender: () => { commits++; } },
        createElement(WorkspacePanel, panelProps(WorkspacePanel, tab)))));
      const storage = context.mock.method(dom.window.Storage.prototype, "setItem");
      const resizer = document.querySelector<HTMLElement>('[role="separator"]')!;
      const grid = resizer.closest<HTMLElement>(".markdown-split-grid")!;
      grid.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 1000, 1000);
      const before = commits;
      await act(async () => { resizer.dispatchEvent(new dom.window.MouseEvent("pointerdown", { clientY: 500, bubbles: true })); });
      const afterDown = commits;
      for (const clientY of [550, 700, 600, 20, 990]) {
        await act(async () => { window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientY, bubbles: true })); });
      }
      assert.equal(commits, afterDown, "pointer moves commit nothing");
      await act(async () => { window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientY: 600, bubbles: true })); });
      await runFrames();
      assert.equal(grid.style.getPropertyValue("--markdown-split"), "60%");
      assert.equal(resizer.getAttribute("aria-valuenow"), "60");
      assert.equal(commits, afterDown);
      await act(async () => { window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true })); });
      assert.ok(commits - before <= 1, "the whole gesture commits at most once");
      assert.equal(storage.mock.calls.filter((call) => call.arguments[0] === "libera.markdownEditorPreviewSplitPercent").length, 1);
      assert.equal(window.localStorage.getItem("libera.markdownEditorPreviewSplitPercent"), "60");
      assert.equal(resizer.getAttribute("aria-valuenow"), "60");
      // Dragging past the end clamps.
      await act(async () => { resizer.dispatchEvent(new dom.window.MouseEvent("pointerdown", { clientY: 600, bubbles: true })); });
      await act(async () => { window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientY: 5000, bubbles: true })); });
      await act(async () => { window.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true })); });
      assert.equal(Number(window.localStorage.getItem("libera.markdownEditorPreviewSplitPercent")), 76);
      assert.equal(resizer.getAttribute("aria-valuenow"), "76");
      // The keyboard still commits per key.
      const keyCommits = commits;
      await act(async () => { resizer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
      await act(async () => { resizer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
      assert.equal(commits - keyCommits, 2);
      assert.equal(resizer.getAttribute("aria-valuenow"), "66");
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("dragging the canvas splitter moves panes and handle by frame and commits the ratio once", async () => {
  const { dom, runFrames } = setupDom();
  // React reads the DOM at load time, so it loads after the DOM exists.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  try {
    const { CanvasSplitView } = await import("../../src/components/libera/canvas-split-view");
    const { useCanvasLayout } = await import("../../src/components/libera/use-canvas-layout");
    let controls!: ReturnType<typeof useCanvasLayout>;
    let commits = 0;
    const resizes: number[] = [];
    const tabs = ["a", "b"].map((id) => documentTab(id, "text"));
    function App() {
      const [activeTabId, activateTab] = useState("a");
      controls = useCanvasLayout({ tabs, activeTabId, activateTab });
      return createElement(Profiler, { id: "canvas", onRender: () => { commits++; } },
        createElement(CanvasSplitView, { layout: controls.layout, tabs,
          onFocusPane: controls.focusPane, onSplitPane: controls.splitPane, onClosePane: controls.closePane,
          onPlaceTab: controls.placeTab, onDropTab: controls.dropTab,
          onResizeSplit: (id: string, ratio: number) => { resizes.push(ratio); controls.resizeSplit(id, ratio); },
          renderPane: () => createElement("div") }));
    }
    await act(async () => root.render(createElement(App)));
    await act(async () => controls.splitPane(controls.layout.focusedPaneId, "right", "b"));
    const handle = document.querySelector<HTMLElement>('[role="separator"]')!;
    const container = document.querySelector<HTMLElement>(".libera-canvas")!;
    container.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 1000, 600);
    const panes = () => [...document.querySelectorAll<HTMLElement>(".libera-canvas-pane")];
    const before = commits;
    await act(async () => { handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { clientX: 500, bubbles: true })); });
    const afterDown = commits;
    for (const clientX of [550, 600, 650]) {
      await act(async () => { handle.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX, bubbles: true })); });
    }
    await runFrames();
    assert.equal(handle.style.left, "65%");
    assert.equal(panes()[0].style.width, "65%");
    assert.equal(handle.getAttribute("aria-valuenow"), "65");
    assert.equal(commits, afterDown, "moves commit nothing");
    assert.deepEqual(resizes, []);
    await act(async () => { handle.dispatchEvent(new dom.window.MouseEvent("pointerup", { clientX: 700, bubbles: true })); });
    assert.deepEqual(resizes, [0.7], "the ratio at the release point is committed once");
    assert.ok(commits - before <= 3, "start, layout and end: no per-move commits");
    assert.equal(handle.style.left, "70%");
    assert.equal(handle.getAttribute("aria-valuenow"), "70");
    // A cancelled drag puts the panes back.
    await act(async () => { handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { clientX: 700, bubbles: true })); });
    await act(async () => { handle.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 300, bubbles: true })); });
    await runFrames();
    assert.equal(handle.style.left, "30%");
    await act(async () => { handle.dispatchEvent(new dom.window.MouseEvent("pointercancel", { bubbles: true })); });
    assert.equal(handle.style.left, "70%");
    assert.deepEqual(resizes, [0.7]);
    // The keyboard still commits per key.
    await act(async () => { handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    assert.equal(resizes.length, 2);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("dragging the LaTeX source/preview splitter paints a CSS variable per frame and commits once at release", async (context) => {
  const { dom, runFrames } = setupDom();
  Object.assign(globalThis, { fetch: async () => new Response("{}", { status: 200 }) });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const require = createRequire(import.meta.url);
  const Stand = () => createElement("div");
  const mocks = [
    ["../../src/components/libera/latex/latex-editor", { LatexEditor: Stand }],
    ["../../src/components/libera/latex/latex-pdf-preview", { LatexPdfPreview: Stand }],
    ["../../src/components/libera/latex/latex-insert-toolbar", { LatexInsertToolbar: Stand }],
  ] as const;
  const saved = mocks.map(([path]) => { const id = require.resolve(path); return { id, module: require.cache[id] }; });
  mocks.forEach(([, exports], i) => { require.cache[saved[i].id] = { exports } as NodeModule; });
  try {
    const { LatexWorkspace } = await import("../../src/components/libera/latex/latex-workspace");
    const noOp = () => {};
    const tab = { ...documentTab("Notes/paper.tex", "text"), file: { path: "Notes/paper.tex", name: "paper.tex", fileType: "latex", notebook: "Notes" } } as unknown as OpenTab;
    let commits = 0;
    await act(async () => root.render(createElement(Profiler, { id: "latex", onRender: () => { commits++; } },
      createElement(LatexWorkspace, { tab, files: [], fontFamily: "monospace", visualFontFamily: "serif", fontSizePx: 14, lineHeight: 1.5,
        readOpenTabs: () => [tab], onSetDraft: noOp, onRegisterDraft: () => noOp, onSave: async () => {}, onSetViewState: noOp, onOpenFile: async () => {} } as never))));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    await runFrames();
    const storage = context.mock.method(dom.window.Storage.prototype, "setItem");
    const resizer = document.querySelector<HTMLElement>('[role="separator"]')!;
    const grid = resizer.closest<HTMLElement>(".markdown-split-grid")!;
    grid.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 1000, 1000);
    await act(async () => { resizer.dispatchEvent(new dom.window.MouseEvent("pointerdown", { clientY: 500, bubbles: true })); });
    const afterDown = commits;
    for (const clientY of [550, 700, 600]) {
      await act(async () => { resizer.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientY, bubbles: true })); });
    }
    await runFrames();
    assert.equal(commits, afterDown, "pointer moves and frames commit nothing");
    assert.equal(grid.style.getPropertyValue("--markdown-split"), "60%");
    assert.equal(resizer.getAttribute("aria-valuenow"), "60");
    await act(async () => { resizer.dispatchEvent(new dom.window.MouseEvent("pointerup", { clientY: 600, bubbles: true })); });
    assert.ok(commits - afterDown <= 1, "release commits once");
    const writes = storage.mock.calls.filter((call) => String(call.arguments[0]).toLowerCase().includes("split"));
    assert.equal(writes.length, 1, "release saves once");
    assert.equal(resizer.getAttribute("aria-valuenow"), "60");
    // Dragging past the end clamps.
    await act(async () => { resizer.dispatchEvent(new dom.window.MouseEvent("pointerdown", { clientY: 600, bubbles: true })); });
    await act(async () => { resizer.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientY: 5000, bubbles: true })); });
    await act(async () => { resizer.dispatchEvent(new dom.window.MouseEvent("pointerup", { clientY: 5000, bubbles: true })); });
    assert.equal(resizer.getAttribute("aria-valuenow"), resizer.getAttribute("aria-valuemax"));
    // The keyboard still commits per key.
    const keyCommits = commits;
    await act(async () => { resizer.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    assert.equal(commits - keyCommits, 1);
  } finally {
    await act(async () => root.unmount());
    saved.forEach(({ id, module }) => { if (module) require.cache[id] = module; else delete require.cache[id]; });
    dom.window.close();
  }
});
