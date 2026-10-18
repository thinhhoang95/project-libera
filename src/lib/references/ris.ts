import { isValidCitationKey } from "./keys";
import { extractIdentifiers, normalizeIsbn, normalizeIssn } from "./identifiers";
import { formatNameForDisplay, parsePersonList } from "./names";
import { importProvenance, normalizeEntryInput, parseMonth, type ReferenceParseError, type ReferenceParseResult } from "./normalize";
import type { CslDate, CslItem, CslItemType, CslName, ReferenceIdentifiers } from "./types";

// RIS ↔ CSL entries. The parser accepts lenient tag spacing (`TY - `,
// `TY  -`), multi-line values, a missing final `ER`, CRLF and a BOM. `SN`
// is split into ISBN and ISSN by length and checksum. The serializer writes
// the standard `XX  - value` lines with CRLF line ends, as the RIS
// specification asks. Pure and dependency-free.

export type RisParseOptions = {
  /** Timestamp for the provenance of every parsed field. Defaults to now. */
  retrievedAt?: string;
};

/** What `serializeRis` needs from an entry; a ReferenceEntry fits. */
export type RisSerializableEntry = {
  key: string;
  csl: CslItem;
  identifiers?: ReferenceIdentifiers;
  tags?: string[];
};

const RIS_TYPES: Record<string, CslItemType> = {
  JOUR: "article-journal", JFULL: "article-journal", EJOUR: "article-journal", ABST: "article-journal", INPR: "article-journal",
  MGZN: "article-magazine", NEWS: "article-newspaper", BOOK: "book", EBOOK: "book", EDBOOK: "book", WHOLE: "book", SER: "book",
  CHAP: "chapter", ECHAP: "chapter", CONF: "paper-conference", CPAPER: "paper-conference", THES: "thesis", RPRT: "report",
  ELEC: "webpage", WEB: "webpage", ICOMM: "webpage", BLOG: "post-weblog", UNPB: "manuscript", MANSCPT: "manuscript",
  GEN: "document", PAT: "patent", DATA: "dataset", DBASE: "dataset", COMP: "software", CASE: "legal_case", STAT: "legislation",
  BILL: "bill", MAP: "map", SOUND: "song", MUSIC: "musical_score", VIDEO: "motion_picture", MPCT: "motion_picture",
  ART: "graphic", FIGURE: "figure", STAND: "standard", ENCYC: "entry-encyclopedia", DICT: "entry-dictionary",
  PCOMM: "personal_communication", HEAR: "hearing", PAMP: "pamphlet", CTLG: "document", GOVDOC: "report", LEGAL: "regulation",
  AGGR: "dataset", ANCIENT: "classic", CLSWK: "classic", SLIDE: "speech", JOURNAL: "periodical",
};
const CSL_TO_RIS: Partial<Record<CslItemType, string>> = {
  "article-journal": "JOUR", article: "JOUR", "article-magazine": "MGZN", "article-newspaper": "NEWS", book: "BOOK",
  chapter: "CHAP", "paper-conference": "CPAPER", thesis: "THES", report: "RPRT", webpage: "ELEC", "post-weblog": "BLOG",
  post: "ELEC", manuscript: "UNPB", document: "GEN", patent: "PAT", dataset: "DATA", software: "COMP", legal_case: "CASE",
  legislation: "STAT", bill: "BILL", map: "MAP", song: "SOUND", musical_score: "MUSIC", motion_picture: "MPCT",
  graphic: "ART", figure: "FIGURE", standard: "STAND", "entry-encyclopedia": "ENCYC", "entry-dictionary": "DICT",
  personal_communication: "PCOMM", hearing: "HEAR", pamphlet: "PAMP", regulation: "LEGAL", classic: "CLSWK", speech: "SLIDE",
  periodical: "JOURNAL", collection: "EDBOOK",
};

const TAG_LINE = /^([A-Z][A-Z0-9])[ \t]*-(?:[ \t](.*))?$/;

type RisRecord = { line: number; tags: Array<[string, string]> };

function readRecords(text: string, errors: ReferenceParseError[]) {
  const records: RisRecord[] = [];
  let current: RisRecord | null = null;
  const lines = text.replace(/^﻿/, "").split(/\r\n?|\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/\s+$/, "");
    const match = line.match(TAG_LINE);
    if (!match) {
      // Continuation of the previous value.
      if (line.trim() && current?.tags.length) current.tags[current.tags.length - 1][1] += ` ${line.trim()}`;
      else if (line.trim()) errors.push({ line: index + 1, message: `Unrecognized line outside a record: "${line.trim().slice(0, 40)}"` });
      return;
    }
    const tag = match[1];
    const value = match[2] ?? "";
    if (tag === "TY") {
      if (current) {
        errors.push({ line: current.line, message: "Record has no ER line" });
        records.push(current);
      }
      current = { line: index + 1, tags: [["TY", value.trim()]] };
      return;
    }
    if (!current) {
      errors.push({ line: index + 1, message: `Tag ${tag} outside a record` });
      return;
    }
    if (tag === "ER") {
      records.push(current);
      current = null;
      return;
    }
    current.tags.push([tag, value.trim()]);
  });
  if (current) {
    errors.push({ line: (current as RisRecord).line, message: "Record has no ER line" });
    records.push(current);
  }
  return records;
}

/** RIS dates: "2020", "2020///", "2020/05/12/", "2020/05/12/Spring", "2020-05-12". */
function risDate(text: string): { parts?: [number, number?, number?]; season?: string } {
  const [year, month, day, other] = text.split(/[/-]/).map((part) => part.trim());
  const yearNumber = Number(year?.match(/^\d{1,4}/)?.[0]);
  if (!Number.isInteger(yearNumber) || !year) return {};
  const parts: [number, number?, number?] = [yearNumber];
  const monthNumber = month ? parseMonth(month) : undefined;
  if (monthNumber) {
    parts.push(monthNumber);
    const dayNumber = Number(day);
    if (day && Number.isInteger(dayNumber) && dayNumber > 0) parts.push(dayNumber);
  }
  return { parts, season: other || undefined };
}

function toEntry(record: RisRecord, retrievedAt: string) {
  const values = (...tags: string[]) => record.tags.filter(([tag]) => tags.includes(tag)).map(([, value]) => value).filter(Boolean);
  const first = (...tags: string[]) => values(...tags)[0];
  const risType = (first("TY") ?? "").toUpperCase();
  const type = RIS_TYPES[risType] ?? "document";
  const csl: CslItem = { type };
  const people = (...tags: string[]) => {
    const list: CslName[] = values(...tags).flatMap((value) => parsePersonList(value));
    return list.length ? list : undefined;
  };
  const author = people("AU", "A1");
  if (author) csl.author = author;
  const editor = people("A2", "ED");
  if (editor) csl.editor = editor;
  const seriesEditor = people("A3");
  if (seriesEditor) csl["collection-editor"] = seriesEditor;
  const translator = people("A4", "TA");
  if (translator) csl.translator = translator;

  const title = first("TI", "T1", "CT") ?? (type === "book" ? first("BT") : undefined);
  if (title) csl.title = title;
  const container = first("T2", "JF", "JO") ?? (type !== "book" ? first("BT") : undefined);
  const shortContainer = first("J2", "JA");
  if (container) csl["container-title"] = container;
  else if (shortContainer) csl["container-title"] = shortContainer;
  if (shortContainer) csl["container-title-short"] = shortContainer;
  const series = first("T3");
  if (series) csl["collection-title"] = series;
  const shortTitle = first("ST");
  if (shortTitle && shortTitle !== title) csl["title-short"] = shortTitle;

  const year = risDate(first("PY", "Y1") ?? "");
  const date = risDate(first("DA") ?? "");
  let parts = year.parts;
  if (date.parts && (!parts || (date.parts[0] === parts[0] && date.parts.length > parts.length))) parts = date.parts;
  if (parts) {
    const issued: CslDate = { "date-parts": [parts] };
    const season = date.season ?? year.season;
    if (season) issued.season = season;
    csl.issued = issued;
  }
  if (risType === "INPR") csl.status = "in press";
  const accessed = risDate(first("Y2") ?? "").parts;
  if (accessed) csl.accessed = { "date-parts": [accessed] };

  const volume = first("VL");
  if (volume) csl.volume = volume;
  const issue = first("IS");
  if (issue) {
    if (type.startsWith("article") || type === "periodical") csl.issue = issue;
    else csl.number = issue;
  }
  const number = first("M1");
  if (number && !csl.number && !type.startsWith("article")) csl.number = number;
  const start = first("SP");
  const end = first("EP");
  if (start) csl.page = end && end !== start ? `${start}–${end}` : start;
  const edition = first("ET");
  if (edition) csl.edition = edition;
  const publisher = first("PB");
  if (publisher) csl.publisher = publisher;
  const place = first("CY", "PP");
  if (place) csl["publisher-place"] = place;
  const abstract = first("AB", "N2");
  if (abstract) csl.abstract = abstract;
  const note = values("N1").join(" ");
  if (note) csl.note = note;
  const language = first("LA");
  if (language) csl.language = language;
  const genre = first("M3");
  if (genre) csl.genre = genre;

  const doi = first("DO");
  if (doi) csl.DOI = doi;
  const url = values("UR").flatMap((value) => value.split(/\s*;\s*|\s+/)).find((value) => /^https?:\/\//i.test(value));
  if (url) csl.URL = url;
  const isbn: string[] = [];
  const issn: string[] = [];
  for (const value of values("SN").flatMap((text) => text.split(/\s*[;,]\s*|\s+(?=\d{4}-|97[89]|\d{9}[\dXx]\b)/))) {
    const cleaned = value.replace(/\s*\((?:print|online|electronic|ebook|paperback|hardcover|pbk|hbk)\)\s*$/i, "").trim();
    const digits = cleaned.replace(/^(?:e?issn|isbn(?:-1[03])?)\s*:?\s*/i, "").replace(/[\s-]/g, "");
    if (digits.length === 8 && normalizeIssn(cleaned)) issn.push(normalizeIssn(cleaned)!);
    else if ((digits.length === 10 || digits.length === 13) && normalizeIsbn(cleaned)) isbn.push(normalizeIsbn(cleaned)!);
    else if (digits.length === 8) issn.push(cleaned);
    else if (cleaned) isbn.push(cleaned);
  }
  if (isbn.length) csl.ISBN = isbn.join(" ");
  if (issn.length) csl.ISSN = issn.join(" ");

  const found = extractIdentifiers([doi, ...values("UR")].filter(Boolean).join(" "));
  const identifiers: ReferenceIdentifiers = {};
  if (found.arxiv) identifiers.arxiv = found.arxiv;
  const tags = values("KW").flatMap((value) => value.split(/\s*;\s*/));
  const input = normalizeEntryInput({ csl, identifiers, tags });
  input.provenance = importProvenance(input.csl, retrievedAt);
  const sourceKey = first("ID") ?? "";
  if (isValidCitationKey(sourceKey)) input.key = sourceKey;
  return { input, sourceKey, line: record.line };
}

/**
 * Parses RIS. Each record (TY … ER) becomes an entry input; the `ID` tag
 * is the source key. Problems are collected in `errors` and never stop the
 * parse.
 */
export function parseRis(text: string, options: RisParseOptions = {}): ReferenceParseResult {
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const errors: ReferenceParseError[] = [];
  const records = readRecords(text, errors);
  const entries = records.map((record) => {
    if (!record.tags[0][1]) errors.push({ line: record.line, message: "Record has an empty TY tag" });
    return toEntry(record, retrievedAt);
  });
  errors.sort((a, b) => a.line - b.line);
  return { entries, errors };
}

/** CSL rich text → plain text for RIS, which has no markup. */
function plainText(text: string) {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function risName(name: CslName) {
  if (name.literal && !name.family) return name.literal;
  const family = [name["non-dropping-particle"], name.family].filter(Boolean).join(" ");
  const given = [name.given, name["dropping-particle"]].filter(Boolean).join(" ");
  return [family, given, name.suffix].filter((part, index) => part || index === 1 && name.suffix).join(", ") || formatNameForDisplay(name);
}

function risDateText(date: CslDate | undefined) {
  const parts = date?.["date-parts"]?.[0];
  if (!parts) return undefined;
  const [year, month, day] = parts;
  return `${String(year).padStart(4, "0")}/${month ? String(month).padStart(2, "0") : ""}/${month && day ? String(day).padStart(2, "0") : ""}/${typeof date?.season === "string" ? date.season : ""}`;
}

/** Entries → RIS, one `TY … ER` record per entry, CRLF line ends. */
export function serializeRis(entries: RisSerializableEntry[]) {
  const records = entries.map((entry) => {
    const csl = entry.csl;
    const lines: string[] = [];
    const add = (tag: string, value: unknown) => {
      if (typeof value === "string" && value.trim()) lines.push(`${tag}  - ${plainText(value)}`);
    };
    add("TY", CSL_TO_RIS[csl.type] ?? "GEN");
    for (const name of csl.author ?? []) add("AU", risName(name));
    for (const name of csl.editor ?? []) add("A2", risName(name));
    for (const name of (csl["collection-editor"] as CslName[] | undefined) ?? []) add("A3", risName(name));
    for (const name of csl.translator ?? []) add("A4", risName(name));
    add("TI", csl.title);
    add("ST", csl["title-short"]);
    add("T2", csl["container-title"]);
    add("J2", csl["container-title-short"]);
    add("T3", csl["collection-title"]);
    const parts = csl.issued?.["date-parts"]?.[0];
    if (parts) add("PY", String(parts[0]));
    if (parts && (parts[1] || csl.issued?.season)) add("DA", risDateText(csl.issued));
    add("Y2", risDateText(csl.accessed));
    add("VL", csl.volume);
    add("IS", csl.type.startsWith("article") || csl.type === "periodical" ? csl.issue : csl.number);
    const page = typeof csl.page === "string" ? csl.page : "";
    const range = page.match(/^([^–\-,]+?)\s*[–-]+\s*([^–\-,]+)$/);
    if (range) {
      add("SP", range[1]);
      add("EP", range[2]);
    } else {
      add("SP", page);
    }
    add("ET", csl.edition);
    add("PB", csl.publisher);
    add("CY", csl["publisher-place"]);
    const isbn = typeof csl.ISBN === "string" ? csl.ISBN.split(/\s+/) : entry.identifiers?.isbn ?? [];
    for (const value of isbn) add("SN", value);
    for (const value of typeof csl.ISSN === "string" ? csl.ISSN.split(/\s+/) : []) add("SN", value);
    const doi = typeof csl.DOI === "string" ? csl.DOI : entry.identifiers?.doi;
    add("DO", doi);
    add("UR", csl.URL);
    // RIS has no arXiv tag; the abs URL carries it unless an arXiv DOI already does.
    if (!csl.URL && entry.identifiers?.arxiv && !/^10\.48550\/arxiv\./i.test(doi ?? "")) add("UR", `https://arxiv.org/abs/${entry.identifiers.arxiv}`);
    add("LA", csl.language);
    add("M3", csl.genre);
    for (const tag of entry.tags ?? []) add("KW", tag);
    add("AB", csl.abstract);
    add("N1", csl.note);
    add("ID", entry.key);
    lines.push("ER  - ");
    return lines.join("\r\n");
  });
  return records.length ? `${records.join("\r\n\r\n")}\r\n` : "";
}
