# LaTeX Visual mode: review against 12 more papers (round 2)

Branch `fix/latex-visual-audit-12` (base `7450031`). November 2026. Round 1:
`2026-11-10-latex-visual-paper-review.md`. The recipe for running a round is now a project skill
(`.claude/skills/latex-visual-audit/SKILL.md`), with `npm run audit:latex-visual`.

## What was done

12 recent arXiv papers, one per field, chosen away from round 1's ML/CS/econ focus. Each `.tex` file was opened
headlessly the way the editor opens it: the project's macro files, the main file's definitions for a chapter, the
numbering start, every pending piece built, the view mounted and numbered.

The new audit script reports three things:
- **Commands left as source:** commands on screen as LaTeX, outside comments and outside faded `\iffalse` branches.
- **Formulas left as source:** each with its reason (the macro expansion failed, or KaTeX's error).
- **Widgets drawn with LaTeX in them:** drawn wrong, which is worse than source.

The issues were split into four areas. Each area was fixed by an Opus agent in its own worktree, and the four branches
were merged by hand.

| Field | Paper | Class / notable packages |
|---|---|---|
| quant-ph | 2611.11568 | JHEP, slashed, bm |
| hep-th | 2611.10539 | revtex4-2 |
| astro-ph.GA | 2611.08676 | aastex7 |
| math.AG | 2611.08810 | amsart |
| math.CO | 2611.11191 | amsart, booktabs |
| stat.ME | 2611.09678 | article, 16 table files |
| cs.LO | 2610.41832 | Cambridge jfp, lhs2TeX |
| cond-mat.str-el | 2611.08102 | revtex4-2 |
| math.PR | 2611.09890 | multi-file book-style |
| cs.CL | 2611.11838 | ACL, linguex, tcolorbox |
| cs.DS | 2611.09172 | acmart, algorithm2e, 27 files |
| q-bio.NC | 2610.36484 | NeurIPS-style, `\newif` switches |

## Measured effect

Same 12 papers, same script, base vs merged.

| Paper | Commands left as source | Formulas left as source | Widgets with raw LaTeX | Numbered entries |
|---|---|---|---|---|
| astro-ph 2611.08676 | 179 → 0 | 0 → 0 | 0 → 0 | 46 → 51 |
| quant-ph 2611.11568 | 379 → 0 | 0 → 0 | 0 → 0 | 291 → 291 |
| cs.LO 2610.41832 | 346 → 40 | 0 → 0 | 0 → 0 | 24 → 24 |
| cs.DS 2611.09172 | 106 → 41 | 6 → 2 | 0 → 0 | 41 → 41 |
| stat.ME 2611.09678 | 95 → 5 | 0 → 0 | 0 → 0 | 124 → 124 |
| hep-th 2611.10539 | 61 → 0 | 0 → 0 | 0 → 0 | 48 → 48 |
| cs.CL 2611.11838 | 61 → 10 | 0 → 0 | 1 → 0 | 98 → 110 |
| cond-mat 2611.08102 | 22 → 1 | 0 → 0 | 0 → 0 | 35 → 35 |
| math.CO 2611.11191 | 17 → 0 | 1 → 0 | 0 → 0 | 102 → 102 |
| q-bio 2610.36484 | 15 → 1 | 0 → 0 | 0 → 0 | 77 → 77 |
| math.PR 2611.09890 | 5 → 5 | 0 → 0 | 0 → 0 | 119 → 119 |
| math.AG 2611.08810 | 0 → 0 | 0 → 0 | 1 → 0 | 16 → 16 |
| **Total** | **1,286 → 103** | **7 → 2** | **2 → 0** | **1,021 → 1,038** |

How to read the numbers:
- **Formula counts:** "formulas left" counts `$`/`\[` openers. The per-formula reason list now holds one formula,
  `$(H')$` in a cs.DS file, rejected by the walk.
- **astro-ph:** in the base its preamble also showed as source, because of the `\begin{document}` comment (below). The
  body count doesn't include that.
- **Build performance:** `npm run bench:latex-visual` was run twice on `main` and twice on the branch, back to back,
  and stays within its budgets and within noise of `main`:
  - First build: 17.6 ms on `main`, 18.0–19.3 ms on the branch.
  - Keystroke median: about 0.65 ms on both.
  - Slowest idle piece: 9.0–11.6 ms on `main`, 11.3–12.7 ms on the branch, against a 12 ms budget. One branch run went
    over the budget; one `main` run was within 0.4 ms of it.
- **Audit times:** the audit's own per-file times are not an editor measure. They include drawing every widget's DOM
  for the raw-LaTeX check, so they grow with what is drawn.

**Tests.**
- The Visual mode suites, plus the Markdown-paste and macro tests, were run once after all merges: 369 of 369 pass,
  about 25 of them new paper regressions.
- Type check and lint are clean.
- On the user's request, testing was kept to the touched files. The full editor suite and the repeated property runs
  were not run.

## What changed, by area

**Body detection (cross-cutting).** A `\begin{document}` inside a comment stopped the search. Every AASTeX 7
template has `%% the \begin{document} command.` above its macros, so the whole file was treated as having no
preamble. A shared finder (`src/lib/latex/document-begin.ts`) now looks past commented ones. It is used for body
detection, entry selection, the title scan, math and snippet contexts, project root and macro collection, chapters,
and search chunking.

**Math.**
- New symbols and commands:
  - `\sun` and `\earth` draw as ⊙ and ⊕.
  - slashed's `\slashed{k}` and `\slashed n` draw with a centred `/`.
  - The `\ooalign{\hfil/\hfil\crcr$#1$}` overlay idiom is drawn. Other overlays stay source.
  - `\arrowvert`, `\Arrowvert` and `\bracevert` are drawn.
  - `\textsc` inside math draws as small caps.
- booktabs rules inside a math `array` are drawn as `\hline`. `\cmidrule` stays source.
- mleftright's idiom, `\renewcommand{\left}{…\bgroup\originalleft}` with `\aftergroup\egroup`, is ignored, and TeX's
  own `\left`/`\right` are drawn. Before, every `\left…\right` in such a paper failed.
- `\ensuremath{…}` in text is drawn as an inline formula. This fixes 113 uses in lhs2TeX output, and AASTeX-style
  `\newcommand{\css}{\ensuremath{…}\xspace}` macros.

**AASTeX.**
- `deluxetable`/`deluxetable*` draw as numbered tables. Supported: `\tablehead`/`\colhead`, `\startdata…\enddata`,
  `\tablenotetext`, `\tablecomments`, `\tablerefs`, `\phn`, `\nodata`, `\sidehead`, `\tablenum`. Anything unknown
  leaves the table as source.
- `\plotone`, `\plottwo` and `\epsscale` draw as images.
- The title block is drawn without `\maketitle` and stays editable. It shows authors with ORCID options and their
  affiliations, `\email[show]`, `\correspondingauthor`, and `\keywords{\uat{…}{…}}`.
- `\facilities` and `\software` draw as labelled paragraphs.
- `\restartappendixnumbering` restarts appendix numbers as A1, B1.
- The journal-name macros (`\apj`, `\mnras`, …) are known.

**Floats, layout lines, algorithms.**
- Tables and floats:
  - revtex `ruledtabular` draws as a double-ruled table, and a caption starting with `\label` is read.
  - `widetext` is transparent.
  - A caption macro is read for any name, when its body is `\caption{#1}` followed by a box around another argument.
    stat.ME's `\tbl{caption}{tabular}` covers 16 tables, including `{\input{…}}` bodies and `\begingroup…\endgroup`
    wrappers.
  - `\fbox`, `\colorbox`, `\fcolorbox` and `\framebox` around a minipage draw as framed text. Widths written with
    `\dimexpr` are understood.
- Layout and state lines now fold away: `\appendix`, `\setcounter`/`\addtocounter`, `\renewcommand{\the…}{…}`,
  `\onecolumn`/`\twocolumn`, `\frenchspacing`, `\begingroup`/`\endgroup`. `\appendix` had been left on screen in 7 of
  the 12 papers.
- algorithm2e:
  - User `\SetKwFor` loops are read, from the preamble too, including side comments.
  - `\lIf`/`\lElse` bodies, `\Return` without braces, and `\fontsize…\selectfont`/`\setlength` at the start are read.
  - A float whose caption is on top no longer has its body taken as notes.
  - An algorithm that defines macros inside itself stays source.

**Text, citations, front matter, macros.**
- Citation notes print emphasis, font switches, `~` and simple math as text. Before, `\citep[\emph{inter alia}]` drew
  "\emphinter alia". A note holding anything else keeps the citation as source.
- Pass-through and discarding wrapper macros are worked out after their conditionals. This covers cs.DS's
  `{\ifx\fullversion\undefined{#1}\fi}` switches and q-bio's `\rev{\paragraph{…} …}`.
- A drawn macro whose `\ifx` can't be decided now stays source, instead of silently using its else branch.
- Conditional markers of decided switches fold: `\ifarxiv\else`, `\fi`.
- acmart: a title wrapped in a version macro, and `\input{abstract}` in the title run, are handled.
- Cambridge `jfp`: `\journaltitle`, `\cpr`, `\doival` and `authgrp` are part of the title block.
- `\maketitle%comment` now folds.
- In long documents built in pieces, a piece starting inside the title declarations no longer loses the block. This
  goes through `widen()` in `structural.ts` and affects every class.
- A theorem wrapper whose heading holds a `\ref` (math.CO's `teoremarep`) draws as "Theorem 1.1".
- linguex: `\ex.`, `\exg.` and `\exi.` are numbered (1), (2), and `\a.`, `\b.` draw as sub-items a., b. Labels refer to
  "1" or "1b".

## Still open or partial

| What | Where |
|---|---|
| Body `\input` lines are shown as source lines (by design so far); about 35 across the papers | cs.DS, math.PR, stat.ME |
| A `figure*` of linguex examples with `\hfill` stays source | cs.CL acl_latex.tex:645 |
| lhs2TeX `hscode` code blocks (polytable `\column`, `\>[n]`) stay source | cs.LO |
| acmart `\gdef\@copyrightpermission{…}` block stays source; jfp affiliations are not shown (as for acmart) | cs.DS, cs.LO |
| An algorithm that redefines `\nl` inside itself stays source | cs.DS algorithms.tex |
| `\titlecap{…}`, `\secref`, revtex `\preprint` | cs.DS, cond-mat |
| linguex glosses are numbered but not aligned word by word | — |
| `\collaboration`, `\altaffiliation` and notes after a plain AASTeX `table` are implemented but not seen in a paper | — |

Behaviour changes worth knowing:
- A macro whose only definition is commented out counts as undefined for `\ifx…\undefined`.
- A true `\newif` conditional's test and the `\fi` of a decided conditional are faded, not shown.
- In a large document, the range holding `\maketitle` is built from the start of its title declarations.

## Not verified

- **Running app:** nothing was checked there. The checks were tests, the headless audit and the benchmark.
- **`\slashed` and the `\ooalign` overlay:** never seen on screen; the browser pane would not run KaTeX on a local file.
- **The rest of the editor suite:** not re-run, within the agreed testing budget.
- **Round 1's 26 lost papers:** not re-audited in this round.
