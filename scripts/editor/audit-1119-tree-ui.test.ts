import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { FileListEntry, HostEvent } from "../../src/lib/collab/local-api";
import {
  SHARED_TREE_REFRESH_MS,
  eventNotebooks,
  isIdentityConflict,
  movesOverlap,
  notebooksToRefresh,
  planMoves,
  replaceNotebook,
  subscribeSharedTreeChanges,
  withBackoff,
  type RefreshScope,
} from "../../src/lib/collab/ui/tree-changes";
import { attachSharedFileIds } from "../../src/lib/collab/tree-file-ids";
import { attachFileIds, getNotebookNode } from "../../src/lib/storage/tree";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTree } from "../../src/lib/types";

function file(notebook: string, name: string, extra: Partial<LiberaFileNode> = {}): LiberaFileNode {
  return { kind: "file", name, path: `${notebook}/${name}`, notebook, fileType: "markdown", createdAt: "", updatedAt: "", size: 10, ...extra };
}
function notebookNode(name: string, children: LiberaFileNode[], extra: Partial<LiberaNotebookNode> = {}): LiberaNotebookNode {
  return { kind: "notebook", name, path: name, createdAt: "", color: "", emoji: "", groupId: null, updatedAt: "", children, ...extra } as LiberaNotebookNode;
}
function treeOf(notebooks: LiberaNotebookNode[], view: { hiddenNotebookNames?: string[]; hiddenGroupIds?: string[] } = {}): LiberaTree {
  return { notebooks, notebookViewOptions: { hiddenGroupIds: [], hiddenNotebookNames: [], showArchive: true, ...view } } as unknown as LiberaTree;
}
function entry(path: string, fileId: string, extra: Partial<FileListEntry> = {}): FileListEntry {
  return { fileId, path, kind: "blob", updatedAt: 0, ...extra };
}

test("finding 24: a swap stays a swap and files through one name keep separate destinations", () => {
  assert.deepEqual(planMoves([{ from: "N/a.md", to: "N/b.md" }, { from: "N/b.md", to: "N/a.md" }]),
    [{ from: "N/a.md", to: "N/b.md" }, { from: "N/b.md", to: "N/a.md" }]);
  // a→b is one file, b→c another: not one file that went a→c.
  assert.deepEqual(planMoves([{ from: "N/a.md", to: "N/b.md" }, { from: "N/b.md", to: "N/c.md" }]),
    [{ from: "N/a.md", to: "N/b.md" }, { from: "N/b.md", to: "N/c.md" }]);
  assert.deepEqual(planMoves([{ from: "N/a.md", to: "N/a.md" }]), []);
  // The same file id seen moving twice is one move from where it began.
  assert.deepEqual(planMoves([{ from: "N/a.md", to: "N/b.md", fileId: "f1" }, { from: "N/b.md", to: "N/c.md", fileId: "f1" }]),
    [{ from: "N/a.md", to: "N/c.md", fileId: "f1" }]);
  assert.deepEqual(planMoves([{ from: "N/a.md", to: "N/b.md", fileId: "f1" }, { from: "N/b.md", to: "N/a.md", fileId: "f1" }]), []);
});

test("finding 24: overlapping moves are detected so they are applied as a whole", () => {
  assert.equal(movesOverlap([{ from: "a", to: "b" }, { from: "b", to: "a" }]), true);
  assert.equal(movesOverlap([{ from: "a", to: "b" }, { from: "c", to: "d" }]), false);
});

test("finding 24: a destination lookup is retried with bounded backoff", async () => {
  const waits: number[] = [];
  let calls = 0;
  const value = await withBackoff(async () => { if (++calls < 3) throw new Error("not yet"); return "here"; }, [10, 20, 30], async (ms) => { waits.push(ms); });
  assert.equal(value, "here");
  assert.deepEqual(waits, [10, 20]);
  calls = 0;
  waits.length = 0;
  await assert.rejects(withBackoff(async () => { calls++; throw new Error("gone"); }, [1, 2], async (ms) => { waits.push(ms); }), /gone/);
  assert.equal(calls, 3, "one try plus one per wait, then it gives up");
  assert.deepEqual(waits, [1, 2]);
});

test("finding 36: events name their notebooks, and the window refreshes only those it shows", () => {
  assert.deepEqual(eventNotebooks({ t: "files-changed", projectId: "p", paths: ["Alpha/x.md", "Alpha/sub/y.md", "Beta/z.md"] }), ["Alpha", "Beta"]);
  assert.equal(eventNotebooks({ t: "files-changed", projectId: "p", paths: ["x.md"] })?.[0], "x.md");
  assert.equal(eventNotebooks({ t: "files-changed", projectId: "p", paths: [""] }), null);
  assert.deepEqual(eventNotebooks({ t: "tree-changed", projectId: "p", notebook: "Gamma", added: [], moves: [], removed: [] }), ["Gamma"]);

  const tree = treeOf([notebookNode("Alpha", []), notebookNode("Beta", [], { groupId: "g" }), notebookNode("Gamma", [])],
    { hiddenNotebookNames: ["Gamma"], hiddenGroupIds: ["g"] });
  assert.deepEqual(notebooksToRefresh({ notebooks: ["Alpha"] }, tree), ["Alpha"]);
  assert.deepEqual(notebooksToRefresh({ notebooks: ["Beta", "Gamma"] }, tree), [], "hidden notebooks and hidden groups need no fetch");
  assert.equal(notebooksToRefresh({ notebooks: ["Delta"] }, tree), null, "an unknown notebook means the library changed shape");
  assert.equal(notebooksToRefresh({ notebooks: null }, tree), null);
});

test("finding 36: the refresh receives the notebooks the batch touched", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let listener: ((event: HostEvent) => void) | null = null;
  const scopes: RefreshScope[] = [];
  const stop = subscribeSharedTreeChanges((callback) => { listener = callback; return () => { listener = null; }; }, (scope) => { scopes.push(scope); }, () => undefined,
    { hidden: () => false, onVisible: () => () => undefined });
  try {
    listener!({ t: "files-changed", projectId: "p", paths: ["Alpha/a.md"] });
    listener!({ t: "tree-changed", projectId: "p", notebook: "Beta", added: ["Beta/b.md"], moves: [], removed: [] });
    t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
    assert.deepEqual(scopes.map((scope) => scope.notebooks?.slice().sort()), [["Alpha", "Beta"]]);
    listener!({ t: "files-changed", projectId: "p", paths: ["Alpha/a.md"] });
    t.mock.timers.tick(SHARED_TREE_REFRESH_MS);
    assert.deepEqual(scopes[1]?.notebooks, ["Alpha"], "the next batch starts clean");
  } finally {
    stop();
    t.mock.timers.reset();
  }
});

test("finding 36: a scoped notebook read keeps links into other notebooks until the next full read", () => {
  const before = treeOf([
    notebookNode("Alpha", [file("Alpha", "a.md", { linkedFilePaths: ["Beta/b.md", "Alpha/c.md"] }), file("Alpha", "c.md")], { relatedNotebookNames: ["Beta"] }),
    notebookNode("Beta", [file("Beta", "b.md")]),
  ]);
  const fresh = notebookNode("Alpha", [file("Alpha", "a.md", { linkedFilePaths: ["Alpha/c.md"] }), file("Alpha", "c.md"), file("Alpha", "new.md")]);
  const merged = replaceNotebook(before, fresh);
  const alpha = merged.notebooks[0];
  const a = alpha.children.find((node) => node.path === "Alpha/a.md") as LiberaFileNode;
  assert.deepEqual(a.linkedFilePaths, ["Alpha/c.md", "Beta/b.md"]);
  assert.deepEqual(alpha.relatedNotebookNames, ["Beta"]);
  assert.equal(alpha.children.length, 3);
  assert.equal(merged.notebooks[1], before.notebooks[1], "other notebooks are untouched");
});

test("finding 1: file ids attach only where the listing agrees with the node, and a missing listing leaves none", async () => {
  const nodes = [file("Shared", "a.pdf", { size: 5 }), file("Shared", "b.pdf", { size: 7 }), file("Shared", "doc.md", { size: 3 })];
  const folder = { kind: "folder" as const, name: "sub", path: "Shared/sub", notebook: "Shared", createdAt: "", updatedAt: "", children: [file("Shared", "sub/c.png", { size: 9 })] };
  const book = notebookNode("Shared", [...nodes] as LiberaFileNode[]);
  (book.children as unknown[]).push(folder);
  const listing = async () => [
    entry("Shared/a.pdf", "id-a", { size: 5 }),
    entry("Shared/b.pdf", "id-b-new", { size: 99 }), // another file now holds this name
    entry("Shared/doc.md", "id-doc", { kind: "doc" }),
    entry("Shared/sub/c.png", "id-c", { size: 9 }),
    entry("Shared/sub", "id-folder", { kind: "folder" }),
  ];
  await attachSharedFileIds([book, notebookNode("Local", [file("Local", "x.md")])], listing, (name) => name === "Shared");
  const byPath = (path: string) => {
    const find = (list: unknown[]): LiberaFileNode | undefined => { for (const node of list as (LiberaFileNode | { kind: "folder"; children: unknown[] })[]) { if (node.kind === "file" && node.path === path) return node; if (node.kind === "folder") { const found = find(node.children); if (found) return found; } } return undefined; };
    return find(book.children);
  };
  // A tree load reads no bytes (see shared-tree-identity-integrity.test.ts), so no row is given an id by size or name.
  for (const name of ["Shared/a.pdf", "Shared/b.pdf", "Shared/sub/c.png"]) assert.equal(byPath(name)?.fileId, undefined, name);
  assert.equal(byPath("Shared/doc.md")?.fileId, "id-doc", "a document row carries the listing's entry id");
  assert.equal(byPath("Shared/a.pdf")?.fileIdState, "unknown");

  const offline = notebookNode("Shared", [file("Shared", "a.pdf", { size: 5 })]);
  await attachSharedFileIds([offline], async () => { throw new Error("host offline"); }, () => true);
  assert.equal((offline.children[0] as LiberaFileNode).fileId, undefined);

  const slow = notebookNode("Shared", [file("Shared", "a.pdf", { size: 5 })]);
  await attachSharedFileIds([slow], () => new Promise<FileListEntry[]>(() => undefined), () => true, 20);
  assert.equal((slow.children[0] as LiberaFileNode).fileId, undefined, "a hung host does not hold the tree");

  const standalone = [file("Shared", "a.pdf", { size: 5 })];
  attachFileIds(standalone, [entry("Shared/a.pdf", "x", { size: 5 })], () => true);
  assert.equal(standalone[0].fileId, "x");
});

test("finding 1: only the host's identity refusal reads as a changed file", () => {
  const conflict = Object.assign(new Error("This file changed since it was read. Refresh it before changing it."), { status: 409 });
  assert.equal(isIdentityConflict(conflict), true);
  assert.equal(isIdentityConflict(Object.assign(new Error("Destination file already exists."), { status: 409 })), false);
  assert.equal(isIdentityConflict(Object.assign(new Error("changed since it was read"), { status: 500 })), false);
  assert.equal(isIdentityConflict(null), false);
});

test("finding 36: one notebook can be read alone", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-notebook-node-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const root = path.join(directory, "users/admin");
    for (const name of ["Alpha", "Beta"]) await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, "Alpha/a.md"), "hello");
    await writeFile(path.join(root, "Beta/b.md"), "other");
    const node = await getNotebookNode("Alpha");
    assert.equal(node?.name, "Alpha");
    assert.deepEqual(node?.children.map((child) => child.name), ["a.md"]);
    assert.equal(await getNotebookNode("Missing"), null);
    assert.equal(await getNotebookNode("../Alpha"), null);
    assert.equal(await getNotebookNode(".hidden"), null);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
