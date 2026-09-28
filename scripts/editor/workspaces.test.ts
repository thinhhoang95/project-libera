import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useLiberaWorkspace } from "../../src/components/libera/use-libera-workspace";
import { emptyTree } from "../../src/components/libera/api-client";
import { toggleWorkspacePath } from "../../src/components/libera/workspaces-panel";
import { createWorkspaceView, saveWorkspaceGroup, emptyWorkspaceLibrary, emptyWorkspaceSession, filterWorkspaceTree, parseWorkspaceLibrary, remapWorkspacePaths, trackWorkspaceFileChange, workspaceIncludesPath, type WorkspaceLibrary } from "../../src/lib/workspaces";
import { readWorkspaces, writeWorkspaces } from "../../src/lib/storage/workspaces";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTree } from "../../src/lib/types";
import { NotebookHome } from "../../src/components/libera/notebook-home";
import { NotebookPanel } from "../../src/components/libera/notebook-panel";
import { WorkspaceViewContext } from "../../src/components/libera/workspace-view-context";
import { readSidebarSortToken } from "../../src/components/libera/sidebar-sort-preference";
import { readNotebookFileSort, readNotebookFileView } from "../../src/components/libera/notebook-home-preferences";
const require = createRequire(import.meta.url);
const { writeWorkspaceRecovery } = require("../../electron/workspace-recovery.cjs");

const date = "2026-09-23T00:00:00Z";
const file = (path: string, fileType: LiberaFileNode["fileType"] = "markdown"): LiberaFileNode => ({ kind: "file", name: path.split("/").at(-1)!, notebook: path.split("/")[0], path, fileType, size: 10, createdAt: date, updatedAt: date });
const a = file("Notes/Research/a.md"), b = file("Notes/Research/b.pdf", "pdf"), c = file("Notes/photo.png", "image"), d = file("Other/extra.md");
const notebook = (name: string): LiberaNotebookNode => ({ kind: "notebook", name, path: name, emoji: "", color: "#7c6fba", groupId: null, createdAt: date, updatedAt: date, children: [] });
const tree: LiberaTree = { ...emptyTree(), root: "/test/workspaces", notebooks: [{ ...notebook("Notes"), children: [{ kind: "folder", name: "Research", path: "Notes/Research", notebook: "Notes", createdAt: date, updatedAt: date, children: [a, b] }, c] }, { ...notebook("Other"), children: [d] }] };
function paths(tree: LiberaTree): string[] {
  const out: string[] = [];
  function collect(nodes: LiberaTree["notebooks"][number]["children"]) { nodes.forEach((node) => node.kind === "file" ? out.push(node.path) : collect(node.children)); }
  tree.notebooks.forEach((node) => collect(node.children));
  return out;
}

test("workspace selection includes ancestors, excludes subtrees, and respects path boundaries", () => {
  assert.deepEqual(paths(filterWorkspaceTree(tree, { mode: "all", paths: [] })), [a.path, b.path, c.path, d.path]);
  const one = filterWorkspaceTree(tree, { mode: "include", paths: [a.path] });
  assert.deepEqual(paths(one), [a.path]);
  assert.equal(one.notebooks[0].children[0].kind, "folder");
  assert.deepEqual(paths(filterWorkspaceTree(tree, { mode: "include", paths: ["Notes/Research"] })), [a.path, b.path]);
  assert.deepEqual(paths(filterWorkspaceTree(tree, { mode: "exclude", paths: ["Notes/Research"] })), [c.path, d.path]);
  assert.deepEqual(paths(filterWorkspaceTree(tree, { mode: "include", paths: ["Note"] })), []);
  assert.deepEqual(filterWorkspaceTree(tree, { mode: "include", paths: [] }).notebooks, []);
  assert.deepEqual(paths(tree), [a.path, b.path, c.path, d.path], "selection never mutates source tree");
});

test("unchecking one file within a selected notebook keeps its siblings", () => {
  const selected = toggleWorkspacePath(tree.notebooks, ["Notes"], a.path, false);
  assert.deepEqual(selected, [b.path, c.path]);
  assert.deepEqual(paths(filterWorkspaceTree(tree, { mode: "include", paths: selected })), [b.path, c.path]);
  assert.deepEqual(toggleWorkspacePath(tree.notebooks, selected, "Notes", true), ["Notes"]);
  assert.deepEqual(toggleWorkspacePath(tree.notebooks, ["Notes", "Other"], "Notes/Research", false), [c.path, "Other"]);
});

test("new files follow whole-folder scopes but not individual or partial selections", () => {
  const updated = structuredClone(tree);
  const research = updated.notebooks[0].children[0];
  assert.equal(research.kind, "folder");
  if (research.kind !== "folder") return;
  const inside = file("Notes/Research/new.md");
  const outside = file("Other/new.md");
  research.children.push(inside);
  updated.notebooks[1].children.push(outside);
  assert.deepEqual(paths(filterWorkspaceTree(updated, { mode: "all", paths: [] })), [a.path, b.path, inside.path, c.path, d.path, outside.path]);
  assert.deepEqual(paths(filterWorkspaceTree(updated, { mode: "include", paths: ["Notes/Research"] })), [a.path, b.path, inside.path]);
  assert.deepEqual(paths(filterWorkspaceTree(updated, { mode: "include", paths: [a.path] })), [a.path]);
  const partial = toggleWorkspacePath(tree.notebooks, ["Notes"], a.path, false);
  assert.deepEqual(paths(filterWorkspaceTree(updated, { mode: "include", paths: partial })), [b.path, c.path]);
  assert.deepEqual(paths(filterWorkspaceTree(updated, { mode: "exclude", paths: ["Notes/Research"] })), [c.path, d.path, outside.path]);
});

test("path remapping preserves explicit selection without broadening other folder scopes", () => {
  const moved = file("Other/a.md");
  const updated = structuredClone(tree);
  const research = updated.notebooks[0].children[0];
  assert.equal(research.kind, "folder");
  if (research.kind !== "folder") return;
  research.children = [b];
  updated.notebooks[1].children.push(moved);
  const library: WorkspaceLibrary = {
    ...emptyWorkspaceLibrary(), activeWorkspaceId: "explicit",
    workspaces: [
      { id: "explicit", name: "Explicit", color: "#7c6fba", scope: { mode: "include", paths: [a.path] }, session: emptyWorkspaceSession() },
      { id: "folder", name: "Folder", color: "#7c6fba", scope: { mode: "include", paths: ["Notes/Research"] }, session: emptyWorkspaceSession() },
      { id: "destination", name: "Destination", color: "#7c6fba", scope: { mode: "include", paths: ["Other"] }, session: emptyWorkspaceSession() },
      { id: "excluded", name: "Excluded", color: "#7c6fba", scope: { mode: "exclude", paths: [a.path] }, session: emptyWorkspaceSession() },
    ],
  };
  const next = remapWorkspacePaths(library, a.path, moved.path);
  assert.deepEqual(paths(filterWorkspaceTree(updated, next.workspaces[0].scope)), [moved.path]);
  assert.deepEqual(paths(filterWorkspaceTree(updated, next.workspaces[1].scope)), [b.path]);
  assert.deepEqual(paths(filterWorkspaceTree(updated, next.workspaces[2].scope)), [d.path, moved.path]);
  assert.deepEqual(paths(filterWorkspaceTree(updated, next.workspaces[3].scope)), [b.path, c.path, d.path]);
});

test("tracking retains moved files and adds narrow exceptions without changing other workspaces", () => {
  const library: WorkspaceLibrary = { ...emptyWorkspaceLibrary(), activeWorkspaceId: "active", workspaces: [
    { id: "active", name: "Active", color: "#7c6fba", scope: { mode: "include", paths: ["Notes/Research"] }, session: emptyWorkspaceSession() },
    { id: "other", name: "Other", color: "#7c6fba", scope: { mode: "include", paths: ["Notes/Research"] }, session: emptyWorkspaceSession() },
  ] };
  const moved = trackWorkspaceFileChange(library, "active", { moved: { from: a.path, to: "Other/a.md" }, paths: ["Other/a.md"] });
  assert.equal(workspaceIncludesPath(moved.workspaces[0].scope, "Other/a.md"), true);
  assert.equal(workspaceIncludesPath(moved.workspaces[1].scope, "Other/a.md"), false);
  const excluded = { ...library, workspaces: [{ ...library.workspaces[0], scope: { mode: "exclude" as const, paths: ["Other"] } }] };
  const added = trackWorkspaceFileChange(excluded, "active", { paths: ["Other/new.md", "Other/new.md"] });
  assert.deepEqual(added.workspaces[0].scope.includedPaths, ["Other/new.md"]);
  assert.equal(workspaceIncludesPath(added.workspaces[0].scope, d.path), false);
  assert.equal(workspaceIncludesPath(added.workspaces[0].scope, "Other/future.md"), false);
  assert.equal(workspaceIncludesPath(added.workspaces[0].scope, "Other/new.md"), true);
  assert.deepEqual(parseWorkspaceLibrary(JSON.parse(JSON.stringify(added))), added);
  const renamed = trackWorkspaceFileChange(added, "active", { moved: { from: "Other/new.md", to: "Other/renamed.md" }, paths: ["Other/renamed.md"] });
  assert.deepEqual(renamed.workspaces[0].scope.includedPaths, ["Other/renamed.md"]);
  const removed = trackWorkspaceFileChange(renamed, "active", { removed: ["Other/renamed.md"] });
  assert.equal(workspaceIncludesPath(removed.workspaces[0].scope, "Other/renamed.md"), false);
  assert.deepEqual(trackWorkspaceFileChange(library, null, { paths: [d.path] }).workspaces, library.workspaces);
  assert.throws(() => parseWorkspaceLibrary({ ...added, workspaces: [{ ...added.workspaces[0], scope: { ...added.workspaces[0].scope, includedPaths: [123] } }] }));
});

test("disk persistence is atomic, serialized, and recovers the last Electron shutdown across origins", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-workspaces-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    assert.deepEqual(await readWorkspaces(), emptyWorkspaceLibrary());
    const library: WorkspaceLibrary = { ...emptyWorkspaceLibrary(), updatedAt: 1, activeWorkspaceId: "w1", workspaces: [{ id: "w1", name: "Research", color: "#7c6fba", scope: { mode: "include", paths: [a.path] }, session: { ...emptyWorkspaceSession(), activeTabId: a.path, tabs: [{ id: a.path, file: a, draft: "unsaved", saved: "disk", status: "dirty", viewState: { markdown: { editorMode: "source", editorScrollTop: 120, selectionStart: 2 } } }] } }] };
    await Promise.all([writeWorkspaces(library), writeWorkspaces({ ...library, updatedAt: 2 })]);
    assert.equal((await readWorkspaces()).updatedAt, 2);
    assert.throws(() => writeWorkspaces({ ...library, activeWorkspaceId: "missing" }));
    const root = path.join(directory, "users", "admin");
    writeWorkspaceRecovery(root, JSON.stringify({ ...library, updatedAt: 3 }));
    assert.deepEqual((await readWorkspaces()).workspaces[0].session, library.workspaces[0].session);
    assert.equal((await readWorkspaces()).updatedAt, 3);
    await writeWorkspaces({ ...library, updatedAt: 4, activeWorkspaceId: null });
    assert.equal((await readWorkspaces()).activeWorkspaceId, null, "an older shutdown journal cannot reactivate an exited workspace");
    await writeFile(path.join(root, ".libera-workspaces-recovery.json"), "broken");
    assert.equal((await readWorkspaces()).updatedAt, 4, "malformed journal falls back to valid disk copy");
    assert.equal(JSON.parse(await readFile(path.join(root, ".libera-workspaces.json"), "utf8")).version, 1);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace sessions preserve order, active tab, unsaved drafts, view state, and library tabs across exit and reload", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  let disk = emptyWorkspaceLibrary();
  let failSave = false;
  let liveTree = structuredClone(tree);
  const files = [a, b, c, d];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/workspaces") {
      if (init?.method === "PUT") {
        if (failSave) return Response.json({ error: "Disk unavailable" }, { status: 500 });
        disk = parseWorkspaceLibrary(JSON.parse(String(init.body)));
        return Response.json({ saved: true });
      }
      return Response.json(disk);
    }
    if (String(url).startsWith("/api/files?")) {
      const requested = new URL(String(url), "http://localhost").searchParams.get("path");
      return Response.json({ file: files.find((item) => item.path === requested), content: requested?.endsWith(".md") ? "saved content" : undefined });
    }
    if (String(url).startsWith("/api/tree")) return Response.json(liveTree);
    return Response.json({});
  };
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  let root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(async () => { root.render(createElement(StrictMode, null, createElement(Harness))); }); };
  try {
    await render();
    assert.equal(workspace.workspaceManager.ready, true);
    await act(async () => { await workspace.openFile(d); });
    await act(async () => { await workspace.workspaceManager.saveWorkspace({ id: "w1", name: "Research", color: "#7c6fba", scope: { mode: "include", paths: ["Notes"] } }); });
    assert.equal(workspace.tabs.length, 0);
    assert.deepEqual(paths(workspace.tree), [a.path, b.path, c.path]);
    await act(async () => { await workspace.openFile(a); });
    await act(async () => { workspace.setActiveDraft("unsaved draft"); workspace.setActiveTabViewState({ markdown: { editorMode: "source", editorScrollTop: 123, selectionStart: 3, selectionEnd: 5 } }); });
    await act(async () => { await workspace.openFile(b); });
    await act(async () => { await workspace.openFile(c); });
    await act(async () => { workspace.swapTabs(a.path, c.path); workspace.setActiveTabId(b.path); workspace.setActiveTabViewState({ pdf: { scrollTop: 456, zoom: 150 } }, b.path); });
    await act(async () => { await workspace.workspaceManager.switchWorkspace(null); });
    assert.deepEqual(workspace.tabs.map((tab) => tab.id), [d.path]);
    assert.equal(workspace.activeTabId, d.path);
    await act(async () => { await workspace.workspaceManager.switchWorkspace("w1"); });
    assert.deepEqual(workspace.tabs.map((tab) => tab.id), [c.path, b.path, a.path]);
    assert.equal(workspace.activeTabId, b.path);
    assert.equal(workspace.tabs[2].draft, "unsaved draft");
    assert.equal(workspace.tabs[2].viewState?.markdown?.editorScrollTop, 123);
    assert.equal(workspace.tabs[1].viewState?.pdf?.scrollTop, 456);
    // Capture a live editor draft that has not yet reached React state.
    const unregister = workspace.registerEditorDraft(a.path, () => "last keystroke");
    let checkpoint = "";
    window.liberaWorkspaces = { checkpoint: (body) => { checkpoint = body; return { saved: true }; } };
    await act(async () => { window.dispatchEvent(new dom.window.Event("pagehide")); });
    assert.equal(parseWorkspaceLibrary(JSON.parse(checkpoint)).workspaces[0].session.tabs[2].draft, "last keystroke");
    unregister();
    await act(async () => { root.unmount(); });
    window.localStorage.clear(); // New Electron origin: disk must be sufficient.
    disk = parseWorkspaceLibrary(JSON.parse(checkpoint));
    root = createRoot(document.getElementById("root")!);
    await render();
    assert.equal(workspace.workspaceManager.activeWorkspace?.id, "w1");
    assert.deepEqual(workspace.tabs.map((tab) => tab.id), [c.path, b.path, a.path]);
    assert.equal(workspace.tabs[2].draft, "last keystroke");
    assert.equal(workspace.activeTabId, b.path);
    await act(async () => { await workspace.workspaceManager.saveWorkspace({ id: "w2", name: "Writing", color: "#428f87", scope: { mode: "all", paths: [] } }); });
    await act(async () => { await workspace.openFile(a); });
    assert.equal(workspace.tabs[0].draft, "saved content", "another workspace starts with disk content, not the first workspace's unsaved draft");
    await act(async () => { workspace.setActiveDraft("separate workspace draft"); });
    await act(async () => { await workspace.workspaceManager.switchWorkspace("w1"); });
    assert.equal(workspace.tabs[2].draft, "last keystroke");
    await act(async () => { await workspace.workspaceManager.switchWorkspace("w2"); });
    assert.equal(workspace.tabs[0].draft, "separate workspace draft");
    await act(async () => { await workspace.workspaceManager.switchWorkspace("w1"); });
    await act(async () => { await workspace.workspaceManager.deleteWorkspace("w2"); });
    assert.equal(workspace.tabs[2].draft, "last keystroke");
    failSave = true;
    await act(async () => { await assert.rejects(workspace.workspaceManager.switchWorkspace(null), /Disk unavailable/); });
    assert.equal(workspace.workspaceManager.activeWorkspace?.id, "w1", "failed save cannot close the current workspace");
    assert.equal(workspace.tabs.length, 3);
    failSave = false;
    await act(async () => { await workspace.workspaceManager.saveWorkspace({ id: "w1", name: "Renamed", color: "#428f87", scope: { mode: "exclude", paths: [b.path] } }); });
    assert.equal(workspace.workspaceManager.activeWorkspace?.name, "Renamed");
    assert.deepEqual(paths(workspace.tree), [a.path, c.path, d.path]);
    assert.equal(workspace.tabs.length, 3, "changing the sidebar scope does not discard already-open drafts");
    await act(async () => { await workspace.workspaceManager.switchWorkspace(null); });
    liveTree = { ...tree, notebooks: [{ ...notebook("Other"), children: [d] }] };
    await act(async () => { await workspace.refreshTree(); await workspace.workspaceManager.switchWorkspace("w1"); });
    assert.equal(workspace.tabs.length, 1, "missing clean files are skipped");
    assert.equal(workspace.tabs[0].draft, "last keystroke");
    assert.equal(workspace.tabs[0].untitled, true, "missing file drafts remain recoverable");
    await act(async () => { await workspace.workspaceManager.deleteWorkspace("w1"); });
    assert.equal(workspace.workspaceManager.workspaces.length, 0);
    assert.deepEqual(workspace.tabs.map((tab) => tab.id), [d.path]);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("renaming folders updates all workspace selections and saved tabs without prefix collisions", () => {
  const library: WorkspaceLibrary = { ...emptyWorkspaceLibrary(), workspaces: [{ id: "w", name: "Work", color: "#7c6fba", scope: { mode: "include", paths: ["Notes/Research", "Notes/Research2"] }, session: { ...emptyWorkspaceSession(), activeTabId: a.path, tabs: [{ id: a.path, file: a, draft: "draft", saved: "saved", status: "dirty" }] } }] };
  const next = remapWorkspacePaths(library, "Notes/Research", "Notes/Reading");
  assert.deepEqual(next.workspaces[0].scope.paths, ["Notes/Reading", "Notes/Research2"]);
  assert.equal(next.workspaces[0].session.activeTabId, "Notes/Reading/a.md");
  assert.equal(next.workspaces[0].session.tabs[0].draft, "draft");
});

test("workspace API requires authentication and rejects invalid saved data", async () => {
  const { NextRequest } = await import("next/server");
  const { GET, PUT } = await import("../../src/app/api/workspaces/route");
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("../../src/lib/auth");
  assert.equal((await GET(new NextRequest("http://localhost/api/workspaces"))).status, 401);
  assert.equal((await PUT(new NextRequest("http://localhost/api/workspaces", { method: "PUT", body: "{}" }))).status, 401);
  const invalid = await PUT(new NextRequest("http://localhost/api/workspaces", { method: "PUT", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify({ version: 1 }) }));
  assert.equal(invalid.status, 400);
});

test("workspace scope overrides library hides and removes empty groups", () => {
  const grouped: LiberaTree = { ...tree, notebookGroups: [{ id: "g1", title: "Research", description: "", createdAt: date, updatedAt: date }, { id: "g2", title: "Empty", description: "", createdAt: date, updatedAt: date }], notebooks: tree.notebooks.map((node) => ({ ...node, groupId: "g1" })), notebookViewOptions: { hiddenGroupIds: ["g1"], hiddenNotebookNames: ["Notes"], showArchive: false } };
  const filtered = filterWorkspaceTree(grouped, { mode: "include", paths: [a.path] });
  assert.deepEqual(filtered.notebookGroups.map((group) => group.id), ["g1"]);
  assert.deepEqual(filtered.notebookViewOptions.hiddenGroupIds, []);
  assert.deepEqual(filtered.notebookViewOptions.hiddenNotebookNames, []);
  assert.deepEqual(filterWorkspaceTree(grouped, { mode: "include", paths: [] }).notebookGroups, []);
});

test("active workspace tracks file operations, persists them, and owns uploads that finish during a switch", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  let disk: WorkspaceLibrary = { ...emptyWorkspaceLibrary(), activeWorkspaceId: "active", workspaces: [
    { id: "active", name: "Active", color: "#7c6fba", scope: { mode: "include", paths: ["Notes/Research"] }, session: emptyWorkspaceSession() },
    { id: "other", name: "Other", color: "#7c6fba", scope: { mode: "include", paths: [] }, session: emptyWorkspaceSession() },
  ] };
  const liveTree = structuredClone(tree);
  let releaseUpload: (() => void) | undefined;
  let uploadStarted: (() => void) | undefined;
  let failFile = false;
  function children(directory: string) {
    const notebook = liveTree.notebooks.find((node) => node.path === directory.split("/")[0])!;
    if (directory === notebook.path) return notebook.children;
    const folder = notebook.children.find((node) => node.path === directory);
    assert.equal(folder?.kind, "folder");
    return folder!.kind === "folder" ? folder.children : [];
  }
  globalThis.fetch = async (url, init) => {
    if (url === "/api/workspaces") {
      if (init?.method === "PUT") { disk = parseWorkspaceLibrary(JSON.parse(String(init.body))); return Response.json({ saved: true }); }
      return Response.json(disk);
    }
    if (String(url).startsWith("/api/tree")) return Response.json(liveTree);
    if (String(url).startsWith("/api/files?")) {
      const requested = new URL(String(url), "http://localhost").searchParams.get("path")!;
      return Response.json({ file: file(requested), content: "content" });
    }
    if (url === "/api/uploads") {
      await new Promise<void>((resolve) => { releaseUpload = resolve; uploadStarted?.(); });
      const uploaded = file("Other/upload.md");
      children("Other").push(uploaded);
      return Response.json({ uploaded: [uploaded], tree: liveTree });
    }
    if (url === "/api/files") {
      if (failFile) return Response.json({ error: "Write failed" }, { status: 500 });
      const body = JSON.parse(String(init?.body));
      if (init?.method === "PATCH" && typeof body.content === "string") {
        return Response.json({ file: file(body.path), content: body.content });
      }
      const directory = body.destinationDirectory ?? body.parentPath ?? body.notebook;
      const target = file(`${directory}/${body.destinationName ?? body.name ?? body.path.split("/").at(-1)}`);
      if (body.path && !body.copy) {
        const source = children(body.path.split("/").slice(0, -1).join("/"));
        source.splice(source.findIndex((node) => node.path === body.path), 1);
      }
      children(directory).push(target);
      return Response.json({ file: target, content: body.content ?? "content" });
    }
    if (url === "/api/folders" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      children(body.parentPath).push({ kind: "folder", name: body.name, path: `${body.parentPath}/${body.name}`, notebook: body.parentPath.split("/")[0], children: [], createdAt: date, updatedAt: date });
      return Response.json(liveTree);
    }
    if (url === "/api/notebooks" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      liveTree.notebooks.push(notebook(body.name));
      return Response.json(liveTree);
    }
    return Response.json({});
  };
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  let root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(async () => { root.render(createElement(Harness)); }); };
  const visible = (path: string) => assert.ok(paths(workspace.tree).includes(path), `${path} should be visible`);
  try {
    await render();
    await act(async () => { await workspace.moveFileToFolder(a, "Other"); });
    visible("Other/a.md");
    assert.ok(!paths(workspace.tree).includes(d.path), "unrelated siblings remain hidden");
    await act(async () => { workspace.createUntitledFile("Other"); });
    await act(async () => { workspace.setActiveDraft("new draft"); });
    await act(async () => { await workspace.saveActiveTab(); });
    await act(async () => { await workspace.submitSaveDraft("new.md", "Other"); });
    visible("Other/new.md");
    await act(async () => { await workspace.copyFileFromPrompt(b); });
    await act(async () => { await workspace.submitWorkspaceInputDialog({ destinationDirectory: "Other", destinationName: "copy.pdf", name: "" }); });
    visible("Other/copy.pdf");
    await act(async () => { await workspace.createMarkdownSlidesFromPrompt("Other"); });
    await act(async () => { await workspace.submitNoteDialog({ name: "deck" }); });
    assert.ok(paths(workspace.tree).some((path) => path.startsWith("Other/deck")));
    await act(async () => { await workspace.createFolderFromPrompt("Other"); });
    await act(async () => { await workspace.submitWorkspaceInputDialog({ name: "New folder", destinationDirectory: "", destinationName: "" }); });
    assert.ok(workspace.tree.notebooks.find((node) => node.name === "Other")?.children.some((node) => node.path === "Other/New folder"));
    await act(async () => { workspace.openCreateNotebookDialog(); });
    await act(async () => { await workspace.submitNotebookDialog({ name: "New notebook", color: "#7c6fba", emoji: "", groupId: "" }); });
    assert.ok(workspace.tree.notebooks.some((node) => node.name === "New notebook"));
    await act(async () => { await workspace.saveChatToNotebook({ directory: "Other", fileName: "chat.md", content: "chat" }); });
    visible("Other/chat.md");
    const beforeFailure = structuredClone(workspace.workspaceManager.activeWorkspace!.scope);
    failFile = true;
    await act(async () => { await assert.rejects(workspace.saveChatToNotebook({ directory: "Other", fileName: "failed.md", content: "chat" }), /Write failed/); });
    assert.deepEqual(workspace.workspaceManager.activeWorkspace!.scope, beforeFailure);
    failFile = false;
    await act(async () => {
      const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
      const uploading = workspace.uploadFilesToNotebook("Other", [new File(["upload"], "upload.md")]);
      await started;
      const switching = workspace.workspaceManager.switchWorkspace("other");
      releaseUpload!();
      await Promise.all([uploading, switching]);
    });
    assert.equal(workspace.workspaceManager.activeWorkspace?.id, "other");
    assert.deepEqual(paths(workspace.tree), []);
    assert.equal(workspaceIncludesPath(disk.workspaces[0].scope, "Other/upload.md"), true);
    assert.deepEqual(disk.workspaces[1].scope.paths, []);
    await act(async () => { await workspace.workspaceManager.switchWorkspace("active"); });
    visible("Other/upload.md");
    await act(async () => { await workspace.openFile(d); });
    await act(async () => { workspace.setActiveDraft("edited within this workspace"); });
    await act(async () => { await workspace.saveActiveTab(); });
    visible(d.path);
    assert.equal(workspace.activeTab?.saved, "edited within this workspace");
    assert.equal(workspaceIncludesPath(disk.workspaces[1].scope, d.path), false, "editing a file only adds it to the active workspace");
    const expected = paths(workspace.tree);
    await act(async () => { await workspace.workspaceManager.checkpoint(); root.unmount(); });
    window.localStorage.clear();
    root = createRoot(document.getElementById("root")!);
    await render();
    assert.deepEqual(paths(workspace.tree), expected, "disk alone restores tracked membership");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("partial upload failures return successful paths for workspace tracking", async () => {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../../src/app/api/uploads/route");
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("../../src/lib/auth");
  const { createNotebook } = await import("../../src/lib/storage/notebooks");
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-workspace-upload-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await createNotebook("Uploads");
    const body = new FormData();
    body.append("notebook", "Uploads");
    body.append("files", new File(["first"], "same.md"));
    body.append("files", new File(["duplicate"], "same.md"));
    const response = await POST(new NextRequest("http://localhost/api/uploads", {
      method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body,
    }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.uploaded.map((file: LiberaFileNode) => file.path), ["Uploads/same.md"]);
    assert.match(result.error, /already exists/);
    assert.ok(paths(result.tree).includes("Uploads/same.md"));
    assert.equal(await readFile(path.join(directory, "users/admin/Uploads/same.md"), "utf8"), "first");
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace view validation and notebook renames preserve independent group organization", () => {
  const group = { id: "g", title: "Reading", description: "", createdAt: date, updatedAt: date };
  const view = saveWorkspaceGroup(createWorkspaceView(tree), group, ["Notes"]);
  const library: WorkspaceLibrary = { ...emptyWorkspaceLibrary(), workspaces: [
    { id: "w", name: "Work", color: "#7c6fba", scope: { mode: "all", paths: [] }, session: emptyWorkspaceSession(), view },
  ] };
  assert.deepEqual(parseWorkspaceLibrary(JSON.parse(JSON.stringify(library))), library);
  for (const bad of [{ sidebarSort: "invalid" }, { fileSort: "invalid" }, { fileView: "invalid" }, { notebookGroupIds: { Notes: "missing" } }, { notebookGroups: [group, group] }, { notebookViewOptions: { hiddenGroupIds: [], hiddenNotebookNames: [], showArchive: "yes" } }]) {
    assert.throws(() => parseWorkspaceLibrary({ ...library, workspaces: [{ ...library.workspaces[0], view: { ...view, ...bad } }] }));
  }
  const renamed = remapWorkspacePaths(library, "Notes", "Reading");
  assert.equal(renamed.workspaces[0].view?.notebookGroupIds.Reading, "g");
  assert.equal(renamed.workspaces[0].view?.notebookGroupIds.Notes, undefined);
  const removed = trackWorkspaceFileChange(renamed, "w", { removed: ["Reading"] });
  assert.equal(removed.workspaces[0].view?.notebookGroupIds.Reading, undefined);
  assert.deepEqual(removed.workspaces[0].view?.notebookGroups, [group], "empty groups remain available for editing");
  assert.deepEqual(tree.notebookGroups, [], "workspace organization never mutates shared metadata");
});

test("sorting controls and group changes stay in their workspace across switches, refreshes, and reload", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const sharedGroup = { id: "shared", title: "Library group", description: "Original", createdAt: date, updatedAt: date };
  let liveTree = { ...structuredClone(tree), notebookGroups: [sharedGroup] };
  liveTree.notebooks[0].groupId = sharedGroup.id;
  let disk: WorkspaceLibrary = { ...emptyWorkspaceLibrary(), activeWorkspaceId: "w1", workspaces: [
    { id: "w1", name: "One", color: "#7c6fba", scope: { mode: "include", paths: [a.path, d.path] }, session: emptyWorkspaceSession() },
    { id: "w2", name: "Two", color: "#7c6fba", scope: { mode: "all", paths: [] }, session: emptyWorkspaceSession() },
  ] };
  let sharedGroupWrites = 0;
  let notebookBody: Record<string, unknown> = {};
  let failSave = false;
  globalThis.fetch = async (url, init) => {
    if (url === "/api/workspaces") {
      if (init?.method === "PUT") {
        if (failSave) return Response.json({ error: "Disk unavailable" }, { status: 500 });
        disk = parseWorkspaceLibrary(JSON.parse(String(init.body)));
        return Response.json({ saved: true });
      }
      return Response.json(disk);
    }
    if (String(url).startsWith("/api/tree")) return Response.json(liveTree);
    if (String(url).startsWith("/api/notebook-groups") || url === "/api/notebook-view-options") { sharedGroupWrites++; return Response.json(liveTree); }
    if (url === "/api/notebooks") {
      notebookBody = JSON.parse(String(init?.body));
      if (init?.method === "POST") liveTree.notebooks.push(notebook(String(notebookBody.name)));
      if (init?.method === "PATCH") liveTree = { ...liveTree, notebooks: liveTree.notebooks.map((node) => node.name === notebookBody.path ? { ...node, name: String(notebookBody.name), path: String(notebookBody.name) } : node) };
      return Response.json(liveTree);
    }
    return Response.json({});
  };
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() {
    workspace = useLiberaWorkspace(true).workspace;
    const manager = workspace.workspaceManager;
    const panel = createElement(NotebookPanel, {
      activeTabId: workspace.activeTabId, expanded: workspace.expanded, fileInteractions: workspace.fileInteractions,
      query: workspace.query, searchResults: workspace.searchResults, selectedNotebookName: workspace.selectedNotebookName,
      tree: workspace.tree, uploadInputRef: workspace.uploadInputRef, workspaceActive: Boolean(manager.activeWorkspace),
      onDuplicateMarkdown: workspace.duplicateMarkdown, onCopyFile: workspace.copyFileFromPrompt,
      onArchiveFile: workspace.archiveFileNode, onArchiveFolder: workspace.archiveFolderNode,
      onCreateFolder: workspace.createFolderFromPrompt, onCreateMarkdown: workspace.createMarkdownFromPrompt,
      onCreateSlides: workspace.createMarkdownSlidesFromPrompt, onCreateNotebook: workspace.openCreateNotebookDialog,
      onCreateNotebookGroup: workspace.openCreateNotebookGroupDialog, onDeleteNotebook: workspace.deleteNotebookFromPrompt,
      onDeleteNotebookGroup: workspace.deleteNotebookGroup, onDeleteFile: workspace.deleteFileNodeFromPrompt,
      onDeleteFolder: workspace.deleteFolderFromPrompt, onDownloadFile: workspace.downloadFile,
      onDownloadNotebook: workspace.downloadNotebook, onEditNotebook: workspace.openEditNotebookDialog,
      onEditNotebookGroup: workspace.openEditNotebookGroupDialog, onMoveFile: workspace.moveFileToFolder,
      onOpenFile: workspace.openFile, onQueryChange: workspace.setQuery, onRenameFolder: workspace.renameFolderFromPrompt,
      onRenameFile: workspace.renameFileNodeFromPrompt, onSelectNotebook: workspace.selectNotebook,
      onSelectSearchResult: workspace.selectSearchResult, onStartUpload: workspace.startUpload,
      onToggleFileStar: workspace.toggleFileStar, onToggleNotebook: workspace.toggleNotebook,
      onUploadChange: workspace.handleUploadChange, onUploadFiles: workspace.uploadFilesToNotebook,
      onUpdateNotebookViewOptions: workspace.updateNotebookViewOptions,
    });
    const home = workspace.selectedNotebook ? createElement(NotebookHome, { yourName: "Test", notebook: workspace.selectedNotebook, onCreateMarkdown: workspace.createMarkdownFromPrompt, onCreateSlides: workspace.createMarkdownSlidesFromPrompt, onOpenFile: workspace.openFile }) : null;
    return createElement(WorkspaceViewContext.Provider, { value: { view: manager.activeWorkspace?.view, updateView: manager.updateView } }, panel, home);
  }
  let root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(async () => { root.render(createElement(Harness)); }); };
  const click = async (label: string) => { await act(async () => { (document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click(); }); };
  const switchTo = async (id: string | null) => { await act(async () => { await workspace.workspaceManager.switchWorkspace(id); }); };
  const sortValue = () => (document.querySelector('[aria-label="Sort notebook files"]') as HTMLSelectElement).value;
  const gridActive = () => document.querySelector('[aria-label="Grid view"]')?.getAttribute("aria-pressed");
  try {
    await render();
    assert.equal(workspace.workspaceManager.activeWorkspace?.view?.notebookGroupIds.Notes, "shared", "legacy workspaces inherit library organization once");
    const initialView = structuredClone(workspace.workspaceManager.activeWorkspace!.view);
    window.liberaMenu = { popup: async () => "sort:name:asc" };
    await click("Sort notebooks and files");
    await click("Grid view");
    await act(async () => {
      const select = document.querySelector('[aria-label="Sort notebook files"]') as HTMLSelectElement;
      select.value = "name";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(workspace.workspaceManager.activeWorkspace?.view?.sidebarSort, "name:asc");
    assert.equal(readSidebarSortToken(), "updatedAt:desc", "workspace sort never changes library cookie");
    assert.equal(readNotebookFileSort(), "updated");
    assert.equal(readNotebookFileView(), "list");
    await act(async () => { workspace.openEditNotebookGroupDialog(sharedGroup); });
    await act(async () => { await workspace.submitNotebookGroupDialog({ title: "Workspace group", description: "Local", notebookNames: ["Other"] }); });
    assert.equal(workspace.tree.notebookGroups[0].title, "Workspace group");
    assert.equal(workspace.tree.notebooks.find((node) => node.name === "Other")?.groupId, "shared");
    assert.equal(workspace.tree.notebooks.find((node) => node.name === "Notes")?.groupId, null);
    const scopeBeforeNotebookEdit = structuredClone(workspace.workspaceManager.activeWorkspace!.scope);
    await act(async () => { workspace.openEditNotebookDialog(workspace.tree.notebooks.find((node) => node.name === "Notes")!); });
    await act(async () => { await workspace.submitNotebookDialog({ name: "Notes", color: "#7c6fba", emoji: "", groupId: "shared" }); });
    assert.deepEqual(workspace.workspaceManager.activeWorkspace?.scope, scopeBeforeNotebookEdit, "changing notebook organization must not reveal unselected sibling files");
    assert.equal(workspace.tree.notebooks.find((node) => node.name === "Notes")?.groupId, "shared");
    await act(async () => { workspace.openCreateNotebookGroupDialog(); });
    await act(async () => { await workspace.submitNotebookGroupDialog({ title: "Empty group", description: "", notebookNames: [] }); });
    const localGroup = workspace.tree.notebookGroups.find((group) => group.title === "Empty group")!;
    assert.ok(localGroup, "new empty groups remain visible");
    await act(async () => { workspace.openCreateNotebookDialog(); });
    await act(async () => { await workspace.submitNotebookDialog({ name: "Created", color: "#7c6fba", emoji: "", groupId: localGroup.id }); });
    assert.equal(notebookBody.groupId, undefined, "local group IDs never reach shared notebook metadata");
    assert.equal(workspace.tree.notebooks.find((node) => node.name === "Created")?.groupId, localGroup.id);
    await act(async () => { workspace.openEditNotebookDialog(workspace.tree.notebooks.find((node) => node.name === "Created")!); });
    await act(async () => { await workspace.submitNotebookDialog({ name: "Renamed", color: "#7c6fba", emoji: "", groupId: localGroup.id }); });
    assert.equal(workspace.tree.notebooks.find((node) => node.name === "Renamed")?.groupId, localGroup.id);
    await act(async () => { await workspace.updateNotebookViewOptions({ hiddenGroupIds: [], hiddenNotebookNames: [], showArchive: true }); await workspace.refreshTree(); });
    const oneView = structuredClone(workspace.workspaceManager.activeWorkspace!.view);
    await switchTo("w2");
    assert.deepEqual(workspace.workspaceManager.activeWorkspace?.view, initialView);
    assert.equal(sortValue(), "updated");
    assert.equal(gridActive(), "false");
    assert.equal(workspace.tree.notebookGroups[0].title, "Library group");
    assert.equal(workspace.tree.notebooks.find((node) => node.name === "Renamed")?.groupId, null);
    await switchTo("w1");
    assert.equal(sortValue(), "name");
    assert.equal(gridActive(), "true");
    let checkedSort = "";
    window.liberaMenu = { popup: async ({ items }) => { const selected = items.find((item) => "checked" in item && item.checked); checkedSort = selected && "id" in selected ? selected.id : ""; return null; } };
    await click("Sort notebooks and files");
    assert.equal(checkedSort, "sort:name:asc", "sort menu restores the active workspace choice");
    await switchTo(null);
    assert.deepEqual(workspace.tree.notebookGroups, [sharedGroup]);
    assert.equal(workspace.tree.notebooks[0].groupId, "shared");
    assert.equal(sortValue(), "updated");
    assert.equal(gridActive(), "false");
    await switchTo("w1");
    await act(async () => { await workspace.workspaceManager.checkpoint(); root.unmount(); });
    window.localStorage.clear();
    root = createRoot(document.getElementById("root")!);
    await render();
    assert.deepEqual(workspace.workspaceManager.activeWorkspace?.view, oneView);
    assert.equal(sortValue(), "name");
    assert.equal(gridActive(), "true");
    await act(async () => { await workspace.deleteNotebookGroup(localGroup); });
    assert.equal(workspace.tree.notebooks.find((node) => node.name === "Renamed")?.groupId, null);
    assert.equal(workspace.tree.notebookGroups.some((group) => group.id === localGroup.id), false);
    failSave = true;
    await act(async () => { await workspace.workspaceManager.updateView((view) => ({ ...view, sidebarSort: "name:desc" })); });
    await act(async () => { await assert.rejects(workspace.workspaceManager.switchWorkspace("w2"), /Disk unavailable/); });
    assert.equal(workspace.workspaceManager.activeWorkspace?.id, "w1");
    failSave = false;
    await switchTo("w2");
    await switchTo("w1");
    assert.equal(workspace.workspaceManager.activeWorkspace?.view?.sidebarSort, "name:desc");
    assert.equal(sharedGroupWrites, 0, "workspace changes never call shared group/view endpoints");
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});

test("archived folders report their actual destination so workspace paths survive archive name collisions", async () => {
  const { createNotebook } = await import("../../src/lib/storage/notebooks");
  const { createFolder, archiveFolder } = await import("../../src/lib/storage/files");
  const { ARCHIVE_DIR } = await import("../../src/lib/storage/constants");
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-workspace-archive-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    await createNotebook("Notes");
    await createFolder("Notes", "Research");
    await archiveFolder("Notes/Research");
    await createFolder("Notes", "Research");
    const result = await archiveFolder("Notes/Research");
    assert.equal(result.moved.from, "Notes/Research");
    assert.ok(result.moved.to.startsWith(`Notes/${ARCHIVE_DIR}/`));
    assert.notEqual(result.moved.to, `Notes/${ARCHIVE_DIR}/Research`);
    const library: WorkspaceLibrary = { ...emptyWorkspaceLibrary(), activeWorkspaceId: "w", workspaces: [
      { id: "w", name: "Work", color: "#7c6fba", scope: { mode: "include", paths: ["Notes/Research"] }, session: emptyWorkspaceSession() },
    ] };
    const tracked = trackWorkspaceFileChange(library, "w", { moved: result.moved, paths: [result.moved.to] });
    assert.deepEqual(tracked.workspaces[0].scope.paths, [result.moved.to]);
    const { getTree } = await import("../../src/lib/storage/tree");
    const completeTree = await getTree({ includeArchive: true });
    const view = createWorkspaceView(completeTree);
    assert.equal(filterWorkspaceTree(completeTree, tracked.workspaces[0].scope, view).notebooks.length, 0, "hidden archives remain hidden");
    view.notebookViewOptions.showArchive = true;
    assert.ok(filterWorkspaceTree(completeTree, tracked.workspaces[0].scope, view).notebooks.length);
    assert.equal((await getTree()).notebookViewOptions.showArchive, false, "workspace archive views do not change library settings");
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
