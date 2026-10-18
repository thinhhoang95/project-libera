import { normalizeArxivId, normalizeDoi, normalizePmcid, normalizePmid } from "../identifiers";
import { parseDateText } from "../normalize";
import { parseName } from "../names";
import type { CslItem, CslItemType, CslName, ReferenceIdentifiers, ReferenceVersionLink } from "../types";
import { SOURCE_CONFIDENCE, type ResolveContext, type SourceRecord } from "./record";

// OpenAlex (https://api.openalex.org): works by DOI, arXiv DOI or PMID, and
// title search. Used to link a preprint with its published version (a work's
// `locations` list both) and for abstracts, which OpenAlex stores as an
// inverted index.

const API = "https://api.openalex.org";
const SELECT = "id,doi,title,display_name,ids,type,publication_year,publication_date,authorships,locations,primary_location,biblio,abstract_inverted_index";

type OpenAlexSource = { id?: string; display_name?: string; type?: string; issn_l?: string | null };
type OpenAlexLocation = {
  id?: string;
  doi?: string | null;
  landing_page_url?: string | null;
  pdf_url?: string | null;
  version?: string | null;
  is_published?: boolean | null;
  source?: OpenAlexSource | null;
};

export type OpenAlexWork = {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  ids?: Record<string, string | undefined>;
  type?: string;
  publication_year?: number | null;
  publication_date?: string | null;
  authorships?: { author?: { display_name?: string | null }; raw_author_name?: string | null }[];
  locations?: OpenAlexLocation[];
  primary_location?: OpenAlexLocation | null;
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null };
  abstract_inverted_index?: Record<string, number[]> | null;
};

/** The abstract text from OpenAlex's inverted index (word → positions). */
export function abstractFromInvertedIndex(index: Record<string, number[]> | null | undefined) {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) if (Number.isInteger(position) && position >= 0 && position < 100_000) words[position] = word;
  }
  const text = words.filter((word) => word !== undefined).join(" ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function openAlexType(work: OpenAlexWork): CslItemType {
  const sourceType = work.primary_location?.source?.type;
  switch (work.type) {
    case "article":
    case "review":
    case "letter":
    case "editorial":
    case "erratum":
    case "retraction":
      if (sourceType === "repository") return "article";
      if (sourceType === "conference") return "paper-conference";
      return "article-journal";
    case "preprint": return "article";
    case "book-chapter": return "chapter";
    case "book": return "book";
    case "dataset": return "dataset";
    case "dissertation": return "thesis";
    case "report": return "report";
    case "standard": return "standard";
    case "peer-review": return "review";
    case "reference-entry": return "entry-encyclopedia";
    default: return "document";
  }
}

function arxivOfLocation(location: OpenAlexLocation) {
  const candidates = [location.landing_page_url, location.pdf_url, location.doi, location.id?.replace(/^pmh:oai:arxiv\.org:/i, "arXiv:")];
  for (const candidate of candidates) {
    if (!candidate || !/arxiv/i.test(candidate)) continue;
    const id = normalizeArxivId(candidate);
    if (id) return id;
  }
  return undefined;
}

export function mapOpenAlexWork(work: OpenAlexWork, retrievedAt: string): SourceRecord | null {
  const openalex = work.id?.replace(/^https?:\/\/openalex\.org\//i, "").toUpperCase();
  if (!openalex) return null;
  const csl: CslItem = { type: openAlexType(work) };
  const title = (work.title ?? work.display_name)?.trim();
  if (title) csl.title = title;
  const author = (work.authorships ?? [])
    .map((authorship) => authorship.author?.display_name ?? authorship.raw_author_name ?? "")
    .filter(Boolean)
    .map((name) => parseName(name))
    .filter((name: CslName) => Object.keys(name).length > 0);
  if (author.length) csl.author = author;
  const issued = (work.publication_date ? parseDateText(work.publication_date) : undefined)
    ?? (work.publication_year ? { "date-parts": [[work.publication_year]] as [[number]] } : undefined);
  if (issued) csl.issued = issued;
  const source = work.primary_location?.source;
  if (source?.display_name && source.type !== "repository") csl["container-title"] = source.display_name;
  if (work.biblio?.volume) csl.volume = work.biblio.volume;
  if (work.biblio?.issue) csl.issue = work.biblio.issue;
  if (work.biblio?.first_page) {
    csl.page = work.biblio.last_page && work.biblio.last_page !== work.biblio.first_page ? `${work.biblio.first_page}-${work.biblio.last_page}` : work.biblio.first_page;
  }
  const abstract = abstractFromInvertedIndex(work.abstract_inverted_index);
  if (abstract) csl.abstract = abstract;

  const identifiers: ReferenceIdentifiers = { openalex };
  const doi = normalizeDoi(work.doi ?? work.ids?.doi);
  if (doi) {
    identifiers.doi = doi;
    csl.DOI = doi;
    csl.URL = `https://doi.org/${doi}`;
  }
  const pmid = normalizePmid(work.ids?.pmid);
  if (pmid) identifiers.pmid = pmid;
  const pmcid = normalizePmcid(work.ids?.pmcid?.replace(/^https?:\/\/[^/]+\/pmc\/articles\//i, ""));
  if (pmcid) identifiers.pmcid = pmcid;
  const locations = work.locations ?? [];
  const arxiv = (doi?.startsWith("10.48550/arxiv.") ? normalizeArxivId(doi) : undefined) ?? locations.map(arxivOfLocation).find(Boolean);
  if (arxiv) identifiers.arxiv = arxiv;

  const versions: ReferenceVersionLink[] = [];
  const isPreprintRecord = !doi || doi.startsWith("10.48550/arxiv.") || work.type === "preprint";
  if (arxiv && doi && !doi.startsWith("10.48550/arxiv.")) versions.push({ relation: "preprint-of", identifier: `arXiv:${arxiv}` });
  if (isPreprintRecord) {
    const published = locations.find((location) => location.is_published && location.doi && !/10\.48550\/arxiv\./i.test(location.doi));
    const publishedDoi = normalizeDoi(published?.doi);
    if (publishedDoi && publishedDoi !== doi) versions.push({ relation: "published-as", identifier: publishedDoi });
  }
  return {
    source: "openalex",
    confidence: SOURCE_CONFIDENCE.openalex!,
    url: `https://openalex.org/${openalex}`,
    retrievedAt,
    csl,
    identifiers,
    ...(versions.length ? { versions } : {}),
  };
}

function withCommonParams(url: URL, ctx: ResolveContext) {
  url.searchParams.set("select", SELECT);
  if (ctx.contactEmail) url.searchParams.set("mailto", ctx.contactEmail);
  return url.toString();
}

/** One work by DOI, arXiv ID (through its arXiv DOI) or PMID; null when OpenAlex does not have it. */
export async function fetchOpenAlexWork(key: { doi?: string; arxiv?: string; pmid?: string }, ctx: ResolveContext): Promise<SourceRecord | null> {
  const lookup = key.doi ? `doi:${key.doi}` : key.arxiv ? `doi:10.48550/arxiv.${key.arxiv}` : key.pmid ? `pmid:${key.pmid}` : undefined;
  if (!lookup) return null;
  const url = withCommonParams(new URL(`${API}/works/${lookup}`), ctx);
  const work = await ctx.network(() => ctx.http.getJson<OpenAlexWork>(url, { signal: ctx.signal }));
  return work ? mapOpenAlexWork(work, ctx.now().toISOString()) : null;
}

/** Up to `perPage` works matching a title or reference string. */
export async function searchOpenAlex(query: string, ctx: ResolveContext, perPage = 5): Promise<SourceRecord[]> {
  const url = new URL(`${API}/works`);
  // Commas and colons have meaning in OpenAlex filters; plain words search best.
  url.searchParams.set("search", query.replace(/[,:;|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500));
  url.searchParams.set("per-page", String(perPage));
  const payload = await ctx.network(() => ctx.http.getJson<{ results?: OpenAlexWork[] }>(withCommonParams(url, ctx), { signal: ctx.signal }));
  const retrievedAt = ctx.now().toISOString();
  return (payload?.results ?? []).map((work) => mapOpenAlexWork(work, retrievedAt)).filter((record): record is SourceRecord => !!record);
}
