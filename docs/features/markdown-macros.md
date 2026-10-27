# Markdown macros

Markdown macros work like LaTeX macros, defined in the note itself. Write the definitions in a fenced block tagged `libera-macro`, and use them anywhere in the note: in text, in inline math and in display math.

````markdown
```libera-macro
% Math macros: the body is wrapped in math markers
\fset = $\mathcal{F}$
\R = $\mathbb{R}$
\norm = $\lVert #1 \rVert$
\energy = $$E = mc^2$$

% Text macros: the body is Markdown
\lab = Libera Lab
\newcommand{\theorem}[2]{**Theorem \counter-theorem (#1).** *#2*}
```

Let \fset be a family of subsets of $\R^n$ with $\norm{x} \le 1$.

\theorem{Pythagoras}{Given a right triangle with legs $a, b$ and hypotenuse $c$, $a^2 + b^2 = c^2$.}

\theorem{Euclid}{There are infinitely many primes.}

\energy
````

renders as:

> Let $\mathcal{F}$ be a family of subsets of $\mathbb{R}^n$ with $\lVert x \rVert \le 1$.
>
> **Theorem 1 (Pythagoras).** *Given a right triangle with legs $a, b$ and hypotenuse $c$, $a^2 + b^2 = c^2$.*
>
> **Theorem 2 (Euclid).** *There are infinitely many primes.*
>
> $$E = mc^2$$

The note's file keeps the macros as you wrote them. They are expanded whenever the note is shown or exported, so changing a definition changes every place it is used.

## Defining macros

A macro block holds one definition per line (a `\newcommand` body may run over several lines). Lines starting with `%` are comments. A note may have several macro blocks; each definition applies to the whole note, wherever its block is, and a later definition of the same name wins.

| Form | Example | Arguments |
| --- | --- | --- |
| `\name = value` | `\lab = Libera Lab` | `#1`…`#9` in the value |
| `\name[n] = value` | `\pair[2] = ($#1$, $#2$)` | `n` |
| `\newcommand{\name}[n]{body}` | `\newcommand{\theorem}[2]{…}` | `n`, or none without `[n]` |
| `\newcommand\name{body}`, `\renewcommand`, `\providecommand` | | as `\newcommand` |
| `\def\name#1#2{body}` | `\def\twice#1{#1, #1}` | one per `#n` |

Names are letters only, as in LaTeX: `\fset2` is not `\fset` followed by `2`. Arguments are `{…}` groups right after the name (spaces between them are allowed); braces inside an argument must balance, and `\{` and `\}` do not count. A use without enough arguments is left as written.

In a body, `#1`…`#9` are arguments and `##1` is a literal `#1`, as in LaTeX; `##` before anything else is plain Markdown, such as a heading. A hex color such as `#2563eb` or `#2563ebcc` is kept as written, so `\newcommand{\bluequote}[1]{>[color=#2563eb]#1[/color]}` takes one argument.

An argument may run over several lines and paragraphs. Blank lines at its start and end are dropped, so `{` and `}` may sit on lines of their own, and in a text macro the argument continues the container its parameter is in: every line of `> #1` stays in the quote (or of `b> #1` in the colored box), every paragraph of `- #1` or `1. #1` in the list item, and in a heading (`## #1`) or table row (`| #1 |`) the lines join with spaces. Inline Markdown cannot cross a paragraph, so a wrapper right around the parameter, such as `[color=#2563eb]#1[/color]`, `**#1**`, `~~#1~~` or a highlight, is closed and opened again around each paragraph, list item and heading of the argument; code blocks, tables and rules in it are left unwrapped. In the Visual editor an argument may run over paragraphs, quotes, lists (task lists too), headings, code blocks and rules, as in the Markdown; the blocks it covers are hidden behind its expansion, shown in the block where the macro starts. Display math and tables end the stretch an argument can cover there, so equation counters keep document order. Braces in an argument count wherever they are, code included, so a code block with an unbalanced `{` cannot sit in one.

### Math macros and text macros

A body wrapped entirely in `$…$`, `$$…$$`, `\(…\)` or `\[…\]` makes a **math macro**. Its LaTeX goes in wherever it is used:

- Inside math (`$\fset \subset \R$`, or a display equation), the markers are stripped: `$\mathcal{F} \subset \mathbb{R}$`.
- In text, it becomes inline math: `\fset` is written as `$\mathcal{F}$`. A display macro (`$$…$$` or `\[…\]`) alone on its line becomes a display equation; elsewhere it is inline.

The first pair of each kind under Preferences → Markdown → **Equation markers** is used for the math a macro writes.

Any other body makes a **text macro**: Markdown, with its arguments filled in. It may contain formatting, math, links, other macros and counters, and it may span several paragraphs (a whole theorem environment, say). A use inside a list item or a quote keeps the expansion in that item or quote. Text macros are not expanded inside math.

Macros may use other macros. Expansion stops after 16 levels, so a macro that uses itself does not hang the note.

## Counters

`\counter-name` needs no definition. Each use is the next number of that counter, counting from 1 in the order the uses appear in the note: `Figure \counter-figure` … `Figure \counter-figure` reads Figure 1 … Figure 2. Counters are independent of each other (`\counter-theorem`, `\counter-lemma`), and they count inside macros too, which is what numbers each `\theorem` above. Counter names start with a letter and may contain letters, digits and `_`.

## What is not expanded

- Code: inline code and fenced code blocks show macros as written. Use inline code to write a macro's name literally.
- Text macros inside math.
- A command with no definition (`\alpha` stays `\alpha`), and an escaped backslash in the Source editor (`\\fset`).

## In the Visual editor

The macro block is shown as a box with a header, **Macros: 5 definitions**, that folds and unfolds the definitions. It starts folded when it has definitions and open when it is new. If a line is not a definition, or a body uses `#3` in a two-argument macro, the header says **· 1 problem** and the open block lists each problem by line; the rest of the block still works.

Type ```` ```libera-macro ```` and a space (or Enter) at the start of a line to start a macro block.

Each use of a macro or counter shows its expansion, underlined faintly. When the caret reaches it (click it, or move onto it with the arrow keys), the source appears so you can edit it; it shows its expansion again when the caret leaves. Formulas that use macros render expanded, and every use updates as soon as a definition changes.

Saving writes the macros as typed: the Visual editor no longer escapes a backslash in front of a letter (`\fset` is not saved as `\\fset`). Since `\\fset` and `\fset` are the same text in the Visual editor, a literal macro name belongs in inline code.

## Expand macros

**Expand macros** (the `{}` button in the Visual and Source toolbars, enabled when the note uses macros or counters) opens a copy of the note in a new, unsaved tab named `<note> (expanded).md`. In the copy every macro and counter is replaced, math macros are written as ordinary math, and the macro blocks are removed: it is plain Markdown that any other app shows the same way. Inspect it, then save it (it is offered in the note's folder) or close it. The note itself is not changed. Relative image paths are kept, so save the copy in the same folder for its images to show.

## Where macros are expanded

- The Source editor's preview, the full-screen preview and the preview window.
- The Visual editor (see above).
- Slides: a deck's macro block applies to every slide, and counters continue from slide to slide.
- PDF export, and LaTeX PDF export (the note is expanded before it is converted, so the LaTeX holds no macros).
- AI Chat and the AI Agent (see below).
- Anything else that renders Markdown with Libera's renderer, such as global search previews.

## In AI Chat and the AI Agent

Assistants tend to write a note's macros back: asked about the note above, a reply may say "every \fset is closed". The Chat panel, in both Chat and Agent mode, renders messages with the macros of:

- every document attached to the conversation (as it was when it was attached), and
- the note open in the editor, as it is now.

If two of them define the same macro, the open note wins, then the most recently attached document. Your own messages expand too, so you can ask "what is \fset?". Counters number within each message.

Both assistants are told how macros work. They may use a note's macros in replies. When the Agent edits a note, it keeps the macros and macro blocks as written, and uses the note's macros for new text instead of expanding them.

**Copy response as Markdown** copies the reply as written, with its macros, so it reads correctly when pasted into the note. Exporting a chat (to a new note or into a notebook) expands the macros, so the exported note reads the same without the definitions.

The Agent can read files that are neither attached nor open. Macros from such a file are not expanded in its replies; open the note, or attach it with @, to use its macros.

## Implementation

- `src/lib/markdown-macros.ts`: parsing definitions, expanding a document (`expandMarkdownMacros`, which maps every offset back to the source), and `remarkMarkdownMacros`, which expands the source before remark parses it and points the tree's positions back at the original. It is the first plugin in `markdownRemarkPlugins` (`src/lib/markdown-rendering.ts`), so the renderer, the preview worker and the PDF export share it, and source maps, citations and review ranges still refer to the file as written. `markdownMacroScopes` carries definitions and counters across a deck's slides (`markdown-slides-viewer.tsx`).
- `src/lib/tiptap-macros.ts`: the Visual editor's plugin. It reads the macro blocks, finds each use (paragraphs are read as Markdown-like text, with inline math written with its markers), numbers counters in document order, and draws expansions as widgets with the source hidden until the caret reaches it. `src/lib/tiptap-math.ts` renders math nodes with their expanded LaTeX and re-renders them when the macros change.
- `src/components/libera/tiptap-live-code-block-view.tsx`: the folding macro block. `src/lib/tiptap-markdown.ts`: the ```` ``` ```` input rule for languages with hyphens, and writing `\name` without an escape.
- `src/components/libera/expand-macros-button.tsx`, used by `markdown-toolbar.tsx` and `tiptap-markdown-editor.tsx`; `workspace-panel.tsx` opens the expanded copy.
- `src/lib/latex-export.ts` expands macros before conversion.
- AI: `combinedMacroScope` and `macroScopeKey` (`markdown-macros.ts`) build the Chat panel's scope in `document-chat-panel.tsx`, passed to chat messages and to `agent-activity.tsx`. `exportChatMarkdown` (`document-chat.ts`) expands exports. `MARKDOWN_MACROS_INSTRUCTION` is a constant in the chat route's and the agent's (`agent/prompt.ts`) system prompts, so they stay cacheable.

## Checks

`node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/markdown-macros.test.ts`

The tests cover the definition forms and problems, math and text expansion, counters, code and escapes left alone, display macros, expansions in lists and quotes, nested and recursive macros, rendering with source positions kept (renderer and preview worker), slide scopes, and the Visual editor: expansions, revealing the source at the caret, re-rendering math when a definition changes, saving macros unchanged, and the ```` ```libera-macro ```` input rule. They also cover chat scopes (which document wins, a stable key), chat replies rendered with and without a scope, chat export, and the macro instruction in the system prompts.
