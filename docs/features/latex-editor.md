# LaTeX editor

`.tex`, `.bib`, `.sty` and `.cls` files open in a CodeMirror 6 source editor (`src/components/libera/latex/`). A `.tex` file is shown beside its compiled PDF, like the Markdown source editor and its preview. Create one from a notebook's menu, a folder's menu ("Add LaTeX Document"), or the notebook home ("New LaTeX"); new `.tex` files start from a small article template.

## Editing

Syntax highlighting comes from a LaTeX stream tokenizer (`src/lib/latex/codemirror/language.ts`). It knows math environments, verbatim-like environments and the arguments of sectioning, label, reference and citation commands. Typing `}` to finish `\begin{name}` inserts the matching `\end{name}`, with an `\item` for lists. Enter continues a list item, and an empty one ends the list. Renaming one side of an environment renames the other. `{`, `[`, `(` and `$` are closed automatically; after a single backslash they get their escaped partner.

Completion offers commands (math commands rank higher inside math), environments, `\ref` labels from the document and other open files, `\cite` keys from the `.bib` files the main file names, files for `\input`, `\includegraphics` and `\bibliography`, and package and class names. Environments and sections fold. A KaTeX preview of the formula floats under the cursor inside math, including simple `\newcommand` macros; Escape hides it.

Shortcuts: ⌘B, ⌘I and ⌘U wrap the selection in `\textbf`, `\textit` and `\underline`, and ⌘⇧E and ⌘⇧T in `\emph` and `\texttt`. ⌘/ toggles comments, ⌘F opens search and replace, ⌘S saves, ⌘↵ compiles, and ⌘⇧J shows the cursor's spot in the PDF.

## Compiling

`POST /api/latex/compile` (`src/lib/latex/build.ts`) runs `latexmk` when it works, or the engine directly with BibTeX/Biber passes. The engine is pdfLaTeX unless a `% !TEX program = …` line, a Unicode-only package (`fontspec`, `unicode-math`, …) or the toolbar choice says otherwise. Builds use a private folder per main file under the OS temp directory, so auxiliary files persist and recompiles are incremental. Nothing is written into the notebook.

The editor's unsaved text is compiled: the main file is written into the build folder, and TeX runs from the document's folder. Unsaved drafts of other open `.tex` files are written there too, and TeX's "output directory first" lookup reads them instead of the saved versions. Auto compile runs after a pause in typing, and is on by default per file. When it is off, saving compiles.

A file without `\documentclass` is typeset through its main file: a `% !TEX root = …` line, or else the `.tex` file in the notebook whose `\input`/`\include` graph reaches it (`GET /api/latex/root`).

Each PDF is copied into an immutable snapshot (the last three are kept) that the viewer and SyncTeX read while the next compile runs. Errors and warnings from the TeX log, BibTeX and Biber are mapped back to notebook files. They appear as editor diagnostics, underlined at the command TeX stopped on, and in the Problems panel with the raw log.

Documents cannot run programs or read outside their folder: TeX runs with `shell_escape=f` and `openin_any=p`/`openout_any=p`. latexmk ignores rc files next to the document (they are Perl) and reads only the user's own.

## SyncTeX

Double-clicking in the PDF jumps to that source line, opening another file of the project when needed. Double-clicking a word in the source scrolls the PDF to it and flashes the spot. Lines are mapped through edits made since the compile, so jumps stay right while typing. `POST /api/latex/synctex` uses the `synctex` command shipped with TeX distributions.

## AI

Right-click in the editor for AI Format (turn plain text, Markdown or pasted PDF text into LaTeX), AI Rewrite and Write with AI. These use the existing routes with `format: "latex"` and LaTeX-specific system prompts (`src/lib/latex/ai-prompts.ts`). Proposals are applied and shown for review: replaced text is struck through in red, new text is green, and each change has Accept and Reject. A bar offers Accept all (⌘⇧↵) and Reject all (⌘⇧⌫). Undo removes a proposal together with its review.

The AI chat includes the open LaTeX source as context, and ⌘⇧L adds the editor selection to the conversation.

Validation: `node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/latex-editor.test.ts` (the compile test is skipped when TeX is not installed)
