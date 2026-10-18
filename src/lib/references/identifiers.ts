import type { ReferenceIdentifiers } from "./types";

// Scholarly identifiers: normalization, checksums, extraction from free text
// (PDF pages, pasted citations), classification of what the user pasted into
// the Add box, and splitting a pasted bibliography into references.
// Normalized forms match ReferenceIdentifiers: DOIs lowercase without a
// resolver prefix, arXiv IDs without version, ISBN-13 digits, PMCIDs with
// "PMC". Pure and dependency-free.

const DOI_BODY = /^10\.\d{4,9}\/\S+$/;

/** Strips trailing punctuation that is not part of the identifier: `.,;:` always, `)`/`]` when unbalanced. */
function trimTrailingPunctuation(text: string) {
  let value = text;
  for (;;) {
    const last = value[value.length - 1];
    if (last && ".,;:'\"!?>".includes(last)) {
      value = value.slice(0, -1);
    } else if (last === ")" && count(value, "(") < count(value, ")")) {
      value = value.slice(0, -1);
    } else if (last === "]" && count(value, "[") < count(value, "]")) {
      value = value.slice(0, -1);
    } else if (last === "}" && count(value, "{") < count(value, "}")) {
      value = value.slice(0, -1);
    } else {
      return value;
    }
  }
}

function count(text: string, char: string) {
  return text.split(char).length - 1;
}

function safeDecode(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * A DOI in its normalized form (lowercase, no `https://doi.org/` or `doi:`
 * prefix, URL-decoded, trailing punctuation removed unless balanced), or
 * undefined when the text is not a DOI.
 */
export function normalizeDoi(text: string | undefined | null) {
  if (!text) return undefined;
  let value = text.trim()
    .replace(/^<|>$/g, "")
    .replace(/^(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\//i, "")
    .replace(/^info:doi\//i, "")
    .replace(/^doi\s*[:=]?\s*/i, "")
    .trim();
  value = safeDecode(value).trim();
  value = trimTrailingPunctuation(value).toLowerCase();
  return DOI_BODY.test(value) ? value : undefined;
}

const NEW_ARXIV = /^(\d{2})(\d{2})\.(\d{4,5})(?:v\d+)?$/;
const OLD_ARXIV = /^([a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?)\/(\d{7})(?:v\d+)?$/;
const OLD_ARXIV_ARCHIVES = new Set([
  "hep-th", "hep-ph", "hep-ex", "hep-lat", "astro-ph", "cond-mat", "gr-qc", "math-ph", "nucl-th", "nucl-ex", "quant-ph", "math",
  "cs", "physics", "nlin", "q-bio", "q-fin", "stat", "chao-dyn", "solv-int", "patt-sol", "adap-org", "comp-gas", "chem-ph",
  "alg-geom", "dg-ga", "funct-an", "q-alg", "mtrl-th", "supr-con", "acc-phys", "ao-sci", "atom-ph", "bayes-an", "plasm-ph",
]);

function validNewArxiv(match: RegExpMatchArray) {
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  // Five-digit sequence numbers started in January 2015.
  return match[3].length === 4 ? Number(match[1]) < 15 : Number(match[1]) >= 15;
}

/**
 * An arXiv ID without version ("2101.00001", "hep-th/9901001"), from a bare
 * ID, an `arXiv:` prefix, an arxiv.org abs/pdf URL or an arXiv DOI
 * (10.48550/arXiv.…). Undefined when the text is not one.
 */
export function normalizeArxivId(text: string | undefined | null) {
  if (!text) return undefined;
  let value = text.trim()
    .replace(/^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\//i, "")
    .replace(/\.pdf$/i, "")
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.48550\/arxiv\./i, "")
    .replace(/^arxiv\s*:\s*/i, "")
    .trim();
  value = trimTrailingPunctuation(value);
  const modern = value.match(NEW_ARXIV);
  if (modern) return validNewArxiv(modern) ? `${modern[1]}${modern[2]}.${modern[3]}` : undefined;
  const old = value.match(OLD_ARXIV);
  if (old) {
    const archive = old[1].split(".")[0].toLowerCase();
    return OLD_ARXIV_ARCHIVES.has(archive) ? `${old[1]}/${old[2]}` : undefined;
  }
  return undefined;
}

export function isValidIsbn10(digits: string) {
  if (!/^\d{9}[\dX]$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 10; index += 1) sum += (digits[index] === "X" ? 10 : Number(digits[index])) * (10 - index);
  return sum % 11 === 0;
}

export function isValidIsbn13(digits: string) {
  if (!/^97[89]\d{10}$/.test(digits)) return false;
  let sum = 0;
  for (let index = 0; index < 13; index += 1) sum += Number(digits[index]) * (index % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

export function isbn10To13(digits: string) {
  const body = `978${digits.slice(0, 9)}`;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) sum += Number(body[index]) * (index % 2 === 0 ? 1 : 3);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** An ISBN-10 or ISBN-13 (hyphens, spaces and an "ISBN" label allowed) → ISBN-13 digits, or undefined when the checksum fails. */
export function normalizeIsbn(text: string | undefined | null) {
  if (!text) return undefined;
  const digits = text.replace(/^\s*isbn(?:-1[03])?\s*:?\s*/i, "").replace(/[\s\-‐‑–]/g, "").toUpperCase();
  if (digits.length === 10 && isValidIsbn10(digits)) return isbn10To13(digits);
  if (digits.length === 13 && isValidIsbn13(digits)) return digits;
  return undefined;
}

/** An ISSN as "1234-567X", or undefined when the checksum fails. */
export function normalizeIssn(text: string | undefined | null) {
  if (!text) return undefined;
  const digits = text.replace(/^\s*e?issn\s*:?\s*/i, "").replace(/[\s\-‐‑–]/g, "").toUpperCase();
  if (!/^\d{7}[\dX]$/.test(digits)) return undefined;
  let sum = 0;
  for (let index = 0; index < 7; index += 1) sum += Number(digits[index]) * (8 - index);
  const check = (11 - (sum % 11)) % 11;
  if ((check === 10 ? "X" : String(check)) !== digits[7]) return undefined;
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/** A PMID (digits), from "PMID: 123", bare digits or a PubMed URL. */
export function normalizePmid(text: string | undefined | null) {
  if (!text) return undefined;
  const value = text.trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed)\//i, "")
    .replace(/^pmid\s*:?\s*/i, "")
    .replace(/\/$/, "");
  return /^\d{1,9}$/.test(value) ? String(Number(value)) : undefined;
}

/** A PMCID with the "PMC" prefix, from "PMC123", "PMCID: PMC123" or a PMC URL. */
export function normalizePmcid(text: string | undefined | null) {
  if (!text) return undefined;
  const value = text.trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:ncbi\.nlm\.nih\.gov\/pmc\/articles|pmc\.ncbi\.nlm\.nih\.gov\/articles)\//i, "")
    .replace(/^pmcid\s*:?\s*/i, "")
    .replace(/\/$/, "");
  const match = value.match(/^(?:pmc)?(\d{1,9})$/i);
  return match ? `PMC${match[1]}` : undefined;
}

export type ExtractedIdentifiers = ReferenceIdentifiers & {
  urls: string[];
  /** Every identifier found, in text order; the scalar fields hold the first of each. */
  all: { doi: string[]; arxiv: string[]; pmid: string[]; pmcid: string[] };
};

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s"<>]+/g;

function pushUnique(list: string[], value: string | undefined) {
  if (value && !list.includes(value)) list.push(value);
}

function mask(text: string, start: number, length: number) {
  return text.slice(0, start) + " ".repeat(length) + text.slice(start + length);
}

/** ISBN candidates: windows of digit groups joined by single hyphens or spaces. */
function findIsbns(text: string) {
  const found: string[] = [];
  const tokens = [...text.matchAll(/[0-9][0-9Xx\-‐‑]*/g)];
  for (let first = 0; first < tokens.length; first += 1) {
    let joined = "";
    for (let last = first; last < Math.min(tokens.length, first + 6); last += 1) {
      const token = tokens[last];
      if (last > first) {
        const previous = tokens[last - 1];
        const gap = text.slice(previous.index! + previous[0].length, token.index!);
        if (!/^ ?$/.test(gap)) break;
      }
      joined += token[0];
      const digits = joined.replace(/[\-‐‑]/g, "").toUpperCase();
      if (digits.length > 13) break;
      const before = text.slice(Math.max(0, tokens[first].index! - 16), tokens[first].index!);
      const after = text[token.index! + token[0].length] ?? "";
      if (/[0-9A-Za-z]/.test(after) || /[0-9A-Za-z]$/.test(before)) continue;
      const labelled = /isbn(?:-1[03])?\s*:?\s*$/i.test(before);
      let isbn: string | undefined;
      if (digits.length === 13 && isValidIsbn13(digits)) isbn = digits;
      // A bare ten-digit number is too often something else; require a label or ISBN-style grouping.
      else if (digits.length === 10 && isValidIsbn10(digits) && (labelled || last > first || /[\-‐‑]/.test(joined))) isbn = isbn10To13(digits);
      if (isbn) {
        pushUnique(found, isbn);
        first = last;
        break;
      }
    }
  }
  return found;
}

/**
 * Every DOI, arXiv ID, ISBN (checksummed, as ISBN-13), PMID, PMCID and URL
 * in free text. DOIs and identifiers inside URLs count; ISBN and PMID
 * scanning skips URL and DOI text so their digits are not misread.
 */
export function extractIdentifiers(text: string): ExtractedIdentifiers {
  const all = { doi: [] as string[], arxiv: [] as string[], pmid: [] as string[], pmcid: [] as string[] };
  const urls: string[] = [];
  let rest = text;
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimTrailingPunctuation(match[0]);
    pushUnique(urls, url);
    pushUnique(all.arxiv, /arxiv\.org\/(?:abs|pdf|html)\//i.test(url) ? normalizeArxivId(url) : undefined);
    pushUnique(all.pmid, /pubmed/i.test(url) ? normalizePmid(url.replace(/[?#].*$/, "")) : undefined);
    pushUnique(all.pmcid, normalizePmcid(url.match(/\/(PMC\d{3,9})\b/i)?.[1]));
  }
  for (const match of text.matchAll(DOI_PATTERN)) {
    const doi = normalizeDoi(match[0]);
    pushUnique(all.doi, doi);
    if (doi?.startsWith("10.48550/arxiv.")) pushUnique(all.arxiv, normalizeArxivId(doi));
  }
  // Mask URLs and DOIs before scanning for bare numbers.
  for (const pattern of [URL_PATTERN, DOI_PATTERN]) {
    for (const match of [...rest.matchAll(pattern)]) rest = mask(rest, match.index!, match[0].length);
  }
  for (const match of rest.matchAll(/\barxiv\s*:\s*([a-z\-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/gi)) pushUnique(all.arxiv, normalizeArxivId(match[1]));
  for (const match of rest.matchAll(/\b([a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/g)) pushUnique(all.arxiv, normalizeArxivId(match[1]));
  for (const match of rest.matchAll(/\bPMID\s*:?\s*(\d{1,9})\b/gi)) pushUnique(all.pmid, normalizePmid(match[1]));
  for (const match of rest.matchAll(/\b(?:PMCID\s*:?\s*)?(PMC\d{3,9})\b/gi)) pushUnique(all.pmcid, normalizePmcid(match[1]));
  const isbn = findIsbns(rest.replace(/\barxiv\s*:\s*\S+/gi, " ").replace(/\bPMC?ID\s*:?\s*\S+/gi, " "));
  const result: ExtractedIdentifiers = { urls, all };
  if (all.doi[0]) result.doi = all.doi[0];
  if (all.arxiv[0]) result.arxiv = all.arxiv[0];
  if (isbn.length) result.isbn = isbn;
  if (all.pmid[0]) result.pmid = all.pmid[0];
  if (all.pmcid[0]) result.pmcid = all.pmcid[0];
  return result;
}

export type ReferenceInputKind = "doi" | "arxiv" | "isbn" | "pmid" | "pmcid" | "url" | "bibtex" | "ris" | "csl-json" | "reference-text" | "bibliography";

function looksLikeCslJson(text: string) {
  if (!/^[[{]/.test(text)) return false;
  try {
    const value: unknown = JSON.parse(text);
    const items = Array.isArray(value) ? value : [value];
    return items.length > 0 && items.every((item) => !!item && typeof item === "object" && !Array.isArray(item) && ("type" in item || "title" in item));
  } catch {
    return false;
  }
}

const YEAR = /\b(1[5-9]\d{2}|20\d{2})[a-z]?\b/;

function looksLikeReference(text: string) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount >= 4 && (YEAR.test(text) || /\b10\.\d{4,9}\//.test(text) || /\bet al\b/.test(text));
}

/**
 * What the user pasted: a single identifier (with its normalized `value`),
 * BibTeX, RIS or CSL-JSON (by syntax), a bibliography (several
 * reference-looking lines or numbered items) or one reference string.
 */
export function classifyReferenceInput(text: string): { kind: ReferenceInputKind; value?: string } {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) return { kind: "reference-text" };
  if (/(^|\n)\s*@[A-Za-z]+\s*[{(]/.test(trimmed)) return { kind: "bibtex" };
  if (/(^|\n)TY\s*-/.test(trimmed)) return { kind: "ris" };
  if (looksLikeCslJson(trimmed)) return { kind: "csl-json" };
  if (!/\n/.test(trimmed)) {
    const single = trimmed.replace(/^<|>$/g, "");
    const isUrl = /^https?:\/\//i.test(single) && !/\s/.test(single);
    const doi = !/\s/.test(single.replace(/^doi\s*:?\s*/i, "")) ? normalizeDoi(single) : undefined;
    if (doi) return { kind: "doi", value: doi };
    const arxiv = normalizeArxivId(single);
    if (arxiv) return { kind: "arxiv", value: arxiv };
    const pmcid = normalizePmcid(single);
    if (pmcid && (/^pmc/i.test(single) || isUrl)) return { kind: "pmcid", value: pmcid };
    const isbn = /^(?:isbn(?:-1[03])?\s*:?\s*)?[\dXx][\dXx\s\-]{8,16}$/i.test(single) ? normalizeIsbn(single) : undefined;
    if (isbn) return { kind: "isbn", value: isbn };
    const pmid = /^(?:pmid\s*:?\s*\d+|\d{1,9})$/i.test(single) || (isUrl && /pubmed/i.test(single)) ? normalizePmid(single) : undefined;
    if (pmid) return { kind: "pmid", value: pmid };
    if (isUrl) return { kind: "url", value: trimTrailingPunctuation(single) };
  }
  const items = splitBibliography(trimmed);
  if (items.length > 1 && (NUMBERED.test(trimmed) || items.filter(looksLikeReference).length >= 2)) return { kind: "bibliography" };
  return { kind: "reference-text" };
}

const NUMBERED = /^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}\.)\s+/m;
const ITEM_MARKER = /^\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\d{1,4}\.)\s+/;

function joinLines(lines: string[]) {
  let text = "";
  for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
    if (!text) text = line;
    else if (/\p{Ll}-$/u.test(text) && /^\p{Ll}/u.test(line)) text = text.slice(0, -1) + line;
    else text += ` ${line}`;
  }
  return text;
}

/**
 * A pasted reference list → one string per reference. Recognizes `[1]`,
 * `1.` and `(1)` numbering, blank-line separation and hanging indents
 * (indented lines continue the previous reference). Without any of these,
 * each line is a reference unless it starts lowercase or the previous line
 * ends mid-sentence with a comma or hyphen.
 */
export function splitBibliography(text: string): string[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const groups: string[][] = [];
  const numberedLines = lines.filter((line) => ITEM_MARKER.test(line)).length;
  if (numberedLines >= 2 || (numberedLines === 1 && ITEM_MARKER.test(lines.find((line) => line.trim()) ?? ""))) {
    for (const line of lines) {
      if (ITEM_MARKER.test(line)) groups.push([line.replace(ITEM_MARKER, "")]);
      else if (line.trim() && groups.length) groups[groups.length - 1].push(line);
      else if (line.trim()) groups.push([line]);
    }
  } else if (/\n[ \t]*\n/.test(text.trim())) {
    let current: string[] = [];
    for (const line of lines) {
      if (line.trim()) {
        current.push(line);
      } else if (current.length) {
        groups.push(current);
        current = [];
      }
    }
    if (current.length) groups.push(current);
  } else {
    const indented = lines.some((line, index) => index > 0 && /^[ \t]+\S/.test(line)) && lines.some((line) => /^\S/.test(line));
    for (const line of lines) {
      if (!line.trim()) continue;
      const previous = groups[groups.length - 1];
      const previousText = previous?.[previous.length - 1].trim() ?? "";
      const continues = previous && (indented
        ? /^[ \t]+\S/.test(line)
        : /^\s*\p{Ll}/u.test(line) || /[,\-]$/.test(previousText));
      if (continues) previous.push(line);
      else groups.push([line]);
    }
  }
  return groups.map(joinLines).filter(Boolean);
}
