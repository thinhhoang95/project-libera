import katex from "katex";
import { expandMacroLatex, type MarkdownMacroDefinitions } from "@/lib/markdown-macros";
import { escapedAt, matchMath, type MathMarkerPair } from "@/lib/math-markers";
import { definitionKey, findQuoteRange, lineAtOffset, type DefinitionEntry } from "@/lib/definitions";
import type { PdfTextPage } from "@/lib/types";

// Checks on the cards the agent sends to SaveDefinitions, and on what it left
// out, so the model is told precisely what to fix (extract-definitions skill).
// A card is rejected when the Definitions tab could not show it right (math
// KaTeX cannot typeset, LaTeX outside math) or could not jump to it (an
// excerpt or line that is not in the document).

/** What a card is checked against: the document as the agent read it. */
export type DefinitionSource =
  | { kind: "text"; content: string; macros?: MarkdownMacroDefinitions }
  | { kind: "pdf"; pages: PdfTextPage[] };

export type CardCheck = {
  /** The card with its line or page settled from its excerpt. */
  entry: DefinitionEntry;
  /** Why the card was rejected; empty when it was saved. */
  problems: string[];
  /** Saved, with something the model should know. */
  notes: string[];
};

const MIN_MEANING_CHARS = 12;

function excerpt(text: string, limit = 80) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** KaTeX's message without its position dump. */
function katexMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^KaTeX parse error:\s*/, "").replace(/\s+at position \d+:[\s\S]*$/, "").trim();
}

/** Problems with the Markdown and math of one field of a card. */
export function checkMarkdownMath(field: string, value: string, pairs: MathMarkerPair[], macros?: MarkdownMacroDefinitions): string[] {
  const problems: string[] = [];
  const counters = new Map<string, number>();
  let outside = "";
  let index = 0;
  while (index < value.length) {
    // Code spans are shown as written.
    if (value[index] === "`") {
      const fence = /^`+/.exec(value.slice(index))![0];
      const close = value.indexOf(fence, index + fence.length);
      if (close > 0) { index = close + fence.length; continue; }
    }
    const opener = escapedAt(value, index) ? undefined : pairs.find((pair) => value.startsWith(pair.open, index));
    if (!opener) { outside += value[index]; index++; continue; }
    const rest = value.slice(index);
    const match = matchMath(rest, pairs, true) ?? matchMath(rest, pairs, false);
    if (!match) {
      problems.push(opener.display
        ? `${field}: display math ${opener.open}…${opener.close} at “${excerpt(rest, 40)}” must have each marker on its own line; inside a sentence use inline math.`
        : `${field}: the math opened by ${opener.open} at “${excerpt(rest, 40)}” is never closed with ${opener.close} (inline math must stay on one line).`);
      outside += opener.open;
      index += opener.open.length;
      continue;
    }
    const display = pairs.some((pair) => pair.display && pair.open === match.open);
    const latex = macros?.macros.size ? expandMacroLatex(match.latex, macros, counters) : match.latex;
    try {
      katex.renderToString(latex, { displayMode: display, throwOnError: true, strict: "ignore" });
    } catch (error) {
      problems.push(`${field}: KaTeX cannot typeset ${match.raw.length > 60 ? `${match.open}${excerpt(match.latex, 50)}${match.close}` : match.raw}: ${katexMessage(error)}. Use standard LaTeX that KaTeX supports${macros?.macros.size ? " or the note's Markdown macros" : "; write out the document's own \\newcommand macros"}.`);
    }
    index += match.raw.length;
  }
  // The shortest inline pair is the one to suggest: `$`, not `$$`.
  const inline = pairs.filter((pair) => !pair.display).sort((left, right) => left.open.length - right.open.length)[0] ?? { open: "$", close: "$" };
  const stray = [...outside.matchAll(/\\([a-zA-Z]+)/g)].map((found) => found[1]).filter((name) => !macros?.macros.has(name));
  if (stray.length) {
    const names = [...new Set(stray)].slice(0, 4).map((name) => `\\${name}`).join(", ");
    problems.push(`${field}: ${names} is outside math markers, so it would show as raw text. Put formulas inside ${inline.open}…${inline.close}.`);
  }
  return problems;
}

/** Letters and digits only, lower-cased: PDF text breaks words, ligatures and spacing unpredictably. */
function looseText(text: string) {
  return text.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Checks one card and settles where it is introduced. */
export function checkDefinitionCard(raw: DefinitionEntry, source: DefinitionSource, pairs: MathMarkerPair[]): CardCheck {
  const entry: DefinitionEntry = { ...raw };
  const problems: string[] = [];
  const notes: string[] = [];
  const macros = source.kind === "text" ? source.macros : undefined;

  problems.push(...checkMarkdownMath("term", entry.term, pairs, macros), ...checkMarkdownMath("meaning", entry.meaning, pairs, macros));
  const bare = (text: string) => text.replace(/[\s$\\{}*_`.,;:]/g, "").toLowerCase();
  if (entry.meaning.length < MIN_MEANING_CHARS || bare(entry.meaning) === bare(entry.term)) {
    problems.push("meaning: explain what the term means in this document (its definition, the kind of object, its assumptions), not just restate it.");
  }

  if (source.kind === "text") {
    const lineCount = source.content.split("\n").length;
    if (entry.quote) {
      const range = findQuoteRange(source.content, entry.quote);
      if (range) entry.line = lineAtOffset(source.content, range.start);
      else {
        const hint = entry.line && entry.line <= lineCount ? ` Line ${entry.line} reads: “${excerpt(source.content.split("\n")[entry.line - 1] ?? "", 120)}”.` : "";
        problems.push(`quote: “${excerpt(entry.quote)}” is not in the document. Copy a short excerpt exactly as Read showed it, without line numbers.${hint}`);
      }
    } else if (entry.line) {
      if (entry.line > lineCount) problems.push(`line: the document has ${lineCount} lines; ${entry.line} is past its end.`);
    } else problems.push("quote: give a short exact excerpt (or the line) where it is introduced, so the reader can jump there.");
    delete entry.page;
  } else {
    const pageCount = source.pages.length;
    if (entry.page && entry.page > pageCount) problems.push(`page: the PDF has ${pageCount} pages; ${entry.page} is past its end.`);
    if (entry.quote) {
      const wanted = looseText(entry.quote);
      const found = wanted.length >= 8 ? source.pages.find((page) => looseText(page.text).includes(wanted)) : undefined;
      if (found) {
        if (entry.page && entry.page !== found.pageNumber) notes.push(`“${excerpt(entry.term, 40)}”: the excerpt is on page ${found.pageNumber}, not ${entry.page}; the page was corrected.`);
        entry.page = found.pageNumber;
      } else {
        // PDF text extraction mangles math; keep the card, jump by page.
        delete entry.quote;
        if (!entry.page) problems.push(`quote: “${excerpt(raw.quote ?? "")}” is not in the PDF's text, and there is no page. Give the page where it is introduced.`);
      }
    } else if (!entry.page) problems.push("page: give the page where it is introduced, and a short exact excerpt if you can.");
    delete entry.line;
  }
  return { entry, problems, notes };
}

/** Checks a SaveDefinitions call: each card, and repeats within the call. */
export function checkDefinitionCards(entries: DefinitionEntry[], source: DefinitionSource, pairs: MathMarkerPair[]) {
  const seen = new Map<string, number>();
  return entries.map((entry, index) => {
    const check = checkDefinitionCard(entry, source, pairs);
    const key = definitionKey(entry);
    const first = seen.get(key);
    if (first !== undefined) check.problems.push(`entries[${first}] has the same kind, term and location; merge them, or give each meaning of an overloaded symbol its own location.`);
    else seen.set(key, index);
    return check;
  });
}

// Passages that almost always introduce a definition or notation. The finish
// pass names those no card is near, so the model reads them again.
// Block signals open a definition that may run several lines; phrase signals
// sit on the line that defines.
const TEXT_BLOCK_SIGNALS: RegExp[] = [
  /\\begin\{(?:definition|defn|dfn|notation|convention|assumption)s?\*?\}/i,
  /^\s{0,3}#{1,6}\s+.*\b(?:definitions?|notations?|conventions?)\b/i,
  /^\s*(?:\*\*|__|\*|_)?\s*(?:definition|notation|convention)s?\b[^.\n]{0,40}?(?:\*\*|__|\*|_)?\s*[.:]/i,
  /\\section\*?\{[^}]*\b(?:definitions?|notations?|conventions?)\b/i,
];
const TEXT_PHRASE_SIGNALS: RegExp[] = [
  /:=|\\coloneqq|\\eqqcolon|\\triangleq|\\stackrel\{\\(?:text|mathrm)\{def\}\}/,
  /\b(?:we\s+(?:say|call|define|denote|write)|is\s+(?:called|said\s+to\s+be|denoted)|(?:are|is)\s+denoted\s+by|denotes?\s+the|let\s+\S+\s+denote)\b/i,
];
const PDF_SIGNAL = /\b(?:definition|notation|convention)\s+\d+(?:\.\d+)*\b|\bwe\s+(?:say|call|define|denote)\b|\bis\s+(?:called|said\s+to\s+be|denoted)\b|:=/i;

export type UncoveredPassage = { line?: number; page?: number; text: string };

/** Passages that look like definitions but have no card within a few lines (or on the page). */
export function uncoveredDefinitionPassages(source: DefinitionSource, entries: DefinitionEntry[]): UncoveredPassage[] {
  const uncovered: UncoveredPassage[] = [];
  if (source.kind === "text") {
    const cardLines = entries.map((entry) => entry.line).filter((line): line is number => !!line).sort((a, b) => a - b);
    let fence = false;
    source.content.split("\n").forEach((text, index) => {
      if (/^\s{0,3}(?:`{3,}|~{3,})/.test(text)) fence = !fence;
      if (fence) return;
      const block = TEXT_BLOCK_SIGNALS.some((signal) => signal.test(text));
      if (!block && !TEXT_PHRASE_SIGNALS.some((signal) => signal.test(text))) return;
      const line = index + 1;
      // A card points at the defining line; inside an environment it may be a few lines on.
      const reach = block ? 8 : 1;
      if (cardLines.some((cardLine) => cardLine >= line - 1 && cardLine <= line + reach)) return;
      uncovered.push({ line, text: excerpt(text, 100) });
    });
  } else {
    const cardPages = new Set(entries.map((entry) => entry.page));
    for (const page of source.pages) {
      if (cardPages.has(page.pageNumber)) continue;
      const match = PDF_SIGNAL.exec(page.text);
      if (match) uncovered.push({ page: page.pageNumber, text: excerpt(page.text.slice(Math.max(0, match.index - 30), match.index + 70), 100) });
    }
  }
  return uncovered;
}
