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
| math.CO 2611.13390 | 696 / 289 / 8 | 0 / 0 / 0 |
| cs.DS 2611.10440 | 479 / 0 / 0 | 1 / 0 / 0 |
| stat.ME 2611.11188 | 169 / 0 / 0 | 0 / 0 / 0 |
| cs.CL 2611.13560 | 76 / 0 / 0 | 3 / 0 / 0 |
| cs.LO 2611.01825 | 69 / 0 / 0 | 0 / 0 / 0 |
| math.PR 2611.11388 | 23 / 0 / 0 | 0 / 0 / 0 |
| cond-mat.str-el 2611.09434 | 4 / 0 / 1 | 0 / 0 / 0 |
| astro-ph.GA, hep-th, math.AG, q-bio.NC | 0 / 0 / 0 | 0 / 0 / 0 (hep-th front matter fixed, see below) |

Merged state (after a follow-up pass, 4b, closed the open items listed in the first pass): all `latex-visual*.test.ts` and `latex-macros.test.ts` pass (537 tests; `latex-editor`, `-parser`, `-export` also pass), `tsc --noEmit` and eslint on the changed files are clean.
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
| Author block | `\thankssymb` → `\@fnsymbol{1}` printed `fnsymbol1` in the title block (**drawn wrong**, math.CO) | **fixed (4b)**: `\@fnsymbol{n}` for 1..9 expands to the footnote symbols; anything else stays source |
| Macros | `\cA…\cZ` made by a `\loop … \repeat` + `\csname` factory left 4 formulas as source (math.CO) | **fixed (4b)**: `readLoopDefinitions` reads the loop (≤64 passes, ≤256 macros; any other shape is skipped, never hangs) |
| Environments | `varwidth` (math.CO) | **fixed (4b)**: transparent wrapper |
| Text | `\hfill {\huge $\lrcorner$}` end-of-claim mark (math.CO) | **fixed (4b)**: drawn as a sized group, right-aligned when alone on its line |
| Proofs | `\renewcommand{\qedsymbol}{…}` on the `\begin{proof}[…]` line stayed source (math.CO) | **fixed (4b)**: hidden inside the proof header's own reveal (caret on that line shows it); the proof end now draws the local `\qedsymbol` |
| Front matter | hand-rolled `\def\@title/\@author/\@date` + `\arxivmaketitle` (stat.ME supplement) | **fixed (4b)**: drawn by `TitleWidget` when the defs are contiguous and the macro is `\let` to `\@maketitle`; title/author/date edit the `\def` arguments; ambiguous layouts stay source |
| Class | MLSys (`\mlsystitle`, `\mlsysauthor`, `mlsysauthorlist`, `\twocolumn[{…}]`) all source (cs.CL) | **fixed**: runs through the ICML title machinery; any other `\twocolumn[…]` is a transparent wrapper |
| Class | revtex `\acknowledgments` (cond-mat) | **fixed**: Acknowledgments heading |
| Class | `jheppub`: only the last author showed, no affiliations or `\abstract{}` (hep-th, invisible to `left`) | **fixed** |

## Click-to-source review (the standing requirement)

- **`IncludeChipWidget`** (new): inherits the `TextWidget` mousedown reveal; tests click it for `\input` and `\include` and check the caret lands inside the command. No Ctrl-click/double-click "open file" hook exists in the visual layer, so none was added.
- **`ItemMarkerWidget`** (existing): had no handler; it now reveals the `\item` source on mousedown (`reveal: "strict"` for `\item` and `\bibitem` markers), tested on `label=$(\star)$` and `\item[$(\dagger)$]`. Note: clicking the marker reveals the `\item`, not the `label=` option in the `\begin{enumerate}[…]` line.
- **`\doi`** reuses `LinkTextWidget` (click reveals source; Ctrl-click opens the URL).
- **Title/author blocks** (MLSys, jheppub, ICML): reuse `TitleWidget`; tests click a name, the title and the abstract (editors open and rewrite the source) and the source button.
- **4b:** no new widget kinds. The hand-rolled title block reuses `TitleWidget` (click a part opens the editor on the `\def` argument; Edit source/Alt-click put the caret in the first `\def`); `varwidth`, the `\hfill` group and the same-line `\qedsymbol` are hidden/replaced ranges tested for source reveal at the cursor (the `\hfill` formula also by Alt-click; a plain click opens the math editor as before). The proof-header test dispatches a mousedown and then places the caret, it does not drive a real browser click.
- **Tables:** a mousedown on a cell of a drawn longtable reveals the table source (tested). Longtables remain read-only otherwise (no per-cell editing).
- **Hidden commands** (`\penalty`, `\looseness`, `\urlstyle`, bst boilerplate, protective braces, `\medmuskip` lines, row-helper `\newcommand`s, `\let\c@…`, `\twocolumn[{`/`}]`, `\acknowledgments`, `\end{widetext}`): each reveals its source when the cursor enters it. The class agent proves this by moving the cursor onto the fold rather than dispatching a mousedown; the text agent asserts the reveal for `\penalty0` only, so `\allowbreak`, `\nobreak` and `\relax` reveal is shared code but not separately asserted.

## Open

- **Longtables** are read-only (click reveals the whole table); a row macro that fails to expand shows as source in the cell it lands in.
- **`\subfile{…}`** in quant-ph `main.tex` stays source (5 left); the include chip could cover it.
- **`\input` chip** also appears whenever the project's file list is unknown (a document opened alone); `\IfFileExists{a}{\input{a}}{}` stays source on purpose (2 left in cs.CL).
- **`\thanks{…}`** notes are not drawn in the title block (math.CO); cs.CL `figures/fig_teaser_body.tex` keeps one `\begin{tikzpicture}` line; cs.DS `main.tex` keeps `\crefalias`.
- **Loop-made macros** are only read for the `\loop`/`\csname` shape seen in math.CO (plus the existing `\foreach`); `\@for` loops and letters beyond Z are not.
- A title block built from `\def\@author` has a single author, so "add author" is unavailable there.

## Process notes

- The biggest "fix" (quant-ph, ~1300 `left`) was a bug in the audit script, not the editor; check how the audit picks its main file before trusting counts from multi-file projects.
- The junk counter flags any `cm-vis-math-source` text containing a backslash, so per-cell align fallback can raise `junk` for a file (quant-ph `sections/3.tex` 4 → 5 mid-round) while showing less raw `&` text; it ended at 0 after the macro fix.
- `latex-macros.test.ts` is outside the `latex-visual*.test.ts` glob and was missed by the first full run; two of its tests asserted that delimited `\def` is unsupported. Both were updated to the new behaviour. Include it in the post-merge run.
- Merge fallout fixed on the round branch: `latex-visual-floats.test.ts` expected `\twocolumn[Kept text]` to stay source; it is now the transparent wrapper (`Kept text`).
