import { readGroup, readOptional } from "../../../macros/core";

/* Commonly used math LaTeX that KaTeX lacks, written as what it can draw (docs/audits: the math coverage sweep,
 * scripts/editor/latex-visual-math-coverage.test.ts). math-render.ts calls these before KaTeX; whatever has no
 * faithful drawing is not here, so it fails in KaTeX and stays source. */

/**
 * KaTeX macros for symbols and commands of amsmath, mathtools, esint and stmaryrd that KaTeX lacks: the symbol they
 * are in Unicode, or the KaTeX symbol that is the same (stmaryrd's `\varoplus` is a ⊕ drawn a little larger).
 * Unicode characters are KaTeX's `\text` characters, as the other symbols of KATEX_MACROS are.
 */
export const COVERAGE_MACROS: Record<string, string> = {
  // unicode-math's and common macro files' `\defeq`: "=" with "def" over it.
  "\\defeq": "\\mathrel{\\stackrel{\\mathrm{def}}{=}}",
  // accents.sty's `\accentset{accent}{base}` and `\underaccent{accent}{base}`: the accent set over or under the base, as
  // `\overset` and `\underset` set it (the accent in script size, as accents.sty sets it).
  "\\accentset": "\\overset{#1}{#2}",
  "\\underaccent": "\\underset{#1}{#2}",
  // LaTeX's framed box with its options left out (`\framebox{a}`).
  "\\framebox": "\\fbox",
  // TeX's spaces by name.
  "\\enspace": "\\kern.5em ",
  "\\enskip": "\\kern.5em ",
  "\\thinspace": "\\,",
  "\\medspace": "\\:",
  "\\thickspace": "\\;",
  "\\negthinspace": "\\!",
  "\\negmedspace": "\\mkern-4mu ",
  "\\negthickspace": "\\mkern-5mu ",
  "\\space": "\\ ",
  "\\nobreakspace": "\\ ",
  // esint's clockwise and counterclockwise contour integrals (limits at the side, as `\oint` takes them in text).
  // esint's integral with a dash through it (the average `\fint_{B_r} u`, 2611.11553), limits at the side.
  "\\fint": "\\mathop{\\text{⨏}}\\nolimits",
  "\\varointclockwise":"\\mathop{\\text{∲}}\\nolimits",
  "\\ointctrclockwise": "\\mathop{\\text{∳}}\\nolimits",
  // stmaryrd: arrows and operators with a counterpart in Unicode or in KaTeX's symbols.
  "\\longmapsfrom": "\\mathrel{\\text{⟻}}",
  "\\Longmapsfrom": "\\mathrel{\\text{⟽}}",
  "\\Longmapsto": "\\mathrel{\\text{⟾}}",
  "\\shortrightarrow": "\\rightarrow",
  "\\shortleftarrow": "\\leftarrow",
  "\\shortuparrow": "\\uparrow",
  "\\shortdownarrow": "\\downarrow",
  "\\varoast": "\\circledast",
  "\\varobar": "\\mathbin{\\text{⦶}}",
  "\\varocircle": "\\circledcirc",
  "\\varodot": "\\odot",
  "\\varominus": "\\ominus",
  "\\varoplus": "\\oplus",
  "\\varoslash": "\\oslash",
  "\\varotimes": "\\otimes",
  "\\varbigcirc": "\\bigcirc",
  "\\fatsemi": "\\mathbin{\\text{⨟}}",
  "\\fatbslash": "\\mathbin{\\text{⧵}}",
  "\\binampersand": "\\mathbin{\\&}",
  "\\bindnasrepma": "\\mathbin{\\text{⅋}}",
  "\\talloblong": "\\mathbin{\\text{⫾}}",
  "\\trianglelefteqslant": "\\trianglelefteq",
  "\\trianglerighteqslant": "\\trianglerighteq",
  "\\boxbslash": "\\mathbin{\\text{⧅}}",
  "\\boxslash": "\\mathbin{\\text{⧄}}",
  "\\boxast": "\\mathbin{\\text{⧆}}",
  "\\boxcircle": "\\mathbin{\\text{⧇}}",
  "\\varcurlywedge": "\\curlywedge",
  "\\varcurlyvee": "\\curlyvee",
  "\\interleave": "\\mathbin{\\text{⫴}}",
  "\\llparenthesis": "\\mathopen{\\text{⦇}}",
  "\\rrparenthesis": "\\mathclose{\\text{⦈}}",
  "\\lAngle": "\\mathopen{\\text{⟪}}",
  "\\rAngle": "\\mathclose{\\text{⟫}}",
};

/** Where the `\end{…}` closing the environment whose `\begin{…}` ends at `from` starts, or -1. */
function environmentEnd(latex: string, from: number) {
  const pattern = /\\(begin|end)\s*\{[^{}]*\}/g;
  pattern.lastIndex = from;
  let depth = 1;
  for (let match: RegExpExecArray | null; (match = pattern.exec(latex));) {
    depth += match[1] === "begin" ? 1 : -1;
    if (depth === 0) return match.index;
  }
  return -1;
}

/** An environment's body as rows with the `\\` (and its `*` and `[…]`) after each, at the top level. */
function rows(body: string) {
  const list: Array<{ text: string; separator: string }> = [];
  let depth = 0;
  let nested = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "%") { const end = body.indexOf("\n", i); i = end < 0 ? body.length : end; continue; }
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      if (body.startsWith("\\begin", i)) nested++;
      else if (body.startsWith("\\end", i)) nested--;
      else if (body[i + 1] === "\\" && depth === 0 && nested === 0) {
        const from = i;
        i++;
        if (body[i + 1] === "*") i++;
        const spacing = /^\s*\[[^\]]*\]/.exec(body.slice(i + 1));
        if (spacing) i += spacing[0].length;
        list.push({ text: body.slice(start, from), separator: body.slice(from, i + 1) });
        start = i + 1;
        continue;
      }
      i++;
    }
  }
  list.push({ text: body.slice(start), separator: "" });
  return list;
}

/** A row's cells, at its top-level `&`s. */
function cells(row: string) {
  const list: string[] = [];
  let depth = 0;
  let nested = 0;
  let start = 0;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === "\\") {
      if (row.startsWith("\\begin", i)) nested++;
      else if (row.startsWith("\\end", i)) nested--;
      i++;
    } else if (char === "&" && depth === 0 && nested === 0) { list.push(row.slice(start, i)); start = i + 1; }
  }
  list.push(row.slice(start));
  return list;
}

const MATHTOOLS_ENVIRONMENT = /\\begin\s*\{(d?r?cases\*|multlined|lgathered|rgathered)\}/g;

/** The Optional `[…]` arguments an environment opens with (`multlined`'s position and width). */
const LEADING_OPTIONS = /^\s*(?:\[[^\]]*\]\s*)+/;

function textCell(text: string) {
  const trimmed = text.trim();
  return trimmed ? `\\text{${trimmed}}` : "";
}

/**
 * mathtools' environments KaTeX lacks, as the ones it has: `multlined` as `gathered`; `lgathered` and `rgathered` as
 * `aligned` with every line flush left or right; `cases*`, `dcases*`, `rcases*` and `drcases*`, whose second column
 * (and, without the `d`, the first) is text, as the plain environment with `\text` cells. A case body with more than two
 * columns is left, and stays source.
 */
export function mathtoolsEnvironmentsForKatex(latex: string): string {
  if (!/\\begin\s*\{(?:d?r?cases\*|multlined|lgathered|rgathered)\}/.test(latex)) return latex;
  let out = "";
  let at = 0;
  const pattern = new RegExp(MATHTOOLS_ENVIRONMENT.source, "g");
  for (let match: RegExpExecArray | null; (match = pattern.exec(latex));) {
    const end = environmentEnd(latex, pattern.lastIndex);
    const closing = end < 0 ? null : /^\\end\s*\{([^{}]*)\}/.exec(latex.slice(end));
    if (!closing || closing[1] !== match[1]) continue;
    const name = match[1];
    const body = mathtoolsEnvironmentsForKatex(latex.slice(pattern.lastIndex, end));
    let replacement: string | null;
    if (name === "multlined") replacement = `\\begin{gathered}${body.replace(LEADING_OPTIONS, "")}\\end{gathered}`;
    else if (name === "lgathered" || name === "rgathered") {
      const lines = rows(body.replace(LEADING_OPTIONS, "")).map((row) => `${name === "lgathered" ? "&" : ""}${row.text.trim()}${name === "rgathered" ? "&" : ""}${row.separator}`);
      replacement = `\\begin{aligned}${lines.join("")}\\end{aligned}`;
    } else {
      const base = name.slice(0, -1);
      const lines = rows(body).map((row) => ({ columns: cells(row.text), separator: row.separator }));
      replacement = lines.some((row) => row.columns.length > 2) ? null : `\\begin{${base}}${lines.map(({ columns, separator }) => `${base.startsWith("d") ? columns[0].trim() : textCell(columns[0])}${columns.length > 1 ? `&${textCell(columns[1])}` : ""}${separator}`).join("")}\\end{${base}}`;
    }
    if (replacement === null) continue;
    out += latex.slice(at, match.index) + replacement;
    at = pattern.lastIndex = end + closing[0].length;
  }
  return out + latex.slice(at);
}

/** A tensor package index list (`^a_b`, `^{\mu\nu}{}_\rho`) as staggered indices (`{}^{a}{}_{b}`), or null for anything else. */
function tensorIndices(source: string) {
  let out = "";
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === "^" || char === "_") {
      let at = i + 1;
      while (/\s/.test(source[at] ?? "")) at++;
      const group = source[at] === "{" ? readGroup(source, at) : null;
      const token = group ? null : /^(?:\\(?:[A-Za-z@]+|.)|[^\s{}^_\\])/.exec(source.slice(at))?.[0];
      if (!group && !token) return null;
      out += `{}${char}{${group ? group.content : token}}`;
      i = group ? group.end : at + token!.length;
    } else if (char === "{") {
      const group = readGroup(source, i);
      if (!group || group.content.trim()) return null;
      i = group.end;
    } else return null;
  }
  return out;
}

/**
 * The tensor package's `\tensor{T}{^a_b}` (indices after the symbol, each in its own column) and
 * `\tensor[^a_b]{T}{^c_d}` (and before it), and `\indices{^a_b}`: the indices as staggered scripts on empty groups.
 */
export function tensorForKatex(latex: string) {
  if (!/\\(?:tensor|indices)(?![A-Za-z@])/.test(latex)) return latex;
  let out = "";
  let at = 0;
  const pattern = /\\(tensor|indices)(?![A-Za-z@])\s*/g;
  for (let match: RegExpExecArray | null; (match = pattern.exec(latex));) {
    let i = pattern.lastIndex;
    let left = "";
    if (match[1] === "tensor") {
      const optional = latex[i] === "[" ? readOptional(latex, i) : null;
      if (optional) {
        const indices = tensorIndices(optional.content);
        if (indices === null) continue;
        left = indices;
        i = optional.end;
      }
      while (/\s/.test(latex[i] ?? "")) i++;
      const base = latex[i] === "{" ? readGroup(latex, i) : null;
      if (!base) continue;
      i = base.end;
      while (/\s/.test(latex[i] ?? "")) i++;
      const group = latex[i] === "{" ? readGroup(latex, i) : null;
      const indices = group ? tensorIndices(group.content) : null;
      if (!group || indices === null) continue;
      out += `${latex.slice(at, match.index)}{${left}{${base.content}}${indices}}`;
      at = pattern.lastIndex = group.end;
    } else {
      const group = latex[i] === "{" ? readGroup(latex, i) : null;
      const indices = group ? tensorIndices(group.content) : null;
      if (!group || indices === null) continue;
      out += `${latex.slice(at, match.index)}{${indices}}`;
      at = pattern.lastIndex = group.end;
    }
  }
  return out + latex.slice(at);
}

/**
 * stmaryrd's `\llbracket` and `\rrbracket` as delimiters (`\left\llbracket x \right\rrbracket`, `\bigl\llbracket`), which
 * KaTeX takes only as symbols: two brackets in the same size, the second drawn closer.
 */
export function bracketDelimitersForKatex(latex: string) {
  if (!/\\(?:ll|rr)bracket(?![A-Za-z@])/.test(latex)) return latex;
  return latex
    .replace(/\\(left|big[lm]?|Big[lm]?|bigg[lm]?|Bigg[lm]?)\s*\\llbracket(?![A-Za-z@])/g, "\\$1[\\!\\$1[")
    .replace(/\\(right|big[rm]?|Big[rm]?|bigg[rm]?|Bigg[rm]?)\s*\\rrbracket(?![A-Za-z@])/g, "\\$1]\\!\\$1]");
}

/**
 * Box and line-spacing settings inside a formula that only move things by fractions of a line: `\lineskiplimit=0pt` (set
 * at the start of an accent macro's text box, 2611.13390's `\oacc`) draws nothing, and `\raisebox{-.2ex}[\height][\depth]{…}`
 * is `\raisebox{-.2ex}{…}` for KaTeX, which has no height and depth arguments (they only change the box's size for layout).
 */
export function boxSettingsForKatex(latex: string) {
  if (!/\\(?:lineskiplimit|lineskip|raisebox)(?![A-Za-z@])/.test(latex)) return latex;
  return latex
    .replace(/\\(?:lineskiplimit|lineskip)\s*=?\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|em|ex|mu|bp|mm|cm|in)(?:\s+(?:plus|minus)\s*-?[\d.]+\s*(?:pt|em|ex|fil+))*\s*/g, "")
    .replace(/(\\raisebox\s*\{[^{}]*\})\s*(?:\[[^\]]*\]\s*){1,2}(?=\{)/g, "$1");
}

/** All of this file's rewrites, in the order math-render.ts's `forKatex` applies them. */
export function coverageForKatex(latex: string) {
  let out = boxSettingsForKatex(latex);
  out = mathtoolsEnvironmentsForKatex(out);
  out = tensorForKatex(out);
  return bracketDelimitersForKatex(out);
}
