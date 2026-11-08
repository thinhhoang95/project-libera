import katex from "katex";
import { stripTexComments } from "../../macros/numbering";

/* KaTeX for the Visual mode. Formulas arrive with the document's macros
 * already expanded (macros/expand.ts). A formula KaTeX cannot parse is not
 * drawn: it stays as source, so the Visual mode never shows a formula other
 * than the one in the file. Equation numbers come from the numbering pass,
 * set on KaTeX's number slots (`.eqn-num`), because KaTeX numbers with a CSS
 * counter and cannot number rows with `\tag`. */

const cache = new Map<string, string | null>();
const CACHE_LIMIT = 3000;

/** HTML for a formula, or null when KaTeX cannot render it. Cached. */
/** Package commands KaTeX lacks, as KaTeX macros: nicefrac/xfrac's slanted fractions, bbm/dsfont's blackboard letters. */
export const KATEX_MACROS: Record<string, string> = {
  "\\nicefrac": "{}^{#1}\\!/\\!{}_{#2}",
  "\\sfrac": "{}^{#1}\\!/\\!{}_{#2}",
  "\\mathbbm": "\\mathbb{#1}",
  "\\mathds": "\\mathbb{#1}",
  "\\bbm": "\\mathbb{#1}",
};

/** LaTeX KaTeX lacks, written as what it can draw: `\textsc{Base}` as `\text{B{\small ASE}}` (small capitals). */
export function forKatex(latex: string) {
  if (!latex.includes("\\textsc")) return latex;
  return latex.replace(/\\textsc\s*\{([^{}]*)\}/g, (_, text: string) => `\\text{${text.replace(/[a-z]+/g, (run) => `{\\small ${run.toUpperCase()}}`)}}`);
}

export function renderKatex(latex: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${latex}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let html: string | null;
  try {
    html = katex.renderToString(forKatex(latex), { displayMode: display, throwOnError: true, strict: "ignore", trust: false, maxExpand: 500, output: "html", macros: { ...KATEX_MACROS } });
  } catch {
    html = null;
  }
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return html;
}

const NUMBERED_ROWS = new Set(["align", "alignat", "flalign", "gather", "eqnarray"]);
const UNNUMBERED_DISPLAY = new Set(["displaymath", "math"]);

/**
 * Labels go: KaTeX has no \label. `\tag` stays: KaTeX draws it as written
 * (`\tag*{A}` without parentheses), also in starred environments, and the
 * numbering pass numbers only the other rows.
 */
function stripNumbering(body: string) {
  return body.replace(/\\label\s*\{[^}]*\}/g, "");
}

export type DisplayMathSource = { latex: string; numbered: boolean; inline: boolean };

/**
 * The KaTeX source for a math environment: unnumbered environments KaTeX
 * lacks are drawn with a near equivalent (multline as gathered lines, eqnarray
 * as align).
 */
export function katexForEnvironment(env: string, body: string): DisplayMathSource {
  const starred = env.endsWith("*");
  const base = env.replace(/\*$/, "");
  const content = stripNumbering(body);
  if (base === "math") return { latex: content, numbered: false, inline: true };
  if (UNNUMBERED_DISPLAY.has(base)) return { latex: content, numbered: false, inline: false };
  if (base === "equation") {
    const numbered = !starred && !/\\(?:nonumber|notag)\b/.test(stripTexComments(content));
    return { latex: numbered ? `\\begin{equation}${content}\\end{equation}` : content, numbered, inline: false };
  }
  if (base === "multline") {
    const inner = `\\begin{gathered}${content}\\end{gathered}`;
    return { latex: starred ? inner : `\\begin{equation}${inner}\\end{equation}`, numbered: !starred, inline: false };
  }
  if (base === "eqnarray") {
    // `a &=& b` is three columns; align's `a &= b` draws the same.
    const rows = content.split(/\\\\/).map((row) => row.replace(/&([^&]*)&/, "&$1"));
    return { latex: `\\begin{align${starred ? "*" : ""}}${rows.join("\\\\")}\\end{align${starred ? "*" : ""}}`, numbered: !starred, inline: false };
  }
  if (NUMBERED_ROWS.has(base)) {
    const args = base === "alignat" ? /^\s*\{[^}]*\}/.exec(content)?.[0] ?? "" : "";
    const rest = content.slice(args.length);
    return { latex: `\\begin{${base}${starred ? "*" : ""}}${args}${rest}\\end{${base}${starred ? "*" : ""}}`, numbered: !starred, inline: false };
  }
  // Inner environments used on their own (matrix, cases) and anything else: as they are.
  return { latex: `\\begin{${env}}${content}\\end{${env}}`, numbered: false, inline: false };
}

/** Puts the numbering pass's numbers on KaTeX's number slots, in row order (rows with a `\tag` have their own, drawn by KaTeX). */
export function applyEquationNumbers(element: HTMLElement, numbers: Array<string | null>, tagged: boolean[] = []) {
  const slots = element.querySelectorAll<HTMLElement>(".eqn-num");
  const values = numbers.filter((number, index): number is string => number !== null && !tagged[index]);
  slots.forEach((slot, index) => {
    const value = values[index];
    if (value === undefined) slot.removeAttribute("data-vis-num");
    else slot.setAttribute("data-vis-num", value);
  });
}

export function clearKatexCache() {
  cache.clear();
}
