import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetBibTethers } from "../../src/lib/references/bib-tether";
import { currentReferenceJobRunner, setReferenceJobRunner } from "../../src/lib/references/jobs";
import { inkFolderPath } from "../../src/lib/storage/ink";
import { verifyNotebook, type IntegrityFinding, type IntegritySeverity } from "../../src/lib/storage/integrity";
import { writeMarkdownImageAsset } from "../../src/lib/storage/markdown-assets";
import { setMigrationFaultForTests } from "../../src/lib/storage/migration";
import { emptyReferenceLibrary } from "../../src/lib/references/library-ops";
import { DEFINITIONS_VERSION } from "../../src/lib/definitions";
import { emptyInkAuthorFile } from "../../src/lib/ink/codec";
import { PDF_OUTLINE_VERSION } from "../../src/lib/pdf-outline";
import { TRANSCRIPT_VERSION } from "../../src/lib/transcription/types";
import type { ReferenceEntry, ReferenceLibrarySettings } from "../../src/lib/references/types";
import { createNotebook } from "../../src/lib/storage/notebooks";
import {
  audioPeaksPath,
  definitionsPath,
  filePathFromParts,
  imageAnnotationsPath,
  notebookPath,
  pdfAnnotationsPath,
  referenceLibraryPath,
  pdfOutlinePath,
  pdfTextCachePath,
  transcriptPath,
} from "../../src/lib/storage/paths";

// Shared by the storage tests that move notebooks' files around: a
// throwaway library, a notebook seeded with every kind of side file, and the
// notebook check (storage/integrity.ts) as the oracle that a notebook came
// out of an operation sound.

/** A data directory of its own, with these notebooks; background work started for it ends with it. */
export async function withTemporaryLibrary(notebooks: string[], run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-notebooks-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    for (const notebook of notebooks) await createNotebook(notebook);
    await run();
  } finally {
    currentReferenceJobRunner()?.dispose();
    setReferenceJobRunner(undefined);
    resetBibTethers();
    setMigrationFaultForTests(null);
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

export const splitLibraryPath = (relative: string) => { const [notebook, ...parts] = relative.split("/"); return { notebook, parts }; };

/** A file of a notebook, by library path. */
export async function writeLibraryFile(relative: string, content: string | Buffer = "text") {
  const { notebook, parts } = splitLibraryPath(relative);
  const target = filePathFromParts(notebook, parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

/** Any file by absolute path (sidecars, hidden files). */
export async function writeAt(target: string, content: string) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** A notebook's reference library that the app accepts, with an entry per key, attached to the given files. */
export async function writeReferenceLibrary(notebook: string, entries: { key: string; attachments: string[] }[], settings?: ReferenceLibrarySettings) {
  const now = new Date().toISOString();
  const library = emptyReferenceLibrary();
  library.revision = 1;
  if (settings) library.settings = { ...library.settings, ...settings };
  for (const [index, item] of entries.entries()) {
    const id = `ref_${index}`;
    library.entries[id] = {
      id, key: item.key, aliases: [], csl: { id, type: "article-journal", title: item.key },
      identifiers: {}, provenance: {}, status: "confirmed",
      attachments: item.attachments.map((attachment) => ({ kind: "pdf" as const, path: attachment })),
      createdAt: now, updatedAt: now,
    } as unknown as ReferenceEntry;
  }
  await writeAt(referenceLibraryPath(notebook), JSON.stringify(library));
}

/**
 * Distinct content for a seeded sidecar, valid for its owner's parser (an
 * outline, definitions, a transcript), so a test can tell where each one went
 * and the notebook check accepts it.
 */
const SEEDED_PDF = "%PDF-1.4 a";
const SEEDED_INK_AUTHOR = "aaaaaaaaaa";
/** The name of a seeded ink file: page 1, by the seeded author (lib/ink/authors.ts). */
export const SEEDED_INK = `page-0001.${SEEDED_INK_AUTHOR}.ink`;

export const seeded = (label: string) => {
  if (label === "outline") return JSON.stringify({ version: PDF_OUTLINE_VERSION, documentPath: label, entries: [] });
  if (label.endsWith("definitions")) return JSON.stringify({ version: DEFINITIONS_VERSION, documentPath: label, entries: [] });
  if (label === "transcript") return JSON.stringify({ version: TRANSCRIPT_VERSION, createdAt: label, segments: [], speakers: [] });
  // Caches as their owners read them, made for the seeded PDF.
  if (label === "text-cache") return JSON.stringify({ version: 3, pdfContentHash: label, pageCount: 1, path: label, pdfUpdatedAt: "", pdfSize: SEEDED_PDF.length, generatedAt: label, pages: [{ pageNumber: 1, text: label }] });
  if (label === "peaks") return JSON.stringify({ key: `seed:${label}`, duration: 1, peaks: [0] });
  // An author file the ink reader accepts, without a recorded source.
  if (label.endsWith("-ink")) return `${JSON.stringify(emptyInkAuthorFile({ key: SEEDED_INK_AUTHOR }, { unit: "pt", width: 612, height: 792 }))}\n`;
  return JSON.stringify({ seed: label });
};

/**
 * A small project with every kind of side file: a PDF (annotations, outline,
 * text cache, definitions, ink), an image (annotations), a recording
 * (transcript, waveform), a note (an upload, an embed of the notebook image,
 * definitions), and hidden or unknown content beside the note.
 */
export async function seedNotebook(notebook: string) {
  const pdf = ["papers", "a.pdf"];
  await writeLibraryFile(`${notebook}/papers/a.pdf`, SEEDED_PDF);
  // As the readers take it; `seed` lets a test tell where it went (`m1`).
  await writeAt(pdfAnnotationsPath(notebook, pdf), JSON.stringify({ annotations: [], comments: [], seed: "m1" }));
  await writeAt(pdfOutlinePath(notebook, pdf), seeded("outline"));
  await writeAt(pdfTextCachePath(notebook, pdf), seeded("text-cache"));
  await writeAt(definitionsPath(notebook, pdf), seeded("pdf-definitions"));
  await writeAt(path.join(inkFolderPath(notebook, pdf), SEEDED_INK), seeded("pdf-ink"));

  await writeLibraryFile(`${notebook}/papers/fig.png`, Buffer.from("png-bytes"));
  await writeAt(imageAnnotationsPath(notebook, ["papers", "fig.png"]), JSON.stringify({ annotations: [] }));

  await writeLibraryFile(`${notebook}/audio/memo.m4a`, Buffer.from("audio"));
  await writeAt(transcriptPath(notebook, ["audio", "memo.m4a"]), seeded("transcript"));
  await writeAt(audioPeaksPath(notebook, ["audio", "memo.m4a"]), seeded("peaks"));

  await writeLibraryFile(`${notebook}/notes/n.md`, "# Note\n");
  const upload = await writeMarkdownImageAsset(`${notebook}/notes/n.md`, new File(["photo-bytes"], "photo.png"));
  await writeLibraryFile(`${notebook}/notes/n.md`, `# Note\n\n${upload.markdown}\n\n![](/api/files/raw/${notebook}/papers/fig.png)\n`);
  await writeAt(definitionsPath(notebook, ["notes", "n.md"]), seeded("note-definitions"));
  await writeAt(path.join(notebookPath(notebook), "notes", ".hidden-config"), "hidden");
  await writeLibraryFile(`${notebook}/notes/data.unknownext`, "unknown");
}

const describe = (finding: IntegrityFinding) => `${finding.severity} ${finding.check}: ${finding.path}: ${finding.message}`;

/**
 * The notebook check finds nothing wrong (errors and warnings by default;
 * pass `severities` to include notes). `allow` names findings a test expects,
 * as text that a finding's description contains.
 */
export async function assertNotebookSound(notebook: string, { allow = [], severities = ["error", "warning"], partial = false }: { allow?: string[]; severities?: IntegritySeverity[]; /** A check that could only partly run is allowed: it can't say the notebook is sound. */ partial?: boolean } = {}) {
  const report = await verifyNotebook(notebook);
  const unexpected = [
    ...report.checks.filter((check) => check.status === "failed" || (!partial && check.status === "incomplete")).map((check) => `check ${check.status} ${check.id}: ${check.note}`),
    ...report.findings.filter((finding) => severities.includes(finding.severity)).map(describe).filter((text) => !allow.some((expected) => text.includes(expected))),
  ];
  assert.deepEqual(unexpected, [], `${notebook} is not sound`);
  return report;
}
