import katex from "katex";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
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
  // eurosym's sign in a formula (the minimum-wage paper's `$\euro 8.50$`).
  "\\euro": "\\text{€}",
  "\\EUR": "\\text{€}\\,#1",
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

/** The premises or conclusion of a rule: lines (`\\`) stacked, and `\and` between premises as a gap. */
function ruleStack(text: string) {
  const parts = text.replace(/\\and(?![A-Za-z@])/g, "\\qquad ").trim();
  return parts ? `\\begin{array}{c}${parts}\\end{array}` : "";
}

/**
 * mathpartir's inference rules, which KaTeX lacks: `\inferrule[name]{premises}{conclusion}` (and `\inferrule*` with
 * `[right=name]`) as a fraction of the stacked premises over the conclusion, the name beside it. A rule whose
 * arguments do not close is left as it is (KaTeX then fails, and the formula stays source).
 */
export function inferrulesForKatex(latex: string) {
  let out = "";
  let at = 0;
  for (let index = latex.indexOf("\\inferrule"); index >= 0; index = latex.indexOf("\\inferrule", at)) {
    let i = index + "\\inferrule".length;
    if (/[A-Za-z@]/.test(latex[i] ?? "")) { out += latex.slice(at, i); at = i; continue; }
    if (latex[i] === "*") i++;
    const skip = () => { while (/\s/.test(latex[i] ?? "")) i++; };
    skip();
    const options = latex[i] === "[" ? readOptional(latex, i, TEX_GROUPS) : null;
    if (options) { i = options.end; skip(); }
    const premises = latex[i] === "{" ? readGroup(latex, i, TEX_GROUPS) : null;
    if (premises) { i = premises.end; skip(); }
    const conclusion = premises && latex[i] === "{" ? readGroup(latex, i, TEX_GROUPS) : null;
    if (!premises || !conclusion) { out += latex.slice(at, i); at = i; continue; }
    const name = options ? (/(?:^|,)\s*(?:right|left|Right|Left|lab|Lab)\s*=\s*([^,]*)/.exec(options.content)?.[1] ?? (options.content.includes("=") ? "" : options.content)).trim() : "";
    const rule = `\\dfrac{${ruleStack(premises.content)}}{${ruleStack(conclusion.content)}}`;
    out += latex.slice(at, index) + (name ? `{\\scriptsize\\textsc{${name}}}\\;${rule}` : rule);
    at = conclusion.end;
  }
  return out + latex.slice(at);
}

/**
 * mathpartir's `mathpar` body as one formula: rules separated by `\and` or blank lines side by side, `\\` starting a
 * new row.
 */
export function mathparForKatex(body: string) {
  // The rules first (their own `\and` and `\\` are inside their braces), then the layout around them.
  const text = inferrulesForKatex(stripTexComments(body).trim());
  const rows: string[][] = [[]];
  let rule = "";
  let depth = 0;
  let environments = 0;
  const endRule = () => { if (rule.trim()) rows[rows.length - 1].push(rule.trim()); rule = ""; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      // A command or an escaped character (`\{`) is copied as it is; at the top level, `\\` and `\and` lay the rules out.
      if (depth === 0) {
        if (text.startsWith("\\begin", i)) environments++;
        else if (text.startsWith("\\end", i)) environments--;
        else if (environments === 0 && text[i + 1] === "\\") { endRule(); rows.push([]); i++; continue; }
        else if (environments === 0 && /^\\and(?![A-Za-z@])/.test(text.slice(i, i + 5))) { endRule(); i += 3; continue; }
      }
      rule += char + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\n" && depth === 0 && environments === 0 && /^\n[ \t]*\n/.test(text.slice(i, i + 40))) { endRule(); continue; }
    rule += char;
  }
  endRule();
  return `\\begin{gathered}${rows.filter((row) => row.length).map((row) => row.join(" \\qquad ")).join(" \\\\[1.2em] ")}\\end{gathered}`;
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
  if (out.includes("\\inferrule")) out = inferrulesForKatex(out);
  // tikzmark's `\tikzmarknode[draw=red]{name}{content}` (Self-RAG's framed Retrieve tokens): its content.
  if (out.includes("\\tikzmark")) out = out.replace(/\\tikzmarknode\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, "").replace(/\\tikzmark\s*\{[^{}]*\}/g, "");
  // Vertical space in a formula (SimPO's `\vspace{-0.5em}` before `\end{equation}`): the page's layout, not the formula.
  if (/\\(?:vspace|vskip|smallskip|medskip|bigskip|noindent)(?![A-Za-z])/.test(out)) {
    out = out.replace(/\\vspace\*?\s*\{[^{}]*\}|\\vskip\s*-?\s*(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|in|cm|mm|bp)(?:\s*(?:plus|minus)\s*-?\s*[\d.]+\s*(?:pt|em|ex|in|cm|mm|bp|fil+))*|\\(?:smallskip|medskip|bigskip|noindent)(?![A-Za-z])/g, "");
  }
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
