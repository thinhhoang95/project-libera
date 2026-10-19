import { normalizeDoi } from "@/lib/references/identifiers";
import { fetchCrossrefWork, searchCrossref } from "@/lib/references/resolve/crossref";
import { fetchDataciteRecord } from "@/lib/references/resolve/datacite";
import { getReferenceHttpClient, isAbortError, type HttpClient } from "@/lib/references/resolve/http";
import { bestMatch, cslYear, MATCH_THRESHOLD, titleScore, titleSimilarityInText, TITLE_IN_TEXT_THRESHOLD, type MatchQuery } from "@/lib/references/resolve/match";
import { searchOpenAlex } from "@/lib/references/resolve/openalex";
import type { ResolveContext, SourceRecord } from "@/lib/references/resolve/record";
import { getReferenceResolveSettings, type ReferenceResolveSettings } from "@/lib/references/resolve/settings";
import type { ReferenceEntry } from "@/lib/references/types";
import type { SourceTextLoader } from "./evidence";
import type { SourceSummary } from "./list-citations";

// Does each cited work exist, and is its attached file the work? Deterministic,
// no model, reusing the resolution lane's source clients:
//
// - With a DOI: Crossref, then DataCite. A DOI that resolves to a work whose
//   title scores below DOI_TITLE_MISMATCH against the entry's title is
//   reported as a mismatch (the identifier names another work).
// - Without a DOI: a bibliographic search (Crossref and OpenAlex), scored with
//   match.ts; the best result must reach MATCH_THRESHOLD (0.85).
// - A work that does not resolve and has no attached file is a possibly
//   hallucinated reference. A source that could not be reached is "not
//   checked", never hallucinated.
// - An attached PDF (or Markdown file) whose first page does not contain the
//   entry's title (titleSimilarityInText below TITLE_IN_TEXT_THRESHOLD, 0.8)
//   is a metadata/attachment mismatch. This part needs no network.
//
// The online part runs only when Preferences → AI → References allows online
// lookups; otherwise the result says "existence not checked (online lookups off)".

export const DOI_TITLE_MISMATCH = 0.5;
const FIRST_PAGE_CHARS = 4_000;

export type ExistenceStatus = "resolved" | "not-found" | "unreachable" | "not-checked";

export type ExistenceResult = {
  entryId: string;
  key: string;
  status: ExistenceStatus;
  /** Where it resolved: "crossref", "datacite", "openalex". */
  source?: string;
  /** Bibliographic search score, or the DOI title score. */
  score?: number;
  possiblyHallucinated: boolean;
  /** The attached file's first page, or the DOI's work, does not match the entry. */
  mismatch?: { path?: string; similarity: number; message: string };
  message: string;
};

export type ExistenceReport = { online: boolean; note?: string; results: ExistenceResult[] };

export type ExistenceOptions = {
  settings?: ReferenceResolveSettings;
  http?: HttpClient;
  signal?: AbortSignal;
  now?: () => Date;
};

function resolveContext(options: ExistenceOptions, settings: ReferenceResolveSettings): ResolveContext {
  return {
    http: options.http ?? getReferenceHttpClient(),
    signal: options.signal,
    contactEmail: settings.contactEmail || undefined,
    now: options.now ?? (() => new Date()),
    network: (task) => task(),
    llm: (task) => task(),
  };
}

type Lookup = { record: SourceRecord | null; failed: string[] };

async function attempt<T>(label: string, failed: string[], task: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
  try { return await task(); }
  catch (error) {
    if (isAbortError(error) || signal?.aborted) throw error;
    failed.push(label);
    return null;
  }
}

async function lookupByDoi(doi: string, ctx: ResolveContext): Promise<Lookup> {
  const failed: string[] = [];
  const crossref = await attempt("Crossref", failed, () => fetchCrossrefWork(doi, ctx), ctx.signal);
  if (crossref) return { record: crossref, failed };
  const datacite = await attempt("DataCite", failed, () => fetchDataciteRecord(doi, ctx), ctx.signal);
  return { record: datacite, failed };
}

async function lookupBySearch(entry: ReferenceEntry, ctx: ResolveContext): Promise<Lookup & { score?: number }> {
  const failed: string[] = [];
  const title = entry.csl.title?.trim();
  if (!title) return { record: null, failed };
  const query: MatchQuery = { title, authors: entry.csl.author ?? entry.csl.editor, year: cslYear(entry.csl) };
  const firstAuthor = (entry.csl.author ?? entry.csl.editor)?.[0];
  const queryString = [title, firstAuthor?.family ?? firstAuthor?.literal ?? "", query.year ?? ""].filter(Boolean).join(" ");
  const [crossref, openalex] = await Promise.all([
    attempt("Crossref", failed, () => searchCrossref(queryString, ctx), ctx.signal),
    attempt("OpenAlex", failed, () => searchOpenAlex(title, ctx), ctx.signal),
  ]);
  const best = bestMatch(query, [...(crossref ?? []), ...(openalex ?? [])]);
  return best && best.score >= MATCH_THRESHOLD ? { record: best.candidate, failed, score: best.score } : { record: null, failed, ...(best ? { score: best.score } : {}) };
}

async function firstPageText(source: SourceSummary, loader: SourceTextLoader) {
  for (const file of source.files) {
    if (!file.exists || file.noText) continue;
    if (file.kind === "pdf") {
      const pages = await loader.pages(file.path);
      const text = pages?.slice(0, 2).map((page) => page.text).join("\n").trim();
      if (text) return { path: file.path, text: text.slice(0, FIRST_PAGE_CHARS) };
    } else {
      const text = (await loader.text(file.path))?.trim();
      if (text) return { path: file.path, text: text.slice(0, FIRST_PAGE_CHARS) };
    }
  }
  return null;
}

/** The attached file's first page against the entry's title (no network). */
async function attachmentMismatch(entry: ReferenceEntry, source: SourceSummary, loader: SourceTextLoader) {
  const title = entry.csl.title?.trim();
  if (!title) return undefined;
  const first = await firstPageText(source, loader);
  if (!first) return undefined;
  const similarity = titleSimilarityInText(title, first.text);
  if (similarity >= TITLE_IN_TEXT_THRESHOLD) return undefined;
  return { path: first.path, similarity, message: `The first page of ${first.path} does not show the title “${title}” (similarity ${similarity.toFixed(2)}): the file may be a different work.` };
}

export async function checkExistence(entries: ReferenceEntry[], sources: Map<string, SourceSummary>, loader: SourceTextLoader, options: ExistenceOptions = {}): Promise<ExistenceReport> {
  const settings = options.settings ?? getReferenceResolveSettings();
  const online = settings.lookupOnline;
  const ctx = resolveContext(options, settings);
  const results: ExistenceResult[] = [];
  for (const entry of entries) {
    const source = sources.get(entry.id);
    const hasFile = !!source?.files.some((file) => file.exists);
    const mismatch = source ? await attachmentMismatch(entry, source, loader) : undefined;
    const base = { entryId: entry.id, key: entry.key, ...(mismatch ? { mismatch } : {}) };
    if (!online) {
      results.push({ ...base, status: "not-checked", possiblyHallucinated: false, message: "existence not checked (online lookups off)" });
      continue;
    }
    const doi = normalizeDoi(entry.identifiers?.doi ?? (typeof entry.csl.DOI === "string" ? entry.csl.DOI : ""));
    const lookup = doi ? await lookupByDoi(doi, ctx) : await lookupBySearch(entry, ctx);
    if (lookup.record) {
      const score = doi ? titleScore(entry.csl.title, lookup.record.csl.title) : (lookup as { score?: number }).score;
      const doiMismatch = doi && entry.csl.title && lookup.record.csl.title && score !== undefined && score < DOI_TITLE_MISMATCH
        ? { similarity: score, message: `DOI ${doi} belongs to “${lookup.record.csl.title}”, not to “${entry.csl.title}”.` } : undefined;
      results.push({
        ...base, ...(doiMismatch && !mismatch ? { mismatch: doiMismatch } : {}),
        status: "resolved", source: lookup.record.source, ...(score !== undefined ? { score } : {}), possiblyHallucinated: false,
        message: doi ? `DOI ${doi} resolves at ${lookup.record.source === "datacite" ? "DataCite" : "Crossref"}.` : `Found at ${lookup.record.source === "openalex" ? "OpenAlex" : "Crossref"} (match ${(score ?? 0).toFixed(2)}).`,
      });
      continue;
    }
    if (lookup.failed.length && (doi || lookup.failed.length === 2)) {
      results.push({ ...base, status: "unreachable", possiblyHallucinated: false, message: `existence not checked (${lookup.failed.join(" and ")} could not be reached)` });
      continue;
    }
    const where = doi ? `DOI ${doi} is not registered at Crossref or DataCite` : entry.csl.title ? "no matching work at Crossref or OpenAlex" : "the entry has no title or DOI to look up";
    results.push({
      ...base, status: "not-found", possiblyHallucinated: !hasFile,
      message: hasFile ? `Not found online (${where}), but a file is attached.` : `Possibly hallucinated reference: ${where}, and no file is attached.`,
    });
  }
  return { online, ...(online ? {} : { note: "existence not checked (online lookups off)" }), results };
}
