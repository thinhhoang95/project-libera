# D8: the Markdown Source editor on CodeMirror 6

**Status:** implemented behind a preference (default: Classic). Spike S2 of the [implementation plan](../implementation-plan.md) (§1 D8, §3 S2, §4 M1.4).
**Date:** 18 Oct 2026

## Decision

Collaboration binds to CodeMirror (`y-codemirror.next`), not to a textarea. The Markdown Source editor gets a CodeMirror 6 implementation next to the textarea one:

- **Preferences → General → Source editor:** *Classic* (the textarea, default) or *CodeMirror (beta)*. It is stored as `sourceEditor` in the Electron config, passed to Next as `LIBERA_SOURCE_EDITOR` (like Smart Paste, it needs a restart), and reaches the workspace as `markdownPreferences.sourceEditor`.
- The textarea editor is unchanged. Its pure helpers are now exported so the new editor reuses them instead of copying them.
- The CodeMirror editor takes the textarea editor's props unchanged, plus the collaboration seam (`extensions`, `documentSource`, `onViewChange`).

The fallback in the plan (a diff-based textarea binding to `Y.Text`) is not needed.

## How it fits

| Piece | File |
|---|---|
| Light wrapper: creates the adapter and puts it in the textarea ref, then loads the editor chunk on demand | `src/components/libera/markdown-source/markdown-source-editor.tsx` |
| The editor component: draft flow, keymaps, paste/drop, menus, find, file links, review | `src/components/libera/markdown-source/markdown-codemirror-editor.tsx` |
| Right-click menu and Find bar (the textarea editor's markup and labels) | `markdown-source-context-menu.tsx`, `markdown-source-find-bar.tsx` |
| Props (textarea props + seam) | `markdown-source/types.ts` |
| Textarea-compatible adapter | `src/lib/markdown-codemirror/textarea-adapter.ts` |
| Commands (toolbar insertions, formatting, headings, paste, file-link context) | `src/lib/markdown-codemirror/commands.ts` |
| Minimal-diff value sync and rebasing | `src/lib/markdown-codemirror/value-sync.ts` |
| Libera syntax decorations | `src/lib/markdown-codemirror/libera-syntax.ts` |
| Find decorations | `src/lib/markdown-codemirror/find.ts` |
| Base setup (GFM, language-data, history, theme) | `src/lib/markdown-codemirror/setup.ts` |

### The seam the toolbar uses

Everything outside the editor drives the Source editor through one `RefObject<HTMLTextAreaElement>` (`workspace.textareaRef`): the toolbar (`insertMarkdown`, link placeholder, file links, images), Fix ChatGPT equations, Enumerate Headings, snipping, the outline and slide outline, Global Search reveals, view-state capture, and scroll sync with the preview. They read `value`, `selectionStart/End`, `scrollTop/Left`, call `focus`, `setSelectionRange`, `addEventListener("input"|"scroll")`, and go through two helper modules: `replaceTextareaSelectionWithUndo` (`textarea-editing.ts`) and the measuring helpers in `textarea-position.ts`.

`CodeMirrorTextareaAdapter` implements that surface on an `EditorView`. Both helper modules check for the adapter first (one guard per exported function) and delegate; real textareas take the old path. So every toolbar action is the **same code** for both editors, and the results are identical by construction. The tests check this against a real textarea for every toolbar button on a table of selections.

The adapter exists before the view: the workspace copies the pane's ref in a layout effect and restores selection and scroll in animation frames, before the lazily loaded chunk can mount. The adapter keeps requested selection, scroll and listeners, and applies them when the view attaches. After unmount it keeps the last text and selection, like a detached textarea.

## Feature inventory and status

Legend: **Ported** (same behaviour), **Different** (deliberately different, why given), **Not ported** (why given).

### Editing and keyboard

| Feature (textarea editor) | Status in CodeMirror | Notes |
|---|---|---|
| Cmd/Ctrl+B, I, U wrap in `**`, `_`, `<u>…</u>` (placeholder "text"), one undo step, publish at once | Ported | `markdownFormatCommand`, `Prec.high` over CodeMirror's `Mod-i` (select parent syntax) and `Mod-u` (undo selection). |
| Tab / Shift+Tab change heading levels in a selection that contains headings; otherwise Tab is left to the browser | Ported | Reuses `changeSelectedHeadingLevels`. Without headings Tab is not handled, as in the textarea (no `indentWithTab`). Each step is its own undo step. |
| Cmd/Ctrl+F opens Find | Ported | Custom bar, see below. |
| Cmd/Ctrl+S save | Ported | Window listener in the workspace; CodeMirror does not bind it. |
| Cmd/Ctrl+Shift+L (add selection to AI chat) | Ported | Selection reader registered with `registerEditorSelectionReader`; `document-chat-panel.tsx` now accepts Markdown tabs in its CodeMirror branch. |
| Plain Enter / Backspace | Ported | `@codemirror/lang-markdown`'s list-continuation keymap is off (`addKeymap: false`) to match the textarea. |
| CodeMirror default keymap extras (move/copy line with Alt+arrows, Mod+Enter blank line, Mod+[ / ] indent, Mod+/ HTML comment …) | Different | Kept: none collides with an app shortcut (checked against the window-level shortcuts). |
| Multiple selections | Different | Off (CodeMirror default). The textarea has one selection; commands use the main one. |
| Line numbers | Ported | `lineNumbers()` gutter instead of the CSS counter. |
| Line wrapping, word breaking | Ported | `EditorView.lineWrapping`, `overflow-wrap: anywhere`. |
| Spellcheck, autocorrect, autocapitalize off | Ported | |
| Font family, size, line height from preferences and zoom | Ported | Same CSS variables as the LaTeX/code editors. |
| Read-only while review is locked | Ported | `useCodeMirrorReview` → `setCodeMirrorReviewLocked`. |

### Undo semantics

| Behaviour | Status | Notes |
|---|---|---|
| Typing groups into undo steps | Different | CodeMirror `history()` grouping (500 ms) instead of the browser's native textarea undo. |
| Toolbar / shortcut / paste / heading edits are one undo step each | Ported | `isolateHistory("full")` on each, like one native `insertText`. |
| Outside value changes (Fix ChatGPT equations, AI Rewrite/Write/Format, image and snip insertions, Enumerate Headings) | Different, better | Applied as a minimal change that stays **undoable** and keeps the caret. The textarea assigns `value`, which resets the native undo stack. |
| Review undo/redo intercept (Cmd/Ctrl+Z when the review's last step matches) | Ported | Shared `useCodeMirrorReview`. |

### Highlight overlay and syntax

| Construct | Status | Notes |
|---|---|---|
| ATX headings coloured per level (1, 2, 3, 4–6) | Ported | Line classes `cm-md-heading-N` on the same `--markdown-editor-heading-N` tokens. Setext headings are coloured too (the overlay did not). |
| Blockquote lines (`>`) | Ported | `cm-md-quote`, `--markdown-editor-blockquote`, plus a grey left rule. |
| Coloured boxes `y> … s>` | Ported, richer | Box tone plus the box's colour as a left rule and tint; the prefix is dimmed. |
| Fenced and indented code excluded from tones | Ported | From the Lezer tree; fenced code is also highlighted by language (language-data). |
| `[color=#…]…[/color]` | New | Text shown in its colour; markers dimmed. |
| `>>>…<<<`, `y>>>…<<<` … `s>>>…<<<`, `==…==` | New | Background tint in the highlight colour. |
| `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and custom markers | New | Uses the configured math markers (Preferences → Markdown); markers inside math are not treated as Libera syntax. |
| `<u>…</u>` | New | Underlined. |
| `<span data-font-size … data-line-height …>` | New | Dotted underline, tooltip with the size and spacing. |
| Inline code and code blocks | Ported, richer | Monospace tint for inline code; Libera syntax inside code is not decorated. |
| Emphasis, strong, strikethrough, links | New | Markdown token styles. |
| Find matches and the active match | Ported | Same classes and colours (`markdown-editor-find-match[-active]`). |
| Review anchors and agentic-review suggestion ranges | Ported | Same `review-source-highlight` class through the shared CodeMirror review field. |
| Light and dark theme | Ported | All colours are the app's CSS variables. |

### Libera features

| Feature | Status | Notes |
|---|---|---|
| Toolbar: bold, italic, underline, headings, list, code, math block, link dialog, highlight colours, text colours | Ported | Through the adapter (same `insertMarkdown`). Also available as `markdownInsertCommand`. |
| Box colour (current line or selected lines, re-colouring an existing box) | Ported | Same `createMarkdownBoxInsertion` path. |
| File-link button (`[link]()` placeholder) and file-link picker while typing `](` | Ported | Same trigger rule (`fileLinkDestinationAt`), same popup component and sections, ↑/↓/Enter/Escape at highest precedence. |
| Insert image from file / existing image / gallery | Ported | Workspace paths through the adapter and the value prop. |
| Paste images; drop images (with "Drop image to insert" overlay) | Ported | Same `onInsertImageFile(file, selection)`; drop position from `posAtCoords`. |
| Paste rich HTML as Markdown, `text/markdown` as is | Ported | `sourcePasteEdit`, same rules (malformed HTML falls back to plain text). |
| Smart Paste | Ported | Same `smartPasteMarkdown` and caret; one undo step. |
| Fix ChatGPT equations | Ported | Workspace sets the normalised draft; applied as a minimal, undoable change with the caret kept. |
| Enumerate Headings | Ported | Same path as Fix ChatGPT equations. |
| Snip as image / Snip as Markdown (PDF-to-Markdown snip) | Ported | The workspace reads selection and scroll from the adapter when the snip starts and restores them after inserting. |
| Slide decks (slide outline navigation, restore to slide, presenter) | Ported | Slide outline calls `focus`, `setSelectionRange`, `scrollTextareaToOffset` on the adapter. |
| Outline navigation, heading drag/move/delete restore | Ported | Same adapter calls. |
| Global Search reveal | Ported | `scrollTextareaToOffset(..., { block: "center" })` → `EditorView.scrollIntoView`. |
| Right-click menu: AI Format, Indent/Unindent Headings, AI Rewrite (quick prompts with `/`), Write with AI (+ "Whole document" toggle and cached-thread icon), AI Image to Markdown | Ported | Same items, labels and callbacks. Right-click outside the selection moves the caret first (as a browser does in a textarea, and as the LaTeX editor does). |
| AI activity indicator while formatting/converting | Ported | `beginAiActivity`. |

### Find and Replace

| Feature | Status | Notes |
|---|---|---|
| Find bar with count, previous/next, Enter / Shift+Enter, Escape | Ported | The textarea editor's bar, not CodeMirror's panel, so Wildcards and labels match. |
| Replace, Replace all, Wildcards (`*`, `?`) | Ported | `findTextMatches` / `replaceTextMatches`; Replace all is one undo step. |
| Prefill from a one-line selection | Ported | |
| Closing keeps the viewport | Ported | |

### Preview, review, drafts, IME

| Feature | Status | Notes |
|---|---|---|
| Scroll sync editor ↔ preview (anchor at 60 %), preview double-click to source, view-state capture | Ported | `textarea-position.ts` helpers answer from CodeMirror's height map (off-screen text included) and from `coordsAtPos` when the line is rendered. Scrolling uses `EditorView.scrollIntoView`. |
| Draft published after a 250 ms pause, deferred during composition | Ported | Same contract as the textarea and LaTeX editors. |
| `registerEditorDraft` reader (`getTabDraft`) publishes and returns the live text | Ported | Also on `pagehide`, blur, canvas view-state capture and unmount. |
| Echoes of published drafts never overwrite newer typing | Ported | Same published-draft list. |
| Selection reported (debounced 120 ms, flushed on blur and unmount) | Ported | |
| Review mode: bridge registration (`isComposing`, `snapshot`, `apply`, `focus`), Cmd/Ctrl+Alt+M comment gesture, mouse-up selection, anchor highlights | Ported | Shared `useCodeMirrorReview` (the hook the LaTeX editor uses). Review results are applied as minimal changes. |
| IME composition | Ported | CodeMirror's own composition handling. Outside values that arrive during a composition are held and applied when it ends. Needs the manual IME matrix (👤) before the default flips. |

### Not ported

| Item | Why |
|---|---|
| The highlight overlay's DOM (the `<pre>` mirror) | Replaced by decorations; nothing outside the editor used it. |
| Native textarea undo stack | Replaced by CodeMirror history (see Undo). |

Nothing in the inventory is left unported.

## Collaboration seam (for the next wave)

- `extensions?: Extension[]` go into a compartment and can be swapped in place.
- `onViewChange(view | null)` gives the binding the `EditorView` (also `adapter.editorView`).
- `documentSource: "value"` (default): `value` is the document, applied as a minimal common-prefix/suffix change (`value-sync.ts`), never a whole-document replacement, so caret and history survive.
- `documentSource: "external"`: the injected extension owns the content.
  - `value` is the initial text; afterwards a new `value` is treated as an intent. It is diffed against the draft the workspace last saw and rebased through the changes made since (`rebaseTextChange`), so a workspace edit (toolbar fallback, AI Rewrite, Fix equations) lands on the live shared text.
  - A change that would rewrite the whole non-empty document is refused.
  - Every change, local or remote, is published through `onChange` as a derived draft (after 250 ms, or at once after applying a value), so `tab.draft` and its consumers stay current.
  - The editor never dispatches a whole-document `Transaction.remote` replacement.
- The mode is fixed for the editor's lifetime; remount (key) to switch.

## Tests

- `scripts/editor/markdown-codemirror-commands.test.ts`: every toolbar button × a table of selections, through a real textarea and through the adapter and the command (text and selection equal); file-link insertions; Cmd+B/I/U; Tab/Shift+Tab; Smart Paste and rich paste; adapter geometry and pre-attach behaviour; minimal diffs, surrogate pairs and rebasing; selection and undo kept by a value change.
- `scripts/editor/markdown-codemirror-syntax.test.ts`: the decorations recognise each Libera syntax, skip code, follow custom math markers, and are drawn with the app's classes.
- `scripts/editor/markdown-codemirror-editor.test.ts`: the component's draft flow, flush on unmount, minimal-diff values, Fix ChatGPT equations parity with the textarea, shortcut and paste parity with the textarea component, image paste, Find/Replace with wildcards, context menu, the lazy wrapper's ref, external mode (no whole-document replacement, derived drafts, rebasing), and review mode (bridge, anchors, Cmd/Ctrl+Alt+M, focus).

## Before the default flips to CodeMirror

1. Use it in the running app (light and dark, Electron on Windows and macOS): scroll sync accuracy on long notes with images, find, the file-link popup position, context menu, drag-and-drop, slides. These were checked by tests in jsdom only; jsdom has no layout. A dev server could not be started in the isolated clone used for this work (the shared `node_modules` lacks the `lightningcss` Windows binary for webpack, and Turbopack rejects the junctioned `node_modules`).
2. The manual IME matrix (👤): Vietnamese Telex, Japanese, Chinese, including a draft publish and a toolbar action during composition.
3. A performance check on a 1 MB note (typing latency, decoration rebuild on scroll).
4. Then change the default in `normalizeMarkdownSourceEditor` (`src/lib/markdown-preferences.ts`) and `normalizeSourceEditor` (`electron/main.cjs`), and keep Classic selectable for one release.
