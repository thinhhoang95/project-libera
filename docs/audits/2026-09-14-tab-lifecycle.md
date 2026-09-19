# Markdown tab lifecycle audit

Scope: switching and closing tabs using the Visual (TipTap) and Source editors, preview workers, review metadata, resize interactions, and duplicate preview windows. This audit preserves the editor-efficiency work and other changes already present in the shared workspace.

## Findings and remedies

| Finding | Impact | Remedy |
| --- | --- | --- |
| Source preview debounce retained the previous tab's content during the new child's first commit. | Switching tabs started the new preview worker with the old document, then queued the correct document behind that unnecessary parse. | Reset the debounced snapshot by tab identity before committing children. Ordinary edits retain the existing debounce. Avoid an extra state update when the snapshot is already current. |
| Split-resize handlers removed window listeners only on pointer-up or pointer-cancel. | Removing the pane during a drag could retain the handler closure and continue processing pointer movement. | Dispose the active drag on tab/mode/fullscreen changes and workspace unmount, and before another drag starts. |
| Duplicate preview windows were keys in a strong Map, pruned only when another window opened. | Closed windows remained strongly referenced by the parent registry until another duplicate was opened or the parent unmounted. | Use a WeakMap for window authorization and metadata. Existing refresh, current-draft lookup, origin checks, and disk fallback remain covered by tests. Actual browser heap reclamation has not been measured. |
| Review load requests were ignored after switching tabs but not cancelled; the previous review remained in `lastTab` after leaving Markdown. | Rapid switches could accumulate obsolete in-flight loads, and the last review could remain retained after its tab closed. | Abort loads during cleanup, clear the previous-review reference on identity changes, and reject stale replies. An already-started review identity migration is allowed to finish; cleanup prevents it from starting an obsolete follow-up load. |

The new switch tests also exposed duplicate sibling keys between the Source toolbar and status bar during concurrent toolbar work. The toolbar now has its own key suffix.

## Lifecycle observations

- Only the active tab mounts an editor. Inactive tabs retain document strings and view state, rather than one TipTap instance and worker per tab.
- Both editors flush pending drafts and unregister their draft readers on unmount. Existing tests cover exact saves, close guards, tab/mode changes, IME, and undo/redo.
- TipTap's installed React hook schedules destruction on the following tick. The new tests wait for that lifecycle and assert that the former editor is destroyed.
- Preview and heading clients terminate workers on unmount. Their request queues retain at most the running and latest requested snapshots rather than every edit.
- Editor/node caches inspected in review mapping, heading navigation, and Find use weak keys or bounded collections. This is a source-level assessment, not proof that every allocation becomes collectible in Electron.

## Verification

- `npm run test:editor`: **155 passed**, including the two new lifecycle tests.
- `tab-lifecycle.test.ts` repeatedly switches Source tabs, switches to Visual, creates a pending edit, switches back, closes the pane, and unmounts during resize under React Strict Mode. It asserts correct initial preview requests, one current worker and draft registration, old editor destruction, and zero remaining tracked resize listeners/workers/readers after closure.
- Review coverage delays responses across tab changes and closure, verifies abort signals, and checks that late responses cannot revive the old review.
- Focused rerun of tab lifecycle and duplicate-window behavior: **3 passed**.
- ESLint on the three changed implementation files and new test: passed.
- Full TypeScript checking is blocked by malformed generated `.next/dev/types/routes.d.ts` (line 108). A check excluding that generated development directory found one separate error in `scripts/editor/markdown-boxes.test.ts:120`: its `onInsertFileLink` prop no longer matches the concurrently changed toolbar API. No remaining type errors were reported in this audit's additions.
- `git diff --check`: passed.

## Remaining limits

This was a source review and DOM lifecycle regression audit. It does not provide Electron heap snapshots, native memory measurements, GPU measurements, or a long-session memory-growth slope. Garbage collection timing is deliberately not asserted by the tests.

Switching back to a Visual tab reconstructs its ProseMirror document; Source tabs restart their preview worker. Large files therefore still have parsing and DOM-mount costs on activation. Keeping inactive editors alive would trade those costs for substantially more memory, so this audit preserves the current active-editor-only policy. Open tabs intentionally retain their saved and current text, so memory still grows with the total size of open documents.
