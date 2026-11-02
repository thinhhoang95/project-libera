import { createHash } from "node:crypto";
import { titleSimilarity } from "./dedupe";
import { parseBibtexWithLayout, serializeBibtex, type BibtexEntryLayout } from "./bibtex";
import { importedEntryStatus } from "./import";
import { generateCitationKey, takenCitationKeys } from "./keys";
import { applyLibraryOps } from "./library-ops";
import type { LatexDialect } from "./latex-text";
import type {
  CslItem,
  FieldAlternative,
  FieldProvenance,
  ReferenceEntry,
  ReferenceEntryInput,
  ReferenceIdentifiers,
  ReferenceLibrary,
  ReferenceLibraryOp,
} from "./types";

// The merge behind a tethered .bib file (bib-tether.ts): a three-way merge of
// the library, the file and the state both had after the last sync. Pure, so
// it can be tested without a disk.
//
// Entries are compared in one space: what an entry says once written as
// BibTeX and read back (its "projection"), flattened to fields (`key`,
// `csl.<variable>`, `id.<identifier>`, `tags`). The base keeps, per entry,
// the projection of each side as it was after the last sync, so a field one
// side changed is told apart from a field the two sides only spell
// differently (a lossy round trip is never a change).
//
// Per field: changed on one side → that side wins; changed on both → the
// newer edit wins (the file's modification time against the field's clock in
// the library) and the losing value is kept on the entry as an alternative,
// so the confirmation card can bring it back. Without a base (the first sync,
// or two entries added on both sides with the same key) `prefer` decides.
//
// The file is edited in place: entries nobody changed keep their exact text
// (comments, @string macros, formatting, and fields Libera does not read are
// never touched). A rewritten entry keeps the fields Libera does not read.
// Deleting is the dangerous direction, so: an entry edited on one side and
// deleted on the other is kept; nothing is deleted while the file has blocks
// that do not parse (their entries look deleted); and many deletions from
// the file at once wait for the user (`pendingDeletion`).

export type TetherBaseEntry = {
  key: string;
  /** The library side's projection after the last sync, as canonical BibTeX. */
  lib: string;
  /** The file side's projection, when it differs from `lib`. */
  file?: string;
  /** The file projection before a second, potentially lossy, BibTeX round trip. */
  fileFields?: Record<string, string>;
  /** Original block for detecting file-only edits, and a self-contained copy for restoration. */
  raw?: string;
  restore?: string;
  /** Detect edits to library-only metadata too, without duplicating attachments or notes. */
  libraryHash?: string;
  /** A removal already shown to the user must not be applied by a later unrelated edit. */
  held?: boolean;
};

export type TetherPrefer = "library" | "file";

/** What to do with deletions held back by `pendingDeletion`: ask again, delete them, or put them back in the file. */
export type TetherDeletionChoice = "ask" | "apply" | "restore";

export type TetherPlanInput = {
  library: ReferenceLibrary;
  /** The file as read, BOM and line endings included. */
  fileText: string;
  /** Per library entry id; null before the first sync. */
  base: Record<string, TetherBaseEntry> | null;
  dialect: LatexDialect;
  now: string;
  /** When the file was last modified (ISO), the clock of every file-side edit. */
  fileModifiedAt: string;
  /** Who wins a difference that no history explains (the first sync). */
  prefer: TetherPrefer;
  deletions?: TetherDeletionChoice;
  /** A new entry id; tests pass a deterministic one. */
  newId?: () => string;
};

export type TetherConflict = { key: string; field: string; kept: "library" | "file" };

export type TetherSummary = {
  /** Changes made to the library. */
  library: { added: string[]; updated: string[]; deleted: string[]; renamed: Array<{ from: string; to: string }> };
  /** Changes made to the file. */
  file: { added: string[]; updated: string[]; deleted: string[]; renamed: Array<{ from: string; to: string }> };
  conflicts: TetherConflict[];
  /** Entries edited on one side and deleted on the other; they were kept. */
  kept: string[];
  /** On the first sync: entries in both whose values differ, decided by `prefer`. */
  decided: string[];
};

export type TetherPlan = {
  /** Ambiguous or unreadable input must be repaired before either side is changed. */
  blocked?: boolean;
  ops: ReferenceLibraryOp[];
  /** The library after `ops` (the revision is left alone). */
  library: ReferenceLibrary;
  /** The new file text, in the file's own BOM and line endings; null when the file stays as it is. */
  fileText: string | null;
  /** The base to keep once both sides are written. */
  base: Record<string, TetherBaseEntry>;
  summary: TetherSummary;
  /** Deletions from the file that wait for the user. Their entries stay in the library meanwhile. */
  pendingDeletion: { ids: string[]; keys: string[] } | null;
  warnings: string[];
};

/** Removing more than this many entries from the file at once, and at least DELETION_SHARE of them, waits for the user. */
export const DELETION_COUNT_LIMIT = 3;
export const DELETION_SHARE = 0.2;

/** Fields the BibTeX parser reads (bibtex.ts toEntry and crossref). Every other field of a rewritten entry is kept as written. */
const PARSED_FIELDS = new Set([
  "abstract", "address", "archiveprefix", "arxiv", "arxivid", "author", "bookauthor", "booksubtitle", "booktitle", "chapter",
  "crossref", "date", "day", "doi", "edition", "editor", "eid", "entrysubtype", "eprint", "eprinttype", "eventdate", "eventtitle",
  "howpublished", "institution", "isbn", "issn", "issue", "journal", "journal-abbrev", "journalabbr", "journalsubtitle",
  "journaltitle", "keywords", "langid", "language", "location", "month", "note", "number", "organization", "origdate", "pages",
  "pagetotal", "pmcid", "pmid", "publisher", "pubstate", "school", "series", "shortjournal", "shorttitle", "subtitle", "title",
  "translator", "type", "url", "urldate", "venue", "version", "volume", "volumes", "year",
]);

const BIBLATEX_FIELD = /^[ \t]*(journaltitle|date|location|urldate|eprinttype|pubstate|origdate|eventdate)[ \t]*=/im;

/** BibLaTeX when the file uses fields only BibLaTeX knows; otherwise (and for an empty file) BibTeX. */
export function detectBibDialect(text: string): LatexDialect {
  return BIBLATEX_FIELD.test(text) ? "biblatex" : "bibtex";
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

type Flat = Map<string, string>;
type Projection = { input: ReferenceEntryInput; flat: Flat };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deterministic JSON (sorted object keys), as library-ops compares values. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const fold = (key: string) => key.toLowerCase();

function flatten(input: ReferenceEntryInput, key: string): Flat {
  const flat: Flat = new Map([["key", key]]);
  for (const [field, value] of Object.entries(input.csl)) {
    if (value !== undefined && value !== null && value !== "") flat.set(`csl.${field}`, stableJson(value));
  }
  for (const [field, value] of Object.entries(input.identifiers ?? {})) {
    if (value !== undefined && !(Array.isArray(value) && !value.length)) flat.set(`id.${field}`, stableJson(value));
  }
  if (input.tags?.length) flat.set("tags", stableJson(input.tags));
  return flat;
}

/** One entry as canonical BibTeX. */
export function canonicalBibtex(entry: { key: string; csl: CslItem; identifiers?: ReferenceIdentifiers; tags?: string[] }, dialect: LatexDialect) {
  return serializeBibtex([{ key: entry.key, csl: entry.csl, identifiers: entry.identifiers, tags: entry.tags }], { dialect }).trimEnd();
}

const PROJECTION_TIME = "1970-01-01T00:00:00.000Z";

/** The projection of canonical BibTeX text (a base entry, or a library entry once written). */
function projectText(text: string, key: string): Projection | null {
  const parsed = parseBibtexWithLayout(text, { retrievedAt: PROJECTION_TIME }).result.entries[0];
  if (!parsed) return null;
  return { input: parsed.input, flat: flatten(parsed.input, key) };
}

// Library projections are recomputed only for entries that changed.
const PROJECTION_CACHE = Symbol.for("libera.bibTetherProjections");
const cacheHolder = globalThis as { [PROJECTION_CACHE]?: Map<string, { source: string; text: string; projection: Projection | null }> };
const projectionCache = cacheHolder[PROJECTION_CACHE] ??= new Map();

function libraryProjection(entry: ReferenceEntry, dialect: LatexDialect) {
  const cacheKey = `${dialect}\u0000${entry.id}`;
  const source = stableJson([entry.key, entry.csl, entry.identifiers, entry.tags]);
  const cached = projectionCache.get(cacheKey);
  if (cached?.source === source) return cached;
  const text = canonicalBibtex(entry, dialect);
  const value = { source, text, projection: projectText(text, entry.key) };
  if (projectionCache.size > 50_000) projectionCache.clear();
  projectionCache.set(cacheKey, value);
  return value;
}

/** The flat fields as one comparable string, in a stable order. */
function signature(flat: Flat) {
  return stableJson(Object.fromEntries(flat));
}

function libraryHash(entry: ReferenceEntry) {
  // Storage assigns its own commit clock, after the pure plan was calculated.
  return createHash("sha256").update(stableJson({ ...entry, updatedAt: undefined, fieldUpdatedAt: undefined })).digest("hex");
}

function withoutKey(flat: Flat) {
  return stableJson(Object.fromEntries([...flat].filter(([field]) => field !== "key")));
}

function sharedIdentifier(left: Flat, right: Flat) {
  for (const field of ["id.doi", "id.arxiv", "id.pmid"]) {
    const value = left.get(field);
    if (value !== undefined && value.toLowerCase() === right.get(field)?.toLowerCase()) return true;
  }
  return false;
}

/** Two entries added independently with one key are the same work unless their titles clearly disagree. */
function sameWork(left: Projection, right: Projection) {
  if (sharedIdentifier(left.flat, right.flat)) return true;
  const a = typeof left.input.csl.title === "string" ? left.input.csl.title : "";
  const b = typeof right.input.csl.title === "string" ? right.input.csl.title : "";
  return !a || !b || titleSimilarity(a, b) >= 0.6;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type FileItem = {
  index: number;
  key: string;
  input: ReferenceEntryInput;
  layout: BibtexEntryLayout;
  projection: Projection;
};

/** What happens to the file's block of an entry. */
type BlockAction =
  | { kind: "keep" }
  | { kind: "key" }        // rewrite the key only
  | { kind: "rewrite" }    // rewrite the entry, keeping fields Libera does not read
  | { kind: "delete" };

type Pair = {
  id: string;
  item?: FileItem;
  block: BlockAction;
  /** Append the entry to the file (it has no block yet). */
  append?: boolean;
  /** Keep this base entry as it is (a held deletion). */
  holdBase?: TetherBaseEntry;
  writeFields?: Set<string>;
};

function newEntryId() {
  return `ref_${globalThis.crypto.randomUUID()}`;
}

function eolOf(text: string) {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

export function planTetherSync(input: TetherPlanInput, reconcile = true): TetherPlan {
  const { library, base, dialect, now, prefer } = input;
  const nextId = input.newId ?? newEntryId;
  const parsed = parseBibtexWithLayout(input.fileText, { retrievedAt: now });
  const text = parsed.text;
  const warnings: string[] = [];
  const summary: TetherSummary = {
    library: { added: [], updated: [], deleted: [], renamed: [] },
    file: { added: [], updated: [], deleted: [], renamed: [] },
    conflicts: [],
    kept: [],
    decided: [],
  };

  // The file's entries Libera manages: a valid key, first of its key.
  const items: FileItem[] = [];
  const itemByKey = new Map<string, FileItem>();
  let invalidKeys = 0;
  parsed.result.entries.forEach((entry, index) => {
    const key = entry.input.key;
    if (!key) { invalidKeys += 1; return; }
    if (itemByKey.has(fold(key))) return; // parseBibtex already reports the duplicate.
    const item: FileItem = { index, key, input: entry.input, layout: parsed.layouts[index], projection: { input: entry.input, flat: flatten(entry.input, key) } };
    items.push(item);
    itemByKey.set(fold(key), item);
  });
  if (invalidKeys) warnings.push(`${invalidKeys} entr${invalidKeys === 1 ? "y has" : "ies have"} a key Libera cannot use and ${invalidKeys === 1 ? "is" : "are"} left out of the library.`);
  const duplicateKeys = parsed.result.errors.filter((error) => error.message.startsWith("Duplicate key")).length;
  if (duplicateKeys) warnings.push(`${duplicateKeys} entr${duplicateKeys === 1 ? "y repeats" : "ies repeat"} a key; make the keys unique to resume syncing.`);
  if (parsed.failures) {
    const lines = parsed.result.errors.slice(0, 3).map((error) => error.line).join(", ");
    warnings.push(`${parsed.failures} block${parsed.failures === 1 ? "" : "s"} of the file could not be read (line ${lines}). Until ${parsed.failures === 1 ? "it is" : "they are"} fixed, nothing is deleted from the library.`);
  }
  if (parsed.result.errors.length || invalidKeys) {
    warnings.push(...parsed.result.errors.slice(0, 3).map((error) => `Line ${error.line}: ${error.message}`));
    warnings.push("Fix the file's keys and parse errors to resume syncing. Neither side was changed.");
    return { blocked: true, ops: [], library, fileText: null, base: base ?? {}, summary, pendingDeletion: null, warnings };
  }

  const used = new Set<FileItem>();
  const pairs: Pair[] = [];
  const baseEntries = base ?? {};
  const baseKeys = new Set(Object.values(baseEntries).map((entry) => fold(entry.key)));
  const baseProjection = new Map<string, { lib: Projection | null; file: Projection | null }>();
  const projectionsOf = (id: string) => {
    let value = baseProjection.get(id);
    if (!value) {
      const entry = baseEntries[id];
      const lib = projectText(entry.lib, entry.key);
      const file = entry.file === undefined ? lib : projectText(entry.file, entry.key);
      value = { lib, file: file && entry.fileFields ? { ...file, flat: new Map(Object.entries(entry.fileFields)) } : file };
      baseProjection.set(id, value);
    }
    return value;
  };

  // Keys and aliases in use, kept current as keys are planned.
  const taken = new Set(takenCitationKeys(Object.values(library.entries)).map(fold));

  // Match unique identities before keys: a swap must not exchange two entries' metadata.
  const identities = new Map<string, FileItem[]>();
  const owners = new Map<FileItem, string[]>();
  const byIdentity = new Map<string, Set<FileItem>>();
  const identityKeys = (flat: Flat) => [withoutKey(flat), ...["id.doi", "id.arxiv", "id.pmid"]
    .flatMap((field) => flat.has(field) ? [`${field}:${flat.get(field)!.toLowerCase()}`] : [])];
  for (const item of items) for (const key of identityKeys(item.projection.flat)) {
    const matches = byIdentity.get(key) ?? new Set<FileItem>();
    matches.add(item);
    byIdentity.set(key, matches);
  }
  for (const id of Object.keys(baseEntries)) {
    const before = projectionsOf(id).file;
    const matches = before ? [...new Set(identityKeys(before.flat).flatMap((key) => [...byIdentity.get(key) ?? []]))] : [];
    identities.set(id, matches);
    for (const item of matches) owners.set(item, [...owners.get(item) ?? [], id]);
  }
  for (const [id, matches] of identities) {
    if (matches.length !== 1 || owners.get(matches[0])?.length !== 1) continue;
    used.add(matches[0]);
    pairs.push({ id, item: matches[0], block: { kind: "keep" } });
  }

  // 1. Entries synced before, found under their key.
  const missingFromFile: string[] = [];
  const paired = new Set(pairs.map((pair) => pair.id));
  for (const [id, entry] of Object.entries(baseEntries)) {
    if (paired.has(id)) continue;
    const item = itemByKey.get(fold(entry.key));
    if (item && !used.has(item)) {
      used.add(item);
      pairs.push({ id, item, block: { kind: "keep" } });
    } else missingFromFile.push(id);
  }

  // 2. Renamed in the file: same fields under a new key, or the same identifier.
  const renameCandidates = items.filter((item) => !used.has(item) && !baseKeys.has(fold(item.key)));
  for (const id of [...missingFromFile]) {
    const before = projectionsOf(id).file;
    if (!before) continue;
    const signature = withoutKey(before.flat);
    const matches = renameCandidates.filter((item) => !used.has(item) && (withoutKey(item.projection.flat) === signature || sharedIdentifier(item.projection.flat, before.flat)));
    if (matches.length !== 1) continue;
    used.add(matches[0]);
    missingFromFile.splice(missingFromFile.indexOf(id), 1);
    pairs.push({ id, item: matches[0], block: { kind: "keep" } });
  }
  for (const id of missingFromFile) pairs.push({ id, block: { kind: "keep" } });

  // 3. Library entries new since the last sync, matched with new file entries by key, then by identifier.
  const unbased = Object.values(library.entries).filter((entry) => !Object.hasOwn(baseEntries, entry.id))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));
  const collisions = new Set<FileItem>();
  const newPairs: Pair[] = [];
  const unmatchedLibrary: ReferenceEntry[] = [];
  for (const entry of unbased) {
    const item = itemByKey.get(fold(entry.key));
    if (item && !used.has(item) && !baseKeys.has(fold(item.key))) {
      const projection = libraryProjection(entry, dialect).projection;
      if (projection && !sameWork(projection, item.projection)) {
        collisions.add(item);
        unmatchedLibrary.push(entry);
        continue;
      }
      used.add(item);
      newPairs.push({ id: entry.id, item, block: { kind: "keep" } });
    } else unmatchedLibrary.push(entry);
  }
  const stillUnmatched: ReferenceEntry[] = [];
  for (const entry of unmatchedLibrary) {
    const projection = libraryProjection(entry, dialect).projection;
    const matches = projection ? items.filter((item) => !used.has(item) && !collisions.has(item) && !baseKeys.has(fold(item.key)) && sharedIdentifier(item.projection.flat, projection.flat)) : [];
    if (matches.length === 1) {
      used.add(matches[0]);
      newPairs.push({ id: entry.id, item: matches[0], block: { kind: "keep" } });
    } else stillUnmatched.push(entry);
  }

  const deleteOps: ReferenceLibraryOp[] = [];
  const renameOps: ReferenceLibraryOp[] = [];
  const updateOps: ReferenceLibraryOp[] = [];
  const putOps: ReferenceLibraryOp[] = [];
  const fileDeletions: Array<{ id: string; key: string }> = [];

  // Merge one entry field by field. `history` false: no base (prefer decides, or recency when not the first sync).
  function merge(pair: Pair, entry: ReferenceEntry, item: FileItem, before: { lib: Projection | null; file: Projection | null } | null) {
    const lib = libraryProjection(entry, dialect).projection;
    if (!lib) return;
    const fileFlat = item.projection.flat;
    const libFlat = lib.flat;
    const fields = new Set([...fileFlat.keys(), ...libFlat.keys()]);
    const toLibrary: string[] = [];
    let libraryWins = false;
    let keyOnly = true;
    let decided = false;
    const conflicts: Record<string, FieldAlternative[]> = {};
    for (const field of fields) {
      const fileValue = fileFlat.get(field);
      const libValue = libFlat.get(field);
      if (fileValue === libValue) continue;
      const fileChanged = before ? fileValue !== before.file?.flat.get(field) : true;
      const libChanged = before ? libValue !== before.lib?.flat.get(field) : true;
      if (!fileChanged && !libChanged) continue; // The two sides only spell it differently.
      let winner: "library" | "file";
      let conflict = false;
      if (fileChanged && !libChanged) winner = "file";
      else if (libChanged && !fileChanged) winner = "library";
      // No history: a field only one side has is kept, never removed.
      else if (!before && fileValue === undefined) winner = "library";
      else if (!before && libValue === undefined) winner = "file";
      else if (!before && !base) {
        winner = prefer; // The first sync: the user chose.
        decided = true;
      } else {
        conflict = true;
        const cslField = field.startsWith("csl.") ? field.slice(4) : null;
        const libClock = (cslField && entry.fieldUpdatedAt[cslField]) || entry.updatedAt;
        winner = input.fileModifiedAt > libClock ? "file" : "library";
      }
      if (winner === "file") toLibrary.push(field);
      else {
        libraryWins = true;
        (pair.writeFields ??= new Set()).add(field);
        if (field !== "key") keyOnly = false;
      }
      if (conflict) {
        summary.conflicts.push({ key: entry.key, field: field.replace(/^(csl|id)\./, ""), kept: winner });
        const cslField = field.startsWith("csl.") ? field.slice(4) : null;
        const losing = cslField ? (winner === "file" ? entry.csl[cslField] : item.input.csl[cslField]) : undefined;
        if (cslField && losing !== undefined) {
          const provenance: FieldProvenance = winner === "file"
            ? entry.provenance[cslField] ?? { source: "user", confidence: 1, retrievedAt: entry.fieldUpdatedAt[cslField] ?? entry.updatedAt }
            : { source: "import", confidence: 0.8, retrievedAt: input.fileModifiedAt };
          const existing = (entry.conflicts?.[cslField] ?? []).filter((alternative) => stableJson(alternative.value) !== stableJson(losing));
          conflicts[cslField] = [...existing, { value: losing, provenance }];
        }
      }
    }

    if (toLibrary.length) {
      const update: Extract<ReferenceLibraryOp, { op: "update" }> = { op: "update", id: entry.id };
      const csl: Partial<CslItem> = {};
      const removeFields: string[] = [];
      const provenance: Record<string, FieldProvenance> = {};
      let identifiers: ReferenceIdentifiers | undefined;
      for (const field of toLibrary) {
        if (field.startsWith("csl.")) {
          const name = field.slice(4);
          const value = item.input.csl[name];
          if (value === undefined) { if (name !== "type") removeFields.push(name); }
          else {
            csl[name] = value;
            const source = item.input.provenance?.[name];
            if (source) provenance[name] = source;
          }
        } else if (field.startsWith("id.")) {
          const name = field.slice(3) as keyof ReferenceIdentifiers;
          identifiers ??= structuredClone(entry.identifiers);
          const value = item.input.identifiers?.[name];
          if (value === undefined) delete identifiers[name];
          else (identifiers as Record<string, unknown>)[name] = value;
        } else if (field === "tags") {
          update.tags = item.input.tags ?? [];
        } else if (field === "key") {
          if (taken.has(fold(item.key)) && ![entry.key, ...entry.aliases].some((key) => fold(key) === fold(item.key))) {
            // The file's new key belongs to another entry (or alias): the file takes the library's key back.
            libraryWins = true;
            warnings.push(`“${item.key}” is already used in the library, so the entry was renamed back to “${entry.key}” in the file.`);
          } else {
            renameOps.push({ op: "rename-key", id: entry.id, key: item.key });
            taken.add(fold(item.key));
            summary.library.renamed.push({ from: entry.key, to: item.key });
          }
        }
      }
      if (Object.keys(csl).length) update.csl = csl;
      if (removeFields.length) update.removeFields = removeFields;
      if (Object.keys(provenance).length) update.provenance = provenance;
      if (identifiers) update.identifiers = identifiers;
      if (Object.keys(conflicts).length) update.conflicts = conflicts;
      if (Object.keys(update).length > 2) {
        updateOps.push(update);
        summary.library.updated.push(item.key);
      }
    } else if (Object.keys(conflicts).length) {
      updateOps.push({ op: "update", id: entry.id, conflicts });
    }
    if (decided) summary.decided.push(entry.key);
    if (libraryWins) {
      pair.block = { kind: keyOnly ? "key" : "rewrite" };
      if (keyOnly) summary.file.renamed.push({ from: item.key, to: entry.key });
      else summary.file.updated.push(entry.key);
    }
  }

  function importItem(item: FileItem, id = nextId()) {
    const key = taken.has(fold(item.key)) ? generateCitationKey(item.input.csl, taken) : item.key;
    taken.add(fold(key));
    const csl = item.input.csl;
    const entry: ReferenceEntry = {
      id,
      key,
      aliases: [],
      csl,
      identifiers: item.input.identifiers ?? {},
      provenance: item.input.provenance ?? {},
      status: importedEntryStatus(csl),
      attachments: [],
      ...(item.input.tags?.length ? { tags: item.input.tags } : {}),
      createdAt: now,
      updatedAt: now,
      fieldUpdatedAt: Object.fromEntries(Object.keys(csl).map((field) => [field, now])),
    };
    putOps.push({ op: "put", entry });
    summary.library.added.push(key);
    const pair: Pair = { id, item, block: { kind: key === item.key ? "keep" : "key" } };
    if (key !== item.key) summary.file.renamed.push({ from: item.key, to: key });
    return pair;
  }

  // 4. Entries synced before.
  const finalPairs: Pair[] = [];
  for (const pair of pairs) {
    const entry = library.entries[pair.id];
    const before = projectionsOf(pair.id);
    if (entry && pair.item) {
      merge(pair, entry, pair.item, before);
      finalPairs.push(pair);
    } else if (entry && !pair.item) {
      // Gone from the file.
      const lib = libraryProjection(entry, dialect).projection;
      const libChanged = !lib || !before.lib || signature(lib.flat) !== signature(before.lib.flat) ||
        (baseEntries[pair.id].libraryHash !== undefined && libraryHash(entry) !== baseEntries[pair.id].libraryHash);
      if (parsed.failures) {
        finalPairs.push({ ...pair, holdBase: baseEntries[pair.id] });
      } else if (libChanged) {
        summary.kept.push(entry.key);
        summary.file.added.push(entry.key);
        finalPairs.push({ ...pair, append: true });
      } else {
        fileDeletions.push({ id: pair.id, key: entry.key });
        finalPairs.push({ ...pair, holdBase: baseEntries[pair.id] });
      }
    } else if (!entry && pair.item) {
      // Deleted in the library.
      const fileChanged = !before.file || signature(pair.item.projection.flat) !== signature(before.file.flat) ||
        (baseEntries[pair.id].raw !== undefined && baseEntries[pair.id].raw !== text.slice(pair.item.layout.start, pair.item.layout.end));
      if (fileChanged) {
        summary.kept.push(pair.item.key);
        finalPairs.push(importItem(pair.item, pair.id));
      } else {
        summary.file.deleted.push(pair.item.key);
        finalPairs.push({ ...pair, block: { kind: "delete" } });
      }
    }
    // Gone from both: forgotten.
  }

  // Many deletions from the file at once wait for the user.
  const baseCount = Object.keys(baseEntries).length;
  const massive = fileDeletions.length > DELETION_COUNT_LIMIT && fileDeletions.length >= baseCount * DELETION_SHARE;
  const emptied = fileDeletions.length > 0 && !items.length;
  const ambiguous = fileDeletions.length > 0 && items.some((item) => !used.has(item));
  const held = fileDeletions.some((item) => baseEntries[item.id].held);
  const choice = input.deletions ?? "ask";
  let pendingDeletion: TetherPlan["pendingDeletion"] = null;
  if (fileDeletions.length && (massive || emptied || ambiguous || held) && choice === "ask") {
    pendingDeletion = { ids: fileDeletions.map((item) => item.id), keys: fileDeletions.map((item) => item.key) };
    for (const deletion of fileDeletions) {
      finalPairs.find((pair) => pair.id === deletion.id)!.holdBase = { ...baseEntries[deletion.id], held: true };
    }
    if (ambiguous) warnings.push("Entries were added and removed together. A removed entry may have been renamed and edited; review the removals to keep its notes and attachments.");
  } else if (fileDeletions.length && choice === "restore") {
    for (const deletion of fileDeletions) {
      const pair = finalPairs.find((candidate) => candidate.id === deletion.id)!;
      delete pair.holdBase;
      pair.append = true;
      summary.file.added.push(deletion.key);
    }
  } else {
    for (const deletion of fileDeletions) {
      deleteOps.push({ op: "delete", id: deletion.id });
      summary.library.deleted.push(deletion.key);
      // Its key and aliases are free for entries new in the file.
      for (const key of [library.entries[deletion.id].key, ...library.entries[deletion.id].aliases]) taken.delete(fold(key));
      const index = finalPairs.findIndex((candidate) => candidate.id === deletion.id);
      finalPairs.splice(index, 1);
    }
  }

  // 5. New on both sides with one key, or one identifier.
  for (const pair of newPairs) {
    merge(pair, library.entries[pair.id], pair.item!, null);
    finalPairs.push(pair);
  }

  // 6. New in the file.
  for (const item of items) {
    if (used.has(item)) continue;
    if (collisions.has(item)) warnings.push(`“${item.key}” in the file and in the library are different works; the file's entry got a new key.`);
    finalPairs.push(importItem(item));
  }

  // 7. New in the library.
  for (const entry of stillUnmatched) {
    finalPairs.push({ id: entry.id, block: { kind: "keep" }, append: true });
    summary.file.added.push(entry.key);
  }

  const ops = [...deleteOps, ...renameOps, ...updateOps, ...putOps];
  const next = ops.length ? applyLibraryOps(library, ops, now).library : library;

  // The file, edited in place.
  type Edit = { start: number; end: number; text: string };
  const edits: Edit[] = [];
  const appended: Array<{ entry: ReferenceEntry; restore?: string }> = [];
  const renamed = new Map(finalPairs.flatMap((pair) => pair.item && next.entries[pair.id] && pair.item.key !== next.entries[pair.id].key
    ? [[fold(pair.item.key), next.entries[pair.id].key] as const] : []));
  const removed = new Set(finalPairs.filter((pair) => pair.block.kind === "delete").map((pair) => fold(pair.item!.key)));
  for (const pair of finalPairs) {
    const entry = next.entries[pair.id];
    if (pair.append && entry) { appended.push({ entry, restore: baseEntries[pair.id]?.restore }); continue; }
    const item = pair.item;
    if (!item) continue;
    const { layout } = item;
    const crossref = layout.fields.find((field) => field.name === "crossref");
    if (crossref && removed.has(fold(crossref.value)) && entry) {
      const standalone = standaloneBlock(item, text, dialect);
      const saved = parseBibtexWithLayout(standalone);
      const source = saved.result.entries[0];
      const restored: FileItem = { ...item, input: source.input, layout: saved.layouts[0], projection: { input: source.input, flat: flatten(source.input, item.key) } };
      edits.push({ start: layout.start, end: layout.end, text: rewrittenBlock(entry, restored, saved.text, dialect, pair.writeFields) });
      continue;
    }
    if (pair.block.kind === "delete") {
      let end = layout.end;
      while (end < text.length && (text[end] === " " || text[end] === "\t")) end += 1;
      for (let newlines = 0; newlines < 2 && text[end] === "\n"; newlines += 1) end += 1;
      edits.push({ start: layout.start, end, text: "" });
    } else if (pair.block.kind === "key" && entry) {
      edits.push({ start: layout.keyStart, end: layout.keyEnd, text: entry.key });
    } else if (pair.block.kind === "rewrite" && entry) {
      edits.push({ start: layout.start, end: layout.end, text: renameCrossref(rewrittenBlock(entry, item, text, dialect, pair.writeFields), renamed) });
    }
    if (crossref && pair.block.kind !== "delete" && pair.block.kind !== "rewrite" && renamed.has(fold(crossref.value))) {
      edits.push({ start: crossref.start, end: crossref.end, text: `crossref = {${renamed.get(fold(crossref.value))}}` });
    }
  }
  let body = text;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  }
  if (appended.length) {
    const blocks = appended.sort((left, right) => left.entry.key.localeCompare(right.entry.key, "en")).map(({ entry, restore }) => {
      if (!restore) {
        const block = canonicalBibtex(entry, dialect);
        return literalMonths(block);
      }
      const saved = parseBibtexWithLayout(restore, { retrievedAt: now });
      const source = saved.result.entries[0];
      if (!source) return canonicalBibtex(entry, dialect);
      const item: FileItem = { index: 0, key: source.sourceKey, input: source.input, layout: saved.layouts[0], projection: { input: source.input, flat: flatten(source.input, source.sourceKey) } };
      return rewrittenBlock(entry, item, saved.text, dialect);
    });
    const trimmed = body.replace(/\s+$/, "");
    body = `${trimmed}${trimmed ? "\n\n" : ""}${blocks.join("\n\n")}\n`;
  }
  const changed = body !== text;
  let fileText: string | null = null;
  if (changed) {
    const eol = eolOf(input.fileText);
    fileText = `${input.fileText.startsWith("﻿") ? "﻿" : ""}${eol === "\n" ? body : body.replace(/\n/g, eol)}`;
  }

  // The base: each side's projection of every entry the two now share.
  const finalItems = new Map<string, FileItem>();
  const reparsed = changed ? parseBibtexWithLayout(body, { retrievedAt: now }) : parsed;
  reparsed.result.entries.forEach((entry, index) => {
    const key = entry.input.key;
    if (key && !finalItems.has(fold(key))) finalItems.set(fold(key), { index, key, input: entry.input, layout: reparsed.layouts[index], projection: { input: entry.input, flat: flatten(entry.input, key) } });
  });
  const nextBase: Record<string, TetherBaseEntry> = {};
  for (const pair of finalPairs) {
    if (pair.holdBase) { nextBase[pair.id] = pair.holdBase; continue; }
    const entry = next.entries[pair.id];
    const item = entry ? finalItems.get(fold(entry.key)) : undefined;
    if (!entry || !item) continue;
    const lib = libraryProjection(entry, dialect).text;
    const file = canonicalBibtex({ key: item.key, csl: item.input.csl, identifiers: item.input.identifiers, tags: item.input.tags }, dialect);
    nextBase[pair.id] = {
      key: item.key, lib, ...(file === lib ? {} : { file }), fileFields: Object.fromEntries(item.projection.flat),
      raw: reparsed.text.slice(item.layout.start, item.layout.end), restore: standaloneBlock(item, reparsed.text, dialect),
      libraryHash: libraryHash(entry),
    };
  }

  if (changed && reconcile) {
    // Rewriting a parent or a macro-using entry can change a child's resolved
    // fields. Observe those changes before acknowledging the new file hash.
    const intermediate = structuredClone(nextBase);
    for (const pair of finalPairs) {
      if (pair.item && intermediate[pair.id] && !pair.holdBase) {
        intermediate[pair.id].fileFields = { ...Object.fromEntries(pair.item.projection.flat), key: intermediate[pair.id].key };
      }
    }
    const followup = planTetherSync({ ...input, library: next, fileText: fileText!, base: intermediate }, false);
    for (const side of ["library", "file"] as const) {
      for (const key of ["added", "updated", "deleted"] as const) {
        summary[side][key] = [...new Set([...summary[side][key], ...followup.summary[side][key]])];
      }
      summary[side].renamed.push(...followup.summary[side].renamed);
    }
    return { ...followup, ops: [...ops, ...followup.ops], fileText: followup.fileText ?? fileText, summary,
      pendingDeletion, warnings: [...new Set([...warnings, ...followup.warnings])] };
  }

  return { ops, library: next, fileText, base: nextBase, summary, pendingDeletion, warnings };
}

// Several BibTeX spellings can feed one CSL field. Replace that whole group
// only when its value changes; untouched macros and crossrefs stay live.
const FIELD_VARIABLES: Record<string, string[]> = {};
for (const [fields, variables] of [
  ["title subtitle", "csl.title"], ["shorttitle", "csl.title-short"],
  ["journal journaltitle booktitle journalsubtitle booksubtitle", "csl.container-title"],
  ["shortjournal journalabbr journal-abbrev", "csl.container-title-short"],
  ["author", "csl.author"], ["editor", "csl.editor"], ["translator", "csl.translator"], ["bookauthor", "csl.container-author"],
  ["date year month day", "csl.issued csl.status"], ["pubstate", "csl.status"],
  ["urldate", "csl.accessed"], ["origdate", "csl.original-date"], ["eventdate", "csl.event-date"],
  ["publisher institution school organization", "csl.publisher"], ["address location", "csl.publisher-place"],
  ["series", "csl.collection-title"], ["eventtitle", "csl.event-title"], ["venue", "csl.event-place"],
  ["number issue eid", "csl.issue csl.number csl.collection-number csl.page"],
  ["chapter", "csl.chapter-number csl.title csl.container-title"], ["pages", "csl.page"],
  ["pagetotal", "csl.number-of-pages"], ["volumes", "csl.number-of-volumes"],
  ["language langid", "csl.language"], ["howpublished", "csl.medium csl.URL"],
  ["doi", "csl.DOI id.doi"], ["isbn", "csl.ISBN id.isbn"], ["pmid", "csl.PMID id.pmid"], ["pmcid", "csl.PMCID id.pmcid"],
  ["eprint eprinttype archiveprefix arxiv arxivid", "id.arxiv csl.PMID id.pmid csl.PMCID id.pmcid csl.DOI id.doi"],
  ["entrysubtype", "csl.type"], ["type", "csl.genre"], ["keywords", "tags"],
]) {
  for (const name of fields.split(" ")) FIELD_VARIABLES[name] = variables.split(" ");
}
for (const name of PARSED_FIELDS) FIELD_VARIABLES[name] ??= [`csl.${name}`];

function affected(name: string, changed: Set<string>, layout?: BibtexEntryLayout) {
  if (name === "crossref") return false;
  let variables = FIELD_VARIABLES[name] ?? [];
  if (layout && ["eprint", "eprinttype", "archiveprefix"].includes(name)) {
    const type = layout.fields.find((field) => field.name === "eprinttype")?.value ?? layout.fields.find((field) => field.name === "archiveprefix")?.value ?? "";
    variables = ({ pubmed: ["csl.PMID", "id.pmid"], pmc: ["csl.PMCID", "id.pmcid"], pmcid: ["csl.PMCID", "id.pmcid"], doi: ["csl.DOI", "id.doi"], arxiv: ["id.arxiv"], "": ["id.arxiv"] } as Record<string, string[]>)[type.toLowerCase()] ?? [];
  }
  return PARSED_FIELDS.has(name) && (changed.has("csl.type") || variables.some((field) => changed.has(field)));
}

function rewrittenBlock(entry: ReferenceEntry, item: FileItem, text: string, dialect: LatexDialect, writeFields?: Set<string>) {
  const block = canonicalBibtex(entry, dialect);
  const generated = parseBibtexWithLayout(block);
  const lib = libraryProjection(entry, dialect).projection!;
  const changed = writeFields ?? new Set([...lib.flat.keys(), ...item.projection.flat.keys()]
    .filter((field) => lib.flat.get(field) !== item.projection.flat.get(field)));
  const kept = item.layout.fields.filter((field) => !affected(field.name, changed, item.layout))
    .map((field) => text.slice(field.start, field.end).trimEnd());
  const added = generated.layouts[0].fields.filter((field) => affected(field.name, changed))
    .map((field) => field.name === "month" ? `month = {${field.value}}` : generated.text.slice(field.start, field.end).trimEnd());
  const header = changed.has("csl.type") ? block.slice(0, block.indexOf("{")) : text.slice(item.layout.start, item.layout.keyStart).replace(/[{(]\s*$/, "");
  const fields = [...added, ...kept];
  return `${header}{${entry.key}${fields.length ? `,\n${fields.map((field) => `  ${field}`).join(",\n")}` : ""}\n}`;
}

function literalMonths(block: string) {
  const parsed = parseBibtexWithLayout(block);
  const month = parsed.layouts[0].fields.find((field) => field.name === "month");
  return month ? block.slice(0, month.start) + `month = {${month.value}}` + block.slice(month.end) : block;
}

function renameCrossref(block: string, renamed: Map<string, string>) {
  const parsed = parseBibtexWithLayout(block);
  const field = parsed.layouts[0].fields.find((field) => field.name === "crossref");
  const key = field && renamed.get(fold(field.value));
  return field && key ? block.slice(0, field.start) + `crossref = {${key}}` + block.slice(field.end) : block;
}

/** A restored entry must not depend on macros or a parent that may now be gone. */
function standaloneBlock(item: FileItem, text: string, dialect: LatexDialect) {
  const fields = item.layout.fields.filter((field) => field.name !== "crossref");
  const variables = new Set(fields.flatMap((field) => FIELD_VARIABLES[field.name] ?? []));
  const canonical = canonicalBibtex({ key: item.key, ...item.input }, dialect);
  const generated = parseBibtexWithLayout(canonical);
  const inherited = generated.layouts[0].fields.filter((field) => !(FIELD_VARIABLES[field.name] ?? []).some((variable) => variables.has(variable)));
  const values = [...fields.map((field) => `${field.name} = {${field.value}}`),
    ...inherited.map((field) => field.name === "month" ? `month = {${field.value}}` : generated.text.slice(field.start, field.end).trimEnd())];
  const header = text.slice(item.layout.start, item.layout.keyStart).replace(/[{(]\s*$/, "");
  return `${header}{${item.key}${values.length ? `,\n${values.map((field) => `  ${field}`).join(",\n")}` : ""}\n}`;
}

/** True when the summary records any change. */
export function tetherSummaryHasChanges(summary: TetherSummary) {
  const { library, file } = summary;
  return [library.added, library.updated, library.deleted, library.renamed, file.added, file.updated, file.deleted, file.renamed]
    .some((list) => list.length > 0);
}
