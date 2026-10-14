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
    await act(async () => context.mock.timers.tick(1000));
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
