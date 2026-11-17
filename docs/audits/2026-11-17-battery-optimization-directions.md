# Battery optimization round — directions (17 November 2026)

Source: two independent code reviews (Claude and GPT-6.1-Sol) of work that is
disproportionate to the user action that triggers it. Nothing here was
profiled; every package must therefore prove its reduction with a counter-style
test (work done, commits, calls), never with timings.

Each package is one agent, one branch, one worktree. Read "Rules for every
package" first, then only your own package.

## Rules for every package

1. **Where you work.** Only inside the worktree path you were given; its branch
   is already checked out. Never `cd` into, edit, or run git in the main
   checkout `/Users/thinhhoang/Documents/project-libera` (other work is in
   progress there). Never switch branches, rebase, push, or touch `git stash`.
2. **Files.** Edit only the files listed for your package, plus new test files
   and new helper files the package names. If the fix needs another file, stop
   and say so in your report instead of editing it.
3. **Next.js.** `AGENTS.md` applies: this Next.js has breaking changes. These
   packages are React/TypeScript client code and need no Next API. If you find
   you need one, read the guide in `node_modules/next/dist/docs/` first.
4. **Line endings.** Some files are CRLF (`use-saved-workspaces.ts`,
   `image-viewer.tsx`, several collab/storage sources). Use the Edit tool, never
   a script that rewrites the file. Before committing, `git diff --stat` must be
   proportionate to your change.
5. **Machine limits (8 GB RAM).** Run only the targeted test files listed for
   your package, one foreground process at a time:
   `node --require ./scripts/editor/setup.cjs --import tsx --test scripts/editor/<file>.test.ts`
   (collab: `node scripts/collab/run-tests.mjs scripts/collab/<file>.test.ts`).
   Do **not** run `tsc`, lint, builds, `npm run test:*`, dev servers, browsers or
   background processes unless your package says so. The type-check and full
   suites run once, centrally, after merging. Write type-correct code by reading
   the types.
6. **Behaviour must not change**, except where the package says so. In
   particular keep: the exact draft on Save / export / tab switch / tab close /
   quit (flush paths: `useCanvasViewStateCapture`, `registerStateFlusher`,
   `pagehide`, unmount cleanups); IME composition guards; undo/redo history;
   shared (collab) tabs, whose text lives in a Y.Text and is never replaced
   wholesale.
7. **Prove it.** Add or extend a test that counts the work you removed
   (function calls, React commits, objects rebuilt) and, for any incremental
   algorithm, a randomized equivalence test against the old full computation.
   If an incremental version cannot be shown equivalent, keep the full version
   for that case and report it. Correctness over savings.
8. **Scope.** No drive-by refactors, renames or formatting. Comments in the
   house style: plain prose saying why, no task or ticket references.
9. **Finish.** Commit on your branch (`perf(<scope>): …`, body explaining what
   work was removed). `node_modules`, `server/node_modules` and
   `electron/collab/dist` are symlinks: never `git add` them. Report: what
   changed (file:line), tests run and their result, what you did not do or are
   unsure about, and any user-visible behaviour change.

Line numbers below are from `main` at 08e9c0b; locate by the quoted names.

---

## Round 1 (file-disjoint, run three at a time)

### A — Persistence, idle work, app menu

Files: `src/lib/workspaces.ts`, `src/components/libera/use-saved-workspaces.ts`
(CRLF), `src/components/libera/app-menu.ts`, `electron/main.cjs`,
`src/app/globals.css`, `src/lib/ai-activity.ts`, new `src/lib/window-activity.ts`.
Tests: `workspaces.test.ts`, `state-persistence.test.ts`, `tab-lifecycle.test.ts`,
`native-menu.test.ts`.

1. **Structure token.** `workspaceStructureToken(session)` (`workspaces.ts:112`)
   `JSON.stringify`s every tab's full `saved` text, and
   `use-saved-workspaces.ts` calls it in the render body (`const structure = …`)
   on every render of the root. Its job is only to detect that the tab set, a
   path, a saved copy or the canvas layout changed, to schedule the 60 s
   structure save. Replace the bodies with per-tab revision numbers: a tokenizer
   holding `Map<tabId, { saved: string; rev: number }>` that bumps `rev` when
   `saved !== previous` (strings compare by reference first, so an unchanged tab
   costs nothing). One tokenizer instance per hook, used by both the render-time
   token and the one inside `persist()` (they are compared through
   `lastStructure`). Also compute it under `useMemo` keyed on `options.session`.
   The token must still change exactly when ids/order, `file.path`, saved
   content, `untitled`, `standaloneSaveId` or the canvas root change. Keep any
   exported pure function that tests use, or update those tests.
2. **30 s journal.** The interval in `use-saved-workspaces.ts`
   (`if (document.visibilityState !== "hidden" || recoverableChanged()) recoverLocally()`)
   snapshots unconditionally while visible: `flushSync(captureCanvasViewState)`
   plus a stringify of every tab. Gate the visible case too: journal only when
   `recoverableChanged()` **or** there was user input since the last journal
   (one boolean set by passive capture listeners for `keydown`, `pointerdown`,
   `wheel` on `window`, cleared after journaling). An idle visible window then
   does nothing; an active one journals exactly as before, scroll position
   included. Hidden-window behaviour and the leave/quit path stay as they are.
3. **App menu.** `useProvider` in `app-menu.ts` has a dependency-less
   `useLayoutEffect(() => scheduleSync())`, so any render of any component that
   provides menu items rebuilds and stringifies every menu 120 ms later. Keep
   the "a render may have changed the items" signal, but make it cheap: mark
   dirty; run `sync()` as a trailing debounce of 300 ms with a 2 s maximum wait,
   inside `requestIdleCallback` (fallback `setTimeout`); skip while
   `document.hidden` or `!document.hasFocus()` and sync on the existing
   `focus`/`focusin` listeners instead. Provider mount/unmount and focus changes
   still sync promptly (keep ≤120 ms there). `lastSent` dedupe stays.
4. **Vibrancy.** `electron/main.cjs` creates the main window with
   `visualEffectState: isMacGlass ? "active" : undefined`. Change to
   `"followWindow"` so an unfocused window stops live blur compositing. Read
   the comments around the window options and around the `libera-glass` CSS
   (`globals.css` ~228–270) first; if one says "active" is deliberate (a flash
   or tint problem on blur), leave it and report. This is a visible change:
   say so in your report.
5. **AI glow.** `globals.css` animates large blurred gradients
   `infinite` while an AI job runs (`.libera-chat-glow[data-active="true"]`,
   `.libera-ai-activity-card`, `.libera-workspace-region[data-ai-active="true"] .libera-ai-glow`,
   and `libera-chat-shimmer`). Add `animation-play-state: paused` for them under
   `html[data-window-inactive="true"]` and `html[data-on-battery="true"]` (the
   static gradient remains as the indicator). New `src/lib/window-activity.ts`
   exports an idempotent `installWindowActivityAttributes()` that maintains both
   attributes on `document.documentElement` (`focus`/`blur`/`visibilitychange`;
   battery from `inkPower` in `src/components/libera/ink/ink-power.ts`, read
   only). Call it from `subscribe` in `src/lib/ai-activity.ts` so no root
   component changes. Keep the existing reduced-motion rules.

### B — PDF, image and photo viewers

Files: `src/components/libera/pdf-viewer.tsx`,
`src/components/libera/image-viewer.tsx` (CRLF),
`src/components/libera/photo-viewer.tsx`.
Tests: `pdf-viewer.test.ts`, `pdf-scroll-anchor.test.ts`, `image-viewer.test.ts`,
`viewer-continuity.test.ts`, `workspace-panel-scroll-state.test.ts`.

Every `updateViewState(...)` from a viewer becomes a `setTabs` on the root
workspace and re-renders the whole window. The Markdown path already holds
scroll positions until scrolling pauses (`workspace-panel.tsx`, the
`pendingScrollViewStateRef` / `reportMarkdownScrollViewState` code): copy that
shape.

1. **PDF scroll.** `handleScroll` arms a 150 ms timer on the first event and
   `flushPendingScrollViewState` then stores the position: a throttle, about
   seven root renders a second while reading. Make the stored position a
   trailing debounce (restart the timer on each scroll event; store when
   scrolling pauses for `PDF_SCROLL_STATE_INTERVAL_MS`). The page indicator
   must stay live: keep calling `updateCurrentPage(scroller)` on the current
   150 ms cadence, locally, without a view-state write unless the page really
   changed. Confirm the pending position is flushed on unmount, tab switch and
   `useCanvasViewStateCapture`; add the flush where missing. `publishView()`
   (collab presence, two `getBoundingClientRect` per scroll event) should run at
   most once per animation frame.
2. **Image pan/zoom.** `zoomTo`, the wheel handler and the pan `pointermove`
   in `image-viewer.tsx` call `updateViewState` per event. Keep the local
   `setZoom`/`setPan` (the image must follow the gesture), but persist through
   one trailing debounce (~200 ms) that is flushed on pointer up / gesture end,
   on unmount and from `useCanvasViewStateCapture` (add the hook if the viewer
   has none; `latex-pdf-preview.tsx` shows the pattern). `photo-viewer.tsx` has
   the same two call sites.

### C — LaTeX auto-compile, Markdown source popups

Files: `src/components/libera/latex/latex-workspace.tsx`,
`src/components/libera/markdown-source/markdown-codemirror-editor.tsx`,
`src/lib/markdown-source.ts`.
Tests: `latex-editor.test.ts`, `markdown-codemirror-editor.test.ts`,
`references-editors-source.test.ts`, `references-editors-popup.test.ts`,
`markdown-internal-links.test.ts`.

1. **Auto-compile.** `scheduleAutoCompile` starts a full typeset
   `AUTO_COMPILE_DELAY_MS = 1200` after every edit pause. Make the delay
   adaptive. Remember the last compile's duration (`onStart`/`onFinish` in
   `compile`). Plugged in: `clamp(max(1200, 1.5 × last), 1200, 8000)`. On
   battery (`inkPower.onBattery`, read when scheduling) or while the PDF pane is
   hidden and no PDF window shows it: `clamp(max(4000, 2 × last), 4000, 15000)`.
   While `document.visibilityState === "hidden"` do not start an automatic
   compile; remember that one is owed and run it on `visibilitychange`. Manual
   compile (button, Mod-Enter), the compile on open, and the `autoCompile`
   toggle are unchanged. Put the delay computation in a small pure exported
   function and unit-test it.
2. **Popups.** In `markdown-codemirror-editor.tsx`, `refreshFileLinkPopup` and
   `refreshCitationPopup` each call `state.doc.toString()` on the frame after
   every keystroke. Give `sourceFileLinkContext` and `sourceCitationContext`
   (`markdown-source.ts`) a lazy text source, e.g.
   `{ slice(from, to): string; read(): string }`, so the common case reads only
   a window: the citation gate already needs just the 260 characters before the
   caret (`mayTriggerCitation`), and `fileLinkDestinationAt` only looks near the
   caret — read it to derive the exact window it needs. The full `read()` may
   happen only once a popup is actually opening (`citationTriggerAt`,
   `citedKeys`, `markdownHeadingAnchors`). Results must be identical to today;
   the classic textarea editor (`markdown-editor.tsx`, not yours to edit) calls
   the same functions with a string, so keep the string signature working
   (overload or wrap). Test with a `read` spy: typing plain prose never calls it.

### D — Recorder context, sidebar and chat resize

Files: `src/components/libera/recording/meeting-recorder.tsx`,
`src/components/libera/notebook-panel.tsx` and
`src/components/libera/notebook-home.tsx` (only their `useRecorderLauncher`
call sites), `src/components/libera-app.tsx` (only the resize code).
Tests: `recording.test.ts`.

1. **Recorder.** `MeetingRecorderProvider` builds one context value per render
   holding both `recorder` (its seconds and levels change every 120 ms while
   recording) and `launcher`, which the notebook tree and notebook home read
   through `useRecorderLauncher()`. Split it: a launcher context whose value is
   memoized and changes only when `busy` changes (`startRecording` stable via a
   latest-ref; the provider's `tabs` prop is a fresh object on every parent
   render, so never depend on its identity), and the existing context for the
   recorder UI. `useRecorderLauncher()` reads only the launcher context.
2. **Resize.** In `libera-app.tsx`, `resizeSidebar` and the chat separator's
   `onPointerMove` call `setSidebarWidth` / `setChatWidth` per pointer event,
   re-rendering the root each time. During a drag, write the CSS variables
   (`--libera-sidebar-width`, `--libera-chat-width`) on `mainLayoutRef.current`
   and the handle's own `left`/`right` directly, at most once per animation
   frame, from geometry cached at pointer down; commit React state and the
   existing persistence on pointer up / cancel / lost capture. React only
   writes style keys whose value changed between renders, so an unrelated
   render mid-drag will not snap the width back; keep it that way (do not
   change the value React renders until the commit). Keyboard resizing and the
   stored widths behave as before.

### E — Visual editor component

Files: `src/components/libera/tiptap-markdown-editor.tsx`,
`src/components/libera/markdown-status-bar.tsx`, optionally one new small
component file beside them.
Tests: `tiptap-performance.test.ts`, `word-count.test.ts`,
`review-editor-lifecycle.test.ts`, `tab-editor-state.test.ts`.

1. **Selection text.** `onSelectionUpdate` does
   `setSelectedText(doc.textBetween(from, to))`: every step of a drag or
   shift-selection re-renders the whole editor component and the status bar
   counts the words of the selection synchronously. Move it out: a small
   component (or store) that listens to the editor's `selectionUpdate` itself,
   clears immediately when the selection becomes empty, and otherwise extracts
   and publishes the text after a ~150 ms trailing pause. Feed
   `MarkdownStatusBar` from it without changing that component's props (the
   source editor uses it too). `selectedText` state leaves
   `TiptapMarkdownEditor`.
2. **Toolbar selector.** The `useEditorState` selector runs on every
   transaction: ~20 `isActive` and six `can()` dry-runs (`sinkListItem` ×2,
   `liftListItem` ×2, `undo`, `redo`). Keep the result identical but: evaluate
   the list `can()`s only when the selection is inside a `listItem`/`taskItem`
   (otherwise both are false — verify that is what `can()` returns there);
   return the cached result when `editor.state` is the same object as last
   time; for undo/redo use the history plugin's depths
   (`undoDepth`/`redoDepth` from `@tiptap/pm/history`) on local tabs and keep
   `can()` on shared tabs (`TiptapCollabHistory` routes undo to a
   Y.UndoManager). Add a test counting `can()` calls while typing in a plain
   paragraph.

Do not touch draft publication, scroll restore or collab attach code.

### F — Visual editor plugins: macros, lead-ins, heading numbering

Files: `src/lib/tiptap-macros.ts`, `src/lib/tiptap-bold-lead-ins.ts`,
`src/lib/tiptap-heading-numbering.ts`, `src/lib/tiptap-editor-actions.ts`
(numbering collection only).
Tests: `markdown-macros.test.ts`, `markdown-heading-numbering.test.ts`,
`tiptap-performance.test.ts`.

ProseMirror nodes are immutable and an unchanged subtree keeps its object
identity across transactions. That is the lever for all three.

1. **Macros.** The plugin's `apply` calls `computeMacroState(state.doc)` on
   every `docChanged`: a `descendants` walk plus `hasCounters`, which builds the
   text of the whole document. Cache per top-level child in a
   `WeakMap<ProseMirrorNode, { macroBlocks: string[]; hasCounter: boolean }>`
   so an edit costs the changed block plus one map lookup per top-level node.
   If the macro block texts and counter presence equal the previous ones,
   return the previous `MacroState` object (so the plugin's `view.update` and
   subscribers see no change). Then read `invocationDecorations`: it is a
   `props.decorations` function, called on every view update; make sure it is
   cached on (doc, macro state) and not rebuilt for selection-only updates.
2. **Bold lead-ins.** `apply` rebuilds the whole `DecorationSet` on every
   `docChanged`. Map the set through `tr.mapping`, then recompute only the
   paragraphs touched by the transaction's changed ranges (from the step maps,
   in new-document coordinates, widened to whole textblocks): remove the
   decorations found in those paragraphs and add fresh ones. Randomized
   equivalence test against `leadInDecorations(doc)`: typing, toggling bold,
   splitting and joining paragraphs, deleting across paragraphs, pasting blocks.
3. **Heading numbering.** With numbering enabled, every eligible edit collects
   every heading. Skip the work when the transaction cannot affect numbering:
   no heading node intersects the changed ranges in the old document or in the
   new one. Otherwise run the existing logic unchanged. The source-editor
   equivalents are out of scope.

### G — Visual editor plugins: tracked changes, Find

Files: `src/lib/tiptap-changes.ts`, `src/lib/tiptap-find.ts`.
Tests: `tiptap-changes.test.ts`, `text-find-efficiency.test.ts`,
`tiptap-review.test.ts`.

1. **Tracked changes.** While any hunk exists, each edit maps all changes into
   a new array, sorts, and rebuilds every decoration and widget descriptor.
   Keep the cheap exit for the empty state. Otherwise map the existing
   `DecorationSet` and rebuild only the hunks whose range intersects the
   changed ranges or whose change object changed; a change whose mapped
   positions did not move keeps its object. Randomized equivalence test against
   the current full rebuild (compare decoration ranges and specs).
2. **Find.** With a query active, each document change calls
   `createFindState`, rebuilding every match decoration (per-block searches are
   already cached). Map matches and decorations through the change and
   re-search only the changed text blocks. Read how the active match is chosen
   after an edit today and keep it exactly. Same style of equivalence test.

These two matter only while changes or a Find query are active: if an
incremental version cannot be made provably equivalent, leave that one as it
is and say so.

### H — Shared documents: acknowledgements, text materialization, comments

Files: `src/lib/collab/client/replica.ts`, `src/lib/collab/client/registry.ts`,
`src/lib/collab/bindings/react-shared-tabs.ts`,
`src/lib/collab/review-store/shared.ts`,
`src/components/libera/where-was-i-tracker.ts`,
`src/components/libera/collab/history/session-end.ts` (subscription only),
`src/components/libera/use-libera-workspace.ts` (only the `useSharedTabs({...})`
options block), `src/components/libera-app.tsx` (only the dirty-document-count
effect).
Tests: find the collab test files that cover the replica, registry, shared tabs
and review store (`grep -l` in `scripts/collab`), plus
`scripts/editor/where-was-i.test.ts`. Run them one at a time. Check line
endings of each file before editing.

1. **Acknowledgements.** `replica.ts`, case `"ack"`, calls `this.publish({})`
   so observers of the unsaved count learn everything is confirmed.
   `registry.ts` forwards every replica publication to `emit()`, which bumps the
   global version read by `useRegistryVersion` — used by `useSharedTabs` in the
   root workspace hook and by every panel's `useSharedTab`. So each
   acknowledged edit batch re-renders the whole window. Split the channels: the
   version (`subscribe`/`getVersion`) changes only when membership, resolution
   or a replica snapshot field really changes; a second
   `subscribeDurability(listener)` fires for acknowledgements. Consumers of the
   unconfirmed count (`libera-app.tsx` dirty-document effect,
   `session-end.ts`) subscribe to both. Check every other
   `registry.subscribe` / `replica.subscribe` consumer for a reliance on the ack
   wake-up before removing it.
2. **Text.** In `react-shared-tabs.ts` the Y.Text observer calls
   `ytext.toString()` on every edit for `onEdit` (recap tracking) and again
   after the mirror delay for `onText`. Make `onEdit` carry no text
   (`onEdit(tabId, local)`): `whereWasITracker.sharedEdited` only needs the
   flags. The tracker's `sharedText` is read when the tab closes, by which time
   the replica may be gone, so feed it from the debounced `onText` string (no
   extra materialization) and, when a mirror is torn down with its timer still
   pending, flush once (a single `toString()`) before unobserving, so the
   recap's final text stays exact. Net: one materialization per pause instead
   of one per keystroke plus one per pause.
3. **Comments.** `SharedReviewStore.changed()` runs `build()` on every text
   change: `ytext.toString()` and a fresh object for every thread, then
   notifies all listeners, with or without a comments panel. Keep the result
   the same but (a) preserve identity: reuse the previous projected thread
   object when it is structurally equal, and (b) when every thread is reused
   and nothing else changed, do not notify the listeners that only care about
   threads. `projection.text` has real readers (`findReattachCandidates`,
   `markdown-review-ui.tsx`, `types.ts` snapshot): either keep it eager only
   when threads exist, or make it lazy with identical values. Read
   `review-latency.test.ts` before changing any scheduling; do not add delays
   that it or the UI would observe.

This is the most delicate package. Anything you cannot make safe, leave and
report.

---

## Round 2 (after round 1 is merged; one agent, may run `npx tsc --noEmit` once at the end)

### I — Keep the shell still when a draft or view state changes

Files: `src/components/libera/use-libera-workspace.ts`,
`src/components/libera-app.tsx`, `src/components/libera/use-saved-workspaces.ts`
(only `updateView`'s identity), `src/components/libera/left-panel.tsx`,
`src/components/libera/notebook-panel.tsx`, new
`src/components/libera/use-stable-handlers.ts`, new tests.
Tests: `tab-lifecycle.test.ts`, `tab-editor-state.test.ts`,
`workspace-panel-performance.test.ts`, `workspaces.test.ts`,
`state-persistence.test.ts`, `canvas-continuity.test.ts`, `untitled.test.ts`,
`command-palette.test.ts`, `notebook-covers.test.ts`.

`tabs` (drafts and view state included) is root state, so every draft
publication (250 ms after typing stops), caret report and stored scroll
position re-renders `LiberaApp`. That render is acceptable; what must stop is
everything below it re-rendering. Only `WorkspacePanelContent` is memoized
today. Target: after a draft publication, the notebook tree
(`NotebookPanel` and its sections/rows) does not render.

1. `useStableHandlers(handlers)`: returns an object with the same keys whose
   functions never change identity and forward to the latest ones (latest ref
   written in `useLayoutEffect`, as `PANEL_CALLBACKS` in `workspace-panel.tsx`
   does). Such wrappers must not be called during render: find the workspace
   functions that are (the review provider's draft reads are candidates) and
   leave those as they are.
2. In `useLiberaWorkspace`, return the plain function declarations through it.
   Do not change what any of them does.
3. In `libera-app.tsx`: `useMemo` the `WorkspaceViewContext` value (make
   `updateView` stable in `use-saved-workspaces.ts`); give every inline closure
   and inline object passed to `LeftPanel` a stable identity (`useCallback`,
   `useMemo`, or the stable handlers), including the `references` object.
4. `memo(NotebookPanel)`. `LeftPanel` still renders (the outline needs the
   draft), so check each prop it forwards to `NotebookPanel` is stable across a
   draft publication, and that the contexts `NotebookPanel` reads
   (`useWorkspaceView`, `useRecorderLauncher`, collab) keep their value
   identity across it.
5. Test: mount `NotebookPanel` (or the smallest tree containing it that is
   practical in the existing JSDOM setup — see how
   `workspace-panel-performance.test.ts` counts commits) under a parent that
   re-renders with a new active-tab object whose only difference is `draft`;
   assert zero `NotebookPanel` renders. At minimum, unit-test
   `useStableHandlers`.

## Round 3 (after round 2 is merged; one agent, may run `npx tsc --noEmit` once at the end)

### J — Tab strip and chat panel without drafts

Files: `src/components/libera/tab-strip.tsx`,
`src/components/libera/document-chat-panel.tsx`,
`src/components/libera-app.tsx`, new `src/components/libera/tab-chrome.ts`,
new tests. Tests: `tab-strip.test.ts`, `document-chat-panel.test.ts`,
`document-chat.test.ts`, `pdf-chat-panel.test.ts`, `chat-comments.test.ts`.

1. `tab-chrome.ts`: `type ChromeTab = Omit<OpenTab, "draft" | "saved" | "viewState">`
   and `useChromeTabs(tabs)`, which returns the previous `ChromeTab` object for
   a tab whose remaining fields are shallow-equal, and the previous array when
   every element and the order are unchanged. The omitted fields are really
   absent, so the compiler finds every stale read.
2. `TabStrip` takes `ChromeTab`s and is wrapped in `memo`. Where it needs a
   draft at action time (the download item) it calls a `readTabDraft(tabId)`
   prop; callbacks that hand a tab object upward are resolved by id in
   `libera-app.tsx` against the live tabs. A status change (clean ↔ dirty)
   still re-renders it; a draft or view-state change alone does not.
3. `DocumentChatPanel`: same treatment with a `readOpenTabs()` prop for
   action-time reads (attachments, comments, selection context). First
   establish whether anything it *shows* depends on the live draft on every
   publication; if so, leave the panel as it is and report why.
4. Test: `useChromeTabs` identity rules; `TabStrip` render count stays zero
   across a draft-only change and is one across a status change.
