import { normalizeTitleForMatch } from "../dedupe";
import { normalizeArxivId, normalizeDoi } from "../identifiers";
import { normalizeEntryInput } from "../normalize";
import type {
  CslItem,
  CslName,
  FieldAlternative,
  FieldProvenance,
  ProvenanceSource,
  ReferenceEntryInput,
  ReferenceIdentifiers,
  ReferenceVersionLink,
} from "../types";
import type { HttpClient } from "./http";

// What every source client returns, how a record becomes an entry input with
// per-field provenance, and how several records of one work combine: the
// first record's values win, the others fill gaps, and values that disagree
// are kept as `conflicts` for the confirmation card.

export type ResolveContext = {
  http: HttpClient;
  signal?: AbortSignal;
  /** Sent as `mailto` to Crossref and OpenAlex only when the user set one in Preferences. */
  contactEmail?: string;
  now: () => Date;
  /** Runs one network lookup; the jobs runner limits how many run at once. */
  network: <T>(task: () => Promise<T>) => Promise<T>;
  /** Runs one model call; the jobs runner limits how many run at once. */
  llm: <T>(task: () => Promise<T>) => Promise<T>;
};

/** Metadata of one work from one source. */
export type SourceRecord = {
  source: ProvenanceSource;
  /** Default confidence of every field. */
  confidence: number;
  /** The record's address at the source (API or landing page). */
  url: string;
  retrievedAt: string;
  csl: CslItem;
  identifiers: ReferenceIdentifiers;
  versions?: ReferenceVersionLink[];
  /** Per-field confidence and URL where they differ from the record's. */
  fields?: Record<string, { confidence?: number; url?: string; source?: ProvenanceSource }>;
};

export const SOURCE_CONFIDENCE: Partial<Record<ProvenanceSource, number>> = {
  crossref: 0.95,
  datacite: 0.95,
  pubmed: 0.95,
  arxiv: 0.9,
  isbn: 0.9,
  openalex: 0.85,
};

export function provenanceFor(record: SourceRecord, field: string): FieldProvenance {
  const override = record.fields?.[field];
  const url = override?.url ?? record.url;
  return {
    source: override?.source ?? record.source,
    confidence: override?.confidence ?? record.confidence,
    ...(url ? { url } : {}),
    retrievedAt: record.retrievedAt,
  };
}

/** A version-link identifier: a DOI, or `arXiv:<id>` for arXiv IDs and arXiv DOIs. */
export function versionIdentifier(value: string) {
  const doi = normalizeDoi(value);
  const arxiv = normalizeArxivId(value);
  if (arxiv && (!doi || doi.startsWith("10.48550/arxiv."))) return `arXiv:${arxiv}`;
  return doi ?? value.trim();
}

export function recordToInput(record: SourceRecord): ReferenceEntryInput {
  const provenance: Record<string, FieldProvenance> = {};
  for (const field of Object.keys(record.csl)) if (field !== "type") provenance[field] = provenanceFor(record, field);
  provenance.type = provenanceFor(record, "type");
  return normalizeEntryInput({
    csl: record.csl,
    identifiers: record.identifiers,
    provenance,
    ...(record.versions?.length ? { versions: record.versions } : {}),
  });
}

function fold(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[‐‑‒–—-]+/g, "-").replace(/\s+/g, " ").trim();
}

function families(names: unknown) {
  if (!Array.isArray(names)) return "";
  return (names as CslName[]).map((name) => normalizeTitleForMatch(name.family ?? name.literal ?? "").replace(/ /g, "")).join("|");
}

function year(date: unknown) {
  const value = (date as { "date-parts"?: unknown[][] } | undefined)?.["date-parts"]?.[0]?.[0];
  return typeof value === "number" ? value : undefined;
}

const TITLE_FIELDS = new Set(["title", "container-title", "collection-title"]);
const NAME_FIELDS = new Set(["author", "editor"]);
const DATE_FIELDS = new Set(["issued"]);
/** Fields whose disagreement is worth showing. Others only fill gaps. */
export const COMPARED_FIELDS = ["title", "author", "editor", "issued", "container-title", "volume", "issue", "page", "publisher", "DOI", "type"];

/** True when two values of `field` say different things (case, spacing, punctuation and dash style aside). */
export function valuesDiffer(field: string, a: unknown, b: unknown) {
  if (a === undefined || b === undefined) return false;
  if (TITLE_FIELDS.has(field)) return normalizeTitleForMatch(String(a)) !== normalizeTitleForMatch(String(b));
  if (NAME_FIELDS.has(field)) return families(a) !== families(b);
  if (DATE_FIELDS.has(field)) return year(a) !== year(b);
  if (typeof a === "string" && typeof b === "string") return fold(a) !== fold(b);
  return JSON.stringify(a) !== JSON.stringify(b);
}

function addConflict(conflicts: Record<string, FieldAlternative[]>, field: string, alternative: FieldAlternative) {
  const list = conflicts[field] ?? [];
  if (list.some((existing) => !valuesDiffer(field, existing.value, alternative.value))) return;
  conflicts[field] = [...list, alternative];
}

/**
 * Combine entry inputs describing one work. The first input's values win;
 * later inputs fill fields it lacks (with their provenance) and, when
 * `conflicts` is set, values that disagree on a compared field become
 * alternatives. Identifiers fill gaps, versions are united.
 */
export function combineInputs(primary: ReferenceEntryInput, others: ReferenceEntryInput[], { conflicts: recordConflicts = true } = {}): ReferenceEntryInput {
  const csl: CslItem = { ...primary.csl };
  const provenance: Record<string, FieldProvenance> = { ...(primary.provenance as Record<string, FieldProvenance> | undefined) };
  const conflicts: Record<string, FieldAlternative[]> = { ...(primary.conflicts as Record<string, FieldAlternative[]> | undefined) };
  const identifiers: ReferenceIdentifiers = { ...primary.identifiers };
  const versions: ReferenceVersionLink[] = [];
  const addVersion = (link: ReferenceVersionLink) => {
    if (!versions.some((existing) => existing.relation === link.relation && existing.identifier === link.identifier)) versions.push(link);
  };
  for (const link of primary.versions ?? []) addVersion(link);
  for (const other of others) {
    for (const [field, value] of Object.entries(other.csl)) {
      if (field === "type" || value === undefined || value === null || value === "") continue;
      const current = csl[field];
      const otherProvenance = other.provenance?.[field];
      if (current === undefined || (Array.isArray(current) && !current.length)) {
        csl[field] = value;
        if (otherProvenance) provenance[field] = otherProvenance;
      } else if (recordConflicts && COMPARED_FIELDS.includes(field) && otherProvenance && valuesDiffer(field, current, value)) {
        addConflict(conflicts, field, { value, provenance: otherProvenance });
      }
    }
    for (const [field, value] of Object.entries(other.identifiers ?? {}) as [keyof ReferenceIdentifiers, ReferenceIdentifiers[keyof ReferenceIdentifiers]][]) {
      if (field === "isbn") identifiers.isbn = [...new Set([...(identifiers.isbn ?? []), ...((value as string[] | undefined) ?? [])])];
      else if (identifiers[field] === undefined && value) (identifiers as Record<string, unknown>)[field] = value;
    }
    for (const link of other.versions ?? []) addVersion(link);
  }
  if (identifiers.isbn && !identifiers.isbn.length) delete identifiers.isbn;
  // A link to the work's own DOI says nothing. (A published entry keeps its
  // arXiv ID in `identifiers` and also links it as `preprint-of`.)
  const isPreprintItself = !!identifiers.arxiv && (!identifiers.doi || identifiers.doi.startsWith("10.48550/arxiv."));
  const ownVersions = versions.filter((link) => link.identifier !== identifiers.doi && !(isPreprintItself && link.identifier === `arXiv:${identifiers.arxiv}`));
  return compactInput(normalizeEntryInput({
    ...primary,
    csl,
    identifiers,
    provenance,
    ...(Object.keys(conflicts).length ? { conflicts } : { conflicts: undefined }),
    ...(ownVersions.length ? { versions: ownVersions } : { versions: undefined }),
  }));
}

/** The conflicts entry for a field, built from a value and its provenance. */
export function alternative(value: unknown, provenance: FieldProvenance): FieldAlternative {
  return { value, provenance };
}

/** `undefined` fields removed (library-ops rejects them). */
export function compactInput(input: ReferenceEntryInput): ReferenceEntryInput {
  const result = { ...input } as Record<string, unknown>;
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  return result as ReferenceEntryInput;
}
