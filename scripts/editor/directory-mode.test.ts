import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  clearRecentDirectories,
  closeDirectory,
  getDirectoryModeSummary,
  openDirectory,
  openFileLocation,
} from "../../src/lib/storage/directory-mode";
import { createMarkdownFile, readLiberaFile, updateMarkdownFile } from "../../src/lib/storage/files";
import { writePdfAnnotations } from "../../src/lib/storage/annotations";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { getAdminRoot } from "../../src/lib/storage/paths";
import { getTree } from "../../src/lib/storage/tree";
import { readWorkspaces, writeWorkspaces } from "../../src/lib/storage/workspaces";
import { emptyWorkspaceLibrary } from "../../src/lib/workspaces";
import type { LiberaTreeNode } from "../../src/lib/types";

const require = createRequire(import.meta.url);
const { contextStateRoot, directoryStateRoot } = require("../../electron/directory-mode.cjs");

function filePaths(nodes: LiberaTreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "file" ? [node.path] : filePaths(node.children));
}

async function withDataDirectory(run: (paths: { data: string; project: string }) => Promise<void>) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-directory-mode-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = path.join(scratch, "data");
  const project = path.join(scratch, "Thesis Project");
  await mkdir(path.join(project, "chapters"), { recursive: true });
  await mkdir(path.join(project, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(project, ".git"), { recursive: true });
  await writeFile(path.join(project, "README.md"), "# Thesis\n\n[Intro](chapters/intro.md)\n");
  await writeFile(path.join(project, "chapters", "intro.md"), "Intro\n");
  await writeFile(path.join(project, "paper.pdf"), "%PDF-1.4\n");
  await writeFile(path.join(project, "notes.docx"), "not shown\n");
  await writeFile(path.join(project, "node_modules", "pkg", "README.md"), "dependency\n");
  await writeFile(path.join(project, ".git", "HEAD.md"), "hidden\n");
  try {
    await createNotebook("Library");
    await createMarkdownFile("Library", "Private.md", "library only");
    await run({ data: process.env.LIBERA_DATA_DIR, project });
  } finally {
    closeDirectory();
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

test("an open folder replaces the notebook library and only exposes its own files", async () => {
  await withDataDirectory(async ({ project }) => {
    const summary = await openDirectory(project);
    assert.deepEqual(summary.current, { name: "Thesis Project", path: project });
    assert.deepEqual(summary.recent, [project]);

    const tree = await getTree();
    assert.equal(tree.root, project);
    assert.deepEqual(tree.directory, { name: "Thesis Project", path: project, truncated: false });
    assert.deepEqual(tree.notebooks.map((notebook) => notebook.name), ["Thesis Project"]);
    assert.deepEqual(filePaths(tree.notebooks[0].children).sort(), [
      "Thesis Project/README.md",
      "Thesis Project/chapters/intro.md",
      "Thesis Project/paper.pdf",
    ], "unsupported, hidden and dependency files stay out of the tree");

    assert.equal((await readLiberaFile("Thesis Project/chapters/intro.md")).content, "Intro\n");
    await updateMarkdownFile("Thesis Project/chapters/intro.md", "Edited\n");
    assert.equal((await readLiberaFile("Thesis Project/chapters/intro.md")).content, "Edited\n");

    await assert.rejects(readLiberaFile("Library/Private.md"), /open folder/, "notebooks are unreachable");
    await assert.rejects(readLiberaFile("Thesis Project/../Library/Private.md"));
    await assert.rejects(createNotebook("Another"), /Close the open folder/);
  });
});

test("app state for an open folder lives in the data directory, not in the folder", async () => {
  await withDataDirectory(async ({ project }) => {
    await openDirectory(project);
    await writePdfAnnotations("Thesis Project/paper.pdf", []);
    assert.deepEqual((await readdir(project)).sort(), ["README.md", "chapters", "node_modules", "notes.docx", "paper.pdf", ".git"].sort());
    assert.ok(existsSync(path.join(directoryStateRoot(getAdminRoot(), project), ".libera", "annotations", "pdf", "paper.pdf.json")));
  });
});

test("Notebook mode and each folder keep separate workspace sessions", async () => {
  await withDataDirectory(async ({ project }) => {
    const adminRoot = getAdminRoot();
    await writeWorkspaces({ ...emptyWorkspaceLibrary(), updatedAt: 10 }, adminRoot);
    await openDirectory(project);
    assert.equal((await readWorkspaces(project)).updatedAt, 0, "a new folder starts empty");
    await writeWorkspaces({ ...emptyWorkspaceLibrary(), updatedAt: 20 }, project);
    // A notebook page that is still closing after the switch saves its own session.
    await writeWorkspaces({ ...emptyWorkspaceLibrary(), updatedAt: 11 }, adminRoot);
    assert.equal((await readWorkspaces(project)).updatedAt, 20);
    assert.equal((await readWorkspaces(adminRoot)).updatedAt, 11);
    assert.throws(() => writeWorkspaces(emptyWorkspaceLibrary(), "/never/opened"), /no longer open/);

    closeDirectory();
    assert.equal((await readWorkspaces()).updatedAt, 11, "closing returns to the library session");
    assert.equal(contextStateRoot(adminRoot, project), directoryStateRoot(adminRoot, project), "recent folders can still save");
  });
});

test("opening a file opens its folder unless it is already in the open context", async () => {
  await withDataDirectory(async ({ project }) => {
    const opened = await openFileLocation(path.join(project, "chapters", "intro.md"));
    assert.equal(opened.changed, true);
    assert.equal(opened.filePath, "chapters/intro.md");
    assert.equal(opened.current?.path, path.join(project, "chapters"));

    await openDirectory(project);
    const inside = await openFileLocation(path.join(project, "chapters", "intro.md"));
    assert.equal(inside.changed, false);
    assert.equal(inside.filePath, "Thesis Project/chapters/intro.md");
    assert.deepEqual(getDirectoryModeSummary().recent, [project, path.join(project, "chapters")]);

    closeDirectory();
    const library = await openFileLocation(path.join(getAdminRoot(), "Library", "Private.md"));
    assert.equal(library.changed, false);
    assert.equal(library.filePath, "Library/Private.md");

    await assert.rejects(openFileLocation(path.join(project, "notes.docx")), /cannot open/);
  });
});

test("closing, missing folders and clearing recents return to the library", async () => {
  await withDataDirectory(async ({ project }) => {
    await openDirectory(project);
    assert.equal(closeDirectory().current, null);
    const tree = await getTree();
    assert.equal(tree.directory, undefined);
    assert.deepEqual(tree.notebooks.map((notebook) => notebook.name), ["Library"]);
    assert.deepEqual(getDirectoryModeSummary().recent, [project], "closed folders stay recent");

    const moved = path.join(path.dirname(project), "Moved");
    await openDirectory(project);
    await rm(moved, { recursive: true, force: true });
    await import("node:fs/promises").then(({ rename }) => rename(project, moved));
    assert.deepEqual((await getTree()).notebooks.map((notebook) => notebook.name), ["Library"], "a vanished folder falls back to notebooks");
    assert.equal(getDirectoryModeSummary().current, null);

    assert.deepEqual(clearRecentDirectories().recent, []);
    await assert.rejects(openDirectory(project), /not found/);
    await assert.rejects(openDirectory(getAdminRoot()), /Libera library/);
    await assert.rejects(openDirectory("relative/path"), /Folder was not found|Choose a folder/);
  });
});

test("menu commands save the session before switching folders and recover from failures", async () => {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useLiberaWorkspace } = await import("../../src/components/libera/use-libera-workspace");
  const { emptyTree } = await import("../../src/components/libera/api-client");
  const virtualConsole = new VirtualConsole();
  const navigations: string[] = [];
  virtualConsole.on("jsdomError", (error) => { if (/navigation/.test(error.message)) navigations.push(error.message); });
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true, virtualConsole });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let directoryResponse: Response | null = null;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    requests.push(`${init?.method ?? "GET"} ${target}`);
    if (target.startsWith("/api/workspaces")) return Response.json(init?.method === "PUT" ? { saved: true } : emptyWorkspaceLibrary());
    if (target === "/api/directory") return directoryResponse!;
    return Response.json({ ...emptyTree(), root: "/library" });
  };
  let listener: ((command: LiberaDirectoryCommand) => void) | undefined;
  let notified = 0;
  window.liberaDirectory = {
    chooseFolder: async () => "/projects/Thesis",
    chooseFile: async () => null,
    notifyChanged: async () => { notified += 1; },
    onCommand: (next) => { listener = next; return () => { listener = undefined; }; },
  };
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(workspace.workspaceManager.ready, true);
    assert.equal(workspace.canOpenDirectories, true);
    assert.ok(listener, "the hook listens for File menu commands");
    const notifiedAfterLoad = notified;

    directoryResponse = Response.json({ error: "Folder was not found." }, { status: 404 });
    await act(async () => { listener!({ type: "open-directory", path: "/projects/Missing" }); });
    assert.equal(workspace.workspaceError, "Folder was not found.");
    assert.equal(workspace.workspaceManager.switching, false, "a failed switch resumes the session");
    assert.equal(navigations.length, 0);

    requests.length = 0;
    directoryResponse = Response.json({ changed: true, filePath: "Thesis/intro.md", current: { name: "Thesis", path: "/projects/Thesis" }, recent: [] });
    await act(async () => { listener!({ type: "open-file", path: "/projects/Thesis/intro.md" }); });
    const saved = requests.findIndex((request) => request === `PUT /api/workspaces?root=${encodeURIComponent("/library")}`);
    const switched = requests.indexOf("POST /api/directory");
    assert.ok(saved >= 0 && saved < switched, "the notebook session is saved under its own root first");
    assert.equal(window.sessionStorage.getItem("libera:pending-open-file"), "Thesis/intro.md");
    assert.equal(notified, notifiedAfterLoad + 1, "the native menu is refreshed");
    assert.equal(navigations.length, 1, "the page reloads into the folder");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    delete window.liberaDirectory;
  }
});
