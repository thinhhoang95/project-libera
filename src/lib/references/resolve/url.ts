import { normalizeArxivId, normalizeDoi, normalizePmid } from "../identifiers";
import { parseName } from "../names";
import { normalizeEntryInput, parseDateText } from "../normalize";
import type { CslDate, CslItem, CslName, FieldProvenance, ReferenceEntryInput } from "../types";
import { decodeXmlEntities } from "./xml";
import { compactInput, type ResolveContext } from "./record";

// A pasted web address (docs/references/plan.md §4.4 step 1): the page is
// fetched once (HTML only, size-limited, with a timeout) and its Highwire
// `citation_*`, Dublin Core and Open Graph meta tags are read. An identifier
// among them is resolved against the authoritative sources; otherwise the
// tags make a `webpage` (or article) candidate.

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** Meta tags count as an importer's data: useful, not authoritative. */
const META_CONFIDENCE = 0.6;

export type PageMetadata = {
  url: string;
  doi?: string;
  arxiv?: string;
  pmid?: string;
  title?: string;
  authors: string[];
  date?: string;
  journal?: string;
  publisher?: string;
  siteName?: string;
  volume?: string;
  issue?: string;
  firstPage?: string;
  lastPage?: string;
  ogType?: string;
  description?: string;
  language?: string;
};

function attributes(tag: string) {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    result[match[1].toLowerCase()] = decodeXmlEntities(match[2] ?? match[3] ?? match[4] ?? "").trim();
  }
  return result;
}

/** Meta tags of an HTML page by lowercase name or property; repeated tags keep every value in order. */
export function readMetaTags(html: string) {
  const head = html.match(/<head[\s>][\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 200_000);
  const tags = new Map<string, string[]>();
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const name = (attrs.name ?? attrs.property ?? attrs.itemprop ?? "").toLowerCase();
    if (!name || !attrs.content) continue;
    tags.set(name, [...(tags.get(name) ?? []), attrs.content]);
  }
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return { tags, title: title ? decodeXmlEntities(title).replace(/\s+/g, " ").trim() : undefined, language: html.match(/<html\b[^>]*\blang\s*=\s*["']?([\w-]+)/i)?.[1] };
}

export function parsePageMetadata(html: string, url: string): PageMetadata {
  const { tags, title, language } = readMetaTags(html);
  const first = (...names: string[]) => names.map((name) => tags.get(name)?.[0]).find((value) => !!value);
  const all = (name: string) => tags.get(name) ?? [];
  const identifiers = [...all("citation_doi"), ...all("dc.identifier"), ...all("dc.identifier.doi"), ...all("prism.doi"), ...all("bepress_citation_doi")];
  const doi = identifiers.map((value) => normalizeDoi(value)).find(Boolean);
  const arxiv = normalizeArxivId(first("citation_arxiv_id")) ?? (doi?.startsWith("10.48550/arxiv.") ? normalizeArxivId(doi) : undefined);
  const pmid = normalizePmid(first("citation_pmid"));
  const authors = [...all("citation_author"), ...(all("citation_author").length ? [] : all("dc.creator"))];
  return {
    url,
    ...(doi ? { doi } : {}),
    ...(arxiv ? { arxiv } : {}),
    ...(pmid ? { pmid } : {}),
    title: first("citation_title", "dc.title", "og:title", "twitter:title") ?? title,
    authors,
    date: first("citation_publication_date", "citation_date", "citation_online_date", "dc.date", "article:published_time", "dc.date.issued"),
    journal: first("citation_journal_title", "citation_conference_title", "citation_inbook_title"),
    publisher: first("citation_publisher", "dc.publisher"),
    siteName: first("og:site_name"),
    volume: first("citation_volume"),
    issue: first("citation_issue"),
    firstPage: first("citation_firstpage"),
    lastPage: first("citation_lastpage"),
    ogType: first("og:type"),
    description: first("citation_abstract", "dc.description", "og:description", "description"),
    language: first("citation_language", "dc.language") ?? language,
  };
}

/** "2014/04/30", "2014-04-30T10:00:00Z", "30 April 2014" → CSL date. */
export function parseLooseDate(text: string | undefined): CslDate | undefined {
  if (!text) return undefined;
  const iso = text.trim().replace(/^(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?$/, (_match, year, month, day) => `${year}-${month}${day ? `-${day}` : ""}`).replace(/T.*$/, "");
  const parsed = parseDateText(iso);
  if (parsed) return parsed;
  const year = text.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1];
  return year ? { "date-parts": [[Number(year)]] } : undefined;
}

/** Fetch a page once: HTML only, at most 2 MB. Null when it is not HTML or does not exist. */
export async function fetchPageMetadata(url: string, ctx: ResolveContext): Promise<PageMetadata | null> {
  const response = await ctx.network(() => ctx.http.getText(url, {
    signal: ctx.signal,
    accept: "text/html,application/xhtml+xml;q=0.9",
    maxBytes: MAX_PAGE_BYTES,
    cache: false,
  }));
  if (!response) return null;
  if (!/html|xml/i.test(response.contentType) && !/^\s*<(?:!doctype|html)/i.test(response.text)) return null;
  return parsePageMetadata(response.text, response.url || url);
}

/** A candidate from the meta tags alone: an article when a journal is named, else a web page. */
export function pageMetadataToInput(page: PageMetadata, retrievedAt: string): ReferenceEntryInput | null {
  if (!page.title) return null;
  const isArticle = !!page.journal;
  const csl: CslItem = { type: isArticle ? "article-journal" : "webpage", title: page.title };
  const author = page.authors.map((name) => parseName(name)).filter((name: CslName) => Object.keys(name).length > 0);
  if (author.length) csl.author = author;
  const issued = parseLooseDate(page.date);
  if (issued) csl.issued = issued;
  if (isArticle) csl["container-title"] = page.journal;
  else if (page.siteName) csl["container-title"] = page.siteName;
  if (page.publisher) csl.publisher = page.publisher;
  if (page.volume) csl.volume = page.volume;
  if (page.issue) csl.issue = page.issue;
  if (page.firstPage) csl.page = page.lastPage ? `${page.firstPage}-${page.lastPage}` : page.firstPage;
  if (page.description && isArticle) csl.abstract = page.description;
  if (page.language) csl.language = page.language;
  if (page.doi) csl.DOI = page.doi;
  csl.URL = page.url;
  const accessed = new Date(retrievedAt);
  csl.accessed = { "date-parts": [[accessed.getUTCFullYear(), accessed.getUTCMonth() + 1, accessed.getUTCDate()]] };
  const provenance: Record<string, FieldProvenance> = {};
  for (const field of Object.keys(csl)) provenance[field] = { source: "import", confidence: META_CONFIDENCE, url: page.url, retrievedAt };
  return compactInput({
    ...normalizeEntryInput({ csl, provenance, attachments: [{ kind: "url", url: page.url }] }),
    status: "needs-review",
  });
}
