import assert from "node:assert/strict";
import test from "node:test";
import { isLatexCitingPath, latexCitation, latexCitedKeys, scanLatexCitations } from "../../src/lib/references/latex-cite-syntax";
import { citationSnippets, relocateLatexCitation } from "../../src/lib/references/occurrences";

test("LaTeX citation commands are scanned with their notes, stars and multicites; comments and escapes are skipped", () => {
  const source = String.raw`As shown \cite{smith2020, Doe_21}. See \citep[p.~3]{jones}.
% \cite{commented}
50\% \textcite{pct} and \\cite{x}. \parencites(g)[a]{k1}[b][c]{k2,k3} \nocite{*}
\Citet*{star} \excite{no} \cite
{broken`;
  assert.deepEqual(scanLatexCitations(source).map(({ command, keys }) => [command, keys]), [
    ["cite", ["smith2020", "Doe_21"]],
    ["citep", ["jones"]],
    ["textcite", ["pct"]],
    ["parencites", ["k1", "k2", "k3"]],
    ["nocite", []],
    ["Citet", ["star"]],
  ]);
  const [first] = scanLatexCitations(source);
  assert.equal(source.slice(first.start, first.end), String.raw`\cite{smith2020, Doe_21}`);
  assert.deepEqual(latexCitedKeys(String.raw`\cite{a,b} \citep{b, c}`), ["a", "b", "c"]);
});

test("Cite at cursor writes \\cite or \\citep with comma-separated keys", () => {
  assert.equal(latexCitation(["a"]), String.raw`\cite{a}`);
  assert.equal(latexCitation(["a", "b"], "citep"), String.raw`\citep{a,b}`);
  for (const key of ["a%b", "two words", "a,b", "a}", "a\\b", ""]) assert.equal(latexCitation([key]), null);
});

test("literal environments and inline examples do not cite, including percent signs inside verbatim", () => {
  const environments = ["verbatim", "verbatim*", "Verbatim", "lstlisting", "minted", "comment"];
  const source = environments.map((name) => `\\begin{${name}}\n% \\cite{example}\n\\cite{alsoExample}\n\\end{${name}}`).join("\n");
  assert.deepEqual(latexCitedKeys(source + String.raw`
\verb|% \cite{inline}| \cite{afterVerb}
\verb*+\cite{star}+ \lstinline[language=TeX]!\cite{listing}!
\mintinline{tex}{% \cite{mint}} \cite{real}`), ["afterVerb", "real"]);
  assert.deepEqual(latexCitedKeys(String.raw`\begin{verbatim} \cite{unclosed}`), []);
});

test("macro definitions are not executed or expanded by the citation scanner", () => {
  assert.deepEqual(latexCitedKeys(String.raw`
\newcommand{\example}[1][\cite{default}]{\cite{unused}}
\renewcommand*\example{\cite{renewed}}
\providecommand{\other}{\cite{provided}}
\DeclareRobustCommand{\robust}{\cite{robust}}
\NewDocumentCommand{\xparse}{m}{\cite{#1}}
\def\primitive#1{\cite{defined}} \long\gdef\global{\cite{global}}
\example \cite{actual}`), ["actual"]);
});

test("comments may separate or occur inside arguments, and braces shield nested note delimiters", () => {
  const source = String.raw`😀 \citep% command note
 [{see ] and [ inside braces} and [nested]]% optional note
 {a,% key note, } ignored
 b} \\% \cite{commented}
\% \cite{escaped} \\\cite{afterBreak}
\textcites({global ) note})(post)[{local ] note}]{c}
 [pre][post]{d, e}`;
  const citations = scanLatexCitations(source);
  assert.deepEqual(citations.map(({ keys }) => keys), [["a", "b"], ["escaped"], ["afterBreak"], ["c", "d", "e"]]);
  assert.equal(citations[0].start, source.indexOf("\\citep"), "offsets count UTF-16 code units");
  assert.equal(source.slice(citations[0].start, citations[0].end), source.slice(3, source.indexOf("b}") + 2));
});

test("incomplete arguments do not invent keys or hide later complete commands", () => {
  assert.deepEqual(latexCitedKeys(String.raw`\cite[unclosed \cite{later} \cite{unfinished`), ["later"]);
  assert.deepEqual(latexCitedKeys(String.raw`\cite{ a , b , , *, two words, \macro, {nested, fake, keys} }`), ["a", "b"]);
  assert.equal(isLatexCitingPath("Notes/MAIN.TEX"), true);
  for (const path of ["Notes/refs.bib", "Notes/pkg.sty", "Notes/class.cls", "Notes/main.tex.md"]) assert.equal(isLatexCitingPath(path), false);
});

test("comments end at LF, CRLF and CR, without changing source offsets or snippet line numbers", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const source = `% \\cite{hidden}${newline}😀 \\cite% note${newline}{a,% key note${newline} b}`;
    assert.deepEqual(latexCitedKeys(source), ["a", "b"]);
    const snippet = citationSnippets(source, ["a"], undefined, "latex")[0];
    assert.equal(snippet.start, source.indexOf("\\cite%"));
    assert.equal(snippet.line, 2);
    assert.equal(snippet.match, source.slice(snippet.start));
  }
});

test("a citation reveal follows edits in UTF-16 text and distinguishes repeated commands by context", () => {
  const source = "First \\cite{a}.\n\nTarget \\cite{a} ends here.";
  const snippet = citationSnippets(source, ["a"], undefined, "latex")[1];
  const changed = "😀 New paragraph.\n\n" + source;
  const moved = relocateLatexCitation(changed, snippet)!;
  assert.equal(moved.start, changed.indexOf("\\cite", changed.indexOf("Target")));
  assert.equal(changed.slice(moved.start, moved.end), snippet.match);
  const edited = relocateLatexCitation(changed.replace("Target \\cite{a}", "Target \\citep{a}"), snippet)!;
  assert.equal(edited.match, "\\citep{a}");
  assert.equal(relocateLatexCitation("% " + snippet.match, snippet), null, "a removed/commented citation is not selected");
});
