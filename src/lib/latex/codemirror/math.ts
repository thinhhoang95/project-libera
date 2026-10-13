import type { EditorState } from "@codemirror/state";

/* Math is never allowed to span a paragraph break, so finding the math
 * around a position only needs the current paragraph. */

const MATH_ENVIRONMENT = /^(?:equation|align|alignat|gather|multline|flalign|eqnarray|math|displaymath|dmath)\*?$/;
const MAX_PARAGRAPH_LINES = 80;

export type MathRegion = {
  /** Range of the math content, without delimiters. */
  from: number;
  to: number;
  display: boolean;
  /** Delimiters or environment name, for a label. */
  kind: string;
};

function paragraphBounds(state: EditorState, pos: number) {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  let first = line.number;
  let last = line.number;
  while (first > 1 && line.number - first < MAX_PARAGRAPH_LINES && doc.line(first - 1).text.trim()) first--;
  while (last < doc.lines && last - line.number < MAX_PARAGRAPH_LINES && doc.line(last + 1).text.trim()) last++;
  return { from: doc.line(first).from, to: doc.line(last).to };
}

type Token = { kind: string; open: boolean; from: number; to: number; display: boolean };

/** Math delimiters in `text` (which starts at document offset `offset`). */
function scanMathTokens(text: string, offset: number) {
  const tokens: Token[] = [];
  let inMath: { kind: string } | null = null;
  const pattern = /%[^\n]*|\\\\|\\[$%]|\$\$|\$|\\\[|\\\]|\\\(|\\\)|\\(begin|end)\s*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const value = match[0];
    const from = offset + match.index;
    const to = from + value.length;
    if (value.startsWith("%") || value === "\\\\" || value === "\\$" || value === "\\%") continue;
    if (match[1]) {
      const name = match[2];
      if (!MATH_ENVIRONMENT.test(name)) continue;
      if (match[1] === "begin" && !inMath) { inMath = { kind: name }; tokens.push({ kind: name, open: true, from, to, display: true }); }
      else if (match[1] === "end" && inMath?.kind === name) { inMath = null; tokens.push({ kind: name, open: false, from, to, display: true }); }
      continue;
    }
    if (!inMath) {
      if (value === "$" || value === "$$" || value === "\\[" || value === "\\(") {
        inMath = { kind: value };
        tokens.push({ kind: value, open: true, from, to, display: value === "$$" || value === "\\[" });
      }
      continue;
    }
    const closes = (inMath.kind === "$" && value === "$") || (inMath.kind === "$$" && value === "$$") || (inMath.kind === "\\[" && value === "\\]") || (inMath.kind === "\\(" && value === "\\)");
    if (closes) {
      tokens.push({ kind: inMath.kind, open: false, from, to, display: inMath.kind !== "$" && inMath.kind !== "\\(" });
      inMath = null;
    }
  }
  return tokens;
}

/** The math region containing `pos`, if any. An unclosed region extends to
 * the end of the paragraph so the preview follows the equation being typed. */
export function findMathRegion(state: EditorState, pos: number): MathRegion | null {
  const bounds = paragraphBounds(state, pos);
  const tokens = scanMathTokens(state.sliceDoc(bounds.from, bounds.to), bounds.from);
  for (let index = 0; index < tokens.length; index++) {
    const open = tokens[index];
    if (!open.open) continue;
    const close = tokens[index + 1] && !tokens[index + 1].open ? tokens[index + 1] : null;
    const contentTo = close ? close.from : bounds.to;
    if (pos >= open.to && pos <= contentTo) return { from: open.to, to: contentTo, display: open.display, kind: open.kind };
    if (pos < open.from) break;
  }
  return null;
}

export function isInsideMath(state: EditorState, pos: number) {
  return findMathRegion(state, pos) !== null;
}

/** Simple `\newcommand` macros from the preamble, for the KaTeX preview. */
export function readPreviewMacros(source: string) {
  const macros: Record<string, string> = {};
  const preambleEnd = source.search(/\\begin\s*\{document\}/);
  const preamble = preambleEnd > 0 ? source.slice(0, preambleEnd) : source.slice(0, 20_000);
  for (const match of preamble.matchAll(/\\(?:re)?newcommand\*?\s*\{?(\\[a-zA-Z]+)\}?\s*(?:\[(\d)\])?\s*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g)) {
    macros[match[1]] = match[3];
  }
  for (const match of preamble.matchAll(/\\DeclareMathOperator\*?\s*\{?(\\[a-zA-Z]+)\}?\s*\{([^{}]*)\}/g)) {
    macros[match[1]] = `\\operatorname{${match[2]}}`;
  }
  return macros;
}
