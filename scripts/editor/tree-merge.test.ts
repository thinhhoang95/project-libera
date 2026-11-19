import assert from "node:assert/strict";
import test from "node:test";
import { applyFileMetadata, mergeTree, patchFileNodes } from "../../src/lib/tree-merge";
import type { LiberaFileNode, LiberaFolderNode, LiberaNotebookNode, LiberaTree } from "../../src/lib/types";

function file(notebook: string, relative: string, extra: Partial<LiberaFileNode> = {}): LiberaFileNode {
  return {
    kind: "file", name: relative.split("/").at(-1)!, path: `${notebook}/${relative}`, notebook, fileType: "markdown",
    createdAt: "2026-01-01T00:00:00.000Z", changedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", size: 10, ...extra,
  };
}

function makeTree(): LiberaTree {
  const sub: LiberaFolderNode = {
    kind: "folder", name: "sub", path: "Alpha/sub", notebook: "Alpha", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", children: [file("Alpha", "sub/deep.md")],
  };
  const notebook = (name: string, children: LiberaNotebookNode["children"]): LiberaNotebookNode => ({
    kind: "notebook", name, path: name, createdAt: "2026-01-01T00:00:00.000Z", color: "#000", emoji: "N", groupId: null,
    updatedAt: "2026-01-01T00:00:00.000Z", children,
  });
  return {
    root: "/root", notebookPanelExpandedPaths: null, notebookGroups: [],
    notebookViewOptions: { hiddenGroupIds: [], hiddenNotebookNames: [], showArchive: false, showFileDetails: true },
    starredFilePaths: [], fileTags: {},
    notebooks: [notebook("Alpha", [sub, file("Alpha", "a.md"), file("Alpha", "b.md")]), notebook("Beta", [file("Beta", "c.md")])],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("an identical tree merges to the previous object", () => {
  const previous = makeTree();
  assert.equal(mergeTree(previous, clone(previous)), previous);
});

test("a changed file replaces only that file and its ancestors", () => {
  const previous = makeTree();
  const next = clone(previous);
  const alpha = next.notebooks[0];
  const deep = (alpha.children[0] as LiberaFolderNode).children[0] as LiberaFileNode;
  deep.size = 99;
  const merged = mergeTree(previous, next);
  assert.notEqual(merged, previous);
  assert.notEqual(merged.notebooks[0], previous.notebooks[0]);
  assert.notEqual(merged.notebooks[0].children[0], previous.notebooks[0].children[0]);
  assert.equal(merged.notebooks[0].children[1], previous.notebooks[0].children[1], "siblings keep their identity");
  assert.equal(merged.notebooks[0].children[2], previous.notebooks[0].children[2]);
  assert.equal(merged.notebooks[1], previous.notebooks[1], "other notebooks keep theirs");
  assert.equal(merged.notebookGroups, previous.notebookGroups);
});

test("an added file does not make later siblings look changed", () => {
  const previous = makeTree();
  const next = clone(previous);
  next.notebooks[0].children.splice(1, 0, file("Alpha", "a0.md"));
  const merged = mergeTree(previous, next);
  assert.equal(merged.notebooks[0].children[2], previous.notebooks[0].children[1]);
  assert.equal(merged.notebooks[0].children[3], previous.notebooks[0].children[2]);
  assert.equal(merged.notebooks[1], previous.notebooks[1]);
});

test("with no previous tree the new one is used as it is", () => {
  const next = makeTree();
  assert.equal(mergeTree(null, next), next);
});

test("patching a file replaces it and its ancestors, and an unchanged file returns the tree itself", () => {
  const tree = makeTree();
  assert.equal(patchFileNodes(tree, [clone(tree.notebooks[0].children[1] as LiberaFileNode)]), tree);
  const changed = file("Alpha", "sub/deep.md", { size: 50, updatedAt: "2026-02-01T00:00:00.000Z" });
  const patched = patchFileNodes(tree, [changed])!;
  const folder = patched.notebooks[0].children[0] as LiberaFolderNode;
  assert.equal((folder.children[0] as LiberaFileNode).size, 50);
  assert.equal(folder.updatedAt, "2026-02-01T00:00:00.000Z", "ancestors take the newer date");
  assert.equal(patched.notebooks[0].updatedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(patched.notebooks[0].children[1], tree.notebooks[0].children[1]);
  assert.equal(patched.notebooks[1], tree.notebooks[1]);
  assert.equal(patchFileNodes(tree, [file("Alpha", "new.md")]), null, "a file the tree does not show needs the full read");
  assert.equal(patchFileNodes(tree, [file("Gamma", "x.md")]), null);
});

test("file metadata is applied unless the links or the file set changed", () => {
  const tree = makeTree();
  const shown = tree.notebooks[0].children[1] as LiberaFileNode;
  shown.linkedFilePaths = ["Alpha/b.md"];
  const fresh = (extra: Partial<LiberaFileNode>) => file("Alpha", "a.md", extra);
  const same = applyFileMetadata(tree, [{ path: "Alpha/a.md", metadata: { node: fresh({}), linkDestinations: ["b.md"] } }]);
  assert.equal(same, tree, "the same size, dates and links change nothing");
  const bigger = applyFileMetadata(tree, [{ path: "Alpha/a.md", metadata: { node: fresh({ size: 77 }), linkDestinations: ["b.md"] } }])!;
  const patched = bigger.notebooks[0].children[1] as LiberaFileNode;
  assert.equal(patched.size, 77);
  assert.deepEqual(patched.linkedFilePaths, ["Alpha/b.md"]);
  assert.equal(bigger.notebooks[0].children[2], tree.notebooks[0].children[2]);
  assert.equal(applyFileMetadata(tree, [{ path: "Alpha/a.md", metadata: { node: fresh({}), linkDestinations: [] } }]), null, "a removed link needs the full read");
  assert.equal(applyFileMetadata(tree, [{ path: "Alpha/a.md", metadata: { node: fresh({}), linkDestinations: ["b.md", "../Beta/c.md"] } }]), null, "an added link needs the full read");
  assert.equal(applyFileMetadata(tree, [{ path: "Alpha/a.md", metadata: null }]), null, "a missing file needs the full read");
});
