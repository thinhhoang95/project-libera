import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { useSavedWorkspaces } from "../../src/components/libera/use-saved-workspaces";
import { useCanvasViewStateCapture } from "../../src/components/libera/canvas-view-state";
import { emptyTree } from "../../src/components/libera/api-client";
import { emptyWorkspaceLibrary, emptyWorkspaceSession, type WorkspaceLibrary, type WorkspaceSession } from "../../src/lib/workspaces";
import type { OpenTab } from "../../src/components/libera/types";

test("scrolling, selecting, typing and hiding do not write workspace files; major changes and close retain the latest state", async (context) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const writes: WorkspaceLibrary[] = [];
  let recovery!: WorkspaceLibrary;
  let nativeFlush!: () => Promise<void>;
  window.liberaWorkspaces = { checkpoint: (body) => { recovery = JSON.parse(body); return { saved: true }; } };
  window.liberaPersistence = { onFlush: (flush) => { nativeFlush = flush; return () => {}; } };
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return Response.json({ saved: true }); }
    return Response.json(emptyWorkspaceLibrary());
  };
  let setSession!: React.Dispatch<React.SetStateAction<WorkspaceSession>>;
  let capturePending = false;
  let liveDraft = "draft";
  function Harness() {
    const [session, update] = useState(emptyWorkspaceSession);
    setSession = update;
    useCanvasViewStateCapture(() => {
      if (!capturePending) return;
      capturePending = false;
      update((value) => ({ ...value, tabs: value.tabs.map((tab) => ({ ...tab, viewState: { markdown: { editorScrollTop: 999, selectionStart: 7 } } })) }));
    });
    useSavedWorkspaces({ authenticated: true, tree: { ...emptyTree(), root: "/test-library" }, refreshTree: async () => emptyTree(), session,
      readDraft: () => liveDraft, applySession: update, onError: (error) => { throw new Error(error); } });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    await act(async () => root.render(createElement(Harness)));
    const tab = { id: "tab", file: { name: "a.md", path: "Notes/a.md", notebook: "Notes", fileType: "markdown" }, draft: "draft", saved: "saved", status: "dirty" } as OpenTab;
    await act(async () => setSession({ ...emptyWorkspaceSession(), tabs: [tab], activeTabId: tab.id }));
    await act(async () => context.mock.timers.tick(59_999));
    assert.equal(writes.length, 0, "tab changes wait a minute before writing");
    await act(async () => context.mock.timers.tick(1));
    assert.equal(writes.length, 1, "opening a tab saves its session");
    for (let i = 0; i < 60; i++) {
      await act(async () => setSession((value) => ({ ...value, tabs: [{ ...value.tabs[0], draft: `typing ${i}`, viewState: { markdown: { editorScrollTop: i, selectionStart: i } } }], expandedPaths: [String(i)] })));
      await act(async () => context.mock.timers.tick(100));
    }
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await act(async () => context.mock.timers.tick(60_000));
    assert.equal(writes.length, 1, "passive changes and local recovery never write synced workspace files");
    assert.ok(window.localStorage.getItem("libera:workspaces:v1:/test-library"));
    liveDraft = "final keystroke";
    capturePending = true;
    await act(nativeFlush);
    assert.equal(recovery.librarySession?.tabs[0].draft, liveDraft);
    assert.equal(recovery.librarySession?.tabs[0].viewState?.markdown?.editorScrollTop, 999);
    assert.equal(recovery.librarySession?.tabs[0].viewState?.markdown?.selectionStart, 7);
    assert.deepEqual(recovery.librarySession?.expandedPaths, ["59"]);
    assert.equal(writes.length, 1);
  } finally {
    context.mock.timers.reset();
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("tab changes share one write a minute, and closing writes a waiting save at once", async (context) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const writes: WorkspaceLibrary[] = [];
  let failWrites = false;
  let nativeFlush!: () => Promise<void>;
  window.liberaWorkspaces = { checkpoint: () => ({ saved: true }) };
  window.liberaPersistence = { onFlush: (flush) => { nativeFlush = flush; return () => {}; } };
  globalThis.fetch = async (_url, init) => {
    if (init?.method !== "PUT") return Response.json(emptyWorkspaceLibrary());
    if (failWrites) return Response.json({ error: "Server stopped" }, { status: 500 });
    writes.push(JSON.parse(String(init.body)));
    return Response.json({ saved: true });
  };
  const tabs = ["a", "b", "c"].map((id) => ({ id, file: { name: `${id}.md`, path: `Notes/${id}.md`, notebook: "Notes", fileType: "markdown" }, draft: "", saved: "", status: "clean" }) as OpenTab);
  // A canvas pane names the tab it shows, which is how a tab switch reaches the structure token.
  const showing = (tab: OpenTab) => ({ ...emptyWorkspaceSession(), tabs, activeTabId: tab.id, canvasLayout: { root: { type: "pane", id: "pane", tabId: tab.id }, focusedPaneId: "pane" } }) as WorkspaceSession;
  let setSession!: React.Dispatch<React.SetStateAction<WorkspaceSession>>;
  function Harness() {
    const [session, update] = useState(emptyWorkspaceSession);
    setSession = update;
    useSavedWorkspaces({ authenticated: true, tree: { ...emptyTree(), root: "/test-library" }, refreshTree: async () => emptyTree(), session,
      readDraft: (tab) => tab.draft, applySession: update, onError: (error) => { throw new Error(error); } });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    await act(async () => root.render(createElement(Harness)));
    // Switching every 10 seconds must neither write each time nor postpone the save forever.
    for (let i = 0; i < 6; i++) {
      await act(async () => setSession(showing(tabs[i % 3])));
      await act(async () => context.mock.timers.tick(10_000));
    }
    assert.equal(writes.length, 1, "six switches in a minute write once");
    assert.equal(writes[0].librarySession?.activeTabId, "c", "the write captures the latest tab");

    await act(async () => setSession(showing(tabs[0])));
    await act(async () => context.mock.timers.tick(5_000));
    await act(nativeFlush);
    assert.equal(writes.length, 2, "closing writes the waiting save");
    assert.equal(writes[1].librarySession?.activeTabId, "a");
    await act(async () => context.mock.timers.tick(120_000));
    assert.equal(writes.length, 2, "the cancelled timer does not write again");

    await act(nativeFlush);
    assert.equal(writes.length, 2, "closing with nothing waiting leaves the synced file alone");

    failWrites = true;
    await act(async () => setSession(showing(tabs[1])));
    await act(nativeFlush); // Rejecting would keep the app open; the recovery file already holds this state.
  } finally {
    context.mock.timers.reset();
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("desktop recovery restores unsaved drafts and reading positions on a fresh browser origin", async (context) => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost:54321" });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previousFetch = globalThis.fetch;
  const tab = { id: "draft", file: { name: "Untitled.md", path: "draft.md", notebook: "Notes", fileType: "markdown" }, draft: "Recovered unsaved text", saved: "", status: "dirty", untitled: true, viewState: { markdown: { visualScrollTop: 321 } } } as OpenTab;
  let local = JSON.stringify({ ...emptyWorkspaceLibrary(), updatedAt: 123, librarySession: { ...emptyWorkspaceSession(), tabs: [tab], activeTabId: tab.id } });
  let localWrites = 0;
  window.liberaWorkspaces = {
    checkpoint: () => ({ saved: true }),
    readRecovery: async () => local,
    remember: (body) => { local = body; localWrites++; return { saved: true }; },
  };
  globalThis.fetch = async () => Response.json(emptyWorkspaceLibrary());
  let restored!: WorkspaceSession;
  function Harness() {
    const [session, applySession] = useState(emptyWorkspaceSession);
    restored = session;
    useSavedWorkspaces({ authenticated: true, tree: { ...emptyTree(), root: "/library" }, refreshTree: async () => emptyTree(), session, readDraft: (value) => value.draft,
      applySession, onError: (error) => { throw new Error(error); } });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    context.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    await act(async () => root.render(createElement(Harness)));
    assert.equal(restored.tabs[0].draft, tab.draft);
    assert.equal(restored.tabs[0].viewState?.markdown?.visualScrollTop, 321);
    await act(async () => context.mock.timers.tick(60_000));
    assert.equal(localWrites, 1, "unchanged recovery is written once, then skipped");
    assert.equal(window.localStorage.length, 0, "native recovery does not duplicate the data in origin-bound browser storage");
  } finally {
    context.mock.timers.reset();
    await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    dom.window.close();
  }
});
