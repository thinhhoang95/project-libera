# LaTeX Visual mode: review against 51 more papers (round 7)

Branch `fix/latex-visual-audit-7`, cut from `main` (33fecec). 15 November 2026. Earlier rounds: `2026-11-10-…-review.md`
to `2026-11-12-…-review-6.md`. Recipe: `.claude/skills/latex-visual-audit/SKILL.md`.

## What was done

51 recent arXiv papers, as asked limited to ML, statistics, physics, control and mathematics: two each from cs.LG,
stat.ML, stat.ME, stat.AP, stat.CO, math.ST, hep-ph, quant-ph, math-ph, cond-mat.{stat-mech,mes-hall,mtrl-sci},
physics.{optics,flu-dyn}, eess.SY, math.{OC,DS,AP,PR,NA,GT,RT,CA}, plus one more each from cs.LG, stat.ML, hep-th,
quant-ph, math.OC and math.PR (ids in `audited-papers.md`). gr-qc and nucl-th papers were fetched but not audited (see Open).
216 `.tex` files were opened headlessly as the editor opens them. Four Sonnet agents fixed one area each in separate
worktrees: units and chemistry, math macros, front matter and bibliography, text and environments. Their branches were
merged by hand, keeping both sides of the conflicts in `definitions.ts`, `numbering.ts`, `project-numbering.ts` and
`walk.ts`.

## Editing: every widget opens its source

The user's standing rule is that nothing drawn may be out of reach for editing. This round's sweep of `widgets.ts` and
`text-commands.ts` found ten widget kinds with no click handler of their own: heading numbers, footnote marks, symbols
such as `\ldots` and `~`, `\\` marks, proof and environment end marks, example markers, restated-theorem headers,
unlabelled item markers and macro pieces. CodeMirror ignores clicks on widgets by default, so whether these could be
edited depended on where the browser put the caret.

- **New `widget-clicks.ts`.** A click on a widget that no handler of its own took now shows the source of the
  construct under it. If the cursor alone would not open that construct, it is forced open, as Alt+Enter does. This
  covers present and future widgets. Controls inside widgets (fields, buttons, links) keep their own clicks.
- **New `noedit=` count in the audit.** It counts drawn widgets that have no construct under them, which no click
  could open. The baseline found 2: an indented `\end{proof}` drew its ∎ over the indent while its construct started
  at `\end` (math.GT 2611.08002, math.PR 2611.15228). Fixed in `walk.ts`; the count is now 0 across all 216 files.
- **New `latex-visual-widget-clicks.test.ts`.** It clicks every widget of a sample document in turn and checks that
  the source shows. Formulas and `\ref` chips do something else on a plain click (open the formula editor, go to the
  label), so for them Alt-click is the path to source.
- **Checked in the running app** (Chrome, the user's own notebook, with clicks only and no edits). Clicking a list
  number opened `\item…`, and clicking a footnote mark opened `\footnote{…}`.
- **Every new widget kind from the agents has a click-to-source test:** units and `\ce` (through `MathWidget`),
  `\bmhead`, the `keywords`/`MSCcodes` blocks, the `\burlalt` link, the `parts` items and `\partlabel` chips, the
  `\citetext` parentheses (new `GroupMarkWidget`), the coloured headings and contents, and the `\thealgorithm` counter.
  `CounterWidget` got a click handler of its own.

## Numbers (left / math / junk, summed per paper)

| Paper | Before | After |
|---|---|---|
| math.AP 2611.14954 | 395 / 0 / 0 | 4 / 0 / 0 |
| physics.flu-dyn 2611.12193 (42 files) | 144 / 16 / 0 | 5 / 0 / 0 (TikZ figure files, a one-line `center`) |
| math.PR 2611.15228 | 121 / 0 / 17 | 0 / 0 / 0 |
| cond-mat.mes-hall 2611.13235 | 116 / 20 / 0 | 8 / 2 / 0 (`\SI{19.1(5.0)}{…}`) |
| stat.ME 2611.14011 | 90 / 21 / 0 | 2 / 0 / 0 (TikZ figure files) |
| math.ST 2611.11874 | 70 / 0 / 0 | 0 / 0 / 0 |
| math.AP 2611.14951 | 48 / 12 / 0 | 19 / 12 / 0 (`tabular` inside `equation`) |
| physics.optics 2611.13800 | 38 / 0 / 0 | 1 / 0 / 0 (`\acknowledgments`) |
| math.GT 2611.08002 | 36 / 2 / 0 | 0 / 0 / 0 |
| math.NA 2611.14041 | 11 / 0 / 0 | 9 / 0 / 0 (TikZ/pgfplots figure files) |
| math-ph 2611.15304 | 11 / 0 / 0 | 0 / 0 / 0 |
| stat.CO 2611.01271 | 10 / 0 / 0 | 0 / 0 / 0 |
| stat.ML 2611.14586 | 8 / 0 / 1 | 1 / 0 / 0 (`\quad`) |
| stat.AP 2611.10325 | 7 / 0 / 0 | 0 / 0 / 0 |
| cond-mat.mes-hall 2611.13157 | 7 / 0 / 0 | 0 / 0 / 0 |
| cond-mat.stat-mech 2611.14576 | 6 / 0 / 0 | 0 / 0 / 0 |
| stat.ML 2611.13765 | 4 / 0 / 0 | 3 / 0 / 0 (TikZ figure files, `\bstctlcite` in one) |
| stat.AP 2611.10515, eess.SY 2611.15162 | 4 / 0 / 0 each | 0 / 0 / 0 |
| math.GT 2611.08165 | 3 / 0 / 0 | 3 / 0 / 0 (`\end` on the last line with no newline: the audit's caret) |
| 6 papers with 1–3 left | 9 / 0 / 0 | 0 / 0 / 0 |
| 26 papers | 0 / 0 / 0 | 0 / 0 / 0 |
| **Total** | **1141 / 71 / 18** | **55 / 14 / 0**, `noedit` 2 → 0 |

Tests:
- **Added:** 35 tests in `latex-visual-audit7-{units,math,front,text}.test.ts` and `latex-visual-widget-clicks.test.ts`.
- **Full Visual set after the merges (637 tests):** 631 passed, 6 failed. All 6 were title and author editing tests:
  they dispatch a mousedown that is not cancelable, so the title editor could not mark it taken and the new click
  fallback took it too. The fallback now leaves alone clicks it cannot take.
- **Rerun after that fix:** only `latex-visual.test.ts`, `latex-visual-gaps-frontmatter.test.ts` and
  `latex-visual-widget-clicks.test.ts`, which all passed (98 / 98). The whole set was not run again, per the compute
  budget.
- **Static checks:** `tsc --noEmit` and eslint on every changed `.ts` file are clean.

## Issues by area

| Area | Issue (paper) | Result |
|---|---|---|
| Units | siunitx 3's abbreviations (`\mol`, `\eV`, `\ml`, `\mm`, `\kHz`…), unit powers (`\angstrom^{-1}`), `\per\sqrt{\hertz}`, `\qtyproduct`/`\numproduct`, `±` quantities bracketed (13235, 12193, 13800) | **fixed** in `siunitx.ts` |
| Units | `\DeclareSIUnit` and `\sisetup` (`per-mode`, range and list phrases, `product-units`), read from the project's definitions so part files get them | **fixed**; options it does not know leave the command as source |
| Units | `\SI` inside `$…$` (a KaTeX error before) | **fixed** in `references.ts` |
| Units | `\SI{19.1(5.0)}{\kelvin}`: a decimal uncertainty in brackets | **left** as source (format not verified) |
| Chemistry | mhchem's `\ce`/`\pu` in text (13800 ×25, 14809) | **fixed**: an inline formula, only when the document loads mhchem |
| Math | `\chardef\showllabel=0` deciding `\ifnum\showllabel=1 … \else \def\llabel…\fi`; `\inon{on $\partial\Omega$}` (a `\hbox{#1}` macro) ending the display in the grammar (14954, 395 left) | **fixed** (`definitions.ts`, `latex-parser.ts` reads such arguments as text) |
| Math | mathtools' `\MoveEqLeft` drawn literally (15228, 17 junk) | **fixed**: an alignment point at a row's start, otherwise the formula stays source |
| Math | `\begin{equ}` (mhequ, or an alias `\newenvironment`) | **fixed**: a numbered display |
| Math | `\DeclareSymbolFontAlphabet{\mathbbl}{bbold}` (14011) | **fixed**, drawn with `\mathbb` |
| Math | `\normalfont`, `\itshape`, `\bfseries`… in `\text{}` (14951) | **fixed**; `\scshape`, `\mdseries` stay source |
| Math | xy's `^-{f}` labels (08002) | **fixed** |
| Math | `\begin{tabular}` inside `\begin{equation}` (14951, line 3617) | **left** |
| Front matter | `\maketitle\thispagestyle{empty}` on one line kept the title block as source (10515) | **fixed** |
| Front matter | sn-jnl `\bmhead`, Elsevier `\end{frontmatter}` in a later build piece, jmlr2e `keywords`, siamart `MSCcodes`, eso-pic `\AddToShipoutPicture*`, IEEEtran `\bstctlcite` | **fixed** |
| Bibliography | `\burlalt` (an `\expandafter\ifx\csname…` fallback definition), `thebibliography` settings, `\begingroup…\bibliography{…}\endgroup` | **fixed**; in the group form the inner `\renewcommand` needs the caret on it |
| Macros | `\pref{eq:a_b}` refused because `_` in a label read as math (15647) | **fixed** |
| Lists | a user `parts` environment opening an enumerate with its own `\theenumi`, and `\partlabel` (11874, 70 left) | **fixed**; `\ref` gives "(ii)", not LaTeX's "3.1(ii)" |
| Citations | natbib `\citetext{…}` | **fixed** |
| Headings | `\textcolor{…}{\section{…}}` and `\protect\textcolor{…}{\tableofcontents}` (15304) | **fixed**; the starred form stays source |
| Environments | `revision` (`\begingroup\color{black}`) transparent; `\hrule`, `\sloppy`, `\setlength` after `\begin{enumerate}` hidden; `\end{minipage}` split across build pieces | **fixed** |
| Audit | `\thealgorithm` counted as junk (it draws the number in the app) | **fixed** in the audit |

## Open

- `tabular` inside an equation (math.AP 2611.14951). It needs a rescue of the broken display and a tabular-to-array
  translation.
- siunitx bracketed decimal uncertainties; `\textcolor{…}{\section*{…}}`; one-line
  `\begin{center}{\large\bfseries …}\end{center}`.
- The whole Visual set was not run again after the last fallback fix; only the three affected files were.
- Not checked in the app: the new widgets of this round (units, `parts`, coloured headings). The two click checks
  above used the user's own notebook.
- gr-qc 2611.15331 and 2611.15321, and nucl-th 2611.10816 and 2611.10465, were fetched and extracted (the fetch log
  lists them) but their folders were gone before the baseline audit. Nothing in the fetcher removes a folder after a
  successful fetch, and the cause was not found. They are not in `audited-papers.md`, so a later round can pick them up.
- One paper was listed in both math-ph and math.PR and was audited once.
