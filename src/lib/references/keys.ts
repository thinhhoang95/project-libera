import type { CslItem, CslName } from "./types";

// Citation keys. A key is generated once, when an entry is created, and is
// never regenerated when its metadata changes (docs/references/plan.md §2).
// Generated keys are lowercase ASCII: family name + year + first significant
// title word, e.g. "smith2020sparse", with a/b/… suffixes on collision.

/**
 * Key grammar, shared by every citation parser. Pandoc's rule: a key starts
 * with a letter, digit or underscore, and may contain internal punctuation
 * from `:.#$%&-+?<>~/` when it is followed by a letter, digit or underscore.
 */
export const CITATION_KEY_SOURCE = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/](?=[\p{L}\p{N}_]))*`;
const KEY_PATTERN = new RegExp(`^${CITATION_KEY_SOURCE}$`, "u");

export function isValidCitationKey(key: string) {
  return key.length > 0 && key.length <= 200 && KEY_PATTERN.test(key);
}

const SPECIAL_LETTERS: Record<string, string> = {
  ß: "ss", æ: "ae", Æ: "ae", œ: "oe", Œ: "oe", ø: "o", Ø: "o", ł: "l", Ł: "l", đ: "d", Đ: "d",
  ð: "d", Ð: "d", þ: "th", Þ: "th", ı: "i", ŋ: "ng", ĸ: "k",
};

/** Lowercase ASCII letters and digits only; diacritics are folded. */
export function asciiKeyPart(text: string) {
  return text
    .replace(/[ßæÆœŒøØłŁđĐðÐþÞıŋĸ]/g, (letter) => SPECIAL_LETTERS[letter] ?? letter)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const STOPWORDS = new Set([
  // English
  "a", "an", "the", "of", "on", "in", "for", "to", "and", "or", "with", "from", "by", "at", "as",
  "is", "are", "be", "into", "onto", "via", "vs", "versus", "its", "it", "this", "that", "these",
  "those", "how", "what", "why", "when", "where", "which", "who", "do", "does", "can", "we", "our",
  "towards", "toward", "about", "over", "under", "between", "among", "through", "not", "no", "new",
  // French, German, Spanish, Italian, Portuguese, Dutch
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "en", "au", "aux", "der", "die", "das",
  "ein", "eine", "und", "zur", "zum", "von", "im", "el", "los", "las", "una", "y", "del", "il", "lo",
  "gli", "di", "e", "o", "os", "as", "um", "uma", "het", "een", "van",
]);

function nameForKey(name: CslName) {
  if (name.family) return name.family;
  if (name.literal) return name.literal.split(/\s+/)[0] ?? "";
  return name.given ?? "";
}

function firstCreator(csl: CslItem) {
  return csl.author?.[0] ?? csl.editor?.[0] ?? csl["container-author"]?.[0] ?? csl.translator?.[0];
}

function issuedYear(csl: CslItem) {
  const year = csl.issued?.["date-parts"]?.[0]?.[0];
  if (typeof year === "number" && Number.isFinite(year)) return String(Math.trunc(year));
  const match = (csl.issued?.literal ?? csl.issued?.raw ?? "").match(/\b(1\d{3}|2\d{3})\b/);
  return match?.[1] ?? "";
}

function titleWords(csl: CslItem) {
  return (csl.title ?? "").split(/[\s\-–—:;,.!?/()[\]{}"'“”‘’]+/).map(asciiKeyPart).filter(Boolean);
}

/** The key an entry would get without collisions. */
export function baseCitationKey(csl: CslItem) {
  const creator = firstCreator(csl);
  const name = creator ? asciiKeyPart(nameForKey(creator)) : "";
  const words = titleWords(csl);
  const word = words.find((candidate) => !STOPWORDS.has(candidate) && !/^\d+$/.test(candidate)) ?? words[0] ?? "";
  const year = issuedYear(csl);
  let key = `${name.slice(0, 40)}${year}${word.slice(0, 20)}`;
  if (!key) key = "ref";
  // Keys must not start with punctuation; our parts are [a-z0-9], so any start is valid.
  return key;
}

function suffix(index: number) {
  // 0 → a, 25 → z, 26 → aa, …
  let value = index;
  let text = "";
  do {
    text = String.fromCharCode(97 + (value % 26)) + text;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return text;
}

/**
 * A key for a new entry, unique against `taken` (keys and aliases already in
 * the library, compared case-insensitively). Collisions get a, b, … suffixes.
 */
export function generateCitationKey(csl: CslItem, taken: Iterable<string>) {
  const used = new Set([...taken].map((key) => key.toLowerCase()));
  const base = baseCitationKey(csl);
  if (!used.has(base)) return base;
  for (let index = 0; ; index += 1) {
    const candidate = `${base}${suffix(index)}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Every key and alias in a set of entries, for collision checks. */
export function takenCitationKeys(entries: Iterable<{ key: string; aliases: string[] }>) {
  const keys: string[] = [];
  for (const entry of entries) keys.push(entry.key, ...entry.aliases);
  return keys;
}
