import assert from "node:assert/strict";
import test from "node:test";
import { applyLibraryOps, emptyReferenceLibrary, LibraryOpError } from "../../src/lib/references/library-ops";
import type { FieldProvenance, ReferenceEntry, ReferenceLibrary, ReferenceLibraryOp } from "../../src/lib/references/types";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-02-01T00:00:00.000Z";
const T2 = "2026-03-01T00:00:00.000Z";
const crossref: FieldProvenance = { source: "crossref", confidence: 1, retrievedAt: T0 };

function apply(library: ReferenceLibrary, ops: ReferenceLibraryOp[], now = T1) {
  return applyLibraryOps(library, ops, now);
}

function only(library: ReferenceLibrary) {
  const entries = Object.values(library.entries);
  assert.equal(entries.length, 1);
  return entries[0];
}

function byKey(library: ReferenceLibrary, key: string) {
  const entry = Object.values(library.entries).find((candidate) => candidate.key === key);
  assert.ok(entry, `entry ${key} exists`);
  return entry;
}

const smith = { type: "article-journal", title: "Sparse coding of images", author: [{ family: "Smith", given: "Ann" }], issued: { "date-parts": [[2020]] } } as const;

function withSmith() {
  return apply(emptyReferenceLibrary(), [{ op: "add", entry: { csl: { ...smith }, provenance: { title: crossref } } }], T0).library;
}

test("the empty library is version 1 at revision 0 with the default style", () => {
  assert.deepEqual(emptyReferenceLibrary(), { version: 1, revision: 0, style: "apa", entries: {} });
});

test("add assigns an id, a generated key, clocks, a default status, and dedupes attachments", () => {
  const { library, changed } = apply(emptyReferenceLibrary(), [{
    op: "add",
    entry: {
      csl: { ...smith },
      provenance: { title: crossref },
      identifiers: { doi: "10.1/x" },
      attachments: [{ kind: "pdf", path: "Notes/a.pdf" }, { kind: "pdf", path: "Notes/a.pdf" }, { kind: "url", url: "https://example.com/a" }],
      tags: ["vision", "vision"],
      notes: "Read twice.",
    },
  }], T0);
  assert.equal(changed, true);
  assert.equal(library.revision, 0, "storage bumps the revision, not the pure ops");
  const entry = only(library);
  assert.match(entry.id, /^ref_[0-9a-f-]{36}$/);
  assert.equal(library.entries[entry.id], entry);
  assert.equal(entry.key, "smith2020sparse");
  assert.deepEqual(entry.aliases, []);
  assert.equal(entry.status, "needs-review");
  assert.equal(entry.createdAt, T0);
  assert.equal(entry.updatedAt, T0);
  assert.deepEqual(entry.fieldUpdatedAt, { type: T0, title: T0, author: T0, issued: T0 });
  assert.deepEqual(entry.attachments, [{ kind: "pdf", path: "Notes/a.pdf" }, { kind: "url", url: "https://example.com/a" }]);
  assert.deepEqual(entry.tags, ["vision"]);
  assert.deepEqual(entry.identifiers, { doi: "10.1/x" });
  assert.deepEqual(entry.provenance, { title: crossref });
});

test("add keeps a valid free key, and replaces taken or invalid ones (case-insensitive, aliases included)", () => {
  let library = withSmith();
  library = apply(library, [{ op: "add", entry: { key: "Custom:Key", csl: { type: "book", title: "A" } } }]).library;
  assert.ok(byKey(library, "Custom:Key"));
  library = apply(library, [{ op: "add", entry: { key: "SMITH2020SPARSE", csl: { ...smith } } }]).library;
  assert.ok(byKey(library, "smith2020sparsea"), "a taken key gets a suffix");
  library = apply(library, [{ op: "add", entry: { key: "has space", csl: { type: "book", title: "B" } } }]).library;
  assert.ok(byKey(library, "b"), "an invalid key is replaced by a generated one");
  const custom = byKey(library, "Custom:Key");
  library = apply(library, [{ op: "rename-key", id: custom.id, key: "renamed" }]).library;
  library = apply(library, [{ op: "add", entry: { key: "custom:key", csl: { type: "book", title: "Z" } } }]).library;
  assert.ok(!Object.values(library.entries).some((entry) => entry.key === "custom:key"), "aliases are taken too");
  // Several adds in one batch see each other.
  const batch = apply(emptyReferenceLibrary(), [{ op: "add", entry: { csl: { ...smith } } }, { op: "add", entry: { csl: { ...smith } } }]).library;
  assert.deepEqual(Object.values(batch.entries).map((entry) => entry.key).sort(), ["smith2020sparse", "smith2020sparsea"]);
});

test("validation rejects bad shapes with readable messages", () => {
  const library = withSmith();
  const id = only(library).id;
  const cases: [ReferenceLibraryOp, RegExp][] = [
    [{ op: "add", entry: { csl: { type: "nonsense" } } } as unknown as ReferenceLibraryOp, /Unknown reference type/],
    [{ op: "add", entry: { csl: { title: "No type" } } } as unknown as ReferenceLibraryOp, /type is required/],
    [{ op: "add", entry: { csl: { type: "book", title: 42 } } } as unknown as ReferenceLibraryOp, /“title” must be text/],
    [{ op: "add", entry: { csl: { type: "book", author: "Smith" } } } as unknown as ReferenceLibraryOp, /list of names/],
    [{ op: "add", entry: { csl: { type: "book", issued: { "date-parts": [["2020"]] } } } } as unknown as ReferenceLibraryOp, /date parts/],
    [{ op: "add", entry: { csl: { type: "book" }, attachments: [{ kind: "pdf", path: "../escape.pdf" }] } }, /inside the library/],
    [{ op: "add", entry: { csl: { type: "book" }, attachments: [{ kind: "pdf", path: "/etc/a.pdf" }] } }, /inside the library/],
    [{ op: "add", entry: { csl: { type: "book" }, attachments: [{ kind: "pdf", path: "C:/a.pdf" }] } }, /inside the library/],
    [{ op: "add", entry: { csl: { type: "book" }, attachments: [{ kind: "zip", path: "a.zip" }] } } as unknown as ReferenceLibraryOp, /Unknown attachment kind/],
    [{ op: "add", entry: { csl: { type: "book" }, attachments: [{ kind: "url", url: "javascript:alert(1)" }] } }, /http/],
    [{ op: "add", entry: { csl: { type: "book" }, status: "maybe" } } as unknown as ReferenceLibraryOp, /Unknown reference status/],
    [{ op: "add", entry: { csl: { type: "book" }, provenance: { title: { source: "guess", confidence: 1, retrievedAt: T0 } } } } as unknown as ReferenceLibraryOp, /unknown source/],
    [{ op: "add", entry: { csl: { type: "book" }, provenance: { title: { source: "llm-web", confidence: 0.5, retrievedAt: T0 } } } }, /web page/],
    [{ op: "update", id: "ref_missing", csl: { title: "x" } }, /no longer in the library/],
    [{ op: "update", id, removeFields: ["type"] }, /type cannot be removed/],
    [{ op: "set-style", style: "made-up" }, /neither a bundled style/],
    [{ op: "set-style", style: "../styles/x.csl" }, /neither a bundled style/],
    [{ op: "set-settings", settings: { autoCreateForPdfs: "yes" } } as unknown as ReferenceLibraryOp, /true or false/],
    [{ op: "frobnicate" } as unknown as ReferenceLibraryOp, /Unknown library change/],
  ];
  for (const [op, message] of cases) {
    assert.throws(() => apply(library, [op]), (error: unknown) => error instanceof LibraryOpError && message.test(error.message), JSON.stringify(op));
  }
});

test("ops apply atomically: one invalid op leaves the input untouched", () => {
  const library = withSmith();
  const before = structuredClone(library);
  const id = only(library).id;
  assert.throws(() => apply(library, [
    { op: "update", id, csl: { title: "Changed" } },
    { op: "add", entry: { csl: { type: "book" } } },
    { op: "delete", id: "ref_unknown" },
  ]), LibraryOpError);
  assert.deepEqual(library, before);
});

test("update merges fields, removes null/undefined and removeFields with their provenance, and bumps clocks", () => {
  const library = withSmith();
  const id = only(library).id;
  const { library: next, changed } = apply(library, [{
    op: "update", id,
    csl: { title: "Sparse coding", page: "1-10", issued: undefined, author: null as never },
    removeFields: ["page"],
    provenance: { page: crossref },
  }], T2);
  assert.equal(changed, true);
  const entry = next.entries[id];
  assert.deepEqual(Object.keys(entry.csl).sort(), ["title", "type"]);
  assert.equal(entry.csl.title, "Sparse coding");
  assert.deepEqual(entry.provenance.title, crossref, "untouched provenance stays");
  assert.equal(entry.provenance.page, undefined, "provenance is not kept for a removed field");
  assert.equal(entry.fieldUpdatedAt.title, T2);
  assert.equal(entry.fieldUpdatedAt.issued, T2);
  assert.equal(entry.fieldUpdatedAt.type, T0);
  assert.equal(entry.updatedAt, T2);

  const removed = apply(next, [{ op: "update", id, removeFields: ["title"] }], T2).library.entries[id];
  assert.equal(removed.provenance.title, undefined, "removing a field removes its provenance");

  const replaced = apply(library, [{
    op: "update", id, identifiers: { doi: "10.2/y" }, status: "confirmed", notes: "n", tags: ["a"],
    versions: [{ relation: "preprint-of", identifier: "arXiv:1" }],
    retraction: { state: "none", checkedAt: T1 },
    provenance: { title: null as never, author: crossref },
  }]).library.entries[id];
  assert.deepEqual(replaced.identifiers, { doi: "10.2/y" });
  assert.equal(replaced.status, "confirmed");
  assert.equal(replaced.notes, "n");
  assert.deepEqual(replaced.tags, ["a"]);
  assert.deepEqual(replaced.versions, [{ relation: "preprint-of", identifier: "arXiv:1" }]);
  assert.deepEqual(replaced.retraction, { state: "none", checkedAt: T1 });
  assert.deepEqual(replaced.provenance, { author: crossref });
});

test("changed is false when nothing changes", () => {
  const library = withSmith();
  const entry = only(library);
  const result = apply(library, [
    { op: "update", id: entry.id, csl: { title: smith.title, author: [{ given: "Ann", family: "Smith" }] }, status: "needs-review" },
    { op: "rename-key", id: entry.id, key: entry.key },
    { op: "detach", id: entry.id, attachment: { kind: "pdf", path: "None/x.pdf" } },
    { op: "set-style", style: "apa" },
  ], T2);
  assert.equal(result.changed, false);
  assert.equal(result.library, library);
  assert.equal(only(result.library).updatedAt, T0);
});

test("rename-key keeps the old key as an alias, checks uniqueness, and can return to an alias", () => {
  let library = apply(withSmith(), [{ op: "add", entry: { key: "other", csl: { type: "book", title: "O" } } }]).library;
  const entry = byKey(library, "smith2020sparse");
  assert.throws(() => apply(library, [{ op: "rename-key", id: entry.id, key: "OTHER" }]), /already used/);
  assert.throws(() => apply(library, [{ op: "rename-key", id: entry.id, key: "bad key" }]), /not valid/);
  library = apply(library, [{ op: "rename-key", id: entry.id, key: "smith-sparse" }], T2).library;
  assert.deepEqual(library.entries[entry.id].aliases, ["smith2020sparse"]);
  assert.equal(library.entries[entry.id].updatedAt, T2);
  library = apply(library, [{ op: "rename-key", id: entry.id, key: "smith2020sparse" }]).library;
  assert.equal(library.entries[entry.id].key, "smith2020sparse");
  assert.deepEqual(library.entries[entry.id].aliases, ["smith-sparse"], "returning to an alias removes it from the aliases");
  library = apply(library, [{ op: "rename-key", id: entry.id, key: "Smith2020Sparse" }]).library;
  assert.deepEqual(library.entries[entry.id].aliases, ["smith-sparse"], "a change of case only is not an alias");
  const other = byKey(library, "other");
  assert.throws(() => apply(library, [{ op: "rename-key", id: other.id, key: "smith-sparse" }]), /already used/, "another entry's alias is taken");
});

test("delete removes the entry; unknown ids are errors", () => {
  const library = withSmith();
  const { library: next, changed } = apply(library, [{ op: "delete", id: only(library).id }]);
  assert.equal(changed, true);
  assert.deepEqual(next.entries, {});
  assert.throws(() => apply(next, [{ op: "delete", id: "ref_x" }]), LibraryOpError);
  assert.throws(() => apply(next, [{ op: "delete", id: "__proto__" }]), LibraryOpError);
});

test("merge keeps the key, collects keys as aliases, fills missing data in order and removes the merged entries", () => {
  const pdfProvenance: FieldProvenance = { source: "pdf-text", confidence: 0.4, retrievedAt: T0 };
  let library = apply(emptyReferenceLibrary(), [
    { op: "add", entry: { key: "keep", csl: { type: "article-journal", title: "Kept title" }, identifiers: { doi: "10.1/keep" }, attachments: [{ kind: "pdf", path: "N/a.pdf" }], tags: ["x"], notes: "First." } },
    { op: "add", entry: { key: "dup1", csl: { type: "book", title: "Other title", page: "5", volume: "2" }, provenance: { page: pdfProvenance }, identifiers: { doi: "10.1/other", arxiv: "2101.00001", isbn: ["9780000000001"] }, attachments: [{ kind: "pdf", path: "N/a.pdf" }, { kind: "url", url: "https://x.org" }], tags: ["x", "y"], notes: "Second.", status: "confirmed", versions: [{ relation: "published-as", identifier: "10.1/v" }] } },
    { op: "add", entry: { key: "dup2", csl: { type: "book", volume: "9", issue: "3" }, tags: ["z"] } },
  ], T0).library;
  const dup1 = byKey(library, "dup1");
  library = apply(library, [{ op: "rename-key", id: dup1.id, key: "dup1b" }]).library;
  const keep = byKey(library, "keep");
  const dup2 = byKey(library, "dup2");
  assert.throws(() => apply(library, [{ op: "merge", keepId: keep.id, mergeIds: [keep.id] }]), /into itself/);
  assert.throws(() => apply(library, [{ op: "merge", keepId: keep.id, mergeIds: ["ref_nope"] }]), /no longer/);
  assert.throws(() => apply(library, [{ op: "merge", keepId: keep.id, mergeIds: [] }]), /at least one/);

  const merged = apply(library, [{ op: "merge", keepId: keep.id, mergeIds: [dup1.id, dup2.id] }], T2).library;
  assert.deepEqual(Object.keys(merged.entries), [keep.id]);
  const entry = merged.entries[keep.id];
  assert.equal(entry.key, "keep");
  assert.deepEqual(entry.aliases, ["dup1b", "dup1", "dup2"]);
  assert.equal(entry.csl.type, "article-journal");
  assert.equal(entry.csl.title, "Kept title");
  assert.equal(entry.csl.page, "5");
  assert.equal(entry.csl.volume, "2", "the first merged entry wins");
  assert.equal(entry.csl.issue, "3");
  assert.deepEqual(entry.provenance.page, pdfProvenance);
  assert.equal(entry.fieldUpdatedAt.page, T0);
  assert.deepEqual(entry.identifiers, { doi: "10.1/keep", arxiv: "2101.00001", isbn: ["9780000000001"] });
  assert.deepEqual(entry.attachments, [{ kind: "pdf", path: "N/a.pdf" }, { kind: "url", url: "https://x.org" }]);
  assert.deepEqual(entry.tags, ["x", "y", "z"]);
  assert.deepEqual(entry.versions, [{ relation: "published-as", identifier: "10.1/v" }]);
  assert.equal(entry.notes, "First.\n\nSecond.");
  assert.equal(entry.status, "confirmed");
  assert.equal(entry.updatedAt, T2);

  const unconfirmed = apply(library, [{ op: "merge", keepId: keep.id, mergeIds: [dup2.id] }]).library.entries[keep.id];
  assert.equal(unconfirmed.status, "needs-review");
});

test("attach and detach dedupe by path or url", () => {
  let library = withSmith();
  const id = only(library).id;
  library = apply(library, [
    { op: "attach", id, attachment: { kind: "pdf", path: "N/a.pdf" } },
    { op: "attach", id, attachment: { kind: "pdf", path: "N/a.pdf", sha256: "a".repeat(64), size: 3 } },
    { op: "attach", id, attachment: { kind: "url", url: "https://a.org" } },
    { op: "attach", id, attachment: { kind: "url", url: "https://a.org" } },
  ]).library;
  assert.deepEqual(library.entries[id].attachments, [{ kind: "pdf", path: "N/a.pdf", sha256: "a".repeat(64), size: 3 }, { kind: "url", url: "https://a.org" }]);
  assert.equal(apply(library, [{ op: "attach", id, attachment: { kind: "url", url: "https://a.org" } }]).changed, false);
  library = apply(library, [{ op: "detach", id, attachment: { kind: "pdf", path: "N/a.pdf" } }]).library;
  assert.deepEqual(library.entries[id].attachments, [{ kind: "url", url: "https://a.org" }]);
  assert.throws(() => apply(library, [{ op: "attach", id, attachment: { kind: "pdf", path: "N/a.pdf", sha256: "nothex" } }]), /hash/);
});

test("set-style accepts bundled ids and library .csl paths; set-settings merges", () => {
  let library = emptyReferenceLibrary();
  library = apply(library, [{ op: "set-style", style: "ieee" }]).library;
  assert.equal(library.style, "ieee");
  library = apply(library, [{ op: "set-style", style: "Notes/styles/custom.csl" }]).library;
  assert.equal(library.style, "Notes/styles/custom.csl");
  library = apply(library, [{ op: "set-settings", settings: { autoCreateForPdfs: true } }]).library;
  assert.deepEqual(library.settings, { autoCreateForPdfs: true });
  assert.equal(apply(library, [{ op: "set-settings", settings: { autoCreateForPdfs: true } }]).changed, false);
  assert.throws(() => apply(library, [{ op: "set-settings", settings: { other: true } } as unknown as ReferenceLibraryOp]), /Unknown library setting/);
});

test("put inserts or replaces a whole entry by id, keeping its timestamps, and checks keys against other entries", () => {
  const library = apply(withSmith(), [{ op: "add", entry: { key: "other", csl: { type: "book", title: "O" } } }]).library;
  const original = structuredClone(byKey(library, "smith2020sparse"));
  const other = byKey(library, "other");
  // Undo of a delete: the entry comes back as it was.
  const deleted = apply(library, [{ op: "delete", id: original.id }]).library;
  const restored = apply(deleted, [{ op: "put", entry: original }], T2).library;
  assert.deepEqual(restored.entries[original.id], original);
  assert.equal(restored.entries[original.id].updatedAt, T0, "timestamps are kept as given");
  // Undo of an update: the entry is replaced, its own key and aliases do not count as taken.
  const edited = apply(library, [{ op: "update", id: original.id, csl: { title: "New" } }, { op: "rename-key", id: original.id, key: "renamed" }]).library;
  const undone = apply(edited, [{ op: "put", entry: original }]).library;
  assert.deepEqual(undone.entries[original.id], original);
  assert.equal(apply(library, [{ op: "put", entry: original }]).changed, false);

  const clash = (patch: Partial<ReferenceEntry>) => apply(library, [{ op: "put", entry: { ...original, ...patch } }]);
  assert.throws(() => clash({ key: "OTHER" }), /already used/);
  assert.throws(() => clash({ aliases: ["other"] }), /already used/);
  assert.throws(() => clash({ id: "ref_new" }), /already used/, "a new id with an existing entry's key collides");
  assert.throws(() => clash({ key: "bad key" }), /not valid/);
  assert.throws(() => clash({ aliases: ["smith2020sparse"] }), /same key twice/);
  assert.throws(() => clash({ csl: { type: "nope" } as never }), /Unknown reference type/);
  assert.throws(() => clash({ attachments: [{ kind: "pdf", path: "../x.pdf" }] }), /inside the library/);
  assert.throws(() => clash({ createdAt: "yesterday" }), /not a valid date/);
  assert.throws(() => clash({ fieldUpdatedAt: { title: 5 } as never }), /Clock/);
  assert.throws(() => clash({ id: "" }), /id is required/);
  assert.throws(() => clash({ status: "done" as never }), /status/);
  assert.equal(other.key, "other");
});
