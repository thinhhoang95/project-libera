import assert from "node:assert/strict";
import test from "node:test";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useLiberaWorkspace } from "../../src/components/libera/use-libera-workspace";
import { emptyTree } from "../../src/components/libera/api-client";
import type { LiberaFileNode, LiberaNotebookNode } from "../../src/lib/types";
import { readLastNotebookName, writeLastNotebookName } from "../../src/lib/storage/last-notebook";
import { getTree } from "../../src/lib/storage/tree";

const timestamp = "2026-09-09T00:00:00.000Z";
const notebook = (name: string): LiberaNotebookNode => ({ kind: "notebook", name, path: name, createdAt: timestamp, updatedAt: timestamp, color: "#000000", emoji: "", groupId: null, children: [] });
const file = (name: string): LiberaFileNode => ({ kind: "file", fileType: "markdown", path: `${name}/Note.md`, name: "Note.md", notebook: name, size: 0, createdAt: timestamp, updatedAt: timestamp });

test("startup restores the last notebook and tracks home selections and tab activity", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previousFetch = globalThis.fetch;
  let remembered = "Beta";
  globalThis.fetch = async (url, init) => {
    if (url === "/api/preferences/last-notebook") {
      remembered = JSON.parse(String(init?.body)).notebook;
      return Response.json({ notebook: remembered });
    }
    if (String(url).startsWith("/api/files?")) {
      const requested = new URL(String(url), "http://localhost").searchParams.get("path")!;
      return Response.json({ file: file(requested.split("/")[0]), content: "" });
    }
    return Response.json({ ...emptyTree(), lastNotebookName: remembered, notebooks: [notebook("Alpha"), notebook("Beta")] });
  };
  let workspace: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  let root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(workspace!.selectedNotebookName, "Beta");
    await act(async () => { workspace.selectNotebook("Alpha"); });
    await act(flushPendingState);
    assert.equal(remembered, "Alpha");
    await act(async () => { root.unmount(); });
    root = createRoot(document.getElementById("root")!);
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(workspace!.selectedNotebookName, "Alpha");
    await act(async () => { await workspace.openFile(file("Beta")); });
    await act(flushPendingState);
    assert.equal(remembered, "Beta");
    await act(async () => { await workspace.openFile(file("Alpha")); });
    await act(async () => { workspace.setActiveTabId("Beta/Note.md"); });
    await act(flushPendingState);
    assert.equal(remembered, "Beta");
    await act(async () => { root.unmount(); });
    remembered = "Removed notebook";
    root = createRoot(document.getElementById("root")!);
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(workspace!.selectedNotebookName, "Alpha");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previousFetch;
    dom.window.close();
  }
});

test("notebook selection waits a minute, shares one write, and cannot block closing", async (context) => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previousFetch = globalThis.fetch;
  const writes: string[] = [];
  let failWrites = false;
  globalThis.fetch = async (url, init) => {
    if (url === "/api/preferences/last-notebook") {
      if (failWrites) return Response.json({ error: "Session expired" }, { status: 401 });
      writes.push(JSON.parse(String(init?.body)).notebook);
      return Response.json({ saved: true });
    }
    return Response.json({ ...emptyTree(), lastNotebookName: "Alpha", notebooks: [notebook("Alpha"), notebook("Beta"), notebook("Gamma")] });
  };
  let workspace: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(flushPendingState);
    writes.length = 0;
    context.mock.timers.enable({ apis: ["setTimeout"] });
    // Switching every 10 seconds neither writes each time nor postpones the write forever.
    for (let i = 0; i < 6; i++) {
      await act(async () => { workspace.selectNotebook(["Beta", "Gamma"][i % 2]); });
      if (i < 5) await act(async () => context.mock.timers.tick(10_000));
    }
    assert.deepEqual(writes, [], "nothing is written during the wait");
    await act(async () => context.mock.timers.tick(10_000));
    assert.deepEqual(writes, ["Gamma"], "six selections in a minute write the latest once");

    await act(async () => { workspace.selectNotebook("Beta"); });
    await act(async () => context.mock.timers.tick(5_000));
    await act(flushPendingState);
    assert.deepEqual(writes, ["Gamma", "Beta"], "closing writes the waiting selection");
    await act(async () => context.mock.timers.tick(120_000));
    assert.equal(writes.length, 2, "the flushed selection does not write again");

    failWrites = true;
    await act(async () => { workspace.selectNotebook("Alpha"); });
    await act(flushPendingState); // Rejecting would keep the app open.
  } finally {
    context.mock.timers.reset();
    await act(async () => { root.unmount(); });
    globalThis.fetch = previousFetch;
    dom.window.close();
  }
});

test("last notebook is stored with workspace data and returned on a fresh tree read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-last-notebook-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await mkdir(path.join(directory, "users", "admin", "Beta"), { recursive: true });
    assert.equal(await readLastNotebookName(), "");
    await writeLastNotebookName("Beta");
    assert.equal(await readLastNotebookName(), "Beta");
    const tree = await getTree();
    assert.equal(tree.lastNotebookName, "Beta");
    assert.deepEqual(tree.notebooks.map((item) => item.name), ["Beta"]);
    await assert.rejects(writeLastNotebookName("../outside"));
    await writeLastNotebookName("Deleted while the write waited");
    assert.equal(await readLastNotebookName(), "Beta", "a notebook that has gone is not remembered");
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
