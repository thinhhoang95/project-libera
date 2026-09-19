import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { OpenTab } from "../../src/components/libera/types";

test("file actions use one native menu between comments and the AI panel", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
    pretendToBeVisual: true,
    url: "http://localhost",
  });

  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  }

  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });

  const tab = {
    id: "draft-1",
    file: {
      kind: "file",
      name: "Draft.md",
      path: "Notes/Draft.md",
      notebook: "Notes",
      fileType: "markdown",
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z",
      size: 7,
    },
    draft: "# Draft",
    saved: "",
    status: "dirty",
  } satisfies OpenTab;
  let menuAction: string | null = "editor-source";
  let capturedMenu: LiberaNativeMenuInput | null = null;
  let editorMode = "";
  let saved = 0;

  window.liberaPlatform = { glass: false, isElectron: true, platform: "darwin" };
  window.liberaMenu = {
    popup: async (menu) => {
      capturedMenu = menu;
      return menuAction;
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      schemaVersion: 1,
      id: "review-1",
      key: tab.file.path,
      revision: 0,
      snapshot: tab.draft,
      enabled: false,
      threads: [],
      undo: [],
    });

  const { createRoot } = await import("react-dom/client");
  const { MarkdownReviewProvider } = await import(
    "../../src/components/libera/markdown-review-context"
  );
  const { TabStrip } = await import("../../src/components/libera/tab-strip");
  const root = createRoot(document.getElementById("root")!);
  const tabStrip = createElement(TabStrip, {
    activeTab: tab,
    activeTabId: tab.id,
    chatOpen: false,
    markdownEditorMode: "visual",
    notebookColors: {},
    tabs: [tab],
    onActivateTab: () => undefined,
    onCloseOtherTabs: () => undefined,
    onCloseTab: () => undefined,
    onCreateUntitled: () => undefined,
    onDeleteFile: async () => undefined,
    onDownloadFile: () => undefined,
    onDownloadMarkdownPdf: async () => undefined,
    onDuplicateMarkdown: () => undefined,
    onMarkdownEditorModeChange: (mode) => {
      editorMode = mode;
    },
    onMoveFile: async () => undefined,
    onRenameFile: async () => undefined,
    onSave: async () => {
      saved += 1;
    },
    onSwapTabs: () => undefined,
    onToggleChat: () => undefined,
  });

  try {
    await act(async () => {
      root.render(
        createElement(
          MarkdownReviewProvider,
          {
            activeTab: tab,
            applyDraft: () => true,
            getDraft: () => tab.draft,
            openChat: () => undefined,
            openComments: () => undefined,
            recoverDraft: () => undefined,
          },
          tabStrip,
        ),
      );
    });

    const commentButton = document.querySelector<HTMLButtonElement>('[aria-label="Review mode"]');
    const menuButton = document.querySelector<HTMLButtonElement>('[aria-label="File actions"]');
    const aiButton = document.querySelector<HTMLButtonElement>('[aria-label="Toggle document chat"]');
    assert.ok(commentButton);
    assert.ok(menuButton);
    assert.ok(aiButton);
    assert.ok(commentButton.compareDocumentPosition(menuButton) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(menuButton.compareDocumentPosition(aiButton) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(document.querySelector('[aria-label="Save"]'), null);
    assert.equal(document.querySelector('[aria-label="Download"]'), null);
    assert.equal(document.querySelector('[aria-label="Rename"]'), null);
    assert.equal(document.querySelector('[aria-label="Move"]'), null);
    assert.equal(document.querySelector('[aria-label="Delete"]'), null);

    await act(async () => menuButton.click());
    assert.equal(editorMode, "source");
    assert.ok(capturedMenu);
    const items = capturedMenu.items;
    const editorItem = items.find(
      (item): item is Exclude<LiberaNativeMenuItem, { type: "separator" }> =>
        item.type !== "separator" && item.id === "editor-mode",
    );
    const downloadItem = items.find(
      (item): item is Exclude<LiberaNativeMenuItem, { type: "separator" }> =>
        item.type !== "separator" && item.id === "download",
    );
    assert.deepEqual(
      editorItem?.submenu?.map((item) => (item.type === "separator" ? "separator" : [item.id, item.checked])),
      [
        ["editor-visual", true],
        ["editor-source", false],
      ],
    );
    assert.deepEqual(
      downloadItem?.submenu?.map((item) => (item.type === "separator" ? "separator" : item.id)),
      ["download-markdown", "download-pdf"],
    );

    menuAction = "save";
    await act(async () => menuButton.click());
    assert.equal(saved, 1);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
