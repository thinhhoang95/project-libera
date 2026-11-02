import assert from "node:assert/strict";
import { test } from "node:test";
import { DELETION_COUNT_LIMIT, planTetherSync, type TetherBaseEntry, type TetherPlanInput } from "../../src/lib/references/bib-tether-merge";
import { parseBibtex } from "../../src/lib/references/bibtex";
import { applyLibraryOps, emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import type { ReferenceLibrary, ReferenceLibraryOp } from "../../src/lib/references/types";

// The three-way merge behind a tethered .bib file: both directions, edits
// in place that keep the user's text, conflicts, renames, and the guards
// against losing entries.

const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const T2 = "2026-10-03T00:00:00.000Z";

let counter = 0;
const newId = () => `ref_test_${++counter}`;

function library(ops: ReferenceLibraryOp[], now = T0): ReferenceLibrary {
  return { ...applyLibraryOps(emptyReferenceLibrary(), ops, now).library, revision: 1 };
}

function apply(current: ReferenceLibrary, ops: ReferenceLibraryOp[], now = T1): ReferenceLibrary {
  return { ...applyLibraryOps(current, ops, now).library, revision: current.revision + 1 };
}

const smith = { op: "add" as const, entry: { key: "smith2020", csl: { type: "article-journal" as const, title: "Sparse attention", author: [{ family: "Smith", given: "Jane" }], issued: { "date-parts": [[2020]] as Array<[number]> }, "container-title": "Journal of Tests", volume: "4" } } };
const doe = { op: "add" as const, entry: { key: "doe2019", csl: { type: "book" as const, title: "A book", author: [{ family: "Doe", given: "John" }], issued: { "date-parts": [[2019]] as Array<[number]> }, publisher: "Press" } } };

function plan(overrides: Partial<TetherPlanInput> & Pick<TetherPlanInput, "library" | "fileText">) {
  return planTetherSync({ base: null, dialect: "bibtex", now: T1, fileModifiedAt: T1, prefer: "library", newId, ...overrides });
}

/** Sync once from nothing and return the settled state. */
function settle(lib: ReferenceLibrary, fileText = "") {
  const first = plan({ library: lib, fileText });
  return { library: { ...first.library, revision: lib.revision + (first.ops.length ? 1 : 0) }, file: first.fileText ?? fileText, base: first.base };
}

const entryByKey = (lib: ReferenceLibrary, key: string) => Object.values(lib.entries).find((entry) => entry.key === key);

test("the first sync writes the library into an empty file, and a second sync changes nothing", () => {
  const lib = library([smith, doe]);
  const first = plan({ library: lib, fileText: "" });
  assert.equal(first.ops.length, 0);
  assert.ok(first.fileText);
  assert.match(first.fileText!, /^@book\{doe2019,[\s\S]*@article\{smith2020,/);
  assert.deepEqual(first.summary.file.added.sort(), ["doe2019", "smith2020"]);
  assert.equal(Object.keys(first.base).length, 2);
  const second = plan({ library: lib, fileText: first.fileText!, base: first.base });
  assert.equal(second.fileText, null);
  assert.equal(second.ops.length, 0);
});

test("the first sync imports entries only in the file and merges both", () => {
  const lib = library([smith]);
  const fileText = "% my refs\n@string{jt = {Journal of Tests}}\n\n@book{doe2019,\n  author = {Doe, John},\n  title = {A book},\n  year = 2019,\n  publisher = {Press},\n  owner = {jd},\n}\n";
  const result = plan({ library: lib, fileText });
  assert.deepEqual(result.summary.library.added, ["doe2019"]);
  assert.deepEqual(result.summary.file.added, ["smith2020"]);
  assert.ok(result.fileText!.startsWith(fileText.trimEnd()), "the user's text is kept as it was");
  assert.ok(entryByKey(result.library, "doe2019"));
  assert.equal(entryByKey(result.library, "doe2019")!.status, "confirmed");
});

test("a field edited in the file reaches the library; the rest of the file is untouched", () => {
  const state = settle(library([smith, doe]));
  const edited = state.file.replace("{Sparse attention}", "{Sparse attention revisited}");
  const result = plan({ library: state.library, fileText: edited, base: state.base, fileModifiedAt: T2 });
  assert.equal(result.fileText, null, "nothing to write back");
  assert.equal(entryByKey(result.library, "smith2020")!.csl.title, "Sparse attention revisited");
  assert.deepEqual(result.summary.library.updated, ["smith2020"]);
});

test("a field edited in the library rewrites only that entry, keeping fields Libera does not read", () => {
  const text = "@article{smith2020,\n  author = {Smith, Jane},\n  title = {Sparse attention},\n  journal = {Journal of Tests},\n  year = {2020},\n  volume = {4},\n  file = {:papers/smith.pdf:PDF},\n  mendeley-tags = {ml}\n}\n\n% keep me\n@book{doe2019,\n    author    = {Doe, John},\n    title     = {A book},\n    year      = {2019},\n    publisher = {Press}\n}\n";
  const lib = library([smith, doe]);
  const state = settle(lib, text);
  assert.equal(state.file, text, "already in agreement: no write");
  const id = entryByKey(state.library, "smith2020")!.id;
  const changed = apply(state.library, [{ op: "update", id, csl: { volume: "5" } }], T2);
  const result = plan({ library: changed, fileText: state.file, base: state.base, fileModifiedAt: T1, now: T2 });
  assert.ok(result.fileText);
  assert.match(result.fileText!, /volume\s*=\s*\{5\}/);
  assert.match(result.fileText!, /file = \{:papers\/smith\.pdf:PDF\}/);
  assert.match(result.fileText!, /mendeley-tags = \{ml\}/);
  assert.match(result.fileText!, /mendeley-tags = \{ml\}\n\}/, "no blank line before the closing brace");
  assert.ok(result.fileText!.endsWith("% keep me\n@book{doe2019,\n    author    = {Doe, John},\n    title     = {A book},\n    year      = {2019},\n    publisher = {Press}\n}\n"), "the other entry keeps its formatting");
  assert.equal(parseBibtex(result.fileText!).errors.length, 0);
});

test("line endings and a BOM are kept", () => {
  const state = settle(library([smith]));
  const crlf = `﻿${state.file.replace(/\n/g, "\r\n")}`;
  const id = entryByKey(state.library, "smith2020")!.id;
  const changed = apply(state.library, [{ op: "update", id, csl: { volume: "9" } }], T2);
  const result = plan({ library: changed, fileText: crlf, base: state.base, now: T2 });
  assert.ok(result.fileText!.startsWith("﻿@article"));
  assert.ok(!/[^\r]\n/.test(result.fileText!), "every line ends in CRLF");
});

test("a field changed on both sides: the newer edit wins and the other value is kept as an alternative", () => {
  const state = settle(library([smith]));
  const id = entryByKey(state.library, "smith2020")!.id;
  const changed = apply(state.library, [{ op: "update", id, csl: { volume: "7" } }], T1);
  const edited = state.file.replace("{4}", "{8}");
  const fileNewer = plan({ library: changed, fileText: edited, base: state.base, fileModifiedAt: T2, now: T2 });
  assert.equal(fileNewer.library.entries[id].csl.volume, "8");
  assert.deepEqual(fileNewer.summary.conflicts, [{ key: "smith2020", field: "volume", kept: "file" }]);
  assert.equal(fileNewer.library.entries[id].conflicts?.volume?.[0].value, "7");
  const libraryNewer = plan({ library: changed, fileText: edited, base: state.base, fileModifiedAt: T0, now: T2 });
  assert.equal(libraryNewer.library.entries[id].csl.volume, "7");
  assert.match(libraryNewer.fileText!, /volume\s*=\s*\{7\}/);
  assert.equal(libraryNewer.library.entries[id].conflicts?.volume?.[0].value, "8");
});

test("different fields changed on each side merge without a conflict", () => {
  const state = settle(library([smith]));
  const id = entryByKey(state.library, "smith2020")!.id;
  const changed = apply(state.library, [{ op: "update", id, csl: { volume: "7" } }], T1);
  const edited = state.file.replace("{Sparse attention}", "{Dense attention}");
  const result = plan({ library: changed, fileText: edited, base: state.base, fileModifiedAt: T2, now: T2 });
  assert.equal(result.summary.conflicts.length, 0);
  assert.equal(result.library.entries[id].csl.title, "Dense attention");
  assert.match(result.fileText!, /volume\s*=\s*\{7\}/);
  assert.match(result.fileText!, /Dense attention/);
});

test("deletions go both ways, and an edit wins over a delete", () => {
  const state = settle(library([smith, doe]));
  const smithId = entryByKey(state.library, "smith2020")!.id;
  const doeId = entryByKey(state.library, "doe2019")!.id;
  // Deleted in the library → removed from the file.
  const deleted = apply(state.library, [{ op: "delete", id: doeId }]);
  const removed = plan({ library: deleted, fileText: state.file, base: state.base });
  assert.doesNotMatch(removed.fileText!, /doe2019/);
  assert.deepEqual(removed.summary.file.deleted, ["doe2019"]);
  assert.ok(!removed.fileText!.includes("\n\n\n"));
  // Deleted in the file → removed from the library.
  const fileWithoutDoe = removed.fileText!;
  const fromFile = plan({ library: state.library, fileText: fileWithoutDoe, base: state.base });
  assert.equal(fromFile.library.entries[doeId], undefined);
  assert.deepEqual(fromFile.summary.library.deleted, ["doe2019"]);
  // Deleted in the file but edited in the library → kept and written back.
  const edited = apply(state.library, [{ op: "update", id: doeId, csl: { publisher: "Other Press" } }]);
  const kept = plan({ library: edited, fileText: fileWithoutDoe, base: state.base });
  assert.ok(kept.library.entries[doeId]);
  assert.match(kept.fileText!, /Other Press/);
  assert.deepEqual(kept.summary.kept, ["doe2019"]);
  // Deleted in the library but edited in the file → back in the library.
  const fileEdited = state.file.replace("{Press}", "{Third Press}");
  const back = plan({ library: deleted, fileText: fileEdited, base: state.base });
  assert.equal(back.library.entries[doeId]?.csl.publisher, "Third Press");
  assert.equal(back.fileText, null);
  assert.ok(smithId);
});

test("many deletions from the file wait for the user, then apply or restore", () => {
  const ops: ReferenceLibraryOp[] = [];
  for (let index = 0; index < 10; index += 1) ops.push({ op: "add", entry: { key: `k${index}`, csl: { type: "book", title: `Book ${index}` } } });
  const state = settle(library(ops));
  const kept = state.file.split("\n\n").slice(0, 3).join("\n\n") + "\n";
  assert.equal(parseBibtex(kept).entries.length, 3);
  const asked = plan({ library: state.library, fileText: kept, base: state.base });
  assert.equal(asked.pendingDeletion?.keys.length, 7);
  assert.ok(asked.pendingDeletion!.keys.length > DELETION_COUNT_LIMIT);
  assert.equal(asked.ops.length, 0);
  assert.equal(Object.keys(asked.base).length, 10, "the held entries stay in the base");
  const applied = plan({ library: state.library, fileText: kept, base: state.base, deletions: "apply" });
  assert.equal(Object.keys(applied.library.entries).length, 3);
  const restored = plan({ library: state.library, fileText: kept, base: state.base, deletions: "restore" });
  assert.equal(parseBibtex(restored.fileText!).entries.length, 10);
  // An emptied file always asks.
  const emptied = plan({ library: state.library, fileText: "", base: state.base });
  assert.equal(emptied.pendingDeletion?.keys.length, 10);
});

test("nothing is deleted while a block of the file does not parse", () => {
  const state = settle(library([smith, doe]));
  const broken = state.file.replace("@book{doe2019,", "@book{doe2019,\n  title = {unclosed,");
  const result = plan({ library: state.library, fileText: broken, base: state.base });
  assert.ok(Object.values(result.library.entries).some((entry) => entry.key === "doe2019"));
  assert.equal(result.summary.library.deleted.length, 0);
  assert.equal(result.fileText, null);
  assert.ok(result.warnings.some((warning) => warning.includes("could not be read")));
});

test("a key renamed in the file renames the entry; a key renamed in Libera renames the block", () => {
  const state = settle(library([smith, doe]));
  const id = entryByKey(state.library, "smith2020")!.id;
  const renamedInFile = plan({ library: state.library, fileText: state.file.replace("smith2020", "smithSparse"), base: state.base });
  assert.equal(renamedInFile.library.entries[id].key, "smithSparse");
  assert.deepEqual(renamedInFile.library.entries[id].aliases, ["smith2020"]);
  assert.equal(renamedInFile.fileText, null);
  const renamedInLibrary = apply(state.library, [{ op: "rename-key", id, key: "jane2020" }]);
  const result = plan({ library: renamedInLibrary, fileText: state.file, base: state.base });
  assert.match(result.fileText!, /@article\{jane2020,/);
  assert.equal(result.fileText!.replace("jane2020", "smith2020"), state.file, "only the key changed");
});

test("a new file entry whose key the library already uses for another work gets a new key", () => {
  const state = settle(library([smith]));
  const lib = apply(state.library, [{ op: "add", entry: { key: "lee2021", csl: { type: "book", title: "Gardening for beginners" } } }]);
  const file = `${state.file}\n@article{lee2021,\n  title = {Quantum chromodynamics on the lattice},\n  year = {2021}\n}\n`;
  const result = plan({ library: lib, fileText: file, base: state.base });
  const keys = Object.values(result.library.entries).map((entry) => entry.key).sort();
  assert.equal(keys.length, 3);
  assert.ok(keys.includes("lee2021"));
  const parsed = parseBibtex(result.fileText!);
  assert.equal(new Set(parsed.entries.map((entry) => entry.sourceKey.toLowerCase())).size, 3, "no duplicate keys in the file");
});

test("a sync after a sync is stable even when the file is formatted differently", () => {
  const text = "@ARTICLE{smith2020,\n\tAuthor = \"Smith, Jane\",\n\tTitle = \"{Sparse} attention\",\n\tJournal = jt,\n\tYear = 2020,\n\tVolume = 4\n}\n";
  const withMacro = `@string{jt = "Journal of Tests"}\n${text}`;
  const lib = library([]);
  const first = plan({ library: lib, fileText: withMacro, prefer: "file" });
  const afterFirst = { ...first.library, revision: 2 };
  assert.equal(first.fileText, null);
  const second = plan({ library: afterFirst, fileText: withMacro, base: first.base });
  assert.equal(second.ops.length, 0);
  assert.equal(second.fileText, null);
});

test("prefer decides differences on the first sync", () => {
  const lib = library([smith]);
  const file = "@article{smith2020,\n  author = {Smith, Jane},\n  title = {Sparse attention},\n  journal = {Journal of Tests},\n  year = {2020},\n  volume = {99}\n}\n";
  const libraryWins = plan({ library: lib, fileText: file, prefer: "library" });
  assert.match(libraryWins.fileText!, /volume\s*=\s*\{4\}/);
  assert.equal(libraryWins.summary.conflicts.length, 0, "a chosen side is not a conflict");
  const fileWins = plan({ library: lib, fileText: file, prefer: "file" });
  assert.equal(fileWins.fileText, null);
  assert.equal(entryByKey(fileWins.library, "smith2020")!.csl.volume, "99");
  void ({} as TetherBaseEntry);
});

test("restoring deleted entries preserves custom fields and expands macros that may have disappeared", () => {
  const text = '@string{owner = {Jane Doe}}\n@book{a, title={Alpha}, file={:alpha.pdf:PDF}, owner=owner}\n@book{b, title={Beta}, custom={keep}}\n';
  const state = settle(library([]), text);
  const restored = plan({ library: state.library, fileText: "", base: state.base, deletions: "restore" });
  assert.match(restored.fileText!, /file = \{:alpha\.pdf:PDF\}/);
  assert.match(restored.fileText!, /owner = \{Jane Doe\}/);
  assert.match(restored.fileText!, /custom = \{keep\}/);
  assert.deepEqual(parseBibtex(restored.fileText!).errors, []);
  const edited = apply(state.library, [{ op: "update", id: entryByKey(state.library, "a")!.id, csl: { title: "New alpha" } }]);
  const kept = plan({ library: edited, fileText: '@book{b, title={Beta}, custom={keep}}\n', base: state.base });
  assert.match(kept.fileText!, /New alpha/);
  assert.match(kept.fileText!, /alpha\.pdf/);
});

test("an edit only to a custom file field survives a library deletion", () => {
  const state = settle(library([]), '@book{a, title={Alpha}, owner={old}}\n');
  const id = entryByKey(state.library, "a")!.id;
  const deleted = apply(state.library, [{ op: "delete", id }]);
  const result = plan({ library: deleted, fileText: state.file.replace("{old}", "{new}"), base: state.base });
  assert.equal(result.library.entries[id].csl.title, "Alpha");
  assert.equal(result.fileText, null);
  assert.deepEqual(result.summary.kept, ["a"]);
});

test("rewrites keep unchanged macros, crossrefs, and parsed fields that CSL cannot represent", () => {
  const text = '@string{jt={Journal of Tests}}\n@book{parent, title={Proceedings}, year=2020}\n@inproceedings{child, title={A paper}, journal=jt, crossref={parent}, eprinttype={HAL}, eprint={hal-123}, volume=4}\n';
  const state = settle(library([]), text);
  const id = entryByKey(state.library, "child")!.id;
  const changed = apply(state.library, [{ op: "update", id, csl: { volume: "5", DOI: "10.1234/new" } }]);
  const result = plan({ library: changed, fileText: state.file, base: state.base });
  assert.match(result.fileText!, /journal=jt/);
  assert.match(result.fileText!, /crossref=\{parent\}/);
  assert.match(result.fileText!, /eprinttype=\{HAL\}/);
  assert.match(result.fileText!, /eprint=\{hal-123\}/);
  const macroEdit = plan({ library: result.library, base: result.base, fileText: result.fileText!.replace("Journal of Tests", "Changed journal") });
  assert.equal(macroEdit.library.entries[id].csl["container-title"], "Changed journal");
});

test("renaming or deleting a crossref parent in the library keeps the child usable", () => {
  const state = settle(library([]), '@book{parent, title={Old proceedings}, year=2020}\n@inproceedings{child, title={Paper}, crossref={parent}}\n');
  const parent = entryByKey(state.library, "parent")!;
  const child = entryByKey(state.library, "child")!;
  const renamed = apply(state.library, [{ op: "rename-key", id: parent.id, key: "newParent" }]);
  const result = plan({ library: renamed, fileText: state.file, base: state.base });
  assert.match(result.fileText!, /crossref = \{newParent\}/);
  assert.deepEqual(parseBibtex(result.fileText!).errors, []);
  const changed = apply(state.library, [{ op: "update", id: parent.id, csl: { title: "New proceedings" } }]);
  const inherited = plan({ library: changed, fileText: state.file, base: state.base });
  assert.equal(inherited.library.entries[child.id].csl["container-title"], "New proceedings");
  assert.equal(plan({ library: inherited.library, fileText: inherited.fileText!, base: inherited.base }).ops.length, 0);
  const deleted = apply(state.library, [{ op: "delete", id: parent.id }]);
  const detached = plan({ library: deleted, fileText: state.file, base: state.base });
  assert.doesNotMatch(detached.fileText!, /crossref/);
  assert.deepEqual(parseBibtex(detached.fileText!).errors, []);
  assert.equal(parseBibtex(detached.fileText!).entries[0].input.csl["container-title"], "Old proceedings");
});

test("swapped file keys do not exchange library identities or their metadata", () => {
  const state = settle(library([smith, doe]));
  const swapped = state.file.replace("smith2020", "temporary").replace("doe2019", "smith2020").replace("temporary", "doe2019");
  const result = plan({ library: state.library, fileText: swapped, base: state.base });
  assert.deepEqual(result.library.entries, state.library.entries);
  assert.equal(result.fileText, state.file);
  assert.equal(result.warnings.length, 2, "colliding keys are restored to their library owners");
});

test("a file can rename an entry back to its own alias, including a case-only correction", () => {
  const state = settle(library([smith]));
  const id = entryByKey(state.library, "smith2020")!.id;
  const renamed = apply(state.library, [{ op: "rename-key", id, key: "smithSparse" }]);
  const synced = plan({ library: renamed, fileText: state.file, base: state.base });
  const reverted = plan({ library: synced.library, fileText: synced.fileText!.replace("smithSparse", "SMITH2020"), base: synced.base });
  assert.equal(reverted.library.entries[id].key, "SMITH2020");
  assert.deepEqual(reverted.library.entries[id].aliases, ["smithSparse"]);
  assert.equal(reverted.fileText, null);
});

for (const [label, file] of [
  ["duplicate keys", '@book{a,title={Alpha}}\n@book{A,title={Other alpha}}\n'],
  ["invalid keys", '@book{a!,title={Alpha}}\n'],
  ["undefined macros", '@book{a,title=unknown}\n'],
  ["unresolved crossrefs", '@book{a,title={Alpha},crossref={missing}}\n'],
  ["unreadable blocks", '@book{a,title={Unclosed\n'],
] as const) {
  test(`${label} block synchronization without treating absence as a deletion`, () => {
    const state = settle(library([]), '@book{a,title={Alpha}}\n');
    const result = plan({ library: state.library, fileText: file, base: state.base });
    assert.equal(result.blocked, true);
    assert.equal(result.ops.length, 0);
    assert.equal(result.fileText, null);
    assert.deepEqual(result.base, state.base);
  });
}

test("emptying even a one-entry file asks before removing its only library entry", () => {
  const state = settle(library([smith]));
  const result = plan({ library: state.library, fileText: "", base: state.base });
  assert.deepEqual(result.pendingDeletion?.keys, ["smith2020"]);
  assert.equal(result.ops.length, 0);
});

test("projection caching does not hide two edits with an identical timestamp", () => {
  const state = settle(library([smith]));
  const id = entryByKey(state.library, "smith2020")!.id;
  const first = apply(state.library, [{ op: "update", id, csl: { volume: "10" } }], T1);
  const synced = plan({ library: first, fileText: state.file, base: state.base });
  const second = apply(first, [{ op: "update", id, csl: { volume: "11" } }], T1);
  const result = plan({ library: second, fileText: synced.fileText!, base: synced.base });
  assert.match(result.fileText!, /volume\s*=\s*\{11\}/);
});

test("a lossy file projection stays stable across repeated merges and unrelated edits", () => {
  const text = '@article{a,title={Article},entrysubtype={magazine},date={2020-05-04},volume=1}\n';
  const state = settle(library([]), text);
  const id = entryByKey(state.library, "a")!.id;
  let current = state.library;
  let base = state.base;
  let file = state.file;
  for (let index = 2; index < 6; index += 1) {
    const result = plan({ library: apply(current, [{ op: "update", id, csl: { volume: String(index) } }]), fileText: file, base });
    current = result.library;
    base = result.base;
    file = result.fileText ?? file;
    assert.equal(current.entries[id].csl.type, "article-magazine");
    assert.deepEqual(current.entries[id].csl.issued, { "date-parts": [[2020, 5, 4]] });
    const again = plan({ library: current, fileText: file, base });
    assert.equal(again.ops.length, 0);
    assert.equal(again.fileText, null);
  }
});

test("new entries do not reinterpret month macros redefined by the user's file", () => {
  const lib = library([{ op: "add", entry: { key: "a", csl: { type: "book", issued: { "date-parts": [[2020, 1]] } } } }]);
  const result = plan({ library: lib, fileText: '@string{jan={June}}\n' });
  assert.deepEqual(parseBibtex(result.fileText!).entries[0].input.csl.issued, { "date-parts": [[2020, 1]] });
});

test("library-only metadata edits win over a concurrent file deletion", () => {
  const state = settle(library([smith, doe]));
  const id = entryByKey(state.library, "smith2020")!.id;
  // These fields do not survive the BibTeX projection, and clocks may coincide.
  const changed = apply(state.library, [{ op: "update", id, notes: "New reading notes", reading: "read" }], T0);
  const onlyDoe = state.file.slice(0, state.file.indexOf("\n\n@article")) + "\n";
  const result = plan({ library: changed, fileText: onlyDoe, base: state.base });
  assert.equal(result.library.entries[id].notes, "New reading notes");
  assert.equal(result.library.entries[id].reading, "read");
  assert.match(result.fileText!, /smith2020/);
  assert.deepEqual(result.summary.kept, ["smith2020"]);
});

test("a rename plus metadata edit without an identifier asks before discarding the old entry's local data", () => {
  const initial = library([{ op: "add", entry: { key: "old", csl: { type: "book", title: "Old title" }, notes: "Keep these notes" } }]);
  const state = settle(initial);
  const result = plan({ library: state.library, fileText: '@book{new,title={New title}}\n', base: state.base });
  assert.deepEqual(result.pendingDeletion?.keys, ["old"]);
  assert.equal(entryByKey(result.library, "old")?.notes, "Keep these notes");
  // Importing the new entry, or a later unrelated change, cannot implicitly approve the held removal.
  const newEntry = entryByKey(result.library, "new")!;
  const changed = apply(result.library, [{ op: "update", id: newEntry.id, csl: { volume: "2" } }]);
  const again = plan({ library: changed, fileText: result.fileText ?? '@book{new,title={New title}}\n', base: result.base });
  assert.deepEqual(again.pendingDeletion?.keys, ["old"]);
  assert.equal(entryByKey(again.library, "old")?.notes, "Keep these notes");
});
