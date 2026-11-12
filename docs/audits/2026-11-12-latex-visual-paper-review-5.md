# LaTeX Visual mode: review against 20 more papers (round 5)

Branch `fix/latex-visual-audit-5`. 12 November 2026. Earlier rounds: `2026-11-10-latex-visual-paper-review.md`,
`-review-2.md`, `2026-11-11-latex-visual-paper-review-3.md`, `-review-4.md`. Recipe:
`.claude/skills/latex-visual-audit/SKILL.md`.

## What was done

20 recent arXiv papers centred on math, CS, ML and econ (ids in `.claude/skills/latex-visual-audit/audited-papers.md`;
cs.SE 2611.11216 was PDF-only and econ.GN 2610.39844 too small, both skipped for the next submission), every `.tex`
file opened headlessly as the editor opens it. Four Sonnet agents fixed one area each in separate worktrees; their
branches were merged by hand (conflicts in `math-render.ts`, `walk.ts`, `widgets.ts`: same change twice, or both sides
kept). A fifth agent reconciled the older tests with the new folding of body definitions.

Every new widget has a path back to its source and a test for it (`BiographyHeaderWidget`, `LiteralTextWidget`, the
box header now reveals on click); hidden commands show their source at the caret. The sweep of `widgets.ts` found no
widget without a path (older widgets without their own handler use the shared `mousedown` in `plugins.ts`).

## Numbers (left / math / junk, summed per paper)

| Paper | Before | After |
|---|---|---|
| cs.PL 2610.37006 | 271 / 83 / 0 | 4 / 0 / 0 (4 TikZ pictures, one unit each) |
| cs.CC 2611.07413 | 254 / 8 / 0 | 16 / 6 / 0 |
| math.NT 2611.11566 | 221 / 15 / 0 | 1 / 0 / 0 |
| cs.GT 2611.05777 | 199 / 56 / 0 | 1 / 0 / 0 |
| cs.AI 2611.13971 | 34 / 0 / 0 | 0 / 0 / 0 |
| cs.LG 2611.14059 | 33 / 0 / 0 | 3 / 0 / 0 |
| math.DG 2611.11400 | 27 / 0 / 20 | 1 / 0 / 0 |
| math.NA 2611.11466 | 22 / 0 / 0 | 0 / 0 / 0 |
| q-fin.MF 2610.16732 | 22 / 10 / 0 | 0 / 0 / 0 |
| cs.CR 2611.11859 | 20 / 6 / 2 | 2 / 0 / 0 (both are the file's last line under the audit's caret) |
| math.OC 2611.12757 | 18 / 1 / 0 | 9 / 1 / 0 |
| econ.TH 2611.01431 | 11 / 0 / 0 | 0 / 0 / 0 |
| stat.ML 2611.11460 | 8 / 0 / 0 | 0 / 0 / 0 |
| cs.CV 2611.13868 | 7 / 0 / 0 | 0 / 0 / 0 |
| cs.SE 2611.12982 | 4 / 0 / 0 | 0 / 0 / 0 |
| math.AP 2611.12463 | 1 / 0 / 7 | 0 / 0 / 0 |
| math.ST 2611.09087 | 1 / 0 / 0 | 0 / 0 / 0 |
| cs.DB, econ.EM, econ.GN | 0 / 0 / 0 | 0 / 0 / 0 |
| **Total** | **1153 / 179 / 29** | **37 / 7 / 0** |

Tests: each agent's new file passes alone (`latex-visual-audit5-{math,class,refs,env}.test.ts`, 47 tests). The whole
Visual set (545 tests) was run after the merges: 8 failures, 6 of them fixed or re-asserted (below). The last full run
still had 2–3 failures that pass when their file runs alone and differ from run to run: the tcolorbox counter test in
`audit5-env`, one in `latex-visual-perf`, one in `latex-visual-math-coverage`. **No clean full run was obtained.** See
"Open". `tsc --noEmit` and eslint on the changed files are clean. Not checked in a running dev server.

## Issues by area

| Area | Issue (paper) | Result |
|---|---|---|
| Macros | `\def\+Bound{…}`: literal text after the name read as a delimited parameter, so 20 formulas failed to expand (cs.PL) | **fixed**: literal prefix in `definitions.ts`/`expand.ts` |
| Math | `\mbox{\sc Files}`, `\mbox{\em ``a''}` in math (cs.PL) | **fixed**: `\textsc`, `\it` |
| Math | `\DeclareMathSymbol{\Sha}{\mathalpha}{cyrletters}{"58}` (math.NT) | **fixed**: Ш, only for that declaration; an undeclared `\Sha` stays source |
| Math | `\hyperref[..]{x}` in a formula (math.NT), `\zcsetup{…}` after `\begin{equation}` (cs.CC), `\footnotemark` in `cases` (cs.CR, was junk) | **fixed** |
| Math | `\mathrel{\mathpalette\rgetscmd\relax}` with an `\ooalign` (cs.CR) | **fixed**, as an approximation (← with a small raised R); other `\mathpalette` uses stay source |
| Macros/project | Definitions from a file `\input` in the body were never read (q-fin.MF) | **fixed** in the editor (`collectMacroSources` `ownBody`, `latex-workspace.tsx` key) and in the audit |
| Math | Formulas inside `\dlt{…}` (ulem `\markoverwith…\ULon`) (cs.CC) | **left**: the command is not rendered |
| Math | `$…\)` mixed delimiters (math.OC) | **left**: needs a grammar change |
| Classes | Elsevier CAS (`cas-dc`/`cas-sc`): `\title [mode = title]`, `\author[1]`, `\ead`, `\cormark`, `\affiliation[1]{organization=…}`, `\cortext`, `\sep` (cs.AI) | **fixed** |
| Classes | LMCS: `\author[short]{Name\lmcsorcid{…}}[a]`, `\address`, `\email` (cs.PL) | **fixed** |
| Classes | LNCS: a `\let` before `\maketitle` ended the title run (cs.CC) | **fixed** |
| Classes | IEEEojcsys: `\affilmark`, `\affil`, `\authornote` (math.OC) | **fixed** |
| Classes | siamart: predefined theorem/lemma/corollary/proposition/definition, `\newsiamthm`, `\newsiamremark`, `AMS` (math.NA) | **fixed** |
| Classes | `IEEEbiography`/`IEEEbiographynophoto`, empty `\section*{}` (cs.CV) | **fixed** (new header widget, click-to-source tested) |
| Classes | INFORMS `APPENDICES` (econ.TH) | **fixed**: lettered like `appendices` |
| Classes | jmlr `\ifmlhdemo\else…\fi` (cs.LG) | **partly**: title and abstract render; the switch stays source (its value is set inside the class) |
| Lists | `label=\textup{(\roman*)}` drawn as raw `\textup{(i)}` (math.DG, 20 junk) | **fixed** |
| Refs | `\tag{\textbf{i}}` shown raw by `\ref` (math.AP, 7 junk) | **fixed** |
| Cites | `\cite[n\textsuperscript{o} 10]{…}` (cs.CR, junk) | **fixed**; unknown commands no longer leak their name |
| Refs | jmlr `\tableref`/`\sectionref`/`\appendixref`/`\figureref` (cs.LG), `\prettyref` with `\newrefformat` (econ.TH), `\Cpageref`, `\label[Type]{key}` (cs.CC, cs.GT), `\lq`/`\rq`, `\printbibliography % …` | **fixed** |
| Refs | `\zcsetup` in text, `\crefalias`, `\numberwithin{table}{section}` | **hidden** (source at the caret); `\numberwithin` does not change numbering |
| Refs | `\zcref` type names (cs.CC) | **left**: prints the number only |
| Bibliography | `\href {url} {\path{doi}}`, `\href{url}⏎{\emph{…}}` (cs.CC, math.DG; 50 uses) | **fixed** |
| Theorems | `reptheorem` wrapper with `\def\reptheoremlabel{#1}` and a `\Cref` heading (cs.GT) | **fixed** |
| Theorems | `\pathconcentrationlemma*` restated from another file (cs.GT) | **partly**: a labelled chip; the lemma itself needs cross-file data |
| Definitions | A definition in the body (`\newcommand`, `\def`, `\let`, `\newenvironment`, `\newif`, `\newcolumntype`, `\pgfkeys`, `\pgfmathsetlengthmacro`, …) stayed on screen as raw source, with its tikzpicture or tabular counted (cs.GT `ps.tex` 110/56, cs.CC) | **fixed**: one folded unit, source at the caret; `\def\@title`/`\@author`/`\@date` are exempt so hand-made title blocks keep working |
| Boxes | `\newtcolorbox` uses with multi-line options and a title; box definitions in preamble/sty not seen from chapters; `auto counter`, `number within`, `label={…}` (cs.CC, stat.ML `hypbox`) | **fixed** |
| Environments | `sloppypar`, `samepage`, `hangparas` | **fixed**: transparent |
| Algorithms | `\floatname{algorithm}{Construction}`, `\algtext*{EndIf}` (cs.GT) | **hidden only**: the caption is not renamed, the end line not suppressed |
| Layout | `\fontsize…\selectfont`, `\itemsep1pt`, `\predisplaypenalty=0\relax`, `\pagenumbering`, `\break`, `\detokenize{…}`, `{\hypersetup{…}\tableofcontents}`, `{\setlength{\tabcolsep}{…}\input{…}}`, `\ifdraft{…}{}` | **fixed** |
| Audit harness | A 200 KB+ file audited after another paper came out as "nothing drawn" (cs.CC, math.DG, math.NT): the Visual build gives the parser 400 ms. Present before this round. | **fixed** in `latex-visual-audit.ts`: the tree is finished before the build |

## Older assertions changed

Body definitions are now folded, so four round-4 assertions that expected them as source were re-asserted with the same
intent (not drawn; source at the caret): `audit4-tables` (plain `\newcommand`), `latex-visual-floats` (`\renewcommand`
in the body), `latex-visual-math` (`\algnewcommand{\Note}`), `latex-visual` (notation table), and `audit4-macros`
(`\let\foo\bar`).

## Open

- **Tests that fail only in the full parallel run** (pass alone): the tcolorbox counter test (`audit5-env`, later boxes
  read "Box : …"), `latex-visual-perf` ("redraws … after that piece"), `latex-visual-math-coverage` ("a formula with a
  user macro stays editable"). Likely the same time budgets that hit the audit harness; not confirmed.
- cs.CC: `\paragraph{…}` left 7× (line 2255 on), `\subsection{\texorpdfstring{Proof of $…$}…}` over two lines, `\dlt{…}`.
- math.OC: `$…\)`, one `\cite[…]` whose key is on the next line (line 1765).
- `\zcref` type names; restated lemmas across files; `\floatname`/`\algtext*` effects; `\numberwithin` for floats;
  the jmlr `\ifmlhdemo` switch; `\qedsymbol` in text (math.NT 2216); `\end{samepage}` (math.DG 541).
