# LaTeX Visual mode

A `.tex` file can be read and edited as formatted text: headings, bold and italic text, lists, formulas, figures, tables, theorems and references drawn as they will look in the PDF. The file stays plain LaTeX. Visual mode is a layer drawn over the same editor and the same text: it hides markup and draws widgets, and where the cursor is, the LaTeX comes back. Nothing is converted back and forth, so the Visual mode never reformats the file; switching modes, moving the cursor or a collaborator's edit changes no byte of it.

Switch with **Source | Visual** in the LaTeX toolbar. The choice is kept per tab, and Source is the default.

## What is drawn

| In the file | In Visual mode |
| --- | --- |
| `\section{…}` and the other headings, starred too | A heading with its number (`2.1 Method`); a `\label` right after it is hidden. `\paragraph` stays a run-in bold title. |
| `\textbf`, `\textit`, `\emph`, `\underline`, `\texttt`, `\textsc`, `\textsf`, `\sout`, `\textsuperscript`, `\textsubscript`, `\textcolor`, `\colorbox` | Styled text; the markup is hidden |
| `\href`, `\url` | A link; ⌘/Ctrl-click opens it |
| `\footnote{…}` | A superscript number and the footnote in small grey text |
| `$…$`, `\(…\)`, `$$…$$`, `\[…\]`, `equation`, `align`, `gather`, `multline`, `alignat`, `flalign`, `eqnarray` | The formula, typeset by KaTeX, with its equation numbers |
| `\cite` and its natbib/biblatex variants | A chip: `[12]` from the last compile, or author and year from the `.bib` files and References |
| `\ref`, `\eqref`, `\cref`, `\Cref`, `\autoref`, `\pageref`, `\nameref` | A chip with the number: `2.1`, `(3)`, `eq. (3)`, `Figure 1`, `Section 2`. Click to jump to the label. |
| `\label` elsewhere | A small grey tag |
| `figure`, `table`, `\includegraphics` | The image (PNG, JPEG, SVG, or a PDF's first page) and the numbered caption; tables as grids |
| `tabular`, `tabularx`, `tabular*` | A grid, with `\multicolumn` and rules |
| `itemize`, `enumerate`, `description` | Bullets and numbers per level (`[(i)]` and enumitem `label=` too); the `\begin` and `\end` lines fold away |
| Theorems from `\newtheorem`, `proof`, `abstract`, `quote`, `center`, user `\newenvironment`s | Headings such as **Theorem 2.1** (Pythagoras), ∎ at the end of a proof, theorem bodies in their style |
| `\maketitle` | The title, authors and date |
| The preamble | A folded block: **Preamble · article · 12 packages · 8 macros · 2 theorem types**. Click it to see the source. |
| `\%`, `\&`, `\ldots`, `--`, `---`, ` `` ''`, `~`, accents such as `\'e`, `\LaTeX`, `\today` | The characters they typeset |

Anything else stays as LaTeX: unknown commands, unclosed braces, environments missing their `\end` or ending with the wrong one, verbatim and code listings, `tikzpicture`, `longtable`, comments. A command with broken braces stays as source, but formulas and formatting inside it still render, so one stray brace does not undo the rest of the page.

## Seeing and editing the source

- **Inline formatting** (bold, links, footnotes) shows its markup while the cursor touches it.
- **Headings** are edited in place with their markup hidden. Put the cursor at the start of the line (Home) to see `\section{…}`.
- **Formulas, chips, figures and tables** stay drawn with the cursor at their edge, and move, select and delete as one block. Backspace next to one selects it first; a second Backspace deletes it.
- **Alt+Enter** shows the source of whatever is at the cursor (a bullet, a symbol) until the cursor leaves it. Alt-click does the same on a widget.
- Typing is ordinary LaTeX editing: autocompletion, snippets, environment renaming and bracket closing work as in Source mode.

### Formulas

Click a formula to edit it in MathLive, a visual equation editor. Enter saves, Escape cancels. Only the parts you changed are written: MathLive's own spellings (`x^{2}` for `x^2`, its spacing) do not leak into the file. The document's macros work in it and are written back by name. If a co-author changed the formula while you were editing, Libera asks before replacing their version.

Some formulas open as source instead, because MathLive would change them: formulas over several lines, or with `\label`, `&`, `\\` or a `%` comment, or using a macro with an optional argument. The live KaTeX preview appears under them.

### Tables

Click a cell to edit its LaTeX; Enter or Tab saves (Tab moves to the next cell), Escape cancels. Only that cell's text is rewritten. Right-click a cell to insert or delete rows and columns; each command is one undo step and writes the fewest changes (one row, or one `&` per row and one letter in the column specification). Cells with a comment or a line break inside are edited as source.

### Formatting and paste

⌘B, ⌘I, ⌘U, ⌘⇧E and ⌘⇧T, and the toolbar's Bold and Italic, wrap the selection, or remove the wrapper when the cursor is already inside one. Pasting from Word, Google Docs or a web page converts the rich text to LaTeX: headings, lists, tables, links and formatting keep their structure, special characters are escaped, symbols such as α and ≤ become `$\alpha$` and `$\le$`, and anything else is dropped. Plain text pastes as it is.

### Keyboard details

- At the end of a heading the cursor stays before the hidden `}`, so typing stays in the heading; moving right from there goes to the next line.
- The cursor never lands before a bullet.
- A letter typed right after a hidden `\ldots` gets a space first, so the command keeps its name.

## Macros, environments and numbering

The Visual mode reads the document's own definitions, as the [Markdown macros](markdown-macros.md) do for notes: from the preamble, from macro files the preamble `\input`s, from local `.sty` packages it loads, and, for a chapter, from its main file's preamble. Definitions in the body apply from where they are written.

- **Math macros** (`\newcommand{\R}{\mathbb{R}}`, `\DeclareMathOperator`, `\def`, optional arguments, `\NewDocumentCommand` with `m`, `o`, `O{…}` and `s` arguments) are substituted into formulas before they are typeset, in the Source mode's preview too.
- **Text macros** show their expansion, faintly underlined, until the cursor is inside them. A macro whose body uses each argument once, in order, in text (`\newcommand\todo[1]{\textcolor{red}{[[#1]]}}`) keeps its argument editable in place: the fixed parts are drawn around it and the argument takes the body's style.
- **Theorems** from `\newtheorem` (shared counters, `[section]`, `\theoremstyle`, starred) and **environments** from `\newenvironment` draw their headings.
- **Numbering** follows the document: sections (letters after `\appendix`), equations (per row of `align`, with `\tag`, `\nonumber`, `\numberwithin`), figures, tables, theorems, footnotes and enumerated items, chapter-prefixed in book and report classes. A chapter continues from where its main file includes it. Labels in other files, page references and numeric citations come from the last compile's `.aux`.

Forms that cannot be rendered safely (delimited `\def` parameters, `\edef`, other xparse argument types) are listed as not rendered, and their uses stay as source. The preamble block counts a definition with a mistake (a body using `#3` in a two-argument macro) as a problem.

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
- `latex-editor.tsx` switches the mode with a compartment; `latex-workspace.tsx` supplies macro sources, `.aux` labels and a chapter's starting counters.

The design and its decisions are in [the plan](../latex-visual-editor-plan.md).

## Checks

```bash
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/latex-parser.test.ts scripts/editor/latex-macros.test.ts scripts/editor/latex-visual.test.ts scripts/editor/latex-visual-editing.test.ts
npm run bench:latex-visual
```

The parser tests are the gate for upgrading `codemirror-lang-latex`: the fixture's tree snapshot (`UPDATE_LATEX_SNAPSHOT=1` rewrites it after you have checked the new tree), incremental parses equal to fresh ones, and Source mode's colours. The Visual tests check rendering, numbering, reveal, keyboard behaviour, transparent macros, building long documents in pieces, and two properties over random edits: incremental updates equal a fresh build, and nothing but an edit changes the document. The editing tests cover the token diff (a property test: a diff applied to the original typesets as the edited formula), the table model and the paste converter. The benchmark checks the budgets on a 500 KB document: under 1 ms median and 4 ms at the 95th percentile per keystroke, under 30 ms for the first build, under 8 ms per idle piece.
