import { parseBibtex } from "./bibtex";
import { parseCslJson } from "./csl-json";
import { duplicateScore, normalizeTitleForMatch, type DuplicateReason } from "./dedupe";
import { classifyReferenceInput, normalizeDoi, normalizeIsbn, normalizeIssn } from "./identifiers";
import { parseName } from "./names";
import {
  identifiersFromCsl,
  importProvenance,
  normalizeEntryInput,
  normalizeIdentifiers,
  parseDateText,
  type ReferenceParseError,
  type ReferenceParseResult,
} from "./normalize";
import { parseRis } from "./ris";
import {
  REFERENCES_UPDATED_EVENT,
  type CslItem,
  type CslItemType,
  type CslName,
  type ReferenceEntryInput,
  type ReferenceIdentifiers,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
  type ReferenceStatus,
  type ReferencesUpdatedDetail,
} from "./types";

// Importing reference files into a notebook's library (docs/references/plan.md
// §1.5, the "Import and export" contract in lanes.md). The route parses the
// text, plans one `add` op per new work against the library it read, applies
// all of them in one transaction and maps the result back with
// `referenceImportOutcome`. Everything here is pure except the two small
// client helpers at the end, so the panel and the notebook tree share them.

export type ReferenceImportFormat = "auto" | "bibtex" | "ris" | "csl-json";

/** File extensions `{ notebook, path }` imports accept. */
export const REFERENCE_IMPORT_EXTENSIONS = [".bib", ".ris", ".json", ".nbib"] as const;

export function isReferenceImportPath(path: string) {
  const lower = path.toLowerCase();
  return REFERENCE_IMPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export type ReferenceImportDuplicate = {
  /** The imported entry: its new id when it was added (fuzzy), otherwise the entry it duplicates. */
  entryId: string;
  /** The entry it duplicates: an existing entry, or one added earlier in the same import. */
  existingId: string;
  reason: DuplicateReason;
  /** True when the imported entry was not added because it is the same work. */
  skipped: boolean;
  /** Line of the imported entry in the source text. */
  line: number;
  sourceKey: string;
};

export type ReferenceImportResult = {
  library: ReferenceLibrary;
  /** Ids of the added entries, in source order. */
  added: string[];
  errors: ReferenceParseError[];
  duplicates: ReferenceImportDuplicate[];
  /** Source keys that could not be kept (taken by a different work, or invalid). */
  renamedKeys: { sourceKey: string; key: string }[];
};

/** An import request the server cannot handle; `status` is the HTTP status. */
export class ReferenceImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ReferenceImportError";
  }
}

export const NOT_A_REFERENCE_FILE_MESSAGE =
  "This looks like an identifier or a reference, not a BibTeX, RIS or CSL-JSON file. Paste it into the Add box in the References panel to look it up.";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** PubMed's MEDLINE (.nbib) format: `PMID- 123`, four-character tags, continuation lines indented. */
const MEDLINE_TAG = /^([A-Z][A-Z0-9]{1,3})\s*-\s(.*)$/;

function looksLikeMedline(text: string) {
  return /^﻿?PMID-\s*\d+/m.test(text) && !/^TY\s*-/m.test(text);
}

const MEDLINE_TYPES: [RegExp, CslItemType][] = [
  [/^book$/i, "book"],
  [/^(?:book )?chapter$/i, "chapter"],
  [/congress|conference/i, "paper-conference"],
  [/preprint/i, "article"],
  [/dataset/i, "dataset"],
];

/** "Smith JA" (MEDLINE AU) → family "Smith", given "J. A.". */
function medlineShortName(text: string): CslName {
  const words = text.trim().split(/\s+/);
  const initials = words.length > 1 && /^[A-Z]{1,4}$/.test(words.at(-1)!) ? words.pop()! : "";
  return { family: words.join(" "), ...(initials ? { given: initials.split("").map((letter) => `${letter}.`).join(" ") } : {}) };
}

function medlineDate(text: string) {
  // "2020 Jan 15", "2020 Jan-Feb", "2019 Winter", "2020".
  const [year, month, day] = text.trim().split(/\s+/);
  if (!/^\d{4}$/.test(year ?? "")) return parseDateText(text);
  const firstMonth = month?.split("-")[0];
  return parseDateText([year, firstMonth, /^\d{1,2}$/.test(day ?? "") ? day : undefined].filter(Boolean).join(" ")) ??
    parseDateText(year);
}

/** Parses PubMed MEDLINE text. Each record starts at a `PMID-` line. */
export function parseMedline(text: string, retrievedAt = new Date().toISOString()): ReferenceParseResult {
  const errors: ReferenceParseError[] = [];
  const records: { line: number; tags: [string, string][] }[] = [];
  let current: { line: number; tags: [string, string][] } | null = null;
  text.replace(/^﻿/, "").split(/\r\n?|\n/).forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) return;
    const match = line.match(MEDLINE_TAG);
    if (!match || /^\s/.test(line)) {
      if (current?.tags.length) current.tags[current.tags.length - 1][1] += ` ${line.trim()}`;
      else errors.push({ line: index + 1, message: `Unrecognized line outside a record: "${line.trim().slice(0, 40)}"` });
      return;
    }
    if (match[1] === "PMID" || !current) {
      current = { line: index + 1, tags: [] };
      records.push(current);
    }
    current.tags.push([match[1], match[2].trim()]);
  });

  const entries = records.map((record) => {
    const all = (tag: string) => record.tags.filter(([name]) => name === tag).map(([, value]) => value).filter(Boolean);
    const first = (tag: string) => all(tag)[0];
    const types = all("PT");
    const csl: CslItem = { type: MEDLINE_TYPES.find(([pattern]) => types.some((type) => pattern.test(type)))?.[1] ?? "article-journal" };
    const title = first("TI") ?? first("BTI");
    if (title) csl.title = title;
    if (first("TI") && first("BTI")) csl["container-title"] = first("BTI");
    const authors = all("FAU").length ? all("FAU").map((name) => parseName(name)) : all("AU").map(medlineShortName);
    const corporate = all("CN").map((literal) => ({ literal }));
    if (authors.length || corporate.length) csl.author = [...authors, ...corporate];
    const editors = all("FED").length ? all("FED").map((name) => parseName(name)) : all("ED").map(medlineShortName);
    if (editors.length) csl.editor = editors;
    const issued = first("DP") ? medlineDate(first("DP")!) : undefined;
    if (issued) csl.issued = issued;
    const journal = first("JT");
    if (journal && !csl["container-title"]) csl["container-title"] = journal;
    if (first("TA")) csl["container-title-short"] = first("TA");
    for (const [tag, field] of [["VI", "volume"], ["IP", "issue"], ["PG", "page"], ["AB", "abstract"], ["PB", "publisher"], ["PL", "publisher-place"], ["LA", "language"]] as const) {
      const value = first(tag);
      if (value) csl[field] = value;
    }
    const issn = all("IS").map((value) => normalizeIssn(value.replace(/\s*\(.*\)\s*$/, ""))).find(Boolean);
    if (issn) csl.ISSN = issn;
    const identifiers: ReferenceIdentifiers = {};
    const pmid = first("PMID");
    if (pmid) identifiers.pmid = pmid;
    const pmcid = first("PMC");
    if (pmcid) identifiers.pmcid = pmcid;
    const doi = [...all("LID"), ...all("AID")].filter((value) => /\[doi\]\s*$/i.test(value)).map((value) => normalizeDoi(value.replace(/\[doi\]\s*$/i, ""))).find(Boolean);
    if (doi) identifiers.doi = doi;
    const isbn = all("ISBN").map((value) => normalizeIsbn(value)).filter((value): value is string => Boolean(value));
    if (isbn.length) identifiers.isbn = isbn;
    const tags = all("OT");
    const input = normalizeEntryInput({ csl, identifiers, ...(tags.length ? { tags } : {}) });
    input.provenance = importProvenance(input.csl, retrievedAt);
    if (!title) errors.push({ line: record.line, message: "Record has no title" });
    return { input, sourceKey: "", line: record.line };
  });
  return { entries, errors };
}

/** The parser for a path's extension. A `.nbib` file is RIS or MEDLINE, by content. */
export function referenceImportFormatForPath(path: string, text: string): ReferenceImportFormat | "medline" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".bib")) return "bibtex";
  if (lower.endsWith(".ris")) return "ris";
  if (lower.endsWith(".json")) return "csl-json";
  if (lower.endsWith(".nbib")) return /^﻿?TY\s*-/m.test(text) ? "ris" : "medline";
  throw new ReferenceImportError("Only .bib, .ris, .json and .nbib files can be imported into References.");
}

/**
 * Parse reference text. `auto` detects BibTeX, RIS, CSL-JSON (with
 * `classifyReferenceInput`) and MEDLINE; anything else is an identifier or
 * reference text for the Add box, a ReferenceImportError.
 */
export function parseReferenceImport(text: string, format: ReferenceImportFormat | "medline", retrievedAt = new Date().toISOString()): ReferenceParseResult {
  let resolved = format;
  if (format === "auto") {
    const kind = classifyReferenceInput(text).kind;
    if (kind === "bibtex" || kind === "ris" || kind === "csl-json") resolved = kind;
    else if (looksLikeMedline(text)) resolved = "medline";
    else throw new ReferenceImportError(NOT_A_REFERENCE_FILE_MESSAGE);
  }
  switch (resolved) {
    case "bibtex": return parseBibtex(text, { retrievedAt });
    case "ris": return parseRis(text, { retrievedAt });
    case "csl-json": return parseCslJson(text, { retrievedAt });
    case "medline": return parseMedline(text, retrievedAt);
    default: throw new ReferenceImportError("Import format must be auto, bibtex, ris or csl-json.");
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function hasName(names: CslName[] | undefined) {
  return Boolean(names?.some((name) => name.family?.trim() || name.literal?.trim()));
}

/** Confirmed when the entry has a title, an author or editor, and an issued date; otherwise it needs review. */
export function importedEntryStatus(csl: CslItem): ReferenceStatus {
  const issued = csl.issued;
  const dated = Boolean(issued?.["date-parts"]?.[0]?.[0] || issued?.literal?.trim() || issued?.raw?.trim());
  return typeof csl.title === "string" && csl.title.trim() && (hasName(csl.author) || hasName(csl.editor)) && dated
    ? "confirmed" : "needs-review";
}

/** Fuzzy matches at or above this score are reported for a merge offer (as in `findDuplicateGroups`). */
const FUZZY_THRESHOLD = 0.9;

type Candidate = { id: string; csl: CslItem; identifiers?: ReferenceIdentifiers; tokens: string[]; values: string[] };

/**
 * Finds the pairs worth scoring without comparing every import with every
 * entry: a shared identifier, or enough shared title words for a title
 * similarity of 0.9 (which needs a token Dice coefficient of at least 0.8).
 */
class CandidateIndex {
  private byValue = new Map<string, Candidate[]>();
  private byToken = new Map<string, Candidate[]>();

  add(candidate: Candidate) {
    for (const value of candidate.values) this.byValue.set(value, [...(this.byValue.get(value) ?? []), candidate]);
    for (const token of candidate.tokens) {
      const list = this.byToken.get(token);
      if (list) list.push(candidate); else this.byToken.set(token, [candidate]);
    }
  }

  /** Best match: an exact identifier duplicate first, else the best fuzzy one at or above the threshold. */
  best(query: Candidate): { candidate: Candidate; score: number; reason: DuplicateReason } | null {
    const seen = new Set<Candidate>();
    for (const value of query.values) {
      for (const candidate of this.byValue.get(value) ?? []) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const { score, reason } = duplicateScore(query, candidate);
        if (score === 1 && reason && reason !== "fuzzy") return { candidate, score, reason };
      }
    }
    const shared = new Map<Candidate, number>();
    for (const token of query.tokens) for (const candidate of this.byToken.get(token) ?? []) shared.set(candidate, (shared.get(candidate) ?? 0) + 1);
    let best: { candidate: Candidate; score: number; reason: DuplicateReason } | null = null;
    for (const [candidate, count] of shared) {
      if ((2 * count) / (query.tokens.length + candidate.tokens.length) < 0.8) continue;
      const { score, reason } = duplicateScore(query, candidate);
      if (reason === "fuzzy" && score >= FUZZY_THRESHOLD && (!best || score > best.score)) best = { candidate, score, reason };
      // A shared identifier that was not found by value (e.g. an ISBN on a chapter) is still exact.
      if (score === 1 && reason && reason !== "fuzzy") return { candidate, score, reason };
    }
    return best;
  }
}

function candidateFor(id: string, csl: CslItem, identifiers: ReferenceIdentifiers | undefined): Candidate {
  const merged = { ...identifiersFromCsl(csl), ...normalizeIdentifiers(identifiers) };
  const values = [
    merged.doi && `doi:${merged.doi}`,
    merged.arxiv && `arxiv:${merged.arxiv}`,
    merged.pmid && `pmid:${merged.pmid}`,
    merged.pmcid && `pmcid:${merged.pmcid}`,
    ...[...(merged.isbn ?? []), ...(identifiers?.isbn ?? [])].map((isbn) => `isbn:${isbn}`),
  ].filter((value): value is string => Boolean(value));
  const tokens = [...new Set(normalizeTitleForMatch(csl.title).split(" ").filter(Boolean))];
  return { id, csl, identifiers, tokens, values };
}

type PlannedDuplicate = Omit<ReferenceImportDuplicate, "entryId" | "existingId"> & {
  /** Index into `ops` of the imported entry, when it was added. */
  op?: number;
  /** An existing entry id, or the op index of an entry added earlier in this import. */
  existing: { id: string } | { op: number };
};

export type ReferenceImportPlan = {
  ops: Extract<ReferenceLibraryOp, { op: "add" }>[];
  /** Per op: the source key and line of the imported entry. */
  sources: { sourceKey: string; line: number }[];
  duplicates: PlannedDuplicate[];
};

/**
 * One `add` op per imported work. Exact duplicates (a shared identifier) of
 * existing entries or of earlier entries in the same import are skipped;
 * fuzzy duplicates are added and reported. Inputs are normalized and get a
 * status from `importedEntryStatus`; valid source keys are passed on, and
 * the library keeps them when they are free.
 */
export function planReferenceImport(library: ReferenceLibrary, parsed: ReferenceParseResult): ReferenceImportPlan {
  const existing = new CandidateIndex();
  for (const entry of Object.values(library.entries)) existing.add(candidateFor(entry.id, entry.csl, entry.identifiers));
  const batch = new CandidateIndex();
  const plan: ReferenceImportPlan = { ops: [], sources: [], duplicates: [] };

  for (const { input: raw, sourceKey, line } of parsed.entries) {
    const input: ReferenceEntryInput = normalizeEntryInput(raw);
    input.status = importedEntryStatus(input.csl);
    const query = candidateFor("", input.csl, input.identifiers);
    const known = existing.best(query);
    const earlier = known?.reason === "fuzzy" || !known ? batch.best(query) : null;
    const exact = [known, earlier].find((match) => match && match.reason !== "fuzzy");
    if (exact) {
      plan.duplicates.push({
        existing: exact === known ? { id: exact.candidate.id } : { op: Number(exact.candidate.id) },
        reason: exact.reason, skipped: true, line, sourceKey,
      });
      continue;
    }
    const op = plan.ops.length;
    plan.ops.push({ op: "add", entry: input });
    plan.sources.push({ sourceKey, line });
    const fuzzy = known ?? earlier;
    if (fuzzy) {
      plan.duplicates.push({
        op,
        existing: fuzzy === known ? { id: fuzzy.candidate.id } : { op: Number(fuzzy.candidate.id) },
        reason: fuzzy.reason, skipped: false, line, sourceKey,
      });
    }
    batch.add({ ...query, id: String(op) });
  }
  return plan;
}

/**
 * The response for a plan applied in one transaction: `before` is the
 * library the plan was made against and `after` the committed result. New
 * entries are the ids `after` adds, in op order.
 */
export function referenceImportOutcome(
  before: ReferenceLibrary,
  after: ReferenceLibrary,
  plan: ReferenceImportPlan,
  errors: ReferenceParseError[],
): ReferenceImportResult {
  const added = Object.keys(after.entries).filter((id) => !Object.hasOwn(before.entries, id));
  if (added.length !== plan.ops.length) throw new Error("The reference library changed while importing.");
  const idOf = (target: { id: string } | { op: number }) => ("id" in target ? target.id : added[target.op]);
  const duplicates = plan.duplicates.map(({ op, existing, ...rest }) => {
    const existingId = idOf(existing);
    return { entryId: op === undefined ? existingId : added[op], existingId, ...rest };
  });
  const renamedKeys = plan.sources.flatMap(({ sourceKey }, index) => {
    const key = after.entries[added[index]].key;
    return sourceKey && sourceKey !== key ? [{ sourceKey, key }] : [];
  });
  return { library: after, added, errors, duplicates, renamedKeys };
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

/** "Added 3 references · 1 duplicate skipped · 1 key renamed". */
export function referenceImportSummary(result: Pick<ReferenceImportResult, "added" | "duplicates" | "renamedKeys" | "errors">) {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const skipped = result.duplicates.filter((duplicate) => duplicate.skipped).length;
  const parts = [`Added ${plural(result.added.length, "reference", "references")}`];
  if (skipped) parts.push(`${plural(skipped, "duplicate", "duplicates")} skipped`);
  if (result.renamedKeys.length) parts.push(`${plural(result.renamedKeys.length, "key", "keys")} renamed`);
  if (result.errors.length) parts.push(plural(result.errors.length, "parse error", "parse errors"));
  return parts.join(" · ");
}

/**
 * Tell this window and the others that a notebook's library changed, the way
 * use-reference-library.ts does after its own writes.
 */
export function announceReferenceLibraryChange(notebook: string, revision: number) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<ReferencesUpdatedDetail>(REFERENCES_UPDATED_EVENT, { detail: { notebook, revision } }));
  }
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("libera-references");
  channel.postMessage({ notebook, revision });
  channel.close();
}

/** POST /api/references/import for a library file, then announce the new revision. */
export async function importReferenceFile(notebook: string, path: string): Promise<ReferenceImportResult> {
  const response = await fetch("/api/references/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notebook, path }),
  });
  const body = await response.json().catch(() => ({})) as Partial<ReferenceImportResult> & { error?: string };
  if (!response.ok || !body.library) throw new Error(body.error ?? "Could not import the references.");
  const result = body as ReferenceImportResult;
  if (result.added.length) announceReferenceLibraryChange(notebook, result.library.revision);
  return result;
}
