import { open, readFile, stat } from "node:fs/promises";
import { normalizeDoi } from "../identifiers";
import { parseName } from "../names";
import { normalizeEntryInput } from "../normalize";
import type { CslItem, CslName, FieldProvenance, ReferenceAttachment, ReferenceEntryInput, ReferenceLibrary, ReferenceLibraryOp } from "../types";
import { isAbortError } from "./http";
import { extractionToInput, proposeMarkdownEntry } from "./llm";
import { lookupDoi, type ResolveEnvironment } from "./lookup";
import { compactInput } from "./record";
import { parseLooseDate } from "./url";

// Markdown resolution (docs/references/plan.md §4.4 step 5). A converted
// `<pdf name>.md` beside a PDF that already has an entry is attached to that
// entry. Any other note gets a proposed entry (manuscript, webpage or
// report) from its front matter, first heading and first section, with the
// note attached and status `needs-review`.

const MAX_NOTE_BYTES = 1024 * 1024;
const FRONT_MATTER_CONFIDENCE = 0.6;

export type MarkdownResolveDeps = {
  /** Text of a library-relative file (defaults to reading it from the library). */
  readText?: (relativePath: string) => Promise<string>;
};

export type MarkdownResolution =
  | { kind: "attach"; entryId: string; op: ReferenceLibraryOp }
  | { kind: "candidate"; candidate: ReferenceEntryInput };

async function defaultReadText(relativePath: string) {
  const { filePathFromParts, splitFilePath } = await import("@/lib/storage/paths");
  const { notebook, pathParts } = splitFilePath(relativePath);
  const absolutePath = filePathFromParts(notebook, pathParts);
  if ((await stat(absolutePath)).size > MAX_NOTE_BYTES) {
    const handle = await open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(MAX_NOTE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_NOTE_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  return readFile(absolutePath, "utf8");
}

/** PDFs whose converted Markdown could be this file: `paper.md`, `paper (2).md` and `paper.pdf.md` all belong to `paper.pdf`. */
export function siblingPdfPaths(relativePath: string) {
  const match = relativePath.match(/^(.*?)(?: \(\d+\))?\.(?:md|markdown)$/i);
  if (!match) return [];
  const stem = match[1];
  return [...new Set([stem.toLowerCase().endsWith(".pdf") ? stem : `${stem}.pdf`, `${relativePath.replace(/\.(?:md|markdown)$/i, "")}.pdf`])];
}

/** The entry that has the sibling PDF attached, if any. */
export function entryForSiblingPdf(relativePath: string, library: ReferenceLibrary) {
  const candidates = new Set(siblingPdfPaths(relativePath).map((value) => value.toLowerCase()));
  return Object.values(library.entries).find((entry) => entry.attachments.some((attachment) => attachment.kind === "pdf" && candidates.has(attachment.path.toLowerCase())));
}

export type MarkdownParts = { frontMatter?: string; fields: Record<string, string | string[]>; heading?: string; section?: string };

/** Front matter (simple `key: value` and `- item` lists), the first heading and the text up to the next heading. */
export function readMarkdownParts(text: string): MarkdownParts {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const fields: Record<string, string | string[]> = {};
  let body = source;
  let frontMatter: string | undefined;
  const front = source.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/);
  if (front) {
    frontMatter = front[1];
    body = source.slice(front[0].length);
    let listKey: string | undefined;
    for (const line of frontMatter.split("\n")) {
      const item = line.match(/^\s+-\s+(.*)$/);
      if (item && listKey) {
        const list = Array.isArray(fields[listKey]) ? fields[listKey] as string[] : [];
        fields[listKey] = [...list, unquote(item[1])];
        continue;
      }
      const pair = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
      if (!pair) continue;
      listKey = pair[2].trim() ? undefined : pair[1].toLowerCase();
      if (pair[2].trim()) {
        const value = pair[2].trim();
        fields[pair[1].toLowerCase()] = /^\[.*\]$/.test(value) ? value.slice(1, -1).split(",").map(unquote).filter(Boolean) : unquote(value);
      }
    }
  }
  const lines = body.split("\n");
  let inFence = false;
  let headingIndex = -1;
  let heading: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) inFence = !inFence;
    if (inFence) continue;
    const match = lines[index].match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) {
      heading = match[1].trim();
      headingIndex = index;
      break;
    }
  }
  const after = lines.slice(headingIndex + 1);
  const next = after.findIndex((line) => /^#{1,6}\s+/.test(line));
  const section = (next >= 0 ? after.slice(0, next) : after).join("\n").trim().slice(0, 4_000);
  return { ...(frontMatter ? { frontMatter } : {}), fields, ...(heading ? { heading } : {}), ...(section ? { section } : {}) };
}

function unquote(value: string) {
  return value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

function asList(value: string | string[] | undefined) {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : value.split(/\s*(?:;|\band\b)\s*/)).map((item) => item.trim()).filter(Boolean);
}

function fileTitle(relativePath: string) {
  return (relativePath.split("/").pop() ?? relativePath).replace(/\.(?:md|markdown)$/i, "").replace(/[_]+/g, " ").trim();
}

/** Without the model: title, authors, date and URL from front matter, else the first heading or file name. */
function noteInput(relativePath: string, parts: MarkdownParts, retrievedAt: string): ReferenceEntryInput {
  const fields = parts.fields;
  const url = typeof fields.url === "string" && /^https?:\/\//i.test(fields.url) ? fields.url : typeof fields.source === "string" && /^https?:\/\//i.test(fields.source) ? fields.source : undefined;
  const csl: CslItem = { type: url ? "webpage" : "manuscript" };
  const provenance: Record<string, FieldProvenance> = {};
  const fromFront: FieldProvenance = { source: "import", confidence: FRONT_MATTER_CONFIDENCE, retrievedAt };
  const fromText: FieldProvenance = { source: "import", confidence: 0.4, retrievedAt };
  const title = typeof fields.title === "string" ? fields.title : undefined;
  csl.title = title ?? parts.heading ?? fileTitle(relativePath);
  provenance.title = title ? fromFront : fromText;
  const authors = asList(fields.author ?? fields.authors).map((name) => parseName(name)).filter((name: CslName) => Object.keys(name).length > 0);
  if (authors.length) {
    csl.author = authors;
    provenance.author = fromFront;
  }
  const issued = parseLooseDate(typeof fields.date === "string" ? fields.date : undefined);
  if (issued) {
    csl.issued = issued;
    provenance.issued = fromFront;
  }
  if (url) {
    csl.URL = url;
    provenance.URL = fromFront;
  }
  provenance.type = fromText;
  return compactInput(normalizeEntryInput({ csl, provenance }));
}

/** Resolve one Markdown file: attach it to its PDF's entry, or propose an entry for it. */
export async function resolveMarkdownFile(relativePath: string, library: ReferenceLibrary, env: ResolveEnvironment, deps: MarkdownResolveDeps = {}): Promise<MarkdownResolution> {
  const attachment: ReferenceAttachment = { kind: "markdown", path: relativePath };
  const sibling = entryForSiblingPdf(relativePath, library);
  if (sibling) {
    return { kind: "attach", entryId: sibling.id, op: { op: "attach", id: sibling.id, attachment } };
  }
  const retrievedAt = env.ctx.now().toISOString();
  const parts = readMarkdownParts(await (deps.readText ?? defaultReadText)(relativePath));

  // A note that names its DOI is that work.
  const doi = normalizeDoi(typeof parts.fields.doi === "string" ? parts.fields.doi : undefined);
  if (doi) {
    const input = await lookupDoi(doi, env);
    if (input) return { kind: "candidate", candidate: compactInput({ ...input, attachments: [attachment], status: "needs-review" }) };
  }

  let candidate = noteInput(relativePath, parts, retrievedAt);
  if (env.aiAvailable) {
    try {
      const extraction = await proposeMarkdownEntry({ fileName: relativePath.split("/").pop() ?? relativePath, frontMatter: parts.frontMatter, heading: parts.heading, section: parts.section }, { ctx: env.ctx, complete: env.complete });
      if (extraction.found) {
        const proposed = extractionToInput(extraction, { source: "llm", confidence: 0.5, retrievedAt, defaultType: "manuscript" });
        // Front matter the user wrote wins over the model's reading of it.
        const fromFront = Object.keys(candidate.provenance ?? {}).filter((field) => candidate.provenance?.[field]?.confidence === FRONT_MATTER_CONFIDENCE);
        const csl = { ...proposed.csl, ...Object.fromEntries(fromFront.map((field) => [field, candidate.csl[field]])) } as CslItem;
        const provenance = { ...proposed.provenance, ...Object.fromEntries(fromFront.map((field) => [field, candidate.provenance![field]])) };
        candidate = compactInput(normalizeEntryInput({ csl, provenance }));
      }
    } catch (error) {
      if (isAbortError(error) || env.ctx.signal?.aborted) throw error;
      env.warnings.push(`The model could not propose an entry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { kind: "candidate", candidate: compactInput({ ...candidate, attachments: [attachment], status: "needs-review" }) };
}
