import { identifiersFromCsl, normalizeIdentifiers } from "./normalize";
import type { CslItem, CslName, FieldProvenance, ReferenceAttachment, ReferenceIdentifiers } from "./types";

// Duplicate detection and merge previews (docs/references/plan.md §4.4
// step 7). A shared identifier makes two entries the same work. Otherwise a
// fuzzy score combines title similarity, the first author's family name and
// the year (±1). Different DOIs mean different works, except when one is an
// arXiv DOI: a preprint and its published version are the same work, and
// `isPreprintPublishedPair` recognizes that case for the "one work" offer.
// Pure and dependency-free.

/** What dedupe reads from an entry; ReferenceEntry and ReferenceEntryInput fit. */
export type DedupeCandidate = {
  csl: CslItem;
  identifiers?: ReferenceIdentifiers;
};

export type DuplicateReason = "doi" | "arxiv" | "isbn" | "pmid" | "fuzzy";

const FOLDED_LETTERS: Record<string, string> = {
  ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i",
};
const COMBINING_MARKS = new RegExp(String.raw`\p{M}`, "gu");
const NON_WORD = new RegExp(String.raw`[^\p{L}\p{N}]+`, "gu");

/** Lowercase, accents and special letters folded, HTML and punctuation removed, single spaces. */
export function normalizeTitleForMatch(title: string | undefined | null) {
  if (!title) return "";
  return title
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#\d+);/g, " ")
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (letter) => FOLDED_LETTERS[letter] ?? letter)
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(NON_WORD, " ")
    .trim();
}

function bigrams(text: string) {
  const compact = text.replace(/ /g, "");
  const counts = new Map<string, number>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    const pair = compact.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

type PreparedTitle = { normalized: string; tokens: Set<string>; bigrams: Map<string, number>; bigramCount: number };

function prepareTitle(title: string | undefined): PreparedTitle {
  const normalized = normalizeTitleForMatch(title);
  const pairs = bigrams(normalized);
  let bigramCount = 0;
  for (const value of pairs.values()) bigramCount += value;
  return { normalized, tokens: new Set(normalized.split(" ").filter(Boolean)), bigrams: pairs, bigramCount };
}

function preparedSimilarity(a: PreparedTitle, b: PreparedTitle) {
  if (!a.normalized || !b.normalized) return 0;
  if (a.normalized === b.normalized) return 1;
  let sharedTokens = 0;
  for (const token of a.tokens) if (b.tokens.has(token)) sharedTokens += 1;
  const tokenDice = (2 * sharedTokens) / (a.tokens.size + b.tokens.size);
  let sharedPairs = 0;
  for (const [pair, count] of a.bigrams) sharedPairs += Math.min(count, b.bigrams.get(pair) ?? 0);
  const bigramDice = a.bigramCount + b.bigramCount ? (2 * sharedPairs) / (a.bigramCount + b.bigramCount) : 0;
  return (tokenDice + bigramDice) / 2;
}

/**
 * Title similarity in 0..1: the mean of the token Dice coefficient (word
 * order and reordering) and the character-bigram Dice coefficient (typos,
 * hyphenation, OCR noise), on `normalizeTitleForMatch` forms.
 */
export function titleSimilarity(a: string | undefined | null, b: string | undefined | null) {
  return preparedSimilarity(prepareTitle(a ?? undefined), prepareTitle(b ?? undefined));
}

function firstFamily(csl: CslItem) {
  const name: CslName | undefined = csl.author?.[0] ?? csl.editor?.[0];
  if (!name) return "";
  return normalizeTitleForMatch(name.family ?? name.literal?.split(/\s+/)[0] ?? "").replace(/ /g, "");
}

function year(csl: CslItem) {
  const value = csl.issued?.["date-parts"]?.[0]?.[0];
  if (typeof value === "number") return value;
  const match = (csl.issued?.literal ?? csl.issued?.raw ?? "").match(/\b(1\d{3}|2\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

const PART_TYPES = new Set(["chapter", "paper-conference", "entry", "entry-dictionary", "entry-encyclopedia"]);

type Prepared = {
  candidate: DedupeCandidate;
  identifiers: ReferenceIdentifiers;
  title: PreparedTitle;
  family: string;
  year: number | undefined;
};

function prepare(candidate: DedupeCandidate): Prepared {
  const fromCsl = identifiersFromCsl(candidate.csl);
  const given = normalizeIdentifiers(candidate.identifiers);
  const identifiers = { ...fromCsl, ...given, isbn: [...new Set([...(given.isbn ?? []), ...(fromCsl.isbn ?? [])])] };
  return { candidate, identifiers, title: prepareTitle(candidate.csl.title), family: firstFamily(candidate.csl), year: year(candidate.csl) };
}

function isArxivDoi(doi: string | undefined) {
  return !!doi && doi.startsWith("10.48550/arxiv.");
}

function sharedIdentifier(a: Prepared, b: Prepared): DuplicateReason | null {
  const x = a.identifiers;
  const y = b.identifiers;
  if (x.doi && x.doi === y.doi) return "doi";
  if (x.arxiv && x.arxiv === y.arxiv) return "arxiv";
  if ((x.pmid && x.pmid === y.pmid) || (x.pmcid && x.pmcid === y.pmcid)) return "pmid";
  // Chapters and papers share their book's ISBN, so an ISBN only identifies whole works.
  const parts = PART_TYPES.has(a.candidate.csl.type) || PART_TYPES.has(b.candidate.csl.type);
  if (!parts && x.isbn?.some((isbn) => y.isbn?.includes(isbn))) return "isbn";
  return null;
}

/** Title × author × year, without the identifier rules. */
function fuzzyScore(a: Prepared, b: Prepared) {
  const title = preparedSimilarity(a.title, b.title);
  if (title === 0) return 0;
  let score = title;
  if (a.family && b.family) score *= a.family === b.family ? 1 : 0.7;
  else score *= 0.95;
  if (a.year !== undefined && b.year !== undefined) {
    const gap = Math.abs(a.year - b.year);
    score *= gap === 0 ? 1 : gap === 1 ? 0.95 : 0.6;
  } else {
    score *= 0.95;
  }
  // Short generic titles ("Introduction", "Editorial") say little on their own.
  if (Math.min(a.title.tokens.size, b.title.tokens.size) <= 2) score *= 0.9;
  return Math.min(0.99, score);
}

function preparedScore(a: Prepared, b: Prepared): { score: number; reason: DuplicateReason | null } {
  const shared = sharedIdentifier(a, b);
  if (shared) return { score: 1, reason: shared };
  const x = a.identifiers;
  const y = b.identifiers;
  if (x.doi && y.doi && !isArxivDoi(x.doi) && !isArxivDoi(y.doi)) return { score: 0, reason: null };
  if (x.arxiv && y.arxiv) return { score: 0, reason: null };
  if (x.pmid && y.pmid) return { score: 0, reason: null };
  const score = fuzzyScore(a, b);
  return { score, reason: score > 0 ? "fuzzy" : null };
}

/**
 * How likely two entries are the same work, 0..1. Any shared identifier
 * (DOI, arXiv ID, PMID/PMCID, or ISBN for whole books) scores 1. Different
 * DOIs score 0 unless one is an arXiv DOI (10.48550/arXiv.*); different
 * arXiv IDs or PMIDs also score 0. Otherwise the score is the title
 * similarity, reduced when first authors differ (×0.7) or are unknown
 * (×0.95), when years differ by one (×0.95), by more (×0.6) or are unknown
 * (×0.95), and for titles of two words or fewer (×0.9). Fuzzy scores stay
 * below 1.
 */
export function duplicateScore(a: DedupeCandidate, b: DedupeCandidate): { score: number; reason: DuplicateReason | null } {
  return preparedScore(prepare(a), prepare(b));
}

/**
 * Groups of duplicates (two or more entries each, in input order) among
 * `entries`, joining every pair that scores at least `threshold` with a
 * union-find, so duplicates of duplicates end up in one group.
 */
export function findDuplicateGroups<T extends DedupeCandidate>(entries: T[], threshold = 0.9): T[][] {
  const prepared = entries.map(prepare);
  const parent = entries.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };
  for (let a = 0; a < prepared.length; a += 1) {
    for (let b = a + 1; b < prepared.length; b += 1) {
      if (find(a) === find(b)) continue;
      // Cheap prefilter: titles of very different lengths cannot reach the threshold unless an identifier matches.
      const lengthA = prepared[a].title.normalized.length;
      const lengthB = prepared[b].title.normalized.length;
      const lengthsClose = Math.min(lengthA, lengthB) >= Math.max(lengthA, lengthB) * 0.5;
      if (!lengthsClose && !sharedIdentifier(prepared[a], prepared[b])) continue;
      if (preparedScore(prepared[a], prepared[b]).score >= threshold) union(a, b);
    }
  }
  const groups = new Map<number, T[]>();
  entries.forEach((entry, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), entry]);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

const PREPRINT_SERVERS = /\b(arxiv|biorxiv|medrxiv|chemrxiv|ssrn|research square|preprints\.org|osf preprints|psyarxiv|socarxiv|eartharxiv|techrxiv|authorea)\b/i;

/**
 * True for a preprint: an arXiv DOI, a 10.1101 DOI (bioRxiv/medRxiv posted
 * content) without a journal, type `article` (CSL's preprint and working
 * paper type), a preprint server as publisher or container, or an arXiv ID
 * without a journal or a non-arXiv DOI.
 */
export function isPreprint(entry: DedupeCandidate) {
  const { csl } = entry;
  const identifiers = prepare(entry).identifiers;
  const doi = identifiers.doi;
  const container = typeof csl["container-title"] === "string" ? csl["container-title"] : "";
  const publisher = typeof csl.publisher === "string" ? csl.publisher : "";
  const journal = !!container && !PREPRINT_SERVERS.test(container);
  if (isArxivDoi(doi)) return true;
  if (doi?.startsWith("10.1101/") && !journal) return true;
  if (csl.type === "article") return true;
  if (PREPRINT_SERVERS.test(publisher) || PREPRINT_SERVERS.test(container)) return true;
  return !!identifiers.arxiv && !journal && (!doi || isArxivDoi(doi));
}

/**
 * True when `a` and `b` are one work in two versions, one a preprint
 * (`isPreprint`) and the other published: they share an arXiv ID, or their
 * title, author and year match closely (fuzzy score ≥ 0.85, ignoring the
 * different-DOI rule, since the two versions have different DOIs).
 */
export function isPreprintPublishedPair(a: DedupeCandidate, b: DedupeCandidate) {
  if (isPreprint(a) === isPreprint(b)) return false;
  const x = prepare(a);
  const y = prepare(b);
  if (x.identifiers.doi && x.identifiers.doi === y.identifiers.doi) return false;
  if (x.identifiers.arxiv && x.identifiers.arxiv === y.identifiers.arxiv) return true;
  return fuzzyScore(x, y) >= 0.85;
}

/** The fields `mergeEntryFields` reads and writes; ReferenceEntry and ReferenceEntryInput fit. */
export type MergeableEntry = DedupeCandidate & {
  provenance?: Partial<Record<string, FieldProvenance>>;
  attachments?: ReferenceAttachment[];
  tags?: string[];
  notes?: string;
};

function isMissing(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
}

function attachmentId(attachment: ReferenceAttachment) {
  return attachment.kind === "url" ? `url:${attachment.url}` : `${attachment.kind}:${attachment.path}`;
}

/**
 * A preview of merging `other` into `keep`: CSL fields `keep` lacks are
 * filled from `other` together with their provenance, missing identifiers
 * are filled (ISBNs are united), attachments and tags are united, and notes
 * are taken when `keep` has none. Nothing `keep` already has is overwritten,
 * and its key, id, status and everything else stay as they are. The
 * storage lane's `merge` op performs the real merge; this pure helper lets
 * the UI show what it would produce.
 */
export function mergeEntryFields<T extends MergeableEntry>(keep: T, other: MergeableEntry): T {
  const csl: CslItem = { ...keep.csl };
  const provenance: Partial<Record<string, FieldProvenance>> = { ...(keep.provenance ?? {}) };
  for (const [field, value] of Object.entries(other.csl)) {
    if (field === "type" || isMissing(value) || !isMissing(csl[field])) continue;
    csl[field] = value;
    const source = other.provenance?.[field];
    if (source) provenance[field] = source;
    else delete provenance[field];
  }
  const identifiers: ReferenceIdentifiers = { ...(keep.identifiers ?? {}) };
  for (const [field, value] of Object.entries(other.identifiers ?? {}) as Array<[keyof ReferenceIdentifiers, ReferenceIdentifiers[keyof ReferenceIdentifiers]]>) {
    if (field === "isbn") continue;
    if (isMissing(identifiers[field]) && !isMissing(value)) (identifiers as Record<string, unknown>)[field] = value;
  }
  const isbn = [...new Set([...(keep.identifiers?.isbn ?? []), ...(other.identifiers?.isbn ?? [])])];
  if (isbn.length) identifiers.isbn = isbn;

  const result: T = { ...keep, csl, identifiers };
  if (Object.keys(provenance).length || keep.provenance) result.provenance = provenance;
  const attachments = [...(keep.attachments ?? [])];
  const seen = new Set(attachments.map(attachmentId));
  for (const attachment of other.attachments ?? []) {
    if (!seen.has(attachmentId(attachment))) {
      seen.add(attachmentId(attachment));
      attachments.push(attachment);
    }
  }
  if (attachments.length || keep.attachments) result.attachments = attachments;
  const tags = [...(keep.tags ?? [])];
  const folded = new Set(tags.map((tag) => tag.toLowerCase()));
  for (const tag of other.tags ?? []) {
    if (!folded.has(tag.toLowerCase())) {
      folded.add(tag.toLowerCase());
      tags.push(tag);
    }
  }
  if (tags.length || keep.tags) result.tags = tags;
  if (isMissing(keep.notes) && !isMissing(other.notes)) result.notes = other.notes;
  return result;
}
