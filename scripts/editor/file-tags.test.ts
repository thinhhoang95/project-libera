import assert from "node:assert/strict";
import test from "node:test";
import { completeTagQuery, fileKind, fileMatchesTags, parseTagQuery } from "../../src/components/libera/file-tags";
import { normalizeFileTags, normalizeWorkspaceMetadata } from "../../src/lib/storage/workspace-metadata";

test("tag queries split tag filters from the free-text search", () => {
  assert.deepEqual(parseTagQuery("intro tags:ml,phy"), { tags: ["ml", "phy"], text: "intro", partialTag: "phy" });
  assert.deepEqual(parseTagQuery("tag:\"deep learning\" paper"), { tags: ["deep learning"], text: "paper", partialTag: null });
  assert.deepEqual(parseTagQuery("plain"), { tags: [], text: "plain", partialTag: null });
});

test("tag filters match every wanted tag by case-insensitive prefix", () => {
  assert.equal(fileMatchesTags(["ML", "Physics"], ["ml", "phy"]), true);
  assert.equal(fileMatchesTags(["ML"], ["ml", "phy"]), false);
  assert.equal(fileMatchesTags(undefined, []), true);
});

test("completing a tag replaces only the tag being typed", () => {
  assert.equal(completeTagQuery("intro tags:ml,ph", "physics"), "intro tags:ml,physics ");
  assert.equal(completeTagQuery("tags:de", "deep learning"), "tags:\"deep learning\" ");
});

test("file kinds tell slide decks and bibliographies apart", () => {
  assert.equal(fileKind({ fileType: "markdown", name: "talk.slides.md" }), "slides");
  assert.equal(fileKind({ fileType: "markdown", name: "notes.md" }), "markdown");
  assert.equal(fileKind({ fileType: "latex", name: "refs.bib" }), "bibtex");
});

test("stored tags are trimmed, de-duplicated and empty lists dropped", () => {
  assert.deepEqual(normalizeFileTags([" ML ", "ml", "deep   learning", "", 3]), ["ML", "deep learning"]);
  assert.deepEqual(
    normalizeWorkspaceMetadata({ fileTags: { "a/b.md": ["x"], "a/c.md": [], "": ["y"] } }).fileTags,
    { "a/b.md": ["x"] },
  );
});
