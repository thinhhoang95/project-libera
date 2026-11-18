# Find & Replace with Patterns — design

Status: implemented on `feat/find-patterns` (engine in `src/lib/find/`, bar in
`src/components/libera/find/`). §15 records the decisions taken while building.

One find/replace engine and one find bar for every editor in Libera, with a
**Pattern** mode built for math and LaTeX:

| Find | Replace | Text | Result |
|---|---|---|---|
| `\(*\)` | `\[@1\]` | `\(4x+3\)` | `\[4x+3\]` |
| `\(*,*\)` | `\(@2,@1\)` | `\(4x+3,3y\)` | `\(3y,4x+3\)` |
| `\frac@n:arg@d:arg` | `\dfrac{@n}{@d}` | `\frac12 + \frac{a+b}{c}` | `\dfrac{1}{2} + \dfrac{a+b}{c}` |

`*` is a **hole**: it matches a piece of text and remembers it, and `@1`, `@2`, …
put the remembered pieces back in the replacement.

---

## 1. What exists today

| Surface | Find code | Modes | Replace |
|---|---|---|---|
| Markdown source, textarea and CodeMirror ([markdown-editor.tsx](../src/components/libera/markdown-editor.tsx), [use-markdown-source-find.ts](../src/components/libera/markdown-source/use-markdown-source-find.ts), [markdown-source-find-bar.tsx](../src/components/libera/markdown-source/markdown-source-find-bar.tsx)) | [text-find.ts](../src/lib/text-find.ts) | Plain (always case-insensitive), Wildcards (`*`, `?`, greedy, single line) | literal text only |
| TipTap rich editor ([tiptap-markdown-editor.tsx](../src/components/libera/tiptap-markdown-editor.tsx)) | [tiptap-find.ts](../src/lib/tiptap-find.ts) over `text-find.ts`, incremental per text block | same as above | `insertText`; takes the marks of the match start |
| LaTeX source + LaTeX Visual ([latex-editor.tsx](../src/components/libera/latex/latex-editor.tsx)) | stock `@codemirror/search` panel | plain, case, whole word, JS regex | `$1`, `$&` (CodeMirror's syntax) |
| Code editor ([code-editor.tsx](../src/components/libera/code-editor.tsx)) | stock `@codemirror/search` panel | same as LaTeX | same as LaTeX |

Gaps that shape this design:

- Two unrelated find UIs with different features and keys.
- Wildcards `*` is **greedy**: `s*d` on `sad and sold` matches the whole line, and
  `\(*\)` on `\(a\) and \(b\)` would swallow both formulas. Nothing is captured,
  so a replacement cannot reuse what `*` matched.
- TipTap math nodes are atoms with no text reading, so find can't see inside or
  across `inlineMath` / `blockMath` at all.
- "Fix ChatGPT equations" (`fixChatGptEquations`) is a hard-coded find/replace
  of exactly the `\(*\)` kind; it should become a preset of the general feature.

## 2. Goals and non-goals

Goals

1. One engine (`src/lib/find/`) and one find bar component for all four surfaces.
2. A pattern language a non-programmer can write after seeing one example, that
   understands brackets and LaTeX arguments, and that scales up to named, typed
   and regex-constrained holes.
3. One replacement language for both Pattern and Regex mode.
4. Show what a pattern means and what a replacement will produce before anything
   is changed.
5. Replace All is one undo step in every editor and one collaborative transaction.

Non-goals (for now): find across files of a LaTeX project or notebook (global
search covers discovery; project-wide replace is a later phase), structural
search over a full LaTeX parse tree, scripting (JS functions as replacements).

## 3. Modes and options

The find bar has a mode switch and toggles:

| Control | Values | Default | Notes |
|---|---|---|---|
| Mode | **Plain** · **Pattern** · **Regex** | Plain | replaces today's Wildcards checkbox and CodeMirror's regex toggle |
| Match case `Aa` | on/off | off | today Libera is always case-insensitive |
| Whole word `ab` | on/off | off | the match must start and end on word boundaries |
| Flexible spacing `␣` | on/off | off | Pattern mode: one space in the pattern matches any run of spaces/tabs, including none, and single line breaks |
| Preserve case | on/off | off | only when Match case is off: `word`→`Word` if the match was capitalised, ALL CAPS if it was all caps; applies to the replacement's literal text, captures keep their own case |
| In selection | on/off | off | limits matches to the selection made when it was turned on (mapped through later edits) |
| Where | Anywhere · Outside math · Inside math · Skip comments & code | Anywhere | see §7 |

The mode, toggles and the last 20 queries are remembered per editor kind
(Markdown, LaTeX, code), so LaTeX can keep Pattern on while notes stay Plain.

## 4. The pattern language

Everything in a pattern is literal text except these:

| Syntax | Meaning |
|---|---|
| `*` | a hole: any text (rules below), captured as `@1`, `@2`, … in order |
| `?` | exactly one character, also captured in that numbering |
| `@name` | a named hole; like `*` but referred to as `@name`. Using the same name twice means "the same text again" |
| `@name:type` / `@:type` | a typed hole (named or anonymous), see §4.3 |
| `@name/regex/` / `@/regex/` | a hole that must match a regular expression |
| `\*` `\?` `\@` | a literal `*`, `?`, `@` |

Every other backslash is literal, so LaTeX is typed as is: `\(`, `\frac`, `\%`,
`\{` are all plain text. `\\` is always read as the two-character pair (LaTeX's
line break), so `\\*` is "line break, then a hole", not an escaped star. Anything
the shorthand cannot say (for example a literal backslash-star, Markdown's `\*`)
is written as a regex hole: `@/\\\*/`.

### 4.1 How a `*` hole matches

Four rules make `*` do the obvious thing on math:

1. **Shortest first.** A hole takes as little text as it can while the rest of the
   pattern still matches. `$*$` on `$a$ and $b$` finds `$a$` and `$b$`, not one
   match from the first `$` to the last.
2. **Brackets stay balanced.** A hole never contains half a `{…}` group. It also
   keeps `(…)` and `[…]` balanced when it can; if no balanced match exists at
   that position (a half-open interval like `[0,1)`), the match is retried with
   only `{}` kept balanced. Escaped delimiters `\{ \} \( \) \[ \]` don't count
   as brackets. That is what makes `\(*,*\)` read `\(f(a,b),3y\)` as `f(a,b)` and
   `3y`: the comma inside `f(a,b)` is not at the top level.
3. **Within a paragraph.** A hole can cross a single line break but never a blank
   line. (LaTeX forbids blank lines inside math, so every math formula fits;
   `@x:block` lifts this for environment bodies.)
4. **Edge holes take an operand.** A hole at the very start or end of the
   pattern, with no literal on that side, would always be empty under rule 1.
   Instead it takes the balanced run of text next to the literal up to a space or
   one of `$ & , ; = + - < > |`, a `\\` line break or an escaped delimiter such as
   `\(`; a trailing edge hole also leaves out a final `.:!?`. So `*^2` on
   `y = (a+b)^2` captures `(a+b)`, on `a+b^2` captures `b`, and `x_*` on
   `x_{ij} + 1` captures `{ij}`.

A hole may be empty (`\(*\)` matches `\(\)`). Matches never overlap and are found
left to right.

### 4.2 Examples

These become the engine's test table.

| Find | Replace | Before | After |
|---|---|---|---|
| `\(*\)` | `\[@1\]` | `\(4x+3\)` | `\[4x+3\]` |
| `\(*,*\)` | `\(@2,@1\)` | `\(4x+3,3y\)` | `\(3y,4x+3\)` |
| `\(*,*\)` | `\(@2,@1\)` | `\(f(a,b),3y\)` | `\(3y,f(a,b)\)` |
| `\(*,*\)` | | `\(a,b,c\)` | `@1`=`a`, `@2`=`b,c` (earlier holes are shortest; use `@x/[^,]+/` to forbid commas) |
| `$*$` | `\(@1\)` | `$a$ and $b$` | `\(a\) and \(b\)` |
| `\frac@n:arg@d:arg` | `\dfrac{@n}{@d}` | `\frac12`, `\frac\pi2`, `\frac{a}{b^{2}}` | `\dfrac{1}{2}`, `\dfrac{\pi}{2}`, `\dfrac{a}{b^{2}}` |
| `\textbf{*}` | `**@1**` | `\textbf{key}` | `**key**` |
| `\*\*@x\*\*` | `\textbf{@x}` | `**key**` | `\textbf{key}` |
| `@a+@a` | `2@a` | `x+x`, `x+y` | `2x`; `x+y` is not a match |
| `\begin{@env}@body:block\end{@env}` | `\begin{@env*}@body\end{@env*}` | an `equation` environment | `equation*` (the second `@env` must equal the first) |
| `*^2` | `\sq{@1}` | `(a+b)^2` | `\sq{(a+b)}` |
| `x_@i:arg` | `x[@i]` | `x_{ij}`, `x_1` | `x[ij]`, `x[1]` |
| `@p:num\%` | `@(p/100)` | `50\%` | `0.5` |
| `Fig. @n:int` | `Figure~\ref{fig:@n}` | `Fig. 3` | `Figure~\ref{fig:3}` |
| `\section{*}` | `\section{@(1.title)}` | `\section{related work}` | `\section{Related Work}` |
| `TODO` | `TODO-@#` | three `TODO`s | `TODO-1`, `TODO-2`, `TODO-3` |
| `\left@o:arg*\right@c:arg` | `@o@1@c` | `\left(x\right)` | `(x)` |

### 4.3 Hole types

| Type | Matches | Notes |
|---|---|---|
| `any` | the `*` rules above | default when no type is given |
| `block` | like `any`, but may cross blank lines | environment bodies, multi-paragraph spans |
| `line` | the rest of the line | greedy, never crosses a line break |
| `word` | letters, digits, `_` (Unicode) | non-empty |
| `int` | `-12`, `3` | |
| `num` | `-1.5`, `.5`, `2e-3` | what `@( )` arithmetic accepts |
| `space` | spaces and tabs | non-empty |
| `cmd` | one LaTeX command: `\alpha`, `\,` | |
| `arg` | one TeX argument: a balanced `{…}` group, captured **without** its braces, or else a single token (one character or one command) | what TeX itself reads after `\frac`; matches `\frac12` and `\frac{a}{b}` alike |
| `opt` | an optional `[…]` argument, or nothing | captured without brackets; empty when absent |
| `math` | one whole math span with its delimiters: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` | |

Unknown types are an error shown in the bar. The list is small on purpose;
`@x/regex/` covers the rest. A type name ends at the first character that is not
a letter, digit or `_`. `word`, `int`, `num`, `space` and `cmd` take their longest
run and never give part of it back.

### 4.4 Regex holes

`@name/regex/` matches where the JavaScript regular expression (Unicode mode)
matches at that position, then the rest of the pattern continues. It is the
escape hatch for anything the types miss: `@x/[^,]+/`, `@n/\d{4}/`,
`@/\\\*/`. `/` inside it is written `\/`.

### 4.5 `?`

`?` keeps today's Wildcards meaning (one character) so existing habits carry
over. The cost: `why?` in Pattern mode means "why plus one character". The parse
preview (§8) makes that visible; see open question 2.

## 5. The replacement language

The same in Pattern and Regex mode. Only `@` is special; `$`, `\`, `{` are
literal, so LaTeX replacements need no escaping.

| Syntax | Inserts |
|---|---|
| `@1` … `@9` | numbered capture (one digit; `@(12)` for more). Numbers count the anonymous holes (`*`, `?`, `@:type`, `@/re/`) only, so in `\left@o:arg*\right` `@1` is the `*` |
| `@name` | named capture (longest identifier, so `@(x)y` for a name followed by letters) |
| `@0` | the whole match |
| `@#` | the match counter, 1-based in document order (Replace All), or the active match's number |
| `@( … )` | an expression: `@(n+1)`, `@(p/100)`, `@(#+9)`, `@(1.upper)`, `@(x.lower)`, `@(x.title)`, `@(x.trim)`. Inside arithmetic a bare `1` is the number one; write `@(@1*2)` for capture 1 |
| `\@` | a literal `@` |
| line break | the replace field grows; Shift+Enter inserts a new line |

Arithmetic needs numeric captures; a match whose capture isn't a number shows
the error in its preview and is skipped by Replace All, which reports how many
it skipped. A reference to an unknown capture is an error and disables Replace.

In Regex mode, typing `$1`, `$<name>` or `$&` (the CodeMirror habit) shows a hint
"Use @1" with a one-click fix; `$` itself stays literal because LaTeX needs it.

## 6. Regex mode

JavaScript regular expressions with the `u`, `m` and `d` flags (`d` gives capture
positions, needed for rich replacements in TipTap). Named groups are available as
`@name`. Match case and Whole word apply as flags/wrappers.

JS regexes can backtrack catastrophically and can't be interrupted on the main
thread, so whole-document regex searches (Markdown source, LaTeX, code) run in a
worker with a ~750 ms deadline; on timeout the worker is terminated and the bar
says the expression is too slow. TipTap searches block by block, where text is
short, and keeps running on the main thread (open question 6).

## 7. Where (scopes)

| Scope | Rule |
|---|---|
| Anywhere | no restriction |
| Inside math | the match lies inside the content of one math span |
| Outside math | the match neither starts nor ends inside math (it may contain whole math spans, so `\(*\)` still works) |
| Skip comments & code | LaTeX: `%` comments, `verbatim`/`lstlisting`/`minted`, `\verb`. Markdown: code spans and code blocks |

Ranges come from one small scanner (`src/lib/find/regions.ts`) per flavor
(`markdown`, `latex`, `text`), reusing the math/comment detection that already
exists in the LaTeX and Markdown paste code where it fits. "Inside math" is how
you rename `x` to `y` in formulas without touching prose.

## 8. The find bar

```
┌──────────────────────────────────────────────────────────────────┐
│ 🔍 \(  ①  ,  ②  \)                            3 of 12   ↑  ↓   ✕ │
│    [Plain|Pattern|Regex]  Aa  ab  ␣  [Where: Anywhere ▾]  ⊡  ⓘ  ☆ │
│ ↳  \(  ②  ,  ①  \)                              Replace   All    │
│    \(4x+3,3y\)  →  \(3y,4x+3\)                                   │
└──────────────────────────────────────────────────────────────────┘
```

- **The pattern explains itself.** In Pattern mode holes are drawn as numbered
  coloured chips inside the find field (an overlay, like the textarea editor's
  match overlay), types and names as `① n:arg`. Replacement references take the
  same colours, so `@2` visibly points at the second hole.
- **Preview before replace.** The line under the replace field shows the active
  match and what it becomes. Hovering any match in the document shows its
  captures and its replacement.
- **Errors where they are.** An unknown type, unbalanced regex or unknown capture
  is underlined at its position with a one-line message; Replace is disabled.
  Warnings that don't block: adjacent untyped holes (`**`: the first is always
  empty), a pattern with no literal text.
- **ⓘ cheat sheet** with the §4.2 examples; clicking one fills both fields.
- **☆ presets.** Built in: `\( \)` → `\[ \]`, `$ $` → `\( \)`, ChatGPT equations
  (today's `fixChatGptEquations`), `\frac` → `\dfrac`, Markdown bold/italic ↔
  `\textbf`/`\emph`. Users save their own (find, replace, mode, toggles).
- **Keys:** Mod-F find, Mod-H (and Mod-Alt-F) find & replace, Enter / Shift+Enter
  next / previous, Mod-Enter Replace All, Alt-C case, Alt-W whole word, Alt-R
  regex, Alt-P pattern. Check against existing shortcuts before shipping.
- All labels go through `next-intl`; the `wildcards` strings are replaced.

## 9. Engine

`src/lib/find/`:

```ts
type FindMode = "plain" | "pattern" | "regex";
type FindFlavor = "markdown" | "latex" | "text";
type FindOptions = { mode: FindMode; matchCase: boolean; wholeWord: boolean;
  flexibleSpacing: boolean; scope: FindScope; flavor: FindFlavor };

type Capture = { index: number; name?: string; start: number; end: number };
type FindMatch = { start: number; end: number; captures: Capture[] };

compileFind(query: string, options: FindOptions):
  { ok: true; finder: Finder } | { ok: false; error: { message: string; from: number; to: number } };

interface Finder {
  key: string;                         // cache key for compiled query + options
  find(text: string, limit?: { from: number; to: number }[]): FindMatch[];
  crossesParagraphs: boolean;          // false → per-paragraph caching is exact
  parts: PatternPart[];                // for the chip overlay
}

compileReplacement(replacement: string, finder: Finder):
  { ok: true; replacer: Replacer } | { ok: false; error: … };

interface Replacer {
  render(text: string, match: FindMatch, counter: number): string | { error: string };
  // Literal text, capture slices and computed text, in order. TipTap uses this to
  // copy captured ranges with their marks instead of flattening them to text.
  pieces(match: FindMatch, counter: number): ReplacePiece[];
}
```

`text-find.ts` keeps `findTextMatches` / `replaceTextMatches` as thin wrappers so
existing callers keep compiling during the migration.

**Pattern matcher.** The pattern compiles to a token list (literal runs, holes,
back-references). Matching is a backtracking search, with these bounds:

- Candidate starts come from `indexOf` of the first literal run (or of the
  literal after a leading edge hole), so most of the text is skipped.
- A precomputed bracket table (one pass over the paragraph: matching partner of
  every `{}`/`()`/`[]`, ignoring escaped ones) lets a hole jump over a group in
  O(1) and enumerate only balanced ends.
- `(token, position)` failures are memoised while no back-reference is bound, which
  bounds the work by tokens × positions × paragraph length.
- A step budget (about 2 million steps per search); past it the bar says the
  pattern is too expensive instead of freezing the editor.
- Holes don't cross blank lines (except `block`), so when `crossesParagraphs` is
  false the text can be searched and cached paragraph by paragraph.

Plain mode is today's `indexOf` loop plus the case/whole-word options. Pattern
mode with no holes must return exactly what Plain returns (a property test).

## 10. Per-editor integration

All surfaces render one `FindReplaceBar` component fed by a small adapter:
`readText`, `setMatches(matches, active)`, `select(match)`,
`replace(matches, replacer)`.

**Markdown source (textarea and CodeMirror).** `useMarkdownSourceFind` swaps
`findTextMatches` for the engine and `replaceTextMatches` for `Replacer.render`.
Replace All stays one `replaceTextareaSelectionWithUndo` call over the span from
the first to the last match, as now. Decorations keep the existing classes.

**TipTap.**
- *Readings.* A text block is searched as its text plus a reading of each inline
  atom. Math atoms read as they would be written to Markdown with the configured
  math markers (`math-markers.ts`), e.g. `\(4x+3\)`; citations keep their
  `leafText`. This reading lives in `tiptap-find.ts`, **not** as `leafText` on the
  math schema, which would change `textBetween`, copy and paste. A `blockMath`
  node is searched as its own unit (`\[…\]`/`$$…$$`).
- *Valid matches.* A match either lies inside one math atom's LaTeX, or covers
  whole atoms. A match that cuts through an atom's delimiters is dropped.
- *Replacing inside math* (`\alpha` → `\beta`, or Where: Inside math) rewrites the
  atom's `latex` attribute.
- *Replacing across atoms* (`\(*\)` → `\[@1\]`) re-parses the rendered
  replacement as Markdown through `replaceTiptapRangeWithMarkdown`, so inline math
  can become display math and back.
- *Plain text replacements* are built from `Replacer.pieces`: literal pieces get
  the marks at the match start, capture pieces are copied from the document with
  their own marks. Swapping `**bold**, plain` keeps each part's formatting.
- A toggle "Replacement is Markdown" interprets the replacement as Markdown
  (`**@1**` makes bold) instead of literal text.
- Plugin state stores `FindMatch` with captures (positions mapped like `from/to`).
  The cache key becomes `Finder.key`. The incremental path and its
  "must agree with `createFindState`" invariant stay as they are.
- `fixChatGptEquations` becomes the ChatGPT equations preset run through this
  path, keeping its code/link protection via Where: Skip comments & code.

**LaTeX source and LaTeX Visual.** `search({ top: true })` and `searchKeymap` are
replaced by the shared bar (a CodeMirror panel hosting it, or the React bar
positioned like the Markdown one) plus a `StateField` like
[markdown-codemirror/find.ts](../src/lib/markdown-codemirror/find.ts). Flavor
`latex`. In Visual mode, selecting a match inside a rendered widget (math,
references) reveals its source the same way moving the cursor there does. Replace
All is one transaction with `userEvent: "input.replace.all"`, so it is one undo
step and one Yjs update when collaborating.

**Code editor.** Same as LaTeX with flavor `text` (brackets balanced, no math,
`Where` hidden).

## 11. Migration

- The Wildcards checkbox becomes the Pattern mode. `*` changes from longest to
  shortest-and-balanced, which fixes cases like `s*d` swallowing a whole line;
  `?` is unchanged. The setting isn't persisted today, so nothing needs migrating.
- LaTeX/code users lose CodeMirror's panel. Its features (case, whole word, regex,
  replace) are all present; `$1` gets the "Use @1" hint (§5).
- `findTextMatches` callers move to the engine; the wrapper is removed at the end.

## 12. Phases

1. **Engine** in `src/lib/find/` with the §4.2 table as tests, Plain/Pattern/Regex,
   options, replacement language, budgets. No UI changes.
2. **Shared bar + Markdown source** (textarea and CodeMirror): modes, toggles,
   chip overlay, preview, cheat sheet.
3. **TipTap**: captures in plugin state, math readings, mark-preserving and
   Markdown replacements, ChatGPT preset.
4. **LaTeX + code CodeMirror**: replace the stock panel, Visual-mode reveal,
   regex worker.
5. **Scopes and presets**: Where, In selection, saved presets, then batch
   "recipes" (an ordered list of find/replace pairs run as one undo step).

## 13. Tests

- Engine: the §4.2 table; Pattern-without-holes ≡ Plain; balance cases
  (`[0,1)`, `\{`, nested `{}`); edge holes; back-references; every type;
  replacement expressions and errors; step budget aborts on a hostile pattern
  (`*a*a*a*a…` on a long `aaaa…` paragraph) within the budget.
- TipTap: incremental ≡ full rebuild, now including captures; math readings
  with each configured marker pair; mark preservation on swap; inline ↔ display
  math; Replace All is one undo step.
- CodeMirror: one undo step, one transaction under collaboration, Visual-mode
  reveal.

## 14. Open questions (resolved, see §15)

1. **`@` as the capture sigil.** It reads well next to LaTeX (`\frac{@n}{@d}`) and
   clashes with neither `$`, `{}` nor `\`. The cost: an email address in Pattern
   mode needs `\@`. Alternative: `{{name}}`, which clashes with LaTeX's `{{…}}`
   and makes replacements like `\dfrac{{{n}}}` unreadable.
2. **Keep `?`** for continuity with Wildcards, or drop it (literal `?` in prose
   is common; `@/./` does the same job)?
3. **May `*` be empty?** Proposed yes (Word-compatible). `\(*\)` then matches `\(\)`.
4. **Pattern mode as the default in the LaTeX editor?**
5. **`$1` in Regex mode:** hint only (proposed) or accept it as an alias?
6. **TipTap Regex on the main thread** (per block, short text) or in a worker too?

## 15. Decisions taken while building

- **Open questions.** `@` is the capture sign (1); `?` stays one character (2);
  `*` may be empty (3); no editor defaults to Pattern mode, but each editor kind
  (Markdown source, rich, LaTeX, code) remembers its own mode and toggles (4);
  `$1` in Regex mode gets the "Use @1" hint and stays literal (5).
- A lone `@` in a pattern (not followed by a name, `:` or `/`) is literal, and
  Plain mode replacements are entirely literal, so plain search and replace of
  e-mail addresses needs no escaping.
- Regex holes give back characters (longest match first, then shorter ones that
  the expression also matches in full), so `\(@x/[^,]+/\)` works.
- Settings and user presets live in `localStorage` (per window profile, not
  synced between machines).
- Batch "recipes" (§12 phase 5) are not built; presets cover one pair each.
