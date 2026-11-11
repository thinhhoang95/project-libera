# LaTeX Visual mode: review against 12 more papers (round 4)

Branch `fix/latex-visual-audit-4`. November 2026. Earlier rounds: `2026-11-10-latex-visual-paper-review.md`, `-review-2.md`,
`2026-11-11-latex-visual-paper-review-3.md`. Recipe: `.claude/skills/latex-visual-audit/SKILL.md`.

## What was done

12 recent arXiv papers (ids in `.claude/skills/latex-visual-audit/audited-papers.md`; a 13th, stat.ME 2611.11274, was
PDF-only and skipped), every `.tex` file opened headlessly as the editor opens it. Five Sonnet agents fixed one area
each in separate worktrees; their branches were merged by hand (two conflicts, both in `walk.ts`/`structural.ts`, kept
both sides). The session was interrupted once mid-round; the four unfinished agents were resumed from their worktrees.

**Standing requirement for this round:** no widget may be render-only. Every new or changed widget has a path back to
its source (mousedown/click reveal, Alt-click and double-click unchanged) and a test; every command that was *hidden*
reveals its source when the cursor enters it. Details per area below.

## Numbers (left / math / junk, summed per paper)

| Paper | Before | After |
|---|---|---|
| quant-ph 2611.13347 | 1308 / 688 / 7 | 5 / 0 / 0 |
| math.CO 2611.13390 | 696 / 289 / 8 | 24 / 20 / 0 |
| cs.DS 2611.10440 | 479 / 0 / 0 | 1 / 0 / 0 |
| stat.ME 2611.11188 | 169 / 0 / 0 | 8 / 0 / 0 |
| cs.CL 2611.13560 | 76 / 0 / 0 | 3 / 0 / 0 |
| cs.LO 2611.01825 | 69 / 0 / 0 | 0 / 0 / 0 |
| math.PR 2611.11388 | 23 / 0 / 0 | 0 / 0 / 0 |
| cond-mat.str-el 2611.09434 | 4 / 0 / 1 | 0 / 0 / 0 |
| astro-ph.GA, hep-th, math.AG, q-bio.NC | 0 / 0 / 0 | 0 / 0 / 0 (hep-th front matter fixed, see below) |

Merged state: all `latex-visual*.test.ts` pass (480 tests), `tsc --noEmit` and eslint on the changed files are clean.
Not checked in a running dev server: everything here was verified through jsdom tests and the headless audit.

## Issues by area

| Area | Issue (paper) | Result |
|---|---|---|
| Project/macros | **The audit harness, not the app**, treated each `subfiles` chapter as its own main file, so `\bL`, `\bbF`, `\P`… were undefined (quant-ph). The app already resolves a subfile to its root and reads `stylesheet.sty` | **fixed** in `latex-visual-audit.ts` (uses `subfilesRootPath`); quant-ph 1308 → 5 |
| Macros | `\def\set#1:#2{…}` (delimited parameters) did not expand (math.CO) | **fixed**: `{type:"u", delimiter}` argument spec, TeX brace/space rules, a missing delimiter leaves the use as source |
| Math/KaTeX | `\accentset`, `\underaccent`, `\lineskiplimit`, `\raisebox[h][d]` inside macro bodies broke KaTeX (math.CO) | **fixed**: mapped to `\overset`/`\underset`, dropped where layout-only (the 0.65 `\scalebox` is drawn at full size) |
| Numbering | `\let\c@lemmaL\c@theorem` (shared counters) shown as source (math.PR) | **fixed**: counter aliases in `numbering.ts`; the line folds, source at cursor |
| Math | `eqnarray` row `&\to&P` became `\toP`, widget showed KaTeX mixed with raw source (**drawn wrong**, cond-mat) | **fixed**: second `&` becomes a space; rows split brace/environment/comment-aware |
| Math | undefined macro in an `align` row drew a widget with raw `&…` text (**drawn wrong**, quant-ph) | **fixed**: per-cell fallback, only the rejected cell shows as source |
| Structure | `\end{widetext}` left as source when a build piece cut the environment (cond-mat) | **fixed**: `widetext`, `subequations`, spacing/landscape/tabbing/keywords environments added to `RENDERED_ENVIRONMENTS` |
| Lists | enumitem `label=$(\square_{\arabic*})$` and `\item[$(\star)$]` printed raw `$…$` (**drawn wrong**, math.CO); old code also turned `\star` into `$(\st1r)$` | **fixed**: enumitem-correct labels, drawn only when every `$…$` piece renders |
| Refs | `\cref` chip to a math-labelled item showed raw `$…$` inside a minipage | **fixed** (`render-fragment.ts`) |
| Bibliography | pasted natbib `.bbl`: `\providecommand`/`\ifx\csname urlstyle` boilerplate, `\penalty0`, `\doi{}` as source (stat.ME 136+33, cs.LO 69) | **fixed**: boilerplate folds, layout hints hidden, `\doi{x}` draws `doi: x` (Ctrl-click opens doi.org), BibTeX `{G}aussian` braces hidden |
| Text | `\looseness=-1`, `\urlstyle{same}` (cs.CL) | **fixed** (hidden, source at cursor) |
| Text | `\input`/`\include` were plain source | **fixed**: "include: path" chip when the file exists or the project is unknown (see open items) |
| Front matter | `\keywords{… \and …}` with `arxiv.sty` (cs.LO) | **fixed** when `\usepackage{arxiv}` is loaded |
| Tables | `longtable` with `\Mach`/`\Alt`/`\tms` cells fell back to source: whole-table macro expansion reached ~25 KB, past the 20 000-char limit (cs.DS 455) | **fixed**: only row-writing macros expand table-wide, cell macros expand per cell, chunked expansion with line-level retry; paragraph-shape assignments (`\hangindent`…) are stripped from cells |
| Tables | `\medmuskip=3mu\relax`, `\relpenalty=…`, `\renewcommand{\arraystretch}` lines (cs.DS) | **fixed**: fold as layout lines |
| Tables | row-helper `\newcommand{\ntrow}[3]{#1 & #2 & #3\\}` stayed source (math.PR) | **fixed**: definitions whose body writes `&`/`\\`/rules fold; other `\newcommand`s stay source |
| Class | MLSys (`\mlsystitle`, `\mlsysauthor`, `mlsysauthorlist`, `\twocolumn[{…}]`) all source (cs.CL) | **fixed**: runs through the ICML title machinery; any other `\twocolumn[…]` is a transparent wrapper |
| Class | revtex `\acknowledgments` (cond-mat) | **fixed**: Acknowledgments heading |
| Class | `jheppub`: only the last author showed, no affiliations or `\abstract{}` (hep-th, invisible to `left`) | **fixed** |

## Click-to-source review (the standing requirement)

- **`IncludeChipWidget`** (new): inherits the `TextWidget` mousedown reveal; tests click it for `\input` and `\include` and check the caret lands inside the command. No Ctrl-click/double-click "open file" hook exists in the visual layer, so none was added.
- **`ItemMarkerWidget`** (existing): had no handler; it now reveals the `\item` source on mousedown (`reveal: "strict"` for `\item` and `\bibitem` markers), tested on `label=$(\star)$` and `\item[$(\dagger)$]`. Note: clicking the marker reveals the `\item`, not the `label=` option in the `\begin{enumerate}[…]` line.
- **`\doi`** reuses `LinkTextWidget` (click reveals source; Ctrl-click opens the URL).
- **Title/author blocks** (MLSys, jheppub, ICML): reuse `TitleWidget`; tests click a name, the title and the abstract (editors open and rewrite the source) and the source button.
- **Tables:** a mousedown on a cell of a drawn longtable reveals the table source (tested). Longtables remain read-only otherwise (no per-cell editing).
- **Hidden commands** (`\penalty`, `\looseness`, `\urlstyle`, bst boilerplate, protective braces, `\medmuskip` lines, row-helper `\newcommand`s, `\let\c@…`, `\twocolumn[{`/`}]`, `\acknowledgments`, `\end{widetext}`): each reveals its source when the cursor enters it. The class agent proves this by moving the cursor onto the fold rather than dispatching a mousedown; the text agent asserts the reveal for `\penalty0` only, so `\allowbreak`, `\nobreak` and `\relax` reveal is shared code but not separately asserted.

## Open

- **math.CO 2611.13390:** 4 formulas from a TeX `\loop`/`\csname` macro factory (`\cV`); 5 `\renewcommand{\qedsymbol}` sharing a line with `\begin{proof}[…]` (hiding them inline made the source unreachable by cursor, reverted); `varwidth`; `\hfill {\huge $\lrcorner$}`; author block shows `fnsymbol1` junk from `\newcommand\thankssymb[1]{\textsuperscript{\@fnsymbol{#1}}}` (`\@fnsymbol` read as `\@` + text). The last one draws something wrong and is the next thing to fix.
- **stat.ME 2611.11188 supplement:** hand-rolled title block (`\def\@title`, `\arxivmaketitle` bound via `\let` in the main preamble): 8 lines stay source.
- **`\subfile{…}`** in quant-ph `main.tex` stays source (5 left); the new include chip could cover it.
- **`\input` chip** also appears whenever the project's file list is unknown (a document opened alone); `\IfFileExists{a}{\input{a}}{}` stays source on purpose.
- **Longtables** are read-only (click reveals the whole table); a row macro that fails to expand shows as source in the cell it lands in.
- cs.CL `figures/fig_teaser_body.tex`: one `\begin{tikzpicture}` line as before.

## Process notes

- The biggest "fix" (quant-ph, ~1300 `left`) was a bug in the audit script, not the editor; check how the audit picks its main file before trusting counts from multi-file projects.
- The junk counter flags any `cm-vis-math-source` text containing a backslash, so per-cell align fallback can raise `junk` for a file (quant-ph `sections/3.tex` 4 → 5 mid-round) while showing less raw `&` text; it ended at 0 after the macro fix.
- Merge fallout fixed on the round branch: `latex-visual-floats.test.ts` expected `\twocolumn[Kept text]` to stay source; it is now the transparent wrapper (`Kept text`).
