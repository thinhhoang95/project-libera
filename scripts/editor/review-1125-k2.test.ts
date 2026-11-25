import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { moveFileToDirectory } from "../../src/lib/storage/files";
import { markdownPathOccurrences, rewriteMovedPaths, writeDestinationPath } from "../../src/lib/move-rewrites";
import { destinationRange } from "../../src/lib/markdown-image-sources";
import { copyMarkdownImageAssets } from "../../src/lib/storage/markdown-assets";
import { addReviewThreads, findReview, rewriteReviewSnapshots } from "../../src/lib/storage/markdown-reviews";
import { listPendingReviews, withReviewWrite } from "../../src/lib/agent/review-store";
import { RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { rewriteCitationKeys } from "../../src/lib/references/citation-syntax";
import { markdownAssetPath } from "../../src/lib/storage/paths";
import { assertNotebookSound, splitLibraryPath, withTemporaryLibrary, writeLibraryFile } from "./notebook-test-helpers";
import { filePathFromParts } from "../../src/lib/storage/paths";

// Review 2026-11-25, package K2: Markdown, chart and image rewrites on move, and
// the notebook check's parity with them (R-H6, R-H7, R-M1, R-M2, R-M4).

const disk = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return filePathFromParts(notebook, parts); };
const read = (relative: string) => readFile(disk(relative), "utf8");
const folder = (relative: string) => mkdir(disk(relative), { recursive: true });

test("R-H6: a chart's data file is found in every YAML form the check accepts, and a comment is never rewritten for the key", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/docs/data.csv", "a,b\n1,2\n");
  await folder("Nb/b");
  const note = [
    "# Charts", "",
    "```chart", "  type: bar", "  data: docs/data.csv", "```", "",
    "```chart", "type: bar", "'data': docs/data.csv", "```", "",
    "```chart", "type: bar", "\"data\":\n  \"docs/data.csv\"", "```", "",
    "```chart", "type: bar", "data:\n  docs/data.csv", "```", "",
    "```chart", "# \"data\": \"docs/data.csv\"", "type: bar", "data: docs/data.csv # the file", "```", "",
    "```chart", "{\"type\": \"bar\", \"data\": \"docs/data.csv\"}", "```", "",
  ].join("\n");
  await writeLibraryFile("Nb/stay.md", note);
  await moveFileToDirectory("Nb/docs/data.csv", "Nb/b");
  const now = await read("Nb/stay.md");
  assert.ok(!/docs\/data\.csv\s*$/m.test(now.replace('# "data": "docs/data.csv"', "")), now);
  assert.ok(now.includes('# "data": "docs/data.csv"'), "the comment is left as it was");
  assert.equal(now.match(/b\/data\.csv/g)?.length, 6);
  await assertNotebookSound("Nb");
}));

test("R-H6: a single-quoted chart value with an escaped apostrophe is found by the move's pre-filter", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/docs/don't.csv", "a,b\n1,2\n");
  await folder("Nb/b");
  await writeLibraryFile("Nb/stay.md", "```chart\ntype: bar\ndata: 'docs/don''t.csv'\n```\n");
  await moveFileToDirectory("Nb/docs/don't.csv", "Nb/b");
  assert.equal(await read("Nb/stay.md"), "```chart\ntype: bar\ndata: 'b/don''t.csv'\n```\n");
  await assertNotebookSound("Nb");
}));

test("R-H7: a code span with a bracket in an image's alt text does not end the alt text", () => withTemporaryLibrary(["Nb"], async () => {
  for (const [markdown, alt] of [["![see `]` here](/api/files/raw/Nb/docs/img.png)", "see `]` here"], ["![a `[` b](/api/files/raw/Nb/docs/img.png)", "a `[` b"]] as const) {
    const range = destinationRange(markdown, false);
    assert.equal(markdown.slice(range.start, range.end), "/api/files/raw/Nb/docs/img.png", alt);
  }
  await writeLibraryFile("Nb/docs/img.png", Buffer.from("png-bytes"));
  await folder("Nb/b");
  await writeLibraryFile("Nb/stay.md", "![see `]` here](/api/files/raw/Nb/docs/img.png)\n\n![a `[` b](/api/files/raw/Nb/docs/img.png)\n");
  await moveFileToDirectory("Nb/docs/img.png", "Nb/b");
  assert.equal(await read("Nb/stay.md"), "![see `]` here](/api/files/raw/Nb/b/img.png)\n\n![a `[` b](/api/files/raw/Nb/b/img.png)\n");
  await assertNotebookSound("Nb");
}));

test("R-M1: an angle-bracket destination with whitespace and `&` is rewritten", () => withTemporaryLibrary(["Nb"], async () => {
  assert.deepEqual(writeDestinationPath("old/R&D notes.md", "old/R&D notes.md", "new/R&D notes.md", false), { written: "new/R\\&D notes.md", value: "new/R&D notes.md" });
  await writeLibraryFile("Nb/docs/R&D notes.md", "# R&D\n");
  await folder("Nb/b");
  await writeLibraryFile("Nb/stay.md", "[doc](<docs/R&D notes.md>)\n");
  const moved = await moveFileToDirectory("Nb/docs/R&D notes.md", "Nb/b");
  assert.deepEqual(moved.links?.skipped, []);
  assert.equal(await read("Nb/stay.md"), "[doc](<b/R\\&D notes.md>)\n");
  await assertNotebookSound("Nb");
}));

test("R-M2: the check reads HTML links and raw-address links; footnote text and inline code hold no paths", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/docs/target.md", "# Target\n");
  await folder("Nb/b");
  const note = [
    "# Stay", "",
    "<a href=\"docs/target.md\">html</a> and [raw](/api/files/raw/Nb/docs/target.md)", "",
    "Footnote[^1].", "", "[^1]: docs/target.md", "",
    "Inline <code><a href=\"docs/target.md\">code</a></code> stays.", "",
  ].join("\n");
  await writeLibraryFile("Nb/stay.md", note);
  assert.deepEqual(markdownPathOccurrences(note).map((occurrence) => [occurrence.kind, occurrence.value]), [["html-link", "docs/target.md"], ["link", "/api/files/raw/Nb/docs/target.md"]]);
  await assertNotebookSound("Nb");
  // The target is deleted behind the app's back: both live links are reported, and only they.
  await writeLibraryFile("Nb/docs/other.md", "# Other\n");
  const { rm } = await import("node:fs/promises");
  await rm(disk("Nb/docs/target.md"));
  const { verifyNotebook } = await import("../../src/lib/storage/integrity");
  const report = await verifyNotebook("Nb");
  const messages = report.findings.filter((finding) => finding.check === "links").map((finding) => finding.message).sort();
  assert.deepEqual(messages, ['The link "/api/files/raw/Nb/docs/target.md" finds no file.', 'The link "docs/target.md" finds no file.']);
  // A move follows both and leaves the footnote's text and the inline code alone.
  await writeLibraryFile("Nb/docs/target.md", "# Target\n");
  await moveFileToDirectory("Nb/docs/target.md", "Nb/b");
  assert.equal(await read("Nb/stay.md"), note.replace("<a href=\"docs/target.md\">html", "<a href=\"b/target.md\">html").replace("/api/files/raw/Nb/docs/target.md", "/api/files/raw/Nb/b/target.md"));
  await assertNotebookSound("Nb");
}));

test("R-M2: a note's own raw `_assets` image is read by the check", () => withTemporaryLibrary(["Nb"], async () => {
  const asset = markdownAssetPath("Nb", "_assets/stay/photo.png").targetPath;
  await mkdir(path.dirname(asset), { recursive: true });
  await writeFile(asset, "photo-bytes");
  await writeLibraryFile("Nb/stay.md", "![photo](/api/files/raw/Nb/_assets/stay/photo.png)\n");
  await assertNotebookSound("Nb");
}));

test("R-M4: the move's rewrite order is images, links, citations: the two rewrites do not depend on it", () => {
  const note = "[@old] and [a](docs/a.md) and [b](<docs/a b.md>) and @old [^n]\n\n[^n]: [@old](docs/a.md)\n";
  const paths = { link: { "docs/a.md": "z/a.md", "docs/a b.md": "z/a b.md" } };
  const keys = new Map([["old", "new"]]);
  const linksThenCitations = rewriteCitationKeys(rewriteMovedPaths(note, "Nb/n.md", paths), keys).text;
  const citationsThenLinks = rewriteMovedPaths(rewriteCitationKeys(note, keys).text, "Nb/n.md", paths);
  assert.equal(citationsThenLinks, linksThenCitations);
  assert.ok(linksThenCitations.includes("[@new]") && linksThenCitations.includes("(z/a.md)"));
});

test("R-M4: review comments follow a rewrite of a note whose snapshot an earlier step of the move already changed", () => withTemporaryLibrary(["Nb"], async () => {
  const original = "Intro ![x](a.png) and more.\n";
  const afterImages = "Intro ![x](b.png) and more.\n";
  const afterLinks = "Intro ![x](b.png) and more. [t](new.md)\n";
  await writeLibraryFile("Nb/n.md", afterImages);
  const start = original.indexOf("and more");
  // The review was taken of the text before the move's own image rewrite.
  await addReviewThreads("Nb/n.md", original, [{ range: { start, end: start + 8 }, text: "Say more" }]);
  const at = afterImages.indexOf("more.") + 5;
  await rewriteReviewSnapshots([{ path: "Nb/n.md", before: afterImages, edits: [{ start: at, end: at, text: " [t](new.md)" }] }]);
  const review = await findReview("Nb/n.md");
  assert.equal(review?.snapshot, afterLinks);
  const anchor = review!.threads[0].anchor;
  assert.equal(afterLinks.slice(anchor.start, anchor.end), "and more");
}));

test("R-M4: a pending agent review and an undo original keep the rewrite for a link the agent removed", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/docs/target.md", "# Target\n");
  await folder("Nb/b");
  const before = "Keep [a](docs/target.md) and [b](docs/target.md?x=1) here.\n";
  const after = "Keep [a](docs/target.md) and here.\n";
  await writeLibraryFile("Nb/stay.md", before);
  const snapshots = new RunSnapshots("run-k2-0001");
  await snapshots.recordOriginal("Nb/stay.md", before);
  await withReviewWrite("Nb/stay.md", before, "run-k2-0001", async () => { await writeLibraryFile("Nb/stay.md", after); });
  await snapshots.recordWritten("Nb/stay.md", after);
  await moveFileToDirectory("Nb/docs/target.md", "Nb/b");
  assert.equal(await read("Nb/stay.md"), "Keep [a](b/target.md) and here.\n");
  const [pending] = await listPendingReviews();
  assert.equal(pending.baseline, "Keep [a](b/target.md) and [b](b/target.md?x=1) here.\n");
  const [result] = await undoRun("run-k2-0001");
  assert.equal(result.status, "restored");
  assert.equal(await read("Nb/stay.md"), "Keep [a](b/target.md) and [b](b/target.md?x=1) here.\n");
  await assertNotebookSound("Nb");
}));

test("R-M4: copying a note's images keeps what an address asks of its image and never throws on a malformed one", () => withTemporaryLibrary(["Nb", "Dst"], async () => {
  await writeLibraryFile("Nb/docs/img.png", Buffer.from("png-bytes"));
  const markdown = "![a](/api/files/raw/Nb/docs/img.png?v=2#top) ![b](/api/files/raw/Nb/docs/%ZZ.png)\n";
  const copy = await copyMarkdownImageAssets("Nb/n.md", "Dst/n.md", markdown);
  try {
    const source = "/api/files/raw/Nb/docs/img.png?v=2#top";
    assert.ok(copy.imageSources[source]?.endsWith("?v=2#top"), JSON.stringify(copy.imageSources));
    assert.equal(copy.imageSources["/api/files/raw/Nb/docs/%ZZ.png"], undefined);
    assert.ok(copy.content.includes("/api/files/raw/Nb/docs/%ZZ.png"));
  } finally { await copy.discard(); }
}));
