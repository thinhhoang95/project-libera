# LaTeX Visual mode: review against 23 more papers (round 9)

Branch `fix/latex-visual-audit-9`, cut from `main` (160f568). 18 November 2026. Earlier rounds: `2026-11-10-…-review.md`
to `2026-11-17-…-review-8.md`. Recipe: `.claude/skills/latex-visual-audit/SKILL.md`.

## What was done

50 papers were asked for; 23 were audited. arXiv's listing API (`export.arxiv.org/api/query`) hung all afternoon, so
the fetcher got a fallback that reads the category listing pages (see Audit tooling). With the first version of that
fallback, 12 of the 26 categories asked for returned papers, and the user chose to go on with those.

The papers are two each from astro-ph.CO, astro-ph.EP, astro-ph.HE, astro-ph.SR, hep-ex, physics.comp-ph, math.QA,
math.CV, cs.HC, cs.DC and eess.SP, and one from math.MG. None of these categories was in an earlier round. The ids are
in `audited-papers.md`. 127 `.tex` files were opened headlessly as the editor opens them.

Four Sonnet agents fixed one area each in separate worktrees, three at a time:
- macro discovery (a collaboration's style files and class);
- formulas (KaTeX), siunitx, AASTeX symbols, diagrams;
- front matter, bibliographies and citations;
- floats, tables and list labels.

Their branches were merged by hand, without conflicts.

## Editing: every widget opens its source

- **No new widget class this round.** Everything new draws through widgets that already reveal their source on a
  click: `MathWidget`, `SymbolWidget`, the title widget, the cite chip, the float and list-marker widgets.
- **Click tests.** Each newly rendered kind has a click-to-source test in `latex-visual-audit9-*.test.ts` (a plain
  click, or an Alt-click for formulas and floats, whose plain click does something else).
- **One junk source was removed, not hidden.** An `\item[label]` whose label has a command nothing knows used to be
  drawn as a marker with the raw LaTeX in it. It stays source now.
- **`noedit=` (drawn widgets that no click can open) is 0** in all 127 files, before and after.

## Numbers (left / math / junk / noedit, summed per paper)

| Paper | Before | After |
|---|---|---|
| hep-ex 2611.16454 (ATLAS) | 3201 / 72 / 1 / 0 | 5 / 2 / 0 / 0 (one formula, a slip in the paper: `\SI{35} (\SI{40}){\GeV}`) |
| astro-ph.HE 2611.21043 | 214 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| astro-ph.SR 2611.19628 | 157 / 2 / 0 / 0 | 0 / 0 / 0 / 0 |
| math.QA 2611.13129 | 119 / 26 / 0 / 0 | 0 / 0 / 0 / 0 |
| math.QA 2611.13239 | 59 / 2 / 0 / 0 | 26 / 1 / 0 / 0 (a tikz-cd triangle with diagonal arrows, see Open) |
| hep-ex 2611.16397 | 54 / 20 / 0 / 0 | 0 / 0 / 0 / 0 (47 / 18 of the "before" were an audit artifact, see Audit tooling) |
| astro-ph.EP 2611.16046 | 33 / 6 / 1 / 0 | 0 / 0 / 0 / 0 (the junk was an audit artifact too) |
| eess.SP 2611.19192 | 24 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| math.MG 2611.13338 | 12 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| math.CV 2611.13725 | 4 / 0 / 0 / 0 | 1 / 0 / 0 / 0 (a TikZ picture, kept as one unit by design) |
| astro-ph.EP 2611.16040, astro-ph.SR 2611.19134 | 4 / 2 / 0 / 0 | 0 / 0 / 0 / 0 |
| cs.HC 2611.21095 | 1 / 0 / 0 / 0 | 1 / 0 / 0 / 0 (a TikZ picture, by design) |
| 10 papers | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| **Total** | **3882 / 130 / 2 / 0** | **33 / 3 / 0 / 0** |

No file has a higher count after than before.

Build time: the ATLAS author list (236 KB, 2887 `\AtlasOrcid` uses) takes about 2.1 s to build where it took 1.8 s,
since every name is expanded now. Its main file takes about 0.7 s where it took 0.6 s. The other papers are unchanged
or faster.

## Issues by area

| Area | Issue (paper) | Result |
|---|---|---|
| Macros | The ATLAS style files are in the project but their macros came out empty: kvoptions booleans (`\DeclareBoolOption`, `\ProcessKeyvalOptions`) were never declared, so every `\ifbool{APHY@…}` was unknown and both branches counted as "maybe" (16454: `\tauhad`, `\GeV`, `\pT`, `\ttbar`… 314 commands, 72 formulas) | **fixed**: the booleans are read with their defaults and with the options the file was loaded with; a boolean whose load options are unknown stays unknown |
| Macros | babel's `\iflanguage{USenglish}{pileup}{pile-up}` (16454's `\pileup`) | **fixed**: decided from the class and babel options; undecided without a language |
| Macros | `\AtlasOrcid[id]{name}`, a `\NewDocumentCommand` in the project's class (16454 `atlas_authlist.tex`, 2887) | **fixed**: a project class's top-level, letters-only commands are read as macros (`classCommandSource`); the name draws with the existing iD mark |
| Macros | `\ifb` (inverse femtobarns), a macro named like a conditional: each `\ifb,` opened an unclosed `\if`, so a later `\let\clearpage…` counted as conditional and `\clearpage` showed as source (16454) | **fixed**: a command the document defines as a macro opens no conditional |
| Macros | `\AtlasCoordFootnote` (16454) | **left**: no file of the project defines it |
| Math | AASTeX's `\arcdeg`, `\arcmin`, `\arcsec` and the marks over the decimal point `\fdg`, `\farcm`, `\farcs`, `\fd`, `\fh`, `\fm`, `\fs`, `\fp`, in text and math (16046, 19134) | **fixed**, in any class, as `\sun` is; a user definition of the same name wins |
| Math | siunitx: a literal unit with a font command, `\SI{3.0}{GeV/\textit{c}^2}`; a unit that is the paper's own macro, `\SI{13.6}{\TeV}` with `\TeV` = `\ensuremath{\text{T\electronvolt}}\xspace` (16397, 16454) | **fixed** |
| Math | `{\mathchar'26\mkern-9mu d}`, plain TeX's barred d (13129, 15 formulas and 2 displays) | **fixed**: `h` is `\hbar`; another letter gets TeX's macron at its own height. **Changed on the round branch:** the agent drew a strike through the letter's bowl; five candidates were compared in a browser, and the one kept is indistinguishable from KaTeX's `\hbar` when given `h` |
| Math | lengths in `\baselineskip` (13338's `\hspace{.1\baselineskip} \rule{.5pt}{.5\baselineskip}`) | **fixed**: 1.2em per line, `\parindent` 1.5em; `\textwidth` and the like still stay source |
| Diagrams | tikz-cd label option `{sloped}` (13239) | **partly**: the square draws (label upright); the triangle with `ld`/`rd` arrows stays source |
| Front matter | AASTeX 7 authors in `\input{authorlist}`: the `\title` before it stayed source, and the author file on its own was all source (19628, 75) | **fixed**: the run survives an `\input`; a file with only the author declarations draws as the author block when the main file's class is AASTeX |
| Citations | `\citep[GLEs\footnote{\url{…} \label{…}}; e.g.,][]{…}` and `\citep[$R_\mathrm{s}$; see][for details]{…}` (19628, 81) | **fixed**: a footnote in a note draws its text in parentheses, `\url` its address, `\ref` its number; `R_\mathrm{s}` draws as Rₛ |
| Bibliography | REVTeX 4.2 entries with a `(1972{\natexlab{a}})` label, `\textendash` in an entry (21043, 18 of 140 entries) | **fixed**: the chips show 1972a; entries may use any symbol command the text renderer knows |
| Front matter | elsarticle `\nonumnote`, `\MSC[2020]` in the keywords, the bbl's `\urlprefix` (13725) | **fixed** |
| Front matter | AASTeX 7 `contribution` environment (16040) | **fixed**: drawn as `acknowledgments` is, headed "Author Contributions" |
| Floats | `\newenvironment{widefigure}{\begin{figure*}[!tp]\setkeys{Gin}{…}}{\end{figure*}}`, `widetable` (19192, 13 files) | **fixed**: an environment that opens a figure or table with only inert set-up, and closes it, draws and numbers as that float (`floatAlias`) |
| Floats | `\newcommand{\TableText}{\footnotesize}` on a line of its own (19192) | **fixed**: a zero-argument macro of size and alignment switches only is hidden as they are |
| Lists | `\item[Fraction of … \pT ($\pT^\mathrm{EM+track} / \pT$):]` drawn with raw LaTeX (16454) | **fixed**: an undrawable label stays source; a label with a defined zero-argument macro draws |

## Audit tooling

- **Fetch.** When the listing API gives nothing within 20 s, the fetcher reads `arxiv.org/list/<cat>/recent`, then
  the month's listing (`current`), then the newest papers with nothing skipped. The first version read only `recent`
  with `--skip 60`, which is empty for a small category (five days hold fewer than 60 papers); that is why 14
  categories came back empty in this round. The later version was checked on one category by hand, not by a full fetch.
- **Caret.** The audit puts the caret at the end of the file. In a file ending without a newline it touched the last
  construct, which then showed as source: hep-ex 2611.16397's TikZ macro file counted its last definition's body
  (47 commands, 18 formulas). The audited text now always ends with a newline.
- **Junk check.** The word "NaN" in a sentence ("a NaN or saturated pixel", astro-ph.EP 2611.16046) was flagged as
  junk. It is flagged only when it stands alone, as `undefined` is.

## Tests

- **Added:** 32 tests in `latex-visual-audit9-{macros,math,front,floats}.test.ts`.
- **Whole Visual set after the merges (724 tests):** 723 passed and 1 failed. The failure, round 5's tcolorbox counter
  test (`latex-visual-audit5-env.test.ts`), showed "Box : No options" without its number. Its file passes when run
  alone (twice, 15 of 15): the numbering arrives asynchronously and lost a race under the parallel run, as three
  other tests did in round 8.
- **Not rerun:** the whole set was run once, per the compute budget.
- **Not done:** the new tests were not run against the base commit to confirm they fail there.
- **Static checks:** `tsc --noEmit` is clean; eslint on every changed `.ts` file is clean after one unused test
  helper was removed.

## Not checked in the running app

Unlike rounds 7 and 8, no paper was opened in the app after the merge. The barred d was checked in a browser against
KaTeX's `\hbar`; nothing else was looked at as rendered. Layout problems of the kind round 8 found there (indents,
overlaps) would not show in the headless audit.

## Open

- The float editors (caption, table cells) on a user environment that wraps a float were not exercised, only select
  and reveal.
- A tikz-cd triangle with diagonal arrows (math.QA 2611.13239), as round 8's far diagonals: needs a renderer of its own.
- `\ifboolexpr` (atlasparticle.sty) is not decided; here it only guards a package that is not in the project.
- A footnote inside a cite note is drawn in parentheses in the chip, not as a numbered mark.
- The 14 categories that returned nothing (nucl-ex, physics.atom-ph, physics.bio-ph, physics.soc-ph, physics.geo-ph,
  cond-mat.supr-con, nlin.CD, math.AT, math.AC, math.SG, cs.CG, cs.FL, q-fin.ST, q-bio.QM) are still unaudited.
