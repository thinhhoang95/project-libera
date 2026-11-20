import assert from "node:assert/strict";
import test from "node:test";
import { beginDrag, consumeDrag, splitDropDestination, type DragSlot } from "../../src/components/libera/drop-target";
import { movesFromRepairMessage, repairMessage } from "../../src/components/libera/repair-channel";
import { missingTabIds, unsavedNamesUnder } from "../../src/components/libera/tab-presence";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTree } from "../../src/lib/types";

const file = (path: string): LiberaFileNode => {
  const parts = path.split("/");
  return { kind: "file", name: parts.at(-1)!, path, notebook: parts[0] } as LiberaFileNode;
};
const tab = (path: string, extra: object = {}) => ({ id: path, file: file(path), ...extra });
const treeOf = (notebooks: Array<{ name: string; files: string[]; folder?: object }>): LiberaTree => ({
  notebooks: notebooks.map((nb) => ({ kind: "notebook", name: nb.name, path: nb.name, folder: nb.folder, children: nb.files.map(file) }) as unknown as LiberaNotebookNode),
}) as LiberaTree;

// F28
test("delete confirmation names the open files under the item with unsaved edits", () => {
  const tabs = [tab("Nb/Drafts/a.md"), tab("Nb/Drafts/sub/b.md"), tab("Nb/Drafts2/c.md"), tab("Nb/Other/d.md")];
  const dirty = new Set(["Nb/Drafts/a.md", "Nb/Drafts/sub/b.md", "Nb/Drafts2/c.md"]);
  const isUnsaved = (t: { file: LiberaFileNode }) => dirty.has(t.file.path);
  assert.deepEqual(unsavedNamesUnder(tabs, "Nb/Drafts", isUnsaved), ["a.md", "b.md"], "a sibling folder with the same prefix is not inside");
  assert.deepEqual(unsavedNamesUnder(tabs, "Nb/Drafts/a.md", isUnsaved), ["a.md"]);
  assert.deepEqual(unsavedNamesUnder(tabs, "Nb/Other", isUnsaved), [], "clean tabs add no warning");
});

// F29
test("drop destinations keep significant spaces", () => {
  assert.deepEqual(splitDropDestination(" Drafts"), { notebook: " Drafts", folder: "" });
  assert.deepEqual(splitDropDestination("Nb/ Drafts"), { notebook: "Nb", folder: " Drafts" });
  assert.deepEqual(splitDropDestination("Nb/Drafts"), { notebook: "Nb", folder: "Drafts" });
  assert.notEqual(splitDropDestination(" Drafts").notebook, splitDropDestination("Drafts").notebook);
  assert.deepEqual(splitDropDestination("Nb//Sub/"), { notebook: "Nb", folder: "Sub" }, "only empty segments go");
});

// F30
test("a drop consumes the drag at once, so a later drag survives the first move's completion", async () => {
  const slot: DragSlot = { current: null };
  const a = file("Nb/a.md");
  const b = file("Nb/b.md");
  beginDrag(slot, [a]);
  let release!: () => void;
  const slowMove = new Promise<void>((resolve) => { release = resolve; });
  // What the panel does at drop: take the file first, then await the move.
  const dropped = consumeDrag(slot);
  const completion = slowMove.then(() => dropped);
  assert.deepEqual(dropped, [a]);
  assert.equal(slot.current, null);
  assert.equal(consumeDrag(slot), null, "dropping the same drag twice moves nothing");
  beginDrag(slot, [b]);
  release();
  await completion;
  assert.deepEqual(slot.current, [b], "the first move finishing leaves the second drag alone");
  assert.deepEqual(consumeDrag(slot), [b]);
  // A selection is dragged as one list and consumed as one.
  beginDrag(slot, [a, b]);
  assert.deepEqual(consumeDrag(slot), [a, b]);
  assert.equal(consumeDrag(slot), null);
});

// F31
test("a record-free dirty note moved outside the app is reported missing after a refresh", () => {
  const tree = treeOf([{ name: "Nb", files: ["Nb/moved/note.md", "Nb/keep.md"] }]);
  const tabs = [tab("Nb/note.md"), tab("Nb/keep.md"), tab("Nb/untitled.md", { untitled: true }), tab("Nb/g.png", { gallery: {} }), tab("Other/x.md")];
  assert.deepEqual([...missingTabIds(tabs, tree)], ["Nb/note.md"], "unknown notebooks and non-file tabs are not judged");
  const unplugged = treeOf([{ name: "Nb", files: [], folder: { path: "/x", truncated: false, missing: true } }]);
  assert.equal(missingTabIds([tab("Nb/note.md")], unplugged).size, 0, "an unplugged linked folder proves nothing");
  const truncated = treeOf([{ name: "Nb", files: [], folder: { path: "/x", truncated: true } }]);
  assert.equal(missingTabIds([tab("Nb/note.md")], truncated).size, 0);
});

// F32
test("repair moves reach other windows but not the window that sent them", () => {
  const moves = [{ from: "Nb/a.md", to: "Nb/b/a.md" }];
  const message = repairMessage(moves);
  assert.deepEqual(movesFromRepairMessage(message, "another-window"), moves);
  assert.equal(movesFromRepairMessage(message), null, "own message: the window event already applied it");
  assert.equal(movesFromRepairMessage({ sender: "x", moves: [{ from: 1 }] }, "y"), null);
  assert.equal(movesFromRepairMessage("junk", "y"), null);
});
