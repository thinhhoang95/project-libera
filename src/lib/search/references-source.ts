import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SearchReferenceRecord } from "@/lib/global-search";
import { chunkMarkdown, chunkPlainText } from "@/lib/search/chunking";
import type { IndexedFile, NewChunk } from "@/lib/search/database";
import { referenceYear } from "@/lib/references/reference-suggestions";
import type { CslName, ReferenceEntry } from "@/lib/references/types";
import { readFileSignature } from "@/lib/storage/file-signature";
import { referenceLibraryPath } from "@/lib/storage/paths";

// References as their own Global Search source (docs/references/plan.md §4.3,
// Phase 5), the way the gallery is one: one record per library entry, keyed
// `reference:<notebook>/<entry id>`, holding its title, authors, year, venue,
// abstract, notes and tags. Its signature is a hash of that text, so an
// unchanged entry keeps its passages and vectors across library revisions.

export const REFERENCE_RECORD_PREFIX = "reference:";

export function referenceRecordKey(notebook: string, entryId: string) {
  return `${REFERENCE_RECORD_PREFIX}${notebook}/${entryId}`;
}

/** The notebook and entry id of a reference record key; null for other keys. */
export function parseReferenceRecordKey(key: string) {
  if (!key.startsWith(REFERENCE_RECORD_PREFIX)) return null;
  const rest = key.slice(REFERENCE_RECORD_PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash <= 0) return null;
  return { notebook: rest.slice(0, slash), entryId: rest.slice(slash + 1) };
}

export type ReferenceRecord = Omit<IndexedFile, "id" | "status"> & { chunks: NewChunk[]; ftsName: string };

function fullName(name: CslName) {
  if (name.literal) return name.literal;
  return [name.given, name["dropping-particle"], name["non-dropping-particle"], name.family, name.suffix].filter(Boolean).join(" ");
}

function familyName(name: CslName | undefined) {
  if (!name) return "";
  return name.literal ?? [name["non-dropping-particle"], name.family].filter(Boolean).join(" ");
}

/** "Smith", "Smith & Lee", "Smith et al." */
function shortAuthors(people: CslName[]) {
  const first = familyName(people[0]);
  if (!first) return "";
  if (people.length > 2) return `${first} et al.`;
  const second = familyName(people[1]);
  return second ? `${first} & ${second}` : first;
}

function text(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** The record Global Search stores for one entry of `notebook`'s library. */
export function referenceRecord(notebook: string, entry: ReferenceEntry): ReferenceRecord {
  const csl = entry.csl;
  const title = text(csl.title) || text(csl["title-short"]) || entry.key;
  const people = csl.author?.length ? csl.author : csl.editor ?? [];
  const authors = people.map(fullName).filter(Boolean).join(", ");
  const year = referenceYear(csl);
  const venue = [text(csl["container-title"]), text(csl["collection-title"]), text(csl["event-title"]), text(csl.publisher)].filter(Boolean).join(", ");
  const tags = (entry.tags ?? []).filter(Boolean);

  const chunks: NewChunk[] = [{
    title: "",
    text: [
      title,
      authors,
      [year, venue].filter(Boolean).join(" · "),
      tags.length ? `Tags: ${tags.join(", ")}` : "",
      `@${entry.key}`,
    ].filter(Boolean).join("\n"),
    context: "",
  }];
  const abstract = typeof csl.abstract === "string" ? csl.abstract.trim() : "";
  for (const chunk of abstract ? chunkPlainText(abstract) : []) chunks.push({ title: "Abstract", text: chunk.text, context: chunk.context });
  const notes = entry.notes?.trim() ?? "";
  for (const chunk of notes ? chunkMarkdown(notes) : []) {
    chunks.push({ title: chunk.title ? `Notes › ${chunk.title}` : "Notes", text: chunk.text, context: chunk.context });
  }

  const meta: SearchReferenceRecord = { notebook, entryId: entry.id, key: entry.key, ...(shortAuthors(people) ? { authors: shortAuthors(people) } : {}), ...(year ? { year } : {}) };
  const signature = `ref:${createHash("sha256").update(JSON.stringify([title, chunks])).digest("hex").slice(0, 32)}`;
  return {
    key: referenceRecordKey(notebook, entry.id),
    source: "references",
    kind: "reference",
    path: notebook,
    name: title,
    notebook,
    signature,
    meta: JSON.stringify(meta),
    chunks,
    ftsName: `Reference ${title} ${entry.key} ${entry.aliases.join(" ")}`.trim(),
  };
}

export type ReferenceSourceRead =
  | { status: "ok"; records: ReferenceRecord[]; fileSignature: string }
  | { status: "missing" }
  /** The library exists but could not be read now; its records are kept. */
  | { status: "unreadable"; error: string };

function isLibrary(value: unknown): value is { entries: Record<string, ReferenceEntry> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = (value as { entries?: unknown }).entries;
  return Boolean(entries) && typeof entries === "object" && !Array.isArray(entries);
}

function isEntry(value: unknown): value is ReferenceEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ReferenceEntry>;
  return typeof entry.id === "string" && typeof entry.key === "string" && Array.isArray(entry.aliases) && Boolean(entry.csl) && typeof entry.csl === "object";
}

/**
 * The records of `notebook`'s library, read straight from its file: Global
 * Search never takes the library's lock, and never moves a damaged library
 * aside (the next library read does that).
 */
export async function readReferenceSource(notebook: string): Promise<ReferenceSourceRead> {
  let target: string;
  try { target = referenceLibraryPath(notebook); } catch { return { status: "missing" }; }
  let raw: string;
  let fileSignature: string;
  try {
    fileSignature = await readFileSignature(target);
    raw = await readFile(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    return { status: "unreadable", error: error instanceof Error ? error.message : "The library could not be read." };
  }
  let library: unknown;
  try { library = JSON.parse(raw); } catch { return { status: "unreadable", error: "The library is not valid JSON." }; }
  if (!isLibrary(library)) return { status: "unreadable", error: "The library is incomplete." };
  const records = Object.values(library.entries).filter(isEntry).map((entry) => referenceRecord(notebook, entry));
  return { status: "ok", records, fileSignature };
}

// Signatures of the libraries' current entries, re-read only when a library
// file changes, so the embedding loop can check a batch is still current.
const current = new Map<string, { fileSignature: string; signatures: Map<string, string> }>();

/** The signature `entryId` has in `notebook`'s library now; "" when it is gone or unreadable. */
export async function currentReferenceSignature(notebook: string, entryId: string) {
  let target: string;
  try { target = referenceLibraryPath(notebook); } catch { return ""; }
  const fileSignature = await readFileSignature(target).catch(() => "");
  if (!fileSignature) {
    current.delete(notebook);
    return "";
  }
  let known = current.get(notebook);
  if (known?.fileSignature !== fileSignature) {
    const read = await readReferenceSource(notebook);
    if (read.status !== "ok") return "";
    known = { fileSignature: read.fileSignature, signatures: new Map(read.records.map((record) => [parseReferenceRecordKey(record.key)!.entryId, record.signature])) };
    current.set(notebook, known);
  }
  return known.signatures.get(entryId) ?? "";
}
