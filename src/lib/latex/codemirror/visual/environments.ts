import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";

/* Environments the walk draws from their own arguments (kept out of walk.ts, which several areas edit):
 * the generic `list` and `trivlist`, and the wrappers that only box or lay out their content (`adjustbox`,
 * `lrbox`, `multicols`, …). Each reader returns null for what it does not understand, and the environment then
 * stays source. */

/** framed's, mdframed's `shaded` and `leftbar` prose boxes: drawn in the text as a frame (a float shows them as source parts). */
export const FRAMED_PROSE = /^(?:framed|oframed|shaded\*?|snugshade\*?|leftbar)$/;

/** The first of LaTeX's own list environments, besides `itemize`, `enumerate` and `description`. */
export const GENERIC_LISTS = /^(?:list|trivlist|tablenotes)$/;

export type GenericList = {
  /** The list it is drawn as. */
  kind: "itemize" | "enumerate";
  /** An enumerate's `label=…` (counter commands turned into enumitem's `\arabic*`), or an itemize's bullet. */
  template: string | null;
  /** No label unless an item gives one (`\begin{list}{}{…}`, `trivlist`). */
  plain: boolean;
};

/** The layout `list`'s second argument may hold, which only sets lengths: ignored. A `\usecounter` names the item counter. */
function listLayout(text: string): { counter: string | null } | null {
  let counter: string | null = null;
  let i = 0;
  for (;;) {
    i += /^\s*/.exec(text.slice(i))![0].length;
    if (i >= text.length) return { counter };
    const rest = text.slice(i);
    let match = /^\\(?:setlength|addtolength)\s*(?:\{\s*\\[A-Za-z@]+\s*\}|\\[A-Za-z@]+)\s*\{[^{}]*\}/.exec(rest);
    if (match) { i += match[0].length; continue; }
    // `\leftmargin=2em plus 1pt`: TeX's own assignment.
    match = /^\\(?:leftmargin|rightmargin|labelwidth|labelsep|itemindent|listparindent|itemsep|parsep|topsep|partopsep)\s*=?\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*[a-z]{2}(?:\s*(?:plus|minus)\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*[a-z]{2})*/.exec(rest);
    if (match) { i += match[0].length; continue; }
    match = /^\\usecounter\s*\{([A-Za-z0-9]+)\}/.exec(rest);
    if (match) { counter = match[1]; i += match[0].length; continue; }
    // `\renewcommand{\makelabel}[1]{\textbf{#1}}`: how the label is set (its style, its alignment): not drawn.
    match = /^\\renewcommand\s*(?:\{\s*\\makelabel\s*\}|\\makelabel)\s*\[1\]\s*/.exec(rest);
    if (match) {
      const body = rest[match[0].length] === "{" ? readGroup(rest, match[0].length, TEX_GROUPS) : null;
      if (!body || !/^\s*(?:\\hfil{1,2}\s*)?(?:\\(?:textbf|textit|textsc|textsf|textsl|emph)\s*\{#1\}|\\(?:bfseries|itshape|scshape|sffamily)\s*#1|#1)\s*(?:\\hfil{1,2}\s*)?$/.test(body.content)) return null;
      i += match[0].length + (body.end - match[0].length);
      continue;
    }
    return null;
  }
}

/** The styles a counter label may be wrapped in (`\textbf{(\roman{c})}`), whose text is what shows. */
const LABEL_STYLES = /\\(?:textbf|textit|textsc|textsf|textsl|textrm|emph)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/;

/** The head of a `\begin{list}{label}{layout}` or `\begin{trivlist}`, or null when it holds more than it can read. */
export function genericListHead(node: SyntaxNode, state: EditorState): GenericList | null {
  const begin = node.getChild("BeginEnv");
  const nameEnd = begin?.getChild("EnvNameGroup")?.to;
  if (!begin || nameEnd === undefined) return null;
  const name = state.doc.sliceString(begin.getChild("EnvNameGroup")!.from + 1, nameEnd - 1).trim();
  const head = state.doc.sliceString(nameEnd, begin.to);
  if (name === "trivlist") return /^\s*$/.test(head) ? { kind: "itemize", template: null, plain: true } : null;
  // threeparttable's notes: items labelled by `\item[a]`, with an optional `[flushleft]` style.
  if (name === "tablenotes") return /^\s*(?:\[[^\]\n]*\])?\s*$/.test(head) ? { kind: "itemize", template: null, plain: true } : null;
  // The two groups, all of the begin's arguments: the label and the layout.
  const first = /^\s*\{/.exec(head);
  const label = first ? readGroup(head, first[0].length - 1, TEX_GROUPS) : null;
  if (!label) return null;
  const second = /^\s*\{/.exec(head.slice(label.end));
  const layout = second ? readGroup(head, label.end + second[0].length - 1, TEX_GROUPS) : null;
  if (!layout || head.slice(layout.end).trim()) return null;
  const read = listLayout(layout.content);
  if (!read) return null;
  const text = label.content.trim();
  const counters = [...text.matchAll(/\\(arabic|alph|Alph|roman|Roman)\s*\{([A-Za-z0-9]+)\}/g)];
  if (counters.length) {
    // The labels count with the counter `\usecounter` named, as enumerate's do: drawn as an enumerate with this label.
    if (counters.some((counter) => counter[2] !== read.counter)) return null;
    let template = text.replace(/\\(arabic|alph|Alph|roman|Roman)\s*\{[A-Za-z0-9]+\}/g, "\\$1*");
    for (let guard = 0; guard < 4 && LABEL_STYLES.test(template); guard++) template = template.replace(LABEL_STYLES, "$1");
    if (/\\(?!(?:arabic|alph|Alph|roman|Roman)\*)[A-Za-z@]+|[$#]/.test(template)) return null;
    return { kind: "enumerate", template: `label=${template}`, plain: false };
  }
  if (!text) return { kind: "itemize", template: null, plain: true };
  // A label that reads a counter or another command's value is not known.
  if (/\\(?:the[A-Za-z]+|value|arabic|alph|Alph|roman|Roman|fnsymbol)(?![A-Za-z])/.test(text)) return null;
  return { kind: "itemize", template: `label=${text}`, plain: false };
}

/** Where the arguments of a wrapper environment end, by letter: `o` an optional `[…]`, `m` a mandatory `{…}`. */
export function readEnvironmentArguments(text: string, spec: string): number | null {
  let i = 0;
  for (const letter of spec) {
    const space = /^[ \t]*(?:\r?\n[ \t]*)?/.exec(text.slice(i))![0].length;
    const at = i + space;
    if (letter === "o") {
      const optional = text[at] === "[" ? readOptional(text, at, TEX_GROUPS) : null;
      if (optional) i = optional.end;
    } else {
      const group = text[at] === "{" ? readGroup(text, at, TEX_GROUPS) : null;
      if (!group) return null;
      i = group.end;
    }
  }
  return i;
}

/**
 * Environments that only box, scale or lay out their content: their `\begin` line (with its arguments) and `\end` fold
 * away, what is inside is drawn as if they were not there. `args`: the arguments after the name (see
 * `readEnvironmentArguments`). `lines`: a line style for the body (an lrbox's content is a box LaTeX does not print where
 * it is written: faded).
 */
export const WRAPPER_ENVIRONMENTS: Record<string, { args: string; lines?: string }> = {
  adjustbox: { args: "m" },
  adjustwidth: { args: "omm" }, "adjustwidth*": { args: "omm" },
  // varwidth's `\begin{varwidth}[t]{\linewidth}`: a paragraph box that shrinks to its content.
  varwidth: { args: "om" },
  // rotating's and graphicx-era wrappers.
  threeparttable: { args: "" }, ThreePartTable: { args: "" },
  sideways: { args: "" }, turn: { args: "m" }, rotate: { args: "m" }, lscape: { args: "" },
  multicols: { args: "mo" }, "multicols*": { args: "mo" },
  // Line- and page-breaking only: `sloppypar` (looser lines), `samepage` (no page break inside), the hanging package's
  // `\begin{hangparas}{3ex}{1}` (a hanging indent for the paragraphs).
  sloppypar: { args: "" }, samepage: { args: "" }, hangparas: { args: "mm" },
  // `\begin{lrbox}{\box} … \end{lrbox}` saves its content in a box for `\usebox`: not printed where it is written.
  lrbox: { args: "m", lines: "cm-vis-disabled" },
};

/** One of booktabs' and LaTeX's table rules with its arguments (`\cmidrule(lr){2-3}`, `\cline{1-2}`, `\specialrule{1pt}{2pt}{2pt}`, `\toprule[1pt]`). */
const TABLE_RULE = /^\\(?:(toprule|bottomrule|midrule|hline)(?![A-Za-z@])(?:\[[^\]\n]*\])?|cline\s*\{[^{}\n]*\}|cmidrule\s*(?:\[[^\]\n]*\])?\s*(?:\([^)\n]*\))?\s*\{[^{}\n]*\}|(specialrule)\s*\{[^{}\n]*\}\s*\{[^{}\n]*\}\s*\{[^{}\n]*\})/;

/**
 * A run of table rules at the start of `text` (`\midrule`, `\hline\hline`, `\cline{1-2}\cline{3-4}`): the length it covers and
 * whether it holds a heavy one (`\toprule`, `\bottomrule`, `\specialrule`). Null when `text` does not start with a rule.
 */
export function tableRuleRun(text: string): { end: number; heavy: boolean } | null {
  let end = 0;
  let covered = 0;
  let heavy = false;
  for (;;) {
    const match = TABLE_RULE.exec(text.slice(end));
    if (!match) break;
    if (match[1] === "toprule" || match[1] === "bottomrule" || match[2]) heavy = true;
    end += match[0].length;
    covered = end;
    end += /^[ \t]*/.exec(text.slice(end))![0].length;
  }
  return covered > 0 ? { end: covered, heavy } : null;
}
