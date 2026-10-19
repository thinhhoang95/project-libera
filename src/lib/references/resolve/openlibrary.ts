import { normalizeIsbn } from "../identifiers";
import { parseDateText } from "../normalize";
import { parseName } from "../names";
import type { CslItem, CslName } from "../types";
import { SOURCE_CONFIDENCE, type ResolveContext, type SourceRecord } from "./record";

// Open Library (https://openlibrary.org): `/isbn/{isbn}.json` redirects to
// the edition record; author names come from `/authors/{id}.json`, through
// the work record when the edition lists none. Google Books is not used as a
// fallback: its anonymous quota is zero in practice, so it needs an API key.

const HOST = "https://openlibrary.org";
const MAX_AUTHORS = 20;

type OpenLibraryRef = { key?: string };

export type OpenLibraryEdition = {
  key?: string;
  title?: string;
  subtitle?: string;
  authors?: OpenLibraryRef[];
  works?: OpenLibraryRef[];
  publishers?: string[];
  publish_places?: string[];
  publish_date?: string;
  number_of_pages?: number;
  edition_name?: string;
  isbn_13?: string[];
  isbn_10?: string[];
  languages?: OpenLibraryRef[];
  series?: string[];
  by_statement?: string;
};

type OpenLibraryWork = { authors?: { author?: OpenLibraryRef }[] };
type OpenLibraryAuthor = { name?: string; personal_name?: string };

const LANGUAGES: Record<string, string> = { eng: "en", fre: "fr", ger: "de", spa: "es", ita: "it", por: "pt", rus: "ru", jpn: "ja", chi: "zh", dut: "nl" };

function openLibraryDate(text: string | undefined) {
  if (!text) return undefined;
  const parsed = parseDateText(text);
  if (parsed) return parsed;
  const year = text.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1];
  return year ? { "date-parts": [[Number(year)]] as [[number]] } : undefined;
}

/** An edition plus resolved author names → a CSL book record. */
export function mapOpenLibraryEdition(edition: OpenLibraryEdition, authors: string[], isbn: string, retrievedAt: string): SourceRecord | null {
  if (!edition.title) return null;
  const csl: CslItem = { type: "book" };
  csl.title = edition.subtitle && !edition.title.includes(edition.subtitle) ? `${edition.title}: ${edition.subtitle}` : edition.title;
  const author = authors.map((name) => parseName(name)).filter((name: CslName) => Object.keys(name).length > 0);
  if (author.length) csl.author = author;
  const issued = openLibraryDate(edition.publish_date);
  if (issued) csl.issued = issued;
  if (edition.publishers?.[0]) csl.publisher = edition.publishers[0];
  if (edition.publish_places?.[0]) csl["publisher-place"] = edition.publish_places[0].replace(/[\s:;,]+$/, "");
  if (edition.number_of_pages) csl["number-of-pages"] = String(edition.number_of_pages);
  if (edition.edition_name) csl.edition = edition.edition_name.replace(/\s*ed(ition)?\.?$/i, "").trim() || edition.edition_name;
  if (edition.series?.[0]) csl["collection-title"] = edition.series[0];
  const language = edition.languages?.[0]?.key?.split("/").pop();
  if (language && LANGUAGES[language]) csl.language = LANGUAGES[language];
  const isbns = [...new Set([isbn, ...(edition.isbn_13 ?? []), ...(edition.isbn_10 ?? [])].map((value) => normalizeIsbn(value)).filter((value): value is string => !!value))];
  csl.ISBN = isbns.join(" ");
  const url = edition.key ? `${HOST}${edition.key}` : `${HOST}/isbn/${isbn}`;
  csl.URL = url;
  return {
    source: "isbn",
    confidence: SOURCE_CONFIDENCE.isbn!,
    url,
    retrievedAt,
    csl,
    identifiers: { isbn: isbns },
  };
}

function refId(ref: OpenLibraryRef | undefined, kind: "authors" | "works") {
  const id = ref?.key?.split("/").pop();
  return id && new RegExp(`^OL\\d+${kind === "authors" ? "A" : "W"}$`).test(id) ? id : undefined;
}

async function authorNames(edition: OpenLibraryEdition, ctx: ResolveContext) {
  let ids = (edition.authors ?? []).map((ref) => refId(ref, "authors")).filter((id): id is string => !!id);
  if (!ids.length) {
    const workId = refId(edition.works?.[0], "works");
    if (workId) {
      const work = await ctx.network(() => ctx.http.getJson<OpenLibraryWork>(`${HOST}/works/${workId}.json`, { signal: ctx.signal }));
      ids = (work?.authors ?? []).map((item) => refId(item.author, "authors")).filter((id): id is string => !!id);
    }
  }
  const names: string[] = [];
  for (const id of ids.slice(0, MAX_AUTHORS)) {
    const author = await ctx.network(() => ctx.http.getJson<OpenLibraryAuthor>(`${HOST}/authors/${id}.json`, { signal: ctx.signal }));
    const name = author?.name ?? author?.personal_name;
    if (name) names.push(name);
  }
  return names;
}

/** The Open Library record for an ISBN, or null when Open Library does not have it. */
export async function fetchOpenLibraryRecord(isbn: string, ctx: ResolveContext): Promise<SourceRecord | null> {
  const edition = await ctx.network(() => ctx.http.getJson<OpenLibraryEdition>(`${HOST}/isbn/${isbn}.json`, { signal: ctx.signal }));
  if (!edition?.title) return null;
  return mapOpenLibraryEdition(edition, await authorNames(edition, ctx), isbn, ctx.now().toISOString());
}
