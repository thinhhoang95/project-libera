# LaTeX Visual mode: review against 50 more papers (round 6)

Branch `fix/latex-visual-audit-6`, cut from `fix/latex-visual-audit-5`. 12 November 2026. Earlier rounds:
`2026-11-10-latex-visual-paper-review.md`, `-review-2.md`, `2026-11-11-…-review-3.md`, `-review-4.md`,
`2026-11-12-…-review-5.md`. Recipe: `.claude/skills/latex-visual-audit/SKILL.md`.

## What was done

50 recent arXiv papers, two each from 25 math, CS, ML and econ categories (ids in
`.claude/skills/latex-visual-audit/audited-papers.md`), 337 `.tex` files opened headlessly as the editor opens them.
Four Sonnet agents fixed one area each in separate worktrees; the branches were merged by hand (conflicts in
`structural.ts`, `walk.ts`, `widgets.ts`: both sides kept). A fifth agent fixed the regressions the merge showed.

Every new widget has a path back to its source and a test (`QedMarkWidget`, `PrintedTextWidget`, the fixed-text
citation chip; the `game` table is a `TableWidget`); hidden commands show their source at the caret.

## Numbers (left / math / junk, summed per paper)

| Paper | Before | After |
|---|---|---|
| math.DG 2611.09697 | 780 / 609 / 0 | 0 / 0 / 0 |
| math.AP 2611.11553 | 458 / 84 / 13 | 0 / 0 / 0 |
| cs.PL 2610.26599 (54 files) | 419 / 2 / 0 | 8 / 0 / 0 |
| cs.IT 2611.09366 | 157 / 6 / 0 | 0 / 0 / 0 |
| econ.TH 2611.05417 | 37 / 7 / 0 | 0 / 0 / 0 |
| math.CO 2611.12330 | 31 / 0 / 0 | 0 / 0 / 0 |
| math.NA 2611.09593 | 27 / 0 / 0 | 0 / 0 / 0 |
| cs.AI 2611.13966 | 18 / 0 / 0 | 0 / 0 / 0 |
| cs.IT 2611.09184 | 16 / 0 / 0 | 0 / 0 / 0 |
| cs.GT 2611.05705 | 12 / 0 / 22 | 0 / 0 / 0 |
| math.DG 2611.09689 | 9 / 1 / 7 | 0 / 0 / 0 |
| math.NA 2611.09574 | 8 / 12 / 0 | 2 / 0 / 0 |
| cs.CR 2611.10776, math.OC 2611.12089 | 8 / 0 / 0 each | 0 / 0 / 0 |
| cs.LG 2611.14035 | 7 / 0 / 0 | 0 / 0 / 0 |
| stat.ML 2611.11386 | 5 / 0 / 9 | 5 / 0 / 0 (`\bn`, left as source on purpose) |
| 11 papers with 1–3 left | 16 / 0 / 0 | 3 / 0 / 0 (end-of-file caret lines) |
| 24 papers | 0 / 0 / 0 | 0 / 0 / 0 |
| **Total** | **2015 / 721 / 51** | **18 / 0 / 0** |

Tests: the four new files pass alone (`latex-visual-audit6-{math,class,text,pandoc}.test.ts`, 37 tests). The whole
Visual set (580 tests) after the merges: 6 failures; 4 were real regressions, fixed in code (below). The last full run
was 578 / 580, taken before the final two-regression fix (after it only the three files it touches were run); the two
failures pass when their file runs alone and are the round-5 flaky ones (tcolorbox counter in `audit5-env`, "a formula
with a user macro stays editable" in `math-coverage`). **Still no clean full parallel run.** `tsc --noEmit` and eslint
on the changed files are clean. Not checked in a running dev server.

## Issues by area

| Area | Issue (paper) | Result |
|---|---|---|
| Parser | `\def\textmatrix#1&#2\\#3&#4\\{…}` in the preamble: the grammar ended the `\def` at the first delimiter and the rest of the file became its body, so **nothing rendered** (math.DG 2611.09697) | **fixed** in `latex-parser.ts`: such parameter text is read as `#1#2#3#4` of the same length |
| Math | `\m@th` in macro bodies (`\defeq`, `\pv`), esint `\fint`, macros inside `\tag{$…$}` (math.AP) | **fixed** |
| Math | `\multicolumn{2}{@{}c@{}}{…}` in a math `array` (cs.PL) | **fixed** |
| Math | mhchem `\ce{…}` (math.NA 2611.09574) | **fixed in the audit** (the app already loads mhchem; the harness loaded the wrong build). `\ce` draws whenever mhchem loads, not only when the document uses the package |
| Math | `\reflectbox{\ensuremath{\mapsto}}` (junk), `\MakeUppercase`/`\romannumeral` in a macro (math.DG 2611.09689) | **fixed** for known arrows; others stay source |
| Math | `\phantomsection` in equations; algorithm2e `\SetKwFunction` names used outside the algorithm (cs.IT) | **fixed**; assumes algorithm2e's default fonts |
| Math | `\footnote{… $…$ …}` inside `\[…\]` mis-paired the dollars (econ.TH) | **fixed**: a mark in the formula, note text in the source |
| Audit | KaTeX's own `\backslash` glyph and the prose word "undefined" counted as junk (cs.GT, stat.ML) | **fixed** in `latex-visual-audit.ts` |
| Pandoc | `\citeproc{ref}{{[}1{]}}`, `CSLReferences`, `\CSLLeftMargin`…, `\tightlist`, `\hypertarget`/`\hyperlink`, `\pandocbounded`, `\passthrough`, `\ifCLASSOPTION…` (cs.IT 2611.09366) | **fixed**. A Pandoc `\begin{lemma}[]` still draws "Lemma 1 ()." |
| Text macros | `\termref`/`\term` (etoolbox `\ifstrequal`, `\hyperlink`), `\myparagraph` (a `\newenvironment` used as a command) (cs.PL, ~290 uses) | **fixed**; thm-restate re-uses across files (5) and one mis-used `\nparagraph` stay source |
| Text macros | A macro body with `\csname`/`\@ifundefined`/`\setbox` drew TeX debris in captions (stat.ML, 9 junk) | **fixed**: such an expansion is rejected and the use stays source |
| Text macros | `\dingnum{n}` (`\ifcase`), `\mybox` (measuring prefix before a tcolorbox), `\newlength`/`\tcbset`/`\usepgfplotslibrary` in a definitions file (cs.CR, cs.SE) | **fixed** |
| Classes | Elsevier CAS title run ended at a `comment` environment (cs.AI 2611.13966) | **fixed** |
| Classes | IEEEtran: `\author` with its brace on the next line, `\linebreakand`, `\markboth{…}%⏎{…}`, `\IEEEpubid`, `\IEEEaftertitletext`, `\IEEEpubidadjcol`, `\IEEEpeerreviewmaketitle`, `IEEEproof` (cs.IT, cs.LG, cs.CV, math.OC) | **fixed**; author editing across `\linebreakand` has no test |
| Classes | SIAM shared preamble file opened on its own; title and authors that live in it (math.NA 2611.09593) | **fixed**: folds as a Preamble block; the main file's title block reads it and is read-only |
| Classes | `\nobalance`, `\suppressfloats`, `\appendixpage` | **hidden**; `\appendixpage` draws no heading |
| Text | `\qed` before `\end{proof}` and elsewhere (math.CO, 31) | **fixed**, no doubled mark |
| Lists | enumitem `enumerate*`/`itemize*`/`description*`, paralist `inparaenum` (cs.GT) | **fixed**: inline lists; the `\begin` line still breaks the line |
| Text | `\index{$…$}` drawn with raw dollars (math.DG) | **fixed** |
| Text | `\smash`, `savenotes`, `\large{…}`, `\tnote` in captions, `\bibliographystyle` in a size group, `\end{samepage}` split across build pieces | **fixed** |
| Text | `{\color{black} …}` over 300 lines (math.NA) | **partly**: the switch is hidden, the group is not coloured |
| Tables | sgame `game{2}{2}[Row][Col]` (cs.GT 2611.05706) | **partly**: a read-only table, labels above and in the corner |
| Round 5 leftovers | `\renewcommand{\paragraph}{\para}` (cs.CC 2611.07413), two-line `\texorpdfstring` | **fixed** |

## Regressions found after merging, and fixed

All six came from the new guard that rejects an expansion still holding TeX internals:
`\ExecuteOptions` defaults (`\if@twoside`), a box around a `\dimexpr`-wide minipage, `\algdef`/`\algblockdefx` blocks,
cvpr's `\eg` (four older tests), and in the re-audit a paper-defined `\cref` shim (cs.AI 2611.13960, 16 uses) and
`\ding{\numexpr171+#1\relax}` (cs.DB 2610.38404). The guard now skips known idioms, falls back to the editor's own
drawing for commands it draws natively, and evaluates written-out `\numexpr` sums.

## Open

- No clean full parallel run of the Visual set (see Tests); the suspected cause, parser time budgets under load, is
  still unconfirmed.
- Worktrees start from `main`, not from the round branch: every agent had to move its worktree first.
- arXiv's listing API returned nothing for 13 categories on the first fetch, without an error; fetched again.
- `\ce` without the mhchem package; `\SetFuncSty`; thm-restate across files; `{\color…}` over many paragraphs;
  rotated `game` labels; "Lemma 1 ()." for an empty note; `\appendixpage` heading; round-5 items (`\zcref` names,
  `$…\)`, `\dlt{…}`, jmlr `\ifmlhdemo`).
