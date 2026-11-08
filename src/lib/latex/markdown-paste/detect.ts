/* Whether pasted plain text is Markdown worth converting (stage 1 of
 * docs/latex-markdown-paste-plan.md §2). Runs in the paste event, so it is a
 * handful of regular expressions: Markdown signals are scored against LaTeX
 * signals, and math counts for neither, since it is valid in both. The parse
 * then confirms (analyze.ts `hasMarkdownStructure`). */

import type { MathMarkerSettings } from "@/lib/math-markers";
import { pasteMathPairs } from "./markers";

export type MarkdownScore = { markdown: number; latex: number; isMarkdown: boolean };

const MAX_SCAN = 200_000;

function count(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0;
}

/**
 * The text with its formulas removed, for every pair of the paste's math
 * markers (the user's own and the common ones), in one pass. A pair whose
 * closer is not found once is never looked for again, so a run of openers
 * without closers stays linear. `$…$` stays on one line, as Markdown's
 * inline math does; the other pairs may span lines.
 */
function withoutMath(text: string, mathMarkers?: MathMarkerSettings) {
  const pairs = pasteMathPairs(mathMarkers);
  const exhausted = new Set<number>();
  let out = "";
  let index = 0;
  while (index < text.length) {
    let next = -1;
    pairs.forEach((pair, at) => {
      if (next >= 0 || exhausted.has(at) || !text.startsWith(pair.open, index)) return;
      const close = text.indexOf(pair.close, index + pair.open.length);
      if (close < 0) { exhausted.add(at); return; }
      if (pair.open === "$" && pair.close === "$" && (close === index + 1 || text.slice(index + 1, close).includes("\n"))) return;
      next = close + pair.close.length;
    });
    if (next >= 0) index = next;
    else out += text[index++];
  }
  return out;
}

/** Fenced code blocks removed, line by line (linear, however long a run of backticks). */
function withoutFences(text: string) {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(line)) fence = null;
      continue;
    }
    if (marker) { fence = marker; continue; }
    out.push(line);
  }
  return out.join("\n");
}

/** LaTeX environments whose contents are literal: Markdown inside them is not the paste's Markdown. */
const LITERAL_LATEX = /\\begin\s*\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|alltt)\}[\s\S]{0,200000}?\\end\s*\{\1\}/g;

/** Code (fenced, or inline) and math are left out before signals are counted. */
function withoutCodeAndMath(text: string, mathMarkers?: MathMarkerSettings) {
  return withoutMath(withoutFences(text).replace(/`[^`\n]+`/g, ""), mathMarkers);
}

export function scoreMarkdown(input: string, mathMarkers?: MathMarkerSettings): MarkdownScore {
  const text = input.length > MAX_SCAN ? input.slice(0, MAX_SCAN) : input;
  let literal = 0;
  // A LaTeX verbatim block holding Markdown is LaTeX: its contents do not count, the block counts for LaTeX.
  const prose = withoutCodeAndMath(text, mathMarkers).replace(LITERAL_LATEX, () => { literal++; return ""; });
  let markdown = 0;
  // Strong signals.
  if (/^ {0,3}#{1,6}[ \t]+\S/m.test(prose)) markdown += 3;
  if (/^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m.test(prose) || /^ {0,3}\|[ \t]*:?-{3,}:?[ \t]*\|[ \t]*$/m.test(prose)) markdown += 3;
  if (/^ {0,3}(`{3,}|~{3,})/m.test(text)) markdown += 3;
  if (/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S.*\n(?:[ \t]*\n)?[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/m.test(prose)) markdown += 3;
  if (/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]/m.test(prose)) markdown += 3;
  if (/^\[\^[^\]\s]+\]:/m.test(prose)) markdown += 3;
  // Repetitions are bounded: on a long line of `[` or `**` without a closer, an unbounded one rescans the rest of the line from every opener.
  if (/!\[[^\]\n]{0,300}\]\([^)\s]{1,500}(?:\s+"[^"\n]{0,300}")?\)/.test(prose)) markdown += 3;
  // Medium signals.
  if (/(?:\*\*|__)(?=\S)[^\n]{1,300}?(?<=\S)(?:\*\*|__)/.test(prose)) markdown += 2;
  if (/(?<!!)\[[^\]\n]{1,300}\]\((?:https?:|mailto:|#|\.{0,2}\/|[\w-]+\.)[^)\s]{0,500}\)/.test(prose)) markdown += 2;
  if (/^[^\n]+\n {0,3}(?:=+|-{2,})[ \t]*$/m.test(prose) && !/^ {0,3}-{3,}[ \t]*$/m.test(prose.split("\n")[0] ?? "")) markdown += 2;
  if (/^ {0,3}>[ \t]?\S/m.test(prose)) markdown += 2;
  if (/^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/m.test(prose)) markdown += 2;
  if (/^ {0,3}(?:-[ \t]*){3,}$/m.test(prose) && /\S/.test(prose.replace(/^ {0,3}(?:-[ \t]*){3,}$/gm, ""))) markdown += 1;
  // Weak signals.
  if (/(?:^|[\s(])\*(?=[^\s*])[^*\n]{1,300}(?<=[^\s*])\*(?=$|[\s).,;:!?])/m.test(prose)) markdown += 1;
  if (/`[^`\n]+`/.test(text)) markdown += 1;
  if (/>>>[^\n]{1,2000}?<<<|\[color=#[0-9a-f]{3,8}\]/i.test(text)) markdown += 1;
  if (/\[@[^\]\s]{1,100}[^\]\n]{0,300}\]/.test(prose)) markdown += 1;
  if (/~~(?=\S)[^~\n]{1,300}(?<=\S)~~/.test(prose)) markdown += 1;

  let latex = 3 * Math.min(3, literal);
  latex += 3 * Math.min(3 - Math.min(3, literal), count(prose, /\\(?:begin|end)\s*\{[A-Za-z*]+\}/g));
  latex += 3 * Math.min(2, count(prose, /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/g));
  latex += 2 * Math.min(3, count(prose, /\\item\b/g));
  latex += 2 * Math.min(3, count(prose, /\\(?:textbf|textit|emph|texttt|underline|cite|citep|citet|parencite|textcite|ref|eqref|label|includegraphics|href|url|footnote|caption|usepackage|documentclass|newcommand)\s*[[{]/g));
  latex += Math.min(3, count(prose, /&[^\n&]*\\\\\s*$/gm));
  const lines = prose.split("\n").filter((line) => line.trim());
  // Comment lines, counted line by line (a pattern to each line's end would rescan long lines for every %).
  if (lines.filter((line) => /(?:^|[^\\])%/.test(line)).length > 1) latex += 2;
  if (lines.length >= 3 && lines.filter((line) => /^\s*\\[A-Za-z]/.test(line)).length / lines.length > 0.4) latex += 3;
  return { markdown, latex, isMarkdown: markdown >= 3 && markdown > latex };
}

/**
 * Markdown syntax that rendered rich text never shows in its `text/plain`:
 * headings, bold markers, table rules, code fences, link syntax, `$$`.
 * Word and web pages put list items on lines of their own, so lists alone
 * do not count when rich HTML is on the clipboard too.
 */
export function hasMarkdownSyntax(text: string) {
  const sample = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  return /^ {0,3}#{1,6}[ \t]+\S/m.test(sample)
    || /(?:\*\*|__)(?=\S)[^\n]{1,300}?(?<=\S)(?:\*\*|__)/.test(sample)
    || /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*\|/m.test(sample)
    || /^ {0,3}(`{3,}|~{3,})/m.test(sample)
    || /(?<!!)\[[^\]\n]{1,300}\]\([^)\s]{1,500}\)/.test(sample)
    || /^[ \t]*\$\$[ \t]*$/m.test(sample);
}

/** Whether a paste's text is Markdown to convert. `richHtml`: the clipboard also holds formatted HTML (Word, Google Docs, a web page). */
export function looksLikeMarkdown(text: string, { richHtml = false, mathMarkers }: { richHtml?: boolean; mathMarkers?: MathMarkerSettings } = {}) {
  if (!scoreMarkdown(text, mathMarkers).isMarkdown) return false;
  return !richHtml || hasMarkdownSyntax(text);
}

/** Clipboard HTML with structure or formatting of its own (not a code editor's coloured lines). */
export function isRichClipboardHtml(html: string) {
  return /<(?:b|strong|i|em|u|s|del|sup|sub|mark|h[1-6]|ul|ol|li|table|blockquote|p|pre|code|a\s[^>]*href|math|img)\b/i.test(html)
    || /font-weight\s*:\s*(?:bold|[6-9]00)|font-style\s*:\s*italic/i.test(html)
    || /class="[^"]*\b(?:katex|MathJax)\b/.test(html);
}
