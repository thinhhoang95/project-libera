import { parseBibtex } from "../bibtex";
import { parseCslJson } from "../csl-json";
import { duplicateScore, isPreprintPublishedPair, normalizeTitleForMatch, type DuplicateReason } from "../dedupe";
import { classifyReferenceInput, extractIdentifiers, normalizeDoi, splitBibliography } from "../identifiers";
import { identifiersFromCsl, normalizeEntryInput, normalizeIdentifiers, type ReferenceParseResult } from "../normalize";
import { emptyReferenceLibrary } from "../library-ops";
import { parseRis } from "../ris";
import type { CslItem, FieldProvenance, ReferenceEntryInput, ReferenceIdentifiers, ReferenceLibrary, ReferenceLibraryOp } from "../types";
import { getReferenceHttpClient, isAbortError, type HttpClient } from "./http";
import { mapWithConcurrency, unlimited, type Limiter } from "./limit";
import { aiConfigured, extractionToInput, lookupWithWeb, parseReferenceWithModel, type CompletionFn } from "./llm";
import { lookupArxiv, lookupDoi, lookupIdentifiers, lookupIsbn, lookupPmcid, lookupPmid, onlineAllowed, searchBibliographic, type ResolveEnvironment } from "./lookup";
import { resolveMarkdownFile, type MarkdownResolveDeps } from "./markdown";
import { scoreReferenceText } from "./match";
import { resolvePdfFile, type PdfResolveDeps } from "./pdf";
import { combineInputs, compactInput, fillFieldProvenance, identifierSupplier, type ResolveContext } from "./record";
import { getReferenceResolveSettings, type ReferenceResolveSettings } from "./settings";
import { fetchPageMetadata, pageMetadataToInput } from "./url";

// The resolution pipeline (docs/references/plan.md §4.4): identify → fetch
// authoritative metadata → normalize → dedupe. Nothing here writes to the
// library; the resolve route returns candidates and the jobs runner commits
// them. Cancelling `signal` aborts every upstream request and model call.

/** Candidates at or above this duplicateScore against a library entry are reported as duplicates. */
export const DUPLICATE_THRESHOLD = 0.9;
/** Items of a pasted bibliography resolved at once. */
export const BIBLIOGRAPHY_CONCURRENCY = 4;
const PARSE_ONLY_CONFIDENCE = 0.2;

export type ResolveOptions = {
  /** The notebook's library: duplicates are reported against it, and Markdown siblings found in it. */
  library?: ReferenceLibrary;
  /** Let the model search the web. Defaults to the "Allow web search by default" preference. */
  webSearch?: boolean;
  /** Look up parsed BibTeX/RIS/CSL-JSON entries that have a DOI, to fill gaps and show disagreements. */
  enrich?: boolean;
  signal?: AbortSignal;
  settings?: ReferenceResolveSettings;
  http?: HttpClient;
  complete?: CompletionFn;
  now?: () => Date;
  /** Shared limits for network lookups and model calls (the jobs runner passes its own). */
  limits?: { network?: Limiter; llm?: Limiter };
  pdf?: PdfResolveDeps;
  markdown?: MarkdownResolveDeps;
};

export type ResolveDuplicate = {
  candidateIndex: number;
  entryId: string;
  reason: DuplicateReason | "preprint-published";
  score: number;
  /** The candidate and the entry are the preprint and the published version of one work. */
  preprintPair?: boolean;
};

export type ResolveResult = {
  candidates: ReferenceEntryInput[];
  duplicates: ResolveDuplicate[];
  /** Ops instead of candidates, e.g. attaching a converted Markdown file to its PDF's entry. */
  updates: ReferenceLibraryOp[];
  /** What could not be done (a source unreachable, lookups turned off, no text layer). */
  warnings: string[];
};

export function createResolveEnvironment(options: ResolveOptions = {}): ResolveEnvironment {
  const settings = options.settings ?? getReferenceResolveSettings();
  const warnings: string[] = [];
  const keyAvailable = !!options.complete || aiConfigured();
  if (settings.useAi && !keyAvailable) warnings.push("AI is allowed in Preferences, but no OpenRouter key is configured.");
  const ctx: ResolveContext = {
    http: options.http ?? getReferenceHttpClient(),
    signal: options.signal,
    contactEmail: settings.contactEmail || undefined,
    now: options.now ?? (() => new Date()),
    network: options.limits?.network ?? unlimited,
    llm: options.limits?.llm ?? unlimited,
  };
  return {
    ctx,
    settings,
    webSearch: options.webSearch ?? settings.webSearchDefault,
    aiAvailable: settings.useAi && keyAvailable,
    complete: options.complete,
    warnings,
  };
}

function rethrowAbort(error: unknown, env: ResolveEnvironment) {
  if (isAbortError(error) || env.ctx.signal?.aborted) throw error;
}

// ---------------------------------------------------------------------------
// Parse-only candidates
// ---------------------------------------------------------------------------

function parseOnly(csl: CslItem, retrievedAt: string, identifiers?: ReferenceIdentifiers, source: FieldProvenance["source"] = "import", confidence = PARSE_ONLY_CONFIDENCE): ReferenceEntryInput {
  const provenance: Record<string, FieldProvenance> = {};
  for (const field of Object.keys(csl)) provenance[field] = { source, confidence, retrievedAt };
  const input = fillFieldProvenance(normalizeEntryInput({ csl, ...(identifiers ? { identifiers } : {}), provenance }), () => ({ source, confidence, retrievedAt }));
  return compactInput({ ...input, status: "unresolved" });
}

/** A reference string read without any source: a quoted or leading title and a year. */
function referenceTextParseOnly(text: string, retrievedAt: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  const quoted = clean.match(/[“"]([^”"]{8,})[”"]/)?.[1];
  const csl: CslItem = { type: "document", title: (quoted ?? clean).slice(0, 500) };
  const year = clean.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1];
  if (year) csl.issued = { "date-parts": [[Number(year)]] };
  if (!quoted && clean.length > 0) csl.note = clean.slice(0, 2_000);
  const ids = extractIdentifiers(clean);
  const identifiers: ReferenceIdentifiers = normalizeIdentifiers({ doi: ids.doi, arxiv: ids.arxiv, pmid: ids.pmid, pmcid: ids.pmcid, isbn: ids.isbn });
  return parseOnly(csl, retrievedAt, identifiers);
}

const IDENTIFIER_FIELDS = { doi: "DOI", isbn: "ISBN", pmid: "PMID", pmcid: "PMCID" } as const;

/** An identifier the sources do not know (or could not be asked about): kept as typed. */
function identifierParseOnly(kind: "doi" | "arxiv" | "isbn" | "pmid" | "pmcid", value: string, retrievedAt: string) {
  if (kind === "arxiv") return parseOnly({ type: "article", number: `arXiv:${value}`, URL: `https://arxiv.org/abs/${value}` }, retrievedAt, { arxiv: value }, "user", 1);
  const identifiers: ReferenceIdentifiers = kind === "isbn" ? { isbn: [value] } : { [kind]: value };
  return parseOnly({ type: kind === "isbn" ? "book" : "document", [IDENTIFIER_FIELDS[kind]]: value }, retrievedAt, identifiers, "user", 1);
}

// ---------------------------------------------------------------------------
// Reference strings and URLs
// ---------------------------------------------------------------------------

async function webCandidate(description: string, env: ResolveEnvironment) {
  if (!env.aiAvailable || !env.webSearch) return null;
  try {
    const result = await lookupWithWeb(description, { ctx: env.ctx, complete: env.complete });
    if (result.downgraded.length) env.warnings.push(`Unverified web fields (the cited page was not consulted): ${result.downgraded.join(", ")}.`);
    if (result.dropped.length) env.warnings.push(`Dropped web fields citing pages that were not consulted: ${result.dropped.join(", ")}.`);
    return result.input;
  } catch (error) {
    rethrowAbort(error, env);
    env.warnings.push(`Web search failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** One reference string: its identifiers, else a bibliographic search, else the model (with the web when allowed), else parse-only. */
export async function resolveReferenceText(text: string, env: ResolveEnvironment): Promise<ReferenceEntryInput> {
  const retrievedAt = env.ctx.now().toISOString();
  const ids = extractIdentifiers(text);
  const identifiers = normalizeIdentifiers({ doi: ids.doi, arxiv: ids.arxiv, pmid: ids.pmid, pmcid: ids.pmcid, isbn: ids.isbn });
  if (Object.keys(identifiers).length && onlineAllowed(env)) {
    const found = await lookupIdentifiers(identifiers, env);
    if (found) return compactInput({ ...found, status: "needs-review" });
  }
  const match = await searchBibliographic(text, {}, env, (record) => scoreReferenceText(text, record.csl));
  if (match) return compactInput({ ...match.input, status: "needs-review" });
  const web = await webCandidate(`Reference: ${text}`, env);
  if (web) return web;
  if (env.aiAvailable) {
    try {
      const extraction = await parseReferenceWithModel(text, { ctx: env.ctx, complete: env.complete });
      if (extraction.found) return compactInput({ ...extractionToInput(extraction, { source: "llm", confidence: 0.5, retrievedAt }), status: "unresolved" });
    } catch (error) {
      rethrowAbort(error, env);
      env.warnings.push(`The model could not parse the reference: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return referenceTextParseOnly(text, retrievedAt);
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;

/** Only public http(s) addresses are fetched; the server never requests its own network on a pasted link. */
export function isFetchableUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !PRIVATE_HOST.test(parsed.hostname) && !parsed.hostname.endsWith(".local") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** A web address: identifiers in it or in its meta tags, else a page candidate from the tags (or the web lookup). */
export async function resolveUrl(url: string, env: ResolveEnvironment): Promise<ReferenceEntryInput> {
  const retrievedAt = env.ctx.now().toISOString();
  const inUrl = extractIdentifiers(url);
  const identifiers = normalizeIdentifiers({ doi: inUrl.doi, arxiv: inUrl.arxiv, pmid: inUrl.pmid, pmcid: inUrl.pmcid });
  if (Object.keys(identifiers).length && onlineAllowed(env)) {
    const found = await lookupIdentifiers(identifiers, env);
    if (found) return compactInput({ ...found, status: "needs-review" });
  }
  let pageInput: ReferenceEntryInput | null = null;
  let pageTitle: string | undefined;
  if (onlineAllowed(env)) {
    if (!isFetchableUrl(url)) {
      env.warnings.push("Only public http(s) addresses are fetched.");
    } else {
      try {
        const page = await fetchPageMetadata(url, env.ctx);
        if (!page) env.warnings.push("The address is not an HTML page, or it was not found.");
        if (page) {
          pageTitle = page.title;
          const found = await lookupIdentifiers({ ...(page.doi ? { doi: page.doi } : {}), ...(page.arxiv ? { arxiv: page.arxiv } : {}), ...(page.pmid ? { pmid: page.pmid } : {}) }, env);
          if (found) return compactInput({ ...found, status: "needs-review" });
          pageInput = pageMetadataToInput(page, retrievedAt);
        }
      } catch (error) {
        rethrowAbort(error, env);
        env.warnings.push(`The page could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const web = await webCandidate(`URL: ${url}${pageTitle ? `\nPage title: ${pageTitle}` : ""}`, env);
  if (web) {
    const combined = pageInput ? combineInputs(web, [pageInput]) : web;
    return compactInput({ ...combined, attachments: [{ kind: "url", url }], status: "needs-review" });
  }
  if (pageInput) return pageInput;
  const parsed = new URL(url);
  return compactInput({ ...parseOnly({ type: "webpage", title: `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`, URL: url }, retrievedAt), attachments: [{ kind: "url", url }] });
}

// ---------------------------------------------------------------------------
// BibTeX, RIS and CSL-JSON
// ---------------------------------------------------------------------------

function hasCreatorTitleDate(csl: CslItem) {
  return !!csl.title && !!(csl.author?.length || csl.editor?.length) && !!csl.issued;
}

async function resolveStructured(kind: "bibtex" | "ris" | "csl-json", text: string, env: ResolveEnvironment, enrich: boolean) {
  const retrievedAt = env.ctx.now().toISOString();
  const parsed: ReferenceParseResult = kind === "bibtex" ? parseBibtex(text, { retrievedAt }) : kind === "ris" ? parseRis(text, { retrievedAt }) : parseCslJson(text, { retrievedAt });
  for (const error of parsed.errors) env.warnings.push(`Line ${error.line}: ${error.message}`);
  return mapWithConcurrency(parsed.entries, BIBLIOGRAPHY_CONCURRENCY, async ({ input }) => {
    // Import's rule (docs/references/progress.md): complete entries are confirmed, others need review.
    let candidate = compactInput({ ...input, status: hasCreatorTitleDate(input.csl) ? "confirmed" : "needs-review" });
    const doi = normalizeDoi(input.identifiers?.doi ?? (typeof input.csl.DOI === "string" ? input.csl.DOI : undefined));
    if (enrich && doi) {
      const authoritative = await lookupDoi(doi, env);
      // The user's own data wins; the source fills gaps and its disagreements become conflicts.
      if (authoritative) candidate = compactInput({ ...combineInputs(candidate, [authoritative]), status: candidate.status });
    }
    return candidate;
  });
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

function quickIdentifiers(input: { csl: CslItem; identifiers?: ReferenceIdentifiers }) {
  return { ...identifiersFromCsl(input.csl), ...normalizeIdentifiers(input.identifiers) };
}

/**
 * Library entries each candidate duplicates: duplicateScore ≥ 0.9 (an
 * exact identifier scores 1), plus preprint/published pairs of one work,
 * flagged `preprintPair`.
 */
export function findCandidateDuplicates(candidates: ReferenceEntryInput[], library: ReferenceLibrary | undefined): ResolveDuplicate[] {
  if (!library) return [];
  const entries = Object.values(library.entries).map((entry) => ({ entry, ids: quickIdentifiers(entry), titleLength: normalizeTitleForMatch(entry.csl.title).length }));
  const duplicates: ResolveDuplicate[] = [];
  candidates.forEach((candidate, candidateIndex) => {
    const ids = quickIdentifiers(candidate);
    const titleLength = normalizeTitleForMatch(candidate.csl.title).length;
    for (const { entry, ids: entryIds, titleLength: entryTitleLength } of entries) {
      const sameId = (ids.doi && ids.doi === entryIds.doi) || (ids.arxiv && ids.arxiv === entryIds.arxiv) || (ids.pmid && ids.pmid === entryIds.pmid) || (ids.pmcid && ids.pmcid === entryIds.pmcid) || ids.isbn?.some((isbn) => entryIds.isbn?.includes(isbn));
      // Titles of very different lengths cannot score high unless an identifier matches.
      if (!sameId && (!titleLength || !entryTitleLength || Math.min(titleLength, entryTitleLength) < Math.max(titleLength, entryTitleLength) * 0.5)) continue;
      const { score, reason } = duplicateScore(candidate, entry);
      const pair = isPreprintPublishedPair(candidate, entry);
      if (score >= DUPLICATE_THRESHOLD && reason) duplicates.push({ candidateIndex, entryId: entry.id, reason, score, ...(pair ? { preprintPair: true } : {}) });
      else if (pair) duplicates.push({ candidateIndex, entryId: entry.id, reason: "preprint-published", score, preprintPair: true });
    }
  });
  return duplicates;
}

/**
 * The last guard of "every field has a source": a field the producers left
 * without provenance takes that of the candidate's own source (its item
 * type's), and the type that of the title.
 */
function withFieldProvenance(candidate: ReferenceEntryInput) {
  const identifiers = identifierSupplier([candidate]);
  return fillFieldProvenance(candidate, (field) => field === "type" ? candidate.provenance?.title : identifiers(field) ?? candidate.provenance?.type);
}

function finish(candidates: ReferenceEntryInput[], env: ResolveEnvironment, library: ReferenceLibrary | undefined, updates: ReferenceLibraryOp[] = []): ResolveResult {
  const normalized = candidates.map((candidate) => compactInput({ ...withFieldProvenance(normalizeEntryInput(candidate)), status: candidate.status ?? "needs-review" }));
  return { candidates: normalized, duplicates: findCandidateDuplicates(normalized, library), updates, warnings: env.warnings };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Resolve what the user pasted: an identifier (DOI, arXiv, ISBN, PMID,
 * PMCID), a URL, a reference string, a whole bibliography (items resolved
 * four at a time, candidates in order), or BibTeX/RIS/CSL-JSON text (parsed;
 * with `enrich`, entries with a DOI are looked up too).
 */
export async function resolveInput(text: string, options: ResolveOptions = {}): Promise<ResolveResult> {
  const env = createResolveEnvironment(options);
  const retrievedAt = env.ctx.now().toISOString();
  const { kind, value } = classifyReferenceInput(text);
  let candidates: ReferenceEntryInput[];
  switch (kind) {
    case "doi":
    case "arxiv":
    case "isbn":
    case "pmid":
    case "pmcid": {
      const lookup = { doi: lookupDoi, arxiv: lookupArxiv, isbn: lookupIsbn, pmid: lookupPmid, pmcid: lookupPmcid }[kind];
      const found = await lookup(value!, env);
      const fallback = found ? null : await webCandidate(`${kind.toUpperCase()}: ${value}`, env);
      candidates = [found ? compactInput({ ...found, status: "needs-review" }) : fallback ?? identifierParseOnly(kind, value!, retrievedAt)];
      break;
    }
    case "url":
      candidates = [await resolveUrl(value!, env)];
      break;
    case "bibtex":
    case "ris":
    case "csl-json":
      candidates = await resolveStructured(kind, text, env, !!options.enrich);
      break;
    case "bibliography":
      candidates = await mapWithConcurrency(splitBibliography(text), BIBLIOGRAPHY_CONCURRENCY, (item) => resolveReferenceText(item, env));
      break;
    default:
      candidates = text.trim() ? [await resolveReferenceText(text.trim(), env)] : [];
  }
  return finish(candidates, env, options.library);
}

/** Resolve a PDF in the library (library-relative path). One candidate, with the PDF attached. */
export async function resolvePdf(relativePath: string, options: ResolveOptions = {}): Promise<ResolveResult> {
  const env = createResolveEnvironment(options);
  const { candidate } = await resolvePdfFile(relativePath, env, options.pdf);
  return finish([candidate], env, options.library);
}

/**
 * Resolve a Markdown file in the library. A converted `<pdf name>.md` whose
 * PDF has an entry comes back as an `attach` op in `updates`, not as a
 * candidate.
 */
export async function resolveMarkdown(relativePath: string, options: ResolveOptions = {}): Promise<ResolveResult> {
  const env = createResolveEnvironment(options);
  const library = options.library ?? emptyReferenceLibrary();
  const result = await resolveMarkdownFile(relativePath, library, env, options.markdown);
  if (result.kind === "attach") return finish([], env, options.library, [result.op]);
  return finish([result.candidate], env, options.library);
}


