# LaTeX Visual mode: editing round (graceful fallback, component editing)

Branch `fix/latex-visual-editing-1` (base `418324e`, the audit-12 merge). November 2026.

## Why

A feature-by-feature audit of the Visual mode against a reference feature set (parsing and macros, text and numbering,
math, floats and tables, references and templates, theorems and algorithms, expensive constructs) found that the core
is well covered. The gaps that mattered were of three kinds:

1. **All-or-nothing fallbacks.** One unknown piece turned a whole float, table, algorithm, formula or title block to
   source (a `\rowcolors` line before a tabular; one unknown algorithm statement; one `\altaffiliation` in revtex).
2. **Components that could not be edited.** Algorithms were read-only; formulas with a `\label`, `&` or `\\` (every
   `align` row) opened only as source; captions needed a source reveal; tables had only insert/delete row and column.
3. **Missing workflow pieces.** No spellcheck, no image paste or drop, no diagram preview, diagnostics only as a count.

## Principles the round implemented

1. Fail gracefully at the smallest unit: a cell, a row, a statement, a panel, a part: only that part shows as source.
2. A construct being typed stays source until it is complete, then renders (checked per construct family by tests).
3. The user can edit the components: in place where possible, otherwise a click reveals just that component's source.
4. Unchanged rules: show only what is understood (never hide text), never edit the preamble, no byte changes from the
   mode itself, incremental build equals fresh build.

## What changed, by area (nine agents, one worktree each, merged by hand)

| Area | Done |
|---|---|
| Tables | Per-cell and per-row fallback (a cell with a comment, line break or macro opens as that cell's source; macro-written rows are handled row by row); ragged rows marked, not fatal; new menu commands: merge and split cells, column alignment, add/remove rules, move row and column; `\rowcolors`, `\arraystretch`, `\columncolor`, `\cline`/`\cmidrule` ranges, `m`/`b` columns, `\diagbox`, siunitx `S` alignment. |
| Floats | An unknown part of a float is a source line inside the drawn float (placeholders for forest, chemfig and similar drawings; listings drawn as code); in-place caption editing; `\subcaptionbox` (lettered, referable); side-by-side `minipage`/`\parbox` outside floats drawn as columns; `height`, `scale`, `angle`, `trim`+`clip`, `page=` and `\DeclareGraphicsExtensions` honoured. |
| Algorithms | Click a statement or the caption to edit it in place; insert/delete a statement (blocks stay balanced); unknown statements are source lines inside the algorithm; algorithm2e `\SetKwComment`/`\Comment`, `\SetKwIF`, `\SetKwRepeat`, `\nl`, `\lnl`, `\nllabel`, `\Indp`; `\ref` to a line gives its number, `\cref` says "line". |
| Math rendering | Per-row fallback in `align`-like environments; empheq, `dmath`, `dseries`, `IEEEeqnarray` drawn and numbered (fixes shifted equation numbers); `\displaybreak`, array column specs, physics `\eval`/`\var`/`\imat`…, mhchem (lazy), siunitx in formulas and text, colour models, many smaller symbols. |
| Math editing | Formulas open in MathLive one row or cell at a time (`&`, `\\`, `\label`, `\tag`, `\nonumber`, comments preserved byte for byte); macros MathLive cannot read round-trip as opaque atoms; a cell it cannot represent opens as source for that cell only. |
| Front matter and citations | revtex, acmart, llncs, svjour3, elsarticle, sn-jnl, AAAI affiliations, emails and notes drawn and editable line by line; one unknown front-matter command no longer spills the block; missing citation keys shown as a warning chip (only when bibliography data is loaded); `\onlinecite`, multicites, `\citetitle`/`\fullcite`/`\citenum`/`\supercite`, `\setcitestyle{numbers}`. |
| Macros and diagnostics | A macro wrapping a whole float or tabular (`\tbl{cap}{tabular}`) is drawn; cells edit the call's argument, a click on the caption edits that argument; body and preamble conditionals (`\iftoggle`, `\ifbool`, `\ifdef`, `\ifthenelse`…); xparse `t d r R D e E`, `\NewExpandableDocumentCommand`, `\PassOptionsToPackage`; lint diagnostics at the command for definition problems and missing files; an unfinished preamble definition no longer blanks the document. |
| Text | enumitem `resume`, `series`, `start`; counters printed in text; `\verb`, `verbatim`, `lstlisting` (with "Listing N" captions), `minted`; `changes` and soul markup; boxes, rules and symbols in running text; contents lists. |
| Workflow | Spellcheck toggle (Visual mode, markup excluded); image paste and drag-and-drop (saved into the project, figure inserted, missing `graphicx` listed, never added); on-demand TikZ/pgfplots/tikz-cd preview compiled with the project's own preamble and cached by hash. |

## Verification

- 47 commits, 70 files, about +9,700/−620 lines. Merge conflicts (walk.ts, widgets.ts, index.ts, the feature doc) were
  resolved keeping both sides' features.
- After merging, 12 of 438 tests failed: five in the agents' own tests (interactions between areas), seven in older files.
  An integration pass fixed them: two real collisions (a duplicated `case "ParBoxCommand"` that disabled the text-wrapper
  path; the float caption editor swallowing an algorithm's caption click), one principle fix (a listing in a float is
  drawn as code, never hidden), the rest old assertions updated for deliberately changed behaviour. A later fix makes
  `framed`/`shaded`/`leftbar` text in a float visible source instead of a placeholder that hid it.
- Final run: Visual suites, parser, macros, editor, images and display-preference tests: 438 of 438. `tsc` and eslint
  (68 changed files) clean. `npm run bench:latex-visual`: all budgets hold (first build 19.8 ms, keystroke median
  0.70 ms, p95 1.26 ms). Two agents had seen budget misses under the load of nine parallel runs; they did not reproduce.
- Headless probes on the merged branch: a `\rowcolors` table float, revtex `\altaffiliation`/`\collaboration`/`\pacs`,
  algorithm2e `\Comment` with an unknown statement, `\subcaptionbox` with side-by-side minipages, empheq with siunitx and
  physics, llncs `\inst`/`\institute`/`\keywords{\and}` all leave nothing as source.
- One claim from the audit was refuted: `\\[2ex]` in body text is fine (the test files had lost their backslashes).

## Partly done or left

| Item | State |
|---|---|
| EPS/PS preview | Still a placeholder: needs a new server route (for example `repstopdf` through `execFile`, cached); not added without review. |
| `\includeonly` | Left on purpose: LaTeX keeps an excluded chapter's numbers through `.aux`; not counting it would differ from the PDF. |
| Macro-written headings, items and footnotes | Still read-only (click shows the source). Definition text has no "jump to definition" control yet. |
| xparse `v` argument type, `\edef`/`\csname` names, expl3, `\@ifnextchar` | Unsupported (rare, package internals). |
| `\volcite`, `\citetext`, `\footcite` as a footnote, acmart `\authornotemark`, elsarticle `\fnref` | Left. No add-author action in the title editor. |
| empheq with a right delimiter and numbered rows | Stays source. |
| TikZ preview | Tested with a stub compiler and the error path; a real compile and the pdf.js crop were not exercised end to end. |
| Spellcheck, image paste, MathLive row editing, the new table menu | Covered by tests and unit-level checks; not run in the live app (the dev server needs a login). |
| Placeholders for `forest`, `chemfig`, `dirtree`, tikz | Show the name of a drawing, not its source; click reveals it. Prose environments (`framed`, `shaded`, `leftbar`) stay visible as source parts. |
