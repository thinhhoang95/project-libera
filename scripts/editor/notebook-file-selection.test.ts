import assert from "node:assert/strict";
import test from "node:test";
import {
  NO_SELECTION,
  draggedFiles,
  isSelected,
  pruneSelection,
  selectRange,
  selectedFiles,
  toggleFile,
  usesBatchMenu,
  visibleFiles,
} from "../../src/components/libera/file-selection";
import type { LiberaFileNode, LiberaFolderNode, LiberaNotebookNode, LiberaTree, LiberaTreeNode } from "../../src/lib/types";

const file = (filePath: string): LiberaFileNode => {
  const [notebook, ...rest] = filePath.split("/");
  return { kind: "file", name: rest.at(-1) ?? "", path: filePath, notebook, fileType: "markdown", createdAt: "", updatedAt: "", changedAt: "", size: 1 } as LiberaFileNode;
};
const folder = (folderPath: string, children: LiberaTreeNode[]): LiberaFolderNode => {
  const [notebook, ...rest] = folderPath.split("/");
  return { kind: "folder", name: rest.at(-1) ?? "", path: folderPath, notebook, createdAt: "", updatedAt: "", children } as LiberaFolderNode;
};
const treeOf = (notebooks: { name: string; children: LiberaTreeNode[] }[]) =>
  ({ notebooks: notebooks.map((notebook) => ({ kind: "notebook", path: notebook.name, ...notebook })) as unknown as LiberaNotebookNode[], notebookGroups: [] }) as unknown as LiberaTree;

const a = file("Nb/a.md");
const b = file("Nb/b.md");
const c = file("Nb/sub/c.md");
const d = file("Nb/sub/d.md");
const other = file("Other/x.md");
const tree = treeOf([{ name: "Nb", children: [a, b, folder("Nb/sub", [c, d])] }, { name: "Other", children: [other] }]);

test("Ctrl+Click toggles a file in and out of the selection", () => {
  let selection = toggleFile(NO_SELECTION, a);
  selection = toggleFile(selection, c);
  assert.deepEqual(selection.paths, ["Nb/a.md", "Nb/sub/c.md"]);
  assert.equal(isSelected(selection, "Nb/a.md"), true);
  assert.equal(isSelected(selection, "Nb/b.md"), false);
  selection = toggleFile(selection, a);
  assert.deepEqual(selection.paths, ["Nb/sub/c.md"]);
  assert.equal(toggleFile(selection, c), NO_SELECTION, "the last file out leaves nothing selected");
});

test("a Ctrl+Click on a file of another notebook starts a new selection there", () => {
  const selection = toggleFile(toggleFile(NO_SELECTION, a), b);
  const next = toggleFile(selection, other);
  assert.equal(next.notebook, "Other");
  assert.deepEqual(next.paths, ["Other/x.md"]);
});

test("Shift+Click selects the visible files between the anchor and the file, in either direction", () => {
  const visible = visibleFiles(tree.notebooks[0].children, () => true, () => 20, "Nb");
  assert.deepEqual(visible.map((item) => item.path), ["Nb/a.md", "Nb/b.md", "Nb/sub/c.md", "Nb/sub/d.md"]);
  const anchored = toggleFile(NO_SELECTION, b);
  assert.deepEqual(selectRange(anchored, d, visible).paths, ["Nb/b.md", "Nb/sub/c.md", "Nb/sub/d.md"]);
  assert.deepEqual(selectRange(anchored, a, visible).paths, ["Nb/a.md", "Nb/b.md"]);
  assert.equal(selectRange(anchored, d, visible).anchor, "Nb/b.md", "the anchor stays for the next range");
  // No anchor in this notebook: just the file.
  assert.deepEqual(selectRange(toggleFile(NO_SELECTION, other), a, visible).paths, ["Nb/a.md"]);
  assert.deepEqual(selectRange(NO_SELECTION, c, visible).paths, ["Nb/sub/c.md"]);
});

test("a range covers only the rows that are shown: collapsed folders and rows behind Show more are skipped", () => {
  const children = tree.notebooks[0].children;
  assert.deepEqual(visibleFiles(children, () => false, () => 20, "Nb").map((item) => item.name), ["a.md", "b.md"]);
  assert.deepEqual(visibleFiles(children, () => true, (path) => (path === "Nb" ? 2 : 20), "Nb").map((item) => item.name), ["a.md", "b.md"]);
  assert.deepEqual(visibleFiles(children, () => true, (path) => (path === "Nb/sub" ? 1 : 20), "Nb").map((item) => item.name), ["a.md", "b.md", "c.md"]);
});

test("a refresh drops the paths that left the tree and keeps the rest", () => {
  const selection = toggleFile(toggleFile(toggleFile(NO_SELECTION, a), b), c);
  assert.equal(pruneSelection(selection, tree), selection, "nothing changed: the same selection");
  const moved = treeOf([{ name: "Nb", children: [b, folder("Nb/sub", [d])] }, { name: "Other", children: [other] }]);
  const pruned = pruneSelection(selection, moved);
  assert.deepEqual(pruned.paths, ["Nb/b.md"]);
  assert.equal(pruned.anchor, "Nb/b.md", "an anchor that left is replaced");
  assert.equal(pruneSelection(selection, treeOf([{ name: "Nb", children: [] }])), NO_SELECTION);
  assert.equal(pruneSelection(NO_SELECTION, moved), NO_SELECTION);
  // A folder is not a file: a selected path that became one is dropped.
  assert.equal(pruneSelection(toggleFile(NO_SELECTION, file("Nb/sub")), tree), NO_SELECTION);
});

test("the batch menu applies to a right-click on one of two or more selected files only", () => {
  const one = toggleFile(NO_SELECTION, a);
  assert.equal(usesBatchMenu(one, a), false, "one file is the single-file menu");
  const two = toggleFile(one, b);
  assert.equal(usesBatchMenu(two, a), true);
  assert.equal(usesBatchMenu(two, b), true);
  assert.equal(usesBatchMenu(two, c), false, "a file outside the selection gets its own menu");
  assert.equal(usesBatchMenu(NO_SELECTION, a), false);
});

test("a drag carries the selection when it starts on a selected file, else just the file", () => {
  const selection = toggleFile(toggleFile(NO_SELECTION, a), c);
  assert.deepEqual(draggedFiles(selection, c, tree).map((item) => item.path), ["Nb/a.md", "Nb/sub/c.md"]);
  assert.deepEqual(draggedFiles(selection, b, tree), [b]);
  assert.deepEqual(draggedFiles(toggleFile(NO_SELECTION, a), a, tree), [a], "a selection of one drags as a single file");
  assert.deepEqual(selectedFiles(selection, tree), [a, c]);
});
