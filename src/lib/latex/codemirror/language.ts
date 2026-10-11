import { HighlightStyle, StreamLanguage, foldService, indentUnit, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

/* A line-oriented LaTeX tokenizer. It knows enough structure for an editor:
 * comments, commands, environment names, sectioning titles, label/ref/cite
 * keys, inline and display math (including math environments), verbatim-like
 * environments, and the nesting depth used for indentation. */

const MATH_ENVIRONMENTS = new Set([
  "equation", "equation*", "align", "align*", "alignat", "alignat*", "aligned", "gather", "gather*", "gathered",
  "multline", "multline*", "flalign", "flalign*", "eqnarray", "eqnarray*", "math", "displaymath", "split", "dmath", "dmath*",
]);
const VERBATIM_ENVIRONMENTS = new Set(["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment", "filecontents", "filecontents*", "luacode", "luacode*"]);
const STRUCTURE_COMMANDS = new Set([
  "begin", "end", "documentclass", "usepackage", "RequirePackage", "input", "include", "includeonly", "subfile",
  "item", "newcommand", "renewcommand", "providecommand", "newenvironment", "renewenvironment", "def", "let",
  "DeclareMathOperator", "maketitle", "tableofcontents", "appendix", "bibliography", "bibliographystyle",
  "addbibresource", "printbibliography", "frontmatter", "mainmatter", "backmatter", "caption", "centering",
]);
const SECTION_COMMANDS = new Set(["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "title", "frametitle"]);
const KEY_COMMANDS = new Set([
  "label", "ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref", "vref",
  "cite", "citep", "citet", "citeauthor", "citeyear", "parencite", "textcite", "autocite", "footcite", "nocite", "bibitem",
]);

type ArgumentKind = "env" | "section" | "key" | "plain";

type LatexState = {
  /** The token mode for the rest of the line. */
  math: null | "$" | "$$" | "\\)" | "\\]" | "env";
  mathEnvironment: string | null;
  verbatim: string | null;
  /** Kind of argument the next `{` opens, and the brace depth of open arguments. */
  pendingArgument: ArgumentKind | null;
  argumentStack: ArgumentKind[];
  /** Open `[...]` optional arguments of a command whose `{...}` is still to come. */
  optionalDepth: number;
  /** Environment nesting for indentation (the document environment excluded). */
  environmentDepth: number;
  braceDepth: number;
  /** Name collected while reading `\begin{...}` or `\end{...}`. */
  environmentName: string | null;
  environmentCommand: "begin" | "end" | null;
};

function copy(state: LatexState): LatexState {
  return { ...state, argumentStack: state.argumentStack.slice() };
}

function enterEnvironment(state: LatexState, name: string) {
  if (VERBATIM_ENVIRONMENTS.has(name)) state.verbatim = name;
  else if (MATH_ENVIRONMENTS.has(name) && !state.math) { state.math = "env"; state.mathEnvironment = name; }
  if (name !== "document") state.environmentDepth++;
}

function leaveEnvironment(state: LatexState, name: string) {
  if (state.math === "env" && state.mathEnvironment === name) { state.math = null; state.mathEnvironment = null; }
  if (name !== "document") state.environmentDepth = Math.max(0, state.environmentDepth - 1);
}

const latexParser: StreamParser<LatexState> = {
  name: "latex",
  startState: () => ({
    math: null, mathEnvironment: null, verbatim: null, pendingArgument: null, argumentStack: [], optionalDepth: 0,
    environmentDepth: 0, braceDepth: 0, environmentName: null, environmentCommand: null,
  }),
  copyState: copy,
  token(stream, state) {
    if (state.verbatim) {
      const end = `\\end{${state.verbatim}}`;
      const index = stream.string.indexOf(end, stream.pos);
      if (index === stream.pos) {
        stream.pos += 5;
        state.environmentCommand = "end";
        state.pendingArgument = "env";
        state.environmentName = "";
        state.verbatim = null;
        return "keyword";
      }
      if (index < 0) stream.skipToEnd();
      else stream.pos = index;
      return "content";
    }

    if (stream.match(/^%.*/)) return "comment";

    const argument = state.argumentStack.at(-1);

    if (stream.match(/^\\[a-zA-Z@]+\*?/)) {
      const name = stream.current().slice(1).replace(/\*$/, "");
      state.pendingArgument = name === "begin" || name === "end" ? "env" : SECTION_COMMANDS.has(name) ? "section" : KEY_COMMANDS.has(name) ? "key" : "plain";
      if (name === "begin" || name === "end") { state.environmentCommand = name; state.environmentName = ""; }
      if (state.math) return "macroName.special";
      return STRUCTURE_COMMANDS.has(name) || SECTION_COMMANDS.has(name) ? "keyword" : "macroName";
    }

    if (stream.match("\\\\")) { state.pendingArgument = null; return "operator"; }

    if (!state.math && stream.match(/^\\\[/)) { state.math = "\\]"; return "processingInstruction"; }
    if (!state.math && stream.match(/^\\\(/)) { state.math = "\\)"; return "processingInstruction"; }
    if (state.math === "\\]" && stream.match(/^\\\]/)) { state.math = null; return "processingInstruction"; }
    if (state.math === "\\)" && stream.match(/^\\\)/)) { state.math = null; return "processingInstruction"; }
    if (stream.match(/^\\./)) return state.math ? "macroName.special" : "escape";

    if (stream.match("$$")) {
      if (!state.math) { state.math = "$$"; return "processingInstruction"; }
      if (state.math === "$$") { state.math = null; return "processingInstruction"; }
      stream.backUp(1);
    }
    if (stream.match("$")) {
      if (!state.math) { state.math = "$"; return "processingInstruction"; }
      if (state.math === "$") { state.math = null; return "processingInstruction"; }
      return "processingInstruction";
    }

    const character = stream.peek();

    if (character === "{") {
      stream.next();
      state.argumentStack.push(state.pendingArgument ?? "plain");
      state.pendingArgument = null;
      state.optionalDepth = 0;
      state.braceDepth++;
      return "brace";
    }

    if (character === "}") {
      stream.next();
      const closed = state.argumentStack.pop();
      state.braceDepth = Math.max(0, state.braceDepth - 1);
      if (closed === "env" && state.environmentCommand && state.environmentName !== null) {
        const name = state.environmentName.trim();
        if (state.environmentCommand === "begin") enterEnvironment(state, name);
        else leaveEnvironment(state, name);
        state.environmentCommand = null;
        state.environmentName = null;
      }
      return "brace";
    }

    if (character === "[" || character === "]") {
      stream.next();
      // Optional arguments do not consume the pending mandatory argument.
      if (character === "[" && state.pendingArgument) state.optionalDepth++;
      else if (character === "]" && state.optionalDepth > 0) state.optionalDepth--;
      return "squareBracket";
    }

    if (stream.eatSpace()) return null;

    if (argument === "env") {
      if (!stream.match(/^[^{}\\%\s]+/)) stream.next();
      if (state.environmentName !== null) state.environmentName += stream.current();
      return "className";
    }

    if (state.optionalDepth > 0 && state.pendingArgument) {
      if (!stream.match(/^[^{}\[\]\\%$]+/)) stream.next();
      return null;
    }

    state.pendingArgument = null;

    if (argument === "key") {
      if (!stream.match(/^[^{}\\%]+/)) stream.next();
      return "labelName";
    }

    if (argument === "section") {
      if (!stream.match(/^[^{}\\%$]+/)) stream.next();
      return "heading";
    }

    if (state.math) {
      if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
      if (stream.match(/^[\^_&]/)) return "operator";
      if (!stream.match(/^[^\\$%{}\[\]\^_&\d\s]+/)) stream.next();
      return "variableName.special";
    }

    if (character === "&" || character === "~") { stream.next(); return "operator"; }
    if (!stream.match(/^[^\\$%{}\[\]&~\s]+/)) stream.next();
    return null;
  },
  blankLine(state) {
    // A paragraph break ends inline math and dangling arguments in TeX.
    if (state.math === "$") state.math = null;
    state.pendingArgument = null;
    state.optionalDepth = 0;
  },
  indent(state, textAfter, context) {
    let depth = state.environmentDepth + Math.min(state.braceDepth, 4);
    if (/^\s*\\end\b/.test(textAfter)) depth--;
    if (/^\s*\}/.test(textAfter)) depth--;
    return Math.max(0, depth) * context.unit;
  },
  languageData: {
    commentTokens: { line: "%" },
    indentOnInput: /^\s*(?:\\end\{?|\})$/,
    closeBrackets: { brackets: ["{", "[", "(", "$"], before: ")]}$:;>,." },
    wordChars: "@:-",
  },
  tokenTable: {
    escape: tags.escape,
    content: tags.content,
  },
};

export const latexLanguage = StreamLanguage.define(latexParser);

/* A minimal BibTeX tokenizer for .bib files. */
type BibState = { depth: number; inEntry: boolean; expectKey: boolean };
const bibParser: StreamParser<BibState> = {
  name: "bibtex",
  startState: () => ({ depth: 0, inEntry: false, expectKey: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (state.depth === 0) {
      if (stream.match(/^@[a-zA-Z]+/)) { state.inEntry = true; state.expectKey = true; return "keyword"; }
      if (stream.match(/^%.*/)) return "comment";
      stream.skipToEnd();
      return "comment";
    }
    if (state.expectKey && state.depth === 1 && stream.match(/^[^,\s{}]+/)) { state.expectKey = false; return "labelName"; }
    if (stream.eat("{") || stream.eat("(")) { state.depth++; return "brace"; }
    if (stream.eat("}") || stream.eat(")")) { state.depth = Math.max(0, state.depth - 1); return "brace"; }
    if (state.depth === 1 && stream.match(/^[a-zA-Z_-]+(?=\s*=)/)) return "propertyName";
    if (stream.eat("=") || stream.eat(",") || stream.eat("#")) return "operator";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^\d+/)) return "number";
    if (stream.match(/^\\[a-zA-Z]+/)) return "macroName";
    if (!stream.match(/^[^{}()",=#\\\s]+/)) stream.next();
    return state.depth > 1 ? "string" : "variableName";
  },
  languageData: { commentTokens: { line: "%" }, closeBrackets: { brackets: ["{", "(", '"'] } },
};

export const bibtexLanguage = StreamLanguage.define(bibParser);

export const latexHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--latex-comment)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--latex-keyword)", fontWeight: "600" },
  { tag: tags.macroName, color: "var(--latex-command)" },
  { tag: tags.escape, color: "var(--latex-command)" },
  { tag: tags.className, color: "var(--latex-environment)", fontWeight: "600" },
  { tag: tags.heading, color: "var(--latex-heading)", fontWeight: "700" },
  { tag: tags.labelName, color: "var(--latex-label)" },
  { tag: tags.propertyName, color: "var(--latex-command)" },
  { tag: tags.special(tags.variableName), color: "var(--latex-math)" },
  { tag: tags.special(tags.macroName), color: "var(--latex-math-command)" },
  { tag: tags.processingInstruction, color: "var(--latex-math-delimiter)", fontWeight: "600" },
  { tag: tags.number, color: "var(--latex-number)" },
  { tag: tags.string, color: "var(--latex-label)" },
  { tag: [tags.brace, tags.squareBracket], color: "var(--latex-bracket)" },
  { tag: tags.operator, color: "var(--latex-operator)" },
  { tag: tags.content, color: "var(--latex-verbatim)" },
  { tag: tags.invalid, color: "var(--destructive)" },
]);

const SECTION_RANK: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const FOLD_SCAN_LINES = 6000;

function stripComment(text: string) {
  const match = text.match(/(^|[^\\])(?:\\\\)*%/);
  return match ? text.slice(0, (match.index ?? 0) + match[0].length - 1) : text;
}

/** Fold `\begin{x}`…`\end{x}` blocks and sections up to the next peer heading. */
export function latexFoldRange(state: EditorState, lineStart: number, lineEnd: number) {
  const doc = state.doc;
  const firstLine = doc.lineAt(lineStart);
  const text = stripComment(firstLine.text);

  const begin = text.match(/\\begin\s*\{([^}]+)\}/);
  if (begin && !new RegExp(`\\\\end\\s*\\{${begin[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`).test(text.slice((begin.index ?? 0) + begin[0].length))) {
    const name = begin[1];
    let depth = 0;
    for (let number = firstLine.number; number <= Math.min(doc.lines, firstLine.number + FOLD_SCAN_LINES); number++) {
      const line = doc.line(number);
      const content = stripComment(number === firstLine.number ? line.text.slice((begin.index ?? 0)) : line.text);
      for (const match of content.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
        if (match[2] !== name) continue;
        depth += match[1] === "begin" ? 1 : -1;
        if (depth === 0) {
          if (number === firstLine.number) return null;
          return { from: lineEnd, to: doc.line(number - 1).to > lineEnd ? doc.line(number - 1).to : lineEnd };
        }
      }
    }
    return null;
  }

  const section = text.match(/^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/);
  if (section) {
    const rank = SECTION_RANK[section[1]];
    let last = firstLine.number;
    for (let number = firstLine.number + 1; number <= Math.min(doc.lines, firstLine.number + FOLD_SCAN_LINES); number++) {
      const content = stripComment(doc.line(number).text);
      const next = content.match(/^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/);
      if ((next && SECTION_RANK[next[1]] <= rank) || /^\s*\\(end\s*\{document\}|bibliography\b|printbibliography\b|appendix\b)/.test(content)) break;
      last = number;
    }
    // Leave trailing blank lines outside the fold.
    while (last > firstLine.number && !doc.line(last).text.trim()) last--;
    return last > firstLine.number ? { from: lineEnd, to: doc.line(last).to } : null;
  }

  return null;
}

export function latexLanguageSupport(fileName: string): Extension {
  if (/\.bib$/i.test(fileName)) return [bibtexLanguage, syntaxHighlighting(latexHighlightStyle), indentUnit.of("  ")];
  return [latexLanguage, syntaxHighlighting(latexHighlightStyle), foldService.of(latexFoldRange), indentUnit.of("  ")];
}
