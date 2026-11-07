# LaTeX visual editor plan

**Status:** built on `feat/latex-visual-editor`, 7 Nov 2026. [What changed while building](#what-changed-while-building) is at the end. The user guide is [LaTeX Visual mode](features/latex-visual-editor.md).

A Visual mode for `.tex` files, next to the existing Source mode. The file stays plain LaTeX the whole time. Visual mode is a layer of CodeMirror decorations drawn over the same editor, the same document and, on shared tabs, the same Y.Text. It hides markup, styles the text, and draws formulas, chips, figures and tables as widgets. Where the cursor is, the raw LaTeX comes back. It never dispatches a document change on its own: every byte in the file was typed, pasted, or written by a widget at the user's request, and only as the smallest change that does the job.

It also brings the idea behind [Markdown macros](features/markdown-macros.md) to LaTeX: the document's own `\newcommand`, `\newenvironment` and `\newtheorem` definitions are read, every use is shown expanded until the cursor reaches it, formulas render with the macros substituted, and counters number theorems, equations, figures and sections in document order so `\ref` shows the number it will have in the PDF.

## Goals

- Read and write a paper as formatted text, formulas and figures, without leaving the LaTeX file or giving up any of it.
- Byte-for-byte fidelity: switching modes, moving the cursor, scrolling or a collaborator's edit never changes the file.
- Show only what is understood. Unknown commands, broken braces, environments missing their `\end` and parser errors stay as source.
- The document's own macros, environments and theorems render as they will in the PDF, numbers included.
- Live collaboration, suggestions, AI review, SyncTeX, diagnostics, search and the outline keep working, with nothing extra on the wire.
- Cost proportional to the edit, not the document: a keystroke in a 500 KB thesis feels like one in a short note.

## Non-goals

- True WYSIWYG. No pages, line breaking, floats placement or real layout. The PDF pane stays the place to see the typeset result.
- Rendering arbitrary TeX. Conditionals, `\csname`, catcode changes, `\makeatletter` internals and packages with their own syntax stay as source.
- Converting LaTeX to another model and back (the TipTap Markdown approach). That is what would make fidelity impossible.
- Visual mode for `.bib`, `.sty` and `.cls` files.
- Beamer frames as slides. Frames render as ordinary environments.

## Where things stand today

| Area | Today | Why it matters |
|---|---|---|
| Language | A line-oriented `StreamLanguage` tokenizer ([language.ts](../src/lib/latex/codemirror/language.ts)). It yields flat tokens with no nesting. | A decoration layer needs a real syntax tree: which `}` closes which `\textbf{`, where an environment ends. The stream parser cannot provide it. |
| `codemirror-lang-latex` | Not installed. Version 0.6.1 (texlyre, based on Overleaf's Lezer grammar) is **AGPL-3.0-or-later**. Its generated parser and external tokenizers ship in the package; `@lezer/generator` is listed as a peer but not imported at run time. Our CodeMirror and Lezer versions satisfy its peers. | Adopted ([decision 1](#decisions)). What its trees look like is in [§2](#2-parsing-codemirror-lang-latex). |
| Editor | One `EditorView` per tab ([latex-editor.tsx](../src/components/libera/latex/latex-editor.tsx)). Shared tabs get the Y.Text binding and a `Y.UndoManager` from `collab.create()`; local tabs use `history()`. | Visual mode can be a `Compartment` in this same view, so a mode switch keeps undo, selection, the binding and the scroll position. |
| Formula preview | A KaTeX tooltip under the cursor inside math ([preview.ts](../src/lib/latex/codemirror/preview.ts)). Macros come from `readPreviewMacros` ([math.ts](../src/lib/latex/codemirror/math.ts)): a regex over the first 40,000 characters for `\newcommand` and `\DeclareMathOperator` only. | No optional arguments, no `\def`, no `\input` files, no macros for chapter files. The new macro engine replaces it in both modes. |
| Decorations already drawn | AI review hunks ([review.ts](../src/lib/latex/codemirror/review.ts)), collaborator suggestions ([suggestions/codemirror.ts](../src/lib/collab/suggestions/codemirror.ts)), agent review, SyncTeX flash, lint. | Visual mode must not hide them: a construct that overlaps one is revealed. |
| Formatting | `wrapSelection` ([editing.ts](../src/lib/latex/codemirror/editing.ts)) unwraps only when the selection is exactly a wrapper's content. Enter continues a list item (`continueListItem`). | Reused; the toggle becomes tree-aware. |
| Project data | `LatexProjectData`: labels from other open `.tex` tabs, bib entries, the file list, the References library. No file contents. | Macros in `\input{macros}`, local `.sty` files and the root file's preamble need file contents. |
| Build | [build.ts](../src/lib/latex/build.ts) already reads the job's `.aux` (for `\bibdata`). | The `.aux` also holds `\newlabel` and `\bibcite`: the exact numbers TeX gave each label and citation. |
| Markdown macros | [markdown-macros.ts](../src/lib/markdown-macros.ts) (definitions, expansion with a map back to source, counters) and [tiptap-macros.ts](../src/lib/tiptap-macros.ts) (expansion widgets, caret reveal, math re-render). | The model to follow; a few primitives can be shared ([§7.9](#79-code-shared-with-markdown-macros)). |
| Libraries | KaTeX 0.17 and pdf.js 4.10 are installed. MathLive is not (MIT, about 5.8 MB unpacked on npm, mostly fonts and sounds). | MathLive is loaded lazily on the first formula edit. |
| Tests | `npm run test:editor` (node test runner, jsdom setup, `fast-check` available). | Property tests carry most of the fidelity guarantees. |

## Design

### 1. Invariants

Every part of the design serves these four rules, and the tests check them directly.

1. **The source is the document.** Visual mode is decorations. Nothing in it dispatches a change except an explicit user action (typing, a toolbar button, a widget edit, a paste), and each such action writes the smallest change set, tagged `userEvent: "input.visual.<action>"` so provenance and undo grouping see it.
2. **Only recognised, well-formed constructs render.** A construct whose own delimiters are broken (an error node among its direct children, a missing closing token, or an environment whose `\end` names another environment) stays as source, and so does anything not in the registry. Well-formed constructs inside a broken one still render, so one stray brace does not turn the rest of the file back into source. Comments and verbatim content are never decorated.
3. **One editor, two looks.** Same `EditorView`, same Y binding, same undo history. Switching modes reconfigures a compartment and touches neither the document nor the undo stack.
4. **Work follows the edit.** Decorations are mapped through changes, and only the region whose syntax actually changed is rebuilt.

### 2. Parsing: codemirror-lang-latex

Visual mode needs a Lezer syntax tree with named, nested nodes, updated incrementally as the user types. It comes from `codemirror-lang-latex`, pinned to an exact version (`0.6.1`), and that tree serves `.tex` files in both modes, so there is one tree.

**Only its parser is used.** The package also has a `latex()` bundle with its own linter, completion, hover tooltips, auto-close tags and bracket closing; none of it is switched on, because Libera's completion, snippets, environment renaming and formula preview already do those jobs. Our own language wraps its parser:

```ts
// src/lib/latex/codemirror/latex-language.ts
import { parser } from "codemirror-lang-latex";
export const latexLanguage = LRLanguage.define({
  name: "latex",
  parser: parser.configure({ props: [latexStyleTags, latexIndent, latexFolding] }),
  languageData: { commentTokens: { line: "%" }, closeBrackets: …, wordChars: "@:-" },
});
```

- **Highlighting stays as it is.** `latexStyleTags` maps the package's nodes onto the tags `latexHighlightStyle` already colours (`SectioningArgument` → heading, `LabelArgument`, `RefArgument`, `BibKeyArgument` → labelName, `Math` contents → the math tags, `EnvName` → className, …), not the package's own choice of tags.
- **Folding and indentation come from the tree.** `Section`, `Chapter` and their relatives already span their heading and everything up to the next heading, so section folding is `foldNodeProp` on those nodes and `latexFoldRange`'s regex scan goes. Environments fold on `Content`; indentation uses `indentNodeProp` on `Environment`, `KnownEnvironment` and `Group`.
- **Bundle size.** The package has no `sideEffects` flag, so importing `parser` from its root may also bundle its linter, completion and data tables. Phase 2 measures the client bundle; if they come along, the import moves to the parser module itself (`codemirror-lang-latex/src/latex.mjs`, allowed because the package has no `exports` map), which is safe with the version pinned.
- **Dependencies.** `@lezer/lr` (1.4.11 installed today) and `@lezer/common` (1.5.3) become direct dependencies instead of transitive ones. npm also installs `@lezer/generator` as a peer; nothing imports it, so it never reaches the bundle.
- **Upgrades are deliberate.** A new version of the package (or of the Overleaf grammar it tracks) is taken only when the tree snapshots of the fixture corpus pass, since the registry depends on node names and shapes.
- **The stream tokenizer stays** for `.bib` files, and for `.tex` behind a flag until the parity tests pass.

**What the trees look like.** Checked by parsing samples with 0.6.1:

| Source | Tree (abridged) |
|---|---|
| `\section{Intro \textbf{b}}\label{s}` + text | `Section(SectioningCommand(SectionCtrlSeq, SectioningArgument(…TextBoldCommand(TextBoldCtrlSeq, TextArgument)…)), Content(Label(LabelCtrlSeq, LabelArgument), …))`: the section node holds the whole section, and the `\label` is the first thing in its `Content` |
| `$x^2$`, `$$y$$` | `DollarMath(Dollar, InlineMath(Math(…)), Dollar)` and `DollarMath(Dollar, DisplayMath(Dollar, Math, Dollar), Dollar)`; `\[…\]` and `\(…\)` are `BracketMath` and `ParenMath` |
| `a $x$ b $ c $y$ d` ⏎⏎ `e $z$` | The unpaired `$` gets a math node ending in an error node at the blank line, and the next paragraph parses normally. So one new `$` re-pairs dollars only up to the end of its paragraph. |
| `\begin{theorem}` … `\end{lemma}` | A generic `Environment` with **no error**: the parser does not check that the names match. The registry compares the `EnvName` of `BeginEnv` and `EndEnv` itself. |
| `\begin{proof}` with no `\end` | `Environment(BeginEnv, Content, ⚠)` |
| `\textbf{abc` with no `}` | `TextBoldCommand(TextBoldCtrlSeq, TextArgument(OpenBrace, LongArg(…), ⚠))`, and the argument runs **to the end of the file**, blank lines included. See [§8](#8-speed) for what that costs, and invariant 2 for why constructs inside it still render. |
| `tabular` | `TabularEnvironment(BeginEnv(…, TextArgument), Content(TabularContent(…, Ampersand, …, MultiColumn(MultiColumnCtrlSeq, SpanArgument, ColumnArgument, TabularArgument), …, LineBreak, …)), EndEnv)`; rules are `HorizontalLine`; a comment sits beside `TabularContent` |
| `align` | `EquationArrayEnvironment(BeginEnv, Content(Math(… Ampersand …, Label, …)), EndEnv)`: labels inside math are nodes, which numbering by row needs |
| `\begin{itemize}\item one \cite[p.~2]{a,b}\item[x] …` | `ListEnvironment(…, Item(ItemCtrlSeq, Whitespace), …, Cite(CiteStarrableCtrlSeq, OptionalArgument, BibKeyArgument), Item(ItemCtrlSeq, OptionalArgument, …), …)` |
| `\newcommand{\R}[1][x]{…}`, `\newtheorem{thm}{Theorem}[section]` | `NewCommand(NewCommandCtrlSeq, OpenBrace, LiteralArgContent, CloseBrace, OptionalArgument, OptionalArgument, DefinitionArgument(DefinitionFragment(…)))` and `NewTheoremCommand(…)` |
| `\providecommand`, `\DeclareMathOperator`, `\NewDocumentCommand` | Generic `Command(UnknownCommand(CtrlSeq, TextArgument…))`; the macro reader ([§7.3](#73-definition-forms)) reads their arguments itself |

Other classifications to know: `longtable`, `tabularx` and `xltabular` are `TabularEnvironment`; `subfigure` is a `FigureEnvironment`; `matrix`, `cases`, `aligned` and the other inner math environments are equation environments too (they only matter at top level, where they are formulas); `verbatim`, `lstlisting`, `minted`, `Verbatim`, `comment` and `luacode` are `VerbatimEnvironment`; `tikzpicture` is `TikzPictureEnvironment`.

**Not forked.** Constructs the grammar lacks (theorem environments, `\providecommand`, `abstract`) are recognised by the registry from generic `Command` and `Environment` nodes and their names, so there is no need to change the grammar. A fork would stay under AGPL and would have to track upstream; it is a last resort.

### 3. The construct registry

`constructs.ts` is a table: which nodes are recognised, and how each is drawn and revealed. Adding a construct is one entry plus a test.

```ts
// "toggle" is the preamble block: its header opens and closes it, not the cursor.
type RevealPolicy = "touch" | "strict" | "line" | "never" | "toggle";

type Construct = {
  id: number;                     // stable across mapping, used by reveal
  kind: string;                   // "bold", "math-inline", "section", …
  from: number; to: number;       // the whole construct
  hidden: Array<[number, number]>;// markup to hide (empty replace decorations)
  marks: Array<{ from: number; to: number; class: string; attributes?: Record<string, string> }>;
  lines: Array<{ at: number; class: string }>;
  widget?: WidgetType;            // replaces [from, to] when present
  block?: boolean;                // widget takes whole lines
  reveal: RevealPolicy;
};
```

| Construct | Source | Drawn as | Reveal |
|---|---|---|---|
| Section headings, starred too | `\part` … `\subparagraph` | Command, braces and a trailing `\label` hidden; line class `cm-vis-h1` … `cm-vis-h4`; number widget from [§7.7](#77-counters-and-cross-references) | line |
| Inline styles | `\textbf`, `\textit`, `\emph`, `\underline`, `\texttt`, `\textsc`, `\textsf`, `\textmd`, `\sout`, `\textsuperscript`, `\textsubscript` | Markup hidden, `cm-vis-b`, `cm-vis-i`, … on the content | touch |
| Colour, links | `\textcolor{c}{…}`, `\href{url}{…}`, `\url{…}` | Markup hidden, colour or link style; links open through the app's link handler (http, https and mailto only) | touch |
| Footnotes | `\footnote{…}` | Superscript number widget, content in small muted text | touch |
| Inline math | `$…$`, `\(…\)` | KaTeX widget | strict |
| Display math | `$$…$$`, `\[…\]`, `equation`, `align`, `gather`, `multline`, `flalign`, starred | Block KaTeX widget with its equation numbers | strict |
| Citations | `\cite` family | Chip: short author–year from the bib entries and library, or the numeric label from the `.aux`; tooltip with the title | strict |
| References | `\ref`, `\eqref`, `\cref`, `\Cref`, `\autoref`, `\pageref`, `\nameref` | Chip with the resolved number ("2.1", "(3)", "Theorem 2.1"); click jumps to the label | strict |
| Labels | `\label{…}` outside headings and environments | Small muted tag chip | strict |
| Figures | `figure`, `figure*`, `wrapfigure` | Block: image preview, rendered caption, number, label | strict |
| Images | `\includegraphics` outside a figure | Inline image widget | strict |
| Tables | `tabular`, `tabular*`, `tabularx`, inside `table` or not | Editable grid, caption above or below as written | strict |
| Lists | `itemize`, `enumerate`, `description` | `\begin`/`\end` lines collapsed; `\item` becomes a bullet or number counted per level; `\item[x]` shows `x` | line |
| Symbols | `\%`, `\&`, `\_`, `\#`, `\$`, `\{`, `\}`, `\ldots`, `\dots`, `~`, `--`, `---`, ` `` ''`, accents (`\'e`), `\LaTeX`, `\TeX`, `\today` | Replaced by the character | never (atomic) |
| Line breaks | `\\`, `\newline` | Faint ↵ | never |
| Theorems, proofs, user environments | `\newtheorem` and `\newenvironment` types, `proof` | Header ("**Theorem 2.1** (Name).") and footer (∎) widgets, body styled by theorem style | line |
| Text blocks | `abstract`, `quote`, `quotation`, `center`, `flushleft`, `flushright` | Begin and end lines collapsed; line classes for indent and alignment; "Abstract" header | line |
| Title | `\maketitle` | Title, authors and date from the preamble, rendered | strict |
| Preamble | Start of file to `\begin{document}` | Folded summary block ([§7.2](#72-where-definitions-come-from)) | toggle |
| Document boundaries | `\begin{document}`, `\end{document}` | Lines collapsed | line |
| Macro uses | Any defined command | [§7.5](#75-drawing-a-use) | strict, or touch for transparent arguments |
| Not decorated | Comments, verbatim, `lstlisting`, `minted`, `\verb`, `\lstinline`, `tikzpicture`, unknown commands, anything with broken delimiters | Source, comments dimmed | — |

An inline construct with empty content (`\textbf{}`) stays as source, so nothing can become invisible.

The nodes behind each row, as the package names them: `Book` … `SubParagraph` with their `SectioningCommand`; `TextBoldCommand`, `TextItalicCommand`, `EmphasisCommand`, `UnderlineCommand`, `TextTeletypeCommand`, `TextSmallCapsCommand`, `TextSansSerifCommand`, `TextMediumCommand`, `StrikeOutCommand`, `TextSuperscriptCommand`, `TextSubscriptCommand`; `TextColorCommand`, `ColorBoxCommand`, `HrefCommand`, `UrlCommand`; `FootnoteCommand`, `EndnoteCommand`; `DollarMath`, `ParenMath`, `BracketMath`, `EquationEnvironment`, `EquationArrayEnvironment`; `Cite`; `Ref`; `Label`; `FigureEnvironment`, `Caption`; `IncludeGraphics`, `IncludeSvg`; `TabularEnvironment`, `TableEnvironment`, `MultiColumn`, `HorizontalLine`; `ListEnvironment`, `Item`; `KnownCtrlSym`, `CtrlSym`, `Tilde`, `LineBreak`; `Maketitle`, `Title`, `Author`, `Date`; `DocumentEnvironment`. Theorems, `proof`, user environments and the text blocks are generic `Environment` nodes, recognised by name. Symbols the grammar leaves as text (`--`, `---`, quotes) are found by scanning `Text` runs during the walk. `Comment`, `VerbatimEnvironment`, `VerbCommand`, `LstInlineCommand` and `TikzPictureEnvironment` are skipped.

### 4. Decorations: one walk, three tools, two layers

`decorations.ts` walks the tree once over a range with a `TreeCursor`. For each node the registry recognises it records a `Construct`. It does not descend into comments, verbatim content or math interiors. A construct with broken delimiters records nothing for itself, but the walk still descends into it, so the well-formed constructs inside render. Each construct becomes decorations of three kinds:

- **Hide**: an empty `Decoration.replace` over markup such as `\textbf{` and its `}`. The text between stays real, editable source.
- **Style**: `Decoration.mark` with a class on visible text, and `Decoration.line` for whole-line styles such as headings.
- **Replace with a widget**: `Decoration.replace({ widget })` over the whole construct, `block: true` for display math, figures, tables and theorem headers.

They live in two layers:

- **Structural layer** (`structural.ts`, a `StateField`): hidden spans and widgets for the whole document. It must be a state field: CodeMirror only lets decorations provided directly (not through a function) introduce block widgets or replacements that cross line breaks. The same set feeds `EditorView.atomicRanges`, so the cursor steps over a hidden span or a widget as one unit.
- **Style layer** (`style.ts`, a `ViewPlugin`): marks and line classes for the visible ranges plus a margin, recomputed on viewport, document and tree changes. It is cheap because it only covers what is on screen.

Each decoration's spec carries its construct's `id` and extent, which is what reveal filters on. Widgets implement `eq` on (kind, source text, dependency fingerprint), so mapping through unrelated edits keeps their DOM; chips use `updateDOM` for number changes; block widgets give `estimatedHeight` so scrolling stays stable before they render.

While an IME composition is in progress (`view.composing`), the line being composed is not rebuilt; the rebuild runs on `compositionend`.

### 5. Revealing the source at the cursor

`reveal.ts` decides which constructs show their source. For each selection range it finds the innermost recognised construct around it and applies that construct's policy:

| Policy | Reveals when | Used by |
|---|---|---|
| touch | The selection intersects `[from, to]`, edges included | Inline styles, colour, links, footnotes, transparent macros |
| strict | The selection is strictly inside: `from < pos < to` | Formulas, chips, figures, tables, labels, title, macro uses |
| line | The cursor is at the start of the construct's line (before its hidden command), or the selection covers the whole construct | Headings, `\item`, begin and end lines, theorem headers |
| never | Never; atomic, deleted as a unit | Symbols, `\\` |

- **Innermost wins.** Bold inside a heading reveals only the bold markup; the heading stays drawn.
- **Edges keep widgets whole.** With the cursor at a formula's edge it stays drawn and moves, selects and deletes as one block.
- **Headings are edited in place.** Typing in a heading's title keeps its markup hidden. Home puts the cursor before the hidden `\section{`, which reveals it, so the command can be changed from the keyboard; the toolbar's heading picker does the same with the mouse.
- **A keyboard path into widgets.** Atomic widgets cannot be entered with the arrow keys, so: with a widget selected (Shift+Arrow, or after the first Backspace) or the cursor next to it, Enter opens its editor (MathLive, the first table cell, the figure popover) and Alt+Enter puts the cursor strictly inside, which shows its source. Click opens the editor; Alt+click shows the source.
- **Also revealed:** any construct that overlaps a pending suggestion, an AI review hunk or an agent review range, so struck-through and inserted text stays visible and decidable.
- **Collaborators never open anything for you.** Their cursors come from the awareness state the binding already shares; the innermost construct around each gets an outline in their colour (`cm-vis-remote`).

Implementation: the structural field keeps `all`, the full decoration set, and `shown`, which is `all` with the revealed constructs filtered out by `RangeSet.update({ filter, filterFrom, filterTo })` limited to the revealed constructs' extents. A selection move costs a few logarithmic lookups, whatever the document size. `shown` is what the view draws and what `atomicRanges` returns, so the two always agree.

### 6. Writing edits back

#### 6.1 Text

Typing is ordinary source editing: the visible text is the source. Autocompletion, snippets, environment renaming and closing brackets keep working.

#### 6.2 Formulas (MathLive)

Clicking a formula opens MathLive (`math-edit.ts`, imported on first use, fonts bundled locally so it works offline in Electron).

- **Refused, opened as source instead** (MathLive would change them): formulas over several lines, or containing `\label`, `&`, `\\` or `%`. These get the cursor strictly inside, so the raw LaTeX and the existing KaTeX preview tooltip appear.
- **The document's macros** are given to MathLive as non-expanding macros, so `\R` displays as ℝ and is written back as `\R`, not `\mathbb{R}` (to confirm in the [MathLive spike](#spikes)).
- **Smallest write-back** (`tex-tokens.ts`). On save, the original and MathLive's output are split into TeX tokens (control words, control symbols, characters, braces, spaces) and compared in a canonical form that removes the differences MathLive introduces: redundant braces around one-token script arguments (`x^{2}` and `x^2`), spacing, `\frac12` and `\frac{1}{2}`. Runs that are equal in canonical form keep their original bytes; only changed runs are written. If nothing changed, nothing is written.
- **Conflicts.** The formula's text and range are recorded when MathLive opens and the range is mapped through every transaction, remote ones included. If a co-author changed the formula meanwhile, saving asks: replace theirs, keep theirs, or open both as source.
- **Viewers and commenters** see formulas read-only. In suggest mode the edit goes through suggest mode's transaction filter and becomes a suggestion, like any other edit.

#### 6.3 Tables

`table-model.ts` maps every cell of a `tabular` to its exact source range: rows split at `\\` and cells at `&`, at brace depth zero and outside math and comments; rule lines (`\hline`, `\cline`, `\toprule`, `\midrule`, `\bottomrule`) recorded but not cells; `\multicolumn{n}{spec}{…}` as one cell spanning `n` columns. The grid renders cells through the fragment renderer ([§7.4](#74-expansion)).

- Editing a cell rewrites only that cell's text.
- Adding or deleting a row or column writes the fewest changes: one line inserted, or one `& ` per row plus one letter in the column spec. All changes go in one transaction. On shared tabs `undoManager.stopCapturing()` runs before and after, and local tabs use `isolateHistory`, so it is one undo step that does not merge with typing.
- Cells containing a comment, `\\` (as in `\makecell`) or a nested tabular are edited as source.
- `longtable` and `array` stay as source in the first version.

#### 6.4 Figures

The figure widget shows the image and the rendered caption. PNG and JPEG previews load from `/api/files/raw`; PDF figures are drawn from their first page with pdf.js; both are cached by path and modification time. EPS and missing files show a labelled placeholder. Paths resolve with `resolveRelativeNotebookPath`, so a figure can never read outside the notebook. Clicking opens a popover to pick another image from the project files, change the width, or edit the caption, label and placement as source.

#### 6.5 Formatting commands

Bold, italic and the other wrappers become tree-aware (`format.ts`): with the cursor or selection anywhere inside an existing `\textbf{…}`, the button removes the wrapper; otherwise it wraps the selection. The toolbar shows a button as active when the cursor is inside its construct. ⌘B, ⌘I and the existing shortcuts keep their keys.

#### 6.6 Keyboard fixes

| Fix | Mechanism |
|---|---|
| At the end of a heading the cursor stays before the hidden `}` (and hidden `\label`), so typing stays in the heading | Transaction filter on selection changes |
| The cursor cannot land before a bullet (in the indentation before `\item`) | Transaction filter |
| Enter in a list adds a new `\item` at the item's indentation; Enter on an empty item ends the list | Existing `continueListItem` |
| Backspace after a formula or chip selects it; a second Backspace deletes it | Keymap |
| A letter typed right after a hidden `\ldots` (or another control word) gets a space first, so the command name is not lengthened | Input handler |
| Enter or Alt+Enter on a selected widget opens it or shows its source | Keymap ([§5](#5-revealing-the-source-at-the-cursor)) |

#### 6.7 Paste

`html2latex.ts` converts clipboard HTML from Word, Google Docs and web pages, deterministically (no AI): paragraphs, bold, italic, underline, headings to sectioning commands, lists to `itemize`/`enumerate`, links to `\href`, tables to `tabular`, code to `\texttt` or `verbatim`, superscript and subscript. It escapes `# $ % & _ { } ~ ^ \`, maps symbols to commands (α → `\alpha`, ≤ → `\le`, wrapped in `$…$` in text; smart quotes to ` `` ''`; dashes to `--` and `---`; non-breaking space to `~`; … to `\ldots`), reads TeX annotations from MathML where present, and drops markup it does not understand. Plain text pastes as it is, since it may be LaTeX; inside math only plain text is used. Large pastes on shared tabs still go through `insertLargeText`.

### 7. Macros, environments and numbering

This is the Markdown macros idea carried over to LaTeX. In Markdown the definitions live in a ```` ```libera-macro ```` block; in LaTeX they already exist, in the preamble and the files it loads. What carries over is the model: read the definitions, expand each use with a map back to its source, show the expansion until the cursor reaches the use, render formulas with macros substituted, and number things in document order.

#### 7.1 What carries over

| Markdown macros | LaTeX Visual mode |
|---|---|
| ```` ```libera-macro ```` block | Preamble, `\input`ed macro files, local `.sty` files, the root file's preamble for chapter files |
| Math macro, `\name = $…$` | Any macro used inside math; `\DeclareMathOperator`; `\ensuremath{…}` bodies |
| Text macro (Markdown body) | A macro used in text (its LaTeX body drawn by the fragment renderer) |
| `\newcommand{\theorem}[2]{**Theorem \counter-theorem (#1).** *#2*}` | `\newtheorem{theorem}{Theorem}[section]` with `\begin{theorem}[Name]` |
| `\counter-name` | LaTeX counters: sections, equations, figures, tables, theorems, footnotes, `\newcounter`, with `\label` and `\ref` |
| Expansion shown until the caret reaches it | The same, through the reveal engine |
| Faint underline on an expansion (`libera-macro-expansion`) | `cm-vis-macro` |
| Block header "Macros: 5 definitions · 1 problem" | Preamble header "Preamble · 12 packages · 8 macros · 2 theorem types · 1 problem" |
| 16 levels of expansion at most | The same, plus a cap on expanded size |
| Math nodes re-render when a definition changes | Math widgets keyed on the fingerprints of the macros they use |
| Expand macros → `<note> (expanded).md` | Follow-up: `<file> (expanded).tex`, for journals that forbid custom macros |
| Chat renders replies with attached notes' macros | Follow-up: attached `.tex` files contribute their math macros |

#### 7.2 Where definitions come from

`src/lib/latex/macros/sources.ts` collects, in TeX's reading order:

1. The root file's preamble, when the open file is a chapter (the workspace already resolves `rootPath`).
2. The open file's preamble, up to `\begin{document}`.
3. Files the preamble loads with `\input`, `\include` or `\usepackage{name}` when `name.sty` exists in the project. Contents come from open tabs' drafts or `/api/files`, as the workspace already does for `.bib` files, and are cached by path and modification time. Paths that leave the notebook are ignored.
4. Definitions in the document body, which apply from where they are written, as in TeX.

`LatexProjectData` gains `macroSources: Array<{ path: string; text: string; version: string }>`. The preamble is parsed again only when an edit touches it or a definition in the body, or when a source file's version changes.

In Visual mode the preamble folds into a summary block. Its header counts packages, macros and theorem types and any problems, and toggles the raw preamble open, like the Markdown macro block. It starts folded. Problems (a body using `#3` in a two-argument macro, a definition with no body) are marked on their lines while the preamble is open.

#### 7.3 Definition forms

| Form | Support |
|---|---|
| `\newcommand{\x}[n][default]{body}`, `\renewcommand`, `\providecommand`, starred, `\newcommand\x{…}` | Full, optional first argument included |
| `\def\x#1#2{body}` | Undelimited parameters; delimited ones (`\def\x#1.{}`) are listed as not rendered |
| `\let\x\y`, `\let\x=\y` | Alias of a defined or built-in command |
| `\DeclareMathOperator{\x}{name}`, starred | `\operatorname{name}`, `\operatorname*{name}` |
| `\NewDocumentCommand` and its relatives | Argument types `m`, `o`, `O{default}`, `s`, with `\IfBooleanTF`, `\IfNoValueTF` and `\IfValueTF` evaluated; other types listed as not rendered |
| `\newenvironment{name}[n][default]{begin}{end}`, `\renewenvironment`, `\NewDocumentEnvironment` | Begin and end code drawn as header and footer, body stays editable |
| `\newtheorem{name}{Title}`, `[within]`, `\newtheorem{name}[shared]{Title}`, `\newtheorem*`, `\theoremstyle{plain|definition|remark}` | Header, number, style; amsthm's `proof` built in |
| `\newcounter{c}[within]`, `\setcounter`, `\addtocounter`, `\stepcounter`, `\refstepcounter`, `\numberwithin`, `\arabic`, `\roman`, `\Roman`, `\alph`, `\Alph`, `\the<c>` | The numbering pass ([§7.7](#77-counters-and-cross-references)) |
| `\crefname`, `\Crefname` | Names on `\cref` chips |
| Conditionals, `\csname`, `\expandafter`, catcode changes, `\makeatletter` internals | Not rendered: uses stay as source, and the definition is listed as not rendered (not as a problem) |

#### 7.4 Expansion

`src/lib/latex/macros/expand.ts`. LaTeX does not mark a body as math or text; the use site decides.

- **In math**, uses are expanded into the formula's LaTeX before it reaches KaTeX (and before the source-mode preview tooltip, which switches to this engine). This handles optional arguments and `\def`, which KaTeX's own `macros` option cannot.
- **In text**, the use is expanded and the resulting LaTeX is drawn by `render-fragment.ts`, a static renderer built on the same registry: inline styles, colour, math (KaTeX), symbols, chips, line breaks. Anything it does not know is shown as source in monospace, so even an expansion never misrepresents what it contains. The same renderer draws captions, theorem names, table cells and the title block.
- A body that only makes sense in math (math-only commands with no `$…$` or `\ensuremath`) used in text would be a TeX error, so the use stays as source.
- Limits: 16 levels of nesting, 20,000 characters of output, and a guard for `\def\x{\x}`-style recursion. Past a limit the use stays as source.
- Each definition has a fingerprint. A widget records the fingerprints of the macros it expanded; when a definition changes, only those widgets redraw.

#### 7.5 Drawing a use

A use shows its expansion with a faint underline and reveals its source when the cursor is strictly inside it (it is atomic at its edges, like a chip). Clicking it places the cursor inside, which shows the source to edit.

**Transparent arguments** (later phase): when a text macro's body uses each parameter exactly once, in text position, as in `\newcommand{\todo}[1]{\textcolor{red}{TODO: #1}}`, the use is drawn without a widget: the name and braces are hidden, the body's fixed parts ("TODO: ") are small widgets before and after, and the argument's own source gets the body's styling (red). The argument is then edited in place like bold text, with the touch policy.

#### 7.6 Environments and theorems

- `\newtheorem` types draw a header widget on the `\begin` line: name, number, and the optional argument rendered in parentheses ("**Theorem 2.1** (Pythagoras)."). The body is styled by theorem style: `plain` italic, `definition` upright, `remark` upright with an italic header. `\label` right after `\begin` is hidden.
- `proof` draws "*Proof.*" and a ∎ footer (or `[Name]` replacing "Proof").
- `\newenvironment` types expand their begin code into a header widget and their end code into a footer widget, with `\begin{env}{a}{b}` arguments substituted. The body between stays editable visual content. If the begin or end code does not render cleanly, the begin and end lines stay as source and the body still renders.
- Built-ins: `abstract`, `quote`, `quotation`, `center`, `flushleft`, `flushright`, lists, figures, tables, display math.

#### 7.7 Counters and cross-references

During the walk each chunk also records a compact list of numbering events: sections (level, starred), `\appendix`, display math (numbered rows, `\tag`, `\nonumber`, `\notag`), figures, tables, theorem environments, footnotes, list items, counter operations, and labels. `numbering.ts` runs over the events in order, resetting counters per `within`, `\numberwithin` and shared theorem counters, switching sections to letters after `\appendix`, and following the document class (chapter-prefixed numbers for `book`, `report`, `memoir` and `amsbook`). A `\label` binds to the last number stepped before it in its environment or section.

The result is the number of every heading, equation, figure, table and theorem, and a label table (key → number, kind, position) for the chips: `\ref` shows "2.1", `\eqref` "(3)", `\cref` "Theorem 2.1" (with `\crefname` overrides), `\autoref` "Section 2". The pass is linear in the number of events (thousands, not characters), so it runs after every structural change; widgets compare their number in `eq`, so only the ones whose number changed redraw.

**The `.aux` file fills the gaps.** The compile response gains the job's labels (`\newlabel{key}{{2.1}{3}…}`, both the plain and hyperref forms) and citation labels (`\bibcite{key}{1}`), parsed by `src/lib/latex/aux-file.ts`. They supply labels defined in other files, numeric citation labels, and the numbers for chapter files, whose counters start where the root file leaves them. A later phase adds a project-wide pass that walks the root's include graph.

#### 7.8 Keeping it current

- An edit inside a definition (preamble, macro file, body definition) bumps the macro version; widgets whose fingerprints changed redraw.
- An edit that adds or removes a numbering event reruns the numbering pass; only widgets with a changed number redraw.
- Other edits touch neither.

#### 7.9 Code shared with Markdown macros

The two engines have different semantics (Markdown bodies, hex colours, list and quote prefixes on one side; optional arguments, `\def`, environments and counters with resets on the other), so they stay separate. A few primitives move to `src/lib/macros/core.ts` and both use them: reading a balanced group (today `readGroup` in markdown-macros.ts and `readBalancedGroup` in project.ts), parameter substitution with `##` handling (the hex-colour exception becomes an option), the depth guard, and the replacement map with its binary-search `toSource`. The Markdown macro tests guard the move.

#### 7.10 Follow-ups

- **Expand macros for LaTeX**: a `<file> (expanded).tex` copy with user macros expanded and their definitions removed, like the Markdown button.
- **Chat**: `.tex` files attached to a conversation contribute their math macros to the chat's KaTeX rendering, as Markdown notes do.
- **Markdown to LaTeX export**: write a note's math macros as `\newcommand`s in the preamble instead of expanding them.
- **Package shims**: macro tables for popular packages KaTeX lacks (`physics`, parts of `siunitx`), switched on by `\usepackage`.

### 8. Speed

- **Mapping first.** Every transaction maps the structural set through its changes. Constructs untouched by the edit keep their widgets, DOM included.
- **Finding what changed.** The changed ranges come from `tr.changes`. Each is widened to the enclosing top-level construct, then extended forward while the old tree (mapped) and the new tree disagree on top-level node types and boundaries, stopping once they agree again. This is what catches one new `$` re-pairing every dollar after it; the parser ends unpaired inline math at the next blank line, which bounds that to the paragraph. Only that region is rebuilt: `RangeSet.update({ filterFrom, filterTo, filter: () => false, add })`.
- **A brace that swallows the file.** An unclosed `\textbf{` (typed with bracket closing off, or left when a `}` is deleted) makes its argument run to the end of the file, so every node after it moves and the diff region becomes the rest of the document. A region longer than the viewport plus a margin is rebuilt only there at once; the rest is queued as idle pieces (below). Closing the brace brings the old tree shape back, and the same rule applies again, so a deleted `}` near the top of a thesis never costs a full rebuild per keystroke.
- **Trees that grow on their own.** CodeMirror parses large documents in time slices and later updates the tree without a document change. The field compares `syntaxTree(tr.startState)` with `syntaxTree(tr.state)` and builds the newly parsed range.
- **Long documents load in pieces.** Over about 60,000 characters, the first build covers the viewport and 12,000 characters around it (with `ensureSyntaxTree` and a time budget); the rest is built 12,000 characters at a time, outward from the viewport, in `requestIdleCallback`. Each piece is an effect, not a document change. A region not yet built shows source, and scrolling into one builds it first.
- **Formulas render once.** KaTeX output is cached by (LaTeX after expansion, display mode), and a formula widget is redrawn only when its own source or a macro it uses changes.
- **Budgets**, checked by `npm run bench:latex-visual` on a 500 KB thesis: under 1 ms median and 4 ms at the 95th percentile per keystroke for decoration work; under 30 ms for the first viewport; no idle piece over 8 ms.

### 9. Collaboration, suggestions and review

- Nothing changes on the wire: Visual mode is local decorations over the same Y.Text. Co-authors' edits arrive as transactions annotated by the binding and are mapped like any other.
- Widget edits are ordinary transactions with the smallest changes, so provenance (`provenanceForTransactions`), the `Y.UndoManager` scope (your undo never reverts a collaborator) and large-paste splitting behave as in Source mode.
- Suggestions and AI review hunks keep their struck-through and inserted styling; constructs they overlap are revealed ([§5](#5-revealing-the-source-at-the-cursor)). A suggestion fully inside an inline construct's text shows without revealing anything.
- Collaborators' cursors outline the construct they are in, and never reveal it for you.
- Viewers get read-only widgets: chips navigate, formulas and tables do not open editors. Commenters in forced suggest mode can open editors; their writes become suggestions.

### 10. The rest of the LaTeX editor

| Feature | In Visual mode |
|---|---|
| SyncTeX | Positions are source positions, so nothing changes. A jump that lands inside a widget selects the widget and flashes it instead of revealing it. |
| Diagnostics | Lint underlines inside hidden markup would be invisible, so a construct with a diagnostic gets a red outline (widgets) or keeps its underline on the visible text; the gutter is unchanged. |
| Search and replace | Works on the source. Selecting a match inside a construct reveals it through the normal rules. |
| Outline, AI menu, Problems panel, snippets, insert toolbar | Unchanged; they act on the source. An inserted equation opens MathLive straight away. |
| Formula preview tooltip | Shown when a formula is revealed as source (refused by MathLive, or Alt+Enter). |
| Folding | Kept. Line numbers are hidden in Visual mode. |
| Copy | Copies the LaTeX source, as Source mode does. |

### 11. Interface

- An **Editor Mode** submenu (Visual, Source) in the file menu, the ⋯ button at the end of the tab strip that the macOS File menu mirrors, for `.tex` files only, as for Markdown. The choice is stored per tab in `LatexTabViewState.editorMode`, like Markdown's `MarkdownTabViewState.editorMode`.
- Default: Source while the mode is in beta, then a Preferences → LaTeX setting ([decision 2](#decisions)).
- Typography from CSS variables in `globals.css`, next to the existing `.libera-latex-editor` rules: a reading font (serif by default, following the editor font preference), a heading scale, smaller blank lines between paragraphs, an optional centred measure of about 72 characters, and light and dark tokens for chips, outlines and theorem headers.
- Accessibility: formula widgets carry their TeX as `aria-label`, chips say what they point to ("Reference to Section 2.1"), every widget can be opened from the keyboard, and MathLive brings its own speech support.

## Edge cases

### Parsing

- Unbalanced braces while typing: the construct has an error node, so it stays as source until it closes; its argument runs to the end of the file, but well-formed constructs inside it keep rendering ([§8](#8-speed) for the cost).
- `\begin{x}` without its `\end`: the parser marks it with an error node. With the wrong `\end`: the parser accepts it, so the registry compares the two names. Either way the environment stays as source.
- A `$` typed mid-paragraph re-pairs the dollars after it, as far as the paragraph's end; the diff finds and rebuilds that stretch.
- `%` in a construct (a comment between arguments) is skipped; `\%` is a symbol.
- `\verb` with any delimiter, verbatim environments, `\iffalse … \fi` (left as source in the first version).
- `\makeatletter` and `@` in command names inside the preamble or `.sty` files.
- Windows line endings, tabs, very long lines, right-to-left text.

### Editing

- Mode switch with the cursor inside a hidden span or widget: the cursor stays where it is, and the construct is revealed.
- Undo across a mode switch, and undo of a widget edit that a collaborator has since edited around.
- A collaborator deletes a formula you are editing in MathLive: saving reports that it is gone and offers to copy your version.
- Two people editing the same table cell, or one adding a column while the other edits a cell.
- IME composition next to a hidden span; dead keys and accents in headings.
- A paste that contains a half environment (`\begin{itemize}` with no end): pasted as written, shown as source.

### Macros and numbering

- A macro redefined in the body: uses before the redefinition keep the old meaning.
- A macro that expands to another macro defined in a not-yet-loaded `\input` file: renders once the file loads.
- `\newcommand{\section}…` and other redefinitions of commands the registry knows: the registry's construct is dropped for that command, and uses render through the macro, or as source.
- Exponential bodies (`\def\a{\b\b}\def\b{\c\c}…`): the size cap stops them.
- Chapter files with no compile yet: numbers start at 1 and are marked as local until the `.aux` arrives.
- `\label` inside an `align` row, `\tag{*}`, `subequations`, `\nonumber` on some rows.

## Security

- KaTeX runs with `trust: false` and a `maxExpand` limit, as the preview does now.
- `\href` and `\url` open through the app's link handler, http, https and mailto only.
- Image, `\input` and `.sty` paths resolve inside the notebook only.
- `html2latex` parses with `DOMParser` and produces text; no clipboard HTML is ever inserted into the page.
- MathLive is bundled with its fonts and makes no network requests.

## Phases

Each phase ends with its tests passing on the corpus and on CI.

1. **Spikes and decisions.** See [spikes](#spikes). Exit: the package's trees are good enough on the corpus, MathLive round trip confirmed or ruled out, the remaining decisions made.
2. **Adopt the package and swap the language.** Install `codemirror-lang-latex` pinned, wrap its parser in our language with our style tags, folding and indentation, add the flag, measure the bundle, add the licence notice. Source mode moves to the new language. Exit: highlighting and folding parity tests pass, the incremental-equals-fresh property holds over random edits, and the tree snapshots are recorded.
3. **Visual core, read-only rendering.** Mode switch and view state, registry, structural and style layers, reveal, atomic ranges, headings, inline styles, lists, symbols, KaTeX formulas, chips with keys, figures with previews, tables drawn read-only, preamble block, keyboard fixes, styling. Exit: every corpus document opens in Visual mode, and the "no document changes" property holds.
4. **Speed and collaboration.** Incremental diff, pieces for long files, tree-growth handling, the benchmark and its budgets, remote outlines, suggestion and review reveal, viewer and suggest-mode behaviour. Exit: budgets met; two-user end-to-end test passes.
5. **Macros and numbering.** Definition sources and forms, expansion, fragment renderer, macro widgets, theorems and user environments, the numbering pass, numbered chips and equations, `.aux` labels from the compile, the preamble block's counts and problems, the source-mode preview on the new engine, and the shared macro core. Exit: macro tests pass, and numbers match the compiled `.aux` on the corpus where TeX is installed.
6. **Editing widgets.** MathLive with token-diff write-back and conflicts, table editing, figure popover, tree-aware formatting, paste. Exit: write-back tests pass; every widget edit is one undo step.
7. **Polish and documentation.** Transparent arguments, package shims, the default-mode preference, `docs/features/latex-visual-editor.md`, updates to `docs/features/latex-editor.md` and the README.

Macros come before the editing widgets because they change what every widget draws, and MathLive needs the definitions.

### Spikes

- **Parser on real documents.** Parse a corpus of about 20 real documents (thesis, `amsart`, IEEE, Beamer, a book with chapters) with `codemirror-lang-latex` and measure error nodes per document, full-parse time for 500 KB, incremental-parse time per keystroke, and the cost of an unclosed brace near the top of the file. Check that its environment context tracker lets fragments be reused, and list constructs the registry must recognise by name because the grammar has no node for them.
- **MathLive.** Bundle and font size in the Electron build; round trip of 200 formulas from the corpus through the token diff (how many are byte-identical untouched, how many minimal after a small edit); non-expanding macros written back by name; offline fonts.
- **Reveal and atomic ranges.** A prototype with three constructs (bold, inline math, heading) to settle the policies in [§5](#5-revealing-the-source-at-the-cursor) with real cursor movement, before the registry grows.

## Testing

- **Parser**: tree snapshots of the package's output for a fixture corpus in `scripts/editor/fixtures/latex/`, which are the gate for upgrading the package; a property test that an incrementally parsed tree equals a fresh parse after random edits; highlighting and folding parity with the stream tokenizer on the corpus.
- **Visual invariants** (fast-check): random documents, edits, cursor moves, scrolls and mode switches never change the document; every hidden range lies inside a recognised construct; incrementally maintained decorations equal a full rebuild (the property that keeps the diff honest); reveal agrees with `atomicRanges`.
- **Reveal**: innermost-wins, edge behaviour, line policy, suggestion overlap, remote cursors.
- **Write-back**: the token diff against MathLive's known rewrites; table operations including `\multicolumn`, one-undo-step checks; `html2latex` on clipboard captures from Word, Google Docs and web pages; tree-aware bold toggling.
- **Macros**: the categories of `markdown-macros.test.ts` carried over (forms, problems, math and text expansion, nesting and recursion limits, escapes, comments), plus optional arguments, `\def`, xparse, environments, theorem styles and counters; numbering compared with the compiled `.aux` on the corpus, skipped when TeX is absent.
- **Collaboration**: the two-user end-to-end test extended with remote outlines, a concurrent formula edit (conflict prompt) and a concurrent table edit.
- **Performance**: `npm run bench:latex-visual` with the budgets in [§8](#8-speed).
- New test files run under `npm run test:editor`: `latex-parser.test.ts`, `latex-visual.test.ts`, `latex-visual-reveal.test.ts`, `latex-macros.test.ts`, `latex-numbering.test.ts`, `latex-math-diff.test.ts`, `latex-table-model.test.ts`, `latex-html2latex.test.ts`.

## Files

New:

- `src/lib/latex/codemirror/latex-language.ts`: the language around the package's parser, with our style tags, folding and indentation
- `src/lib/latex/codemirror/visual/`: `index.ts` (the extension and its compartment), `constructs.ts`, `decorations.ts`, `structural.ts`, `style.ts`, `reveal.ts`, `collab.ts`, `render-fragment.ts`, `widgets/` (`math.ts`, `chips.ts`, `figure.ts`, `table.ts`, `list.ts`, `symbols.ts`, `macro.ts`, `theorem.ts`, `preamble.ts`), `editing/` (`keymap.ts`, `format.ts`, `math-edit.ts`, `tex-tokens.ts`, `table-model.ts`, `table-edit.ts`, `html2latex.ts`)
- `src/lib/latex/macros/`: `definitions.ts`, `sources.ts`, `expand.ts`, `numbering.ts`, `katex.ts`
- `src/lib/latex/aux-file.ts`
- `src/lib/macros/core.ts`
- `scripts/editor/latex-visual-bench.ts`, the test files above, the fixture corpus
- `docs/features/latex-visual-editor.md`

Changed:

- [latex-editor.tsx](../src/components/libera/latex/latex-editor.tsx): the visual compartment and `editorMode` prop; the new language for `.tex`.
- [latex-workspace.tsx](../src/components/libera/latex/latex-workspace.tsx): the mode switch, `macroSources`, `.aux` labels.
- [latex-insert-toolbar.tsx](../src/components/libera/latex/latex-insert-toolbar.tsx): active states, heading picker, MathLive on equation insert.
- [types.ts](../src/components/libera/types.ts): `LatexTabViewState.editorMode`.
- [editing.ts](../src/lib/latex/codemirror/editing.ts): `LatexProjectData.macroSources`; tree-aware helpers.
- [preview.ts](../src/lib/latex/codemirror/preview.ts) and [math.ts](../src/lib/latex/codemirror/math.ts): macros from the new engine; `readPreviewMacros` removed.
- [language.ts](../src/lib/latex/codemirror/language.ts): kept for `.bib` and behind the flag; `latexFoldRange` replaced by tree folding.
- [build.ts](../src/lib/latex/build.ts) and the compile route: labels and citation labels from the `.aux` in the response.
- [markdown-macros.ts](../src/lib/markdown-macros.ts) and [project.ts](../src/lib/latex/project.ts): primitives from `src/lib/macros/core.ts`.
- `src/app/globals.css`: Visual mode styles.
- `package.json`: `codemirror-lang-latex` pinned to `0.6.1`, `@lezer/lr` and `@lezer/common` as direct dependencies, `mathlive`; script `bench:latex-visual`.
- Licence notices: the README and the app's About information name `codemirror-lang-latex` and its AGPL-3.0-or-later licence. Libera has no third-party notices page yet; this may be the reason to add one.

## Decisions

Decided:

1. **Parser: `codemirror-lang-latex`** (7 Nov 2026). Its parser is used, pinned, unforked, with Libera's own style tags and none of the package's other extensions. It is AGPL-3.0-or-later, so Libera as distributed (the desktop app, and any hosted deployment that serves the editor) has to meet that licence's terms, including offering the corresponding source to its users.

2. **Default mode: Source** while Visual is in beta, with a per-tab switch; a Preferences → LaTeX default later. (Markdown opens in Visual by default.)
3. **Heading reveal: the line policy.** Headings are edited with their markup hidden, and show it only when the cursor is at the line start or the whole heading is selected. The touch policy, which would show `\section{…}` whenever the cursor is in the title, was not chosen.
4. **MathLive: adopted**, loaded on the first formula edit, subject to the spike's size and round-trip results. If the spike rules it out, formulas are edited as source with the live KaTeX preview.
5. **Numbers from the `.aux`: yes.** The compile response gains labels and citation labels, so chips show exact numbers for labels in other files and numeric citations.

## What changed while building

**Spikes.** The paper used for testing (*Attention Is All You Need*, ten `.tex` files) parses with one error node, a starred `\newcommand*` the grammar does not know; the definitions reader handles it. A 500 KB document parses in about 9 ms and a keystroke's incremental parse in about 3 ms, and incremental parses equal fresh ones. MathLive's minified bundle is about 830 KB; it draws with the KaTeX fonts the page already loads (`fontsDirectory = null`), and a math field must be in the page before its macros are set.

**Speed.** The budgets are met for the Visual mode's own work, timed on state updates (jsdom cannot measure layout and draws far more than a browser, so the view's update is printed for information only): 0.5 ms median and 1.1 ms at the 95th percentile per keystroke, 21 ms for the first build, 7.4 ms for the slowest idle piece, 3 ms for a `$` that re-pairs a paragraph. To get there:
- Pieces are 8,000 characters, and the first build reaches 8,000 characters on each side of the cursor (the plan said 12,000).
- Plain typing rebuilds only its lines. An edit is followed forward only when it involves `$`, braces, backslashes, brackets, `%`, a line break, or letters of a command or environment name.
- Where the body starts (`\begin{document}`) is mapped through edits instead of being searched for on every keystroke.
- The walk skips the many node types it does not handle without building node objects, and `\maketitle`'s title scan is limited and cached.

**Done earlier than planned.** A chapter's numbering continues from its main file now, not in a later phase (`project-numbering.ts`, from the main file's body with the files it includes before the chapter). Transparent macro arguments are in, for macros of one to four arguments used once each, in order, in text.

**Different from the plan.**
- Equation numbers are set on KaTeX's own number slots (`.eqn-num`), because KaTeX numbers with a CSS counter and allows only one `\tag` per environment. `multline` is drawn as gathered lines with one number, `eqnarray` as `align`.
- Numbering runs 150 ms after typing stops, and number widgets update in place without rebuilding decorations.
- A construct over a compile error is revealed as source, so the error's underline shows, instead of getting a red outline.
- `readPreviewMacros` stays as the formula preview's fallback when the Visual state is not installed; with it, the preview expands macros with the new engine.
- Clipboard HTML that only wraps text in `div` and `span` (code editors) pastes as plain text.
- The mode effect compares with the view's compartment, not with the last mode it applied, so a recreated view (hot reload) follows the switch.
- The mode is chosen from the file menu's **Editor Mode** submenu, as for Markdown, not from a toolbar switch.
- Installing packages with npm unlinks the `.platform-deps` native bindings on Windows; `npm run deps:setup` restores them.

**After the review (medium issues 13–66).**
- Definitions are read the way TeX runs the source. A forward scan (`TexScanner` in `definitions.ts`) skips comments, verbatim environments, `\verb`, the false branch of `\iffalse`/`\iftrue` and other definitions' bodies; local definitions end with their group (`{…}`, `\begingroup…\endgroup`, an environment other than `document`), `\gdef`, `\global` and xparse's definitions do not. A definition under a conditional the reader cannot evaluate (`\ifx`, `\ifdefined`, a `\newif` flag) and an unsupported redefinition (`\edef`, delimited parameters) hide the earlier meaning: their uses stay source. `\let` to a command the reader does not know is an alias whose uses stay source before arguments. `\renewcommand` of a built-in (`\textbf`, `\section`) draws the document's macro instead of the built-in; `\providecommand` of one does not.
- Each definition's extent in the open file is kept: an edit inside a multi-line body re-reads the definitions, the walk skips a definition the grammar ends early (`\newcommand*`), and other edits map the positions (the fingerprint stays, so nothing is rebuilt).
- Other files are read where they are loaded (`collectLatexDefinitions`, `MacroSource.loadedBy` and `key`), through nested `\input`s and local packages, from live tab text (shared tabs through the registry), and read again when any of them changes. They, included chapters and graphics resolve from the compile root's directory; graphics also through `\graphicspath`.
- Text expansion expands math inside `$…$`, `\(…\)`, `\[…\]` and `\ensuremath`; substitution keeps control words apart from letters (`\alpha#1` with `x` is `\alpha x`); group readers and argument reading skip comments.
- Numbering: labels inside captions and footnotes; footnotes printed alone in book classes, `\footnote[n]`, endnotes; `\counterwithin*` and `\newcounter[…]` reset without a prefix; no row for a final `\\` in amsmath environments (eqnarray keeps it); commented commands ignored; `secnumdepth`, `subequations` and a custom `\theequation` (counter commands only; anything else prints "?"); `\setcounter{enumi}` and custom item labels shared by markers and references; nested item references with LaTeX's prefixes; `\input`/`\include`d files advance the numbers. Explicit `\tag`s are left to KaTeX, starred environments too.
- A figure or table is drawn as one widget only when it holds nothing else than images, tables, one caption, labels and layout commands; otherwise it stays source and its parts render on their own.
- An edit in a container larger than the synchronous budget walks its own lines now and leaves the rest of the container pending; text the parser has not reached stays pending. Body text on the `\begin{document}` line is not folded; an edit to `\title`, `\author` or `\date` redraws `\maketitle`.
- Widget edits are one undo step in local, shared and suggest-mode histories (`src/lib/collab/undo-boundary.ts`). Formula and cell editors and the table menu close with their view and recheck permissions before writing; a deleted formula is not written back (the draft can be copied); a redrawn table continues an open cell edit; cell saves write only the characters that changed. Buttons act on click, so Enter and Space work; the table menu and formula dialog work from the keyboard; Enter follows a selected reference and opens a selected table's first cell.
- Paste: link URLs are percent-encoded so they cannot leave `\href`; MathML TeX that could leave its formula or read files, and `<pre>` text containing `\end{verbatim}`, paste as escaped text.

**Not done.**
- From the review: column-spec descriptors (`>{…}`) when a column is deleted, and the rest of the table column model, are left to the high-priority table fixes. A redefined `\section` is drawn as the macro, but numbering still counts it as a section.
- A SyncTeX jump into a formula or chip shows its source; it does not select and flash the widget.
- An equation inserted from the toolbar does not open MathLive by itself.
- `longtable` and `xltabular` stay as source, as planned for the first version.
- The Preferences → LaTeX default mode (decision 2 left it for later), Expand macros for LaTeX, `.tex` macros in the AI Chat, macros in Markdown-to-LaTeX export, and package shims remain follow-ups (§7.10).
