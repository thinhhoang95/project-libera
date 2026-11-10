# LaTeX editor

`.tex`, `.bib`, `.sty` and `.cls` files open in a CodeMirror 6 source editor (`src/components/libera/latex/`). A `.tex` file is shown beside its compiled PDF, like the Markdown source editor and its preview. Create one from a notebook's menu, a folder's menu ("Add LaTeX Document"), or the notebook home ("New LaTeX"); new `.tex` files start from a small article template.

## Editing

`.tex` files are parsed by `codemirror-lang-latex` (`src/lib/latex/codemirror/latex-language.ts`), which gives one syntax tree for the highlighting, folding and the [Visual mode](latex-visual-editor.md); **Editor Mode** in the file menu (⋯ at the end of the tab strip, or File on macOS) switches between the LaTeX as written and formatted text, formulas and figures over the same file. `.bib` files keep a stream tokenizer (`src/lib/latex/codemirror/language.ts`), which `.tex` files can also use with `localStorage["libera.latexParser"] = "stream"`. Typing `}` to finish `\begin{name}` inserts the matching `\end{name}`, with an `\item` for lists. Enter continues a list item, and an empty one ends the list. Renaming one side of an environment renames the other. `{`, `[`, `(` and `$` are closed automatically; after a single backslash they get their escaped partner.

Completion offers commands (math commands rank higher inside math), environments, `\ref` labels from the document and other open files, `\cite` keys from the `.bib` files the main file names, files for `\input`, `\includegraphics` and `\bibliography`, and package and class names. Environments and sections fold. A KaTeX preview of the formula floats under the cursor inside math, with the document's macros expanded (including optional arguments, `\def`, macro files and a chapter's main file); Escape hides it.

Shortcuts: ⌘B, ⌘I and ⌘U wrap the selection in `\textbf`, `\textit` and `\underline`, and ⌘⇧E and ⌘⇧T in `\emph` and `\texttt` (the toolbar's Bold and Italic remove the wrapper when the cursor is inside one). ⌘/ toggles comments, ⌘F opens search and replace, ⌘S saves, ⌘↵ compiles, and ⌘⇧J shows the cursor's spot in the PDF.

## Pasting Markdown

Markdown pasted into a `.tex` file, in Source or Visual mode, becomes LaTeX: from a Libera note or chat, ChatGPT or Claude, GitHub, Obsidian or Notion. Headings become sectioning commands, lists `itemize` and `enumerate`, tables `tabular`, `tabularx` or `longtable`, `**bold**` `\textbf`, `*italic*` `\emph`, formulas stay as written (whether delimited by your math markers from Preferences → Markdown or by `$…$`, `$$…$$`, `\(…\)` and `\[…\]`, they become `$…$` and `\[…\]`), `[@key]` becomes `\cite`, `\citep` or `\parencite` for the bibliography package the preamble loads, footnotes `\footnote`, links `\href`, images figures, and Libera's highlights, colors, boxes and macros their LaTeX equivalents. Special characters are escaped. LaTeX written in the Markdown (`see \ref{fig:1}`) is kept when it uses common text commands or the document's own macros and environments; anything else, and anything that could read or write files, is shown as text. Horizontal rules are dropped. Prices stay text (`$5 and $10` is not a formula), and a `|` inside a formula or code in a table row (`$P(A|B)$`) stays in its cell. HTML written in the Markdown (a README's centred image, `<details>`) converts like pasted rich text. LaTeX, and prose with no Markdown in it, paste as they are, and so does anything pasted inside math, verbatim, a comment or the preamble.

Rich text from Word, Google Docs or a web page converts the same way, in both modes: Word's lists become `itemize` and `enumerate`, and formulas become TeX (from their annotation, or else from their MathML). In Source mode it converts only while Markdown conversion is on, and pastes as written when its text is LaTeX or it is only a code block.

Where the paste lands counts: inside a `table` or `figure`, tables and images get no float of their own (a table's caption is the float's); inside a box (`tcolorbox`, `minipage`, or a callout written as a `tcolorbox`), no caption either; inside a footnote, footnotes are written in parentheses.

When the Markdown has headings or tables, a dialog asks how to write them first, with the LaTeX it will insert beside the choices:

- **Headings**: one row per heading level in the paste. The top one defaults to one level below the section the cursor is in (after `\section{Methods}`, `##` becomes `\subsection`), and the levels below follow. Any row can be `\part` … `\subparagraph`, a bold or plain paragraph, or a custom command (`\frametitle`) or template with `#1` (`\textbf{\large #1}\par`). Options: unnumbered (`\section*`), labels (on by default when the Markdown links to its own headings, which then become `\hyperref`), and removing numbers such as "1.2" that LaTeX writes itself.
- **Tables**: the environment, the rules (booktabs, simple `\hline`s, a grid or none), wrapping long columns, a bold header, the float (`table`, `table*` in two-column documents, or none), its placement, `\centering`, and per table a caption (a "Table 2: …" line next to the table fills it) and a label.
- **More options**: `\emph` or `\textit`, strikethrough, code (`verbatim` or `lstlisting`), display math (`\[…\]`, `equation*`, `equation`), links, quotation marks, block quotes, highlights, and whether to keep LaTeX written in the text.

Markdown with nothing to choose is converted straight away, with a notice that offers **Paste as plain text instead** and **Options…** (both only while the pasted LaTeX is unchanged). Each paste is one undo step, however large; after **Paste as plain text instead**, one Undo still goes back to before the paste. Pastes made in quick succession are handled one after another. If the text a paste replaces, or the selection being converted, is edited (by a collaborator, say) while the dialog is open, nothing is replaced; if the place became math, a comment or verbatim, the paste goes in as plain text. Packages the output needs and the preamble does not load are listed, with a Copy button; nothing is added to the preamble unless you tick "Add to the preamble" in the dialog. The choices are remembered (`/api/preferences/latex-paste`); the dialog's "When pasting Markdown" setting can ask always, never, or stop converting Markdown.

⇧⌘V pastes as plain text, and so does a paste at several cursors. **Paste** in the right-click menu converts as ⌘V does. ⌥⌘V, or **Paste Markdown as LaTeX…** in the right-click menu, opens the dialog for whatever is on the clipboard, and **Convert Markdown to LaTeX…** converts the selection in place. The converter is deterministic (no AI) and lives in `src/lib/latex/markdown-paste/`; the plan is [latex-markdown-paste-plan.md](../latex-markdown-paste-plan.md).

## Compiling

`POST /api/latex/compile` (`src/lib/latex/build.ts`) runs `latexmk` when it works, or the engine directly with BibTeX/Biber passes. The engine is pdfLaTeX unless a `% !TEX program = …` line, a Unicode-only package (`fontspec`, `unicode-math`, …) or the toolbar choice says otherwise. Builds use a private folder per main file under the OS temp directory, so auxiliary files persist and recompiles are incremental. Nothing is written into the notebook.

The editor's unsaved text is compiled: the main file is written into the build folder, and TeX runs from the document's folder. Unsaved drafts of other open `.tex` files are written there too, and TeX's "output directory first" lookup reads them instead of the saved versions. Auto compile runs after a pause in typing, and is on by default per file. When it is off, saving compiles.

A file without `\documentclass` is typeset through its main file: a `% !TEX root = …` line, or else the `.tex` file in the notebook whose `\input`/`\include` graph reaches it (`GET /api/latex/root`).

The compile response also carries the labels and citation labels TeX wrote to the `.aux` files, which the Visual mode uses for references to other files, page references and numeric citations.

Each PDF is copied into an immutable snapshot (the last three are kept) that the viewer and SyncTeX read while the next compile runs. Errors and warnings from the TeX log, BibTeX and Biber are mapped back to notebook files. They appear as editor diagnostics, underlined at the command TeX stopped on, and in the Problems panel with the raw log.

Documents cannot run programs or read outside their folder: TeX runs with `shell_escape=f` and `openin_any=p`/`openout_any=p`. latexmk ignores rc files next to the document (they are Perl) and reads only the user's own.

## SyncTeX

Double-clicking in the PDF jumps to that source line, opening another file of the project when needed. Double-clicking a word in the source scrolls the PDF to it and flashes the spot. Lines are mapped through edits made since the compile, so jumps stay right while typing. `POST /api/latex/synctex` uses the `synctex` command shipped with TeX distributions.

## AI

Right-click in the editor for AI Format (turn plain text, Markdown or pasted PDF text into LaTeX), AI Rewrite and Write with AI. These use the existing routes with `format: "latex"` and LaTeX-specific system prompts (`src/lib/latex/ai-prompts.ts`). Proposals are applied and shown for review: replaced text is struck through in red, new text is green, and each change has Accept and Reject. A bar offers Accept all (⌘⇧↵) and Reject all (⌘⇧⌫). Undo removes a proposal together with its review.

The AI chat includes the open LaTeX source as context, and ⌘⇧L adds the editor selection to the conversation.

Validation: `node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/latex-editor.test.ts` (the compile test is skipped when TeX is not installed)

`npm run test:latex-production` checks the compiled production routes: password login, a real TeX build with a bibliography, and the authenticated PDF response. It runs automatically after the Electron Next build and again against the packaged app. Install TeX on the build machine to exercise compilation; the check reports a skip when TeX is absent. This catches mismatched bundled toolchain exports that source tests cannot detect. An optional server directory argument lets the same check validate an installed app.
