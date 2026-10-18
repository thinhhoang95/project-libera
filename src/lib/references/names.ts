import { decodeLatex, encodeLatex, type LatexDialect } from "./latex-text";
import type { CslName } from "./types";

// Personal and corporate names → CSL names. Handles BibTeX's three forms
// ("First von Last", "von Last, First", "von Last, Jr, First"), RIS's
// "Last, First, Suffix", particles and suffixes, and brace-protected
// corporate names (`{World Health Organization}` → literal). With
// `latex: true` the input is BibTeX source: splitting respects brace depth
// and each part is decoded from LaTeX afterwards. Pure and dependency-free.

export type NameParseOptions = {
  /** The text is BibTeX source: brace-aware, decoded from LaTeX. */
  latex?: boolean;
};

/** Name particles. Lowercase ones become `non-dropping-particle`. */
export const NAME_PARTICLES = new Set([
  "van", "von", "der", "den", "de", "la", "le", "du", "di", "da", "dos", "das", "do", "ten", "ter", "al", "el", "bin", "ibn",
  "bint", "ben", "abu", "del", "della", "degli", "dei", "des", "lo", "zu", "zum", "zur", "vom", "het", "op", "y", "e", "st.", "san",
]);
const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
/** Words that mark an unbraced name as institutional. */
const CORPORATE_WORDS = /\b(organi[sz]ation|institut(e|o)?|university|universit(é|ät|y)|association|society|council|committee|group|agency|foundation|department|ministry|consortium|collaboration|centre|center|board|office|bureau|commission|corporation|company|inc\.?|ltd\.?|llc|gmbh|team|project|network|alliance|federation|academy|laboratory|press)\b/i;

type Token = { raw: string; text: string };

/** Splits at `separator` (a single character) outside braces. */
function splitTopLevel(text: string, separator: string, latex: boolean) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (latex && char === "\\") {
      index += 1;
    } else if (latex && char === "{") {
      depth += 1;
    } else if (latex && char === "}") {
      depth = Math.max(0, depth - 1);
    } else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/** Words at brace depth 0. `~` separates words like a space in BibTeX. */
function words(text: string, latex: boolean): Token[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (latex && char === "\\" && depth === 0 && index + 1 < text.length) {
      current += char + text[index + 1];
      index += 1;
      continue;
    }
    if (latex && char === "{") depth += 1;
    if (latex && char === "}") depth = Math.max(0, depth - 1);
    if (depth === 0 && (/\s/.test(char) || (latex && char === "~"))) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens.map((raw) => ({ raw, text: latex ? decodeLatex(raw, { markup: "plain" }) : raw }));
}

/** A lowercase word in BibTeX's sense: first letter lowercase, not inside a protecting group. */
function isLowercase(token: Token, latex: boolean) {
  if (latex && /^\{(?!\\)/.test(token.raw)) return false;
  const letter = token.text.match(/[^\W\d_]/u)?.[0] ?? Array.from(token.text).find((char) => char.toLowerCase() !== char.toUpperCase());
  return !!letter && letter === letter.toLowerCase() && letter !== letter.toUpperCase();
}

function isParticle(token: Token) {
  return NAME_PARTICLES.has(token.text.toLowerCase()) || /^(d|l|dell)['’]$/i.test(token.text);
}

function isSuffix(text: string) {
  return SUFFIXES.has(text.trim().toLowerCase());
}

function joined(tokens: Token[]) {
  return tokens.map((token) => token.text).join(" ").trim();
}

function decodePart(text: string, latex: boolean) {
  return (latex ? decodeLatex(text, { markup: "plain" }) : text).replace(/\s+/g, " ").trim();
}

function compact(name: CslName): CslName {
  const result: CslName = {};
  for (const field of ["family", "given", "dropping-particle", "non-dropping-particle", "suffix", "literal"] as const) {
    const value = name[field]?.trim();
    if (value) result[field] = value;
  }
  return result;
}

/** "von Last" (the part before the first comma): leading lowercase words are the particle. */
function vonLast(tokens: Token[], latex: boolean): CslName {
  if (!tokens.length) return {};
  let split = 0;
  while (split < tokens.length - 1 && isLowercase(tokens[split], latex)) split += 1;
  return { "non-dropping-particle": joined(tokens.slice(0, split)), family: joined(tokens.slice(split)) };
}

/** "First von Last", the form without commas. */
function firstVonLast(tokens: Token[], latex: boolean): CslName {
  let suffix = "";
  if (tokens.length > 2 && isSuffix(tokens[tokens.length - 1].text)) {
    suffix = tokens[tokens.length - 1].text;
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 1) return { family: tokens[0].text, suffix };
  // BibTeX's von part: lowercase words between the first name and the last word.
  let vonStart = tokens.findIndex((token, index) => index > 0 && index < tokens.length - 1 && isLowercase(token, latex));
  if (vonStart > 0) {
    let vonEnd = vonStart;
    for (let index = vonStart; index < tokens.length - 1; index += 1) if (isLowercase(tokens[index], latex)) vonEnd = index;
    return {
      given: joined(tokens.slice(0, vonStart)),
      "non-dropping-particle": joined(tokens.slice(vonStart, vonEnd + 1)),
      family: joined(tokens.slice(vonEnd + 1)),
      suffix,
    };
  }
  // Capitalized particles ("Johannes Van Der Berg", "Anna Di Lorenzo") start the family name.
  vonStart = tokens.findIndex((token, index) => index > 0 && index < tokens.length - 1 && isParticle(token));
  const familyStart = vonStart > 0 ? vonStart : tokens.length - 1;
  return { given: joined(tokens.slice(0, familyStart)), family: joined(tokens.slice(familyStart)), suffix };
}

/**
 * One name → CSL. Accepts "First Last", "Last, First", "von Last, Jr,
 * First", "Last, First, Jr" and corporate names: a fully braced BibTeX name,
 * or (plain text) a name containing a word like "Organization" or
 * "University", becomes `literal`.
 */
export function parseName(text: string, options: NameParseOptions = {}): CslName {
  const latex = !!options.latex;
  const source = text.trim().replace(/[,\s]+$/, "");
  if (!source) return {};
  if (latex && source.startsWith("{") && source.endsWith("}")) {
    // `{World Health Organization}`: one group encloses the whole name.
    let depth = 0;
    let closesAtEnd = true;
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] === "\\") index += 1;
      else if (source[index] === "{") depth += 1;
      else if (source[index] === "}" && --depth === 0 && index < source.length - 1) closesAtEnd = false;
    }
    if (closesAtEnd) return compact({ literal: decodePart(source.slice(1, -1), true) });
  }
  const parts = splitTopLevel(source, ",", latex).filter((part, index) => part || index === 0);
  if (parts.length === 1) {
    if (!latex && CORPORATE_WORDS.test(source)) return { literal: source.replace(/\s+/g, " ") };
    return compact(firstVonLast(words(parts[0], latex), latex));
  }
  const last = vonLast(words(parts[0], latex), latex);
  if (parts.length === 2) {
    if (isSuffix(decodePart(parts[1], latex))) return compact({ ...last, suffix: decodePart(parts[1], latex) });
    return compact({ ...last, given: decodePart(parts[1], latex) });
  }
  // Three or more parts: BibTeX's "Last, Jr, First" or RIS's "Last, First, Jr".
  const second = decodePart(parts[1], latex);
  const rest = parts.slice(2).map((part) => decodePart(part, latex));
  if (!isSuffix(second) && rest.length === 1 && isSuffix(rest[0])) return compact({ ...last, given: second, suffix: rest[0] });
  return compact({ ...last, suffix: second, given: rest.join(" ") });
}

/** Splits a BibTeX name list on " and " at brace depth 0 (case-insensitive). */
function splitAnd(text: string) {
  const names: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /\s/.test(char)) {
      const match = text.slice(index).match(/^\s+and\s+/i);
      if (match) {
        names.push(text.slice(start, index));
        index += match[0].length - 1;
        start = index + 1;
      }
    }
  }
  names.push(text.slice(start));
  return names.map((name) => name.trim()).filter(Boolean);
}

/**
 * A BibTeX name list ("A and B and others") → CSL names. A final "others"
 * sets `etAl`; it is not a name.
 */
export function parseBibtexNameList(text: string): { names: CslName[]; etAl: boolean } {
  const parts = splitAnd(text.replace(/\s+/g, " "));
  let etAl = false;
  if (parts.length && parts[parts.length - 1].toLowerCase() === "others") {
    etAl = true;
    parts.pop();
  }
  return { names: parts.map((part) => parseName(part, { latex: true })).filter((name) => Object.keys(name).length > 0), etAl };
}

/**
 * A plain-text list of people, as in RIS `AU` lines or pasted text: names
 * separated by newlines or semicolons, or by " and " / " & " when there are
 * no semicolons. Each name is parsed with `parseName`.
 */
export function parsePersonList(text: string): CslName[] {
  const lines = text.split(/[\r\n;]+/).map((line) => line.trim()).filter(Boolean);
  const parts = lines.length > 1 || text.includes(";") ? lines : lines.flatMap((line) => line.split(/\s+(?:and|&)\s+/i));
  return parts.map((part) => parseName(part)).filter((name) => Object.keys(name).length > 0);
}

function needsBraces(text: string) {
  // Words BibTeX would misread: a lowercase first word (a "von" part), or "and" inside the part.
  return /^\p{Ll}/u.test(text) || /\sand\s/i.test(text) || text.includes(",");
}

/**
 * A CSL name in BibTeX's "von Last, Jr, First" form, LaTeX-encoded. Literal
 * names are braced so BibTeX keeps them whole.
 */
export function formatBibtexName(name: CslName, dialect: LatexDialect = "biblatex") {
  const encode = (text: string) => encodeLatex(text, dialect);
  if (name.literal && !name.family) return `{${encode(name.literal)}}`;
  let family = name.family ? encode(name.family) : "";
  if (family && needsBraces(name.family!)) family = `{${family}}`;
  const particle = [name["dropping-particle"], name["non-dropping-particle"]].filter(Boolean).map((part) => encode(part!)).join(" ");
  const last = [particle, family].filter(Boolean).join(" ");
  const given = name.given ? encode(name.given) : "";
  const suffix = name.suffix ? encode(name.suffix) : "";
  if (!given && !suffix) return last || (name.literal ? `{${encode(name.literal)}}` : "");
  if (suffix) return `${last}, ${suffix}, ${given}`;
  return `${last}, ${given}`;
}

/**
 * A name for display: "Jane van Smith Jr." (given first, the default) or
 * "van Smith, Jane, Jr." (family first, for sorted lists).
 */
export function formatNameForDisplay(name: CslName, options: { order?: "given-first" | "family-first" } = {}) {
  if (name.literal && !name.family) return name.literal;
  const family = [name["non-dropping-particle"], name.family].filter(Boolean).join(" ");
  if ((options.order ?? "given-first") === "family-first") {
    const given = [name.given, name["dropping-particle"]].filter(Boolean).join(" ");
    return [family, given, name.suffix].filter(Boolean).join(", ") || name.literal || "";
  }
  return [name.given, name["dropping-particle"], family, name.suffix].filter(Boolean).join(" ") || name.literal || "";
}
