import { normalizeDoi, normalizeIsbn } from "../identifiers";
import { parseName } from "../names";
import type { CslDate, CslItem, CslItemType, CslName, ReferenceVersionLink } from "../types";
import { SOURCE_CONFIDENCE, versionIdentifier, type ResolveContext, type SourceRecord } from "./record";

// Crossref REST API (https://api.crossref.org): `/works/{doi}` for a DOI and
// `/works?query.bibliographic=…` for a reference string or title. Records
// map to CSL with per-field provenance; `relation` and `update-to` become
// version links and `short-container-title` the journal abbreviation.

const API = "https://api.crossref.org";

type CrossrefDateParts = { "date-parts"?: (number | null)[][] };
type CrossrefName = { given?: string; family?: string; name?: string; suffix?: string; sequence?: string };
type CrossrefRelation = { "id-type"?: string; id?: string };

export type CrossrefWork = {
  DOI?: string;
  type?: string;
  title?: string[];
  subtitle?: string[];
  "original-title"?: string[];
  author?: CrossrefName[];
  editor?: CrossrefName[];
  translator?: CrossrefName[];
  issued?: CrossrefDateParts;
  published?: CrossrefDateParts;
  "published-print"?: CrossrefDateParts;
  "published-online"?: CrossrefDateParts;
  "container-title"?: string[];
  "short-container-title"?: string[];
  "event"?: { name?: string; location?: string };
  volume?: string;
  issue?: string;
  page?: string;
  "article-number"?: string;
  publisher?: string;
  "publisher-location"?: string;
  ISSN?: string[];
  ISBN?: string[];
  "isbn-type"?: { value?: string; type?: string }[];
  URL?: string;
  abstract?: string;
  language?: string;
  edition?: string | number;
  relation?: Record<string, CrossrefRelation[] | undefined>;
  "update-to"?: { DOI?: string; type?: string }[];
  "updated-by"?: { DOI?: string; type?: string }[];
  institution?: { name?: string }[];
  score?: number;
};

const TYPES: Record<string, CslItemType> = {
  "journal-article": "article-journal",
  "proceedings-article": "paper-conference",
  "book-chapter": "chapter",
  "book-section": "chapter",
  "book-part": "chapter",
  "book": "book",
  "monograph": "book",
  "edited-book": "book",
  "reference-book": "book",
  "book-set": "book",
  "book-series": "book",
  "posted-content": "article",
  "dataset": "dataset",
  "report": "report",
  "report-series": "report",
  "dissertation": "thesis",
  "peer-review": "review",
  "standard": "standard",
  "reference-entry": "entry-encyclopedia",
  "journal-issue": "periodical",
  "journal-volume": "periodical",
  "journal": "periodical",
  "proceedings": "book",
  "component": "document",
  "other": "document",
};

/** Crossref relation types → how the related work stands to this one. */
const RELATIONS: Record<string, ReferenceVersionLink["relation"]> = {
  "has-preprint": "preprint-of",
  "is-preprint-of": "published-as",
};

/** Crossref update types → version link relations. */
function updateRelation(type: string | undefined): ReferenceVersionLink["relation"] | undefined {
  const value = (type ?? "").toLowerCase();
  if (/retraction|withdrawal|removal/.test(value)) return "retraction";
  if (/erratum/.test(value)) return "erratum";
  if (/correction|corrigendum|addendum|clarification/.test(value)) return "correction";
  return undefined;
}

export function crossrefDate(value: CrossrefDateParts | undefined): CslDate | undefined {
  const parts = value?.["date-parts"]?.[0]?.filter((part): part is number => typeof part === "number");
  if (!parts?.length) return undefined;
  return { "date-parts": [parts.slice(0, 3) as [number, number?, number?]] };
}

function crossrefName(name: CrossrefName): CslName | undefined {
  if (name.family) {
    const parsed: CslName = { family: name.family.trim() };
    if (name.given?.trim()) parsed.given = name.given.trim();
    if (name.suffix?.trim()) parsed.suffix = name.suffix.trim();
    return parsed;
  }
  if (name.name?.trim()) return { literal: name.name.trim() };
  if (name.given?.trim()) return parseName(name.given);
  return undefined;
}

function names(list: CrossrefName[] | undefined) {
  const result = (list ?? []).map(crossrefName).filter((name): name is CslName => !!name);
  return result.length ? result : undefined;
}

/** JATS abstract markup → plain paragraphs. */
export function stripJats(text: string) {
  return text
    .replace(/<jats:title>[\s\S]*?<\/jats:title>/gi, "")
    .replace(/<\/(?:jats:)?p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function mapCrossrefWork(work: CrossrefWork, retrievedAt: string): SourceRecord | null {
  const doi = normalizeDoi(work.DOI);
  if (!doi) return null;
  const type = TYPES[work.type ?? ""] ?? "document";
  const csl: CslItem = { type };
  let title = work.title?.[0]?.trim();
  const subtitle = work.subtitle?.[0]?.trim();
  if (title && subtitle && !title.toLowerCase().includes(subtitle.toLowerCase())) title = `${title}: ${subtitle}`;
  if (title) csl.title = title;
  const author = names(work.author);
  if (author) csl.author = author;
  const editor = names(work.editor);
  if (editor) csl.editor = editor;
  const translator = names(work.translator);
  if (translator) csl.translator = translator;
  const issued = crossrefDate(work.issued) ?? crossrefDate(work["published-print"]) ?? crossrefDate(work["published-online"]) ?? crossrefDate(work.published);
  if (issued) csl.issued = issued;
  const container = work["container-title"]?.[0]?.trim();
  if (container) csl["container-title"] = container;
  const short = work["short-container-title"]?.[0]?.trim();
  if (short && short !== container) csl["container-title-short"] = short;
  if (work.event?.name) csl["event-title"] = work.event.name;
  if (work.event?.location) csl["event-place"] = work.event.location;
  if (work.volume) csl.volume = String(work.volume);
  if (work.issue) csl.issue = String(work.issue);
  if (work.page) csl.page = work.page;
  else if (work["article-number"]) csl.number = work["article-number"];
  if (work.publisher) csl.publisher = work.publisher;
  if (work["publisher-location"]) csl["publisher-place"] = work["publisher-location"];
  if (work.ISSN?.length) csl.ISSN = work.ISSN.join(" ");
  const isbn = [...new Set([...(work["isbn-type"] ?? []).map((item) => item.value), ...(work.ISBN ?? [])].map((value) => normalizeIsbn(value)).filter((value): value is string => !!value))];
  if (isbn.length && (type === "book" || type === "chapter" || type === "report")) csl.ISBN = isbn.join(" ");
  if (work.abstract) {
    const abstract = stripJats(work.abstract);
    if (abstract) csl.abstract = abstract;
  }
  if (work.language) csl.language = work.language;
  if (work.edition !== undefined && work.edition !== "") csl.edition = String(work.edition);
  if (type === "report" && work.institution?.[0]?.name && !csl.publisher) csl.publisher = work.institution[0].name;
  csl.DOI = doi;
  csl.URL = `https://doi.org/${doi}`;

  const versions: ReferenceVersionLink[] = [];
  for (const [kind, relations] of Object.entries(work.relation ?? {})) {
    const relation = RELATIONS[kind];
    if (!relation) continue;
    for (const item of relations ?? []) {
      if (!item.id) continue;
      const idType = (item["id-type"] ?? "").toLowerCase();
      if (idType !== "doi" && idType !== "arxiv" && idType !== "uri") continue;
      versions.push({ relation, identifier: versionIdentifier(item.id) });
    }
  }
  // A notice (erratum, retraction) names the work it amends in `update-to`;
  // newer records also list their own notices in `updated-by`.
  for (const update of [...(work["update-to"] ?? []), ...(work["updated-by"] ?? [])]) {
    const relation = updateRelation(update.type);
    const target = normalizeDoi(update.DOI);
    if (relation && target && target !== doi) versions.push({ relation, identifier: target });
  }

  return {
    source: "crossref",
    confidence: SOURCE_CONFIDENCE.crossref!,
    url: `${API}/works/${encodeURIComponent(doi)}`,
    retrievedAt,
    csl,
    identifiers: { doi, ...(isbn.length ? { isbn } : {}) },
    ...(versions.length ? { versions } : {}),
  };
}

function withMailto(url: URL, ctx: ResolveContext) {
  if (ctx.contactEmail) url.searchParams.set("mailto", ctx.contactEmail);
  return url.toString();
}

/** The Crossref record for a DOI, or null when Crossref does not know it (for example a DataCite DOI). */
export async function fetchCrossrefWork(doi: string, ctx: ResolveContext): Promise<SourceRecord | null> {
  const url = withMailto(new URL(`${API}/works/${encodeURIComponent(doi)}`), ctx);
  const payload = await ctx.network(() => ctx.http.getJson<{ message?: CrossrefWork }>(url, { signal: ctx.signal }));
  if (!payload?.message) return null;
  return mapCrossrefWork(payload.message, ctx.now().toISOString());
}

const SEARCH_SELECT = [
  "DOI", "title", "subtitle", "author", "editor", "issued", "published", "published-print", "published-online",
  "container-title", "short-container-title", "type", "volume", "issue", "page", "publisher", "ISSN", "ISBN",
  "URL", "relation", "abstract", "score",
].join(",");

/** Up to `rows` Crossref matches for a reference string or title, best first. */
export async function searchCrossref(query: string, ctx: ResolveContext, rows = 5): Promise<SourceRecord[]> {
  const url = new URL(`${API}/works`);
  url.searchParams.set("query.bibliographic", query.slice(0, 1000));
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("select", SEARCH_SELECT);
  const payload = await ctx.network(() => ctx.http.getJson<{ message?: { items?: CrossrefWork[] } }>(withMailto(url, ctx), { signal: ctx.signal }));
  const retrievedAt = ctx.now().toISOString();
  return (payload?.message?.items ?? []).map((work) => mapCrossrefWork(work, retrievedAt)).filter((record): record is SourceRecord => !!record);
}
