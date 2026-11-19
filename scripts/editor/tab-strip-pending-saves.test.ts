import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Profiler } from "react";
import type { OpenTab } from "../../src/components/libera/types";

test("the tab strip re-renders only for the unsaved state of its own tabs", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true, url: "http://localhost" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const tab = {
    id: "pdf-1",
    file: { kind: "file", name: "Paper.pdf", path: "Notes/Paper.pdf", notebook: "Notes", fileType: "pdf", createdAt: "2026-09-15T00:00:00.000Z", updatedAt: "2026-09-15T00:00:00.000Z", size: 7 },
    draft: "",
    saved: "",
    status: "clean",
  } as unknown as OpenTab;
  const { createRoot } = await import("react-dom/client");
  const { MarkdownReviewProvider } = await import("../../src/components/libera/markdown-review-context");
  const { TabStrip } = await import("../../src/components/libera/tab-strip");
  const { pendingSaves, resetPendingSavesForTests } = await import("../../src/components/libera/pending-saves");
  const noop = () => undefined;
  const props = {
    activeTab: tab, activeTabId: tab.id, chatOpen: false, markdownEditorMode: "visual", notebookColors: {}, tabs: [tab],
    onActivateTab: noop, onAddToAiChat: noop, onCloseOtherTabs: noop, onCloseTab: noop, onCreateUntitled: noop,
    onDeleteFile: async () => undefined, onDownloadAnnotatedPdf: async () => undefined, onDownloadFile: noop,
    readTabDraft: () => undefined, onDownloadMarkdownPdf: async () => undefined, onDuplicateMarkdown: noop,
    onMarkdownEditorModeChange: noop, latexEditorMode: "source", onLatexEditorModeChange: noop, onMoveFile: async () => undefined,
    onRenameFile: async () => undefined, onSave: async () => undefined, onSwapTabs: noop, onToggleChat: noop,
  } as unknown as Parameters<typeof TabStrip>[0];
  let renders = 0;
  const root = createRoot(document.getElementById("root")!);
  const entry = { dirty: false, save: async () => undefined };
  try {
    await act(async () => {
      root.render(createElement(Profiler, { id: "strip", onRender: () => { renders++; } },
        createElement(MarkdownReviewProvider, ({ activeTab: tab, applyDraft: () => true, getDraft: () => "", openChat: noop, openComments: noop, recoverDraft: noop } as unknown as Parameters<typeof MarkdownReviewProvider>[0]), createElement(TabStrip, props))));
    });
    renders = 0;
    let unregister = () => {};
    await act(async () => { unregister = pendingSaves.register("Notes/Other.pdf", "ink", entry); });
    await act(async () => pendingSaves.setDirty("Notes/Other.pdf", "ink", true));
    await act(async () => pendingSaves.setDirty("Notes/Other.pdf", "ink", false));
    await act(async () => unregister());
    assert.equal(renders, 0, "registrations and dirty changes of files that have no tab");

    await act(async () => { unregister = pendingSaves.register(tab.file.path, "ink", { ...entry }); });
    assert.equal(renders, 0, "a registration for a shown tab that is not dirty");
    await act(async () => pendingSaves.setDirty(tab.file.path, "ink", true));
    assert.ok(renders >= 1 && renders <= 2, "a shown tab turning dirty re-renders the strip (at most one follow-up commit)");
    const afterDirty = renders;
    await act(async () => pendingSaves.setDirty(tab.file.path, "ink", false));
    assert.ok(renders > afterDirty && renders <= afterDirty + 2, "and clean again");
    await act(async () => unregister());
  } finally {
    resetPendingSavesForTests();
    await act(async () => root.unmount());
    dom.window.close();
  }
});
