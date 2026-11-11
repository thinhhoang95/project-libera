import json
from collections import Counter
from pathlib import Path

out = Path('/private/tmp/claude-501/-Users-thinhhoang--claude-spares-spare-VcvXMm/9ce4c92f-3cf5-4aa3-91f7-230392e2a879/scratchpad/codex-review')
audit = json.loads((out/'audit.json').read_text())
probes = json.loads((out/'probes.json').read_text())
verdicts = {'1706.03762':'Borderline', '2005.11710':'Not acceptable', '2203.00671':'Not acceptable', '1803.09015':'Not acceptable', '1812.09970':'Borderline'}
names = {'1706.03762':'Attention Is All You Need', '2005.11710':'Featherweight Go', '2203.00671':'Maximum Flow and Minimum-Cost Flow in Almost-Linear Time', '1803.09015':'Callaway & Sant’Anna', '1812.09970':'Synthetic Difference in Differences'}
parts=[]
def add(s): parts.append(s.strip()+'\n')
def total(p, key): return sum(f.get(key,0) for f in p['files'])
def counts(p,key):
 c=Counter()
 for f in p['files']: c.update(f.get(key,{}))
 return c
def length(p,key): return sum(len(f.get(key,[])) for f in p['files'])
add(r'''# Libera LaTeX Visual mode review

## 1. Summary

Visual mode is not yet reliable enough to meet its promise for these five papers: two are **Borderline** and three are **Not acceptable**. The audit covered **28 files, 1,087,848 source characters and 14,249 structural constructs**, with **759 source-level formula fallbacks** and no renderer exceptions. Source text remained unchanged in every file through rendering, cursor movement and mode switches, but confirmed defects hide listing content, apply later number formats retroactively, suppress numbering after an unsupported definition, and skip counters in included files. The highest priorities are preserving visible content, fixing numbering isolation and bounding work on untrusted table specifications; package coverage comes after those correctness fixes.

## 2. Per-paper results

“Math” below counts structural math constructs; formulas inside table, algorithm and macro widgets are additionally exercised through their DOM. “Failed/candidates” counts source math nodes that remain visible and fail the renderer’s macro expansion/KaTeX path; candidates already covered by a larger widget are not failures. Raw commands exclude folded preambles, comments, definitions, verbatim regions and math interiors, which are tracked separately. These are occurrence counts, not percentages of typeset content.
''')
add('| Paper | Files | Verdict | Constructs | Math | Failed/candidates | Raw commands | Ref chips with `?`¹ | Build ms² | Exceptions |\n|---|---:|---|---:|---:|---:|---:|---:|---:|---:|')
for p in audit['papers']:
 c=counts(p,'constructs')
 add(f"| {p['id']} | {len(p['files'])} | **{verdicts[p['id']]}** | {sum(c.values()):,} | {c['math']:,} | {length(p,'mathFallbacks')}/{total(p,'mathCandidates'):,} | {total(p,'rawCommandCount'):,} | {length(p,'missingRefChips')} | {total(p,'buildMs'):.1f} | {length(p,'exceptions')} |")
add(r'''¹ Top-level reference chips. Including chips nested in widgets, the numbers of citation/reference chips containing `?` are respectively **5, 118, 170, 6, 12**. Unresolved citations normally show the literal bibliography key, not `?`; unresolved citation-key occurrences are respectively **58, 0, 0, 170, 0**. The first and fourth source trees contain no `.bib` files usable by the project lookup. Inline bibliographies and any shipped `.aux` data were read as data; no paper was compiled.

² Sum of synchronous first build and draining all pending structural chunks, excluding initial parsing, dependency loading, numbering and DOM inspection. Times are observations from one run on this machine, not browser latency guarantees. All pending queues drained to empty. KaTeX uses `throwOnError: true` and returns `null` on failure (`math-render.ts:83`), so **zero `.katex-error` nodes does not mean zero failed formulas**: all 759 failures were source fallbacks. Nested widgets also contain **537 raw fragment elements**: 0, 472, 53, 0 and 12 respectively; these include unsupported commands as well as failed math.

Every widget’s `toDOM()` ran, including widgets outside the initial EditorView viewport. Image URL callbacks deliberately returned `null` to avoid resource loading; image placeholders in this harness are **not** counted as image failures. Raster/PDF decoding, actual layout and PDF cropping/overlays are outside this headless result.

**Per-file measurements.** H = headings; M = structural math; C/R = citations/references; F/T/A = complete figure/table/algorithm widgets; grid = standalone TableWidgets. A complete table float is counted under T, not grid. “Theorem” is counted through numbering entries, so the zero for Featherweight Go exposes the numbering defect rather than absence of theorem markup. Full counts for every structural kind, every snippet and all timing phases are in `audit.json`.
''')
add('| File | Constructs | H / M / C / R | F / T / A / grid | Theorem | Math failures | Raw cmds | `?` refs | Build ms | Max chunk ms |\n|---|---:|---|---|---:|---:|---:|---:|---:|---:|')
for p in audit['papers']:
 for f in p['files']:
  c=f['constructs']; w=Counter(w.get('kind') for w in f['widgets'] if w['type']=='FigureWidget'); n=Counter(n['kind'] for n in f['numbering'])
  add(f"| {p['id']}/{f['file']} | {sum(c.values())} | {c.get('heading',0)} / {c.get('math',0)} / {c.get('cite',0)} / {c.get('ref',0)} | {w['figure']} / {w['table']} / {w['algorithm']} / {c.get('table',0)} | {n['theorem']} | {len(f['mathFallbacks'])} | {f['rawCommandCount']} | {len(f['missingRefChips'])} | {f['buildMs']:.1f} | {f['maxChunkMs']:.1f} |")

details={
'1706.03762':r'''
**1706.03762 — Attention Is All You Need: Borderline.** The prose and formulas are mostly comfortable to read. All detected source formulas render; the four result/comparison tables are complete widgets, and there are no raw fragments inside those widgets.

1. **The important two-panel attention figure remains partially source.** In `model_architecture.tex:61`, `\begin{minipage}[t]{0.5\textwidth}` contains the ordinary text `Scaled Dot-Product Attention \\` before its image; the other panel says `Multi-Head Attention`. `walk.ts:1325` rejects nonempty Normal text while checking float coverage. The outer figure/caption and minipage markup remain source, although two separate images render. This is a conservative coverage limitation, not lost content. Support plain text panel headings in FigureContent before consuming the float.
2. **Five cross-file references remain unresolved.** Examples include `background.tex`’s reference to `sec:attn` and references in `results.tex` to material in another tab. `references.ts:92` only resolves local numbering or `.aux` labels, and this source tree has no `.aux`. Root macros and correct chapter counter starts do not supply other files’ label targets. A normal compile supplying `.aux` is the immediate remedy; a project numbering/label index could provide a compile-free fallback with explicit file locations.
3. **Citations show bibliography keys throughout the chapters.** For example `\cite{bahdanau2014neural}` in `introduction.tex` cannot obtain authors/year from the project’s empty `.bib` list. There are 45 citation constructs and 58 unresolved key occurrences. `references.ts:13` looks only in project/library entries, and `citationText` falls back to the key (`references.ts:88`). The inline `thebibliography` in `ms.tex` renders, but does not populate that lookup. Supply compiled citation labels, or seed a conservative citation lookup from inline `\bibitem` records.

Numbering spot-check: the chapter file correctly continues with **3.1**, **3.2**, etc.; its numbered equations are **1** and **2**, the training schedule is **3**, and the table sequence is **1–4** across chapters. The main-file include-counter bug in finding 4 still exists: the root numbering pass does not accumulate those child equations/floats, even though independent chapter-start calculation happens to produce the expected numbers here. There are no theorem or algorithm constructs in this paper.

Frequent visible commands: `\input` ×7, `\begin` ×3, `\end` ×3, `\centering`, `\textwidth`, `\vspace` ×2 each. Visible environments include `minipage` ×2 and one outer `figure`. Root `\input` commands are expected because chapters open in separate tabs.
''',
'2005.11710':r'''
**2005.11710 — Featherweight Go: Not acceptable.** It produces 1,341 structural formulas, but 378 source formulas fail, 1,767 command occurrences remain visible outside math, and 472 widget fragments remain raw. Essential typing and reduction rules are recurring source blocks.

1. **All computed numbering disappears.** The valid suffix-package definition `\WithSuffix\newcommand\notmonomorphisable*{\meta{nomono}}` at `main.tex:226` is treated as an unfinished `\newcommand`. The definition reader extends its error extent to EOF (`definitions.ts:647`), then numbering skips that extent (`numbering.ts:449`). The result has **zero numbering entries and zero local label targets** despite 57 heading constructs and many theorem headers; all 118 reference chips are unresolved. Findings 3 and 5 give minimal reproducers. Recognize suffix declarations conservatively, and, independently, prevent a definition-reading error from suppressing unrelated following numbering.
2. **Inference rules are not rendered.** `main.tex:2524` contains `\begin{gather*}\inferrule[r-field]{(\ov{f~\tau})=\fields(\tau_S)}{...}`; the expanded formula still contains `\inferrule`, which KaTeX rejects. `walk.ts:677` correctly falls back, but `mathpar`/rule blocks outside math also expose their commands. Add a bounded inference-rule adapter, or a dedicated read-only rule widget, rather than hiding the source without rendering it.
3. **Standalone arrays lose their column specification.** For example the `\begin{array}{l}` block at `main.tex:2840` reaches KaTeX as `\begin{array}` followed by its body. `walk.ts:671` reads Content but omits arguments stored in BeginEnv; `math-render.ts:132` reconstructs only the environment name/body. This is a confirmed implementation defect, not missing KaTeX support; see finding 10. Preserve the environment’s required arguments.
4. **Code and custom layout wrappers recur as source.** Examples are `\goinl{Dispatcher}` at `main.tex:3096`, expanding to `\lstinline[style=mygo]+Dispatcher+`, and `golst`, `golsttwo`, `tabbing`, `mathpar` and `restatable` environments. `walk.ts:72` intentionally skips inline/listing nodes, and `render-fragment.ts:419` prints unhandled nodes as raw. The theorem/rules wrappers also produce raw `\hrule`. Read-only code formatting and explicitly supported rule/restatable wrappers would be needed for this paper to become comfortable; leaving unsupported listings as source is currently consistent with the documented fallback policy.

Frequent visible commands: `\ov` ×151, `\tau` ×121, `\vdash` ×114, `\inferrule` ×95, `\begin` ×86, `\end` ×85, `\Delta` ×81. Frequent source environments: `mathpar` ×28, `tabbing` ×22, `golsttwo` ×12, `golst` ×10, `minipage` ×6, `restatable` ×4. Some are math written outside parser-recognized math containers, so these counts supplement the formula-failure count. Numbering cannot be meaningfully PDF-matched until the zero-entry defect is fixed; a first numbered section and the Preservation/Progress theorem numbers must exist, whereas the visual headers currently omit them.
''',
'2203.00671':r'''
**2203.00671 — Maximum Flow and Minimum-Cost Flow in Almost-Linear Time: Not acceptable.** Much of the prose renders well, but important mathematical notation is missing across 357 source formulas, with a further 53 raw widget fragments. There are 116 computed theorem entries and 8 complete algorithm widgets; two additional algorithm floats stay source.

1. **Dynamically generated notation is unavailable.** `main.tex:163–171` uses `\foreach` with `\expandafter\xdef\csname m\x\endcsname{\noexpand\mathbf{\x}}` and a corresponding `c\x` family. Thus `$\mB^\top \bf = \bd,$` at `intro.tex:19` still has undefined `\mB`; the central minimum-cost-flow equations at `overview.tex:24` and `overview.tex:31` fail too. `definitions.ts:468` rejects `\xdef`; the reader does not interpret `\csname`, and `walk.ts:677` then falls back. This is within the plan’s explicit arbitrary-TeX non-goal, but prevents an acceptable verdict for this paper. A constrained recognizer for this common alphabet-definition pattern, or explicit project-supplied macro definitions, would address it without executing TeX.
2. **Algorithm2e’s parenthesized comments/labels prevent two complete algorithms.** `spanner.tex:68` has `\For(\tcp*[f]{Re-set level-$\geq j$ sparsifiers.}){...}{...}`, and `:72` has `\ForEach(\label{...}){...}{...}`. `algorithm.ts:206` expects a braced argument immediately; the loop path at `algorithm.ts:249` does not read the parenthesized prefix. Both algorithm floats at lines 63 and 222 fall back. Parse these bounded optional comment arguments before the loop condition/body.
3. **Cross-chapter references are frequently unresolved without compiled metadata.** There are 155 unresolved top-level reference chips, and 170 question-mark chips when nested widgets are included. For example `\Cref{thm:maxflow}` in another chapter cannot resolve solely from that tab’s numbering. `references.ts:92` intentionally requires local numbering or `.aux`; no `.aux` is shipped. Supply a compile result or a project label snapshot; do not invent numbers from label names.
4. **`restatable` wrappers and header macros expose source.** Examples include `\begin{restatable}[...]{theorem}{...}` and `\texorpdfstring{...}{...}` in headings. The registry’s generic environment path (`walk.ts:837`) recognizes direct theorem names and user environments, not thmtools’ restatable syntax, while `walk.ts:915` leaves unknown commands alone. Add explicit restatable and safe text-branch handling for `\texorpdfstring` if this source family is a target.

Numbering spot-checks from source order: first chapters start **1, 2, 3, 4, 5, 6**; `jtree.tex` itself contains later top-level sections, so `combine.tex` correctly starts **9**, not 7. The appendix files start **A, B, C, D**. The shared lemma/theorem sequence begins **1.1, 1.2…**, and equations progress from **1** in overview to **8** in `ipm.tex`. These positive checks concern separate tabs; the root include-counter defect in finding 4 makes root counters disagree with their included contents.

Frequent non-math visible commands: `\input` ×12, `\and` ×5, `\begin`/`\end` ×5 each, `\texorpdfstring` ×5, and `\ForEach`, `\lForEach`, `\tcp*`, `\thanks` ×4 each. The important raw environments are three `restatable`s and two `algorithm`s. Four figure floats and one table float are complete widgets; image decoding was not tested.
''',
'1803.09015':r'''
**1803.09015 — Callaway & Sant’Anna: Not acceptable.** Most formulas render—721 structural widgets and only 4 source-math failures—but the view is misleading because main-text headings, assumptions and theorems receive appendix number formats, and all three substantive `\ctable` tables remain source.

1. **Main-text numbering is retroactively formatted as appendix B.** `\section{Introduction}` at line 134 displays **B**, and subsequent sections repeat B. Later definitions at lines 2265 (`\renewcommand{\thesection}{A}`) and 2855 (`...{B}`), plus corresponding theorem/assumption formats, are used for earlier constructs by `numbering.ts:253`. The first assumption at line 367 becomes **Assumption B.1**, and the first theorem at line 729 becomes **Theorem B.1**, although those redefinitions have not occurred in TeX’s reading order. Finding 3 reproduces this independently. Evaluate counter formats at each construct’s position and carry that context through reset/prefix formatting.
2. **Three result tables are raw blocks.** For example line 2119 uses `\ctable[caption={Minimum Wage Aggregated Treatment Effect Estimates},label=tab:aggte,...]{lcccccc}{\tnote[]{...}}{\FL ... \NN ... \LL}`. The environment-only table registry in `walk.ts:1278`/`table-model.ts:154` has no ctable adapter; 45 `\NN` and 18 `\multicolumn` occurrences remain visible. Add a read-only ctable adapter for caption, notes and row/rule syntax before attempting editable cell mapping.
3. **A theorem named `algorithm` is mistaken for a float.** The preamble declares `\newtheorem{algorithm}{Algorithm}` at line 49. Its prose bootstrap algorithm at line 1790 should have a numbered theorem-style heading, but the walker tries the float renderer first (`walk.ts:750`) and never reaches the theorem registry on failure. See finding 8. Give explicit document theorem definitions precedence over a built-in float-name heuristic.
4. **The main figure falls back because of `\subcaption*`.** The image at line 2057 is drawn separately, but `\subcaption*{\scriptsize \textit{Notes:} ...}` at line 2058 is unrecognized by the float-coverage check (`walk.ts:1338`), leaving figure/caption source around it. Support an unnumbered note/caption block while retaining its full text.

The supplied auxiliary files contain 26 labels and one citation; the source itself contains no usable `.bib`. Six top-level references remain unresolved and 170 citation-key occurrences have no metadata. One overlapping supplied aux label differs (`eqn:pscore_ny`: Visual **B.5**, aux **SA.11**), but the auxiliary material may belong to a supplementary compile, so that mismatch alone is **not** treated as proof of an implementation defect. The retroactive B numbering is independently confirmed directly from the source and minimal probe. The four KaTeX fallbacks are proof endings such as `$\square\bigskip$`, rather than central estimating equations.

Frequent visible commands: `\NN` ×45, `\multicolumn` ×18, `\setcounter` ×11, `\cline`/`\noindent` ×4, and `\ctable`, `\FL`, `\LL` ×3 each. The outer algorithm and figure remain source; no complete table or figure float is built.
''',
'1812.09970':r'''
**1812.09970 — Synthetic Difference in Differences: Borderline.** The main exposition is largely readable, with 1,035 structural formulas, 4 complete algorithm floats and 5 complete table floats across tabs. Twenty source formulas and 12 widget fragments remain raw; the main algorithm’s estimator formula and three table wrappers are important recurring gaps.

1. **Algorithm 1’s defining regression remains raw inside a rendered algorithm.** `main.tex:495–499` contains `\begin{equation*}\p{\hat\tau^\sdid,...}=\argmin_{...}\cb{...}\end{equation*}`. The fragment renderer expands the entire statement in text mode (`render-fragment.ts:128`); macro expansion switches mode for dollar/paren/ensuremath syntax but not equation environments (`expand.ts:204`). Encountering the math-only operator makes expansion fail, and the later fragment math path tries the original unresolved macros. Finding 7 reproduces this with `\DeclareMathOperator`. Use the same position-aware math expansion/reference pipeline as the editor’s math widgets.
2. **Loop bounds retain `\KwTo` in all three variance algorithms.** For example line 1232 is `\For{$i \leftarrow 1$ \KwTo $B$}{...}`. `algorithm.ts:249` copies the loop argument into fragment text; its standalone `KwTo` handling does not process commands inside that argument. The resulting rendered header visibly contains `\KwTo`. Normalize standard algorithm keywords within header arguments, preserving nested math.
3. **A common paired-delimiter definition is not read.** `\DeclarePairedDelimiter{\smallabs}{\lvert}{\rvert}` at line 227 is absent from the macro-definition reader, so the 20 later formulas using it—for example the bound at line 1981—fall back at `walk.ts:677`. Add a constrained mathtools paired-delimiter definition reader including its star/size forms. This is a package-coverage gap, not silent alteration of the formula.
4. **`adjustbox` prevents complete rendering of three tables.** `table_cps.tex:2`, `table_penn.tex:1` and the laws table at `main.tex:1534` wrap their grids in `\begin{adjustbox}{width=...}`. The grid renders, but the outer table and caption stay source because `walk.ts:1358` rejects that environment. Recognize adjustbox as a transparent layout wrapper after checking its arguments and content.

Numbering spot-check: the first equation is **1.1**, consistent with the explicit `\theequation=\arabic{section}.\arabic{equation}` definition; Algorithms **1–4** follow caption order. The two included numbered tables correctly start at **2** (`table_cps.tex`) and **3** (`table_penn.tex`) when opened separately. The California weight tables use unnumbered captions and produce no table-number entries, correctly. Seven top-level references and twelve chips including nested content show `?`; examples `\ref{table1}` cross into an included table, and there is no supplied `.aux`. The 1,953 parsed `.bib` entries resolve all requested citation keys.

Frequent visible commands: `\or` ×12 (the unsupported month-name conditional), `\smash` ×9, `\begin`/`\end` ×6, `\thanks` ×5, `\and`, `\input`, `\noindent` ×4, and `\caption` ×3. Three `adjustbox` and three outer `table` environments remain source.
'''
}
for p in audit['papers']: add(details[p['id']])

add(r'''## 3. Code review findings, ranked

All findings below are **confirmed** by code inspection and the saved probes or paper runs. Severity P1 means potential UI denial of service, hidden content or broadly misleading output; P2 means a narrower correctness or responsiveness defect. These are renderer defects; the package-coverage gaps described above are not all defects against the plan.

**1. P1 — Empty repeated column specifications bypass the work limit.**

Location: `src/lib/latex/codemirror/visual/table-model.ts:109–110`.

Input: `\begin{tabular}{*{100000000000000000000}{}}x\end{tabular}`. `columnSpans` accepts an empty inner column list; multiplying its length by any repeat count yields zero, so the 256-column check passes. The loop still iterates once per requested repeat, and the count need not be a safe integer. This allows a tiny untrusted file to block the editor; for sufficiently large counts JavaScript’s `n++` eventually cannot advance. The enormous input was **not run**; the loop and guard prove the problem, and bounded calls with 1,000,000 and 10,000,000 empty repetitions verified work despite returning zero columns. Reject unsafe/excessive repeat counts independently of output size, and short-circuit empty inner lists.

**2. P1 — A figure silently discards a code listing.**

Location: `src/lib/latex/codemirror/visual/walk.ts:1322`; consumption occurs at `walk.ts:450`, while `widgets.ts:626` only draws recognized FigureContent.

Concrete input:

```tex
\begin{figure}
\begin{lstlisting}
func main() { println(42) }
\end{lstlisting}
\caption{Example}
\end{figure}
```

`figureCovered` treats every SKIPPED node as already covered, including VerbatimEnvironment. The complete figure is replaced with a FigureWidget containing no images, tables, drawings or algorithm, only “Example”; the listing disappears. The same happens with `verbatim`. This violates the “show only what is understood” invariant and is more serious than a source fallback. Distinguish ignorable comments/definitions from visible skipped content; reject the whole replacement unless the listing is actually drawn.

**3. P1 — Later counter-format definitions rewrite earlier numbers.**

Location: `src/lib/latex/macros/numbering.ts:253`.

Concrete input:

```tex
\begin{document}
\section{First}\label{first}
\begin{equation}a=b\end{equation}
\renewcommand{\thesection}{B}
\renewcommand{\theequation}{B.\arabic{equation}}
\section{Appendix}
\end{document}
```

The first section is numbered **B**, and its preceding equation **B.1**, instead of **1** and **1**. `customFormat` always calls `macroAt(..., Number.MAX_SAFE_INTEGER)`, ignoring the current construct position; earlier scoped definitions may also be excluded by this lookup. This directly causes the widespread wrong B numbering in Callaway–Sant’Anna. Thread the effective source position through all counter formatting, including parent counters and included-file contexts.

**4. P1 — Root definition offsets cause included files to be skipped entirely for numbering.**

Location: `src/lib/latex/macros/numbering.ts:328`, with the guard at `:434`.

Root input:

```tex
\newcommand{\f}{foo}
\begin{document}
\input{child}
\section{After}
\end{document}
```

Child input: `\section{Child}\begin{equation}x=y\end{equation}`.

The root’s definition sets `skipUntil` to a positive root offset. `numberIncluded` changes the read function and traverses the child with the **same visitor-local offset state**; the child root starts at zero and is rejected immediately. “After” is numbered **1**, and the equation counter never advances. Removing the otherwise irrelevant `\newcommand` makes “After” correctly **2**, with equation counter 1. Save/reset/restore coordinate-dependent visitor state on each included file, and evaluate its definitions/disabled regions in its own coordinate system; keep shared counters separate from traversal state.

**5. P1 — A definition reader error suppresses all following numbering.**

Location: `src/lib/latex/macros/definitions.ts:647`, consumed by `numbering.ts:449`.

Concrete input: `\WithSuffix\newcommand\foo*{bar}` before `\begin{document}\section{First}\label{first}\end{document}`. Also reproducible with a genuinely unfinished `\newcommand{\broken}` followed by an otherwise well-formed section. When the reader cannot find a body at the expected position, it creates an extent ending at EOF. Numbering treats that diagnostic/recovery extent as a definition body and skips everything. Featherweight Go hits this at line 226: all heading/theorem/equation numbers disappear and 118 references become unresolved. Separate diagnostic invalidation extents from actual definition-body extents, and recover at a bounded syntactic boundary. Unsupported syntax must not disable numbering for the rest of the file.

**6. P2 — Fragment math renders with broken or mismatched delimiters.**

Location: `src/lib/latex/codemirror/visual/render-fragment.ts:192–200` and `:262–266`.

Inputs: `$x`, `\(x`, and `\begin{equation}x\end{align}` passed through a caption/cell/macro fragment. All three render a KaTeX **x**, hiding the malformed delimiters. A figure with `\caption{Broken $x}` is also accepted as a complete FigureWidget, so this affects a real widget path. The fragment renderer checks neither direct parser errors on inline math nor equality of environment begin/end names. Apply the same well-formedness checks used by the main walk, leaving the complete malformed construct as source.

**7. P2 — Fragment formulas do not use the main math macro/reference pipeline.**

Location: `src/lib/latex/codemirror/visual/render-fragment.ts:128`, `:195`, `:266`; math-mode detection in `src/lib/latex/macros/expand.ts:204–238`.

Inputs: define `\DeclareMathOperator*{\argmin}{arg\,min}` and `\newcommand{\p}[1]{(#1)}`, then place `\begin{equation*}\argmin_x\p{x}\end{equation*}` in an algorithm statement. It stays raw even though the corresponding main editor formula can expand/render: outer text-mode expansion does not recognize the equation environment as math and fails on the math-only macro. Independently, `$x_{\ref{e}}$` remains raw inside a fragment even when the supplied numbering resolves `e` to 3, because fragment math never substitutes references. Synthetic DiD’s Algorithm 1 exposes the first case. Share a position-aware formula preparation function between both renderers, checking expansion success and refreshing reference numbers consistently.

**8. P2 — A document theorem named `algorithm` cannot render its heading.**

Location: `src/lib/latex/codemirror/visual/walk.ts:750–754`.

Input: `\newtheorem{algorithm}{Algorithm}\begin{algorithm}\label{alg}Important steps.\end{algorithm}`. Numbering recognizes theorem 1, but the structural layer emits only label/ref chips and leaves the entire algorithm begin/end as source. The float-name heuristic returns from `drawFloat` before the explicit theorem registry is tried. This occurs in Callaway–Sant’Anna’s bootstrap algorithm. Prefer applicable document theorem/environment definitions before float heuristics, or explicitly fall through after a rejected float.

**9. P2 — Initial and idle builds can expand a chunk to an entire large list.**

Location: `src/lib/latex/codemirror/visual/structural.ts:175–190`, `:295`, `:367`.

Input: one `enumerate` containing 10,000 repetitions of `\item Text $x$.` (160,033 characters), with the cursor in its middle. `initialBuild` requests a small window, but `widen` reaches the ListEnvironment’s full bounds. `capEdit` applies only when an EditContext exists, so the initial build walks the entire list and leaves no pending work. The saved probe took about **63 ms**, exceeding the plan’s 30 ms first-viewport budget on a document smaller than 500 KB; 1,000 items took about 15 ms. Initial and idle work need the same bound as edits, with list context/counter summaries rather than full-list widening. The standard repeated-fixture benchmark passes and does not catch this shape.

**10. P2 — Standalone math arrays omit required BeginEnv arguments.**

Location: `src/lib/latex/codemirror/visual/walk.ts:671–672` and `src/lib/latex/codemirror/visual/math-render.ts:132`.

Input: `\begin{array}{cc}a & b \\ c & d\end{array}`. The parser stores `{cc}` in BeginEnv, but the walk passes only Content to `katexForEnvironment`, producing `\begin{array}a & b ...\end{array}`. KaTeX therefore fails and the array stays source. Featherweight Go has real `{l}` examples at lines 2840 and 3033. Preserve required environment arguments and test array/alignat variants against their actual parser shapes; an array already inside a successfully parsed outer math formula follows a different path and is not affected in the same way.

No autonomous document-changing transaction was found in the reviewed rendering/background paths. The tested cursor/mode transitions preserved all source strings. No confirmed `.tex`-to-DOM script injection or path escape was found: raw strings go through text nodes/textContent, KaTeX uses `trust: false`, link opening restricts schemes, and graphic paths go through notebook-relative resolution. The table-repeat issue is nevertheless an availability/security defect for untrusted input. Dynamic image decoding, MathLive UI behavior and a full Electron security audit were not exercised here.

## 4. Recommended fixes in priority order

1. **Bound untrusted work and prevent hidden content:** cap repeat counts independently of expanded column count; make complete-float coverage prove that every visible child has a renderer. Add the empty-repeat and figure-listing regressions.
2. **Repair numbering before expanding package support:** make counter formats position-aware; isolate included-file traversal state; separate actual definition bodies from diagnostic invalidation extents. Assert identical counters in a root traversal and in independently opened chapters. Include the real Featherweight Go suffix declaration and Callaway appendix redefinitions as fixtures.
3. **Unify formula preparation:** validate delimiters, retain required environment arguments, expand macros in the correct mode, substitute references, and apply numbering through a shared function used by source decorations and static fragments. Test malformed caption math and the actual Synthetic DiD estimator statement.
4. **Honor explicit environment definitions:** resolve theorem/user-environment declarations before float name heuristics. Keep rejected constructs readable as source while drawing their recognized children.
5. **Make budgets hold for document shapes, not just repeated fixtures:** bound initial/idle widening for one large list or broken wrapper; retain incremental list context. Keep timing of parse, structural build, numbering and DOM work separate.
6. **Then add high-value paper support:** algorithm2e parenthesized loop comments and keywords inside arguments; mathtools paired delimiters; adjustbox/subcaption notes; ctable; inference rules, code presentation and restatable. Treat dynamic `\csname` definitions as an explicit bounded feature or documented limitation. Reuse actual `.bib`/`.aux` data and expose unresolved metadata honestly; do not claim cross-file references are correct merely because they render chips.

## 5. How the audit was run

Repository root: `/Users/thinhhoang/Documents/project-libera`. Harnesses and logs are only under `scripts/editor/.render-audit/`; artifacts are under the requested `scratchpad/codex-review/` directory. Existing repository files were not edited. No state-changing git command, dev-server start, TeX compilation, paper script execution or network request was used.

Commands, from the repository root:

```sh
mkdir -p scripts/editor/.render-audit
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/latex-visual.test.ts scripts/editor/latex-visual-editing.test.ts > scripts/editor/.render-audit/tests.log 2>&1
node --require ./scripts/editor/setup.cjs --import tsx scripts/editor/.render-audit/audit.ts > scripts/editor/.render-audit/audit.log 2>&1
node --require ./scripts/editor/setup.cjs --import tsx scripts/editor/.render-audit/probes.ts > scripts/editor/.render-audit/probes.log 2>&1
node --require ./scripts/editor/setup.cjs --import tsx scripts/editor/latex-visual-bench.ts > scripts/editor/.render-audit/bench.log 2>&1
python3 scripts/editor/.render-audit/report.py
```

The harness recursively inventories each paper tree without following symbolic links, follows existing braced `\input`/`\include` files using the application’s input reader, and audits each as a separate tab. It calls the app’s `collectMacroSources`, `collectBodyIncludes` and `chapterNumberingStart` functions, uses root preamble/local `.sty` sources in the same load order, supplies parsed `.bib` entries and shipped `.aux` data, and does not evaluate any TeX. All 28 reachable files were present; there were no missing input files.

For each file it creates jsdom globals, calls `latexLanguageSupport(path, "tree")` and `latexVisualState()`, ensures the syntax tree, enables `latexVisualMode({documentPath, rootPath})` through a Compartment, and drains `structuralField.pending` with `buildPendingEffect`/`CHUNK`. Numbering uses the parsed included-file texts. It mounts a real EditorView, refreshes its widgets and captures console/jsdom errors. Because jsdom does not lay out/scroll like a browser, it additionally calls every structural widget’s `toDOM()` in a connected host using a view proxy that supplies that decoration’s source position to `posAtDOM`; this ensures off-screen captions, cells, macros and algorithms execute and refresh. The proxy does not emulate geometric layout or user editing.

Source visibility is measured against the structural replacement ranges with the cursor at EOF; intentional source revealed by editing is not treated as a rendering failure. Failed source formulas are also checked explicitly with the same macro expansion, environment conversion and reference substitution helpers, since failed KaTeX produces no error DOM. The saved per-file output includes constructs by kind, numbering entries/labels/counters, raw command and environment counts/examples, every failed formula and prepared KaTeX input, float fallbacks, all widget text/raw fragments/captions, missing references/citation keys, pending state, timings and exceptions. `sourceStable` and `sourceStableAfterMoveAndModeSwitch` are true for every file. Input text is LF-normalized, as in the repository tests; the source files themselves are never written.

Existing tests: **93 passed, 0 failed**. The shipped 502 KB benchmark passed its configured budgets: first build **13.92 ms**, slowest idle piece **8.27 ms**, state-only keystroke median/p95 **0.44/0.96 ms**, dollar re-pair p95 **2.63 ms**. jsdom view-update median/p95 was **3.02/7.07 ms**. These passing fixture results coexist with the confirmed large-single-list budget failure and real-paper chunks exceeding 12 ms.

Artifacts: `report.md` is this report; `audit.json` is the full raw per-file result; `probes.json` holds the minimal defect reproducers and outputs. Keep the harness files if the temporary directory will be deleted and future reruns are needed. No complete PDF comparison was claimed: numbering checks use source order, declarations and the limited auxiliary data supplied with the source trees.
''')
(out/'report.md').write_text('\n'.join(parts))
text=(out/'report.md').read_text()
text=text.replace('|\n\n|','|\n|')
text=text.replace('parser-recognized definition nodes', 'parser-recognized definition nodes')
text=text.replace('Raw commands exclude folded preambles, comments, definitions, verbatim regions and math interiors, which are tracked separately.', 'Raw commands are residual visible command tokens, including commands such as \\caption whose enclosing construct fell back; they are not all unknown command names. Counts exclude folded preambles, comments, parser-recognized definition nodes, verbatim regions and math interiors, which are tracked separately.')
text=text.replace('`sec:attn`','`sec:attention`')
text=text.replace(r'For example `\cite{bahdanau2014neural}` in `introduction.tex`', r'For example the citation key `bahdanau2014neural` in `introduction.tex`')
text=text.replace('(`references.ts:88`)', '(`references.ts:84`)')
text=text.replace('Findings 3 and 5 give minimal reproducers.', 'Finding 5 gives minimal reproducers.')
text=text.replace('`render-fragment.ts:419`', '`render-fragment.ts:413`')
text=text.replace(r'For example `\Cref{thm:maxflow}` in another chapter', r'For example `\cref{thm:spanner}` at `jtree.tex:144`')
text=text.replace(r'Examples include `\begin{restatable}[...]{theorem}{...}`',r'Examples include `\begin{restatable}{theorem}{staticEmbedding}` at `spanner.tex:96`')
text=text.replace(r'Input: `\begin{array}{cc}a & b \\ c & d\end{array}`.',r'Input: an array `\begin{array}{cc}a & b \\ c & d\end{array}` inside a mathpartir `\inferrule` premise, whose math context the parser does not recognize. The same conversion defect is reproducible by presenting the array alone to the visual walker.')
text=text.replace('Keep the harness files if the temporary directory will be deleted and future reruns are needed.', 'Preserved copies of `audit.ts`, `probes.ts` and `report.py` are in `codex-review/harness/`; if the repository scratch directory is deleted, copy those files back into `scripts/editor/.render-audit/` before running the commands above.')
text=text.replace('Artifacts: `report.md` is this report; `audit.json` is the full raw per-file result; `probes.json` holds the minimal defect reproducers and outputs.', f'Artifacts: [report.md]({out}/report.md) is this report; [audit.json]({out}/audit.json) is the full raw per-file result; [probes.json]({out}/probes.json) holds the minimal defect reproducers and outputs.')
(out/'report.md').write_text(text)
print(f'Wrote {out/"report.md"}: {(out/"report.md").stat().st_size:,} bytes')
