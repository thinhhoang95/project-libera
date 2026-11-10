# LaTeX Visual mode: review against 36 real papers

Branch `fix/latex-visual-render` (base `5a0991e`). November 2026.

## What was done

The Visual mode (the CodeMirror layer that draws a `.tex` file as a document) was opened on the arXiv sources of
36 papers. The papers span CS (ML, systems, HCI, PL, theory), econometrics and applied economics, a thesis and two books.
Every problem seen was written down with its paper and source, then fixed or deliberately left as source.

- **Review sources.** Codex (GPT-6.1-Sol) reviewed the code and 10 papers (findings C-1…C-10). Claude looked at the same
  papers in the running app (M-1…M-15). Five rounds of auditor subagents took 26 more papers (B3-…B7-).
- **Fixes.** Batches 1–3 were fixed directly on the branch. Batches 4–7 were split into seven areas, each fixed on its own
  branch in its own worktree, then merged: conditionals/definitions, numbering/references/bibliography, multi-file
  projects/classes, floats/tables, front matter/text, math/algorithms, build performance.
- **Rule kept throughout:** show only what is understood. Anything the code cannot read stays as LaTeX source rather
  than being drawn wrong.

| Status | Issues |
|---|---|
| Fixed | 149 |
| Partly fixed | 15 |
| Open | 1 |

### Papers

| Round | Papers |
|---|---|
| 1–2 (Codex, app) | Callaway & Sant'Anna DiD 1803.09015, Synthetic DiD 1812.09970, Featherweight Go 2005.11710, almost-linear max-flow 2203.00671, Transformer 1706.03762, Borusyak et al. 2108.12419, generalized random forests 1610.01271, Carlini & Wagner 1608.04644, Julia 1411.1607, O'Donnell's *Analysis of Boolean Functions* 2105.10386 |
| 3 | SimCLR 2002.05709, normalizing flows 1912.02762, SIAM optimization review 1606.04838, econ 2404.19590, econ theory 2102.00618 |
| 4 | minimum wage (KOMA) 2403.17206, esttab tables 2303.10367, Econometrica theory 1909.11219, HANK macro 2403.00471, stargazer tables 2301.08083 |
| 5 | thesis 1709.01953, book 2403.14606, USENIX 2012.07805, Generative Agents (acmart) 2304.03442, IEEE 1610.05820, IROS 1703.06907 |
| 6 | SimPO 2405.14734, Self-RAG 2310.11511, Depth Anything 2401.10891, GaLore 2403.03507, LongBench 2308.14508 |
| 7 | complexity 2402.08434, 2411.02681, 2410.03413, LIPIcs 2204.14024, physics 2511.16492 |

## Measured effect

The 10 round-1–2 papers (55 `.tex` files) were built headlessly with the base code and the merged code. The build
covers the structural layer to the end of each file, plus numbering. Each file was built alone, without its project's
other files, so absolute "left as source" counts are high: macros from the main file and local `.sty` files are
unknown. The comparison between the two builds is what matters.

Both builds were run back to back on an idle machine.

| | Base `5a0991e` | Merged |
|---|---|---|
| Crashes / hangs | 0 | 0 |
| Commands left as source (body, outside comments) | 54,608 | 47,325 (−13%) |
| Numbered entries (sections, equations, floats, theorems) | 1,219 | 1,537 (+26%) |
| Full build of all 55 files, every pending piece run to the end | 3.09 s | 3.41 s (+10%) |
| Slowest single piece | 14 ms | 15–17 ms |

Per paper:

| Paper | Commands left as source | Numbered entries |
|---|---|---|
| Synthetic DiD | 642 → 47 | 155 → 155 |
| Borusyak et al. | 2,340 → 275 | 195 → 197 |
| Callaway & Sant'Anna | 97 → 40 | 128 → 131 |
| Carlini & Wagner | 51 → 4 | 92 → 92 |
| Featherweight Go | 6,267 → 3,424 | 0 → 109 |
| Julia | 226 → 287 (its `\ja…\jc` code macros were drawn as half-expanded junk and now stay source on purpose) | 23 → 61 |

The 10% longer total build is the cost of building in smaller, time-bounded pieces plus the new features. Interactive
costs went down: see build performance below.

**Tests.**
- The Visual mode suites (12 files, 331 tests, ~120 of them new paper regressions) passed five runs in a row, property
  tests included.
- The full editor suite passed 2,218 of 2,226. All 7 failures that remained also fail on `main` (gallery, markdown text
  width, notebook links, outline panel, review-file locks).
- One Visual mode test failed only under the full suite's load: its helper numbered a partly parsed tree. The helper now
  waits for the parse.
- The existing Markdown-paste property test fails rarely: once in about 15 runs, in code these branches didn't change.
- Type check and lint are clean.

## What changed, by area

**Conditionals and definitions.**
- TeX conditionals are decided when what they test is known: `\if0`, `\ifnum\flag=…` on constants, `\newif` switches,
  `\ifdefined`, `\ifmmode`, ifthen's `\ifthenelse`. Package and class options run their `\DeclareOption` code. The
  branch not taken is faded and not numbered.
- `\loop…\repeat` no longer derails the definitions reader.
- Newly read: thmtools' `\declaretheorem` and `\declaretheoremstyle`, `\newtheoremstyle`, definer macros, unbraced
  one-token bodies, `\DeclareMathAlphabet`, `\mathchardef`, `\DeclareMathSymbol`, `\DeclarePairedDelimiterX`, and
  `\let…\undefined` / saved built-ins.
- Also: xparse `g`/`G` arguments, the comment package, `\foreach` alphabets, `\WithSuffix`, LyX's `\global\long\def`.

**Numbering, references, bibliography.**
- Numbering now handles `\frontmatter`/`\mainmatter`/`\backmatter`, the `appendix` environment, an `\appendix` after
  `\the…` formats, body `\counterwithin`, `\setcounter{…}{\value{…}}`, KOMA `\captionabove`/`\captionbelow`, ctable,
  listing captions, sub-caption labels, macro-written structure, and `\fnsymbol` footnotes.
- cleveref/autoref wording now matches pdflatex: chapter/appendix names, capitalize/noabbrev, grouped and compressed
  lists, `\crefrange`, `\crefalias`, `\crefname`.
- Citations are read from the compiled `.bbl` (biblatex, natbib, harvard, ACM, apacite, numeric). Numeric and
  author–year styles are told apart, and notes like "p. 5" are kept.
- `\bibliography`/`\printbibliography` draw the reference list.
- `\hyperref[label]{text}` draws as a link; a `\tag` written as math shows as math.

**Multi-file projects and classes.**
- A chapter sees the macros and numbering formats its main file defines before including it.
- Projects with more than 24 included files are fully numbered.
- `\import`/`\subimport` and subfiles roots are followed.
- llncs, LIPIcs and acmart theorems are known, and project `.cls` files are read.
- A user environment that wraps a theorem in a frame is numbered as that theorem.
- Chapter-start numbering went from ~340 ms to ~2 ms when nothing changed (~50 ms after typing). Main-file re-numbering
  after a pause went from 15 ms to 1.3 ms.

**Floats and tables.**
- Floats with notes (notes paragraphs, notes minipages, threeparttable, `\floatfoot`), layout commands, `\Description`,
  `\caption*` notes, and renamed floats are drawn instead of falling back to source.
- Boxes (tcolorbox, mdframed), diagrams as placeholders (tikz-cd, quantikz, xy, tikzit, cryptocode), picture overlays,
  `\captionof` teasers, and `\input` rows are handled.
- In cells and captions: colours (`\textcolor[HTML]`, `{\color{x} …}`), footnotes, `\phantom`, lists in minipages.
- Column specs: dcolumn, estout's `\newcolumntype{.}`, dashed rules, stargazer spacing rows. Wide tables no longer wrap
  numbers mid-digit.

**Front matter and text.**
- Title blocks: acmart (abstract, CCS, keywords, teaser), IEEEtran author blocks, ICML, JMLR, LIPIcs 5-argument
  authors, amsart's abstract-before-title, title declarations in the body, `\date` written with TeX's clock.
- Text: `\item[$…$]` labels, `\bf`/`\sc` in headings, glossaries/acronyms, todonotes, paralist, CJK, `\euro`.
- Layout-only lines fold away (spacing environments, landscape, `\afterpage`), and so does IEEEtran's bibliography
  boilerplate.
- A theorem's `[note]` on the line after `\begin` is read as its note.

**Build performance and incremental correctness.**
- **Four root causes of the "build after an edit ≠ full rebuild" mismatches fixed.** All four reproduce on the base:
  - a caption macro read an unclosed argument past `\end{figure}`;
  - following an edit stopped at the first pending piece, leaving later changes stale;
  - an edit closing a `{\it …` group opened lines earlier missed the group's style;
  - when the parser caught up, a node it had cut short stayed source.

  About 4,400 fuzzed runs across all property suites passed after the fix, including runs with the parser's time budget
  cut at random points.
- **Large documents.** Documents over 12 KB are first built around the cursor (4 KB before, 6 KB after), and the rest is
  built later. On-screen pieces are built before the browser paints; the others in idle time, in 2,000-character
  parts that stop after 8 ms.
- **Long lists** are built in pieces instead of all at once. Edits follow 10 KB ahead synchronously (was 40 KB).

| Measurement | Before → after |
|---|---|
| Opening a generated 23 / 41 / 55 KB math chapter | 30.1 / 47.0 / 49.8 ms → 7.3 / 5.8 / 3.8 ms |
| Slowest idle slice in those chapters | up to 19.6 ms → 4.4–7.4 ms |
| Typing `{` in prose (median / p95) | 2.3–7.9 / 6.6–10.2 ms → 1.5–1.9 / 2.3–5.1 ms |
| 10,000-item enumerate: first build / slowest idle slice | 942 ms / 495 ms → 21.8 ms / 8.3 ms |
| Repo benchmark first build | 16–17.7 ms → 11.5 ms |

**Math and algorithms.**
- The complexity package (`\P` was drawn as ¶) and the physics package.
- amsthm `\qed`/`\qedhere`, capital accents, `\intertext`, `\sqsubsetneq`, `\scalebox` in math, small matrices,
  `\tikzmark`, mathpartir inference rules.
- Algorithms: algorithm2e and algpseudocode (`\Call`, `\algnewcommand`, `\algdef` blocks, `\SetKw*`, `\Indp`), and
  `\forall` is no longer read as `\FORALL`.

## Still open or partial

| Id | What remains |
|---|---|
| B5-17 (rest) | Typing `{` inside a very long list still costs ~9 ms per keystroke (the rest of the list is rebuilt in idle slices). |
| — | The widget and KaTeX caches evict their oldest entry in a way that gets slow with thousands of distinct formulas. |
| B5-26 | A user environment with `\paragraph` in its begin code; `\newreptheorem`. |
| B6-18/B7-20 | A restated theorem (`\name*`) is drawn only when its `restatable` is in the same file. |
| B5-28 | Listing captions are numbered and referable, but the "Listing 1" caption is not drawn. |
| B4-24 | `\footnotemark` in cells, captions and formulas shows "*" / is not drawn. |
| B4-25 | `\crefalias` of a theorem counter is not applied. |
| B5-16 | natbib's numeric style set with `\setcitestyle{numbers}` is not detected (`\usepackage[numbers]` is). |
| B5-13 | A preamble `\import{dir/}{macros}` is not read for definitions. |
| B4-23 | Theorem-style head punctuation is not drawn. |
| B5-23 | `blockarray` stays source. |
| B3-14 | Environment macros that don't pair up stay guarded rather than understood. |
| B4-19, B4-29..34, B5-32, B6-23 | Small leftovers. B4-19: exact source not found. B4-32: too vague to reproduce. B4-33: preamble-only `\input` needs a preamble change. B5-32: biblatex parentheses not reproduced. B6-23: `\label` inside a heading stays a chip. |

Behaviour changes worth knowing:
- `\autoref` to a section says "section 2", as pdflatex with hyperref does.
- Proofs end with □ when amsthm is loaded.
- algorithmic statement names are case-sensitive.
- A package read without its loader runs its option code as uncertain.

## Not verified

- The merged result has not yet been checked in the running app. It was checked by tests and by the headless build of
  the 10 round-1–2 papers. Batches 1–3 were checked in the app before the parallel fixes. This session could not start
  a dev server for the worktree.
- The paper sources and auditor notes for rounds 3–7 were lost when a temporary folder was cleared mid-run. The fixers
  finished from their written issue descriptions and small reproductions copied earlier; re-auditing those 26 papers
  would confirm the fixes on the real sources.
