import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, memo, useCallback, useMemo, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { emptyTree } from "../../src/components/libera/api-client";
import { createSidebarSearchStore } from "../../src/components/libera/sidebar-search-store";
import { useStableHandlers } from "../../src/components/libera/use-stable-handlers";
import type { OpenTab } from "../../src/components/libera/types";
import { emptyWorkspaceSession } from "../../src/lib/workspaces";
import type { LiberaFileNode, LiberaTree } from "../../src/lib/types";

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
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  return dom;
}

function markdownTab(draft: string): OpenTab {
  return { id: "Notes/a.md", draft, saved: "", status: "dirty",
    file: { path: "Notes/a.md", name: "a.md", fileType: "markdown", notebook: "Notes", createdAt: "2026-09-14", updatedAt: "2026-09-14" } as OpenTab["file"] };
}

test("useStableHandlers keeps one identity per key, calls the latest function and passes arguments and results through", async () => {
  const dom = setupDom();
  const root = createRoot(document.getElementById("root")!);
  const seen: Array<{ add: (a: number, b: number) => number; note: (text?: string) => string }> = [];
  function Probe({ base }: { base: number }) {
    seen.push(useStableHandlers({
      add: (a: number, b: number) => a + b + base,
      note: (text = "default") => `${base}:${text}`,
    }));
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe, { base: 1 })));
    await act(async () => root.render(createElement(Probe, { base: 10 })));
    await act(async () => root.render(createElement(Probe, { base: 100 })));
    assert.equal(seen.length, 3);
    assert.ok(seen.every((handlers) => handlers.add === seen[0].add && handlers.note === seen[0].note), "wrappers keep their identity");
    assert.equal(seen[0].add(2, 3), 105, "the latest function runs, arguments and return value pass through");
    // A defaulted parameter still applies: no argument is invented for the caller.
    assert.equal(seen[0].note(), "100:default");
    assert.equal(seen[0].note("x"), "100:x");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("useStableHandlers wrappers called before the first commit reach the first render's functions", async () => {
  const dom = setupDom();
  const root = createRoot(document.getElementById("root")!);
  const calls: string[] = [];
  let early: (() => void) | undefined;
  function Probe() {
    const handlers = useStableHandlers({ ping: () => { calls.push("ping"); } });
    early = handlers.ping;
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    early!();
    assert.deepEqual(calls, ["ping"]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("the notebook tree does not render when only the active tab's draft changes", async () => {
  const dom = setupDom();
  // SidebarSearch is rendered by every render of NotebookPanel and by nothing
  // else, so its render count is the panel's. (A Profiler above the panel
  // cannot tell: it commits whenever its own parent renders.)
  const require = createRequire(import.meta.url);
  const panelRenders: string[] = [];
  const searchPath = require.resolve("../../src/components/libera/sidebar-search");
  const savedSearch = require.cache[searchPath];
  require.cache[searchPath] = { id: searchPath, filename: searchPath, loaded: true, exports: { SidebarSearch: () => { panelRenders.push("render"); return null; } } } as unknown as NodeModule;
  const { NotebookPanel } = await import("../../src/components/libera/notebook-panel");
  const { WorkspaceViewContext } = await import("../../src/components/libera/workspace-view-context");
  type Props = ComponentProps<typeof NotebookPanel>;
  const root = createRoot(document.getElementById("root")!);
  const shellRenders: string[] = [];
  const tree: LiberaTree = emptyTree();
  const expanded = new Set<string>();
  const fileInteractions = {};
  const searchStore = createSidebarSearchStore();
  const uploadInputRef = { current: null };
  const updateView = async () => undefined;
  const openedWith: string[] = [];

  // Mirrors what LiberaApp does: every render builds fresh closures (as the
  // workspace hook's function declarations are), forwards them through the
  // stable layer, and hands the left panel the new tab object. Only the tab differs.
  function Shell({ activeTab, treeProp, extra }: { activeTab: OpenTab; treeProp: LiberaTree; extra?: boolean }) {
    shellRenders.push(activeTab.draft);
    const draft = activeTab.draft;
    const asyncNoOp = async () => undefined;
    const noOp = () => undefined;
    const stable = useStableHandlers({
      onDuplicateMarkdown: noOp, onCopyFile: asyncNoOp, onArchiveFile: asyncNoOp, onArchiveFolder: asyncNoOp, onCreateFolder: asyncNoOp,
      onCreateMarkdown: asyncNoOp, onCreateSlides: asyncNoOp, onCreateLatex: asyncNoOp, onCreateTextFile: asyncNoOp, onCreateNotebook: noOp,
      onCreateNotebookGroup: noOp, onDeleteNotebook: asyncNoOp, onDeleteNotebookGroup: asyncNoOp, onDeleteFile: asyncNoOp, onDeleteFolder: asyncNoOp,
      onDownloadFile: noOp, onDownloadNotebook: noOp, onEditNotebook: noOp, onEditNotebookGroup: noOp, onMoveFile: asyncNoOp,
      onOpenFile: async (file: LiberaFileNode) => { openedWith.push(`${file.path}@${draft}`); },
      onRenameFolder: asyncNoOp, onRenameFile: asyncNoOp, onSelectNotebook: noOp, onSelectSearchResult: noOp,
      onStartUpload: noOp, onToggleFileStar: asyncNoOp, onEditFileTags: noOp, onToggleNotebook: noOp, onUploadChange: asyncNoOp,
      onUploadFiles: asyncNoOp, onUpdateNotebookViewOptions: asyncNoOp, onCloseDirectory: noOp,
    });
    const onOpenMigration = useCallback(() => stable.onCreateNotebook(), [stable]);
    const onManageWorkspace = useCallback(() => undefined, []);
    const workspaceView = useMemo(() => ({ view: undefined, updateView }), []);
    // An inline closure on purpose, to show the probe notices an unstable prop.
    const unstable = extra ? { onNotebookRepaired: () => undefined } : {};
    return createElement("div", null,
      createElement("output", null, activeTab.draft),
      createElement(WorkspaceViewContext.Provider, { value: workspaceView },
        createElement(NotebookPanel, {
          ...stable, ...unstable, onOpenMigration, onManageWorkspace, workspaceActive: false, canOpenDirectories: false,
          activeTabId: activeTab.id, expanded, fileInteractions, searchStore, selectedNotebookName: "", tree: treeProp, uploadInputRef,
        } satisfies Props)));
  }

  try {
    await act(async () => root.render(createElement(Shell, { activeTab: markdownTab("one"), treeProp: tree })));
    const mounted = panelRenders.length;
    assert.equal(mounted, 1, "the panel mounts once");
    for (const draft of ["one two", "one two three", "one two three four"]) {
      await act(async () => root.render(createElement(Shell, { activeTab: markdownTab(draft), treeProp: tree })));
    }
    assert.equal(shellRenders.length, 4, "the shell itself rendered for every draft");
    assert.equal(panelRenders.length, mounted, "the notebook panel did not render for any draft publication");
    assert.equal(document.querySelector("output")!.textContent, "one two three four");

    // The controls: an inline closure or a new tree does wake the panel, so the count above means something.
    await act(async () => root.render(createElement(Shell, { activeTab: markdownTab("x"), treeProp: tree, extra: true })));
    assert.equal(panelRenders.length, mounted + 1, "an inline closure renders the panel");
    await act(async () => root.render(createElement(Shell, { activeTab: markdownTab("y"), treeProp: tree, extra: true })));
    assert.equal(panelRenders.length, mounted + 2, "a fresh inline closure on every render renders it every time");
    await act(async () => root.render(createElement(Shell, { activeTab: markdownTab("z"), treeProp: { ...tree } })));
    assert.equal(panelRenders.length, mounted + 3, "a new tree renders the panel");
  } finally {
    await act(async () => root.unmount());
    if (savedSearch) require.cache[searchPath] = savedSearch; else delete require.cache[searchPath];
    dom.window.close();
  }
});

test("a workspace manager's updateView keeps one identity across renders and still forwards calls", async () => {
  const dom = setupDom();
  const { useSavedWorkspaces } = await import("../../src/components/libera/use-saved-workspaces");
  const root = createRoot(document.getElementById("root")!);
  const seen: Array<(change: never) => Promise<void>> = [];
  function Probe() {
    const manager = useSavedWorkspaces({
      authenticated: false, tree: emptyTree(), refreshTree: async () => emptyTree(), session: emptyWorkspaceSession(),
      readDraft: () => "", applySession: () => {}, onError: () => {},
    });
    seen.push(manager.updateView as never);
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => root.render(createElement(Probe)));
    assert.equal(seen.length, 3);
    assert.ok(seen.every((updateView) => updateView === seen[0]));
    // Before a workspace is loaded the real function refuses, synchronously; the wrapper must not hide that.
    assert.throws(() => seen[0](((view: unknown) => view) as never), /wait for your workspace/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("the left panel forwards identical props to the notebook panel when only the active tab changed", async () => {
  const dom = setupDom();
  const require = createRequire(import.meta.url);
  const forwarded: Array<Record<string, unknown>> = [];
  const Probe = memo(function NotebookProbe(props: Record<string, unknown>) {
    forwarded.push(props);
    return null;
  });
  const modulePath = require.resolve("../../src/components/libera/notebook-panel");
  const saved = require.cache[modulePath];
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports: { NotebookPanel: Probe } } as unknown as NodeModule;
  const root = createRoot(document.getElementById("root")!);
  try {
    const { LeftPanel } = await import("../../src/components/libera/left-panel");
    type Props = ComponentProps<typeof LeftPanel>;
    const noOp = () => undefined;
    const asyncNoOp = async () => undefined;
    const tree = emptyTree();
    const stableProps: Props = {
      workspaceManager: { activeWorkspace: undefined, switching: false } as unknown as Props["workspaceManager"],
      fullTree: tree, tree, activePanel: "notebook", onPanelChange: noOp, collapsed: false, textareaRef: { current: null },
      onLogout: asyncNoOp, onSetDraft: noOp, onToggleCollapsed: noOp, onGeneratedFilesSaved: noOp,
      activeTabId: "Notes/a.md", expanded: new Set(), fileInteractions: {}, searchStore: createSidebarSearchStore(), selectedNotebookName: "", uploadInputRef: { current: null },
      onDuplicateMarkdown: noOp, onCopyFile: asyncNoOp, onArchiveFile: asyncNoOp, onArchiveFolder: asyncNoOp, onCreateFolder: asyncNoOp,
      onCreateMarkdown: asyncNoOp, onCreateSlides: asyncNoOp, onCreateNotebook: noOp, onCreateNotebookGroup: noOp, onDeleteNotebook: asyncNoOp,
      onDeleteNotebookGroup: asyncNoOp, onDeleteFile: asyncNoOp, onDeleteFolder: asyncNoOp, onDownloadFile: noOp, onDownloadNotebook: noOp,
      onEditNotebook: noOp, onEditNotebookGroup: noOp, onMoveFile: asyncNoOp, onOpenFile: asyncNoOp, onRenameFolder: asyncNoOp,
      onRenameFile: asyncNoOp, onSelectNotebook: noOp, onSelectSearchResult: noOp, onStartUpload: noOp, onToggleFileStar: asyncNoOp,
      onEditFileTags: noOp, onToggleNotebook: noOp, onUploadChange: asyncNoOp, onUploadFiles: asyncNoOp, onUpdateNotebookViewOptions: asyncNoOp,
    };
    const render = (draft: string): ReactNode => createElement(LeftPanel, { ...stableProps, activeTab: markdownTab(draft) });
    await act(async () => root.render(render("one")));
    await act(async () => root.render(render("one two")));
    await act(async () => root.render(render("one two three")));
    assert.equal(forwarded.length, 1, "the notebook panel received props once; later left-panel renders did not reach it");
    // Every forwarded prop is also identical on a further render that does reach the probe.
    await act(async () => root.render(createElement(LeftPanel, { ...stableProps, activeTab: markdownTab("two"), searchStore: createSidebarSearchStore() })));
    assert.equal(forwarded.length, 2);
    for (const key of Object.keys(forwarded[0])) {
      if (key === "searchStore") continue;
      assert.ok(Object.is(forwarded[0][key], forwarded[1][key]), `prop ${key} kept its identity`);
    }
  } finally {
    await act(async () => root.unmount());
    if (saved) require.cache[modulePath] = saved; else delete require.cache[modulePath];
    dom.window.close();
  }
});
