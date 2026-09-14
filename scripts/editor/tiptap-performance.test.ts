import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Worker as NodeWorker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import "./setup.cjs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Profiler, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { TIPTAP_DRAFT_DELAY_MS } from "../../src/components/libera/use-tiptap-draft";
import { hasTiptapHeadings } from "../../src/lib/tiptap-editor-actions";
import { tiptapFindPluginKey, updateTiptapFind } from "../../src/lib/tiptap-find";

function setupDom() {
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
  Object.assign(dom.window.Range.prototype, {
    getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect(),
  });
  return dom;
}
async function settle(delay = TIPTAP_DRAFT_DELAY_MS + 50) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, delay)); });
}
function liveEditor(): Editor {
  return (document.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
}

test("rapid typing avoids serialization and React commits; snapshots, external edits, history and IME stay correct", async (t) => {
  const dom = setupDom();
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  // Exercise the production worker entry in Node, including the opt-in large
  // notebook benchmark, instead of falling back to main-thread parsing in JSDOM.
  class HeadingWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    private worker: NodeWorker;
    constructor(url: URL) {
      this.worker = new NodeWorker(`
        require("tsx/cjs");
        const { parentPort, workerData } = require("node:worker_threads");
        globalThis.self = { postMessage: (data) => parentPort.postMessage(data) };
        require(workerData.entry);
        parentPort.on("message", (data) => self.onmessage({ data }));
      `, { eval: true, workerData: { entry: fileURLToPath(url) } });
      this.worker.on("message", (data) => this.onmessage?.({ data } as MessageEvent));
      this.worker.on("error", () => this.onerror?.());
    }
    postMessage(data: unknown) { this.worker.postMessage(data); }
    terminate() { void this.worker.terminate(); }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: HeadingWorker });
  const { TiptapMarkdownEditor } = await import("../../src/components/libera/tiptap-markdown-editor");
  const root = createRoot(document.getElementById("root")!);
  // Opt-in local benchmark; never copy a user's notebook into test fixtures.
  const source = process.env.LIBERA_PERF_DOCUMENT
    ? readFileSync(process.env.LIBERA_PERF_DOCUMENT, "utf8")
    : Array.from({ length: 150 }, (_, i) => `## Section ${i}\n\nParagraph with **bold** words and regular text. More text in this paragraph.\n\n`).join("");
  let read!: () => string;
  const register = (reader: () => string) => { read = reader; return () => {}; };
  let published = source, changes = 0, commits = 0, saved = "";
  let setExternal!: (value: string) => void;
  function Harness() {
    const [value, setValue] = useState(source);
    setExternal = setValue;
    return createElement(TiptapMarkdownEditor, {
      documentPath: "Notes/perf.md", value, fontSizePx: 16, lineHeight: 1.5, markdownZoom: 100,
      onMarkdownZoomChange: () => {}, onRegisterDraft: register,
      onChange: (markdown) => { changes++; published = markdown; setValue(markdown); },
      onViewStateChange: () => {}, onSave: async () => { saved = published; }, onOpenFileLink: async () => false,
    });
  }
  try {
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Profiler, { id: "typing", onRender: () => commits++ }, createElement(Harness)))); });
    await settle(50);
    const editor = liveEditor();
    await act(async () => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.commands.insertContent("warmup"); });
    await settle();
    // Let the status bar's independent 750 ms word-count timer finish before
    // measuring commits caused by typing (especially on large documents).
    await settle(850);
    let serializations = 0, serializationMs = 0;
    const original = editor.getMarkdown.bind(editor);
    editor.getMarkdown = () => { serializations++; const started = performance.now(); const markdown = original(); serializationMs += performance.now() - started; return markdown; };
    changes = commits = 0;
    const emptyFind = tiptapFindPluginKey.getState(editor.state);
    const times: number[] = [];
    for (let index = 0; index < 60; index++) {
      const started = performance.now();
      await act(async () => { editor.commands.insertContent("x"); });
      times.push(performance.now() - started);
    }
    assert.equal(serializations, 0, "No whole-document serialization in the typing path");
    assert.equal(changes, 0, "No workspace publication for each keystroke");
    assert.equal(commits, 0, "Ordinary typing must not render the editor or parent");
    assert.equal(tiptapFindPluginKey.getState(editor.state), emptyFind);
    const selection = editor.state.selection.from, history = undoDepth(editor.state);
    await settle();
    assert.equal(serializations, 1);
    assert.equal(changes, 1);
    assert.equal(published, original());
    assert.equal(editor.state.selection.from, selection);
    assert.equal(undoDepth(editor.state), history);
    times.sort((a, b) => a - b);
    t.diagnostic(`${Buffer.byteLength(source)} bytes / 60 edits: median ${times[30].toFixed(2)} ms, p95 ${times[57].toFixed(2)} ms; one deferred serialization (${serializationMs.toFixed(2)} ms)`);

    await act(async () => { editor.commands.insertContent(" saved immediately"); document.querySelector<HTMLButtonElement>('[aria-label="Save document"]')!.click(); });
    assert.equal(saved, original(), "Save includes the unflushed final characters");
    await act(async () => { editor.commands.insertContent(" snapshot"); assert.equal(read(), original()); });
    await act(async () => { editor.commands.undo(); });
    await settle();
    assert.equal(published, original());
    await act(async () => { editor.commands.redo(); });
    await settle();
    assert.equal(published, original());

    await act(async () => { editor.commands.insertContent(" obsolete pending text"); setExternal("# External\n\nReplacement"); });
    const beforeSettle = changes;
    await settle();
    assert.equal(read(), "# External\n\nReplacement");
    assert.equal(editor.getText(), "External\n\nReplacement");
    assert.equal(changes, beforeSettle, "External replacement cancels the old pending publication");
    assert.equal(hasTiptapHeadings(editor.state.doc), true);
    await act(async () => { setExternal("No headings"); });
    assert.equal(hasTiptapHeadings(editor.state.doc), false);

    const beforeComposition = serializations;
    await act(async () => {
      editor.view.dom.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
      editor.commands.insertContent("Tiếng Việt");
    });
    await settle();
    assert.equal(serializations, beforeComposition, "IME input stays in ProseMirror during composition");
    await act(async () => { editor.view.dom.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true })); });
    await settle();
    assert.equal(published, original());

    await act(async () => { updateTiptapFind(editor, { query: "Việt" }); });
    assert.equal(tiptapFindPluginKey.getState(editor.state)?.matches.length, 1);
    await act(async () => { editor.commands.selectAll(); editor.commands.insertContent("Other text"); });
    assert.equal(tiptapFindPluginKey.getState(editor.state)?.matches.length, 0);
    await act(async () => { root.unmount(); });
    assert.equal(published, "Other text", "Unmount publishes pending edits before destroying the editor");
    const atUnmount = changes;
    await settle();
    assert.equal(changes, atUnmount, "No orphaned publication after unmount");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    if (originalWorker) Object.defineProperty(globalThis, "Worker", originalWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});

test("workspace reads pending Visual edits for saves, exports, close guards, and tab/mode switches", async () => {
  const dom = setupDom();
  const { TiptapMarkdownEditor } = await import("../../src/components/libera/tiptap-markdown-editor");
  const { useLiberaWorkspace } = await import("../../src/components/libera/use-libera-workspace");
  const { emptyTree } = await import("../../src/components/libera/api-client");
  const { useCallback } = await import("react");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(emptyTree());
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  let setVisual!: (visual: boolean) => void;
  function Harness() {
    workspace = useLiberaWorkspace(false).workspace;
    const [visual, changeVisual] = useState(true);
    setVisual = changeVisual;
    const tab = workspace.activeTab;
    const registerEditorDraft = workspace.registerEditorDraft;
    const id = tab?.id;
    const register = useCallback((read: () => string) => registerEditorDraft(id!, read), [id, registerEditorDraft]);
    if (!tab || !visual) return null;
    return createElement(TiptapMarkdownEditor, {
      key: tab.id, documentPath: tab.file.path, untitled: true, value: tab.draft,
      fontSizePx: 16, lineHeight: 1.5, markdownZoom: 100, onMarkdownZoomChange: () => {},
      onRegisterDraft: register, onChange: workspace.setActiveDraft,
      onSave: workspace.saveActiveTab, onOpenFileLink: async () => false,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  let saved = "", exported = "";
  window.liberaExport = {
    saveMarkdownFile: async (input) => { saved = input.content; return { canceled: false, saveId: "test-file", fileName: "Test.md" }; },
    exportMarkdownPdf: async (input) => { exported = input.content; return { canceled: true }; },
  };
  try {
    await act(async () => { root.render(createElement(StrictMode, null, createElement(Harness))); });
    await act(async () => { workspace.createUntitledFile(); });
    await settle(50);
    const firstId = workspace.activeTab!.id;
    await act(async () => { liveEditor().commands.insertContent("first pending"); workspace.createUntitledFile(); });
    await settle(50);
    assert.equal(workspace.tabs.find((tab) => tab.id === firstId)?.draft, "first pending");
    assert.equal(workspace.activeTab!.draft, "", "Old editor cleanup must not write into the newly active tab");
    await act(async () => { liveEditor().commands.insertContent("second pending"); workspace.setActiveTabId(firstId); });
    await settle(50);
    assert.equal(liveEditor().getText(), "first pending");
    assert.equal(workspace.tabs.find((tab) => tab.id !== firstId)?.draft, "second pending");

    await act(async () => { liveEditor().commands.insertContent(" mode switch"); setVisual(false); });
    assert.match(workspace.activeTab!.draft, /mode switch/);
    await act(async () => { setVisual(true); });
    await settle(50);
    await act(async () => { liveEditor().commands.insertContent(" save"); await workspace.saveActiveTab(); });
    await act(async () => { await workspace.submitSaveDraft("Test", ""); });
    assert.equal(saved, liveEditor().getMarkdown());
    assert.equal(workspace.activeTab!.status, "clean");
    await act(async () => { liveEditor().commands.insertContent(" last keystroke"); await workspace.saveActiveTab(); });
    assert.equal(saved, liveEditor().getMarkdown(), "Standalone save reads the pending editor snapshot");
    assert.equal(workspace.activeTab!.status, "clean");

    let finishSave!: () => void;
    window.liberaExport!.saveMarkdownFile = async (input) => {
      saved = input.content;
      await new Promise<void>((resolve) => { finishSave = resolve; });
      return { canceled: false, saveId: "test-file", fileName: "Test.md" };
    };
    let saving!: Promise<void>;
    await act(async () => { liveEditor().commands.insertContent(" saving"); saving = workspace.saveActiveTab(); });
    await act(async () => { liveEditor().commands.insertContent(" typed during save"); finishSave(); await saving; });
    assert.notEqual(saved, liveEditor().getMarkdown());
    assert.equal(workspace.activeTab!.saved, saved);
    assert.equal(workspace.activeTab!.draft, liveEditor().getMarkdown());
    assert.equal(workspace.activeTab!.status, "dirty", "Save completion must preserve unpublished in-flight edits");

    await act(async () => { liveEditor().commands.insertContent(" PDF"); await workspace.downloadMarkdownPdf(workspace.activeTab!); });
    assert.equal(exported, liveEditor().getMarkdown());
    await act(async () => { liveEditor().commands.insertContent(" close"); workspace.closeTab(firstId); });
    assert.equal(workspace.workspaceConfirmDialog?.mode, "close-tab");
    assert.ok(workspace.tabs.some((tab) => tab.id === firstId));
    await act(async () => { workspace.closeWorkspaceConfirmDialog(); });
    const unload = new dom.window.Event("beforeunload", { cancelable: true });
    await act(async () => { liveEditor().commands.insertContent(" unload"); window.dispatchEvent(unload); });
    assert.equal(unload.defaultPrevented, true);
    assert.equal(workspace.activeTab!.draft, liveEditor().getMarkdown());
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.fetch = originalFetch;
  }
});
