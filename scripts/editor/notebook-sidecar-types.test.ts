import assert from "node:assert/strict";
import { readFile, readdir, utimes } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { emptyInkAuthorFile } from "../../src/lib/ink/codec";
import { listLegacyAnnotations } from "../../src/lib/storage/annotations";
import { destinationRecords } from "../../src/lib/storage/destination-records";
import { StorageError } from "../../src/lib/storage/errors";
import { createFolder, moveFile, moveFileToDirectory } from "../../src/lib/storage/files";
import { verifyNotebook } from "../../src/lib/storage/integrity";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { filePathFromParts, legacyFlatImageAnnotationsPath, legacyFlatPdfAnnotationsPath, legacyPdfAnnotationsPath, pdfAnnotationsPath } from "../../src/lib/storage/paths";
import { reconcilePdfSidecars } from "../../src/lib/storage/pdf-sidecars";
import { pathExists } from "../../src/lib/storage/fs-utils";
import { splitLibraryPath, withTemporaryLibrary, writeAt, writeLibraryFile } from "./notebook-test-helpers";

// A5: what a change of file type, a destination name and the notebook check
// make of ink chunks and of annotations kept in an older layout.

const AUTHOR = "aaaaaaaaaa";
const inkOf = (relative: string) => { const { notebook, parts } = splitLibraryPath(relative); return inkFolderPath(notebook, parts); };
const authorFile = () => `${JSON.stringify(emptyInkAuthorFile({ key: AUTHOR }, { unit: "pt", width: 100, height: 100 }))}\n`;
const writeInk = (relative: string, chunk: string) => writeAt(path.join(inkOf(relative), `${chunk}.${AUTHOR}.ink`), authorFile());
const refused = (error: unknown) => error instanceof StorageError && error.status === 409;
const legacy = JSON.stringify({ annotations: [] });

test("finding 7: a rename to another file type is refused while its ink holds chunks the new editor never shows", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.pdf", "%PDF-1.4 a");
  await writeInk("Nb/a.pdf", "page-0001");
  await assert.rejects(moveFile("Nb/a.pdf", "Nb", "a.png"), refused);
  await assert.rejects(moveFile("Nb/a.pdf", "Nb", "a.md"), refused);
  assert.ok(await pathExists(inkOf("Nb/a.pdf")));
  assert.ok(await pathExists(path.join(inkOf("Nb/a.pdf"), `page-0001.${AUTHOR}.ink`)));

  await writeLibraryFile("Nb/p.png", "png");
  await writeInk("Nb/p.png", "image");
  await assert.rejects(moveFile("Nb/p.png", "Nb", "p.md"), refused);
  await assert.rejects(moveFile("Nb/p.png", "Nb", "p.pdf"), refused);

  await writeLibraryFile("Nb/n.md", "# Note\n");
  await writeInk("Nb/n.md", "text");
  await assert.rejects(moveFile("Nb/n.md", "Nb", "n.png"), refused);
  await assert.rejects(moveFile("Nb/n.md", "Nb", "n.pdf"), refused);

  // Nothing moved; a rename that keeps the type keeps the ink, and so does a change between types that share chunks.
  assert.ok(await pathExists(inkOf("Nb/p.png")) && await pathExists(inkOf("Nb/n.md")));
  await moveFile("Nb/a.pdf", "Nb", "b.pdf");
  assert.deepEqual(await readdir(inkOf("Nb/b.pdf")), [`page-0001.${AUTHOR}.ink`]);
  await moveFile("Nb/p.png", "Nb", "p.jpg");
  assert.deepEqual(await readdir(inkOf("Nb/p.jpg")), [`image.${AUTHOR}.ink`]);
}));

test("finding 8: a vacant name that holds notes in an older layout refuses the move that the migrator would give them to", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/a.pdf", "%PDF-1.4 a");
  await writeAt(legacyFlatPdfAnnotationsPath("Nb", "b.pdf"), legacy);
  await assert.rejects(moveFile("Nb/a.pdf", "Nb", "b.pdf"), refused);
  assert.equal(await readFile(legacyFlatPdfAnnotationsPath("Nb", "b.pdf"), "utf8"), legacy);
  assert.ok(await pathExists(filePathFromParts("Nb", ["a.pdf"])));
  assert.equal(await pathExists(filePathFromParts("Nb", ["b.pdf"])), false);
  // The destination check of a notebook move reads the same layouts.
  assert.deepEqual(await (await destinationRecords()).at("Nb", ["b.pdf"], "pdf"), ["annotations"]);

  // The dot-file layout and images too.
  await writeLibraryFile("Nb/p.png", "png");
  await writeAt(legacyFlatImageAnnotationsPath("Nb", "q.png"), legacy);
  await assert.rejects(moveFile("Nb/p.png", "Nb", "q.png"), refused);
  await writeLibraryFile("Nb/c.pdf", "%PDF-1.4 c");
  await writeAt(legacyPdfAnnotationsPath("Nb", "d.pdf"), legacy);
  await assert.rejects(moveFile("Nb/c.pdf", "Nb", "d.pdf"), refused);

  // With several files of that name the migrator gives the notes to none: not a reason to refuse.
  await writeAt(legacyFlatPdfAnnotationsPath("Nb", "dup.pdf"), legacy);
  await writeLibraryFile("Nb/x/dup.pdf", "%PDF-1.4 x");
  await writeLibraryFile("Nb/y/dup.pdf", "%PDF-1.4 y");
  await writeLibraryFile("Nb/e.pdf", "%PDF-1.4 e");
  await moveFile("Nb/e.pdf", "Nb", "dup.pdf");

  // A file's own notes in an older layout do not block its move to another folder, and follow it.
  await writeLibraryFile("Nb/own.pdf", "%PDF-1.4 own");
  await writeAt(legacyFlatPdfAnnotationsPath("Nb", "own.pdf"), JSON.stringify({ annotations: [], seed: "own" }));
  await createFolder("Nb", "sub");
  await moveFileToDirectory("Nb/own.pdf", "Nb/sub");
  assert.match(await readFile(pdfAnnotationsPath("Nb", ["sub", "own.pdf"]), "utf8"), /"seed":"own"|"seed": "own"/);
}));

test("finding 48: the notebook check lists notes in an older layout without upgrading them, and says when ownership is ambiguous", () => withTemporaryLibrary(["Nb"], async () => {
  await writeLibraryFile("Nb/m.pdf", "%PDF-1.4 m");
  await writeAt(legacyFlatPdfAnnotationsPath("Nb", "m.pdf"), legacy);
  await writeLibraryFile("Nb/x/d.png", "png");
  await writeLibraryFile("Nb/y/d.png", "png");
  await writeAt(legacyFlatImageAnnotationsPath("Nb", "d.png"), legacy);
  await writeAt(legacyPdfAnnotationsPath("Nb", "gone.pdf"), legacy);

  const listed = await listLegacyAnnotations("Nb");
  assert.equal(listed.unreadable, false);
  const owners = Object.fromEntries(listed.legacy.map((entry) => [`${entry.kind}/${entry.name}`, entry.owners.map((owner) => owner.join("/")).sort()]));
  assert.deepEqual(owners, { "pdf/m.pdf": ["m.pdf"], "pdf/gone.pdf": [], "image/d.png": ["x/d.png", "y/d.png"] });

  const report = await verifyNotebook("Nb");
  const older = report.findings.filter((finding) => finding.message.includes("older layout"));
  assert.deepEqual(older.map((finding) => `${finding.severity} ${finding.path}`).sort(), ["info Nb", "info Nb/m.pdf", "warning Nb"]);
  assert.ok(older.some((finding) => finding.severity === "warning" && finding.message.includes("2 files")));

  // Reading did not upgrade anything: the older files are where they were, none was archived, and no by-path file was made.
  assert.equal(await readFile(legacyFlatPdfAnnotationsPath("Nb", "m.pdf"), "utf8"), legacy);
  assert.equal(await readFile(legacyFlatImageAnnotationsPath("Nb", "d.png"), "utf8"), legacy);
  assert.equal(await pathExists(pdfAnnotationsPath("Nb", ["m.pdf"])), false);
  assert.deepEqual((await readdir(path.dirname(legacyFlatPdfAnnotationsPath("Nb", "m.pdf")))).sort(), ["m.pdf.json"]);
}));

/** The PDF's annotations by path, saved before they recorded their PDF; the PDF written at `pdfTime`, the notes at `notesTime`. */
async function seedUnidentified(notebook: string, pdfTime: number, notesTime: number) {
  const pdf = await writeLibraryFile(`${notebook}/p.pdf`, "%PDF-1.4 p");
  const notes = pdfAnnotationsPath(notebook, ["p.pdf"]);
  await writeAt(notes, JSON.stringify({ annotations: [], revision: 1 }));
  await utimes(pdf, pdfTime, pdfTime);
  await utimes(notes, notesTime, notesTime);
  return { size: (await readFile(pdf)).length, notes };
}

const hasSource = async (notes: string) => Boolean((JSON.parse(await readFile(notes, "utf8")) as { source?: unknown }).source);

test("finding 40: notes without an identity do not take the identity of a PDF changed since they were saved", () => withTemporaryLibrary([], async () => {
  // Their folders are made by the files below, not created as notebooks: that would already run the once-per-notebook backfill, on nothing.
  const now = Date.now() / 1000;
  const replaced = await seedUnidentified("Replaced", now, now - 3600);
  const untouched = await seedUnidentified("Untouched", now - 3600, now);
  await reconcilePdfSidecars("Replaced", [{ path: "Replaced/p.pdf", size: replaced.size }]);
  await reconcilePdfSidecars("Untouched", [{ path: "Untouched/p.pdf", size: untouched.size }]);
  // The background backfill: the control gets its identity, the replaced one stays unknown.
  for (let attempt = 0; attempt < 100 && !await hasSource(untouched.notes); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await hasSource(untouched.notes), true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await hasSource(replaced.notes), false);
}));
