import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import {
  createMarkdownFile,
  moveFileToDirectory,
  readLiberaFile,
  updateMarkdownFile,
} from "../../src/lib/storage/files";
import { writePdfAnnotations } from "../../src/lib/storage/annotations";
import { createNotebook, deleteNotebook, renameNotebook } from "../../src/lib/storage/notebooks";
import { createNotebookGroup } from "../../src/lib/storage/notebook-groups";
import { getAdminRoot } from "../../src/lib/storage/paths";
import { updateStarredFile } from "../../src/lib/storage/starred-files";
import { getTree } from "../../src/lib/storage/tree";
import { readWorkspaces, writeWorkspaces } from "../../src/lib/storage/workspaces";
import { emptyWorkspaceLibrary } from "../../src/lib/workspaces";
import type { LiberaTree, LiberaTreeNode } from "../../src/lib/types";

const require = createRequire(import.meta.url);
const { directoryModeStatePath, directoryStateRoot } = require("../../electron/directory-mode.cjs");

function filePaths(nodes: LiberaTreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "file" ? [node.path] : filePaths(node.children));
}

function notebookNamed(tree: LiberaTree, name: string) {
  const notebook = tree.notebooks.find((candidate) => candidate.name === name);
  assert.ok(notebook, `${name} is in the library`);
  return notebook;
}

async function withDataDirectory(run: (paths: { scratch: string; project: string }) => Promise<void>) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "libera-linked-folders-"));
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
    await run({ scratch, project });
  } finally {
    for (const folder of getDirectoryModeSummary().folders) closeDirectory(folder.name);
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(scratch, { recursive: true, force: true });
  }
}

test("a linked folder sits next to the notebooks and both stay usable", async () => {
  await withDataDirectory(async ({ project }) => {
    const linked = await openDirectory(project);
    assert.equal(linked.name, "Thesis Project");
    assert.equal(linked.changed, true);
    assert.deepEqual(linked.folders, [{ name: "Thesis Project", path: project }]);
    assert.deepEqual(linked.recent, [project]);
    assert.equal((await openDirectory(project)).changed, false, "linking twice keeps one link");

    const tree = await getTree();
    assert.equal(tree.root, getAdminRoot(), "the library stays the context");
    assert.deepEqual(tree.notebooks.map((notebook) => notebook.name).sort(), ["Library", "Thesis Project"]);
    const folder = notebookNamed(tree, "Thesis Project");
    assert.deepEqual(folder.folder, { path: project, truncated: false });
    assert.equal(folder.emoji, "📁");
    assert.equal(notebookNamed(tree, "Library").folder, undefined);
    assert.deepEqual(filePaths(folder.children).sort(), [
      "Thesis Project/README.md",
      "Thesis Project/chapters/intro.md",
      "Thesis Project/paper.pdf",
    ], "unsupported, hidden and dependency files stay out of the tree");

    assert.equal((await readLiberaFile("Thesis Project/chapters/intro.md")).content, "Intro\n");
    await updateMarkdownFile("Thesis Project/chapters/intro.md", "Edited\n");
    assert.equal(await readFile(path.join(project, "chapters", "intro.md"), "utf8"), "Edited\n");
    assert.equal((await readLiberaFile("Library/Private.md")).content, "library only", "notebooks stay reachable");
    await assert.rejects(readLiberaFile("Thesis Project/../Library/Private.md"));

    await createNotebook("Another");
    assert.ok(notebookNamed(await getTree(), "Another"), "notebooks can be created while folders are linked");
    await assert.rejects(createNotebook("thesis project"), /linked folder already uses/);
  });
});

test("folder names never collide with notebooks", async () => {
  await withDataDirectory(async ({ scratch }) => {
    const clash = path.join(scratch, "Library");
    await mkdir(clash);
    await writeFile(path.join(clash, "a.md"), "folder copy\n");
    const linked = await openDirectory(clash);
    assert.equal(linked.name, "Library (2)");
    assert.equal((await readLiberaFile("Library (2)/a.md")).content, "folder copy\n");
    assert.equal((await readLiberaFile("Library/Private.md")).content, "library only");
  });
});

test("app state for a linked folder lives in the data directory, not in the folder", async () => {
  await withDataDirectory(async ({ project }) => {
    await openDirectory(project);
    await writePdfAnnotations("Thesis Project/paper.pdf", []);
    await getTree();
    assert.deepEqual((await readdir(project)).sort(), ["README.md", "chapters", "node_modules", "notes.docx", "paper.pdf", ".git"].sort());
    const stateRoot = directoryStateRoot(getAdminRoot(), project);
    assert.ok(existsSync(path.join(stateRoot, ".libera", "annotations", "pdf", "paper.pdf.json")));
    assert.ok(existsSync(path.join(stateRoot, ".libera", "notebook-links.json")), "link index stays out of the folder");
  });
});

test("files move between notebooks and linked folders with their metadata", async () => {
  await withDataDirectory(async ({ project }) => {
    await openDirectory(project);
    await updateStarredFile("Library/Private.md", true);
    await moveFileToDirectory("Library/Private.md", "Thesis Project/chapters");
    assert.equal(await readFile(path.join(project, "chapters", "Private.md"), "utf8"), "library only");
    let tree = await getTree();
    assert.deepEqual(tree.starredFilePaths, ["Thesis Project/chapters/Private.md"]);

    await moveFileToDirectory("Thesis Project/chapters/Private.md", "Library");
    tree = await getTree();
    assert.deepEqual(tree.starredFilePaths, ["Library/Private.md"]);
    assert.equal(existsSync(path.join(project, "chapters", "Private.md")), false);
  });
});

test("linked folders can be renamed, grouped and removed without touching disk", async () => {
  await withDataDirectory(async ({ project }) => {
    await openDirectory(project);
    await updateStarredFile("Thesis Project/README.md", true);

    let tree = await renameNotebook("Thesis Project", "Thesis", { emoji: "🎓" });
    const renamed = notebookNamed(tree, "Thesis");
    assert.equal(renamed.emoji, "🎓");
    assert.deepEqual(tree.starredFilePaths, ["Thesis/README.md"]);
    assert.ok(existsSync(path.join(project, "README.md")), "the folder on disk keeps its name");
    await assert.rejects(renameNotebook("Thesis", "Library"), /already uses this name/);

    tree = await createNotebookGroup({ title: "Research", notebookNames: ["Thesis", "Library"] });
    const groupId = tree.notebookGroups[0].id;
    assert.equal(notebookNamed(tree, "Thesis").groupId, groupId);
    assert.equal(notebookNamed(tree, "Library").groupId, groupId);

    await assert.rejects(deleteNotebook("Thesis"), /Remove the folder/);
    assert.deepEqual(closeDirectory("Thesis").folders, []);
    assert.ok(existsSync(path.join(project, "README.md")), "removing a folder keeps its files");
    tree = await getTree();
    assert.deepEqual(tree.notebooks.map((notebook) => notebook.name), ["Library"]);
    assert.throws(() => closeDirectory("Thesis"), /not linked/);
  });
});

test("notebooks and folders share one workspace session", async () => {
  await withDataDirectory(async ({ project }) => {
    const adminRoot = getAdminRoot();
    await writeWorkspaces({ ...emptyWorkspaceLibrary(), updatedAt: 10 }, adminRoot);
    await openDirectory(project);
    assert.equal((await readWorkspaces(adminRoot)).updatedAt, 10, "linking a folder keeps the session");
    assert.throws(() => writeWorkspaces(emptyWorkspaceLibrary(), project), /out of date/);
  });
});

test("opening a file opens it in place or links its folder", async () => {
  await withDataDirectory(async ({ project }) => {
    const opened = await openFileLocation(path.join(project, "chapters", "intro.md"));
    assert.equal(opened.changed, true);
    assert.equal(opened.filePath, "chapters/intro.md");
    assert.deepEqual(opened.folders, [{ name: "chapters", path: path.join(project, "chapters") }]);

    await openDirectory(project);
    const inside = await openFileLocation(path.join(project, "chapters", "intro.md"));
    assert.equal(inside.changed, false);
    assert.equal(inside.filePath, "chapters/intro.md", "the deepest linked folder wins");
    const readme = await openFileLocation(path.join(project, "README.md"));
    assert.equal(readme.filePath, "Thesis Project/README.md");

    const library = await openFileLocation(path.join(getAdminRoot(), "Library", "Private.md"));
    assert.equal(library.changed, false);
    assert.equal(library.filePath, "Library/Private.md");

    await assert.rejects(openFileLocation(path.join(project, "notes.docx")), /cannot open/);
  });
});

test("missing folders stay linked and invalid folders are refused", async () => {
  await withDataDirectory(async ({ project }) => {
    await openDirectory(project);
    const moved = path.join(path.dirname(project), "Moved");
    await rename(project, moved);
    let folder = notebookNamed(await getTree(), "Thesis Project");
    assert.deepEqual(folder.folder, { path: project, truncated: false, missing: true });
    assert.deepEqual(folder.children, []);
    assert.equal(notebookNamed(await getTree(), "Library").children.length, 1, "notebooks still load");

    await rename(moved, project);
    folder = notebookNamed(await getTree(), "Thesis Project");
    assert.equal(folder.folder?.missing, undefined, "the folder returns when it is back");

    assert.deepEqual(clearRecentDirectories().recent, []);
    await assert.rejects(openDirectory(path.join(project, "missing")), /not found/);
    await assert.rejects(openDirectory(getAdminRoot()), /already part of your Libera library/);
    await assert.rejects(openDirectory(path.join(getAdminRoot(), "Library")), /already part of your Libera library/);
    await assert.rejects(openDirectory("relative/path"), /Folder was not found|Choose a folder/);
  });
});

test("a folder open in the old single-folder mode joins the library with its stars", async () => {
  await withDataDirectory(async ({ project }) => {
    const adminRoot = getAdminRoot();
    const stateRoot = directoryStateRoot(adminRoot, project);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(path.join(stateRoot, ".libera-workspace.json"), JSON.stringify({
      starredFilePaths: ["Thesis Project/README.md"],
      fileTags: { "Thesis Project/paper.pdf": ["reading"] },
    }));
    await mkdir(path.dirname(directoryModeStatePath(adminRoot)), { recursive: true });
    await writeFile(directoryModeStatePath(adminRoot), JSON.stringify({ version: 1, current: project, recent: [project] }));

    assert.deepEqual(getDirectoryModeSummary().folders, [{ name: "Thesis Project", path: project }]);
    const tree = await getTree();
    assert.deepEqual(tree.notebooks.map((notebook) => notebook.name).sort(), ["Library", "Thesis Project"]);
    assert.deepEqual(tree.starredFilePaths, ["Thesis Project/README.md"]);
    assert.deepEqual(tree.fileTags, { "Thesis Project/paper.pdf": ["reading"] });
    assert.equal(existsSync(path.join(stateRoot, ".libera-workspace.json")), false, "merged once");
  });
});

test("menu commands link folders in place without reloading", async () => {
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
  const now = new Date().toISOString();
  const introFile = {
    kind: "file" as const, name: "intro.md", path: "Thesis/intro.md", notebook: "Thesis",
    fileType: "markdown" as const, createdAt: now, updatedAt: now, size: 6,
  };
  const libraryTree: LiberaTree = { ...emptyTree(), root: "/library" };
  const linkedTree: LiberaTree = {
    ...libraryTree,
    notebooks: [{
      kind: "notebook", name: "Thesis", path: "Thesis", folder: { path: "/projects/Thesis", truncated: false },
      createdAt: now, updatedAt: now, color: "#475569", emoji: "📁", groupId: null, children: [introFile],
    }],
  };
  let currentTree = libraryTree;
  let directoryResponse: () => Response = () => Response.json({});
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    requests.push(`${init?.method ?? "GET"} ${target}`);
    if (target.startsWith("/api/workspaces")) return Response.json(init?.method === "PUT" ? { saved: true } : emptyWorkspaceLibrary());
    if (target === "/api/directory") return directoryResponse();
    if (target.startsWith("/api/files?")) return Response.json({ file: introFile, content: "Intro\n" });
    return Response.json(currentTree);
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

    directoryResponse = () => Response.json({ error: "Folder was not found." }, { status: 404 });
    await act(async () => { listener!({ type: "open-directory", path: "/projects/Missing" }); });
    assert.equal(workspace.workspaceError, "Folder was not found.");
    assert.equal(workspace.workspaceManager.ready, true, "a failed link leaves the session running");

    directoryResponse = () => {
      currentTree = linkedTree;
      return Response.json({ changed: true, name: "Thesis", folders: [{ name: "Thesis", path: "/projects/Thesis" }], recent: [] });
    };
    await act(async () => { listener!({ type: "open-directory", path: "/projects/Thesis" }); });
    assert.equal(workspace.workspaceError, "");
    assert.equal(workspace.selectedNotebookName, "Thesis", "the linked folder is shown");
    assert.ok(workspace.expanded.has("Thesis"));
    assert.equal(notified, notifiedAfterLoad + 1, "the native menu is refreshed");

    requests.length = 0;
    directoryResponse = () => Response.json({ changed: false, filePath: "Thesis/intro.md", folders: [], recent: [] });
    await act(async () => { listener!({ type: "open-file", path: "/projects/Thesis/intro.md" }); });
    assert.ok(requests.includes(`GET /api/files?path=${encodeURIComponent("Thesis/intro.md")}`), "the file opens in a tab");
    assert.equal(workspace.activeTabId, "Thesis/intro.md");

    directoryResponse = () => {
      currentTree = libraryTree;
      return Response.json({ folders: [], recent: [] });
    };
    await act(async () => { listener!({ type: "close-directory", name: "Thesis" }); });
    assert.equal(workspace.tabs.length, 0, "tabs from the removed folder close");
    assert.equal(navigations.length, 0, "the page never reloads");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    delete window.liberaDirectory;
  }
});
