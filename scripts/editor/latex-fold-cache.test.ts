import "./setup.cjs";
import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { latexFoldRange } from "../../src/lib/latex/codemirror/language";

// A copy of the fold service as it was before it was memoized.
const SECTION_RANK: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const FOLD_SCAN_LINES = 6000;
function stripComment(text: string) {
  const match = text.match(/(^|[^\\])(?:\\\\)*%/);
  return match ? text.slice(0, (match.index ?? 0) + match[0].length - 1) : text;
}
function original(state: EditorState, lineStart: number, lineEnd: number) {
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
    while (last > firstLine.number && !doc.line(last).text.trim()) last--;
    return last > firstLine.number ? { from: lineEnd, to: doc.line(last).to } : null;
  }
  return null;
}

const SOURCE = String.raw`\documentclass{article}
% \begin{commented}
\begin{document}
\part{One}
\chapter{A}
\section{S1}
text \begin{itemize} \item x \end{itemize}
\begin{itemize}
\item a % \end{itemize}
\begin{itemize}
\item nested
\end{itemize}
\end{itemize}

\subsection{Sub}
\begin{equation} x \end{equation}
\begin{unclosed}
\subsubsection*{Deep}
\paragraph{P}
text

\section{S2}
\appendix
\section{After}
\bibliography{x}
\end{document}
`;

test("memoized fold ranges equal the original logic for every line", () => {
  const state = EditorState.create({ doc: SOURCE });
  for (let pass = 0; pass < 2; pass++) {
    for (let number = 1; number <= state.doc.lines; number++) {
      const line = state.doc.line(number);
      assert.deepEqual(latexFoldRange(state, line.from, line.to), original(state, line.from, line.to), `line ${number}, pass ${pass}`);
    }
  }
});

test("a different line end is another cache entry, and an edited document is rescanned", () => {
  const state = EditorState.create({ doc: SOURCE });
  const line = state.doc.line(3);
  assert.deepEqual(latexFoldRange(state, line.from, line.to), original(state, line.from, line.to));
  assert.deepEqual(latexFoldRange(state, line.from, line.to + 1), original(state, line.from, line.to + 1));
  const edited = state.update({ changes: { from: state.doc.length - 15, insert: "\\end{unclosed}\n" } }).state;
  for (let number = 1; number <= edited.doc.lines; number++) {
    const l = edited.doc.line(number);
    assert.deepEqual(latexFoldRange(edited, l.from, l.to), original(edited, l.from, l.to), `edited line ${number}`);
  }
});
