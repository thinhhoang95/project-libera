import { normalizeArxivId, normalizeDoi, normalizeIsbn, normalizeIssn, normalizePmcid, normalizePmid } from "./identifiers";
import { parseName } from "./names";
import { CSL_ITEM_TYPES, type CslDate, type CslItem, type CslName, type FieldProvenance, type ReferenceEntryInput, type ReferenceIdentifiers } from "./types";

// Cleanup shared by every importer and resolver: whitespace, the rich-text
// subset citeproc understands, en-dash page ranges, identifier formats,
// valid dates, structured names, and identifiers kept in sync between
// `csl` (DOI, ISBN, PMID, PMCID) and `identifiers`. Also the result shape
// and provenance helper the BibTeX, RIS and CSL-JSON parsers share.
// Pure and dependency-free.

export type ReferenceParseError = { line: number; message: string };

/** What every reference parser returns. `sourceKey` is the key or id in the source, even when it is not a valid citation key. */
export type ReferenceParseResult = {
  entries: Array<{ input: ReferenceEntryInput; sourceKey: string; line: number }>;
  errors: ReferenceParseError[];
};

/** Provenance for every field of an imported item: source "import", confidence 0.8. */
export function importProvenance(csl: CslItem, retrievedAt: string) {
  const provenance: Record<string, FieldProvenance> = {};
  for (const field of Object.keys(csl)) provenance[field] = { source: "import", confidence: 0.8, retrievedAt };
  return provenance;
}

/** CSL variables holding rich text (titles), cleaned to the citeproc subset. */
export const CSL_TITLE_FIELDS = [
  "title", "title-short", "container-title", "container-title-short", "collection-title", "event-title", "original-title",
  "volume-title", "part-title", "reviewed-title",
] as const;
export const CSL_DATE_FIELDS = ["issued", "accessed", "original-date", "event-date", "submitted", "available-date"] as const;
export const CSL_NAME_FIELDS = [
  "author", "editor", "translator", "container-author", "collection-editor", "composer", "director", "editorial-director",
  "illustrator", "interviewer", "original-author", "recipient", "reviewed-author", "chair", "compiler", "contributor",
  "curator", "executive-producer", "guest", "host", "narrator", "organizer", "performer", "producer", "script-writer",
  "series-creator",
] as const;
/** Number-like variables CSL-JSON may carry as numbers; stored as strings. */
const NUMBER_FIELDS = new Set([
  "volume", "issue", "page", "number", "edition", "number-of-pages", "number-of-volumes", "collection-number",
  "chapter-number", "version", "citation-number", "page-first", "part-number", "supplement-number", "printing-number",
]);

const COLLAPSIBLE_SPACE = /[\t\n\v\f\r \u2028\u2029]+/g;

function cleanString(text: string) {
  return text.replace(COLLAPSIBLE_SPACE, " ").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—" };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Rich text reduced to what citeproc renders: `<i> <b> <sup> <sub>`,
 * `<span class="nocase">` and small caps. `<em>`/`<strong>` become `<i>`/`<b>`,
 * other tags are removed (their text is kept), entities are decoded.
 */
export function cleanRichText(html: string) {
  if (!/[<&]/.test(html)) return cleanString(html);
  let out = "";
  const spans: boolean[] = [];
  for (const piece of html.split(/(<\/?[a-zA-Z][^<>]*>)/)) {
    const tag = piece.match(/^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^<>]*)>$/);
    if (!tag) {
      out += decodeEntities(piece);
      continue;
    }
    const closing = tag[1] === "/";
    const name = tag[2].toLowerCase();
    const attributes = tag[3];
    const simple = ({ i: "i", em: "i", b: "b", strong: "b", sup: "sup", sub: "sub" } as Record<string, string>)[name];
    if (simple) {
      out += closing ? `</${simple}>` : `<${simple}>`;
    } else if (name === "span") {
      if (closing) {
        if (spans.pop()) out += "</span>";
      } else if (/class\s*=\s*["']?nocase/i.test(attributes)) {
        spans.push(true);
        out += '<span class="nocase">';
      } else if (/font-variant\s*:\s*small-caps/i.test(attributes)) {
        spans.push(true);
        out += '<span style="font-variant:small-caps;">';
      } else {
        spans.push(false);
      }
    } else if (name === "br" || name === "p" || name.endsWith(":p")) {
      out += " ";
    }
  }
  return cleanString(out.replace(/<(i|b|sup|sub)>\s*<\/\1>/g, ""));
}

const PAGE_PART = /^[A-Za-z]{0,3}\d+[A-Za-z]?$|^[ivxlcdm]+$/i;

/** "12-14" → "12–14", "pp. 12--14" → "12–14"; single pages like "e1234" or "S12" are kept. Comma lists are handled part by part. */
export function normalizePageRange(page: string) {
  return cleanString(page)
    .replace(/^pp?\.\s*/i, "")
    .split(/\s*,\s*/)
    .map((part) => {
      const range = part.match(/^(\S+?)\s*(?:-{1,3}|[‐‑‒–—])\s*(\S+)$/);
      return range && PAGE_PART.test(range[1]) && PAGE_PART.test(range[2]) ? `${range[1]}–${range[2]}` : part;
    })
    .join(", ");
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** A month name, abbreviation or number → 1..12. */
export function parseMonth(text: string) {
  const value = text.trim().toLowerCase().replace(/\.$/, "");
  if (/^\d{1,2}$/.test(value)) {
    const month = Number(value);
    return month >= 1 && month <= 12 ? month : undefined;
  }
  return MONTHS[value.slice(0, 4)] ?? MONTHS[value.slice(0, 3)];
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

type DatePart = [number, number?, number?];

function datePart(year: number, month?: number, day?: number): DatePart {
  if (month === undefined) return [year];
  if (day === undefined) return [year, month];
  return [year, month, day];
}

function parseIsoPart(text: string): DatePart | undefined {
  const match = text.trim().match(/^(-?\d{1,4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T[\d:.]+Z?)?$/);
  if (!match) return undefined;
  return datePart(Number(match[1]), match[2] ? Number(match[2]) : undefined, match[3] ? Number(match[3]) : undefined);
}

/**
 * A date string → CSL date, or undefined. Understands ISO 8601 and
 * EDTF-like forms ("2020", "2020-05", "2020-05-12", ranges "2020-01/2020-03",
 * open ranges "2020/..", "~" and "?" qualifiers as circa), year ranges
 * ("2019–2020"), and "May 2020", "12 May 2020", "May 12, 2020".
 */
export function parseDateText(text: string): CslDate | undefined {
  let value = cleanString(text);
  if (!value) return undefined;
  let circa = false;
  if (/[~?%]/.test(value)) {
    circa = true;
    value = value.replace(/[~?%]/g, "");
  }
  const result = (parts: DatePart[]): CslDate => (circa ? { "date-parts": parts, circa: true } : { "date-parts": parts });
  const range = value.split(/\s*\/\s*|\s*(?:--|–|—)\s*/);
  if (range.length === 2) {
    const start = parseIsoPart(range[0]);
    const end = range[1] === ".." || range[1] === "" ? null : parseIsoPart(range[1]);
    if (start && end) return result([start, end]);
    if (start && end === null) return result([start]);
  }
  const single = parseIsoPart(value);
  if (single) return result([single]);
  const words = value.replace(/,/g, " ").split(/\s+/);
  if (words.length >= 2 && words.length <= 3) {
    const year = words.find((word) => /^\d{4}$/.test(word));
    const month = words.map((word) => (/^\d+$/.test(word) ? undefined : parseMonth(word))).find((part) => part !== undefined);
    const day = words.find((word) => /^\d{1,2}(?:st|nd|rd|th)?$/.test(word));
    if (year && month) return result([datePart(Number(year), month, day ? parseInt(day, 10) : undefined)]);
  }
  return undefined;
}

function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return NaN;
}

/** Drops invalid years, months and days; undefined when nothing is left. */
export function normalizeCslDate(date: unknown): CslDate | undefined {
  if (typeof date === "string") return parseDateText(date) ?? (date.trim() ? { literal: date.trim() } : undefined);
  if (!date || typeof date !== "object") return undefined;
  const source = date as CslDate & Record<string, unknown>;
  const result: CslDate = {};
  const parts: DatePart[] = [];
  for (const raw of Array.isArray(source["date-parts"]) ? source["date-parts"] : []) {
    if (!Array.isArray(raw)) continue;
    const year = toNumber(raw[0]);
    if (!Number.isInteger(year) || year === 0) continue;
    let month: number | undefined = toNumber(raw[1]);
    let day: number | undefined = toNumber(raw[2]);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      month = undefined;
      day = undefined;
    }
    if (month === undefined || !Number.isInteger(day) || day! < 1 || day! > daysInMonth(year, month)) day = undefined;
    parts.push(datePart(year, month, day));
    if (parts.length === 2) break;
  }
  if (parts.length === 2 && parts[0].join("-") === parts[1].join("-")) parts.pop();
  for (const field of ["literal", "raw"] as const) {
    if (typeof source[field] === "string" && cleanString(source[field]!)) result[field] = cleanString(source[field]!);
  }
  if (!parts.length && result.raw) {
    const parsed = parseDateText(result.raw);
    if (parsed?.["date-parts"]) {
      parts.push(...parsed["date-parts"]);
      if (parsed.circa) result.circa = true;
      delete result.raw;
    }
  }
  if (parts.length) result["date-parts"] = parts;
  if (source.season !== undefined && source.season !== "") result.season = source.season;
  if (source.circa === true || (typeof source.circa === "string" && source.circa)) result.circa = true;
  return Object.keys(result).length ? result : undefined;
}

const INITIALS = String.raw`(?:\p{Lu}\.?(?:[\s-]*\p{Lu}\.?){0,3})`;
const SURNAME = String.raw`\p{Lu}[\p{L}'’\-]+`;
const FAMILY_COMMA_INITIALS = new RegExp(String.raw`^(?:\p{Ll}+\s+)*${SURNAME},\s*${INITIALS}$`, "u");
const INITIALS_FAMILY = new RegExp(String.raw`^${INITIALS}\s+(?:\p{Ll}+\s+)*${SURNAME}$`, "u");
const FAMILY_COMMA_GIVEN = new RegExp(String.raw`^(?:\p{Ll}+\s+)*${SURNAME},\s*\p{Lu}[\p{L}'’.\-]*(?:\s+(?:\p{Lu}[\p{L}'’.\-]*))?$`, "u");

/** A literal that is really a person: "Smith, J.", "J. Smith", "Smith, Jane", "J.-P. Sartre". */
export function looksLikePersonalName(literal: string) {
  const text = cleanString(literal);
  return FAMILY_COMMA_INITIALS.test(text) || INITIALS_FAMILY.test(text) || FAMILY_COMMA_GIVEN.test(text);
}

/** A CSL name with trimmed parts and empty parts removed; literals that look personal are parsed. */
export function normalizeCslName(name: unknown): CslName | undefined {
  if (typeof name === "string") return normalizeCslName(parseName(name));
  if (!name || typeof name !== "object") return undefined;
  const source = name as Record<string, unknown>;
  const result: CslName = {};
  for (const field of ["family", "given", "dropping-particle", "non-dropping-particle", "suffix", "literal"] as const) {
    const value = source[field];
    if (typeof value === "string" && cleanString(value)) result[field] = cleanString(value);
  }
  if (result.literal && !result.family && !result.given && looksLikePersonalName(result.literal)) {
    const parsed = parseName(result.literal);
    if (parsed.family) return parsed;
  }
  if (result.literal && (result.family || result.given)) delete result.literal;
  return Object.keys(result).length ? result : undefined;
}

function isEmpty(value: unknown) {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return typeof value === "number" && !Number.isFinite(value);
}

/** A list of ISBNs or ISSNs separated by commas, semicolons or spaces. A single value written with spaces ("978 0 262 03384 8") counts as one. */
function splitIdentifierList(text: string, normalize: (value: string) => string | undefined) {
  const whole = normalize(text);
  if (whole) return [whole];
  const parts = text.split(/[,;]+|\s+(?=(?:isbn|issn|\d{3}[\d-]{6}|\d{4}-))/i).map((part) => part.trim()).filter(Boolean);
  return [...new Set(parts.map((part) => normalize(part) ?? part))];
}

function normalizeList(text: string, normalize: (value: string) => string | undefined) {
  return splitIdentifierList(text, normalize).join(" ");
}

/**
 * A cleaned CSL item: strings trimmed and whitespace collapsed, titles
 * reduced to the citeproc rich-text subset, pages with en-dash ranges,
 * DOI/ISBN/ISSN/PMID/PMCID in normalized form (invalid values are kept as
 * typed), valid dates, structured names, number variables as strings, an
 * unknown type as "document", and empty fields dropped.
 */
export function normalizeCslItem(csl: CslItem): CslItem {
  const result: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(csl)) {
    let value: unknown = raw;
    if (typeof value === "number" && NUMBER_FIELDS.has(field)) value = String(value);
    if ((CSL_DATE_FIELDS as readonly string[]).includes(field)) {
      value = normalizeCslDate(value);
    } else if ((CSL_NAME_FIELDS as readonly string[]).includes(field)) {
      value = Array.isArray(value) ? value.map(normalizeCslName).filter((name): name is CslName => !!name) : undefined;
    } else if (typeof value === "string") {
      value = (CSL_TITLE_FIELDS as readonly string[]).includes(field) || field === "abstract" ? cleanRichText(value) : cleanString(value);
      const text = value as string;
      if (field === "page") value = normalizePageRange(text);
      else if (field === "DOI") value = normalizeDoi(text) ?? text;
      else if (field === "ISBN") value = normalizeList(text, normalizeIsbn);
      else if (field === "ISSN") value = normalizeList(text, normalizeIssn);
      else if (field === "PMID") value = normalizePmid(text) ?? text;
      else if (field === "PMCID") value = normalizePmcid(text) ?? text;
    }
    if (!isEmpty(value)) result[field] = value;
  }
  if (!(CSL_ITEM_TYPES as readonly string[]).includes(result.type as string)) result.type = "document";
  return result as CslItem;
}

/** Identifiers in normalized form; invalid values are dropped, ISBNs deduplicated. */
export function normalizeIdentifiers(identifiers: ReferenceIdentifiers | undefined): ReferenceIdentifiers {
  const result: ReferenceIdentifiers = {};
  if (!identifiers) return result;
  const doi = normalizeDoi(identifiers.doi);
  if (doi) result.doi = doi;
  const arxiv = normalizeArxivId(identifiers.arxiv);
  if (arxiv) result.arxiv = arxiv;
  const isbn = [...new Set((identifiers.isbn ?? []).map((value) => normalizeIsbn(value)).filter((value): value is string => !!value))];
  if (isbn.length) result.isbn = isbn;
  const pmid = normalizePmid(identifiers.pmid);
  if (pmid) result.pmid = pmid;
  const pmcid = normalizePmcid(identifiers.pmcid);
  if (pmcid) result.pmcid = pmcid;
  const openalex = identifiers.openalex?.trim().replace(/^https?:\/\/openalex\.org\//i, "");
  if (openalex) result.openalex = openalex.toUpperCase();
  return result;
}

/** The identifiers a CSL item carries: DOI, ISBN, PMID, PMCID, and an arXiv ID from an arXiv DOI, URL or `number`. */
export function identifiersFromCsl(csl: CslItem): ReferenceIdentifiers {
  const result: ReferenceIdentifiers = {};
  const doi = typeof csl.DOI === "string" ? normalizeDoi(csl.DOI) : undefined;
  if (doi) result.doi = doi;
  const isbn = typeof csl.ISBN === "string" ? splitIdentifierList(csl.ISBN, normalizeIsbn).filter((value) => /^97[89]\d{10}$/.test(value)) : [];
  if (isbn.length) result.isbn = [...new Set(isbn)];
  const pmid = typeof csl.PMID === "string" || typeof csl.PMID === "number" ? normalizePmid(String(csl.PMID)) : undefined;
  if (pmid) result.pmid = pmid;
  const pmcid = typeof csl.PMCID === "string" ? normalizePmcid(csl.PMCID) : undefined;
  if (pmcid) result.pmcid = pmcid;
  const arxivSources = [doi?.startsWith("10.48550/arxiv.") ? doi : undefined, typeof csl.URL === "string" && /arxiv\.org\//i.test(csl.URL) ? csl.URL : undefined, typeof csl.number === "string" && /^arxiv:/i.test(csl.number) ? csl.number : undefined];
  const arxiv = arxivSources.map((value) => normalizeArxivId(value)).find(Boolean);
  if (arxiv) result.arxiv = arxiv;
  return result;
}

/** `csl` with DOI, ISBN, PMID and PMCID filled from `identifiers` where the item has none. Existing values are never overwritten. */
export function applyIdentifiersToCsl(csl: CslItem, identifiers: ReferenceIdentifiers | undefined): CslItem {
  if (!identifiers) return csl;
  const result: CslItem = { ...csl };
  if (!result.DOI && identifiers.doi) result.DOI = identifiers.doi;
  if (!result.ISBN && identifiers.isbn?.length) result.ISBN = identifiers.isbn.join(" ");
  if (!result.PMID && identifiers.pmid) result.PMID = identifiers.pmid;
  if (!result.PMCID && identifiers.pmcid) result.PMCID = identifiers.pmcid;
  return result;
}

/**
 * A cleaned entry input: `normalizeCslItem`, identifiers normalized and
 * synced with the CSL item in both directions (existing values win), tags
 * trimmed and deduplicated case-insensitively, empty fields dropped.
 */
export function normalizeEntryInput(input: ReferenceEntryInput): ReferenceEntryInput {
  let csl = normalizeCslItem(input.csl);
  const fromCsl = identifiersFromCsl(csl);
  const given = normalizeIdentifiers(input.identifiers);
  const identifiers: ReferenceIdentifiers = { ...fromCsl, ...given };
  const isbn = [...new Set([...(given.isbn ?? []), ...(fromCsl.isbn ?? [])])];
  if (isbn.length) identifiers.isbn = isbn;
  csl = applyIdentifiersToCsl(csl, identifiers);
  const result: ReferenceEntryInput = { ...input, csl };
  if (Object.keys(identifiers).length) result.identifiers = identifiers;
  else delete result.identifiers;
  const seen = new Set<string>();
  const tags = (input.tags ?? []).map(cleanString).filter((tag) => {
    const folded = tag.toLowerCase();
    if (!tag || seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
  if (tags.length) result.tags = tags;
  else delete result.tags;
  if (typeof input.notes === "string" && input.notes.trim()) result.notes = input.notes.trim();
  else delete result.notes;
  for (const field of ["key", "provenance", "attachments", "versions", "status"] as const) {
    if (isEmpty(result[field])) delete result[field];
  }
  return result;
}
