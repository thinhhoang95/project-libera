import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { presetSourceRefused, requestPaths, type MigrationPreset } from "../../src/components/libera/notebook-migration-dialog";
import { NO_SELECTION, selectRange, toggleFile } from "../../src/components/libera/file-selection";
import type { LiberaFileNode, LiberaTreeNode } from "../../src/lib/types";

const file = (filePath: string): LiberaFileNode => {
  const [notebook, ...rest] = filePath.split("/");
  return { kind: "file", name: rest.at(-1) ?? "", path: filePath, notebook, fileType: "markdown", createdAt: "", updatedAt: "", changedAt: "", size: 1 } as LiberaFileNode;
};

test("U-C4: a preset from a shared notebook is refused, never re-sourced to a local notebook", () => {
  const preset: MigrationPreset = { paths: ["SharedNB/a.md"], destination: "LocalA", folder: "", flat: true };
  assert.equal(presetSourceRefused(preset, "SharedNB", ["LocalA", "LocalB"]), true);
  assert.equal(presetSourceRefused(preset, "LocalB", ["LocalA", "LocalB"]), false);
  // Opened from the menu without paths: the user picks the source, nothing is refused.
  assert.equal(presetSourceRefused(null, "SharedNB", ["LocalA"]), false);
});

test("U-C5: the paths checked for unsaved tabs are the paths the request sends, `_archive` ones included", () => {
  const preset: MigrationPreset = { paths: ["Nb/_archive/z.md", "Nb/a.md"], destination: "Other", folder: "", flat: true };
  // The visible tree hides the top-level _archive folder, so selecting by tree would find only a.md or nothing.
  const visible: LiberaTreeNode[] = [file("Nb/a.md")];
  assert.deepEqual(requestPaths(preset, visible, new Set(preset.paths)), ["Nb/_archive/z.md", "Nb/a.md"]);
  assert.deepEqual(requestPaths(preset, [], new Set(["Nb/_archive/z.md"])), ["Nb/_archive/z.md"]);
  // Without a preset the tree decides, as before.
  assert.deepEqual(requestPaths(null, visible, new Set(["Nb/a.md"])), ["Nb/a.md"]);
});

test("U-M1: Shift+Click in the Starred list ranges over the starred files of that notebook", () => {
  const starred = [file("A/1.md"), file("B/x.md"), file("A/2.md"), file("A/3.md")];
  const scope = (clicked: LiberaFileNode) => starred.filter((item) => item.notebook === clicked.notebook);
  const anchored = toggleFile(NO_SELECTION, starred[0]);
  assert.deepEqual(selectRange(anchored, starred[3], scope(starred[3])).paths, ["A/1.md", "A/2.md", "A/3.md"]);
});

// The row and section handlers are JSX closures; pin their wiring from the source.
const panel = readFileSync("src/components/libera/notebook-panel.tsx", "utf8");

test("U-M1: Starred rows take no drops and range inside the Starred list", () => {
  assert.match(panel, /dropDisabled\r?\n\s+rangeScope=\{visibleFiles\}/);
  assert.match(panel, /dropDisabled \? null : draggingFile/);
});

test("U-M2: a drop does not clear the multi-selection before the move is done", () => {
  const body = panel.slice(panel.indexOf("async function dropFileOnPath"), panel.indexOf("/** Plain click opens"));
  assert.doesNotMatch(body, /setSelection\(NO_SELECTION\)/);
});

test("U-M2: a missing linked folder takes no drops and leaving for a child does not clear the highlight", () => {
  assert.match(panel, /const dropFile = linkedFolder\?\.missing \? null : draggingFile/);
  assert.doesNotMatch(panel, /onDragLeave=\{\(\) => onSetDragOverPath\(""\)\}/);
});
