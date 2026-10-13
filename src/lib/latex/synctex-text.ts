/**
 * SyncTeX inverse search only knows the source line a PDF box came from, which
 * for a paragraph written on one long line is no better than "this paragraph".
 * These helpers refine the jump with the text the reader clicked: the word
 * under the pointer and a little of what surrounds it in the PDF.
 */

/** The clicked word and the PDF text on either side of it. */
export type SynctexTextHint = { word: string; before: string; after: string };

const CONTEXT_LETTERS = 48;
/** How far around the reported line to look, in lines. */
const SEARCH_LINES_BEFORE = 30;
const SEARCH_LINES_AFTER = 8;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Letters and digits only, folded, so PDF text and LaTeX source compare. */
export function comparableLetters(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Source text as a reader sees it: comments, command names and braces removed. */
function readableSource(text: string) {
  return text.replace(/(?<!\\)%.*$/gm, " ").replace(/\\[a-zA-Z@]+\*?/g, " ");
}

/** The word around `offset` in `text`, plus context, as a hint for inverse search. */
export function textHintAt(text: string, offset: number): SynctexTextHint | null {
  let start = Math.max(0, Math.min(text.length, offset));
  let end = start;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  while (end < text.length && WORD_CHAR.test(text[end])) end += 1;
  // A click just past a word's end still means that word.
  if (start === end && start > 0 && WORD_CHAR.test(text[start - 1])) return textHintAt(text, start - 1);
  const word = text.slice(start, end);
  if (!word) return null;
  return {
    word,
    before: text.slice(Math.max(0, start - CONTEXT_LETTERS * 3), start),
    after: text.slice(end, end + CONTEXT_LETTERS * 3),
  };
}

function commonSuffix(a: string, b: string) {
  let count = 0;
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

function commonPrefix(a: string, b: string) {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the clicked word in `doc` near `lineNumber` (1-based). Returns the
 * word's range, or null when the word does not appear near that line.
 */
export function locateTextHint(doc: string, lineNumber: number, hint: SynctexTextHint): { from: number; to: number } | null {
  const word = hint.word.normalize("NFKC");
  if (!comparableLetters(word)) return null;

  const lineStarts = [0];
  for (let index = doc.indexOf("\n"); index >= 0; index = doc.indexOf("\n", index + 1)) lineStarts.push(index + 1);
  const lineIndex = Math.max(0, Math.min(lineStarts.length - 1, lineNumber - 1));
  const regionFrom = lineStarts[Math.max(0, lineIndex - SEARCH_LINES_BEFORE)];
  const regionTo = lineIndex + SEARCH_LINES_AFTER + 1 < lineStarts.length ? lineStarts[lineIndex + SEARCH_LINES_AFTER + 1] : doc.length;
  const lineFrom = lineStarts[lineIndex];
  const lineTo = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : doc.length;

  const before = comparableLetters(hint.before).slice(-CONTEXT_LETTERS);
  const after = comparableLetters(hint.after).slice(0, CONTEXT_LETTERS);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, "giu");
  const region = doc.slice(regionFrom, regionTo);

  let best: { from: number; to: number; score: number } | null = null;
  for (const match of region.matchAll(pattern)) {
    const from = regionFrom + match.index;
    const to = from + match[0].length;
    // Skip matches inside command names, such as "section" in \section.
    if (/\\[a-zA-Z@]*$/.test(doc.slice(Math.max(0, from - 40), from))) continue;
    const sourceBefore = comparableLetters(readableSource(doc.slice(Math.max(0, from - CONTEXT_LETTERS * 4), from)));
    const sourceAfter = comparableLetters(readableSource(doc.slice(to, to + CONTEXT_LETTERS * 4)));
    const context = commonSuffix(before, sourceBefore) + commonPrefix(after, sourceAfter);
    // Context decides; staying on (or near) the line SyncTeX named breaks ties.
    const distance = from < lineFrom ? lineFrom - from : from > lineTo ? from - lineTo : 0;
    const score = context * 1000 + (match[0] === word ? 500 : 0) - Math.min(distance, 499);
    if (!best || score > best.score) best = { from, to, score };
  }
  return best ? { from: best.from, to: best.to } : null;
}
