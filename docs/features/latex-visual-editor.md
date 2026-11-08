# LaTeX Visual mode

A `.tex` file can be read and edited as formatted text: headings, bold and italic text, lists, formulas, figures, tables, theorems and references drawn as they will look in the PDF. The file stays plain LaTeX. Visual mode is a layer drawn over the same editor and the same text: it hides markup and draws widgets, and where the cursor is, the LaTeX comes back. Nothing is converted back and forth, so the Visual mode never reformats the file; switching modes, moving the cursor or a collaborator's edit changes no byte of it.

Switch with **Editor Mode → Visual** or **Source** in the file menu (the ⋯ button at the end of the tab strip, also the File menu on macOS), as for Markdown files. The choice is kept per tab, and Source is the default.

## What is drawn

| In the file | In Visual mode |
| --- | --- |
| `\section{…}` and the other headings, starred too | A heading with its number (`2.1 Method`); a `\label` right after it is hidden. `\paragraph` stays a run-in bold title. |
| `\textbf`, `\textit`, `\emph`, `\underline`, `\texttt`, `\textsc`, `\textsf`, `\sout`, `\textsuperscript`, `\textsubscript`, `\textcolor`, `\colorbox` | Styled text; the markup is hidden |
| `\href`, `\url` | A link; ⌘/Ctrl-click opens it |
| `\footnote{…}` | A superscript number and the footnote in small grey text |
| `$…$`, `\(…\)`, `$$…$$`, `\[…\]`, `equation`, `align`, `gather`, `multline`, `alignat`, `flalign`, `eqnarray` | The formula, typeset by KaTeX, with its equation numbers |
| `\cite` and its natbib/biblatex variants | A chip: `[12]` from the last compile, or author and year from the `.bib` files and References, with accents decoded (`Boli\'c` is Bolić). A `\let\cite\textcite` in the preamble cites the way its target does. Click it to edit its keys. |
| `\ref`, `\eqref`, `\cref`, `\Cref`, `\autoref`, `\pageref`, `\nameref` | A chip with the number: `2.1`, `(3)`, `eq. (3)`, `Figure 1`, `Section 2`. Click to jump to the label. |
| `\label` elsewhere | A small grey tag |
| `figure`, `table`, `\includegraphics` | The image (PNG, JPEG, SVG, or a PDF's first page) and the numbered caption; tables as grids. A drawing the editor cannot typeset (a `tikzpicture`, or a file brought in with `\input` or `\includestandalone`, also inside `\resizebox` or `\scalebox`) is a placeholder naming its file; the PDF shows it. A figure holding anything else (text, other commands, sub-figures) stays source, with its parts drawn on their own. Images are found from the main file's directory and `\graphicspath`, as TeX finds them. |
| `tabular`, `tabularx`, `tabular*` | A grid, with `\multicolumn` and rules (`\addlinespace` adds space, not a line). Rows written through the document's own macros (`\row{a}{b}` for `a & b \\`) are drawn from their expansion; such a table is edited as source. |
| `longtable`, `xltabular` | A numbered table: the caption, the first head, the body and the last foot (the head and foot repeated on later pages are left out). Rows written through macros are expanded. Click it to edit its source. |
| `\textcircled{1}` | ① (digits up to 20 and letters); size switches such as `\small` draw nothing |
| `itemize`, `enumerate`, `description` | Bullets and numbers per level (`[(i)]` and enumitem `label=` too); the `\begin` and `\end` lines fold away |
| Theorems from `\newtheorem`, `proof`, `abstract`, `quote`, `center`, user `\newenvironment`s | Headings such as **Theorem 2.1** (Pythagoras), ∎ at the end of a proof, theorem bodies in their style |
| `\maketitle` | The title, authors and date |
| The preamble | A folded block: **Preamble · article · 12 packages · 8 macros · 2 theorem types**. Click it (or press Enter on it) to see the source. Text after `\begin{document}` on the same line stays visible. |
| `\%`, `\&`, `\ldots`, `--`, `---`, ` `` ''`, `~`, accents such as `\'e`, `\LaTeX`, `\today` | The characters they typeset. An accent shows its source while the cursor touches it, so `\c` typed on the way to `\cite` is not drawn as a cedilla. |

Anything else stays as LaTeX: unknown commands, unclosed braces, environments missing their `\end` or ending with the wrong one, verbatim and code listings, a `tikzpicture` outside a figure, comments. A command with broken braces stays as source, but formulas and formatting inside it still render, so one stray brace does not undo the rest of the page.

## Seeing and editing the source

- **Inline formatting** (bold, links, footnotes) shows its markup while the cursor touches it.
- **Headings** are edited in place with their markup hidden. Put the cursor at the start of the line (Home) to see `\section{…}`.
- **Formulas, chips, figures and tables** stay drawn with the cursor at their edge, and move, select and delete as one block. Backspace next to one selects it first; a second Backspace deletes it.
- **Alt+Enter** shows the source of whatever is at the cursor (a bullet, a symbol) until the cursor leaves it. Alt-click does the same on a widget.
- **Text** uses the visual editors' settings, as the TipTap editor does: the typeface of the visual theme (Preferences → Markdown → Themes) and the Markdown text size and line height. The triangle above the text sets the page width, shared with the Markdown editors.
- Typing is ordinary LaTeX editing: autocompletion, snippets, environment renaming and bracket closing work as in Source mode.

### Formulas

Click a formula (or select it and press Enter) to edit it in MathLive, a visual equation editor. Enter saves, Escape cancels, and Tab moves between the field and the buttons. Only the parts you changed are written, as one undo step: MathLive's own spellings (`x^{2}` for `x^2`, its spacing) do not leak into the file. The document's macros work in it, with the macros they use, and are written back by name. If a co-author changed the formula while you were editing, Libera asks before replacing their version; if they deleted it, nothing is written and you can copy your version.

Some formulas open as source instead, because MathLive would change them: formulas over several lines, or with `\label`, `&`, `\\` or a `%` comment, or using (directly or through another macro) a macro with an optional argument. The live KaTeX preview appears under them.

### Tables

Click a cell (or select a table and press Enter) to edit its LaTeX; Enter or Tab saves (Tab moves to the next cell), Escape cancels. Only the characters you changed are written. If a co-author edits the table meanwhile, your cell stays open with what you typed. Right-click a cell to insert or delete rows and columns (the menu works with the arrow keys too); each command is one undo step and writes the fewest changes (one row, or one `&` per row and one letter in the column specification). Cells with a comment or a line break inside are edited as source.

### Formatting and paste

⌘B, ⌘I, ⌘U, ⌘⇧E and ⌘⇧T, and the toolbar's Bold and Italic, wrap the selection, or remove the wrapper when the cursor is already inside one. Pasting from Word, Google Docs or a web page converts the rich text to LaTeX: headings, lists, tables, links and formatting keep their structure, special characters are escaped, symbols such as α and ≤ become `$\alpha$` and `$\le$`, and anything else is dropped. Rich text goes through the same converter, settings and dialog as [pasted Markdown](latex-editor.md#pasting-markdown): with headings or tables, the dialog asks how to write them; otherwise a notice offers the plain text instead. Pasted links, formulas and code cannot break out of what they become: a TeX formula that could (or that reads files) pastes as text. Plain text pastes as it is, unless it is Markdown.

### Keyboard details

- At the end of a heading the cursor stays before the hidden `}`, so typing stays in the heading; moving right from there goes to the next line.
- The cursor never lands before a bullet.
- A letter typed right after a hidden `\ldots` gets a space first, so the command keeps its name (at every cursor).
- Select a reference chip and press Enter to go to its label.

## Macros, environments and numbering

The Visual mode reads the document's own definitions, as the [Markdown macros](markdown-macros.md) do for notes: from the preamble, from macro files the preamble `\input`s (and the files they input), from local `.sty` packages it loads, and, for a chapter, from its main file's preamble, in the order TeX reads them, and again when one of those files changes. Definitions in the body apply from where they are written. Definitions follow TeX's rules:

- A definition inside a group (`{…}`, `\begingroup…\endgroup`, an environment) ends with the group; `\gdef` and `\global` ones do not.
- Definitions TeX does not run are not read: in comments, `verbatim`, `\verb`, the false branch of `\iffalse`, or inside another definition's body.
- A definition under a condition the Visual mode cannot decide (`\ifx`, `\ifdefined`, a `\newif` flag) hides the macro's earlier meaning: its uses stay source. So does a redefinition that cannot be rendered.
- Redefining one of LaTeX's commands (`\renewcommand{\textbf}…`) draws the new definition instead of the built-in one.

- **Math macros** (`\newcommand{\R}{\mathbb{R}}`, `\DeclareMathOperator`, `\def`, optional arguments, `\NewDocumentCommand` with `m`, `o`, `O{…}` and `s` arguments) are substituted into formulas before they are typeset, in the Source mode's preview too.
- **Text macros** show their expansion, faintly underlined, until the cursor is inside them. A macro whose body uses each argument once, in order, in text (`\newcommand\todo[1]{\textcolor{red}{[[#1]]}}`) keeps its argument editable in place: the fixed parts are drawn around it and the argument takes the body's style.
- **Theorems** from `\newtheorem` (shared counters, `[section]`, `\theoremstyle`, starred) and **environments** from `\newenvironment` draw their headings.
- **Macros that write structure** are expanded before it is read, for numbering and drawing alike. A macro for a heading (`\newcommand{\mysec}[1]{\section{#1}}`) is a numbered heading; one for `\item` is the list's next item; `\label`, `\caption` and `\footnote` written by a macro register, caption the figure and number the note; a row break in `align` written as `\nl` numbers its row. A macro for a whole environment (`\newcommand{\thm}[1]{\begin{theorem}#1\end{theorem}}`) and a pair that opens and closes one (`\newcommand{\beq}{\begin{equation}}` with `\eeq`) are drawn as that environment, numbered. All of these are drawn from the expansion, read-only: a click shows the source. A `\footnote` inside a definition's body is not counted.
- **Numbering** follows the document: sections (letters after `\appendix`, `secnumdepth`), equations (per row of `align`, with `\tag`, `\nonumber`, `\numberwithin`, `subequations`), figures, tables, theorems, footnotes (`\footnote[n]`, endnotes) and enumerated items (with `\setcounter{enumi}` and custom labels), chapter-prefixed in book and report classes. A chapter continues from where its main file includes it, and a main file's numbers count the chapters it `\input`s or `\include`s. A custom `\theequation` built from counter commands is followed; one that uses anything else shows "?". Labels in other files, page references and numeric citations come from the last compile's `.aux`.

Forms that cannot be rendered safely (delimited `\def` parameters, `\edef`, other xparse argument types, `\let` to a command whose arguments are unknown) are listed as not rendered, and their uses stay as source. The preamble block counts a definition with a mistake (a body using `#3` in a two-argument macro) as a problem.

## Collaboration, suggestions and review

Shared tabs need nothing extra: the Visual mode is drawn over the same shared text. Co-authors' edits appear as they are typed, and each collaborator's cursor outlines the construct it is in (it never opens it for you). Pending suggestions, AI review changes and compile errors show the constructs under them as source, so their strike-through, insertions and underlines are visible. Viewers can read but not open editors; commenters in suggest mode can, and their edits become suggestions.

## Implementation

- Parser: `codemirror-lang-latex` (AGPL-3.0-or-later, pinned), wrapped with Libera's colours, indentation and folding in `src/lib/latex/codemirror/latex-language.ts`. `localStorage["libera.latexParser"] = "stream"` switches `.tex` back to the old tokenizer (`language.ts`), which `.bib` files keep.
- `src/lib/latex/codemirror/visual/`:
  - `walk.ts`: one walk over the tree that recognises each construct and says what to hide, style and draw.
  - `structural.ts`: hidden markup and widgets for the whole document, in a state field that also gives the atomic ranges and decides what is revealed at the cursor. Edits map the set and rebuild only the lines and constructs they touch; edits with `$`, braces, backslashes, comments or line breaks are followed forward until the old and new constructs agree again. Documents over 60,000 characters are built 8,000 characters at a time, the part around the cursor first, the rest while idle (`plugins.ts`).
  - `style.ts`: marks and line classes for what is on screen.
  - `widgets.ts`, `render-fragment.ts` (captions, expansions, cells), `math-render.ts` (KaTeX, numbers set on KaTeX's number slots), `symbols.ts`, `references.ts`.
  - Editing: `keys.ts`, `math-edit.ts` with `tex-tokens.ts` (MathLive and the token diff), `table-model.ts` and `table-edit.ts`, `html2latex.ts` and `paste.ts`, `transparent.ts`.
  - `model.ts`: definitions, numbering, `.aux` data and the preamble toggle, kept in both modes.
- `src/lib/latex/macros/`: `definitions.ts`, `expand.ts`, `numbering.ts`, `project-numbering.ts`. `src/lib/latex/aux-file.ts` reads `\newlabel` and `\bibcite`; the compile response carries them (`build.ts`). `src/lib/macros/core.ts` holds the primitives shared with the Markdown macros.
- `latex-editor.tsx` switches the mode with a compartment; `latex-workspace.tsx` supplies macro sources, the files the body includes, `.aux` labels and a chapter's starting counters, read by `latex-dependencies.ts`. `src/lib/collab/undo-boundary.ts` makes a widget's edit one undo step in every history.

The design and its decisions are in [the plan](../latex-visual-editor-plan.md).

## Checks

```bash
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/latex-parser.test.ts scripts/editor/latex-macros.test.ts scripts/editor/latex-visual.test.ts scripts/editor/latex-visual-editing.test.ts
npm run bench:latex-visual
```

The parser tests are the gate for upgrading `codemirror-lang-latex`: the fixture's tree snapshot (`UPDATE_LATEX_SNAPSHOT=1` rewrites it after you have checked the new tree), incremental parses equal to fresh ones, and Source mode's colours. The Visual tests check rendering, numbering, reveal, keyboard behaviour, transparent macros, building long documents in pieces, and two properties over random edits: incremental updates equal a fresh build, and nothing but an edit changes the document. The editing tests cover the token diff (a property test: a diff applied to the original typesets as the edited formula), the table model and the paste converter. The benchmark checks the budgets on a 500 KB document: under 1 ms median and 4 ms at the 95th percentile per keystroke, under 30 ms for the first build, under 12 ms per idle piece.
