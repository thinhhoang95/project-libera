import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useCallback, useEffect, useMemo } from "react";
import { draftRevision, projectChromeTabs, useChromeTabs, type ChromeTab } from "../../src/components/libera/tab-chrome";
import { useStableHandlers } from "../../src/components/libera/use-stable-handlers";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import type { OpenTab } from "../../src/components/libera/types";
import type { ChatMessage, ChatStore } from "../../src/lib/document-chat";

function setupDom() {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "FileReader"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  return dom;
}

// A tab keeps its file object while its text changes, as in the workspace hook.
const fileOf = new Map<string, OpenTab["file"]>();
function tabOf(id: string, patch: Partial<OpenTab> = {}): OpenTab {
  if (!fileOf.has(id)) fileOf.set(id, { path: `Notes/${id}.md`, name: `${id}.md`, fileType: "markdown", notebook: "Notes", createdAt: "2026-09-14", updatedAt: "2026-09-14" } as OpenTab["file"]);
  return { id, draft: "", saved: "", status: "clean", file: fileOf.get(id)!, ...patch };
}

test("projectChromeTabs reuses objects and the array unless a chrome field changed, and never carries text or view state", () => {
  const a = tabOf("a", { draft: "one", saved: "one", viewState: { markdown: { line: 1 } } });
  const b = tabOf("b", { draft: "two" });
  const first = projectChromeTabs([], [a, b]);
  assert.equal(first.length, 2);
  for (const tab of first) {
    for (const key of ["draft", "saved", "viewState"]) assert.ok(!(key in tab), `no ${key} key`);
  }

  // Draft, saved text and view state only: same array, same elements.
  const typed = projectChromeTabs(first, [
    { ...a, draft: "one two", viewState: { markdown: { line: 40, selectionStart: 3 } } },
    { ...b, saved: "two", draft: "three" },
  ]);
  assert.equal(typed, first);

  // A status change replaces only that tab's object.
  const dirty = projectChromeTabs(first, [{ ...a, status: "dirty" }, b]);
  assert.notEqual(dirty, first);
  assert.notEqual(dirty[0], first[0]);
  assert.equal(dirty[0].status, "dirty");
  assert.equal(dirty[1], first[1]);

  // Error, name and path changes likewise.
  const failed = projectChromeTabs(first, [{ ...a, status: "error", error: "disk full" }, b]);
  assert.equal(failed[0].error, "disk full");
  assert.equal(failed[1], first[1]);
  const renamedFile = { ...b.file, name: "renamed.md", path: "Notes/renamed.md" };
  const renamed = projectChromeTabs(first, [a, { ...b, file: renamedFile }]);
  assert.equal(renamed[0], first[0]);
  assert.notEqual(renamed[1], first[1]);
  assert.equal(renamed[1].file.name, "renamed.md");

  // A field that disappears (error cleared) is a change too.
  const cleared = projectChromeTabs(failed, [{ ...a, status: "clean" }, b]);
  assert.ok(!("error" in cleared[0]));

  // Reordering keeps every element and changes the array; adding and removing do as well.
  const swapped = projectChromeTabs(first, [b, a]);
  assert.notEqual(swapped, first);
  assert.deepEqual(swapped.map((tab) => tab.id), ["b", "a"]);
  assert.equal(swapped[0], first[1]);
  assert.equal(swapped[1], first[0]);
  const added = projectChromeTabs(first, [a, b, tabOf("c")]);
  assert.equal(added.length, 3);
  assert.equal(added[0], first[0]);
  const removed = projectChromeTabs(first, [b]);
  assert.equal(removed.length, 1);
  assert.equal(removed[0], first[1]);
});

test("useChromeTabs keeps identities across renders that only change drafts", async () => {
  const dom = setupDom();
  // Loaded after the DOM exists: react-dom decides at load time whether input events are supported.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const seen: Array<readonly ChromeTab[]> = [];
  function Probe({ tabs }: { tabs: OpenTab[] }) {
    seen.push(useChromeTabs(tabs));
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe, { tabs: [tabOf("a"), tabOf("b")] })));
    await act(async () => root.render(createElement(Probe, { tabs: [tabOf("a", { draft: "x" }), tabOf("b", { viewState: { markdown: { line: 9 } } })] })));
    await act(async () => root.render(createElement(Probe, { tabs: [tabOf("a", { draft: "xy", status: "dirty" }), tabOf("b")] })));
    assert.equal(seen[1], seen[0]);
    assert.notEqual(seen[2], seen[0]);
    assert.equal(seen[2][1], seen[0][1]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("the tab strip renders zero times for a draft or view-state change and once for a clean to dirty change", async () => {
  const dom = setupDom();
  // Loaded after the DOM exists: react-dom decides at load time whether input events are supported.
  const { createRoot } = await import("react-dom/client");
  const require = createRequire(import.meta.url);
  // WindowControls is rendered by every render of TabStrip and by nothing else, so its count is the strip's.
  const stripRenders: string[] = [];
  const controlsPath = require.resolve("../../src/components/libera/window-controls");
  const savedControls = require.cache[controlsPath];
  require.cache[controlsPath] = { id: controlsPath, filename: controlsPath, loaded: true, exports: { WindowControls: () => { stripRenders.push("render"); return null; } } } as unknown as NodeModule;
  window.liberaPlatform = { glass: false, isElectron: true, platform: "darwin" };
  const { TabStrip } = await import("../../src/components/libera/tab-strip");
  const root = createRoot(document.getElementById("root")!);
  const shellRenders: string[] = [];
  const notebookColors = {};
  const downloads: Array<string | undefined> = [];

  // What LiberaApp does: a fresh closure per render goes through the stable layer, and the strip gets projected tabs.
  function Shell({ tabs }: { tabs: OpenTab[] }) {
    shellRenders.push(tabs[0].draft);
    const chrome = useChromeTabs(tabs);
    const activeTab = useMemo(() => chrome.find((tab) => tab.id === "a"), [chrome]);
    const actions = useStableHandlers({
      onToggleChat: () => { downloads.push(tabs[0].draft); },
      onCreateUntitled: () => undefined,
      onCreateUntitledText: () => undefined,
      onMarkdownEditorModeChange: (_mode: "visual" | "source") => undefined,
      onLatexEditorModeChange: (_mode: "visual" | "source") => undefined,
      onAddToAiChat: (_tab: ChromeTab) => undefined,
      onDeleteFile: async (_tab: ChromeTab) => undefined,
      onDownloadAnnotatedPdf: async (_tab: ChromeTab) => undefined,
      onDownloadMarkdownPdf: async (_tab: ChromeTab) => undefined,
      onMoveFile: async (_tab: ChromeTab) => undefined,
      onRenameFile: async (_tab: ChromeTab) => undefined,
      onActivateTab: (_tabId: string) => undefined,
      onCloseOtherTabs: (_tabId: string) => undefined,
      onCloseTab: (_tabId: string) => undefined,
      onDuplicateMarkdown: (_file: OpenTab["file"]) => undefined,
      onDownloadFile: (_file: OpenTab["file"], content?: string) => { downloads.push(content); },
      onSave: async () => undefined,
      onSwapTabs: (_source: string, _target: string) => undefined,
      readTabDraft: (tabId: string) => tabs.find((tab) => tab.id === tabId)?.draft,
    });
    return createElement(TabStrip, {
      ...actions, chatOpen: false, markdownEditorMode: "visual", latexEditorMode: "source", activeTab, activeTabId: "a", notebookColors, tabs: chrome,
    });
  }

  try {
    await act(async () => root.render(createElement(Shell, { tabs: [tabOf("a", { draft: "one", status: "dirty" }), tabOf("b")] })));
    const mounted = stripRenders.length;
    assert.equal(mounted, 1, "the strip mounts once");
    for (const draft of ["one two", "one two three", "one two three four"]) {
      await act(async () => root.render(createElement(Shell, { tabs: [tabOf("a", { draft, status: "dirty", viewState: { markdown: { line: draft.length } } }), tabOf("b")] })));
    }
    assert.equal(shellRenders.length, 4, "the shell rendered for every draft");
    assert.equal(stripRenders.length, mounted, "the strip did not render for any draft or view-state change");
    // Saved text catching up with the draft is not a chrome change either.
    await act(async () => root.render(createElement(Shell, { tabs: [tabOf("a", { draft: "one two three four", saved: "one two three four", status: "dirty" }), tabOf("b")] })));
    assert.equal(stripRenders.length, mounted);

    await act(async () => root.render(createElement(Shell, { tabs: [tabOf("a", { draft: "one two three four", saved: "one two three four", status: "clean" }), tabOf("b")] })));
    assert.equal(stripRenders.length, mounted + 1, "a dirty to clean change renders the strip once");
    await act(async () => root.render(createElement(Shell, { tabs: [tabOf("a", { draft: "edited", saved: "one two three four", status: "dirty" }), tabOf("b")] })));
    assert.equal(stripRenders.length, mounted + 2, "a clean to dirty change renders the strip once");

    // The download item reads the draft of the moment it is chosen, through the reader prop.
    let menuChoice: string | null = "download-markdown";
    window.liberaMenu = { popup: async () => menuChoice } as unknown as Window["liberaMenu"];
    await act(async () => root.render(createElement(Shell, { tabs: [tabOf("a", { draft: "latest text", saved: "", status: "dirty" }), tabOf("b")] })));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="File actions"]')!.click());
    assert.deepEqual(downloads.at(-1), "latest text");
    menuChoice = null;
  } finally {
    await act(async () => root.unmount());
    if (savedControls) require.cache[controlsPath] = savedControls; else delete require.cache[controlsPath];
    dom.window.close();
  }
});

test("the chat panel renders zero times for a draft change, still sends the latest draft, and wakes for a status change", async () => {
  const dom = setupDom();
  // Loaded after the DOM exists: react-dom decides at load time whether input events are supported.
  const { createRoot } = await import("react-dom/client");
  const require = createRequire(import.meta.url);
  // ChatTokenUsage is rendered by every render of the panel once its chat has loaded, and by nothing else.
  const panelRenders: string[] = [];
  const usagePath = require.resolve("../../src/components/libera/chat-token-usage");
  const savedUsage = require.cache[usagePath];
  require.cache[usagePath] = { id: usagePath, filename: usagePath, loaded: true, exports: { ChatTokenUsage: () => { panelRenders.push("render"); return null; } } } as unknown as NodeModule;
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  const originalFetch = globalThis.fetch;
  let savedHistory: ChatStore | null = null;
  const requests: { messages: ChatMessage[] }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/state")) {
      if (init?.method === "PUT") { savedHistory = JSON.parse(String(init.body)).value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory });
    }
    if (url === "/api/document-chat") {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ text: "Answer" });
    }
    return Response.json({});
  };
  const root = createRoot(document.getElementById("root")!);
  const shellRenders: string[] = [];
  const files: OpenTab["file"][] = [tabOf("a").file];
  const mathMarkers = {};
  const noop = () => undefined;

  function Shell({ tabs }: { tabs: OpenTab[] }) {
    shellRenders.push(tabs[0].draft);
    const chrome = useChromeTabs(tabs);
    const activeTab = useMemo(() => chrome.find((tab) => tab.id === "a"), [chrome]);
    const readers = useStableHandlers({ readOpenTabs: () => tabs });
    useEffect(() => { draftRevision.bump(); }, [tabs]);
    const onCollapsedChange = useCallback(noop, []);
    const onCreateDraft = useCallback(noop, []);
    return createElement(DocumentChatPanel, { activeTab, tabs: chrome, readOpenTabs: readers.readOpenTabs, files, collapsed: false, mathMarkers, onCollapsedChange, onCreateDraft });
  }
  const host = document.getElementById("root")!;
  const settle = async () => { await act(flushPendingState); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const render = async (tabs: OpenTab[]) => { await act(async () => root.render(createElement(Shell, { tabs }))); await settle(); };

  try {
    await render([tabOf("a", { draft: "# first", status: "dirty" })]);
    await settle();
    const mounted = panelRenders.length;
    assert.ok(mounted >= 1, "the panel rendered with its chat loaded");
    for (const draft of ["# first draft", "# first draft two", "# first draft two three"]) {
      await render([tabOf("a", { draft, status: "dirty", viewState: { markdown: { line: 2 } } })]);
    }
    assert.equal(shellRenders.length, 4, "the shell rendered for every draft");
    assert.equal(panelRenders.length, mounted, "the panel did not render for any draft or view-state change");

    // Sending reads the draft of that moment, not the one of the panel's last render.
    await act(async () => {
      const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Explain this");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(flushPendingState);
    const sendButton = host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    await act(async () => sendButton.click());
    await settle();
    await settle();
    await act(flushPendingState);
    assert.ok(requests.length, "a request was made");
    const sent = requests.at(-1)!.messages.flatMap((message) => message.contexts ?? []).find((context) => context.kind === "document");
    assert.equal(sent?.text, "# first draft two three");

    const before = panelRenders.length;
    await render([tabOf("a", { draft: "# first draft two three", status: "clean" })]);
    assert.ok(panelRenders.length > before, "a status change renders the panel");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    if (savedUsage) require.cache[usagePath] = savedUsage; else delete require.cache[usagePath];
    dom.window.close();
  }
});

test("the agent review strip re-checks an open draft when the draft revision moves", async () => {
  const dom = setupDom();
  // Loaded after the DOM exists: react-dom decides at load time whether input events are supported.
  const { createRoot } = await import("react-dom/client");
  const { AgentReviewStrip } = await import("../../src/components/libera/agent-review-strip");
  const { agentReviewStore } = await import("../../src/lib/agent-review/store");
  const originalFetch = globalThis.fetch;
  const file = { path: "Research/plan.md", baseline: "a\n", current: "a\nb\n", created: false, revision: "r1" };
  globalThis.fetch = async (_input, init) => init?.method === "POST" ? Response.json({ ok: true }) : Response.json({ files: [file] });
  const root = createRoot(document.getElementById("root")!);
  let draft = "a\nb\n";
  const readTabDraft = () => draft;
  const props = { readTabDraft, onOpenFile: noop, onReverted: noop, onError: noop };
  function noop() { return undefined; }
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  try {
    await act(async () => root.render(createElement(AgentReviewStrip, props)));
    await settle();
    await settle();
    const row = () => document.querySelector(`[aria-label="Review ${file.path}"]`)?.textContent;
    assert.match(row() ?? "", /\+1/);
    // The parent does not re-render, as with a memoized chat panel; only the revision moves.
    draft = "a\nb\nc\nd\n";
    await act(async () => draftRevision.bump());
    assert.match(row() ?? "", /\+3/, "the counts follow the new draft");
  } finally {
    await act(async () => root.unmount());
    await agentReviewStore.keep([file.path]).catch(() => undefined);
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
