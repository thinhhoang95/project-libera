# Persistence trigger audit — October 18, 2026

This audit traces the UI save triggers and their storage implementations. It measures requests, browser-storage calls, and file identity/timestamps in tests; it does not measure physical disk writes or device wear in the installed application.

## Changes made

| Path | Previous trigger | Current trigger |
| --- | --- | --- |
| Chat/Agent history (`document-chat-panel.tsx`) | Composer edits after 1 second; streaming checkpoints every 30 seconds | Send/edit/regenerate, final/interrupted/failed response, discrete conversation/settings/attachment actions, and app close. Live tokens and drafts stay in memory. |
| Image-generation prompt (`image-generation-panel.tsx`) | Browser storage on every keystroke | Field blur, generate, completion/failure/stop, panel/app close, and explicit reuse of a gallery prompt. Duplicate values are skipped. |
| Image-generation settings (`image-generation-panel.tsx`) | A 400 ms save timer after settings edits; a separate unmount request | Field blur, slider release, generate, completion/failure/stop, and panel/app close, through the shared serialized save writer. Loading unchanged settings is read-only, including a failed read followed by close. |
| Image-generation settings file (`image-generation-server.ts`) | Every PUT atomically replaced the file, even if identical; overlapping requests could finish out of order | Shared `writeJsonState` deduplicates unchanged content and serializes writes. |
| Agent undo manifests (`agent/snapshots.ts`) | Every recorded file write or suggestion set replaced the manifest, even if identical | Shared `writeJsonState` skips identical manifests. Original-file capture and undo durability still happen at each file-operation boundary. |
| Markdown editor/preview split (`workspace-panel.tsx`) | Browser storage on pointer down and every pointer move | Save the last width at drag end/cancel, or on a keyboard adjustment. |
| LaTeX editor/preview split (`latex-workspace.tsx`) | Browser storage on every pointer move; keyboard adjustments were not persisted | Save at drag end/lost capture and on keyboard adjustments. |

App-close saves use `registerStateFlusher`, so Electron can await pending requests. Image-generation settings now participate in that protocol, rather than relying only on an unmount keepalive request.

## Remaining candidates

These paths still save automatically during editing. They were inspected but retain their current recovery behavior in this change.

| Path | Current behavior | What a further event-based conversion must preserve |
| --- | --- | --- |
| Local Review Mode (`markdown-review-context.tsx`) | After a 900 ms typing pause, `action("sync")` persists the snapshot and remapped comment anchors to `.libera/markdown-reviews.json`. Skips unchanged snapshots and waits during IME composition or generation. | Sync on document save, tab switch/close, review actions, and app close; keep anchors projected in memory while typing. Serialize against generation and revision checks, capture the outgoing tab rather than the newly selected one, and distinguish a newer user draft from an unapplied review result on reload. Simply removing the timer can create false recovery prompts after review decisions. |
| Workspace recovery (`use-saved-workspaces.ts`) | Captures live drafts/view state every 30 seconds. Writes a local Electron recovery journal (browser storage on the web) only when contents differ, ignoring timestamp-only changes. Structural changes and explicit workspace operations also persist. | Decide how to retain crash recovery for unsaved editor drafts before removing the interval. An event-only policy needs save, switch, blur, close, and final editor-reader captures, with an explicit change to the maximum unsaved crash window. |
| PDF/image text annotations (`pdf-note-editor.tsx`, `pdf-viewer.tsx`, `image-viewer.tsx`) | Note text is published after 160 ms; changed annotations are saved after another 350 ms. Drawing, undo, styling, and other annotation actions use the same persistence path. | Split live note editing from commits on note finish/blur, viewer close, and app close; retain final text on virtualized page unmount, annotation undo, cross-window synchronization, and error retries. |

These are the next places to optimize if the same policy should extend to editor recovery and annotation editing as well as AI panels.

## Paths already driven by events

- Chat panel width/visibility: resize end, keyboard resize, or toggle. No typing/streaming dependency.
- Markdown display preferences: explicit preference updates, coalesced and deduplicated; sliders already expose a flush callback.
- Notebook selection/expansion, file operations, and workspace organization: user actions or structural changes, with queued writes and close flushes.
- Agentic review planning/generation: the server writes a result after generation finishes. AI format/rewrite/write applies a completed result rather than saving tokens.
- PDF-to-Markdown: commits completed pages. These are deliberate progress/recovery boundaries, not token-level writes.
- Collaborative documents: the host journals document operations before acknowledging/broadcasting them. Those commits provide offline/synchronization durability and should not be replaced with private-chat response triggers.
- Search indexing and caches: separate background/content-processing work; their schedule is not a chat-history save trigger.

## Validation

- Chat persistence tests advance time without explicit close flushes and verify no typing/streaming writes; sent/final/interrupted/failed turns, conversation operations, and close recovery save correctly.
- Image-generation tests advance time through typing/settings edits, then verify field commits, generation boundaries, close flushes, and read-error handling. They count browser-storage writes as well as PUT requests.
- Image-generation storage tests verify identical saves preserve inode/mtime and concurrent writes retain the newest settings.
- Agent snapshot tests verify duplicate manifests preserve inode/mtime and changed content is retained; existing tool and undo tests exercise file-operation durability.
- The Markdown split UI test verifies multiple pointer moves cause no storage writes, drag end writes once, and keyboard adjustments persist.
- Existing review lifecycle, review-route, and workspace recovery tests continue to cover the intentionally retained behavior.
