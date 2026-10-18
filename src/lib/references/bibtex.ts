import { abbreviateJournal } from "./journal-abbreviations";
import { isValidCitationKey } from "./keys";
import { decodeLatex, decodeLatexVerbatim, encodeLatex, protectTitleCase, type LatexDialect } from "./latex-text";
import { formatBibtexName, parseBibtexNameList } from "./names";
import { normalizeArxivId } from "./identifiers";
import { importProvenance, normalizeEntryInput, parseDateText, parseMonth, type ReferenceParseError, type ReferenceParseResult } from "./normalize";
import type { CslDate, CslItem, CslItemType, CslName, ReferenceIdentifiers } from "./types";

// BibTeX and BibLaTeX ↔ CSL entries.
//
// The parser is tolerant: it reads `@string` macros (with `#`
// concatenation and the predefined month macros), skips `@comment` and
// `@preamble`, accepts braces and quotes, CRLF and a BOM, and resolves
// `crossref`. A malformed entry adds an error and parsing resumes at the
// next `@` that starts a line. Field values are decoded from LaTeX (see
// latex-text.ts); titles keep brace protection as nocase spans.
//
// The serializer is the inverse, with a stable field order, title-case
// protection, `--` page ranges, and the date and field names of the chosen
// dialect. Parsing what it writes gives back the same entries.

export type BibtexParseOptions = {
  /** Timestamp for the provenance of every parsed field. Defaults to now. */
  retrievedAt?: string;
};

export type BibtexSerializeOptions = {
  dialect: LatexDialect;
  /**
   * Write the abbreviated journal title as the journal: the entry's
   * `container-title-short`, else its ISO 4 abbreviation (journal-abbreviations.ts;
   * call loadJournalAbbreviations() first to use the full-title table).
   */
  abbreviateJournals?: boolean;
  /** Write each entry's aliases as `@comment{alias: old -> key}` lines before it. */
  includeAliases?: boolean;
};

/** What `serializeBibtex` needs from an entry; a ReferenceEntry fits. */
export type BibtexSerializableEntry = {
  key: string;
  csl: CslItem;
  identifiers?: ReferenceIdentifiers;
  aliases?: string[];
  tags?: string[];
};

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_MACROS = MONTH_NAMES.map((name) => name.slice(0, 3));

type RawEntry = {
  type: string;
  key: string;
  line: number;
  /** Lowercase field name → raw LaTeX value after macro expansion. */
  fields: Map<string, string>;
};

class ParseFailure extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

const ENTRY_START = /@[ \t\r\n]*([A-Za-z][\w-]*)[ \t\r\n]*([{(])/y;
const LINE_START_AT = /(?:^|\n)[ \t]*@[ \t]*[A-Za-z][\w-]*[ \t\r\n]*[{(]/g;
const FIELD_NAME = /[^\s=,{}()"#@%]+/y;
const MACRO_NAME = /[A-Za-z_][^\s=,{}()"#%]*/y;
const DIGITS = /\d+/y;

class BibtexScanner {
  private index = 0;
  private readonly lineStarts: number[] = [0];
  readonly macros = new Map<string, string>(MONTH_MACROS.map((macro, index) => [macro, MONTH_NAMES[index][0].toUpperCase() + MONTH_NAMES[index].slice(1)]));
  readonly entries: RawEntry[] = [];
  readonly errors: ReferenceParseError[] = [];

  constructor(private readonly text: string) {
    for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") this.lineStarts.push(index + 1);
  }

  lineAt(offset: number) {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  run() {
    const text = this.text;
    while (this.index < text.length) {
      const at = text.indexOf("@", this.index);
      if (at < 0) break;
      ENTRY_START.lastIndex = at;
      const match = ENTRY_START.exec(text);
      if (!match) {
        this.index = at + 1;
        continue;
      }
      const type = match[1].toLowerCase();
      const close = match[2] === "{" ? "}" : ")";
      this.index = ENTRY_START.lastIndex;
      try {
        if (type === "comment" || type === "preamble") this.skipGroup(at, close);
        else if (type === "string") this.readString(close);
        else this.readEntry(type, close, at);
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.errors.push({ line: this.lineAt(error.offset), message: error.message });
        this.recover(at);
      }
    }
  }

  /** Resumes at the next `@type{` that starts a line after `from`. */
  private recover(from: number) {
    LINE_START_AT.lastIndex = from + 1;
    const next = LINE_START_AT.exec(this.text);
    this.index = next ? next.index + next[0].indexOf("@") : this.text.length;
  }

  private skipGroup(start: number, close: string) {
    const open = close === "}" ? "{" : "(";
    let depth = 1;
    for (let index = this.index; index < this.text.length; index += 1) {
      const char = this.text[index];
      if (char === open) depth += 1;
      else if (char === close && --depth === 0) {
        this.index = index + 1;
        return;
      }
    }
    // An unterminated @comment ends at its line.
    const end = this.text.indexOf("\n", start);
    this.index = end < 0 ? this.text.length : end + 1;
  }

  private skipSpace(allowComments = false) {
    const text = this.text;
    for (;;) {
      while (this.index < text.length && /\s/.test(text[this.index])) this.index += 1;
      if (allowComments && text[this.index] === "%") {
        const end = text.indexOf("\n", this.index);
        this.index = end < 0 ? text.length : end + 1;
        continue;
      }
      return;
    }
  }

  private readString(close: string) {
    this.skipSpace(true);
    while (this.index < this.text.length && this.text[this.index] !== close) {
      MACRO_NAME.lastIndex = this.index;
      const name = MACRO_NAME.exec(this.text)?.[0];
      if (!name) throw new ParseFailure("Malformed @string: expected a macro name", this.index);
      this.index += name.length;
      this.skipSpace();
      if (this.text[this.index] !== "=") throw new ParseFailure(`Malformed @string: expected "=" after ${name}`, this.index);
      this.index += 1;
      this.macros.set(name.toLowerCase(), this.readValue(name, close));
      this.skipSpace(true);
      if (this.text[this.index] === ",") {
        this.index += 1;
        this.skipSpace(true);
      }
    }
    if (this.index >= this.text.length) throw new ParseFailure("Unterminated @string", this.index);
    this.index += 1;
  }

  private readEntry(type: string, close: string, start: number) {
    const text = this.text;
    this.skipSpace();
    let keyEnd = this.index;
    while (keyEnd < text.length && !/[\s,]/.test(text[keyEnd]) && text[keyEnd] !== close && !(close === "}" && text[keyEnd] === "{")) keyEnd += 1;
    const key = text.slice(this.index, keyEnd);
    this.index = keyEnd;
    this.skipSpace();
    const entry: RawEntry = { type, key, line: this.lineAt(start), fields: new Map() };
    const label = key ? `"${key}"` : `at line ${entry.line}`;
    if (text[this.index] === close) {
      this.index += 1;
      this.entries.push(entry);
      return;
    }
    if (text[this.index] !== ",") throw new ParseFailure(key ? `Expected "," after the key of entry ${label}` : `Entry ${label} has no key`, this.index);
    for (;;) {
      this.skipSpace(true);
      const char = text[this.index];
      if (char === close) {
        this.index += 1;
        break;
      }
      if (char === ",") {
        this.index += 1;
        continue;
      }
      if (char === undefined || char === "@") throw new ParseFailure(`Entry ${label} is not closed`, this.index);
      FIELD_NAME.lastIndex = this.index;
      const name = FIELD_NAME.exec(text)?.[0];
      if (!name) throw new ParseFailure(`Unexpected "${char}" in entry ${label}`, this.index);
      this.index += name.length;
      this.skipSpace();
      if (text[this.index] !== "=") throw new ParseFailure(`Expected "=" after field "${name}" in entry ${label}`, this.index);
      this.index += 1;
      const valueStart = this.index;
      const value = this.readValue(name, close);
      const field = name.toLowerCase();
      if (entry.fields.has(field)) this.errors.push({ line: this.lineAt(valueStart), message: `Duplicate field "${field}" in entry ${label}; the first value is kept` });
      else entry.fields.set(field, value);
      this.skipSpace(true);
      if (text[this.index] !== "," && text[this.index] !== close) throw new ParseFailure(`Expected "," or "${close}" after field "${name}" in entry ${label}`, this.index);
    }
    this.entries.push(entry);
  }

  /** A field value: braced, quoted, number or macro parts joined by `#`. */
  private readValue(name: string, close: string) {
    const text = this.text;
    let value = "";
    for (;;) {
      this.skipSpace();
      const char = text[this.index];
      if (char === "{") {
        value += this.readDelimited("{");
      } else if (char === "\"") {
        value += this.readDelimited("\"");
      } else if (char !== undefined && /\d/.test(char)) {
        DIGITS.lastIndex = this.index;
        const digits = DIGITS.exec(text)![0];
        value += digits;
        this.index += digits.length;
      } else {
        MACRO_NAME.lastIndex = this.index;
        const macro = MACRO_NAME.exec(text)?.[0];
        if (!macro || char === close) throw new ParseFailure(`Missing value for field "${name}"`, this.index);
        this.index += macro.length;
        const expansion = this.macros.get(macro.toLowerCase());
        if (expansion === undefined) this.errors.push({ line: this.lineAt(this.index), message: `Undefined macro "${macro}" in field "${name}"` });
        value += expansion ?? "";
      }
      this.skipSpace();
      if (text[this.index] !== "#") return value;
      this.index += 1;
    }
  }

  /**
   * The content of `{…}` or `"…"`, balanced braces inside. A line that
   * starts a new `@entry{` while braces are still open means a brace was
   * never closed; that fails the entry instead of swallowing the next one.
   */
  private readDelimited(open: "{" | "\"") {
    const text = this.text;
    const start = this.index;
    let depth = open === "{" ? 1 : 0;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\\") {
        index += 1;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (open === "{" && depth === 0) {
          this.index = index + 1;
          return text.slice(start + 1, index);
        }
        if (depth < 0) throw new ParseFailure("Unbalanced \"}\" in a quoted value", index);
      } else if (char === "\"" && open === "\"" && depth === 0) {
        this.index = index + 1;
        return text.slice(start + 1, index);
      } else if (char === "\n" && /^[ \t]*@[ \t]*[A-Za-z][\w-]*[ \t\r\n]*[{(]/.test(text.slice(index + 1, index + 80))) {
        throw new ParseFailure("Unbalanced braces: a value runs into the next entry", start);
      }
    }
    throw new ParseFailure("Unbalanced braces: a value is not closed before the end of the file", start);
  }
}

// ---------------------------------------------------------------------------
// Raw entries → CSL
// ---------------------------------------------------------------------------

const TYPE_MAP: Record<string, CslItemType> = {
  article: "article-journal", inproceedings: "paper-conference", conference: "paper-conference",
  incollection: "chapter", inbook: "chapter", bookinbook: "chapter", suppbook: "chapter", suppcollection: "chapter",
  inreference: "entry-encyclopedia", book: "book", mvbook: "book", collection: "book", mvcollection: "book",
  proceedings: "book", mvproceedings: "book", reference: "book", mvreference: "book", booklet: "pamphlet",
  phdthesis: "thesis", mastersthesis: "thesis", thesis: "thesis", techreport: "report", report: "report",
  manual: "report", online: "webpage", electronic: "webpage", www: "webpage", webpage: "webpage",
  unpublished: "manuscript", patent: "patent", dataset: "dataset", software: "software", periodical: "periodical",
  standard: "standard", misc: "document",
};
/** Types that are part of a larger work: their `booktitle` is the container. */
const PART_TYPES = new Set(["inproceedings", "conference", "incollection", "inbook", "bookinbook", "suppbook", "suppcollection", "inreference"]);
/** biblatex's localization keys for `type`, and the genre each stands for. */
const GENRE_KEYS: Record<string, string> = {
  phdthesis: "PhD thesis", mathesis: "Master's thesis", mastersthesis: "Master's thesis", candthesis: "Candidate thesis",
  techreport: "Technical report", resreport: "Research report",
};
const PUBSTATES: Record<string, string> = { inpress: "in press", forthcoming: "forthcoming", submitted: "submitted", prepublished: "prepublished", inpreparation: "in preparation" };
const LANGIDS: Record<string, string> = {
  english: "en", american: "en-US", usenglish: "en-US", british: "en-GB", ukenglish: "en-GB", german: "de", ngerman: "de",
  french: "fr", spanish: "es", italian: "it", dutch: "nl", portuguese: "pt", brazilian: "pt-BR", russian: "ru",
  chinese: "zh", japanese: "ja", korean: "ko", polish: "pl", swedish: "sv", danish: "da", norwegian: "nb", finnish: "fi",
  czech: "cs", greek: "el", turkish: "tr", catalan: "ca", hungarian: "hu",
};
/** Fields a crossref child never takes from its parent. */
const NOT_INHERITED = new Set([
  "title", "subtitle", "titleaddon", "shorttitle", "sorttitle", "indextitle", "indexsorttitle", "ids", "crossref", "xref",
  "entryset", "entrysubtype", "execute", "label", "options", "presort", "related", "relatedoptions", "relatedtype", "shorthand",
  "sortkey", "keywords", "doi", "url", "urldate", "eprint", "eprinttype", "archiveprefix", "eprintclass", "primaryclass",
  "pmid", "pmcid", "pages", "abstract", "note", "chapter", "eid",
]);

function resolveCrossrefs(entries: RawEntry[], errors: ReferenceParseError[]) {
  const byKey = new Map<string, RawEntry>();
  for (const entry of entries) if (!byKey.has(entry.key.toLowerCase())) byKey.set(entry.key.toLowerCase(), entry);
  const resolved = new Set<RawEntry>();
  const resolve = (entry: RawEntry, depth: number) => {
    if (resolved.has(entry)) return;
    resolved.add(entry);
    const parentKey = entry.fields.get("crossref");
    if (parentKey === undefined) return;
    entry.fields.delete("crossref");
    const parent = byKey.get(decodeLatexVerbatim(parentKey).toLowerCase());
    if (!parent || parent === entry) {
      errors.push({ line: entry.line, message: `Crossref "${decodeLatexVerbatim(parentKey)}" of entry "${entry.key}" was not found` });
      return;
    }
    if (depth < 4) resolve(parent, depth + 1);
    const fields = entry.fields;
    const part = PART_TYPES.has(entry.type);
    if (part || entry.type === "article") {
      const target = part ? "booktitle" : "journaltitle";
      if (!fields.has(target) && !fields.has("journal") && parent.fields.has("title")) fields.set(target, parent.fields.get("title")!);
      if (part && !fields.has("booksubtitle") && parent.fields.has("subtitle")) fields.set("booksubtitle", parent.fields.get("subtitle")!);
      if (part && !fields.has("bookauthor") && parent.fields.has("author")) fields.set("bookauthor", parent.fields.get("author")!);
    }
    for (const [name, value] of parent.fields) {
      if (NOT_INHERITED.has(name) || fields.has(name)) continue;
      if (part && name === "author") continue;
      fields.set(name, value);
    }
  };
  for (const entry of entries) resolve(entry, 0);
}

function joinTitle(title: string | undefined, subtitle: string | undefined) {
  if (!title) return subtitle;
  if (!subtitle) return title;
  return /[?!:.]$/.test(stripTags(title)) ? `${title} ${subtitle}` : `${title}: ${subtitle}`;
}

function stripTags(text: string) {
  return text.replace(/<[^>]+>/g, "");
}

function names(raw: string | undefined): CslName[] | undefined {
  if (raw === undefined) return undefined;
  const list = parseBibtexNameList(raw).names;
  return list.length ? list : undefined;
}

/** A year field: "2020", "2020a", "2019--2020", or a publication state such as "in press". */
function yearDate(year: string, month: string | undefined, day: string | undefined): { issued?: CslDate; status?: string } {
  const text = decodeLatex(year, { markup: "plain" });
  if (/^(in press|forthcoming|submitted|accepted|in preparation|to appear)$/i.test(text)) return { status: text.toLowerCase() };
  const simple = text.match(/^(\d{1,4})[a-z]?$/);
  if (simple) {
    const monthNumber = month ? parseMonth(decodeLatex(month, { markup: "plain" }).split(/[–—\s/-]/)[0]) : undefined;
    const dayNumber = day && monthNumber ? Number(decodeLatex(day, { markup: "plain" })) : NaN;
    const parts: [number, number?, number?] = [Number(simple[1])];
    if (monthNumber) parts.push(monthNumber);
    if (monthNumber && Number.isInteger(dayNumber)) parts.push(dayNumber);
    return { issued: { "date-parts": [parts] } };
  }
  return { issued: parseDateText(text) ?? { literal: text } };
}

function edition(text: string) {
  const match = text.match(/^(\d+)\s*(?:st|nd|rd|th)?(?:\s+ed(?:\.|ition)?)?$/i);
  return match ? match[1] : text;
}

function toEntry(raw: RawEntry, retrievedAt: string) {
  const fields = raw.fields;
  const get = (name: string) => fields.get(name);
  const has = (name: string) => fields.has(name) && fields.get(name)!.trim() !== "";
  const title = (name: string) => (has(name) ? decodeLatex(get(name)!) : undefined);
  const rich = (name: string) => (has(name) ? decodeLatex(get(name)!, { protectCase: false }) : undefined);
  const plain = (name: string) => (has(name) ? decodeLatex(get(name)!, { markup: "plain" }) : undefined);
  const verbatim = (name: string) => (has(name) ? decodeLatexVerbatim(get(name)!) : undefined);

  let note = plain("note");
  let type: CslItemType = TYPE_MAP[raw.type] ?? "document";
  if (!(raw.type in TYPE_MAP)) note = [note, `BibTeX entry type: @${raw.type}`].filter(Boolean).join(". ");
  const howpublished = get("howpublished");
  const howpublishedUrl = howpublished && /\\url\s*\{|^\s*https?:\/\//.test(howpublished) ? decodeLatexVerbatim(howpublished) : undefined;
  const url = verbatim("url") ?? howpublishedUrl;
  if (raw.type === "misc" && url && !["publisher", "journal", "journaltitle", "booktitle", "institution", "organization", "school", "isbn", "doi", "eprint"].some(has) && !(howpublished && !howpublishedUrl)) type = "webpage";
  if (raw.type === "article") {
    const subtype = plain("entrysubtype")?.toLowerCase();
    if (subtype === "magazine") type = "article-magazine";
    if (subtype === "newspaper") type = "article-newspaper";
  }

  const csl: CslItem = { type };
  let mainTitle = joinTitle(title("title"), title("subtitle"));
  let container = joinTitle(title("journaltitle") ?? title("journal") ?? title("booktitle"), title("journalsubtitle") ?? title("booksubtitle"));
  const chapter = plain("chapter");
  if (raw.type === "inbook" && !has("booktitle") && chapter && !/^\d+$/.test(chapter)) {
    // Classic BibTeX @inbook: `title` is the book, `chapter` the part.
    container = mainTitle;
    mainTitle = chapter;
  } else if (chapter) {
    csl["chapter-number"] = chapter;
  }
  if (raw.type === "inbook" && !has("booktitle") && (!chapter || /^\d+$/.test(chapter)) && mainTitle && !container) {
    container = mainTitle;
    mainTitle = undefined;
  }
  if (mainTitle) csl.title = mainTitle;
  if (has("shorttitle")) csl["title-short"] = title("shorttitle");
  if (container) csl["container-title"] = container;
  const shortContainer = rich("shortjournal") ?? rich("journalabbr") ?? rich("journal-abbrev");
  if (shortContainer) csl["container-title-short"] = shortContainer;
  if (has("series")) csl["collection-title"] = title("series");
  if (has("eventtitle")) csl["event-title"] = title("eventtitle");
  if (has("venue")) csl["event-place"] = plain("venue");

  const author = names(get("author"));
  if (author) csl.author = author;
  const editor = names(get("editor"));
  if (editor) csl.editor = editor;
  const translator = names(get("translator"));
  if (translator) csl.translator = translator;
  const bookauthor = names(get("bookauthor"));
  if (bookauthor) csl["container-author"] = bookauthor;

  if (has("date")) {
    csl.issued = parseDateText(verbatim("date")!) ?? { literal: plain("date")! };
  } else if (has("year")) {
    const { issued, status } = yearDate(get("year")!, get("month"), get("day"));
    if (issued) csl.issued = issued;
    if (status) csl.status = status;
  }
  if (has("pubstate")) {
    const state = plain("pubstate")!;
    csl.status = PUBSTATES[state.toLowerCase().replace(/\s+/g, "")] ?? state;
  }
  if (has("urldate")) csl.accessed = parseDateText(verbatim("urldate")!) ?? { literal: plain("urldate")! };
  if (has("origdate")) csl["original-date"] = parseDateText(verbatim("origdate")!) ?? { literal: plain("origdate")! };
  if (has("eventdate")) csl["event-date"] = parseDateText(verbatim("eventdate")!) ?? { literal: plain("eventdate")! };

  if (has("volume")) csl.volume = plain("volume");
  if (has("volumes")) csl["number-of-volumes"] = plain("volumes");
  const article = type.startsWith("article") || type === "periodical";
  if (article) {
    const issue = plain("number") ?? plain("issue");
    if (issue) csl.issue = issue;
    if (has("eid")) csl.number = plain("eid");
  } else {
    const number = plain("number");
    const series = type === "book" || type === "chapter" || type === "paper-conference";
    if (number && series && has("series")) csl["collection-number"] = number;
    else if (number) csl.number = number;
    if (has("issue")) csl.issue = plain("issue");
  }
  if (has("pages")) csl.page = plain("pages");
  else if (has("eid") && !article) csl.page = plain("eid");
  if (has("pagetotal")) csl["number-of-pages"] = plain("pagetotal");
  if (has("edition")) csl.edition = edition(plain("edition")!);
  if (has("version")) csl.version = plain("version");

  const publisher = plain("publisher") ?? plain("institution") ?? plain("school") ?? plain("organization");
  if (publisher) csl.publisher = publisher;
  const place = plain("location") ?? plain("address");
  if (place) csl["publisher-place"] = place;
  if (howpublished && !howpublishedUrl) csl.medium = plain("howpublished");

  let genre = plain("type");
  if (genre) genre = GENRE_KEYS[genre.toLowerCase()] ?? genre;
  else if (raw.type === "phdthesis") genre = "PhD thesis";
  else if (raw.type === "mastersthesis") genre = "Master's thesis";
  if (genre) csl.genre = genre;
  const language = plain("language") ?? (has("langid") ? LANGIDS[plain("langid")!.toLowerCase()] ?? plain("langid") : undefined);
  if (language) csl.language = language;
  if (has("abstract")) csl.abstract = rich("abstract");
  if (note) csl.note = note;

  const identifiers: ReferenceIdentifiers = {};
  if (has("doi")) csl.DOI = verbatim("doi");
  if (url) csl.URL = url;
  if (has("isbn")) csl.ISBN = verbatim("isbn");
  if (has("issn")) csl.ISSN = verbatim("issn");
  if (has("pmid")) csl.PMID = verbatim("pmid");
  if (has("pmcid")) csl.PMCID = verbatim("pmcid");
  const eprint = verbatim("eprint");
  const eprintType = (plain("eprinttype") ?? plain("archiveprefix") ?? "").toLowerCase();
  if (eprint) {
    if (eprintType === "pubmed" && !csl.PMID) csl.PMID = eprint;
    else if ((eprintType === "pmc" || eprintType === "pmcid") && !csl.PMCID) csl.PMCID = eprint;
    else if (eprintType === "doi" && !csl.DOI) csl.DOI = eprint;
    else if (eprintType === "arxiv" || !eprintType) {
      const arxiv = normalizeArxivId(eprint);
      if (arxiv) identifiers.arxiv = arxiv;
    }
  }
  const arxivField = verbatim("arxiv") ?? verbatim("arxivid");
  if (!identifiers.arxiv && arxivField) identifiers.arxiv = normalizeArxivId(arxivField);

  const keywords = plain("keywords");
  const tags = keywords ? keywords.split(/\s*[,;]\s*/).filter(Boolean) : undefined;
  const input = normalizeEntryInput({ csl, identifiers, tags });
  input.provenance = importProvenance(input.csl, retrievedAt);
  if (isValidCitationKey(raw.key)) input.key = raw.key;
  return { input, sourceKey: raw.key, line: raw.line };
}

/**
 * Parses BibTeX or BibLaTeX source. Each entry comes back as an entry
 * input (key set only when the source key is a valid citation key), its
 * source key and line. Problems are collected in `errors`; they never stop
 * the parse.
 */
export function parseBibtex(text: string, options: BibtexParseOptions = {}): ReferenceParseResult {
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const scanner = new BibtexScanner(text.replace(/^﻿/, "").replace(/\r\n?/g, "\n"));
  scanner.run();
  const errors = [...scanner.errors];
  const seen = new Map<string, number>();
  for (const entry of scanner.entries) {
    const folded = entry.key.toLowerCase();
    if (seen.has(folded)) errors.push({ line: entry.line, message: `Duplicate key "${entry.key}" (first used at line ${seen.get(folded)})` });
    else seen.set(folded, entry.line);
  }
  resolveCrossrefs(scanner.entries, errors);
  const entries = scanner.entries.map((entry) => toEntry(entry, retrievedAt));
  errors.sort((a, b) => a.line - b.line);
  return { entries, errors };
}

// ---------------------------------------------------------------------------
// CSL → BibTeX
// ---------------------------------------------------------------------------

const FIELD_ORDER = [
  "author", "editor", "translator", "bookauthor", "title", "shorttitle", "journal", "journaltitle", "shortjournal", "booktitle",
  "eventtitle", "venue", "series", "edition", "volume", "volumes", "number", "eid", "issue", "chapter", "pages", "pagetotal",
  "publisher", "institution", "school", "address", "location", "howpublished", "year", "month", "day", "date", "origdate",
  "eventdate", "urldate", "pubstate", "doi", "eprint", "eprinttype", "archiveprefix", "isbn", "issn", "pmid", "pmcid", "url",
  "type", "version", "language", "keywords", "abstract", "note",
];
const ARTICLE_TYPES = new Set(["article", "article-journal", "article-magazine", "article-newspaper", "periodical", "review", "review-book"]);

function bibtexType(csl: CslItem, dialect: LatexDialect) {
  const biblatex = dialect === "biblatex";
  const genre = typeof csl.genre === "string" ? csl.genre : "";
  switch (csl.type) {
    case "article-journal": case "article-magazine": case "article-newspaper": case "review": case "review-book":
      return "article";
    case "article": return biblatex ? "online" : "misc";
    case "paper-conference": return "inproceedings";
    case "chapter": return "incollection";
    case "entry": case "entry-dictionary": case "entry-encyclopedia": return biblatex ? "inreference" : "incollection";
    case "book": case "classic": return "book";
    case "collection": return biblatex ? "collection" : "book";
    case "pamphlet": return "booklet";
    case "thesis":
      if (biblatex) return "thesis";
      return /master|m\.\s?sc|\bm\.?a\.|diplom/i.test(genre) ? "mastersthesis" : "phdthesis";
    case "report": return biblatex ? "report" : "techreport";
    case "webpage": case "post": case "post-weblog": return biblatex ? "online" : "misc";
    case "manuscript": return "unpublished";
    case "patent": case "dataset": case "software": return csl.type;
    case "periodical": case "standard": return biblatex ? csl.type : "misc";
    default: return "misc";
  }
}

/** The `type` field for a genre, or undefined when the entry type already says it. */
function typeField(entryType: string, genre: string | undefined, dialect: LatexDialect) {
  if (!genre) return undefined;
  if (entryType === "phdthesis" && genre === "PhD thesis") return undefined;
  if (entryType === "mastersthesis" && genre === "Master's thesis") return undefined;
  if (dialect === "biblatex") {
    const key = Object.entries(GENRE_KEYS).find(([name, label]) => label === genre && name !== "mastersthesis")?.[0];
    if (key) return key;
  }
  return encodeLatex(genre, dialect);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function isoDate(parts: [number, number?, number?]) {
  const [year, month, day] = parts;
  const yearText = year < 0 ? `-${String(-year).padStart(4, "0")}` : String(year).padStart(4, "0");
  return [yearText, month ? pad(month) : undefined, month && day ? pad(day) : undefined].filter(Boolean).join("-");
}

function isoDateText(date: CslDate | undefined) {
  const parts = date?.["date-parts"];
  if (!parts?.length) return undefined;
  return parts.map(isoDate).join("/") + (date?.circa ? "~" : "");
}

function nameList(list: CslName[] | undefined, dialect: LatexDialect) {
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.map((name) => formatBibtexName(name, dialect)).filter(Boolean).join(" and ") || undefined;
}

function verbatimValue(text: string) {
  return text.replace(/\{/g, "%7B").replace(/\}/g, "%7D").replace(/\\/g, "%5C");
}

function str(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function serializeEntry(entry: BibtexSerializableEntry, options: BibtexSerializeOptions) {
  const { dialect } = options;
  const biblatex = dialect === "biblatex";
  const csl = entry.csl;
  const encode = (value: unknown) => (str(value) ? encodeLatex(value as string, dialect) : undefined);
  const fields = new Map<string, string>();
  const set = (name: string, value: string | undefined, bare = false) => {
    if (value === undefined || value === "") return;
    fields.set(name, bare ? value : `{${value}}`);
  };
  const type = bibtexType(csl, dialect);
  const article = ARTICLE_TYPES.has(csl.type);

  set("author", nameList(csl.author, dialect));
  set("editor", nameList(csl.editor, dialect));
  set("translator", nameList(csl.translator, dialect));
  set("bookauthor", nameList(csl["container-author"], dialect));
  if (str(csl.title)) set("title", protectTitleCase(csl.title!, dialect));
  set("shorttitle", encode(csl["title-short"]));
  const container = str(csl["container-title"]);
  const shortContainer = str(csl["container-title-short"]);
  if (article) {
    const journal = options.abbreviateJournals ? shortContainer ?? (container ? abbreviateJournal(container) : undefined) : container;
    set(biblatex ? "journaltitle" : "journal", encode(journal));
  } else if (container) {
    set("booktitle", protectTitleCase(container, dialect));
  }
  set("shortjournal", encode(shortContainer));
  set("eventtitle", encode(csl["event-title"]));
  set("venue", encode(csl["event-place"]));
  set("series", encode(csl["collection-title"]));
  set("edition", encode(csl.edition));
  set("volume", encode(csl.volume));
  set("volumes", encode(csl["number-of-volumes"]));
  if (article) {
    set("number", encode(csl.issue));
    set("eid", encode(csl.number));
  } else {
    set("number", encode(csl["collection-number"] ?? csl.number));
    set("issue", encode(csl.issue));
  }
  set("chapter", encode(csl["chapter-number"]));
  set("pages", encode(csl.page));
  set("pagetotal", encode(csl["number-of-pages"]));
  const publisherField = csl.type === "thesis" ? (biblatex ? "institution" : "school") : csl.type === "report" ? "institution" : "publisher";
  set(publisherField, encode(csl.publisher));
  set(biblatex ? "location" : "address", encode(csl["publisher-place"]));
  set("howpublished", encode(csl.medium));

  const issued = csl.issued;
  const parts = issued?.["date-parts"];
  const status = str(csl.status);
  if (biblatex) {
    const iso = isoDateText(issued);
    if (iso) set("date", iso);
    else if (issued?.literal || issued?.raw) set("year", encode(issued.literal ?? issued.raw));
    if (status) set("pubstate", Object.entries(PUBSTATES).find(([, label]) => label === status.toLowerCase())?.[0] ?? encode(status));
  } else if (parts?.length) {
    const [year, month, day] = parts[0];
    if (parts.length > 1) {
      set("year", `${year}--${parts[1][0]}`);
    } else {
      set("year", String(year));
      if (month) set("month", MONTH_MACROS[month - 1], true);
      if (month && day) set("day", String(day));
    }
  } else if (issued?.literal || issued?.raw) {
    set("year", encode(issued.literal ?? issued.raw));
  } else if (status) {
    set("year", encode(status));
  }
  set("origdate", isoDateText(csl["original-date"]));
  set("eventdate", isoDateText(csl["event-date"] as CslDate | undefined));
  set("urldate", isoDateText(csl.accessed));

  const identifiers = entry.identifiers ?? {};
  const doi = str(csl.DOI) ?? identifiers.doi;
  if (doi) set("doi", verbatimValue(doi));
  if (identifiers.arxiv) {
    set("eprint", identifiers.arxiv);
    set(biblatex ? "eprinttype" : "archiveprefix", "arXiv");
  }
  const isbn = str(csl.ISBN) ?? identifiers.isbn?.join(" ");
  if (isbn) set("isbn", verbatimValue(isbn));
  if (str(csl.ISSN)) set("issn", verbatimValue(csl.ISSN!));
  const pmid = str(csl.PMID) ?? identifiers.pmid;
  if (pmid) set("pmid", verbatimValue(pmid));
  const pmcid = str(csl.PMCID) ?? identifiers.pmcid;
  if (pmcid) set("pmcid", verbatimValue(pmcid));
  if (str(csl.URL)) set("url", verbatimValue(csl.URL!));

  set("type", typeField(type, str(csl.genre), dialect));
  set("version", encode(csl.version));
  set("language", encode(csl.language));
  if (entry.tags?.length) set("keywords", encodeLatex(entry.tags.join(", "), dialect));
  set("abstract", encode(csl.abstract));
  set("note", encode(csl.note));

  const ordered = [...fields.keys()].sort((a, b) => FIELD_ORDER.indexOf(a) - FIELD_ORDER.indexOf(b));
  const width = Math.max(0, ...ordered.map((name) => name.length));
  const lines = ordered.map((name) => `  ${name.padEnd(width)} = ${fields.get(name)}`);
  return `@${type}{${entry.key}${lines.length ? `,\n${lines.join(",\n")}\n` : "\n"}}`;
}

/**
 * Entries → BibTeX or BibLaTeX. One entry per key (the first one wins,
 * compared case-insensitively, as BibTeX does), fields in a stable order,
 * values escaped for LaTeX, titles with case protection, `--` page ranges,
 * month macros (bibtex) or ISO `date` (biblatex), `journal` or
 * `journaltitle`, and `container-title-short` (else the ISO 4
 * abbreviation) as the journal when abbreviating. Aliases are written as
 * `@comment{alias: old -> key}` lines only with `includeAliases`.
 */
export function serializeBibtex(entries: BibtexSerializableEntry[], options: BibtexSerializeOptions) {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const entry of entries) {
    const folded = entry.key.toLowerCase();
    if (!entry.key || seen.has(folded)) continue;
    seen.add(folded);
    const aliases = options.includeAliases ? (entry.aliases ?? []).map((alias) => `@comment{alias: ${alias} -> ${entry.key}}\n`).join("") : "";
    blocks.push(aliases + serializeEntry(entry, options));
  }
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}
