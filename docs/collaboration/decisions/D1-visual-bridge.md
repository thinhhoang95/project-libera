# D1 — Visual editor over `Y.Text`: the block bridge (spike S1)

**Status:** recommended: keep D1's proposed default. The bridge is built for real, not as a throwaway spike.
**Date:** 18 Oct 2026
**Code:** `src/lib/collab/bindings/tiptap-*.ts`
**Tests:** `scripts/collab/tiptap-bridge*.test.ts`
**Related:** map §5 and §7.2, implementation plan §1 (D1), §3 (S1) and M1.4 (Visual).

## Decision

Shared Markdown stays plain source text in `Y.Text` (`ContentKeys.source`). The Visual (Tiptap) editor edits it through a block bridge that serializes and reparses only the top-level blocks a change touched.

S1's measurable criteria pass in headless tests. Two Visual editors and a Source participant converge under concurrent edits in paragraphs, lists, tables and headings. Untouched blocks keep their exact bytes. Remote typing does not move the local caret. A 1 MB note costs about 2 ms of bridge time per keystroke.

One S1 criterion is not verified yet: real IME commits (Vietnamese Telex, Japanese, Chinese) in Electron. jsdom can only simulate `view.composing`. Keep the D1 fallback (below) available until that manual check is done.

## How it works

### Block model (`tiptap-blocks.ts`)

The source is tiled into alternating **gaps** and **blocks**:

- A gap is the whitespace between blocks.
- A block is a top-level remark node, with the same ranges as `reviewBlocks` in `markdown-review.ts`.

Each tile records how many ProseMirror top-level nodes stand for it:

- A block is normally one node (a reference definition is zero).
- A gap holds the empty paragraphs that Tiptap creates for extra blank lines. Two or three newlines give none, four or five give one, and so on. The bridge measures this with Tiptap's own parser and serializes it back the same way (`gapEmptyParagraphs`, `serializeRun`).

Concatenating the tiles gives the exact source. Concatenating their nodes gives the ProseMirror document.

Tiles hold absolute Y.Text offsets, which are shifted on every change. They do not use `Y.RelativePosition`s: shifting 35k numbers costs microseconds, and the offsets are always exact.

Blocks are parsed one at a time with the editor's own extensions (`editor.markdown.parse`). Reference definitions from elsewhere in the note are appended so that links resolve, as `tiptap-review.ts` does. The Markdown parser can produce schema-invalid nodes, for example a heading as a list item's first child. `repairNode` fixes these deterministically, so every participant gets the same document.

remark is superlinear on long notes: one 1 MB parse takes about 18 s, while the same note in 50 KB pieces takes about 2 s. `sourceBlocks` therefore parses long texts in chunks. Each chunk is cut before a heading or paragraph that follows a blank line. Each seam is then checked by parsing its two neighbouring blocks together, and merged if the result differs. At a blank line, block structure depends only on the block before it, so the chunked result equals a whole-document parse. A test checks this, including fences, comments and `$$` blocks across seams and an unclosed fence.

### Local → Y

On a ProseMirror change, the bridge diffs the old and new top-level children by identity to find the changed node range. It maps that range to tiles:

- **Edit inside one block, same node count:** serialize only that block's nodes. If the paragraph has edge spaces, which remark puts in the neighbouring gap, include them in the diff.
- **Structural change** (split, merge, insert, delete, paste, empty paragraphs): rewrite from the end of the block on the left to the start of the block on the right. Separators and blank lines are regenerated consistently. Neighbouring blocks are never re-serialized.

The old and new source of that region are diffed character by character: common prefix and suffix, then a bounded Myers diff, never splitting a surrogate pair (`tiptap-text-diff.ts`). Only the changed characters go to Y.Text, in one transaction with the bridge's origin. CRLF notes keep CRLF in edited blocks.

The rewritten region becomes a "dirty" tile. Right after the write, the remote phase re-tiles it with remark:

- If the new source still means the same structure (node types and counts match), the user's nodes are kept.
- Otherwise the region is reparsed. Examples: two lists that merged, or a paragraph whose text now starts with `# `.

Timing:

- Serialization is throttled to at most every 50 ms (`flushDelay`). It also runs on blur, `pagehide` and `destroy`, and immediately for paste.
- `beforeTransaction` flushes pending typing before a paste, so each change carries its own provenance.
- While `view.composing` is true, nothing is sent. The bridge flushes after `compositionend`.

### Y → local

Y.Text events from other origins mark the tiles they touch as dirty, immediately and even during composition, so the block map always matches Y.Text.

The remote phase finds the smallest stable window around each dirty run: the clean blocks on either side must parse to themselves. If they do not (an unclosed fence, merged lists), the window widens, doubling each time. The window is then re-tiled, and only the changed nodes are reparsed and replaced in one ProseMirror transaction. That transaction has `addToHistory: false` and the meta `liberaCollabBridge: "remote"`. Unchanged nodes keep their identity.

Selection inside a replaced block is restored on the same source character: document position → source offset (by visible-text alignment) → mapped through the diff → position in the new nodes. Positions outside replaced blocks are mapped by ProseMirror.

If a remote change rewrites a gap's edge whitespace, the neighbouring blocks are re-checked (`markStaleEdges`). Otherwise a locally typed leading or trailing space could outlive the source.

During composition, remote changes wait. At composition end, local and remote changes to the same block are merged three ways (`rebaseOps`):

- Local deletions only remove characters that survived the remote change.
- Remote insertions inside a locally deleted range are kept.

The same merge covers a remote update that arrives between keystrokes, before the throttled flush.

### Undo (`tiptap-history.ts`)

- `bridge.undoManager` is a `Y.UndoManager` on the shared Y.Text. It tracks only this bridge's origin class, so remote edits are never undone.
- `TiptapCollabHistory` routes Mod-z, Mod-Shift-z and Mod-y, and the `undo`/`redo` commands used by the toolbar and Tiptap's keymap, to the bridge while it is bound. It also stops ProseMirror history from recording. It falls back to Tiptap history when no bridge is bound.
- If the extension is missing, the bridge registers an equivalent keymap and removes it on `destroy`.
- Undo and redo restore the caret to where the change was. The selection is stored as relative positions in the stack item's meta.
- `captureTransaction(fn, provenance)` and changes after `setNextProvenance` are separate undo steps. An AI rewrite undoes in one step.

### Provenance

Every bridge transaction's origin is an instance of a per-bridge subclass of `TiptapBridgeOrigin`, carrying `provenance`:

- `typing` by default.
- `paste` when ProseMirror tags the transaction `paste` or `uiEvent: paste|drop`.
- Whatever `setNextProvenance` or `captureTransaction` set, for example `{ source: "ai", feature: "rewrite" }`.

`provenanceOfOrigin(origin)` also returns `{ source: "undo" }` for the bridge's UndoManager transactions. Read it synchronously in the Y.Doc `update` handler.

### Remote cursors (`tiptap-cursors.ts`)

Awareness uses y-codemirror.next's fields exactly (`src/y-remote-selections.js` in node_modules):

- `cursor: { anchor, head }`: `Y.RelativePosition`s from `Y.createRelativePositionFromTypeIndex(ytext, index)` with assoc 0. They travel as RelativePosition JSON.
- `user: { name, color, colorLight? }`.

The local cursor is published only while the editor has focus (as y-codemirror.next does), and only when the bridge is in sync. On `destroy` it is cleared.

The Visual plugin renders other clients' carets (`.libera-collab-caret` with a name label) and selections (`.libera-collab-selection`), with inline styles so it works without CSS. It rebuilds after each bridge sync and each awareness change, and maps through local typing in between.

Position mapping is source offset ↔ block, then a visible-text alignment inside the block. Each text node is matched verbatim in the source, falling back to a greedy character match for escapes and entities. It is exact in plain text and approximate inside inline formatting: a caret between `**` markers snaps to the nearest visible character.

## API for the wiring wave

```ts
import { bindTiptapToYText, provenanceOfOrigin, TIPTAP_BRIDGE_META, type TiptapYTextBridge } from "@/lib/collab/bindings/tiptap-ytext";
import { TiptapCollabHistory } from "@/lib/collab/bindings/tiptap-history";
import { createRemoteCursorPlugin } from "@/lib/collab/bindings/tiptap-cursors";

const bridge: TiptapYTextBridge = bindTiptapToYText({
  editor,                 // built with createMarkdownExtensions (+ math, TiptapCollabHistory)
  ytext,                  // contentDoc.getText(ContentKeys.source)
  awareness,              // optional: publishes the cursor and renders remote ones
  renderRemoteCursors,    // default true when awareness is given
  cursorRequiresFocus,    // default true (as y-codemirror.next)
  flushDelay,             // default 50 ms
  captureTimeout,         // UndoManager grouping, default 500 ms
  readOnlyReason,         // start in the D1 fallback (live read-only view)
  onReadOnlyChange,       // (reason: string | null) => void, to show the banner
  onError,                // sync step threw; the bridge rebuilds from Y.Text and turns read-only
});

bridge.flush();                                    // send pending local changes now (held during IME)
bridge.undo(); bridge.redo(); bridge.canUndo(); bridge.canRedo();
bridge.undoManager;                                // Y.UndoManager, local origin only
bridge.stopCapturing();
bridge.captureTransaction(() => applyAiEdit(), { source: "ai", feature: "rewrite" }); // one undo step
bridge.setNextProvenance({ source: "ai", feature: "format" });
bridge.isLocalOrigin(origin); bridge.originClass;  // per-bridge TiptapBridgeOrigin subclass
bridge.posToSourceOffset(pos); bridge.sourceOffsetToPos(offset);
bridge.posToRelativePosition(pos); bridge.relativePositionToPos(rposOrJson);
bridge.setReadOnly(reason | null); bridge.readOnlyReason;  // D1 fallback hook
bridge.isSynced(); bridge.verify();                // diagnostics; verify() is [] when in step
bridge.subscribe(listener);                        // after each sync that changed something
bridge.destroy();                                  // flushes, unbinds, removes plugins, clears the cursor
```

Wiring notes for `use-tiptap-draft.ts` and `tiptap-markdown-editor.tsx`:

- **Create the editor empty, then bind.** `bindTiptapToYText` builds the document block by block, in linear time. Tiptap's whole-note `setContent` parse is quadratic: 25 KB takes 0.2 s, 50 KB 0.8 s, 100 KB 3.6 s, and 1 MB would take minutes. The cause is the math tokenizer's `start()`, which slices the remaining source at every character, so this is pre-existing. Binding an editor that already has content also works. The bridge replaces the document once, without history, if its block-wise parse differs.
- **Never call `replace`/`setContent` on a shared tab.** The shared-mode path of `useTiptapDraft` should not publish drafts. `getTabDraft` reads `ytext.toString()`. Ignore transactions with `tr.getMeta(TIPTAP_BRIDGE_META)` where the editor reacts to "external" changes.
- **Undo.** Add `TiptapCollabHistory` to the extensions. StarterKit's `undoRedo` can stay: its keymap and commands route to the bridge while bound. Point the toolbar's Undo and Redo at `editor.commands.undo()` / `redo()` or at `bridge.undo()` / `redo()`.
- **Replica.** Call `bridge.flush()` before applying a batch of remote updates. This is optional: a three-way merge handles updates that arrive with local changes pending. In the Y.Doc `update` handler, forward `provenanceOfOrigin(origin)`.
- **Paste and AI actions.** Libera's own paste handlers (`replaceTiptapRangeWithMarkdown`, Smart Paste) dispatch without ProseMirror's `paste` meta. Either set `tr.setMeta("paste", true)` there or call `bridge.setNextProvenance({ source: "paste" })`. Wrap AI insertions in `captureTransaction`.
- **CSS.** Optionally style `.libera-collab-caret`, `.libera-collab-caret-label` and `.libera-collab-selection`. Inline styles already make them visible.
- **Lifetime.** The bridge belongs to the editor mount; the Y.Doc outlives it (M1.4). Destroy the bridge before the editor.

## Measured results

The headless tests run with Node 22, jsdom and Tiptap 3.31. Each test file runs in its own process.

```
node --require ./scripts/editor/setup.cjs --import tsx --test scripts/collab/tiptap-bridge*.test.ts
  → 57 test cases in 5 files, all passing
```

The count includes the harness self-test, which runs in every file that imports the harness. `npm run test:collab` runs 63, all passing.

Coverage:

- **Concurrency:** two Visual editors and a raw Y.Text participant (standing in for CodeMirror) type concurrently in one paragraph, a list (including nested), a heading and a table cell. Also covered: multi-block paste, deleting across blocks while others edit inside them, and splits, merges, empty paragraphs and block deletion.
- **Convergence:** checked with equal Y.Texts, `bridge.verify()` and, for canonical fixtures, the serialized document equal to Y.Text.
- **Untouched blocks byte-identical:** a fixture with `*`/`_`, `__strong__`, `+` lists, odd spacing, three-newline gaps, Setext headings, `1)` lists and an unpadded table. Editing one paragraph changes only that paragraph's bytes.
- **Caret:** stays on its text under remote edits in the same block (before and after the caret), in other blocks, and inside formatted text. Local typing interleaved with remote edits stays contiguous.
- **IME:** with simulated `composing`, outgoing and incoming changes are held, then both are applied at `compositionend` with a three-way merge.
- **Undo:** only local changes are undone, through the command, Ctrl+Z and Ctrl+Y. ProseMirror history stays empty while bound. The fallback keymap is registered and removed when the extension is absent.
- **Provenance:** typing, paste, AI (`captureTransaction` is one undo step) and undo.
- **Cursors:** positions round-trip in plain and formatted text. The awareness `cursor` JSON is byte-equal to what y-codemirror.next creates, and decodes with y-codemirror.next's `YSyncConfig.fromYPos`. A CodeMirror user's caret renders in the Visual editor with its name.
- **Construct matrix:** 30 constructs, each edited locally and remotely at once. Each converges, keeps its neighbours byte-identical, and both Visual editors end with identical documents. CRLF notes and an unbalanced `$$` are tested separately.
- **Property tests (fast-check):**
  - Random interleavings of typing, deletion, split, join, bold, paste, undo and redo by two Visual editors. The Source participant inserts and deletes Markdown syntax (`#`, `-`, `*`, backticks, `|`, `>`, `1.`, newlines). Deliveries are random and out of order.
  - The default is 60 runs. On the final code, 3,000 more runs over 10 seeds passed (`BRIDGE_RUNS=300 BRIDGE_SEED=41…50`).
  - Earlier stress runs found four bugs, now fixed and covered: schema-invalid parser output, paragraph edge spaces counted twice, edge spaces outliving a remote gap edit, and the `$$` block mismatch.
  - Character diff round-trips with no split surrogate pairs, and rebase over disjoint edits.

### Performance (1 MB note, 17,700 top-level nodes, jsdom)

The bridge was flushed after every keystroke, which is the worst case for the 50 ms throttle. ProseMirror's own view update is timed separately.

| Measure | Average | p95 | Max |
|---|---|---|---|
| **Local bridge cost per keystroke** (serialize, diff, Y write, re-tile) | 1.5 ms | 2.0 ms | 3.1 ms |
| Remote bridge cost per received keystroke (re-tile, reparse, selection) | 2.3 ms | 4.8 ms | 6.7 ms |
| ProseMirror dispatch for the remote change (not bridge) | 3.9 ms | 6.4 ms | 7.4 ms |
| ProseMirror dispatch for local typing (not bridge) | 3.5 ms | 4.7 ms | 6.7 ms |
| Bind (tiling, per-block parse, first render) | 3.7–4.2 s, once | | |

The 16 ms budget is met with room to spare. Under heavier machine load (other jobs running), local p95 rose to 3.4 ms and remote bridge p95 to 6.3 ms. jsdom numbers are indicative: Electron's renderer is usually faster, but its DOM work is real.

Binding is the slow part on very large notes, about 4 s for 1 MB, dominated by remark. The rest of a keystroke's cost is O(number of tiles) array maintenance, which is microseconds.

## What does not round-trip

Every construct tested converges. These are lossy only inside a block a Visual user edits, exactly as saving from today's Visual editor would be. Untouched blocks keep their bytes:

- **Normalized by Tiptap's serializer:**
  - `_em_` → `*em*`, `__strong__` → `**strong**`
  - `+`/`*` bullets → `-`, `1)` → `1.`
  - Setext headings → ATX, indented code → fenced
  - Table cell padding
  - Reference links → inline links (the definition stays)
  - Autolinks → `[url](url)`
- **Dropped by Tiptap's parser in an edited block:**
  - Raw HTML blocks (the text is kept, the tags are lost)
  - HTML comments (the comment becomes an empty paragraph; typing into it replaces it)
  - Footnote references (escaped to `\[^1\]`)
  - YAML front matter (parsed as a rule plus a heading, so editing that heading rewrites it)

Known approximations and limits:

- Caret mapping inside inline formatting is approximate (see above). Remote carets can snap by a character next to markup.
- remark-math reads `$$` as a block that can span blank lines, while Libera treats `$$` as an inline marker. The bridge reparses such regions instead of keeping local nodes, so all participants converge. The Visual view of an unbalanced `$$` can differ from today's whole-note parse.
- Display math (`\[ … \]`) containing a blank line is split into paragraphs per block. Today's whole-note parse would show one math node.
- When a reference definition changes, blocks that use it pick up the new target when they are next reparsed, not immediately.
- A leading or trailing space a user deletes is not removed from the source. It is not significant in Markdown and no view shows it.
- Real IME commits are unverified (see Decision).

## D1 fallback hook

`bindTiptapToYText({ readOnlyReason })` or `bridge.setReadOnly(reason)` turns the Visual editor into a live, read-only rendered view. Remote changes keep applying. `onReadOnlyChange(reason)` lets the UI show the "Switch to Source to edit" banner, and `setReadOnly(null)` restores editing.

The bridge turns read-only by itself if a sync step throws. It reports the error through `onError`, rebuilds the document from Y.Text, and keeps showing live changes.

No construct currently needs the fallback. If manual IME testing fails for a language, set `readOnlyReason` for shared tabs on those platforms until it is fixed.

## Edits outside the owned files

None. No existing file was changed. `reviewBlocks` and `createMarkdownExtensions` are imported as they are.
