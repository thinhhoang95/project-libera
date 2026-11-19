# LaTeX Visual mode: review against 50 more papers (round 10)

Branch `fix/latex-visual-audit-10`, cut from `main` (23b8925). 19 November 2026. Earlier rounds: `2026-11-10-…-review.md`
to `2026-11-18-…-review-9.md`. Recipe: `.claude/skills/latex-visual-audit/SKILL.md`.

## What was done

50 papers were asked for and 50 were audited, one per category. The categories were the 14 that came back empty in
round 9 (nucl-ex, physics.atom-ph, physics.bio-ph, physics.soc-ph, physics.geo-ph, cond-mat.supr-con, nlin.CD, math.AT,
math.AC, math.SG, cs.CG, cs.FL, q-fin.ST, q-bio.QM) and 36 that no round had covered: astro-ph.IM, cond-mat.dis-nn,
cond-mat.quant-gas, cond-mat.other, nine more physics categories (ins-det, acc-ph, ao-ph, app-ph, class-ph, data-an,
space-ph, med-ph, hist-ph), nlin.AO/PS/SI, math.KT/SP/GN/HO, ten CS categories (NE, MA, SC, SI, SD, DM, IR, GR, AR, MS),
eess.AS/IV, q-bio.BM/GN and q-fin.CP/PR. arXiv's listing API answered this time; no category needed the fallback. The
ids are in `audited-papers.md`. 217 `.tex` files were opened headlessly as the editor opens them.

25 of the 50 papers had nothing left as source before any fix. Four Sonnet agents fixed one area each in separate
worktrees, three at a time:
- macro definitions and expansion;
- formulas (KaTeX), siunitx and tikz-cd;
- front matter, bibliographies and citations;
- text commands, inert environments and settings, labels.

Their branches were merged by hand in `.claude/worktrees/latex-visual-audit-10`, without textual conflicts.

## Editing: every widget opens its source

- **No new widget class this round.** New drawings go through widgets that already reveal their source on a click:
  `PrintedTextWidget` (the `\orcidlink` iD mark in text), `SymbolWidget` (`\bysame`), `EnvironmentHeaderWidget` (IOP's
  `\ack`, `\funding`, `\data`; environments made by a `\def`), the title widget (CERN, AGU, IOP, openjournal and authblk
  title blocks), `MathWidget` (formulas). Folded lines (`subappendices`, `\fancypagestyle`, float placement settings, a
  one-line `center`'s markers) show their source when the caret enters them.
- **Click tests.** Each new kind has a click-to-source test (plain click, Alt-click for formulas and title blocks) or a
  caret-reveal test for folded lines, in `latex-visual-audit10-*.test.ts`.
- **Junk removed, not hidden.** `\label{LISTING\thelstlisting}` used to be drawn as a chip showing the raw command. A
  label whose key holds a command stays source now.
- **`noedit=` is 0** in all 217 files, before and after.

## Numbers (left / math / junk / noedit, summed per paper)

| Paper | Before | After |
|---|---|---|
| nlin.SI 2610.32149 | 2312 / 882 / 0 / 0 | 0 / 0 / 0 / 0 (one `\def` had blanked the whole document) |
| nucl-ex 2611.08473 (ALICE) | 959 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| physics.med-ph 2611.05340 | 318 / 14 / 0 / 0 | 0 / 0 / 0 / 0 |
| math.GN 2610.31059 | 126 / 54 / 0 / 0 | 1 / 0 / 0 / 0 (a TikZ picture, by design) |
| math.SP 2611.09610 | 75 / 2 / 0 / 0 | 53 / 2 / 0 / 0 (two tikz-cd diagrams with vertical hook arrows, see Open) |
| cs.CG 2611.00364 | 45 / 0 / 0 / 0 | 45 / 0 / 0 / 0 (45 TikZ figure files, by design) |
| math.AC 2611.10064 | 24 / 24 / 0 / 0 | 0 / 0 / 0 / 0 |
| cond-mat.dis-nn 2611.14200 | 27 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| cs.AR 2611.19101 | 27 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| cs.DM 2611.13813 | 26 / 1 / 0 / 0 | 0 / 0 / 0 / 0 |
| physics.space-ph 2610.30517 | 20 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| nlin.CD 2610.35979 | 14 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| cs.NE 2611.08483 | 13 / 0 / 0 / 0 | 13 / 0 / 0 / 0 (TikZ figure files, by design) |
| math.AT 2611.11463 | 10 / 1 / 0 / 0 | 6 / 1 / 0 / 0 (a tikz-cd triangle with a dashed diagonal, see Open) |
| physics.hist-ph 2609.14600 | 10 / 0 / 6 / 0 | 12 / 0 / 0 / 0 (six `\label{LISTING\thelstlisting}`, now source instead of junk) |
| physics.ins-det 2611.12369 | 8 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| physics.soc-ph 2611.10574 | 8 / 0 / 0 / 0 | 2 / 0 / 0 / 0 (`\footnote` with its argument on the next line, see Open) |
| math.HO 2610.08565 | 7 / 0 / 0 / 0 | 7 / 0 / 0 / 0 (TikZ figure files, by design) |
| math.KT 2610.27016 | 5 / 1 / 0 / 0 | 0 / 0 / 0 / 0 |
| nlin.PS 2610.37990 | 4 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| astro-ph.IM 2611.19899, cs.SI 2611.09126, nlin.AO 2610.25113 | 3 / 0 / 0 / 0 each | 0 / 0 / 0 / 0 |
| q-bio.BM 2610.24806 | 2 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| physics.atom-ph 2611.07764 | 1 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| 25 papers | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| **Total** | **4050 / 979 / 6 / 0** | **139 / 3 / 0 / 0** |

Of the 139 left, 66 are TikZ pictures kept as one unit by design. Only physics.hist-ph's count rose (10 → 12): its 6
junk labels became source (2 commands each) and its 10 `subappendices` commands are drawn.

**Build time.** The merged audit ran while another session ran the collab test suite (load average 12 to 18), and
every file took about 4.5 times as long as in the baseline, papers no fix touched included. Timed back to back on
`main` and on the round branch under the same load, the untouched papers take the same time (q-fin.PR 2607.17502:
7.3 / 6.7 s on main, 6.7 / 6.3 s on the branch; cs.DM 2611.13813: 3.9 / 4.0 s on both). physics.med-ph's files build
faster than on main (1.7 s against 2.1 s in all), since its 4300 data macros resolve instead of failing. nlin.SI's
file takes 1.4 s where main took 0.36 s, because main drew none of it.

## Issues by area

| Area | Issue (paper) | Result |
|---|---|---|
| Macros | `\def\equationautorefname~#1\null{(#1)\null}` in the preamble blanked the whole document (nlin.SI 32149: 2312 commands, 882 formulas, 0 numbered) | **fixed**: the parser's preamble patch rewrote only `\def` parameter text that starts with `#`; with a delimiter before `#1` the grammar swallowed the rest of the file as the body. The patch now covers it |
| Macros | Data macros: `\expandafter\def\csname mpb@key\endcsname{93.1}` (4300 in a generated file), used through `\newcommand{\mpb}[1]{\@ifundefined{mpb@#1}{…}{\csname mpb@#1\endcsname}}` (med-ph 05340: 318, 14 formulas) | **fixed**: `\csname` definitions and `\@namedef` are read into `defs.dataMacros`, kept apart from the macros; `\csname … \endcsname` and `\@ifundefined` expand. An undefined name takes the "undefined" branch only in a family the document defines data for (`mpb@`) |
| Macros | `\underbrace` redefined as a TikZ brace (math.SP 09610) | **fixed**: a definition of a natively drawn command whose body is TikZ or pgf is dropped; the built-in is drawn |
| Macros | The project's own `orcidlink.sty` (a TikZ picture) shadowed `\orcidlink` (nucl-ex 08473's author list: 950) | **fixed**: the project's copy is not read; in text the iD mark is drawn (a click shows the command) |
| Macros | `\twoheaduparrow` / `\twoheaddownarrow` built with `\mathpalette` and `\rotatebox` (math.GN 31059: 32 formulas and more) | **fixed**: drawn as stix's ↟ / ↡ (a two-entry table of names whose glyph is certain) |
| Macros | `\begin{PRoof} … \end{PRoof}` where only `\def\PRoof{\par\noindent{\textbf{Proof of Claim 1}~}}` exists (cs.DM 13813) | **fixed**: drawn with the macro's text as the header, the `\end` hidden. The same paper's `\def\[{\left[}` made the grammar read `\[…\]` as display math and break the `eqnarray*` around it; with `\[` redefined in the preamble, the parser now reads it as a thin space |
| Math | `\o` in a formula (math.AC 10064: 24) | **fixed**: ø (Ø for `\O`), as LaTeX prints it; a document's own `\o` wins |
| Math | extarrows' `\xlongrightarrow{j^*}` (math.KT 27016) | **fixed**: KaTeX's `\xrightarrow` family |
| Math | `\qty{0.11}{}`, an empty unit (cs.AR 19101: 24) | **fixed**: the number alone |
| Diagrams | tikz-cd's older `\arrow[hook]{r}{label}` form and `{}` cells (math.SP 09610) | **partly**: read now, but those two diagrams also have vertical `hook` arrows (no KaTeX glyph) and hooked/dashed diagonals, so they stay source |
| Diagrams | A dashed diagonal (`\arrow[ur,dashed]`, math.AT 11463) | **left**: plain diagonals between adjacent cells were already drawn as `\nearrow` etc.; styled ones need an SVG overlay |
| Diagrams | `\Span` in an `eqnarray*` with a `\[…\]` inside it (cs.DM 13813) | **not a bug**: a LaTeX error in the paper; the parser fix above made it draw anyway |
| Front matter | CERN's `cernphprep`: `titlepage`, `\PHyear`, `\PHnumber`, `\PHdate`, `\Collaboration{…\thanks{…}}`, `\ShortTitle`, `\ShortAuthor` (nucl-ex 08473) | **fixed**: a title block with "CERN-EP-2026-296" and the date as the class prints them; running heads hidden; `titlepage` transparent |
| Front matter | AGU `agujournal2019`: `\authors`, `\affiliation{1}{…}`, `\correspondingauthor{name}{email}`, `keypoints` (space-ph 30517: 20) | **fixed** |
| Front matter | IOP `iopjournal`: `\author{…\orcid{…}}`, `\affil`, `\email`; back matter `\ack`, `\funding`, `\data` (ins-det 12369) | **fixed**: title block; headed paragraphs "Acknowledgments", "Funding", "Data availability statement" |
| Front matter | openjournal: a `\title` with `\vspace` in it, authors and affiliations in `\input{authors}` (astro-ph.IM 19899) | **fixed**; the structural build now redraws when an `\input` holding `\title` or `\author` arrives or changes |
| Front matter | authblk `\author[a]` / `\affil[a]`, `\markboth`, `\openup 0.8\jot` (cs.DM 13813) | **fixed** |
| Front matter | cas `\corref{cor}` (cs.SI 09126); `\twocolumn[%` title block with `\input{abstract}` in a `{\small …}` group (nlin.AO 25113) | **fixed** |
| Bibliography | `\bibliography{x}% comment` stayed source (atom-ph 07764, space-ph 30517) | **fixed** |
| Bibliography | REVTeX bbl: `\ifmmode~\acute{c}\else \'{c}\fi{}` in entries and labels, `SM()` labels with no year, `\href@noop`, `\BibitemShut` after a note with `\cite`, `onecolumngrid` as an environment (dis-nn 14200, nlin.CD 35979) | **fixed**: the `\else` branch (ć); chips no longer show "Ponte\et al." |
| Bibliography | amsart's `\bysame` (math.AT 11463) | **fixed**: ——— |
| Text | `\label{LISTING\thelstlisting}` drawn as junk (hist-ph 14600: 6) | **partly**: stays source; the counter's value at that point is not known reliably |
| Text | appendix package's `subappendices` in a book's chapters (hist-ph 14600) | **fixed**: lines fold away; sections inside number 1.A, 1.B (`\thechapter.\Alph{section}`, as appendix.sty sets it for chapter classes) and are restored after |
| Text | REVTeX `\NoCaseChange{(ii)}` in headings (soc-ph 10574); `\seqsplit{…}` (q-bio.BM 24806) | **fixed** |
| Text | `\makeatletter\renewcommand{\fps@table}{!htbp}…\makeatother` on a body line; `\begin{center}{\large\bfseries …}\end{center}` on one line (nlin.PS 37990) | **fixed**; the one-line `center` was open since round 7 (physics.flu-dyn 2611.12193), whose test now checks it is drawn |
| Text | fancyhdr `\fancypagestyle{…}{…}`, `\fancyhf`, `\fancyfoot` in the body (cs.AR 19101) | **fixed**: folded away |
| Text | `\boldmath$\alpha$ and $\beta$\unboldmath` in an item (cs.SI 09126) | **partly**: switches hidden, the text between them bold, the pair ends at `\unboldmath` instead of the end of the list; the formulas are not drawn bold |
| Speed | ~20 ms per KB for some files (cs.DM 13813, q-fin.PR 07502, soc-ph 10574) | **no change**: a profile of cs.DM put the time in jsdom's parsing and insertion of KaTeX's HTML, not in our code |

## Fixed on the round branch

- **A debug test file** (`scripts/editor/zz-dbg.test.ts`) was committed by the front-matter agent; removed.
- **The `\[` parser patch ignored comments.** A template's commented `%\renewcommand{\[}{…}` would have stopped every
  `\[…\]` in the document from parsing as display math. The preamble is now checked without its comments (test added).
- **Round 7's one-line `center` test** asserted the old limitation; it now asserts the line is drawn and centred.

## Tests

- **Added:** 36 tests in `latex-visual-audit10-{macros,math,front,text}.test.ts` (10, 5, 15, 6), plus one assertion
  rewritten in `latex-visual-audit7-text.test.ts`.
- **Whole Visual set after the merges (760 tests):** 753 passed and 7 failed. One was the round 7 `center` test (fixed
  above, its file passes). The other six (`audit8-bib`'s REVTeX markers, two in `floats`, one each in
  `gaps-environments`, `gaps-macros` and `perf`) all pass when their files run alone. They lost the asynchronous
  numbering race under the parallel run, as in rounds 8 and 9. The load from the other session's collab tests probably
  explains why there were six this time against one in round 9.
- **Not rerun:** the whole set was run once, per the compute budget.
- **Not done:** the new tests were not run against the base commit to confirm they fail there (except the bracket
  comment test, whose first assertion fails with the patch as the agent left it).
- **Static checks:** `tsc --noEmit` is clean; eslint on every changed `.ts` file is clean.

## Not checked in the running app

No paper was opened in the app. The new title blocks (CERN, AGU, IOP, openjournal, authblk), the iD mark in an author
list and the one-line centred heading were checked only headlessly. Layout problems of the kind round 8 found in the
app (indents, overlaps) would not show there.

## Open

- tikz-cd: vertical `hook` arrows (math.SP 09610) and styled or far diagonals (math.AT 11463, and round 9's math.QA
  2611.13239) need a renderer of their own, e.g. an SVG overlay placed from the cell boxes.
- `\footnote` with its argument on the next line (`\footnote` + line end + `{…}`, soc-ph 10574): the grammar leaves the
  argument off. TeX reads one line end as a space; any command may be written this way.
- Formulas between `\boldmath` and `\unboldmath` are not drawn bold.
- A label written with a counter (`\label{LISTING\thelstlisting}`) stays source.
- siunitx's `\micro` draws `\text{µ}`, for which KaTeX logs "No character metrics" (it still renders).
- `\def\(` is handled by the walk only; the grammar still reads `\(…\)` as math.
- The `subappendices` numbering for article-like classes (where appendix.sty letters the subsections) is not done; only
  chapter classes number them.
