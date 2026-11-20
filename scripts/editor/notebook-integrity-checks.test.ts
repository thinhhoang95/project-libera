import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createMarkdownFileLinkDestination } from "../../src/lib/markdown-file-links";
import { extractMarkdownLinkOccurrences, markdownHtmlAnchors } from "../../src/lib/markdown-link-occurrences";
import { verifyNotebook, type IntegrityReport } from "../../src/lib/storage/integrity";
import { legacyReviewDatabasePath, reviewsDirectory } from "../../src/lib/storage/review-files";
import { audioPeaksPath, filePathFromParts, legacyFlatPdfAnnotationsPath, getStateRoot, pdfAnnotationsPath, transcriptPath } from "../../src/lib/storage/paths";
import { withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// The check functions of storage/integrity.ts that read records and links: review documents, annotation ids,
// recording positions, reference definitions and HTML anchors, image and TeX probes, LaTeX builds.

const withLibrary = (run: () => Promise<void>) => withTemporaryLibrary(["Nb"], run);
const of = (report: IntegrityReport, check: string) => report.findings.filter((finding) => finding.check === check);
const messages = (report: IntegrityReport, check: string) => of(report, check).map((finding) => `${finding.severity}: ${finding.message}`);
const status = (report: IntegrityReport, check: string) => report.checks.find((item) => item.id === check)?.status;
const annotationLink = (annotation: string) => createMarkdownFileLinkDestination({ sourcePath: "Nb/b.md", targetPath: "Nb/p.pdf", metadata: { v: 1, fileType: "pdf", viewState: { pdf: { selectedAnnotationId: annotation } } } });

test("a review document that is corrupt is reported as unreadable and never offered for removal; a legacy-only store is inspected", () => withLibrary(async () => {
  await writeLibraryFile("Nb/a.md", "A\n");
  const reviews = reviewsDirectory(getStateRoot());
  await writeAt(path.join(reviews, "index.json"), JSON.stringify({ schemaVersion: 2, documents: { r1: "Nb/a.md", r2: "Nb/gone.md", r3: "Nb/ok.md" } }));
  await writeAt(path.join(reviews, "r1.json"), '{ "id": "r1", "comm');
  await writeAt(path.join(reviews, "r2.json"), JSON.stringify({ id: "wrong" }));
  await writeAt(path.join(reviews, "r3.json"), JSON.stringify({ id: "r3", key: "Nb/ok.md" }));
  await writeLibraryFile("Nb/ok.md", "ok\n");
  const lines = messages(await verifyNotebook("Nb"), "records").sort();
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0], /^warning: The review comments of Nb\/a\.md can't be read/);
  assert.match(lines[1], /^warning: The review comments of Nb\/gone\.md can't be read/);
  assert.ok(of(await verifyNotebook("Nb"), "records").every((finding) => !finding.clear), "nothing is offered for removal");

  // The index is fine and holds nothing; the older database still waits to be converted and names a missing note.
  await writeAt(path.join(reviews, "index.json"), JSON.stringify({ schemaVersion: 2, documents: {} }));
  await writeAt(legacyReviewDatabasePath(getStateRoot()), JSON.stringify({ schemaVersion: 1, documents: [{ id: "x", key: "Nb/lost.md" }, { id: "y", key: "Nb/ok.md" }] }));
  const legacy = await verifyNotebook("Nb");
  assert.deepEqual(messages(legacy, "records").sort(), [
    "info: Older review storage is waiting to be converted; it is the next time review comments load.",
    "info: Review comments are kept for this file, which is missing.",
  ]);
  assert.ok(of(legacy, "records").every((finding) => !finding.clear), "a key only the older database holds is not offered for removal");

  await writeAt(legacyReviewDatabasePath(getStateRoot()), "{ broken");
  assert.match(messages(await verifyNotebook("Nb"), "records")[0], /^warning: The older review storage can't be read/);
}));

test("a link to an annotation: absent sidecar is reported, an unreadable or older-layout one makes the check partial", () => withLibrary(async () => {
  await writeLibraryFile("Nb/p.pdf", "%PDF-1");
  const sidecar = pdfAnnotationsPath("Nb", ["p.pdf"]);
  await writeAt(sidecar, JSON.stringify({ annotations: [] }));
  await writeLibraryFile("Nb/b.md", `[mark](${annotationLink("a1")})\n`);
  const gone = `warning: The link "${annotationLink("a1")}" points at an annotation of Nb/p.pdf that is no longer there; it opens the file at its start.`;
  assert.deepEqual(messages(await verifyNotebook("Nb"), "links"), [gone], "a sidecar without the id");

  await rm(sidecar);
  const absent = await verifyNotebook("Nb");
  assert.deepEqual(messages(absent, "links"), [gone], "no sidecar at all: the annotation is gone too");
  assert.equal(status(absent, "links"), "findings");

  await mkdir(sidecar, { recursive: true });
  const unreadable = await verifyNotebook("Nb");
  assert.deepEqual(messages(unreadable, "links"), []);
  assert.equal(status(unreadable, "links"), "incomplete", "a sidecar that can't be read is not a missing annotation");

  await rm(sidecar, { recursive: true });
  await writeAt(legacyFlatPdfAnnotationsPath("Nb", "p.pdf"), JSON.stringify({ annotations: [] }));
  const legacy = await verifyNotebook("Nb");
  assert.deepEqual(messages(legacy, "links"), []);
  assert.equal(status(legacy, "links"), "incomplete", "an older layout is not read here, so its ids are not known");
}));

test("a recording position is judged only by a length saved for the recording as it is", () => withLibrary(async () => {
  await writeLibraryFile("Nb/m.m4a", "audio");
  await writeAt(transcriptPath("Nb", ["m.m4a"]), JSON.stringify({ version: 1, audio: { size: 5, duration: 60 }, speakers: [], segments: [] }));
  await writeLibraryFile("Nb/a.md", "[soon](m.m4a#t=30) [late](m.m4a#t=2:00)\n");
  const current = await verifyNotebook("Nb");
  assert.deepEqual(messages(current, "links"), ['warning: The link "m.m4a#t=2:00" points at 2:00, past the end of Nb/m.m4a (1:00).']);

  // Replaced by a shorter recording: the 60 s transcript no longer says anything about it, so 30 s passes nothing and flags nothing.
  await writeLibraryFile("Nb/m.m4a", "a shorter recording");
  const replaced = await verifyNotebook("Nb");
  assert.deepEqual(messages(replaced, "links"), []);
  assert.equal(status(replaced, "links"), "incomplete");

  // The waveform of the old file is no better.
  await rm(transcriptPath("Nb", ["m.m4a"]));
  await writeAt(audioPeaksPath("Nb", ["m.m4a"]), JSON.stringify({ key: "5:1\0hash", duration: 10, peaks: [0.1] }));
  const peaks = await verifyNotebook("Nb");
  assert.deepEqual(messages(peaks, "links"), []);
  assert.equal(status(peaks, "links"), "incomplete");

  // A waveform made for this file is.
  await writeAt(audioPeaksPath("Nb", ["m.m4a"]), JSON.stringify({ key: `${"a shorter recording".length}:1\0hash`, duration: 10, peaks: [0.1] }));
  assert.deepEqual(messages(await verifyNotebook("Nb"), "links"), [
    'warning: The link "m.m4a#t=30" points at 0:30, past the end of Nb/m.m4a (0:10).',
    'warning: The link "m.m4a#t=2:00" points at 2:00, past the end of Nb/m.m4a (0:10).',
  ]);
}));

test("a reference label defined twice resolves to its first definition", async () => {
  const links = (source: string) => extractMarkdownLinkOccurrences(source).map((link) => link.href);
  assert.deepEqual(links("[x][r]\n\n[r]: first.md\n[R]: second.md\n"), ["first.md"]);
  await withLibrary(async () => {
    await writeLibraryFile("Nb/a.md", "A\n");
    await writeLibraryFile("Nb/b.md", "[x][r]\n\n[r]: a.md\n[r]: gone.md\n");
    assert.deepEqual(messages(await verifyNotebook("Nb"), "links"), [], "the stale second definition is not the link");
    await writeLibraryFile("Nb/b.md", "[x][r]\n\n[r]: gone.md\n[r]: a.md\n");
    assert.deepEqual(messages(await verifyNotebook("Nb"), "links"), ['warning: The link "gone.md" finds no file.']);
  });
});

test("HTML anchors are real id and name attributes, in either quote style, never text in code", async () => {
  assert.deepEqual([...markdownHtmlAnchors("<a id='one'></a> <span id=\"two\">x</span> <a name=three></a> <p name=\"no\">\n\n```html\n<a id=\"fenced\"></a>\n```\n\n`<a id=\"span\">`\n")].sort(), ["one", "three", "two"]);
  await withLibrary(async () => {
    await writeLibraryFile("Nb/a.md", [
      "[one](#one) [two](#two) [fenced](#fenced) [code](#span)",
      "",
      "<a id='one'></a> <a name=\"two\"></a>",
      "",
      "```html",
      "<a id=\"fenced\"></a>",
      "```",
      "",
      "Inline `<a id=\"span\"></a>` code.",
      "",
    ].join("\n"));
    assert.deepEqual(messages(await verifyNotebook("Nb"), "links").sort(), [
      'warning: The link "#fenced" finds no heading in this note.',
      'warning: The link "#span" finds no heading in this note.',
    ]);
  });
});

test("an image or an included TeX file must be a readable file: a folder or a dangling link is missing", () => withLibrary(async () => {
  await mkdir(filePathFromParts("Nb", ["pics", "shot.png"]), { recursive: true });
  await writeLibraryFile("Nb/a.md", "<img src=\"/api/files/raw/Nb/pics/shot.png\">\n");
  await mkdir(filePathFromParts("Nb", ["paper", "intro.tex"]), { recursive: true });
  await writeLibraryFile("Nb/paper/main.tex", "\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\end{document}\n");
  const folders = await verifyNotebook("Nb");
  assert.deepEqual(messages(folders, "images"), ["error: Shows Nb/pics/shot.png, which is missing."]);
  assert.deepEqual(messages(folders, "latex"), ['error: includes "intro.tex", which is not found.']);

  // A file is fine again; a link to nowhere is not (where links can be made).
  await rm(filePathFromParts("Nb", ["pics", "shot.png"]), { recursive: true });
  await rm(filePathFromParts("Nb", ["paper", "intro.tex"]), { recursive: true });
  try {
    await symlink(path.join(filePathFromParts("Nb", ["nowhere"])), filePathFromParts("Nb", ["pics", "shot.png"]));
    await symlink(path.join(filePathFromParts("Nb", ["nowhere"])), filePathFromParts("Nb", ["paper", "intro.tex"]));
  } catch { return; /* No permission to make links here (Windows). */ }
  const dangling = await verifyNotebook("Nb");
  assert.deepEqual(messages(dangling, "images"), ["error: Shows Nb/pics/shot.png, which is missing."]);
  assert.deepEqual(messages(dangling, "latex"), ['error: includes "intro.tex", which is not found.']);
  await writeFile(filePathFromParts("Nb", ["nowhere"]), "x");
  const target = await verifyNotebook("Nb");
  assert.deepEqual(messages(target, "images"), []);
  assert.deepEqual(messages(target, "latex"), []);
}));

test("a chapter two main files share is checked from each, and the finding names the build that loses the file", () => withLibrary(async () => {
  const main = (name: string) => `\\documentclass{article}\n\\begin{document}\n\\input{../shared/chap}\n\\end{document}\n`.replace("article", name);
  await writeLibraryFile("Nb/a/main.tex", main("article"));
  await writeLibraryFile("Nb/b/main.tex", main("report"));
  await writeLibraryFile("Nb/shared/chap.tex", "\\includegraphics{plot}\n");
  await writeLibraryFile("Nb/a/plot.pdf", "%PDF");
  const report = await verifyNotebook("Nb");
  assert.deepEqual(messages(report, "latex"), ['error: shows "plot", which is not found when building Nb/b/main.tex.']);
  assert.equal(of(report, "latex")[0].path, "Nb/shared/chap.tex");
  assert.equal(of(report, "latex")[0].code, "latexMissingInBuild");

  await writeLibraryFile("Nb/b/plot.pdf", "%PDF");
  assert.deepEqual(messages(await verifyNotebook("Nb"), "latex"), []);
  await rm(filePathFromParts("Nb", ["a", "plot.pdf"]));
  assert.deepEqual(messages(await verifyNotebook("Nb"), "latex"), ['error: shows "plot", which is not found when building Nb/a/main.tex.']);
}));
