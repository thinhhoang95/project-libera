import katex from "katex";
import { splitMathRows, stripTexComments } from "../../macros/numbering";

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
  // LaTeX's text box and old slanted switch in formulas (`$\left[ \mbox{UNK} \right]$`, `$\text{\sl N}$`).
  "\\mbox": "\\text{#1}",
  "\\sl": "\\it",
  // relsize's one-step larger and smaller formulas (YOLO's `\mathlarger{\mathbbm{1}}`).
  "\\mathlarger": "{\\large #1}",
  "\\mathsmaller": "{\\small #1}",
  // Spacing and robustness commands that draw nothing in a formula: the italic correction (O'Donnell's
  // `\Var` is `\mathop{\bf Var\/}`), `\protect`, xspace's `\xspace`, `\@` and `\leavevmode`.
  "\\/": "",
  "\\protect": "",
  "\\xspace": "",
  "\\@": "",
  "\\leavevmode": "",
  "\\ensuremath": "#1",
  // The TeX.SX `\widebar` (a bar sized to its argument, built from box arithmetic the reader leaves out): a bar.
  "\\widebar": "\\overline{#1}",
};

/** mathtools' small matrices with delimiters, which KaTeX lacks: its `smallmatrix` between those delimiters. */
const SMALL_MATRICES: Record<string, [string, string]> = {
  psmallmatrix: ["(", ")"], bsmallmatrix: ["[", "]"], Bsmallmatrix: ["\\{", "\\}"], vsmallmatrix: ["|", "|"], Vsmallmatrix: ["\\|", "\\|"],
};
const SMALL_MATRIX = /\\(begin|end)\s*\{([pbBvV]smallmatrix)\}/g;

const COUNTER_COMMANDS = /\\(?:addtocounter|setcounter)\s*\{[^{}]*\}\s*\{[^{}]*\}|\\(?:stepcounter|refstepcounter)\s*\{[^{}]*\}/g;
const COUNTED_TAG = /\\tag\*?\s*\{\s*\\theequation\s*\}/;

/**
 * Rows numbered by hand (`\addtocounter{equation}{1}\tag{\theequation}`, VAE's `\eqnr` in `align*`): the counter
 * commands draw nothing, and such rows get number slots, which the numbering pass fills as other rows'; the
 * environment's other rows are `\nonumber`. Null when the formula has none of this.
 */
export function countedRows(latex: string): { latex: string; numbered: boolean } | null {
  if (!/\\(?:addtocounter|setcounter|stepcounter|refstepcounter|theequation)(?![A-Za-z@])/.test(latex)) return null;
  const text = latex.replace(COUNTER_COMMANDS, "");
  if (!COUNTED_TAG.test(text)) return { latex: text, numbered: false };
  const untagged = (row: string) => row.replace(new RegExp(COUNTED_TAG.source, "g"), "");
  const env = /^\s*\\begin\{(align|alignat|flalign|gather|equation|multline)\*\}([\s\S]*)\\end\{\1\*\}\s*$/.exec(text);
  if (env && (env[1] === "equation" || env[1] === "multline")) return { latex: `\\begin{${env[1]}}${untagged(env[2])}\\end{${env[1]}}`, numbered: true };
  if (env) {
    const rows = splitMathRows(env[2]).map((row) => (COUNTED_TAG.test(row) ? untagged(row) : `${row}\\nonumber`));
    return { latex: `\\begin{${env[1]}}${rows.join("\\\\")}\\end{${env[1]}}`, numbered: true };
  }
  // `equation*`, drawn without its environment: a numbered equation.
  return { latex: `\\begin{equation}${untagged(text)}\\end{equation}`, numbered: true };
}

/** TeX's `\raise<dimen>` and `\lower<dimen>` before a box. */
export const RAISE = /\\(?:raise|lower)\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:ex|em|pt|mm|cm|in|bp|mu)\s*/g;

/** An accent or font whose argument is a command with its own group (`\widehat\mathrm{x}`): TeX reads it, KaTeX does not. */
const UNBRACED_ARGUMENT = /\\(hat|widehat|tilde|widetilde|bar|overline|underline|vec|dot|ddot|check|breve|acute|grave|mathring|overrightarrow|overleftarrow|boldsymbol|bm|sqrt)\s*(\\(?:math[a-z]+|text[a-z]*|operatorname|boldsymbol|bm)\s*\{(?:[^{}]|\{[^{}]*\})*\})/g;

/**
 * LaTeX KaTeX lacks, written as what it can draw: `\textsc{Base}` as `\text{B{\small ASE}}` (small capitals),
 * and Batch Norm's `\widehat\mathrm{x}` as `\widehat{\mathrm{x}}`.
 */
export function forKatex(latex: string) {
  // `\raise.17ex\hbox{…}` (Mask R-CNN's `\app`, a raised ∼): KaTeX has no \raise or \lower; the box is drawn in place.
  let out = latex.includes("\\raise") || latex.includes("\\lower") ? latex.replace(RAISE, "") : latex;
  if (out.includes("\\textsc")) out = out.replace(/\\textsc\s*\{([^{}]*)\}/g, (_, text: string) => `\\text{${text.replace(/[a-z]+/g, (run) => `{\\small ${run.toUpperCase()}}`)}}`);
  if (/\\[a-z]+\s*\\(?:math|text|operatorname|boldsymbol|bm)/.test(out)) out = out.replace(UNBRACED_ARGUMENT, "\\$1{$2}");
  // `\begin{psmallmatrix}…\end{psmallmatrix}` (Borusyak et al.'s rank conditions): `smallmatrix` in parentheses.
  if (out.includes("smallmatrix")) {
    out = out.replace(SMALL_MATRIX, (whole, side: string, env: string) => {
      const [left, right] = SMALL_MATRICES[env] ?? [];
      if (!left) return whole;
      return side === "begin" ? `\\left${left}\\begin{smallmatrix}` : `\\end{smallmatrix}\\right${right}`;
    });
  }
  return out;
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
    // KaTeX has no flalign: its align takes as many column pairs, centred rather than flush.
    const name = `${base === "flalign" ? "align" : base}${starred ? "*" : ""}`;
    return { latex: `\\begin{${name}}${args}${rest}\\end{${name}}`, numbered: !starred, inline: false };
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
