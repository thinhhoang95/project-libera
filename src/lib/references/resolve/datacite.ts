import { normalizeDoi, normalizeIsbn } from "../identifiers";
import { parseDateText } from "../normalize";
import { parseName } from "../names";
import { CSL_ITEM_TYPES, type CslItem, type CslItemType, type CslName } from "../types";
import { SOURCE_CONFIDENCE, type ResolveContext, type SourceRecord } from "./record";

// DataCite REST API (https://api.datacite.org/dois/{doi}): datasets,
// software, theses and other DOIs that Crossref does not register.

const API = "https://api.datacite.org";

type DataciteName = { name?: string; nameType?: string; givenName?: string; familyName?: string };

export type DataciteAttributes = {
  doi?: string;
  creators?: DataciteName[];
  contributors?: (DataciteName & { contributorType?: string })[];
  titles?: { title?: string; titleType?: string; lang?: string }[];
  publisher?: string | { name?: string };
  publicationYear?: number | string;
  dates?: { date?: string; dateType?: string }[];
  types?: { citeproc?: string; resourceTypeGeneral?: string; resourceType?: string };
  container?: { title?: string; volume?: string; issue?: string; firstPage?: string; lastPage?: string };
  descriptions?: { description?: string; descriptionType?: string }[];
  identifiers?: { identifier?: string; identifierType?: string }[];
  url?: string;
  version?: string;
  language?: string;
};

const GENERAL_TYPES: Record<string, CslItemType> = {
  dataset: "dataset",
  software: "software",
  journalarticle: "article-journal",
  preprint: "article",
  book: "book",
  bookchapter: "chapter",
  report: "report",
  dissertation: "thesis",
  conferencepaper: "paper-conference",
  conferenceproceeding: "book",
  image: "graphic",
  audiovisual: "motion_picture",
  collection: "collection",
  standard: "standard",
  text: "document",
  other: "document",
};

function dataciteType(types: DataciteAttributes["types"]): CslItemType {
  const citeproc = types?.citeproc?.toLowerCase();
  if (citeproc && (CSL_ITEM_TYPES as readonly string[]).includes(citeproc) && citeproc !== "article") return citeproc as CslItemType;
  return GENERAL_TYPES[(types?.resourceTypeGeneral ?? "").toLowerCase()] ?? (citeproc === "article" ? "article" : "document");
}

function dataciteName(name: DataciteName): CslName | undefined {
  if (name.familyName?.trim()) {
    return { family: name.familyName.trim(), ...(name.givenName?.trim() ? { given: name.givenName.trim() } : {}) };
  }
  const full = name.name?.trim();
  if (!full) return undefined;
  if (name.nameType === "Organizational") return { literal: full };
  return parseName(full);
}

export function mapDataciteRecord(attributes: DataciteAttributes, retrievedAt: string): SourceRecord | null {
  const doi = normalizeDoi(attributes.doi);
  if (!doi) return null;
  const csl: CslItem = { type: dataciteType(attributes.types) };
  const title = (attributes.titles?.find((item) => !item.titleType) ?? attributes.titles?.[0])?.title?.trim();
  const subtitle = attributes.titles?.find((item) => item.titleType === "Subtitle")?.title?.trim();
  if (title) csl.title = subtitle && !title.includes(subtitle) ? `${title}: ${subtitle}` : title;
  const author = (attributes.creators ?? []).map(dataciteName).filter((name): name is CslName => !!name);
  if (author.length) csl.author = author;
  const editor = (attributes.contributors ?? []).filter((item) => item.contributorType === "Editor").map(dataciteName).filter((name): name is CslName => !!name);
  if (editor.length) csl.editor = editor;
  const issuedDate = attributes.dates?.find((item) => item.dateType === "Issued")?.date;
  const issued = (issuedDate ? parseDateText(issuedDate.slice(0, 10)) : undefined)
    ?? (attributes.publicationYear ? { "date-parts": [[Number(attributes.publicationYear)]] as [[number]] } : undefined);
  // An "Issued" date that disagrees with the publication year is usually a later deposit; the year wins.
  const year = Number(attributes.publicationYear);
  if (issued && Number.isFinite(year) && issued["date-parts"]?.[0]?.[0] !== year) csl.issued = { "date-parts": [[year]] };
  else if (issued) csl.issued = issued;
  const publisher = typeof attributes.publisher === "string" ? attributes.publisher : attributes.publisher?.name;
  if (publisher?.trim()) csl.publisher = publisher.trim();
  if (attributes.container?.title) csl["container-title"] = attributes.container.title;
  if (attributes.container?.volume) csl.volume = attributes.container.volume;
  if (attributes.container?.issue) csl.issue = attributes.container.issue;
  if (attributes.container?.firstPage) {
    csl.page = attributes.container.lastPage ? `${attributes.container.firstPage}-${attributes.container.lastPage}` : attributes.container.firstPage;
  }
  const abstract = attributes.descriptions?.find((item) => item.descriptionType === "Abstract")?.description?.trim();
  if (abstract) csl.abstract = abstract;
  if (attributes.version) csl.version = attributes.version;
  if (attributes.language) csl.language = attributes.language;
  const isbn = (attributes.identifiers ?? []).filter((item) => item.identifierType === "ISBN").map((item) => normalizeIsbn(item.identifier)).filter((value): value is string => !!value);
  if (isbn.length) csl.ISBN = isbn.join(" ");
  csl.DOI = doi;
  csl.URL = `https://doi.org/${doi}`;
  return {
    source: "datacite",
    confidence: SOURCE_CONFIDENCE.datacite!,
    url: `${API}/dois/${encodeURIComponent(doi)}`,
    retrievedAt,
    csl,
    identifiers: { doi, ...(isbn.length ? { isbn } : {}) },
  };
}

/** The DataCite record for a DOI, or null when DataCite does not know it. */
export async function fetchDataciteRecord(doi: string, ctx: ResolveContext): Promise<SourceRecord | null> {
  const url = `${API}/dois/${encodeURIComponent(doi)}`;
  const payload = await ctx.network(() => ctx.http.getJson<{ data?: { attributes?: DataciteAttributes } }>(url, { signal: ctx.signal, accept: "application/vnd.api+json" }));
  if (!payload?.data?.attributes) return null;
  return mapDataciteRecord(payload.data.attributes, ctx.now().toISOString());
}
