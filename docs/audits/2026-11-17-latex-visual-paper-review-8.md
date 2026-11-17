# LaTeX Visual mode: review against 48 more papers (round 8)

Branch `fix/latex-visual-audit-8`, cut from `main` (2605871). 17 November 2026. Earlier rounds: `2026-11-10-…-review.md`
to `2026-11-15-…-review-7.md`. Recipe: `.claude/skills/latex-visual-audit/SKILL.md`.

## What was done

48 recent arXiv papers, as asked focused on ML, CS, economics, mathematics, physics, chemistry and biology, from fields
the earlier rounds covered least. There are two each from:
- ML and CS: cs.LG, stat.ML, cs.CL, cs.LO, cs.DS, cs.RO, cs.NI;
- economics: econ.EM, econ.GN, econ.TH;
- mathematics: math.AG, math.LO, math.GR, math.OA, math.CT;
- physics: gr-qc, nucl-th, hep-lat, cond-mat.str-el, physics.plasm-ph;
- chemistry: physics.chem-ph, cond-mat.soft;
- biology: q-bio.PE, q-bio.NC.

The ids are in `audited-papers.md`. q-bio.QM was asked for too, but arXiv's listing API returned nothing (see Open).
152 `.tex` files were opened headlessly as the editor opens them.

Five Sonnet agents fixed one area each in separate worktrees:
- commutative diagrams;
- formulas (KaTeX);
- bibliographies and the index;
- front matter, classes and text;
- macro discovery.

Their branches were merged by hand. One conflict, in `math-render.ts`'s list of commands that draw nothing, was resolved
by keeping the superset.

## Editing: every widget opens its source

The user's standing rule is that nothing drawn may be out of reach for editing.

- **No new widget class this round.** Everything new draws through widgets that already reveal their source on a
  click:
  - diagrams, colour boxes, tabulars in displays and `\eqno` through `MathWidget`;
  - the bibliography entries, the index, `\glsadd` and the expanded `\citep{\macro}` through the existing chip and
    macro widgets;
  - the `\lean` mark through `PrintedTextWidget`, which takes a colour now;
  - the INFORMS title through the title widget and its editor.
- **The sweep of `widgets.ts` and `text-commands.ts` is clean.** Every class that swallows events has a `mousedown` of its
  own that reveals the source (`revealOnClick`, the preamble toggle). The rest fall back to `widget-clicks.ts`.
- **One editability bug was found and fixed (diagrams agent).** `pieceReason` in `math-pieces.ts` treated the `@` of
  `\xymatrix@C=…` as part of the command name. Such a display was not recognised as a diagram, so a click opened the
  formula editor on source it cannot read. The click now shows the source.
- **Hidden constructs stay reachable.** `\begingroup`/`\endgroup`, `\index`, `\glsadd`, `\ifx…\undefined\def…\fi`,
  `\begin{barticle}`, `nolinenumbers`, `KeepFromToc` and the blueprint commands show their source when the caret
  enters them.
- **Click tests.** Every newly rendered kind has a click-to-source test in `latex-visual-audit8-*.test.ts`: a plain
  click, or an Alt-click for formulas and `\ref` chips, whose plain click does something else.
- **`noedit=` (drawn widgets that no click can open) is 0** in all 152 files, before and after.

## Numbers (left / math / junk / noedit, summed per paper)

| Paper | Before | After |
|---|---|---|
| math.LO 2611.11828 | 3198 / 160 / 0 / 0 | 2175 / 111 / 0 / 0 (84 of 137 tikz-cd diagrams still source, see Open) |
| cs.LG 2611.21216 | 1347 / 392 / 9 / 0 | 529 / 75 / 0 / 0 (all in files the paper never includes) |
| math.CT 2611.03553 | 1244 / 318 / 0 / 0 | 14 / 6 / 0 / 0 (`\dmor`) |
| cs.NI 2611.13943 | 1075 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| math.OA 2611.08668 | 662 / 46 / 40 / 0 | 11 / 0 / 0 / 0 |
| cond-mat.str-el 2611.17927 | 449 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| q-bio.PE 2610.35161 | 373 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| physics.plasm-ph 2611.11343 | 207 / 36 / 4 / 0 | 10 / 0 / 0 / 0 |
| econ.EM 2611.06067 | 81 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| cs.LO 2611.10842 | 51 / 62 / 0 / 0 | 3 / 0 / 0 / 0 |
| gr-qc 2611.18827 | 43 / 6 / 3 / 0 | 1 / 0 / 0 / 0 |
| econ.TH 2611.05701 | 40 / 54 / 1 / 0 | 2 / 0 / 0 / 0 |
| math.GR 2611.14085 | 21 / 0 / 60 / 0 | 0 / 0 / 0 / 0 |
| cs.RO 2611.20202 | 17 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| cond-mat.str-el 2611.17871 | 16 / 0 / 0 / 0 | 10 / 0 / 0 / 0 (REVTeX `\frontmatter@init` plumbing) |
| econ.TH 2611.05708 | 15 / 0 / 0 / 0 | 4 / 0 / 0 / 0 (`\ECSwitch`, `\ECHead`) |
| q-bio.NC 2611.07809 | 14 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| nucl-th 2611.13953 | 13 / 2 / 0 / 0 | 0 / 0 / 0 / 0 |
| stat.ML 2611.18394 | 12 / 0 / 0 / 0 | 12 / 0 / 0 / 0 (a `$(K)$` inside a formula in the paper itself) |
| cs.RO 2611.20185, math.AG 2611.18357, econ.GN 2611.02533 | 18 / 1 / 0 / 0 | 1 / 0 / 0 / 0 |
| 7 papers with 1–2 left | 8 / 0 / 0 / 0 | 8 / 0 / 0 / 0 |
| 19 papers | 0 / 0 / 0 / 0 (cs.LG 2611.21215: 1 junk) | 0 / 0 / 0 / 0 |
| **Total** | **8904 / 1077 / 118 / 0** | **2780 / 192 / 0 / 0** |

cs.LG 2611.21216's "before" was audited against the wrong main file (see the audit fix under Macros). Its "after" counts
come from files that no `\input` reaches, whose macros are unknown, as in the app.

## Issues by area

| Area | Issue (paper) | Result |
|---|---|---|
| Diagrams | quiver's tikz-cd `\arrow[from=r-c, to=r-c]` refused outright (11828: 1152 `\arrow`) | **partly**: `from/to`, quoted labels with `'` and `{description}`, `squiggly`, `tail`, `shorten`, pullback corners (`draw=none` + `\lrcorner`); 53 of 137 diagrams draw |
| Diagrams | 2-cells, `between=`, curves, far diagonals, vertical or leftward squiggly arrows, `[hook, two heads]` | **left** as source (no faithful KaTeX form) |
| Diagrams | `\xymatrix@C=…@R=…` with `@<1.1ex>` shifted arrows and `@{}|-{\perp}` (03553) | **fixed**: an opposite pair is drawn as an adjunction. The side rule for `@<>` is from xy's convention, not checked against a real xy render |
| Math | `\breve \mathcal P(E)`: an accent over a font command and a letter (11343, 31 formulas, 4 junk) | **fixed** in `forKatex` |
| Math | `\colorbox{red!40}{$0$}` inside a formula split it at the inner `$` (10842) | **fixed**: the parser reads those `$` as spaces. **Fixed on the round branch:** the agent's version keyed the parse tree on their positions, so every keystroke above a box reparsed the whole document; only the fragments around them are reparsed now (test added) |
| Math | `tabular` inside `align*` (05701; open since round 7) | **fixed**: translated to `array`; a tabular it cannot translate keeps the display source, not junk |
| Math | `\eqno\hbox{\qedsymbol}`, `\lambdabar`, `\lhook\joinrel\longrightarrow`, text `\dh`/`\DH`, `\EuScript` (as `\mathcal`), `\glsadd`/`\index` in formulas | **fixed** |
| Macros | audit chose a stray standalone `mxqtip/mxqtip.tex` as the main file for 21216's chapters | **fixed** in the audit: it now picks the root as the app's `findLatexRoot` does |
| Macros | `\MakeUppercase{\bm{Y}}` (21216) | **fixed**. **Fixed on the round branch:** the result was wrapped in braces, which broke `\textup{\MakeUppercase{\romannumeral4}}` (round 6's test) |
| Macros | `\include{math_commands}` in the preamble not read for definitions (20202) | **fixed** |
| Macros | `\usebox` of a `\savebox`ed xy arrow (03553, 158 formulas) | **fixed** for `\mor` (a long arrow); `\dmor` (a partial-map arrow with a half head) **left** |
| Macros | `\raisebox{…}{\ensuremath{…}}` in `\restr`; unicode-math `\symbfit` behind `\ifdefined` (08668) | **fixed** |
| Bibliography | REVTeX 4.2 inline bbl: `\bibinfo`, `\bibfield`, `\href@noop`, `\BibitemShut` (17927) | **fixed**, new `bibliography.ts`; an entry with an unknown command stays source |
| Bibliography | sn-jnl inline bbl: `\ifx\bauthor\undefined\def…\fi`, `barticle`/`bchapter`, `\citeauthoryear` (13943) | **fixed**: the guard is read as a definition (`conditionals.ts`) |
| Bibliography | EPL `\Name`/`\REVIEW` (35161) | **fixed** per `epl2.cls`, only under an `epl*` class |
| Index | inline `theindex` with `\item`/`\subitem`/`\hyperpage`/`\indexspace`; `\index{… \ref{…}}` junk (08668) | **fixed**; letter heads `{\textbf{A}}` still show their braces |
| Citations | `\citep{\releasedCites}`, a macro for the key list (21215) | **fixed**; an unknown macro stays source |
| Lists | `label=\normalfont(\roman*)`: `\ref` chips showed `\normalfont(i)` (14085, 60 junk) | **fixed**. **Narrowed on the round branch:** item markers dropped every font command, so `\textbf{\alph*)}` lost its bold (round 4's test). Markers now drop only the neutral switches; `\ref` chips, which are plain text, drop all |
| Front matter | INFORMS `\TITLE`, `\ARTICLEAUTHORS{\AUTHOR \AFF}`, `\ABSTRACT`, `\KEYWORDS`… (05708) | **fixed**; `\ECSwitch`, `\ECHead` left |
| Front matter | title cache ignored the class; `\let\maketitle\OriginalMaketitle` self-alias (17871) | **fixed** |
| Text | `\begingroup…\endgroup` around paragraphs (06067, 81); titling's `\thetitle` | **fixed** |
| Text | the paper's own `\lean{rel}{names}` mark (03553, 195) | **fixed** as a coloured chip; genuine leanblueprint commands are hidden |
| Text | jmlr's `algorithm2e` environment (07809), `nolinenumbers`, `KeepFromToc`, `\vbox to 0pt{…}`, `\romannumeral1`, `\tableofcontents` in a group | **fixed** |

## Tests

- **Added:** 53 tests in `latex-visual-audit8-{diagrams,math,bib,text,macros}.test.ts`, including the incremental-parse
  test for colour boxes.
- **Changed:** in `latex-visual-gaps-math-diagrams.test.ts`, two "stays source" cases are now drawn on purpose
  (`{description}` labels, `from/to` arrows). They were changed to cases that still stay source.
- **Whole Visual set after the merges (690 tests):** 684 passed and 6 failed.
  - Two failures were real. Both are fixed on the round branch, and both files pass now: round 4's bold enumitem marker
    and round 6's `\MakeUppercase{\romannumeral}`.
  - Three pass when run alone. They lost a timing race under the parallel full run, because `\ref` numbering arrives
    asynchronously. These are round 7's `parts` refs, round 7's units click test, and this round's `\normalfont` refs.
  - The idle-filler test in `latex-visual-background.test.ts` fails on `main` too (checked in a clean worktree). It
    expects the builder to keep up with a 1.5 MB parse within 1.5 s. Building speed is unchanged by this round:
    200 KB takes 75–82 ms on every branch.
- **Not rerun:** the whole set was not run again after the two fixes, per the compute budget. Only the affected files
  were.
- **Static checks:** `tsc --noEmit` and eslint on every changed `.ts` file are clean.

## Open

- tikz-cd diagrams KaTeX's CD cannot draw: 2-cells, curves, far diagonals and vertical squiggly arrows (math.LO 2611.11828,
  84 diagrams). They need a renderer of their own (SVG), not more KaTeX translation.
- `\dmor` (partial map arrow), REVTeX's `\frontmatter@init` plumbing, INFORMS's `\ECSwitch`/`\ECHead`, the index's letter
  heads, `\printnoidxglossary`.
- The idle-filler test is timing-dependent and fails on `main`. The three ref/units tests are also load-sensitive in a
  parallel run. They should wait on the numbering, not on a clock.
- Not checked in the running app. The dev server started, but the browser pane was hidden and could not load the page.
- q-bio.QM: the listing came back empty several times after a restarted fetch. A first fetch (with astro-ph, before the
  focus was set) was stopped; its node process kept running on Windows and wrote into the same folder. Its astro-ph
  extractions failed, and it garbled the log. It was killed, and the 48 papers it shared the folder with were checked to
  have their `.tex` files. The skill now warns about this; it may be how round 7 lost four papers.
