# Markdown paste for the LaTeX editor: plan

**Status:** built on `feat/latex-markdown-paste`, 8 Nov 2026, with the [decisions](#decisions) made. [What changed while building](#what-changed-while-building) is at the end. The user guide is [Pasting Markdown](features/latex-editor.md#pasting-markdown). Related: [LaTeX visual editor plan](latex-visual-editor-plan.md) §6.7 (the HTML paste this extends) and [Markdown smart paste](../src/lib/markdown-smart-paste.ts) (the heading-shift rule this mirrors).

When someone pastes Markdown into a `.tex` file, in Source or Visual mode, Libera converts it to LaTeX. Bullets become `itemize`, numbered lists become `enumerate`, tables become `tabular`, `tabularx` or `longtable`, `**bold**` becomes `\textbf`, `*italic*` becomes `\emph`, `$x$` stays math, `[@key]` becomes `\cite`, and so on. A dialog opens first. It lets the user choose how the pasted headings map to sectioning commands (the top one might be `##` → `\subsection`, or a custom command) and how tables are written (environment, rules, float, caption, label). A live preview shows the LaTeX before anything is inserted. The conversion is deterministic and uses no AI, like `html2latex.ts`.

## Goals

- Markdown from anywhere pastes as clean, idiomatic LaTeX that compiles: ChatGPT and Claude answers, GitHub READMEs, Obsidian, Notion exports, and Libera's own notes and chat (whose copy writes Markdown as `text/plain`).
- Cover as much of CommonMark, GFM and Libera's Markdown dialect as has a LaTeX equivalent. Anything without one is dropped as markup and kept as text, never lost silently: the dialog lists what was dropped.
- One undo step, in both modes, on local and shared tabs.
- Never get in the way of pasting LaTeX. Text that is LaTeX, or plain prose with no Markdown in it, pastes exactly as it does today, with no dialog.
- Defaults that are right without touching the dialog: headings land one level below the section the cursor is in, and the table settings are the ones used last time.

## Non-goals

- Converting LaTeX back to Markdown (copy out of the LaTeX editor).
- Pandoc-level coverage of exotic extensions (definition lists, grid tables, attribute blocks `{#id .class}`, citeproc output). They paste as text.
- Downloading remote images during the paste (phase 4 follow-up at most, with the user's confirmation).
- `minted`. Builds run with shell escape off ([build.ts](../src/lib/latex/build.ts) sets `shell_escape: "f"`), so `minted` would never compile.

## Where things stand today

| Area | Today | What it means for this feature |
|---|---|---|
| Paste in Visual mode | [paste.ts](../src/lib/latex/codemirror/visual/paste.ts) converts **clipboard HTML** with [html2latex.ts](../src/lib/latex/codemirror/visual/html2latex.ts). `text/plain` pastes as is, and nothing is converted inside math, verbatim or comments. Large pastes on shared tabs go through `insertLargeText`. | Markdown arrives as `text/plain`, so today it is pasted raw. The new handler sits in front of this one and reuses its context checks, escaping and large-paste path. |
| Paste in Source mode | CodeMirror's default (no conversion). | The Markdown handler is installed in both modes, outside the Visual compartment. |
| HTML → LaTeX | `html2latex.ts` hard-codes H1→`\section`, H2→`\subsection`, `\emph` for italics, and `tabular` with `\hline`. | Its heading, table and italic output moves onto the same option-driven emitters, so HTML and Markdown pastes behave the same way (phase 4). |
| Markdown grammar | [markdown-rendering.ts](../src/lib/markdown-rendering.ts) `markdownRemarkPlugins()`: remark-parse, remark-gfm (tables, strikethrough, task lists, footnotes, autolinks), math markers, citations, highlights `>>>…<<<`, colors `[color=#hex]…[/color]`, `<u>`, boxes `y> …`, macros, front matter. | The converter parses with this same grammar, so Libera's own syntax converts too. The parse produces an mdast, and the converter walks it. |
| Libera's copy | [markdown-clipboard.ts](../src/lib/markdown-clipboard.ts) `writeMarkdownClipboard` clears the clipboard and writes **only `text/plain`** Markdown (preview, chat panel, PDF viewer). | Detecting Markdown in `text/plain` is the main way this feature is reached. |
| Markdown smart paste | [markdown-smart-paste.ts](../src/lib/markdown-smart-paste.ts) shifts pasted headings to sit one level below the closest heading before the cursor ("child"), or beside it ("peer"). | The LaTeX default for the top heading follows the same rule, so the two editors agree. |
| Citations | [citation-syntax.ts](../src/lib/references/citation-syntax.ts) (Pandoc grammar), [biblatex-export.ts](../src/lib/references/biblatex-export.ts) (`biblatexCitation`, `biblatexPostnote`, `biblatexPrenote`), [latex-cite-syntax.ts](../src/lib/references/latex-cite-syntax.ts) (`latexCitation`). | `[@a, p. 4]` maps straight to `\cite`, `\parencite` or `\citep` with the existing helpers. |
| Escaping | Two escapers: `html2latex.escapeLatexText` (maps symbols such as α to `$\alpha$`, smart quotes, dashes) and `latex-citations.escapeLatexText` (also `<`, `>`, `|`). | Merged into one shared module. `<`, `>` and `|` print as ¡, ¿ and — under the default OT1 encoding, so they are escaped unless T1 is loaded. |
| Tables in Visual mode | `parseTabular` ([table-model.ts](../src/lib/latex/codemirror/visual/table-model.ts)) handles `tabular`, `tabular*` and `tabularx` (width argument). `longtable` and `xltabular` are shown as source ([walk.ts](../src/lib/latex/codemirror/visual/walk.ts)). | `tabular` and `tabularx` output becomes an editable table widget straight away. The dialog says that a `longtable` shows as source. |
| Project context | `readLatexOutline` and `SECTION_LEVELS` ([project.ts](../src/lib/latex/project.ts)), `resolveLatexEngine` (pdfLaTeX, XeLaTeX or LuaLaTeX), macro sources including the root file's preamble for chapter files (`setMacroSources`, installed in both modes), `LatexProjectData` (labels, bib entries, file list). | These give the defaults: the section at the cursor, the loaded packages (`hyperref`, `booktabs`, `biblatex`, `natbib`, `enumitem`, `soul`…), the document class (whether `\chapter` exists), the engine (Unicode handling), and existing labels (no duplicates). |
| Dialogs and preferences | [modal-dialog.tsx](../src/components/libera/modal-dialog.tsx) `ModalDialog`. Snippets and LaTeX export options are stored per user through `/api/preferences/...` routes. | The paste dialog uses `ModalDialog`. The remembered options use the same kind of route. |
| Context menu | [latex-ai-menu.tsx](../src/components/libera/latex/latex-ai-menu.tsx) has Cut, Copy, Paste (`navigator.clipboard.readText`) and AI Format. | New items: "Paste Markdown as LaTeX…" and, with a selection, "Convert Markdown to LaTeX…". |

## Design

### 1. Flow

```
paste event (Source or Visual)
  │
  ├─ read-only, or cursor inside math / verbatim / comment ─────────────▶ default paste
  ├─ Mod-Shift-V was pressed (paste as plain text) ─────────────────────▶ default paste
  ├─ text/plain passes the quick Markdown check (§2)?
  │     no ─▶ HTML on the clipboard? ─▶ existing html2latex path (Visual only)
  │            otherwise ─────────────────────────────────────────────▶ default paste
  │     yes ─▶ preventDefault, remember the target range (mapped through later changes)
  │            parse (§3), confirm it really is Markdown, else insert the text raw
  │            analyse: heading levels present, tables, citations, images…
  │            ask? (§6.1) ── no ─▶ convert with the remembered options, insert, show a notice
  │                           yes ─▶ dialog with live preview (§6)
  │                                    Paste as LaTeX ─▶ convert, insert (§5)
  │                                    Paste as plain text ─▶ insert the Markdown as it was
  │                                    Cancel / Esc ─▶ nothing is inserted
  ▼
one transaction, userEvent "input.paste.markdown" (insertLargeText above 64 KB)
```

The converter is a pure function with no DOM, so it can be tested in Node:

```ts
markdownToLatex(markdown: string, options: MarkdownPasteOptions, context: LatexPasteContext): {
  latex: string;
  packages: RequiredPackage[];   // { name, options?, reason } for anything the output needs
  warnings: PasteWarning[];      // dropped constructs, unsupported images, emoji under pdfLaTeX…
}
analyzeMarkdown(markdown: string): MarkdownPasteAnalysis  // what the dialog needs to show
```

### 2. When a paste is Markdown

The paste handler has to call `preventDefault()` synchronously, so detection runs in two stages.

**Stage 1: a quick regex check** in the event handler, under 1 ms for 100 KB. It scores Markdown signals:

| Weight | Signal |
|---|---|
| strong (3) | an ATX heading line `^#{1,6}\s`; a GFM table delimiter row `^\|?\s*:?-{3,}:?\s*(\|…)`; a fenced code block; two or more consecutive list lines `^\s*([-*+]\|\d+[.)])\s`; a task item `- [ ]`; a footnote definition `[^x]:`; an image `![…](…)` |
| medium (2) | `**bold**` or `__bold__`; a link `[text](url)`; a setext underline; a block quote line `^>\s`; a lone `---`, `***` or `___` line |
| weak (1) | `*italic*`; `` `code` ``; Libera's `>>>…<<<` and `[color=…]` |

It also scores **LaTeX signals**: `\begin{`, `\end{`, sectioning commands, `\item`, `\textbf{`, a `&` … `\\` row, `%` comments, and the share of lines that start with `\`. The text counts as Markdown when its Markdown score is at least 3 and greater than its LaTeX score. Math (`$…$`, `\[…\]`) scores for neither side, because it is valid in both. Pasting LaTeX or plain prose therefore never opens the dialog.

**Stage 2: the parse confirms.** If the mdast holds only paragraphs of plain text and math, with no formatting, list, table, heading, link or code, the text is inserted raw (exactly what a normal paste would have done) and nothing else happens.

Only stage 1 decides whether the handler takes over the event. When it doesn't, CodeMirror's own paste behaviour stays intact: one line per cursor for multiple selections, and line-wise pastes.

### 3. Parsing

- Use the same unified pipeline as the preview, with the same plugin order: `remarkMarkdownMacros` (scoped to the pasted text, so a pasted `libera-macro` block defines its own macros), `remarkGfm`, boxes, highlights, colors, underlines, text styles, math markers (the user's configured pairs from Markdown preferences, falling back to the defaults `$ $`, `$$ $$`, `\( \)`, `\[ \]`), citations, and front matter. The source map and bibliography plugins are left out. A small `markdownParsePlugins()` beside `markdownRemarkPlugins()` keeps one definition of the grammar.
- The parser is loaded with a dynamic `import()` and preloaded when the editor is idle after a `.tex` tab opens, so the first paste does not wait for it. The libraries are already in the app's client bundle for the Markdown preview.
- Line endings are normalised to `\n`. Tabs in code are expanded to 4 spaces.
- Reference-style links and images are resolved through the definitions collected in a first pass.

### 4. Conversion

One walk over the mdast. An `Emitter` carries the options, the context, the list depth, the "where am I" flags (`inHeading`, `inCaption`, `inTableCell`, `inFootnote`, `inlineOnly`), the set of required packages and the warnings. Blocks are joined with blank lines. Soft line breaks keep the Markdown's line breaks, since LaTeX reads them as spaces and the diff stays readable.

#### 4.1 Block mapping (defaults in bold)

| Markdown | LaTeX | Options and notes |
|---|---|---|
| Heading `#`…`######` | Sectioning command chosen per level (§4.3) | **`\section`-ladder relative to the cursor**, custom command or template, starred, labels, strip manual numbers |
| Paragraph | Text, blank line after | |
| Hard break (two spaces, `\`, `<br>`) | `\\` | In a table cell: `\newline` in `p` and `X` columns, a space otherwise. A `[` at the start of the next line is protected (`\\{}[`), or `\\` would read it as a length. |
| `- * +` list | `itemize` | Items indented two spaces per level, like html2latex |
| `1.` `1)` list | `enumerate` | A start other than 1 becomes `[start=n]` with `enumitem`, else `\setcounter{enumi}{n-1}` (`enumii`… by depth) |
| Task list `- [ ]` / `- [x]` | `\item[$\square$]` / `\item[$\boxtimes$]` | Needs `amssymb`. Without it, `\item[{[\,]}]` / `\item[{[x]}]`. |
| Lists nested deeper than 4 | Flattened to level 4 | Warning ("LaTeX allows four levels of lists"). |
| An item whose text starts with `[` | `\item{} [text…` | Otherwise `\item` reads it as the label. |
| Block quote | **`quote`** | `quotation`, `displayquote` (csquotes) |
| GitHub alert `> [!NOTE]` | `quote` beginning with `\textbf{Note.}` | Phase 4: `tcolorbox` when it is loaded |
| Libera box `y> …` | `quote` | Phase 4: `tcolorbox` with the box's color when it is loaded |
| Fenced or indented code | **`verbatim`** | `lstlisting` with `language=` mapped to the names listings knows (Python, C, C++, Java, R, Matlab, SQL, HTML, XML, bash…). Unknown languages get no option. |
| Code that contains `\end{verbatim}` | Escaped `\texttt` lines joined by `\\` | As html2latex does. |
| ```` ```math ```` | Display math (§4.4) | |
| ```` ```mermaid ```` and other diagrams | `verbatim` with a `% diagram (mermaid)` comment | Warning |
| `libera-macro` block | Nothing; its macros are expanded | Phase 4: math macros become `\newcommand` lines |
| Display math | **`\[ … \]`** | `equation*`, `equation` (numbered, optional label). Multi-line content with `\\` and `&` becomes `align*`, and with `\\` only, `gather*` (amsmath). |
| Thematic break `---`, `***`, `___` | Dropped, always | No option ([decision 5](#decisions)). html2latex already drops `<hr>`. |
| Table | §4.5 | |
| Image alone in a paragraph | **`figure`** (§4.7) | Inline `\includegraphics`, or a comment |
| HTML block | Allowed tags converted (`<br>`, `<sup>`, `<sub>`, `<u>`, `<kbd>`, `<details>` content); other tags dropped and their text kept | Warning listing the dropped tags |
| HTML comment | Dropped | |
| YAML front matter | Dropped | |
| Footnote definition | Inserted at its reference (§4.6) | Definitions nobody references are dropped, with a warning. |

#### 4.2 Inline mapping

| Markdown | LaTeX | Options and notes |
|---|---|---|
| `*em*` / `_em_` | **`\emph{…}`** | `\textit{…}`. The default matches html2latex, and the shared option makes both pastes use one form. |
| `**strong**` | `\textbf{…}` | |
| `***both***` | `\textbf{\emph{…}}` | |
| `~~strike~~` | `\sout{…}` | Needs `\usepackage[normalem]{ulem}` (`normalem` so `\emph` keeps its italics). `\st` with soul is an option. |
| `` `code` `` | **`\texttt{…}`**, escaped | `\verb|…|`, which falls back to `\texttt` in arguments, captions and cells, where `\verb` is not allowed |
| `$…$`, `\(…\)` | **`$…$`** | `\(…\)`. Unicode inside the formula is mapped (α → `\alpha`) under pdfLaTeX. |
| A paragraph that is only `$$…$$` | Display math | Libera's default math markers make `$$…$$` an inline pair, so the converter promotes a lone formula to display math itself. |
| `[text](https://…)` | **`\href{url}{text}`**, or `\url{url}` when the text is the URL | Text followed by `\footnote{\url{…}}` (good for print), or text only. URLs go through `latexUrl` (percent-encoding). |
| Autolink, bare URL | `\url{…}` | |
| `mailto:` | `\href{mailto:…}{text}` | |
| `[text](#anchor)` | `\hyperref[sec:anchor]{text}` when the anchor is one of the pasted headings and labels are on; otherwise the text alone | |
| Relative link (another note) | The text alone | |
| `![alt](src)` inside text | `\includegraphics[height=1em]{src}` | Rare. Remote sources become the alt text. |
| `[@key]`, `@key` | §4.6 | |
| `[^1]` | `\footnote{…}` | §4.6 |
| `>>>text<<<` (Libera highlight) | `\hl{…}` with soul | `\colorbox{yellow}{…}` (no line breaks), or dropped |
| `[color=#2563eb]…[/color]` | `\textcolor[HTML]{2563EB}{…}` | Needs xcolor |
| `<u>…</u>` | `\underline{…}` | `\uline` when ulem is loaded (it can break across lines) |
| `<sup>` / `<sub>` | `\textsuperscript` / `\textsubscript` | |
| Libera text styles (`data-font-size`) | Dropped | |
| LaTeX commands written in prose (`\ref{eq:1}`, `\newpage`) | Kept as LaTeX (§4.8) | |
| Straight quotes `"…"` | **` ``…'' `** | `\enquote{…}` with csquotes, or kept as written |
| Emoji under pdfLaTeX | Dropped | Warning ("pdfLaTeX cannot typeset 3 emoji"). Kept under XeLaTeX and LuaLaTeX. |

#### 4.3 Headings

- **Levels are mapped by rank.** The distinct heading depths in the paste are sorted (for example `##`, `###`, `#####`). The first (the "top heading") maps to the chosen command, and each next depth maps one step further down the ladder `\part` → `\chapter` → `\section` → `\subsection` → `\subsubsection` → `\paragraph` → `\subparagraph`. Gaps in the Markdown (`##` then `####`) do not leave gaps in the LaTeX. Depths that fall past `\subparagraph` become a bold run-in paragraph `\textbf{Title.}`.
- **The default top level** is one below the last sectioning command before the cursor: `readLatexOutline` over this file up to the cursor, the same "child" rule as Markdown smart paste. With no heading before the cursor, it is `\chapter` when the class has chapters (book, report, memoir, scrbook, scrreprt), otherwise `\section`. The dialog shows why: "The cursor is in \section{Methods}".
- **Each level present gets its own row** in the dialog, and each row's menu offers the ladder, "Bold paragraph", "Plain paragraph" and "Custom…". Changing the top row re-defaults every row below it that the user has not changed. `\chapter` and `\part` are disabled, with a tooltip, when the document class does not define them.
- **Custom**: either a command name (`\frametitle`, `\myheading`, `\section*`), written as `\name{Title}`, or a one-line template with exactly one `#1` (`\textbf{\large #1}\par`, `\heading[short]{#1}`). The template is validated: balanced braces, no `\begin` or `\end`, and nothing from the dangerous-command list (§9).
- **Numbered or not**: an "Unnumbered (`\section*`)" checkbox.
- **Manual numbers**: "Remove numbers such as `1.2`" is offered, and on by default, when `detectMarkdownHeadingNumbering` finds the pasted headings numbered, because LaTeX numbers sections itself.
- **Labels**: "Add labels" writes `\label{sec:slug}` after each heading (`chap:` for chapters). Slugs follow GitHub's algorithm (so `#anchor` links resolve), keep only `[a-z0-9-]`, and are made unique against the document's and project's existing labels. Labels are off by default, and on by default when the paste links to its own headings.
- **Formatting in titles** is kept (`\section{The \emph{n}-body problem}`). Fragile commands in titles get `\protect` (`\footnote`, `\url`). Inline code uses `\texttt`, never `\verb`.

#### 4.4 Math

- The formula text is kept exactly as written. This is the part users care most about not being changed.
- Every formula goes through `isSafeMathTex` (html2latex). A formula that could leave its delimiters or read files is pasted as escaped text, with a warning.
- A formula that contains a complete display environment (`$$\begin{align}…\end{align}$$`, which ChatGPT writes and which is invalid inside `\[`) is unwrapped and written as the environment itself. `aligned`, `cases` and `matrix` stay inside `\[ … \]`.
- `equation` and `align` (numbered) are offered. Labels are added only when the user asks.
- Required packages: `amsmath` for `align*`, `gather*`, `\text` and `\tag`; `amssymb` for `\mathbb` and the like when the formulas use them (a small list of common commands and their packages).

#### 4.5 Tables

Per table, the converter knows the column alignments (from `:--`, `:-:` and `--:`), the header row, the body rows and a length estimate per column.

**Environment** (one setting for every table in the paste):

| Choice | Output | Notes |
|---|---|---|
| **`tabular`** | `\begin{tabular}{lrl}` | Columns whose content runs long (longest cell over about 40 characters) can become `p{w\linewidth}`, with widths shared out in proportion to their content (rounded to 0.05, at least 0.1). With `array`, `p` columns keep their alignment through `>{\raggedright\arraybackslash}`. |
| `tabularx` | `\begin{tabularx}{\linewidth}{l>{\raggedright\arraybackslash}X r}` | Long columns become `X` (`>{\centering\arraybackslash}X` and the like keep the alignment). With no long column, the longest one becomes `X`. Needs `tabularx`. |
| `longtable` | `longtable` with the head repeated on each page (`\endfirsthead`, `\endhead`, `\endlastfoot`) | Cannot go in a `table` float, so the float options are hidden. The caption goes inside, as `\caption{…}\label{…}\\`. The dialog notes: "Shown as source in Visual mode". Needs `longtable`. |

**Rules**: **booktabs** (`\toprule`, `\midrule` after the header, `\bottomrule`; needs `booktabs`), grid (`|l|r|l|` with an `\hline` after every row), simple (`\hline` at the top, after the header and at the bottom), or none.

**Header**: a "Bold header row" checkbox (default off; booktabs style is not bold). A header whose cells are all empty is skipped, since some tools write one.

**Float** (not for `longtable`):

- Wrap in: none (just the tabular at the cursor) or a **`table`** float, or `table*` when the class has the `twocolumn` option.
- Placement: checkboxes `h`, `t`, `b`, `p` and `!`, default **`[htbp]`**, or `H` on its own, which needs the `float` package.
- `\centering`: on by default.
- Caption: a text field, placed **above** the table (the usual convention for tables) or below it. A paragraph just before the table that looks like a caption (`Table 2: …`, `**Table:** …`) fills the field and is removed from the body. That behaviour is an option, on by default. With no caption, there is no `\caption` and no `\label`.
- Label: defaults to `tab:` plus the caption's slug, can be edited, and is made unique.
- Size: none, `\small`, `\footnotesize` or `\scriptsize`.

**Several tables** in one paste share these settings, and each gets its own caption and label fields, listed as "Table 1: Model, Acc., Notes (3 × 4)".

**Cells**: inline conversion with `inTableCell` set. Display math in a cell becomes inline math. Footnotes become `\footnotemark` in the cell and `\footnotetext` after the tabular (`longtable` uses `\footnote` directly). Rows with fewer cells than the header are padded with empty cells. `<br>` follows the hard-break rule in §4.1, and a column that contains one is made a wrapping column.

#### 4.6 Citations and footnotes

- **Citations** come from the `liberaCitation` nodes produced by remark-citations. The dialect follows the preamble:
  - `biblatex`: `\parencite` / `\textcite`, through `biblatexCitation` (prenote, postnote, multicites, `-@key`).
  - `natbib`: `\citep[pre][post]{a,b}` / `\citet`.
  - Neither: `\cite[post]{a,b}`. A prefix becomes text before the command, since `\cite` has no prenote.
  - Keys are kept even when the bibliography does not know them. A warning lists unknown keys when `LatexProjectData` has the bib entries.
- **Footnotes**: `\footnote{…}` at the reference. A definition with several paragraphs joins them with `\par`. A footnote referenced twice gets `\footnote{…}\label{fn:x}` the first time and `\footnotemark[\ref{fn:x}]` after that. In headings and captions it gets `\protect`. In table cells it follows §4.5.

#### 4.7 Images

- An image alone in a paragraph becomes `figure[htbp]` with `\centering`, `\includegraphics[width=0.75\linewidth]{path}`, `\caption{alt or title}` and `\label{fig:slug}`. The width defaults to the LaTeX export's `imageWidth`. Needs `graphicx`.
- Paths: a relative path is kept as written. A Libera `/api/files/raw/…` URL becomes a path relative to the `.tex` file. A path that is not in the project's file list gets a warning.
- Remote URLs and data URIs cannot be compiled. They become `% Image not in the project: <url>` plus the alt text, with a warning. Downloading them into the project is a possible phase 4 follow-up, and only with the user's confirmation.
- SVG, WebP and GIF are flagged, since pdfLaTeX cannot include them.

#### 4.8 Text, escaping and LaTeX already in the Markdown

- One shared module, `src/lib/latex/latex-text.ts`. It takes `escapeLatexText`, `latexUrl` and `isSafeMathTex` from html2latex, adds the `<`, `>` and `|` handling from `latex-citations.ts` (escaped only when T1 is not loaded), quote conversion, and the emoji rule. Both converters import it.
- **LaTeX written inside Markdown** is common in academic notes (`see \cite{x}`, `\newpage`). CommonMark keeps a backslash before a letter as literal text, so plain escaping would turn `\ref{eq:1}` into `\textbackslash{}ref\{eq:1\}`. The option "Keep LaTeX commands in the text" (on by default, as with Pandoc's `raw_tex`) lets a `\command` with balanced `[…]` and `{…}` arguments, or a `\begin{x}…\end{x}` inside one text run, through unescaped. Commands on the dangerous list (§9) are always escaped.
- The engine matters: under XeLaTeX or LuaLaTeX, Unicode letters and symbols are kept as written. Under pdfLaTeX, known symbols are mapped, accented Latin passes, and other scripts get a warning ("may need XeLaTeX").

#### 4.9 Packages the output needs

Each construct records what it needs, for example `hyperref` (`\href`, `\url`, `\hyperref`), `booktabs`, `tabularx`, `longtable`, `array`, `float` (`H`), `ulem` with `normalem`, `soul`, `xcolor`, `graphicx`, `amsmath`, `amssymb`, `listings`, `enumitem`, `csquotes`.

The context lists the packages loaded by the compile root's preamble, through the macro sources the editor already has, so this works for chapter files too. Missing packages appear in the dialog: "This needs `booktabs`, `hyperref`."

- **Nothing is added to the preamble automatically** ([decision 3](#decisions)). The user keeps final control over it. The dialog, or the notice for a paste that skips the dialog, lists the missing `\usepackage` lines with a Copy button.
- When the root is the current file, the dialog also has an "Add to the preamble" checkbox. It is **off** for every paste and its state is never remembered. When ticked, the lines go after the last `\usepackage` before `\begin{document}`, in the same transaction as the paste, so it is one undo step.
- When the root is another file, only the lines and the Copy button are shown.
- Some settings switch to a fallback rather than adding a package: `hyperref` missing, with links set to "text only", needs nothing.

### 5. Where the paste lands

The context is computed from the syntax tree at the target position:

| Cursor in… | Behaviour |
|---|---|
| Math, verbatim, comment | No conversion (the existing check, shared). |
| A command argument (`\section{|}`, `\caption{|}`, `\textbf{|}`) or a tabular body | **Inline only**: blocks are flattened (headings → bold, lists → text separated by semicolons), no dialog. |
| A list environment | Output lists nest. Indentation follows the current line's indentation. |
| The middle of a paragraph | Inline content is inserted in place. When the output starts or ends with a block, blank lines are added before or after it as needed, so the surrounding text stays its own paragraph. |
| The preamble (before `\begin{document}`) | No conversion. |

The target range is kept as a mapped range while the dialog is open, so a collaborator's edits in the meantime do not move it. If the range was deleted, the paste goes to its mapped position.

### 6. The dialog

`LatexMarkdownPasteDialog`, built on `ModalDialog` (`panelClassName="max-w-4xl"`), with two columns. The options are on the left. On the right is a **live preview** of the LaTeX (read-only CodeMirror with LaTeX highlighting), recomputed on every change. The converter is fast enough for that, and the preview is cut after 400 lines for very large pastes.

```
┌ Paste Markdown as LaTeX ─────────────────────────────────────────────────────┐
│ HEADINGS  (cursor is in \section{Methods})     │ \subsection{Results}         │
│   ##   → [\subsection      ▾]                  │                              │
│   ###  → [\subsubsection   ▾]                  │ We compare \textbf{three}... │
│   #### → [\paragraph       ▾]                  │                              │
│   ☐ Unnumbered   ☐ Add labels   ☑ Remove "1.2" │ \begin{table}[htbp]          │
│                                                │   \centering                 │
│ TABLES (2)                                     │   \caption{Model comparison} │
│   Environment ( tabular | tabularx | longtable)│   \label{tab:model-compari...│
│   Rules  (booktabs | grid | simple | none)     │   \begin{tabular}{lrl}       │
│   ☑ Wrap long columns   ☐ Bold header          │     \toprule                 │
│   Float [table ▾]  ☑h ☑t ☑b ☑p ☐!  ☐H          │ ...                          │
│   Table 1 caption [Model comparison  ] label […]│                              │
│   Table 2 caption [                  ] label […]│                              │
│                                                │                              │
│ ▸ More options (italics, code, math, links, …) │                              │
│                                                │ ⚠ Needs booktabs, hyperref   │
│                                                │   [Copy] ☐ Add to preamble   │
│                                                │ ⚠ 1 image is a remote URL    │
├────────────────────────────────────────────────┴──────────────────────────────┤
│ ☐ Next time, paste without asking   [Paste as plain text] [Cancel] [Paste ⏎]│
└───────────────────────────────────────────────────────────────────────────────┘
```

- Groups appear only when they apply (no headings, no Headings group).
- "More options" holds the §4.1 and §4.2 choices: italics, strikethrough, inline code, code blocks, display math, links, images, quotes, keep LaTeX commands.
- Keyboard: focus starts on the top heading menu. Enter pastes, Esc cancels, and Mod-Shift-V inside the dialog means "Paste as plain text".
- Viewers and read-only tabs never see it.

#### 6.1 When it asks

A setting with three values: **"Ask when the paste has headings or tables"** (default, [decision 1](#decisions)), "Always ask", or "Never ask, use my settings". Pastes with nothing to decide (bold, a list, a link) are converted straight away, with a small notice under the cursor: "Pasted Markdown as LaTeX · Paste as plain text instead · Options…". When the output needs packages the preamble lacks, the notice adds "Needs `\usepackage{ulem}` · Copy" and never edits the preamble. "Paste as plain text instead" replaces the converted text with the raw Markdown in one transaction. Undo still goes back to before the paste. "Never convert Markdown" is a fourth value, for anyone who wants the old behaviour.

### 7. Remembered settings

`MarkdownPasteOptions` (heading ladder start, starred, labels, number stripping, table environment, rules, wrapping, header bold, float, placement, centering, caption position, size, the More options, and the "ask" mode) is stored per user. It follows the LaTeX preferences pattern: types, defaults and validation in `src/lib/latex/markdown-paste/options.ts`, a `/api/preferences/latex-paste` route, and a small client store like `latex-snippets-store.ts`. Captions, labels and the "Add to the preamble" checkbox belong to one paste and are never stored. The top heading is stored as **relative** ("one below the cursor's section") unless the user picks a fixed command, in which case that command is stored.

### 8. Entry points

1. **Mod-V**, with detection, in Source and Visual mode.
2. **Mod-Shift-V**: paste as plain text, never converted. Chrome's "paste and match style" still fires a `paste` event with `text/plain`, so a keydown handler sets a one-shot flag that the paste handler reads.
3. **Mod-Alt-V**: "Paste Markdown as LaTeX…". It always opens the dialog, skips detection, and reads `navigator.clipboard.readText()`.
4. **Context menu**: "Paste Markdown as LaTeX…" under Paste. With a selection, "Convert Markdown to LaTeX…" runs the same dialog on the selected text and replaces it. This fixes an earlier raw paste, or AI output that was pasted as is.
5. The command palette or shortcut list, if the editor has one, lists 3 and 4.

### 9. HTML pastes

Phase 4 moves html2latex's headings, tables and italics onto the same emitters and options, and shows the dialog for HTML pastes that contain headings or tables. One mapping then applies whether the text came from Google Docs or from ChatGPT's Markdown. Until then html2latex keeps working as it does. When both formats are on the clipboard (ChatGPT's copy button writes Markdown as `text/plain` alongside HTML), the Markdown wins when it passes detection. It carries the formulas and heading levels exactly, while the HTML carries KaTeX markup.

## Example

With the cursor after `\section{Experiments}`, no bibliography package, and the defaults (top heading → `\subsection`, `tabular` + booktabs in a `table[htbp]` float, the caption typed in the dialog):

```markdown
## Results

We compare **three** models on *two* datasets [@smith2020, p. 4].

- Accuracy improves by 12%
- Latency drops:
  1. on CPU
  2. on GPU

| Model | Acc. | Notes        |
|:------|-----:|--------------|
| A     | 91.2 | baseline     |
| B_2   | 93.4 | uses `fp16`  |

$$
E = mc^2
$$
```

```latex
\subsection{Results}

We compare \textbf{three} models on \emph{two} datasets \cite[p.~4]{smith2020}.

\begin{itemize}
  \item Accuracy improves by 12\%
  \item Latency drops:
  \begin{enumerate}
    \item on CPU
    \item on GPU
  \end{enumerate}
\end{itemize}

\begin{table}[htbp]
  \centering
  \caption{Model comparison}
  \label{tab:model-comparison}
  \begin{tabular}{lrl}
    \toprule
    Model & Acc. & Notes \\
    \midrule
    A & 91.2 & baseline \\
    B\_2 & 93.4 & uses \texttt{fp16} \\
    \bottomrule
  \end{tabular}
\end{table}

\[
E = mc^2
\]
```

The dialog would also report "Needs `\usepackage{booktabs}`" with a Copy button. The preamble is left alone unless the user ticks "Add to the preamble".

## Edge cases

- **LaTeX that looks a little like Markdown**: `\item` lines, `% ---` rules, `$a*b*c$`. The LaTeX score vetoes them, and math does not count as a Markdown signal.
- **Markdown that looks a little like LaTeX**: a README with one `\n` in a code span. Code is excluded when the LaTeX signals are counted.
- **Underscores in identifiers** (`snake_case_name`): CommonMark's intraword rule keeps them literal, and they are escaped to `\_`.
- **`*` inside formulas, or `_` in `$a_1$`**: the math markers tokenize before emphasis, as in the preview.
- **Very large pastes** (over 1 MB): no dialog preview beyond 400 lines. Conversion runs once on confirm. Insertion uses `insertLargeText`.
- **Mixed `\r\n`**, BOM, zero-width spaces: normalised or dropped (`TEXT_SYMBOLS` already drops `​` and `﻿`).
- **Headings inside list items or block quotes** (valid Markdown): sectioning commands are not allowed there, so they become bold paragraphs.
- **Empty headings, empty table cells, a table without body rows**: no `\section{}`. An empty table with a header still pastes.
- **A list item containing a table or code block**: allowed in LaTeX. `verbatim` inside `\item` works, and so does a `table` or `figure` float (floats are refused only inside boxes and other floats). Inside a footnote, tables have no float and code is written as `\texttt` lines.
- **Two pastes in a row**: requests are queued; the second waits until the first is inserted or its dialog closes, and gets a dialog of its own with fresh state.
- **Shared tabs and suggestion mode**: the paste is an ordinary local edit, so provenance, `Y.UndoManager` and collaborator suggestions behave as for any paste.
- **Visual mode right after the paste**: `tabular` and `tabularx` render as table widgets, figures as figure widgets, lists and sections as styled text. `longtable` stays source.

## Security

The clipboard is untrusted (web pages, chat output), and the result is compiled.

- Every URL goes through `latexUrl`, so it cannot leave `\href` or `\url`.
- Formulas, raw LaTeX kept from the text (§4.8) and custom heading templates are rejected or escaped when they contain `\input`, `\include`, `\openin`, `\openout`, `\write`, `\write18`, `\immediate`, `\catcode`, `\def`, `\let`, `\csname`, `\newcommand`, `\usepackage`, `\directlua`, `\makeatletter`, `\endinput` and the rest of html2latex's list, or `\begin{document}` / `\end{document}`, or unbalanced braces.
- `verbatim` content cannot close its environment early.
- Labels, image paths and listings languages are restricted to safe characters. Image paths may not start with `/` or contain `..` above the project root.
- Package names come only from the converter's fixed list, never from the clipboard.

## Phases

Each phase ends with its tests passing under `npm run test:editor`.

1. **Converter core (no UI).** Shared `latex-text.ts` (html2latex switched to it, with no change in its output), `markdownParsePlugins()`, `markdownToLatex` and `analyzeMarkdown` for CommonMark + GFM + math + Libera inline syntax, headings with the rank ladder and custom templates, tables (`tabular`, `tabularx`, `longtable`, rules, floats), code, links, footnotes, citations with the three dialects. Exit: fixture snapshots pass, the property tests pass, and the fixtures compile with pdfLaTeX where TeX is installed.
2. **Paste flow and dialog.** Detection, the CodeMirror extension in both modes, mapped target range, the dialog with live preview, headings and tables groups, "ask" modes and notice, remembered settings route and store, Mod-Shift-V and Mod-Alt-V, the context menu items. Exit: jsdom tests of the handler. Manual check in Electron with pastes from ChatGPT, Claude, GitHub, Obsidian and a Libera note.
3. **Context awareness.** Section at the cursor and class-aware ladder, packages from the root preamble with the missing lines listed (Copy, and the opt-in "Add to the preamble"), engine-aware Unicode, inline-only contexts, labels deduplicated against the project, cross-references for `#anchor` links, unknown citation keys.
4. **Extras.** Images to figures with Libera path resolution, HTML pastes through the shared emitters and dialog, Libera boxes and GitHub alerts to `tcolorbox`, `libera-macro` math macros to `\newcommand`, Obsidian syntax (`==highlight==`, `[[wikilinks]]`, callouts). Possibly a custom clipboard type (`application/x-libera-markdown`), written next to `text/plain` when Libera copies, carrying the source note's path so relative image paths resolve.

## Testing

- **Converter fixtures**: `scripts/editor/fixtures/markdown-paste/*.md` with `.tex` snapshots for each, rewritten with `UPDATE_MARKDOWN_PASTE_SNAPSHOT=1` as the LaTeX parser snapshot is. The corpus covers ChatGPT and Claude answers, a GitHub README, Obsidian and Notion exports, a Libera note with citations, highlights, colors, boxes and macros, and one table-heavy document.
- **Option matrix**: each heading ladder start including custom templates, each table environment × rule style × float, each More option.
- **Properties (fast-check)** over generated mdast-shaped Markdown:
  - The output parses with codemirror-lang-latex with no error nodes, and `\begin` and `\end` balance.
  - No text character reaches the output unescaped (`# $ % & _ { } ~ ^ \`).
  - Converting is deterministic and never throws.
  - Inline-only mode never emits a block construct or a blank line.
- **Detection corpus**: about 100 clipboard samples labelled Markdown, LaTeX or plain, with no false positives on the LaTeX samples (taken from `scripts/editor/fixtures/latex/`).
- **Compile check**: the fixtures wrapped in a minimal document, compiled when TeX is available (alongside `test:latex-production`).
- **Editor integration** (jsdom, like `latex-visual-editing.test.ts`): synthetic `ClipboardEvent`s in both modes, the math, verbatim and comment bypass, Mod-Shift-V, one undo step including the preamble insertion when it is ticked, the preamble untouched when it is not, the mapped target after a concurrent remote change, read-only tabs.
- **html2latex regression**: its existing tests unchanged after the switch to the shared escaper.

## Files

New:

- `src/lib/latex/latex-text.ts`: escaping, URLs, safe-TeX check, slugs and labels (moved from html2latex and latex-citations)
- `src/lib/latex/markdown-paste/`: `index.ts` (`markdownToLatex`, `analyzeMarkdown`), `parse.ts`, `detect.ts`, `emitter.ts`, `blocks.ts`, `inline.ts`, `headings.ts`, `tables.ts`, `citations.ts`, `packages.ts`, `options.ts`
- `src/lib/latex/markdown-paste/context.ts`: `latexPasteContext(state, pos)`, giving the section at the cursor, class, engine, loaded packages, bibliography dialect, existing labels, inline-only flag
- `src/lib/latex/codemirror/markdown-paste.ts`: the paste handler, the Mod-Shift-V flag, the tracked target range, the request callback to React
- `src/components/libera/latex/latex-markdown-paste-dialog.tsx`, `latex-paste-options-store.ts`
- `src/app/api/preferences/latex-paste/route.ts` and its storage
- `scripts/editor/latex-markdown-paste.test.ts`, `latex-markdown-detect.test.ts`, fixtures

Changed:

- [html2latex.ts](../src/lib/latex/codemirror/visual/html2latex.ts): imports `latex-text.ts`; in phase 4, its headings, tables and italics use the shared emitters
- [paste.ts](../src/lib/latex/codemirror/visual/paste.ts): shares the context check and yields to the Markdown handler
- [markdown-rendering.ts](../src/lib/markdown-rendering.ts): `markdownParsePlugins()`
- [latex-editor.tsx](../src/components/libera/latex/latex-editor.tsx): installs the extension in both modes, the dialog state, the notice
- [latex-ai-menu.tsx](../src/components/libera/latex/latex-ai-menu.tsx): "Paste Markdown as LaTeX…" and "Convert Markdown to LaTeX…"
- [latex-citations.ts](../src/lib/references/latex-citations.ts): its escaper comes from `latex-text.ts`
- `docs/features/latex-editor.md`, `docs/features/latex-visual-editor.md`: the user guide

## Decisions

Decided 8 Nov 2026:

1. **The dialog opens only when the paste has headings or tables.** Simpler Markdown (formatting, lists, links, math, code) is converted straight away, with a notice that offers "Paste as plain text instead". "Always ask" and "Never ask" stay available as settings (§6.1).
2. **Italics default to `\emph`.** `\textit` is an option. html2latex already writes `\emph`, so the two pastes agree out of the box (§4.2).
3. **`\usepackage` lines are never added automatically.** The user keeps final control over the preamble. Missing packages are listed with a Copy button. When the root is the current file, an "Add to the preamble" checkbox is offered, off for every paste and never remembered (§4.9).
4. **Word and Google Docs pastes get the same dialog later**, in phase 4, through the shared emitters and the same "ask" rule (§9).
5. **Horizontal dividers are always dropped.** `---`, `***` and `___` produce nothing, and there is no option for them (§4.1).

## What changed while building

- **HTML pastes go through the Markdown converter.** Instead of making `html2latex.ts` option-driven, `markdown-paste/html.ts` turns clipboard HTML into the same mdast the Markdown parser produces (headings, lists, tables with `colspan`, MathML and KaTeX annotations, Word and Google Docs span styles). Both pastes therefore share one emitter, one dialog, one set of remembered settings and one notice. `html2latex.ts` stays as the Visual mode's fallback and keeps its tests; it now imports its escaping from `latex-text.ts`. Rich text is still converted in the Visual mode only, as before.
- **Math is read with the user's markers and the common conventions.** The math markers from Preferences → Markdown reach the LaTeX editor (`workspace-panel.tsx` → `LatexWorkspace` → `LatexEditor`), so Markdown copied from the user's notes reads as it does there, custom markers included. `pasteMathMarkers()` (`markdown-paste/markers.ts`) then adds `$…$`, `$$…$$` and `\(…\)` inline and `\[…\]` and `$$` on lines of their own as display, where the user's settings do not already claim the opener, because a paste may come from ChatGPT, GitHub or Obsidian. Detection leaves formulas written with any of these markers out of its LaTeX score.
- **Narrative citations** (`@key`) convert only when the project's bibliography or References library knows the key; otherwise `@alice` stays text. Bracketed citations always convert.
- **`latex-citations.ts` keeps its own escaper.** It serves the LLM export with `encodeLatex`, whose output the export's tests pin; merging it was not needed for the paste.
- **Packages** are never added by themselves (decision 3). The notice lists them with a Copy button; the dialog adds them only when "Add to the preamble" is ticked, and only when the preamble is in the open file before the paste.
- **`libera-macro` blocks** are expanded by the Markdown macro plugin, as in the preview, rather than written as `\newcommand`.
- **Not built:** a custom clipboard type carrying the source note's path (for relative image paths), Obsidian's `==highlight==`, `[[wikilinks]]` and callout titles beyond GitHub-style alerts, and downloading remote images.

### After the review (8 Nov 2026)

A review of the first build (Codex, `gpt-6.1-sol` at `xhigh` reasoning) found these, now fixed and tested in `latex-markdown-paste.test.ts`:

- **TeX safety.** `^^` notation (`^^5c` is a backslash) is refused in formulas, kept LaTeX and heading templates. LaTeX written in the text is now an **allowlist**: a piece is kept only when every command and environment in it is a known text command (math commands inside it), or one the document itself defines (`\newcommand`, `\newtheorem`… read from the preamble and the macro sources); file readers and writers such as `\lstinputlisting`, `\verbatiminput`, `filecontents` and pdfTeX's file primitives are on the refused list as well. A command whose argument never closes is text as a whole. Every generated `lstlisting` turns off `escapechar`, `escapeinside`, `mathescape` and `texcl`, so a document's `\lstset` cannot make pasted code run as TeX. Heading templates take exactly one `#1` and no other `#`.
- **HTML.** `colspan`/`rowspan` are read as whole numbers from 1 to 64 (`colspan="Infinity"` hung the converter), row spans keep later cells in their columns (with a warning), `<caption>` becomes the caption, and paragraphs inside a cell become line breaks.
- **Editor.** Requests are queued and each dialog gets fresh state. The context is computed again when the dialog closes, so labels and packages added meanwhile are seen. The notice's actions replace the pasted LaTeX only while it is still there unchanged (the notice now tracks the whole insertion, blank-line padding included), and no notice appears when suggest mode turned the paste into a suggestion. A closed editor takes nothing. Each paste is its own undo step, in the local history and in the shared tab's undo manager. ⇧⌘V and pastes into math, comments or the preamble are marked so the Visual mode's HTML paste does not convert them either. `\usepackage` lines go after a `\usepackage` whose arguments span lines, and a commented `\begin{document}` does not count. Insertion no longer indents verbatim contents.
- **Context.** The build's engine choice and the compile root reach the converter (image paths are written for the folder TeX runs from, and may not climb above the notebook). Library aliases cite the key the bibliography has. Lists and quote environments around the paste count toward LaTeX's nesting limits. The section at the cursor ignores verbatim blocks and macro definitions.
- **Conversion.** `\verb` is never written inside another command's argument. `\hl` and `\st` hold only what soul can typeset (links, footnotes, citations, code and math inside keep their text, unmarked, with a warning). A display environment inside running text is made inline (`aligned`, `gathered` or its content); alone in its paragraph it is displayed. Several footnotes in one table get their own numbers, and a footnote inside a footnote goes in parentheses. A caption paragraph leaves the text only when caption detection is on and that table writes a caption. Merged cells never take `\newline`. `longtable` falls back to `tabular` in two-column documents (and is disabled there in the dialog). Repeated headings get GitHub's `-1`, `-2` anchors, starred headings publish no anchors, and a typed table label already in use gets a number. `ℝ` in text, matrices and `equation*` now report their packages.
- **Detection.** A linear scan replaces the fence expression that backtracked on long runs of backticks, formula patterns are bounded, single-column tables count, Markdown inside a LaTeX `verbatim` block does not outweigh it, and `~~strike~~` is a weak signal. Formatted HTML wins over list-like plain text only in the Visual mode, where it can be converted.
- **Dialog and settings.** Focus starts in the dialog (its first choice, or Paste) and stays there. The first heading row can stay **Automatic** or be fixed. A toggle controls taking "Table 1: …" lines as captions. The preview follows the other choices a moment later on large pastes. Saved settings are written one after another, the server refuses a non-object body, and `!` alone is no placement. The parser is preloaded when the editor is idle. The notice lists every warning and restarts its time for each paste.

Still open from the review:

- ~~**History after "Paste as plain text instead"**~~: fixed in the second review (below).
- **LaTeX written in Markdown that Markdown has already changed**: CommonMark removes the backslash of `\%`, and GFM turns a URL inside `\href{…}` into a link, before the converter sees the text; such commands are shown as text rather than kept.
- **Quotation marks across formatting** (`"**hi**"`): each text run is converted on its own, so the pairing can be wrong.
- **Detection stays conservative**: a single `**bold**` or a lone link scores below the threshold and pastes as written (Paste Markdown as LaTeX… converts it).
- **Smaller items**: the preview is a `<pre>`, not a highlighted CodeMirror; the notice sits at the bottom of the editor, not under the cursor; the parser runs the preview's full plugin list (source map and bibliography included); citation conversion fakes reference entries for `biblatexCitation`; `ModalDialog` itself still has no focus trap (this dialog adds its own).
- **Tests not written**: compile checks of the fixtures with TeX, real Yjs and suggest-mode tests (suggest mode is simulated with a transaction filter), and React integration tests of the queue and the dialog.
- **Files**, beyond the plan's list: `markdown-paste/analyze.ts`, `choices.ts`, `html.ts`, `src/lib/latex/markdown-paste-storage.ts`, `latex-paste-notice.tsx`; tests in `scripts/editor/latex-markdown-paste.test.ts`.

### After the second review (10 Nov 2026)

A second review (Codex, `gpt-6.1-sol` at `xhigh`) found these, now fixed and tested in `latex-markdown-paste.test.ts` and `latex-markdown-paste-editor.test.ts`:

- **Conversion.** A footnote that refers to itself (directly or through another) is written once, with a warning, instead of overflowing the stack. Prices stay text: under `currencyDollars` (set by `pasteMathMarkers`, so for pastes only; the preview is unchanged) a `$` followed by a digit, or after a space in a formula that began with a digit, closes no formula. ©, ® and ™ keep their TeX spellings under pdfLaTeX instead of being dropped as emoji. Unicode symbols inside a text argument of a formula (`\text{α}`) become `\ensuremath{\alpha}`. LaTeX written around inline math (`\textbf{foo $x$}`) is kept whole, read from the source across the text and math nodes. Commands kept from the text report their packages (`\eqref` amsmath, `\cref` cleveref, `\SI` siunitx, `\ce` mhchem…); amsart and beamer count as loading amsthm. HTML blocks in Markdown go through `html.ts`, so their paragraphs, formatting, images and `<details>` convert. Reference-style links to the paste's own headings (`[x]: #heading`) turn labels on and become `\hyperref`. A `|` inside a formula or code span in a table row stays in its cell (swapped for a placeholder before parsing; GFM itself would split it).
- **Where the paste lands.** The context knows when the paste is inside a float (`container: "float"`: tables and images get no float, a table caption is the float's), a box (`"box"`: tcolorbox, minipage, mdframed…; no caption either) or a footnote's text (`inFootnote`: footnotes in parentheses, footnoted links as text). A callout the converter writes as a `tcolorbox` is a box for what it holds. `longtable` falls back to `tabular` inside floats and boxes. Footnotes in a `longtable`'s header are marks in the first header only, their texts in the first body row.
- **Rich text.** Word's `mso-list` paragraphs become nested `itemize`/`enumerate` (with the typed start number). MathML without a TeX annotation is read as TeX (`mathml.ts`: scripts, fractions, roots, accents, limits, tables, fences); its tokens cannot spell commands. A table cut at 64 columns or 5,000 rows says so. Rich text converts in Source mode too, through the same request flow, unless Markdown conversion is off, its plain text carries LaTeX signals, or it is only a `<pre>`/`<code>` block.
- **Editor.** Saved settings reach later pastes (the store's load no longer returns its first result forever). Every request remembers the text at its range: when it changed before the result goes in (a collaborator's edit inside the selection), nothing is replaced and a message says why. When the target became math, a comment, verbatim or the preamble, a paste goes in as plain text and a conversion is declined. Local tabs take a paste of any size in one transaction, `\usepackage` lines included; shared tabs still send large pastes in pieces, which the undo manager captures as one step. "Paste as plain text instead" undoes the paste first while it is still the latest step, so one Undo goes back to before the paste. A paste at several cursors is CodeMirror's own plain paste in both modes. The context menu's **Paste** runs the same detection as ⌘V.

Not done from that review: downloading remote or embedded images into the project (still a follow-up), and converting a single `**bold**` or link pasted on its own (detection stays conservative).
