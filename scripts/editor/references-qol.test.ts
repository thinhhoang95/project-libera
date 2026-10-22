import assert from "node:assert/strict";
import test from "node:test";
import {
  changedTags,
  citationText,
  hasTag,
  libraryTags,
  sortEntries,
} from "../../src/components/libera/references/reference-display";
import { applyLibraryOps, emptyReferenceLibrary, LibraryOpError } from "../../src/lib/references/library-ops";
import { citationSnippets } from "../../src/lib/references/occurrences";
import type { CslItem, ReferenceEntry, ReferenceLibrary } from "../../src/lib/references/types";

const T0 = "2026-01-01T00:00:00.000Z";

function entry(id: string, key: string, extra: Partial<ReferenceEntry> = {}): ReferenceEntry {
  return {
    id,
    key,
    aliases: [],
    csl: { type: "article-journal", title: `Title ${key}`, author: [{ family: key }], issued: { "date-parts": [[2020]] } },
    identifiers: {},
    provenance: {},
    status: "confirmed",
    attachments: [],
    createdAt: T0,
    updatedAt: T0,
    fieldUpdatedAt: {},
    ...extra,
  };
}

test("citationSnippets finds each citation of a key or alias, with its line and the text around it", () => {
  const markdown = [
    "---",
    "title: Notes",
    "---",
    "Sparse codes are efficient [@smith2020; @lee2021, p. 4].",
    "",
    "Later, @smith2020 argues the opposite, and `[@smith2020]` in code is not a citation.",
    "",
    "Old key: [see @smith-old, ch. 2]. Unrelated [@lee2021].",
  ].join("\n");
  const snippets = citationSnippets(markdown, ["smith2020", "SMITH-old"]);
  assert.deepEqual(snippets.map((snippet) => snippet.match), ["[@smith2020; @lee2021, p. 4]", "@smith2020", "[see @smith-old, ch. 2]"]);
  assert.deepEqual(snippets.map((snippet) => snippet.line), [4, 6, 8]);
  assert.equal(markdown.slice(snippets[0].start, snippets[0].end), snippets[0].match);
  assert.equal(snippets[0].before, "Sparse codes are efficient ");
  assert.equal(snippets[1].after.startsWith(" argues the opposite"), true);
  // The context stops at a paragraph break.
  assert.equal(snippets[1].before, "Later, ");
  assert.deepEqual(citationSnippets(markdown, []), []);
});

test("citationSnippets shortens long context at a word", () => {
  const long = `${"word ".repeat(60)}[@k] ${"tail ".repeat(60)}`;
  const [snippet] = citationSnippets(long, ["k"], 30);
  assert.ok(snippet.before.startsWith("…"));
  assert.ok(snippet.before.length <= 32);
  assert.ok(snippet.after.endsWith("…"));
  assert.ok(!snippet.after.includes("tai…"), "cut at a word boundary");
});

test("libraryTags counts tags case-insensitively, most used first", () => {
  const entries = [
    entry("a", "a", { tags: ["Logic", "sets"] }),
    entry("b", "b", { tags: ["logic"] }),
    entry("c", "c", { tags: ["Sets", "  "] }),
    entry("d", "d", { tags: ["proofs"] }),
  ];
  assert.deepEqual(libraryTags(entries), [{ tag: "Logic", count: 2 }, { tag: "sets", count: 2 }, { tag: "proofs", count: 1 }]);
  assert.equal(hasTag(entries[1], "LOGIC"), true);
  assert.equal(hasTag(entries[3], "logic"), false);
});

test("changedTags adds and removes case-insensitively and reports no change as null", () => {
  const tagged = entry("a", "a", { tags: ["Logic", "sets"] });
  assert.deepEqual(changedTags(tagged, ["logic", "new"], []), ["Logic", "sets", "new"]);
  assert.deepEqual(changedTags(tagged, [], ["SETS"]), ["Logic"]);
  assert.equal(changedTags(tagged, ["logic"], []), null);
  assert.equal(changedTags(entry("b", "b"), [], ["x"]), null);
});

test("citationText writes one Pandoc or LaTeX citation for several keys", () => {
  assert.equal(citationText(["a"], "pandoc"), "[@a]");
  assert.equal(citationText(["a", "b"], "pandoc"), "[@a; @b]");
  assert.equal(citationText(["a", "b"], "latex"), "\\cite{a,b}");
});

test("the Recently cited sort puts the latest citing change first and uncited entries last", () => {
  const entries = [entry("a", "aaa"), entry("b", "bbb"), entry("c", "ccc")];
  const citedAt = new Map([["a", "2026-01-02T00:00:00.000Z"], ["c", "2026-03-01T00:00:00.000Z"]]);
  assert.deepEqual(sortEntries(entries, "cited", { citedAt }).map((item) => item.id), ["c", "a", "b"]);
  // Without the context it falls back to the author order.
  assert.deepEqual(sortEntries(entries, "cited").map((item) => item.id), ["a", "b", "c"]);
});

test("the reading flag is set, cleared, validated and kept by a merge", () => {
  const csl: CslItem = { type: "book", title: "A book", author: [{ family: "Smith" }], issued: { "date-parts": [[2020]] } };
  let library: ReferenceLibrary = applyLibraryOps(emptyReferenceLibrary(), [
    { op: "add", entry: { csl } },
    { op: "add", entry: { csl: { ...csl, title: "Another book" } } },
  ], T0).library;
  const [first, second] = Object.values(library.entries);
  library = applyLibraryOps(library, [{ op: "update", id: first.id, reading: "to-read" }], T0).library;
  assert.equal(library.entries[first.id].reading, "to-read");
  library = applyLibraryOps(library, [{ op: "update", id: first.id, reading: null }], T0).library;
  assert.equal("reading" in library.entries[first.id], false);
  assert.throws(() => applyLibraryOps(library, [{ op: "update", id: first.id, reading: "skimmed" as never }], T0), LibraryOpError);
  library = applyLibraryOps(library, [{ op: "update", id: second.id, reading: "read" }], T0).library;
  library = applyLibraryOps(library, [{ op: "merge", keepId: first.id, mergeIds: [second.id] }], T0).library;
  assert.equal(library.entries[first.id].reading, "read");
  // A whole entry with the flag can be put back (undo).
  const put = applyLibraryOps(library, [{ op: "put", entry: { ...library.entries[first.id], reading: "to-read" } }], T0).library;
  assert.equal(put.entries[first.id].reading, "to-read");
});
