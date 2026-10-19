import { normalizeArxivId, normalizeDoi } from "../identifiers";
import type { ReferenceEntryInput, ReferenceIdentifiers } from "../types";
import { fetchArxivRecord } from "./arxiv";
import { fetchCrossrefWork, searchCrossref } from "./crossref";
import { fetchDataciteRecord } from "./datacite";
import { isAbortError } from "./http";
import type { CompletionFn } from "./llm";
import { bestMatch, MATCH_THRESHOLD, type MatchQuery } from "./match";
import { fetchOpenAlexWork, searchOpenAlex } from "./openalex";
import { fetchOpenLibraryRecord } from "./openlibrary";
import { fetchPubmedRecord, pmidForPmcid } from "./pubmed";
import { combineInputs, recordToInput, type ResolveContext, type SourceRecord } from "./record";
import type { ReferenceResolveSettings } from "./settings";

// Identifier lookups and bibliographic search across the authoritative
// sources, shared by the input, PDF and Markdown paths. Every lookup returns
// an entry input with per-field provenance, or null. A failing source is
// reported in `warnings` and the next one is tried; only cancellation
// propagates.

export type ResolveEnvironment = {
  ctx: ResolveContext;
  settings: ReferenceResolveSettings;
  /** Let the model search the web for this request or job. */
  webSearch: boolean;
  /** The model may be used: allowed in Preferences and a key (or a test double) is available. */
  aiAvailable: boolean;
  complete?: CompletionFn;
  /** Human-readable notes about what could not be done. */
  warnings: string[];
};

function warn(env: ResolveEnvironment, message: string) {
  if (!env.warnings.includes(message)) env.warnings.push(message);
}

/** Runs a source call; an error other than cancellation becomes a warning and null. */
async function attempt<T>(env: ResolveEnvironment, label: string, task: () => Promise<T | null>): Promise<T | null> {
  try {
    return await task();
  } catch (error) {
    if (isAbortError(error) || env.ctx.signal?.aborted) throw error;
    warn(env, `${label} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function onlineAllowed(env: ResolveEnvironment) {
  if (env.settings.lookupOnline) return true;
  warn(env, "Online lookups are turned off in Preferences.");
  return false;
}

/** Crossref, else DataCite; OpenAlex adds the abstract and preprint links when it has the work. */
export async function lookupDoi(doiText: string, env: ResolveEnvironment): Promise<ReferenceEntryInput | null> {
  const doi = normalizeDoi(doiText);
  if (!doi || !onlineAllowed(env)) return null;
  if (doi.startsWith("10.48550/arxiv.")) return lookupArxiv(doi, env);
  const crossref = await attempt(env, "Crossref", () => fetchCrossrefWork(doi, env.ctx));
  const primary: SourceRecord | null = crossref ?? await attempt(env, "DataCite", () => fetchDataciteRecord(doi, env.ctx));
  if (!primary) return null;
  if (primary.source !== "crossref") return recordToInput(primary);
  const openalex = await attempt(env, "OpenAlex", () => fetchOpenAlexWork({ doi }, env.ctx));
  return combineInputs(recordToInput(primary), openalex ? [recordToInput(openalex)] : []);
}

/**
 * arXiv. When arXiv (or OpenAlex) knows the published version, the published
 * metadata is the candidate, carrying the arXiv ID and a `preprint-of`
 * link; the preprint only fills gaps, since its differences are versions,
 * not disagreements.
 */
export async function lookupArxiv(idText: string, env: ResolveEnvironment): Promise<ReferenceEntryInput | null> {
  const arxiv = normalizeArxivId(idText);
  if (!arxiv || !onlineAllowed(env)) return null;
  const preprint = await attempt(env, "arXiv", () => fetchArxivRecord(arxiv, env.ctx));
  let publishedDoi = preprint?.publishedDoi;
  let openalex: SourceRecord | null = null;
  if (!publishedDoi) {
    openalex = await attempt(env, "OpenAlex", () => fetchOpenAlexWork({ arxiv }, env.ctx));
    const link = openalex?.versions?.find((version) => version.relation === "published-as");
    // Only a location OpenAlex marks as published counts: the work's own DOI
    // can be a repost of the preprint under another prefix.
    publishedDoi = link ? normalizeDoi(link.identifier) : undefined;
  }
  const published = publishedDoi ? await lookupDoi(publishedDoi, env) : null;
  if (published) {
    const preprintInput = preprint ? recordToInput(preprint) : null;
    const linked: ReferenceEntryInput = {
      ...published,
      identifiers: { ...published.identifiers, arxiv },
      versions: [...(published.versions ?? []), { relation: "preprint-of", identifier: `arXiv:${arxiv}` }],
    };
    // The preprint's own DOI and URL describe the other version.
    const gaps = preprintInput ? [{ ...preprintInput, csl: Object.fromEntries(Object.entries(preprintInput.csl).filter(([field]) => !["DOI", "URL", "number", "publisher", "genre", "type"].includes(field))) as ReferenceEntryInput["csl"] }] : [];
    return combineInputs(linked, gaps, { conflicts: false });
  }
  if (!preprint) return openalex ? recordToInput(openalex) : null;
  return combineInputs(recordToInput(preprint), openalex ? [recordToInput(openalex)] : [], { conflicts: false });
}

export async function lookupPmid(pmid: string, env: ResolveEnvironment) {
  if (!onlineAllowed(env)) return null;
  const record = await attempt(env, "PubMed", () => fetchPubmedRecord(pmid, env.ctx));
  return record ? recordToInput(record) : null;
}

export async function lookupPmcid(pmcid: string, env: ResolveEnvironment) {
  if (!onlineAllowed(env)) return null;
  const pmid = await attempt(env, "PubMed", () => pmidForPmcid(pmcid, env.ctx));
  return pmid ? lookupPmid(pmid, env) : null;
}

export async function lookupIsbn(isbn: string, env: ResolveEnvironment) {
  if (!onlineAllowed(env)) return null;
  const record = await attempt(env, "Open Library", () => fetchOpenLibraryRecord(isbn, env.ctx));
  if (!record) warn(env, "Open Library has no record for this ISBN. Google Books is not queried because it needs an API key.");
  return record ? recordToInput(record) : null;
}

/** The first identifier that resolves, in the order DOI, arXiv, PMID, PMCID, ISBN. */
export async function lookupIdentifiers(identifiers: ReferenceIdentifiers, env: ResolveEnvironment) {
  if (identifiers.doi) {
    const result = await lookupDoi(identifiers.doi, env);
    if (result) return result;
  }
  if (identifiers.arxiv) {
    const result = await lookupArxiv(identifiers.arxiv, env);
    if (result) return result;
  }
  if (identifiers.pmid) {
    const result = await lookupPmid(identifiers.pmid, env);
    if (result) return result;
  }
  if (identifiers.pmcid) {
    const result = await lookupPmcid(identifiers.pmcid, env);
    if (result) return result;
  }
  for (const isbn of identifiers.isbn ?? []) {
    const result = await lookupIsbn(isbn, env);
    if (result) return result;
  }
  return null;
}

export type SearchMatch = { input: ReferenceEntryInput; score: number };

/**
 * Crossref and OpenAlex searched in parallel with `queryString`; results are
 * scored with `score` (or `scoreMatch` against `query`). The best one at or
 * above MATCH_THRESHOLD is returned, re-resolved by DOI when it has one so
 * the candidate carries the full authoritative record.
 */
export async function searchBibliographic(queryString: string, query: MatchQuery, env: ResolveEnvironment, score?: (record: SourceRecord) => number): Promise<SearchMatch | null> {
  if (!queryString.trim() || !onlineAllowed(env)) return null;
  const [crossref, openalex] = await Promise.all([
    attempt(env, "Crossref", () => searchCrossref(queryString, env.ctx)),
    attempt(env, "OpenAlex", () => searchOpenAlex(query.title ?? queryString, env.ctx)),
  ]);
  const records = [...(crossref ?? []), ...(openalex ?? [])];
  const best = score
    ? records.map((candidate) => ({ candidate, score: score(candidate) })).sort((a, b) => b.score - a.score)[0]
    : bestMatch(query, records);
  if (!best || best.score < MATCH_THRESHOLD) return null;
  const doi = best.candidate.identifiers.doi;
  const full = doi ? await lookupDoi(doi, env) : null;
  return { input: full ?? recordToInput(best.candidate), score: best.score };
}


