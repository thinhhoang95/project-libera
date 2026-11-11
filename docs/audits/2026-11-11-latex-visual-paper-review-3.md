# LaTeX Visual mode: review against 12 more papers (round 3)

Branch `fix/latex-visual-audit-3`. November 2026. Earlier rounds: `2026-11-10-latex-visual-paper-review.md`,
`-review-2.md`. Recipe: `.claude/skills/latex-visual-audit/SKILL.md`.

## What was done

12 recent arXiv papers (ids in `.claude/skills/latex-visual-audit/audited-papers.md`), each `.tex` file opened
headlessly as the editor opens it. Five Sonnet agents fixed areas in separate worktrees; their branches were merged by
hand into the round branch.

**Audit tooling bug found first.** `fetch` extracted sources with `tar xzf C:/…`; on Windows GNU tar reads `C:` as a
remote host, the extraction failed silently, and the fallback wrote the raw tar as `main.tex`. The first audit ran on
tar blobs. Fixed (relative tar path, tar detected by `ustar` after gunzip); the numbers below come from the corrected
fetch. The audit script also no longer counts `$` inside verbatim/listing/`\verb`/TikZ ranges.

## Issues by area

All of them degraded to source (nothing crashed, nothing was lost); the ones that drew something wrong are marked.

| Area | Issue (paper) | Result |
|---|---|---|
| Math | `\xymatrix` and `tikzcd` stayed source (math.AG 2611.06861) | **fixed**: simple diagrams draw as a KaTeX array (`math-diagram.ts`); anything with curved/shifted arrows, `\|` labels, `*+[F]` cells stays source; click shows source |
| Math | `\renewcommand{\arraystretch}` / `\setlength{\arraycolsep}` inside a formula broke KaTeX (math.AG) | **fixed** |
| Math/parser | TikZ body (`\foreach`, `$..$` coordinates) was parsed as LaTeX: error nodes broke the float, fake math widgets (math.AG) | **fixed**: `tikzpicture`/`pgfpicture`/`circuitikz` are verbatim in the grammar (side effect: no syntax highlighting inside a bare tikzpicture) |
| Verbatim | `$` in R code "paired" as math (stat.ME 2611.07519) | editor was already right; the audit script was miscounting; script fixed |
| Math | formulas with unit macros (`\masyr`) in citation notes kept the citation as source (astro-ph 2611.07227) | **fixed**: `mathNoteText`/`noteMathText` |
| Math sweep | not paper-driven: ~900 common math snippets through the pipeline | **17 tests**; gaps fixed in mathtools (`cases*`, `multlined`), `tensor`, stmaryrd, spacing, sized `\llbracket`; list of what stays source is in the test |
| Text | A&A class front matter (`\institute`, `\inst`, `\orcidlink`, `\corrauth`, `\titlerunning`, five-group `\abstract`) | **fixed** |
| Text | nested natbib (`\citep[][… \citealt{..}]{..}`) printed `\citealtPace2022` (**drawn wrong**) | **fixed** |
| Text | `\bibitem[CGK{\etalchar{+}}20]` printed raw LaTeX (**drawn wrong**) | **fixed** |
| Text | `\url{\repourl}`, `\footnotetext` under group-local `\renewcommand{\thefootnote}` | **fixed** |
| Text | `\eject`, `\Needspace`, `\onecolumngrid`, `\addtocontents`, `\AtEndDocument`, `\vskip\baselineskip`, `\includepdf`, `\hbox`, `\thanks` | **fixed** (hidden, source at cursor; `\includepdf` is a placeholder) |
| Environments | `\newtcolorbox` env leaked `\end{mainbox}` (hep-th 2611.09538): a box cut by a piece boundary was not widened whole (`structural.ts`) | **fixed** |
| Environments | `adjustbox`, `adjustwidth`, `multicols`, `sideways`, `lscape`, `threeparttable`, bare `\resizebox`/`\scalebox` | **fixed** (transparent wrappers) |
| Environments | generic `list`/`trivlist` (astro-ph) | **fixed** |
| Environments | bare table-row fragments (`\midrule`…) | **fixed** (drawn as rule lines) |
| Environments | `\newcounter`, `\counterwithin`, `\newsavebox`, `lrbox` | **fixed** as definitions; `\usebox` not expanded |
| Title block | no discoverable way back to the source: Alt-click only, revealed just `\maketitle` while `\title/\author` sit in the folded preamble; no way to add an author; keywords/CCS lines not clickable | **fixed**: "Edit source" button (unfolds the preamble, caret at the first command), "+" add author where `\and` applies, notes clickable (`title-edit.ts`, `widgets.ts`) |

## Measured effect

Same 12 papers, same (corrected) script, base vs merged: commands left as source 707 → 166, formulas left as source
129 → 2, widgets with raw LaTeX 2 → 0. Remaining "left": math.PR's 54 are preamble `\newcommand`s, cs.CL's 100+ are
`\input` lines and macro/style files, stat.ME's supplement 16, a few `\bottomrule` lines in astro-ph table fragments.
The 2 formulas left are the `\newcommand{\etalchar}[1]{$^{#1}$}` written in the body of cs.DS.

Tests: all `latex-visual*.test.ts` run once after the merges: 444 tests; 5 failed, fixed on the round branch (4 tests
whose expectations changed by design: tikz-cd in an equation now draws, title-block reveal places the caret, bibitem
`⁺`, note formula fallback; 1 jsdom flake that passes alone). `tsc` and `eslint` on changed files are clean.
Not checked in the running app (dev server needs a login); the CSS for the title-block buttons is untested visually.

## Rule added to the recipe

Every rendered widget must stay editable: a click (or Alt-click) must reveal its raw source, with a test per new kind
of widget. The skill's fixer brief and merge check now say so.

## Open

- `floatrow`/`\ffigbox`, `\newtcbtheorem` boxes, `\usebox` expansion, `\nolinebreak`.
- A macro expansion widget reveals its use, not the `\newcommand` in the folded preamble; theorem headings likewise
  for `\newtheorem`; `\bibliography` reveals the command line, not the `.bib`.
- The title block cannot add a missing `\date`/`\author`; the A&A five-group abstract has no in-place editor.
- Two helper families for natbib notes (`mathNoteText`/`noteMacros` and `noteMathText`/`citationNotes`) overlap and
  should be unified.
- Not source-bearing: `\cancelto`, `\overarc`, some stmaryrd symbols, `\left\ulcorner`.
- Agent worktrees were created from `origin/main`, not the round branch; the merges also brought in the two newer
  `origin/main` commits.
