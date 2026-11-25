# Comprehensive Code Review: File-Moving Feature Package & Notebook Verification Oracle

This review audits the full file-moving feature package across **in-app moves** (context menu, drag-and-drop, multi-select batch moves, folder rename/archive, cross-notebook migration, notebook rename), **external moves** (File Explorer / Finder / OneDrive / sync clients, automatic tree upkeep, Try to fix, Acknowledge, linked folders), **link & path rewriting**, **collaboration / shared-notebook interactions**, and the **notebook verification oracle** ([integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts) & [notebook-test-helpers.ts](file:///Users/thinhhoang/Documents/project-libera/scripts/editor/notebook-test-helpers.ts)).

Every finding below is verified directly against the current repository source at `HEAD`.

---

## Executive Summary

| Domain | Critical | High | Medium | Low | Primary Threats |
| --- | ---: | ---: | ---: | ---: | --- |
| **1. UI / Context Menu / Drag & Drop / Renderer** | 5 | 10 | 6 | 1 | In-flight ink writer retrying at old path (oracle evasion); silent loss of unsaved transcript edits; missing `fileId` on all opened local tabs; shared→local cross-notebook drop silently substituting source notebook; `_archive` migration bypassing unsaved checks; no cross-window sync for regular moves |
| **2. Local Storage, Batch, Folders & Migration** | 4 | 8 | 4 | 2 | Infinite loop DoS in copy path allocation on corrupt review index; moved reviews permanently shadowed by empty destination reviews; TOCTOU `rm -rf` in `moveWithoutReplacing`; lockless folder ops & `migration.ts` lock stealing; cold-start `.bib` tether drop; forgotten post-takedown `.transcript` & `document-chat`/`where-was-i` |
| **3. Link & Path Rewriting Engine** | 2 | 7 | 4 | 1 | Shared pre-filter skipping `/api/files/raw/` images, charts under renamed folders, `<a href>`, and live CRDT edits; shared `_archive/` skipped & broken; blob-stored shared `.md`/`.tex` always failing; LaTeX `../` rewrites uncompilable under `openin_any=p`; chart YAML & Markdown alt-text corruption |
| **4. External Moves, Upkeep, Try to Fix & Acknowledge** | 3 | 9 | 8 | 5 | macOS NFD/NFC mismatch deleting live images via Acknowledge; stale `getLinkedFolders()` cache bypassing folder identity proof; cross-volume `EXDEV` ink set-aside leak; case-only renames ripping live sidecars/ink into set-aside & 90-day expiry; `aliasRename` no-op on parent folder case renames; corrupt set-aside deletion; unlocked concurrent upkeep/repair races |
| **5. Collaboration & Shared Notebook Moves** | 2 | 5 | 4 | 0 | Shared PDF rename/delete permanently leaking sidecars & creating an unbreakable 409 deadlock on `pdfLive: true`; `recordTransitions()` always deferring during `fileOp` (defeating M23 rollback safety); case-only renames detaching `_ink`/`_assets` & cross-OS ping-pong; `PdfMarksRuntime.resolve` 503 on NFD; case-sensitive `judge()` stealing/deleting live sidecars |
| **6. Notebook Verification Oracle (`integrity.ts`)** | 1 | 4 | 3 | 0 | `Shared/_archive/` local files treated as missing (causing false warnings, Try-to-fix record hijacking onto collaborator files, and Acknowledge deletion); alias-deletion in shared `cleanup.ts`; zero verification of shared `doc` bytes/sizes, same-size blobs, and shared `.transcript` companions; `assertNotebookSound` ignoring all `"info"` findings |

> [!CAUTION]
> **Top Five Immediate Data-Loss / Deadlock / Corruption Hazards**
> 1. **Live image deletion on macOS (Section 4, E-C1)**: `unreferencedMarkdownAssets` lowercases without `.normalize("NFC")`, causing `Acknowledge` (and note-save pruning) to permanently delete live, displayed accented images.
> 2. **Unbreakable 409 deadlock & permanent sidecar leak on shared PDF moves/deletes (Section 5, S-C1)**: `followSharedPdfChanges` never deletes old sidecars, `PdfMarksRuntime.close` writes a recovery sidecar on delete, and on `pdfLive: true` neither Try to fix nor Acknowledge can remove it—permanently blocking path reuse.
> 3. **Shared `_archive/` treated as missing by oracle, Try to fix, and Acknowledge (Section 6, O-C1)**: Displaced/archived local files in a shared notebook trigger false warnings, Try-to-fix hijacking their records onto collaborator files, and Acknowledge permanently deleting their records.
> 4. **Stale `getLinkedFolders()` cache (Section 4, E-C2)**: Moving and replacing a linked folder externally while Libera is running bypasses `.libera-folder.json` identity checks, causing upkeep/Try to fix/Acknowledge to operate on the wrong folder.
> 5. **In-flight `InkWriter.save()` retrying at `oldPath` (Section 1, U-C1) + silent loss of unsaved transcript edits (Section 1, U-C2)**, plus **M23 rollback bypass on shared in-app deletes (Section 5, S-C2)** permanently deleting local records before server ACK.

---

## Oracle Coverage Matrix: Does `verifyNotebook` Catch These Problems?

| Problem Category | Caught by `verifyNotebook`? | Caught by `assertNotebookSound`? | Notes |
| --- | --- | --- | --- |
| Live macOS image deleted via NFD/NFC (`E-C1`) | **Caused by oracle** | **Missed** | `integrity.ts:912` uses `stat` (succeeds) while `unreferencedMarkdownAssets` misses NFC/NFD, so oracle *emits* the destructive `clear` action |
| Shared `_archive/` records destroyed (`O-C1`) | **Caused by oracle** | **False positive** | Oracle treats `_archive/` as missing because manifest never lists `_archive/` |
| Shared PDF rename/delete orphan + `pdfLive` deadlock (`S-C1`) | **Caught** (`orphanSideFile`) | **Caught** (`warning`) | Caught as warning, but **unfixable** via Try to fix or Acknowledge; blocks path reuse with 409 |
| In-flight `InkWriter` / `useAnnotationWriter` writing to reused `oldPath` (`U-C1`, `U-M4`) | **EVADED** | **EVADED** | Server stamps replacement file's own SHA-256/size onto the misdirected sidecar/ink |
| Unsaved transcript / `_archive` migration / missing `fileId` tab actions (`U-C2`, `U-C3`, `U-C5`) | **Missed** | **Missed** | Data loss happens before disk or replaces intended target cleanly |
| Moved review shadowed by pre-existing empty review (`L-C2`) | **Missed** | **Missed** | Both reviews live in `index.json` for a real file; oracle does not detect duplicate keys per path |
| Shared `doc` content/size drift & same-size blob corruption (`O-H2`) | **Missed** | **Missed** | `sharing` check only stats `kind === "blob"` size; skips `kind === "doc"` and blob hashes |
| Shared `<audio>.transcript` corrupt/stale/orphaned (`O-H3`) | **Missed** | **Missed** | `listSidecars`, `recordingDuration`, and `checkNothingLeftAt` completely ignore `.transcript` companions |
| LaTeX `../` & `_archive/` rewrites uncompilable under `openin_any=p` (`R-H5`) | **Missed** | **Missed** | Oracle uses `latexDependencies` which allows `..` and `_archive`, disagreeing with `latex/build.ts` |
| Orphaned review comments, left-behind images, stale ink/sidecars, unlisted shared disk copies, stale search rows (`O-H4`) | **Caught as `info`** | **MISSED** | `assertNotebookSound` ignores `"info"` severity by default |
| Linux case-only external rename stranding Python `.py` (`E-H7`) | **Missed** | **Missed** | `unreferencedMarkdownAssets` lowercases `owned` prefixes, hiding the unreachable `.py` file |
| HTML `<a href>` & `/api/files/raw/...` Markdown links broken (`R-M2`) | **Missed** | **Missed** | `integrity.ts:1012` uses `extractNotebookLinkDestinations` (Markdown links only) & skips leading `/` |
| `document-chat`, `where-was-i`, saved workspaces, `notebookPanelExpandedPaths`, `illustrationPath` (`L-M1`, `S-M2`, `O-M1`) | **Missed** | **Missed** | None of these path-keyed stores are inspected by `verifyNotebook` |
| Shared link pre-filter skipping `/api/files/raw/` images, folder charts, stale link index (`R-C1`) | **Caught** | **Caught** | Caught by `images` (`error`) and `links` (`warning`) checks after move |
| Cold-start `.bib` tether not following local move (`L-H2`) | **Caught** | **Caught** | Caught by `references` check (`tetherFileMissing` warning) |
| Cross-window stale tabs / review sync / `agentReviewStore` / `pendingSaves` (`U-H1`–`U-H10`) | **Missed** | **Missed** | Purely renderer/IndexedDB/workspace state unless a stale tab later overwrites disk |

---

## 1. In-App Moves — UI, Context Menu, Drag-and-Drop & Renderer Retargeting

### Critical

#### U-C1. `InkWriter.save()` Races With `retarget()` — Re-Queues `oldPath` Into `this.retry` (Active Oracle Evasion)
- **Where:** [use-ink-document.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/ink/use-ink-document.ts#L79-L89) (`retarget`), [use-ink-document.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/ink/use-ink-document.ts#L157-L205) (`save`); [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L416-L433).
- **Root Cause:** `InkWriter.retarget(path, sources)` updates `this.target` and `this.retry`, but **never updates `this.inFlight`**. When a move/rename/migration completes while `PATCH /api/ink` for `oldPath` is in flight and the request fails (404/409), line 192 executes `this.retry = batch`, pushing the stale `oldPath` batch back into `this.retry`. Every future Save on the retargeted tab continues sending `PATCH /api/ink` to `oldPath`.
- **Impact:** Unsaved ink is permanently stranded from `newPath`; if another file later occupies `oldPath`, the next Save **writes the moved file's ink strokes onto the replacement file**.
- **Oracle:** **Evaded.** `writeInk` ([ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L416)) computes `sourceIdentity` from the replacement file at `oldPath`, stamping the replacement file's own hash/size onto the misdirected ink (and Markdown ink stores no source hash).

#### U-C2. Unsaved Audio Transcript Edits Silently Lost and Flushed to `oldPath` on Move/Rename/Archive/Migration
- **Where:** [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L1441-L1443) (`tabUnsaved`), [workspace-panel.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/workspace-panel.tsx#L617), [editable-lines.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/audio/editable-lines.tsx#L207-L220), [use-voice-memo.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/audio/use-voice-memo.ts#L98-L105).
- **Root Cause:** `useSegmentDraft` never registers with `pendingSaves` and never sets `tab.status = "dirty"`, so `tabUnsaved` misses it and never prompts before moving. After the move commits, `retargetOpenTabs` updates `tab.id`, unmounting `<VoiceMemoViewer key={activeTab.id}>`. `useFlushWhenEditingEnds`'s unmount cleanup calls `saveSegments` with stale `oldPath`, which hits 404 and is dropped while the new mount loads the unedited transcript from disk.
- **Impact:** Silent data loss of unsaved transcript edits on any move/rename/archive/migration.
- **Oracle:** **Missed.**

#### U-C3. `getFileNode` / `readLiberaFile` Never Populates `fileId` for Local Files — Identity Protection Disabled on All Tab-Initiated Moves/Renames/Deletes
- **Where:** [tree.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/tree.ts#L240-L270) (`getFileNode`), [tree.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/tree.ts#L341-L353) (`stampLocalFileIds`), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L96-L128), [route.ts](file:///Users/thinhhoang/Documents/project-libera/src/app/api/files/route.ts#L63-L66), [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L3921-L3936).
- **Root Cause:** `localFileIdentity` is only stamped during `readTreeRoot`, never in `getFileNode` or `GET /api/files`. `openFile` and `retargetOpenTabs` store `payload.file` (with `fileId === undefined`) on `tab.file`. Tab-initiated Rename, Move…, and Delete send `fileId: undefined`, disabling `assertLocalFileIdentity` on the server.
- **Impact:** Moving, renaming, or deleting from a tab silently operates on a replacement file placed at that path outside Libera.
- **Oracle:** **Missed.**

#### U-C4. Cross-Notebook Drag/Move From a Shared Notebook Silently Substitutes `localNotebooks[0]` as Migration Source
- **Where:** [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4161-L4165), [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4229-L4233), [notebook-migration-dialog.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-migration-dialog.tsx#L90-L97), [notebook-migration-dialog.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-migration-dialog.tsx#L112), [notebook-migration-dialog.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-migration-dialog.tsx#L185-L192).
- **Root Cause:** Dragging or moving a file from `SharedNB` onto `LocalA` opens `NotebookMigrationDialog` with `initialSource = "SharedNB"`. Because `localNotebooks` excludes shared notebooks, `source` falls back to `localNotebooks[0]?.name` (potentially `LocalA` itself!), `destination` becomes `"LocalA"`, line 112 suppresses `notLocalNotebook`, and line 189 immediately auto-runs `review()` with mismatched `source` and `paths`.
- **Impact:** Broken shared→local drag/move flow; confusing error; risk of migrating from the silently substituted notebook if the user navigates back to Select.
- **Oracle:** **Missed.**

#### U-C5. `NotebookMigrationDialog` Bypasses Unsaved-Tab Checks & Save-All When Migrating `_archive` Files via Preset
- **Where:** [notebook-migration-dialog.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-migration-dialog.tsx#L48-L50), [notebook-migration-dialog.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-migration-dialog.tsx#L119-L121), [notebook-migration-dialog.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-migration-dialog.tsx#L157), [notebook-migration-dialog.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-migration-dialog.tsx#L229).
- **Root Cause:** `visibleChildren()` strips top-level `_archive` from `sourceChildren`, so `paths = selectionPaths(sourceChildren, selected)` evaluates to `[]` and `unsaved = unsavedTabsUnder(paths)` evaluates to `[]`, even though `request()` sends `preset ? [...selection].sort() : ...`. Unsaved edits in an open `_archive` tab are never flagged or saved before migration.
- **Impact:** Stale pre-edit bytes migrate without unsaved edits, assets, or links.
- **Oracle:** **Missed.**

### High

#### U-H1. No Cross-Window Sync for Regular Moves, Renames, Batch Moves, Archives, Folder Renames, or Detached File/Preview Windows
- **Where:** [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4110-L4294), [file-window-page.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/file-window-page.tsx#L15-L57), [use-markdown-windows.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-markdown-windows.ts#L10-L59).
- **Details:** `BroadcastChannel` move sync only exists for repair and migration. A second main window never retargets moved tabs or receives link rewrites for other open notes (saving from Window 2 hits 409 and "Replace disk version" reverts all rewritten links). Detached PDF/image popups (`FileWindowPage`) subscribe to zero move channels and keep writing ink/annotations to `oldPath`. Detached Markdown preview popups (`useMarkdownWindows`) look up tabs by `tabId` / `file.path`, both of which change on move/rename, causing refresh to 404.
- **Oracle:** **Missed** until Window 2 overwrites disk (then caught as broken links).

#### U-H2. `pendingSaves.moveUnsavedMany()` Async IndexedDB Staging-Path Race & `register` Cleanup `mounted` Leak
- **Where:** [pending-saves.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/pending-saves.ts#L55), [pending-saves.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/pending-saves.ts#L247-L257), [pending-saves.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/pending-saves.ts#L311-L370).
- **Details:**
  1. For overlapping/swap batches, `moveUnsavedMany` calls `moveUnsaved(from, "${to}\0moving-${i}")` then `moveUnsaved("${to}\0moving-${i}", to)`. Each spawns an unchained `open().then(...)`; step 2 can run before step 1 writes the staging key, permanently orphaning recovery records under `"\0moving-N"` in IndexedDB.
  2. `register(oldPath, key, entry)` captures `oldPath` in its unmount cleanup; after `moveUnsaved` relocates `registered` to `newPath`, unmount returns early without setting `registered.mounted = false`, leaking stuck dirty state.
  3. `discardedPaths` never clears a path on subsequent `put()`.
- **Oracle:** **Missed.**

#### U-H3. `MarkdownReviewProvider` Unmount Flush Races With Server `moveReviewPath` / `rewriteReviewSnapshots`
- **Where:** [markdown-review-context.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/markdown-review-context.tsx#L140-L156), [markdown-review-context.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/markdown-review-context.tsx#L362-L367), [markdown-review-context.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/markdown-review-context.tsx#L399-L458).
- **Details:**
  1. On retarget, unmount calls `flushTab()` and puts the **uncaught** promise into `leaving.current`. When the server rewrote links (`rewriteReviewSnapshots`), `flushTab` detects `base.snapshot !== stored.snapshot` and rejects; the new tab's `load()` awaits `Promise.all(leaving.current)`, aborting review load into an error state.
  2. `REVIEWS_MOVED_EVENT` is only dispatched by `notebook-integrity-dialog.tsx:181`, never after regular moves/renames/migrations that rewrite links in other open notes, leaving those open tabs with stale `doc.revision` / `doc.snapshot`.
- **Oracle:** **Missed.**

#### U-H4. `agentReviewStore` Never Flushed or Refreshed on Non-Migration Moves
- **Where:** [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4431), [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4449), [store.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/agent-review/store.ts#L135-L157).
- **Details:** Only `runNotebookMigration` flushes/refreshes `agentReviewStore`. Single moves, batch moves, renames, archives, folder renames, notebook renames, and repair leave stale 400ms debounced `setBaseline(oldPath)` timers (losing partial hunk decisions), stale paths in `AgentReviewStrip`, and stale `revision` on other open notes whose baselines were rewritten by `transformReviewBaselines` (causing 409 on Keep/Revert).
- **Oracle:** **Missed.**

#### U-H5. Batch Move Drops Link Rewrites on `payload === null` Partial-Failure Items & Clobbers Per-File Warnings
- **Where:** [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4262-L4272), [batch-files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/batch-files.ts#L269), [batch-files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/batch-files.ts#L290).
- **Details:** When a batch item hits `MoveCommittedError` / `SharedOperationUnfinishedError`, `payload` is `null`, `followBatchLinks` skips attaching `links` to it, `moveFilesToFolder` calls `followFileMove` without `links: result.links`, and line 4271 explicitly excludes `item.to` from `applyLinkRewritesToTabs`. A dirty moved tab never receives its link rewrite; saving later reverts links on disk. Also, calling `followFileMove` in a loop clobbers `referenceMoveNotice` per iteration.
- **Oracle:** **Missed** until saved.

#### U-H6. `applyLinkRewritesToTabs` Races In-Flight Saves, Uses Async `updateTab` (Stale `tabsRef`), CodeMirror Echo-Suppression Drops Rewrites, and TipTap Destroys IME Composition
- **Where:** [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L1749-L1763), [latex-editor.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/latex/latex-editor.tsx#L761-L765), [code-editor.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/code-editor.tsx#L284-L288), [markdown-codemirror-editor.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/markdown-source/markdown-codemirror-editor.tsx#L530-L534), [use-tiptap-draft.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-tiptap-draft.ts#L94-L97).
- **Details:** (1) Overwrites `status: "saving"` without synchronizing with in-flight `saveTabText`. (2) Uses async `updateTab` instead of `changeTabsNow`, leaving `tabsRef.current` stale for `workspaceManager.checkpoint()` or immediate saves. (3) CodeMirror `publishedRef.current` echo-suppression ignores a link rewrite that returns text to a previously emitted string (e.g., moving a target A→B→A). (4) TipTap calls `setContent` without guarding `editor.view.composing`.
- **Oracle:** **Missed** until stale buffer saves.

#### U-H7. Multi-Window `applyRepairMoves` & `followMigrationFromOtherWindow` Race `PUT /api/workspaces` and Abort Retargeting
- **Where:** [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4520-L4593), [use-saved-workspaces.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-saved-workspaces.ts#L365-L384).
- **Details:** Both Window A and Window B call `workspaceManager.runFileChange(...)`, issuing concurrent last-writer-wins `PUT /api/workspaces` writes. Worse, `applyRepairMoves` awaits `runFileChange` *before* retargeting open tabs; if Window B is switching workspaces (`locked.current`), it throws and leaves Window B's open tabs and `pendingSaves` un-retargeted.
- **Oracle:** **Missed.**

#### U-H8. `remapWorkspacePathsMany` Creates Duplicate Tab IDs on Collision, Leaves Stale `fileId`/`size`, and `movesForSavedWorkspaces` Over-Drops Valid Moves
- **Where:** [workspaces.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/workspaces.ts#L312-L324), [use-saved-workspaces.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-saved-workspaces.ts#L386-L391).
- **Details:** (1) No deduplication when a saved workspace has tabs at both `from` and `to`. (2) `file.size`, `file.fileId`, and `diskConflict` are not updated after text rewrites. (3) If *any* saved workspace holds a mismatched `fileId` at `move.from`, `sessions.some(...)` drops `move` for **every** saved workspace, even those with the matching `fileId`.
- **Oracle:** **Missed.**

#### U-H9. `renameFolder` & `submitNotebookDialog` Bypass `retargetOpenTabs`, Read Stale `tabs` Closures, and Omit State Remaps
- **Where:** [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L3425-L3498), [use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4687-L4777).
- **Details:** Both iterate over the render-time `tabs` closure instead of `tabsRef.current` when moving drafts, bypass `planRetargets` collision handling, and never remap `fileInteractions`, `remapDocumentHeadingNumbering`, or `untitled.saveDirectory`. `submitNotebookDialog` also uses async `setTabs` and never remaps `closedViewStates`.
- **Oracle:** **Missed** (except broken cross-notebook links on notebook rename, Section 3 `R-H4`).

#### U-H10. `reconcileCanvasLayout` Swaps Panes on Tab Swaps and Closes Unrelated Split Panes on Batch Merge
- **Where:** [canvas-layout.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/canvas-layout.ts#L201-L216).
- **Details:** Only infers renames when `previousTabIds.length === tabIds.length` and skips indices where `open.has(from) || previous.has(to)`. A swap (`A ↔ B`) silently swaps displayed files across panes; a batch where one tab merges (`A → B`) and another renames (`C → D`) skips the rename loop entirely and closes `C`'s split pane.
- **Oracle:** **Missed.**

### Medium & Low

- **U-M1. `StarredFilesSection` drag-and-drop & `Shift+Click` ([notebook-panel.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-panel.tsx#L752-L758), [notebook-panel.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-panel.tsx#L1310-L1332)):** Dropping a file onto a starred row moves it into that starred file's parent folder (even another notebook) with no UI indication; `Shift+Click` selects against the main tree instead of the Starred list.
- **U-M2. Drag-and-drop selection clearing & missing linked folders ([notebook-panel.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-panel.tsx#L734-L749), [notebook-panel.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/notebook-panel.tsx#L1584-L1669)):** `dropFileOnPath` clears multi-selection before confirmation/no-op/errors; `NotebookSection` accepts drops onto `linkedFolder?.missing`; `onDragLeave` flickers over children.
- **U-M3. `.trim()` on `destinationDirectory` in `submitWorkspaceInputDialog` ([use-libera-workspace.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-libera-workspace.ts#L4799-L4828)):** Breaks Move…/Copy… into folders with trailing spaces (while drag-and-drop preserves them).
- **U-M4. `useAnnotationWriter.save()` races across `await` without file identity ([use-annotation-writer.ts](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/use-annotation-writer.ts#L59-L96)):** Broadcasts to `oldPath`, clears dirty state for `newPath`, and can overwrite a replacement file's annotations at `oldPath` (**Oracle Evaded**, since server stamps replacement hash).
- **U-M5. `DocumentChatPanel` contexts never retarget ([document-chat-panel.tsx](file:///Users/thinhhoang/Documents/project-libera/src/components/libera/document-chat-panel.tsx#L1086-L1174)):** Attached moved PDF/audio contexts 404 on send; moved notes send stale pre-move text.
- **U-M6. Auxiliary UI caches & `archiveFolderNode` partial-failure gaps:** `pdfCommentsStore`, `discoveredRoots`, `activePreviewTabId`, `fileInteractions`, `headingNumbering`, and `archiveFolderNode` (missing partial-failure retargeting) do not follow moves.
- **U-L1. Stale `file.fileId` in confirmation dialogs** can trigger spurious 409s if a file was edited while the confirmation modal was open.

---

## 2. Local Storage — Single Moves, Batch Moves, Folder Ops, Migration & Path-Keyed Stores

### Critical

#### L-C1. Infinite Loop / CPU Spin DoS in `findAvailableCopyPath` When Review Index Is Damaged
- **Where:** [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L1023-L1033) (`findAvailableCopyPath`), [destination-records.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/destination-records.ts#L29-L32), [destination-records.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/destination-records.ts#L53).
- **Root Cause:** When `.libera/reviews/index.json` is damaged, `records.at(...)` returns `["review comments"]` for every candidate path. Unlike `archiveFile`, `archiveFolder`, and `migration.ts`, `findAvailableCopyPath` never checks `records.blocker` before looping `for (let index = 0; ; index += 1)`, hanging the Node.js server indefinitely.

#### L-C2. Moved Review Comments Permanently Shadowed by Pre-Existing Empty Reviews (Folder Ops, Migration, Notebook Rename)
- **Where:** [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L1183), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L1471), [notebooks.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/notebooks.ts#L156), [markdown-reviews.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-reviews.ts#L122-L167), [review-files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/review-files.ts#L263-L270).
- **Root Cause:** Destination checks deliberately allow moving onto paths with an empty review (`isEmptyReview`). Single-file moves pass `{ replaceEmpty: true }` to `moveReviewPaths`, removing the empty review. However, `moveFolderWithRecords` (`moveReviewPath`), `migration.ts:1471` (`moveReviewPaths(moves)` without `{ replaceEmpty: true }`), and `followNotebookRootRename` do **not**. Because `findReviewDocument` returns the first match in `index.json` insertion order, the pre-existing empty review shadows the moved review permanently—hiding all user comments and suggestions.
- **Oracle:** **Missed.** `integrity.ts` checks keys for existence, not duplicate review docs per path.

#### L-C3. Destructive TOCTOU `rm -rf` in `moveWithoutReplacing` and Non-Atomic `EXDEV` Partial-Copy Corruption
- **Where:** [fs-utils.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/fs-utils.ts#L55-L63), [fs-utils.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/fs-utils.ts#L201-L217).
- **Root Cause:**
  1. `moveWithoutReplacing` checks `if (await holdsFiles(nextPath))` (line 208) and then executes `await rm(nextPath, { force: true, recursive: true })` (line 210). Any sidecar/ink/transcript written into `nextPath` between those two calls is recursively destroyed (safe removal of empty dirs requires bottom-up `rmdir`).
  2. On `EXDEV` (moving sidecars across drives, e.g., notebook ↔ linked folder), line 215 falls back to `movePath` (`cp` + `rm`). A mid-copy failure leaves half of a multi-file `_ink` folder at `nextPath` with no rollback (permanently blocking retries with 409) and leaks `ERR_FS_CP_EEXIST` as 500 instead of 409.

#### L-C4. Lockless Folder Ops, `deleteFile` Identity TOCTOU, Unlocked Sidecar Writers, and Migration Lock-Stealing Race
- **Where:** [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L692-L834), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L905-L917), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L1035-L1058), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L1180), [route.ts](file:///Users/thinhhoang/Documents/project-libera/src/app/api/files/route.ts#L207-L208), [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L344-L447), [definitions.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/definitions.ts#L55-L60), [migration-fence.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration-fence.ts#L58-L96), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L412-L440).
- **Root Cause:**
  1. `renameFolder`, `archiveFolder`, `deleteFolder`, `deleteFile`, and `renameNotebook` never acquire `withPathLocks`; `moveFolderWithRecords` uses raw `fs.rename` (silently overwriting an empty directory created concurrently on POSIX); `archiveFile` picks `safeNextName` outside locks without retry or `legacyAnnotationSidecars` checks.
  2. `DELETE /api/files` and `batch-files.ts` verify `assertLocalFileIdentity` *outside* lockless `deleteFile`, allowing a concurrent replacement to be deleted.
  3. `writeInk` and `writeDefinitions` neither acquire `withPathLocks([sourcePath])` nor re-verify source existence before writing, recreating orphaned sidecars at `oldPath` during concurrent moves/deletes.
  4. `migration-fence.ts` compares paths case-sensitively (bypassable on macOS/Windows via alternate casing) and `claimNotebooksForMigration` does not wait for in-flight file/sidecar writers that passed `assertNotMigrating` just before the journal was written.
  5. `migration.ts:421-432` (`exclusively`) creates an empty `.lock` via `open(..., "wx")` before writing `{ pid }` with **zero** mtime grace period; a second process hitting `EEXIST` in that microsecond fails `JSON.parse("")` and immediately `rm`s the live owner's lock!

### High

#### L-H1. Case-Only Folder Rename Fails (409) With Python Code; Case-Only File Rename Strands Python Folder Casing; Pre-Move Mutation
- **Where:** [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L1206-L1230), [markdown-assets.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-assets.ts#L365-L385).
- **Details:** (1) On macOS/Windows, `moveFolderPythonSidecars` passes `{ replace: false }` to `movePythonSidecar`, where `await pathExists(destination.absolutePath)` hits the case-insensitive alias of the source and returns `false`, failing every case-only folder rename containing Python code with 409. (2) Single-file case-only rename (`Analysis.md → analysis.md`) renames `.py` inside the still-uppercase `_assets/Analysis.md/analysis.py`, breaking `pythonSidecarDocumentPath`. (3) Line 374 overwrites the source `.py` in place (clearing `previousPythonFigureSources` on cross-notebook moves) *before* attempting the move. (4) Rollback at `files.ts:1212` defaults to `replace: true`.

#### L-H2. `.bib` Tether Fails to Follow Local Moves on Cold Server Starts; `moveReferenceAttachments` Swallows Errors
- **Where:** [bib-tether.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/references/bib-tether.ts#L618-L622), [references.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/references.ts#L371-L379), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L422), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L1185).
- **Details:** Local moves rely on `moveReferenceAttachments` emitting `publishReferenceEvent({ type: "moved" })`, whose listener is only registered as a module-load side effect of `bib-tether.ts` (never imported by `/api/files`, `/api/folders`, or `/api/notebooks`). On cold starts, the event is silently dropped, breaking the tether. Even when loaded, `void moveTetheredFiles(...)` runs unawaited (racing `verifyNotebook` and folder rollbacks). Meanwhile `moveReferenceAttachments` catches and swallows all errors from `remapReferenceAttachments`, preventing `unfinished` reporting or rollback.

#### L-H3. Post-Shared-Takedown Audio Companion `.transcript` Files Forgotten Everywhere in Local Storage
- **Where:** [transcripts.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/transcripts.ts#L49-L57), [transcripts.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/transcripts.ts#L167-L175); omitted from [sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/sidecars.ts), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts), [destination-records.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/destination-records.ts).
- **Details:** After a shared notebook takedown, `<name>.transcript` stays beside `<name>.m4a` and is adopted on first read. Local move/rename/archive leaves it behind (losing the transcript); `deleteFile` leaves it behind (causing a future recording of the same name to inherit the deleted transcript); migration drops it on single-file move and fails to rename it on folder clash.

#### L-H4. Unicode NFC/NFD Normalization Gaps on macOS Break Renames, Path Locks, Batch Preflight & Migration Planning
- **Where:** [fs-utils.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/fs-utils.ts#L104) (`withPathLocks`), [fs-utils.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/fs-utils.ts#L155-L163) (`isCaseOnlyRename`), [notebooks.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/notebooks.ts#L119), [batch-files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/batch-files.ts#L135), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L680-L788).
- **Details:** All use `.toLowerCase()` without `.normalize("NFC")`. Renaming an NFD macOS file `Cafe\u0301.md` to NFC `Café.md` fails with 409 `"already exists"`; concurrent NFC/NFD saves & moves acquire different lock keys; batch/migration of NFC + NFD same-name files from two folders passes preflight and collides mid-operation.

#### L-H5. `destination-records.ts` & `leftoverRecords` Miss 5 Record Types (Silent Overwrite / Inheritance)
- **Where:** [destination-records.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/destination-records.ts#L34-L76), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L583-L650).
- **Details:** Missing checks for: (1) `.bib` tethers (moving a `.bib` onto an orphaned tethered path silently overwrites/merges it on next tether sync), (2) hash-less set-aside records in `.libera/orphaned-sidecars/` (automatically reattached to the unrelated arriving file on next refresh), (3) `agent-runs/*.json` undo snapshots (not cleaned on delete; `undoRun` skips hash check when `existed: false` or `written: ""`), (4) `legacyPythonSidecarPath` in `existingSidecars` (silently inherited on open), and (5) damaged/unreadable metadata, reference libraries, legacy reviews, and unreadable agent reviews (silently treated as empty).

#### L-H6. Cross-Notebook Migration (`migration.ts`) Crash-Recovery Wedge, `_assets` Staging Deadlock & Non-Idempotent `"history"` Step
- **Where:** [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L782-L786), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L1548-L1595), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L1867-L1879), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L1933-L1950).
- **Details:**
  1. **Unrecoverable 409 wedge in `resumeMigration` (`phase === "finalizing"`):** Line 1936 calls `reconcile` with no `try/catch` (unlike `runMoving` lines 1770–1776), so an unmoved item kept by "Stop here" throws 409 forever if any finalize step fails once and is resumed.
  2. **Staging deadlock on colliding sanitized `_assets` names:** Migrating `a b.md` and `a-b.md` (or `notes.md` and `notes.markdown`) together creates `Dest/_assets/a-b` on item 0 and fails item 1 at line 1874 (`madeAbove` checks strict descendant, false for equal paths) with 409.
  3. **Corrupting & non-idempotent `"history"` step:** Rewrites review baselines/undo snapshots using `journal.references.drafts` even when `journal.citationRewritesApplied === false`, and re-applies `rewriteCitationKeys` on resume after a crash between lines 1593 and 1594.

#### L-H7. Shared Batch Moves Rewrite Links Per File (O(N²) CRDT Churn) and Drop `BatchMoveResult.links`
- **Where:** [route.ts](file:///Users/thinhhoang/Documents/project-libera/src/app/api/files/batch/route.ts#L75-L80), [batch-files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/batch-files.ts#L243-L276).
- **Details:** `moveSharedFile` has no `deferLinks` mode, so moving N interlinked shared files runs `followSharedMovedLinks` N times (mutating mutual links back-and-forth) and never populates `BatchMoveResult.links` (breaking saved-workspace rewrites and losing link reports on `SharedOperationUnfinishedError`).

#### L-H8. `deleteNotebook` Leaves Orphaned Pending Agent Reviews and Active `bib-tether` / `bib-mirror` Timers
- **Where:** [notebooks.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/notebooks.ts#L170-L194).
- **Details:** Never calls `discardReviewsUnder(name)` (orphaning `.libera/agent-review/*.json` that block a future notebook of the same name) and never stops `bib-tether` watchers or pending `bib-mirror` debounce timers.

### Medium & Low

- **L-M1. Unretargeted secondary path-keyed stores:** [document-chat.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/document-chat.ts) and [where-was-i.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/where-was-i.ts) are never updated on any move, rename, archive, delete, or migration (and invisible to `integrity.ts`).
- **L-M2. `batch-files.ts` path normalization & preflight gaps ([batch-files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/batch-files.ts#L99-L153), [batch-files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/batch-files.ts#L269-L292)):** Unnormalized raw strings allow `Notes//a.md` duplicates, fail trailing-slash `destinationDirectory`, misclassify leading-slash `/SharedNb/_archive/...`; `preflightLocalMove` omits `assertNotMigrating` & `assertSidecarsCanMove`; `MoveCommittedError.unfinished` is dropped at line 269.
- **L-M3. Additional migration gaps ([migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L548-L580), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L776-L789), [migration.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration.ts#L1482-L1620), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L414-L419)):** Selecting parent + child folders walks the child twice; caches/empty ink folders cause spurious renames; ignored `cleanupMarkdownImageAssets` `false` return; `checkNothingLeftAt` misses cross-notebook `.bib` tethers; `"links"` step omits `replan` and skips `rewriteReviewSnapshots` on crash recovery; reused reference entry drops migrated PDF attachment.
- **L-M4. Miscellaneous local file ops ([files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L253-L256), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L460-L494), [files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L980-L1125)):** `moveFile` self-rename returns 409; symlinked folders skip Python sidecars; `copyFileToDirectory` leaks destination on metadata error; `saveEditedImageCopy` uses `findAvailableFilePath` instead of `findAvailableCopyPath` (inheriting leftover records); `.md → .txt` rename strands `_assets` images; `finishMarkdownImageMove` uses non-atomic `writeFile`.
- **L-L1 / L-L2:** `deleteFile` ignores `cleanupMarkdownImageAssets` returning `false`; `migration-fence.ts` directory `mtimeMs:ctimeMs` cache can miss same-tick cross-process journal transitions.

---

## 3. Link & Path Rewriting Engine (Local & Shared)

### Critical

#### R-C1. Shared Notebook Link Pre-Filter Silently Skips `/api/files/raw/` Images, Charts Under Renamed Folders, HTML `<a href>`, and Live CRDT Edits
- **Where:** [shared-move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-move-links.ts#L74-L80), [markdown-link-occurrences.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/markdown-link-occurrences.ts#L46-L90).
- **Root Cause:** `sharedLinkSource().documents` filters which shared notes to fetch from the host using the local on-disk `notebook-links.json` index plus `charts = hint.names.some(n => /\.(csv|tsv)$/i.test(n))`:
  1. `/api/files/raw/...` image embeds (`![](/api/files/raw/...)` and `<img src>`) are **never** in `notebook-links.json` → moving an image skips unmoved notes and breaks images (**Caught by oracle** as `error`).
  2. Renaming a folder containing `.csv`/`.tsv` chart data yields folder names in `hint.names` (not `.csv`/`.tsv`) → `charts` is `false` → chart blocks in unmoved notes are skipped (**Caught by oracle** as `chartDataMissing`).
  3. HTML `<a href="...">` links are never in `notebook-links.json` → skipped (**Missed by oracle too**).
  4. `notebook-links.json` is built from lagging local disk and cached 3–6 min (`LINK_RECHECK_MS`); links recently added in the live CRDT are skipped (**Caught by oracle** once synced).

#### R-C2. Shared Notebook `_archive/` Notes Are Never Rewritten, and Links Into `_archive/` Fail Existence Checks
- **Where:** [shared-move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-move-links.ts#L52-L58), [shared-move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-move-links.ts#L70-L95).
- **Root Cause:** (1) `sharedLinkSource().documents` only iterates manifest entries, skipping local `_archive/` notes that link to moved shared files. (2) `existence` checks `sharedIn(notebookOf(libraryPath))` instead of `sharedIn(libraryPath)`, routing `SharedNB/_archive/old.md` to the manifest (which never lists `_archive/`) instead of disk, so moving a note linking to `_archive/old.md` sees `layout.before === false` and leaves the link broken.
- **Oracle:** **Caught** (`integrity.ts` scans `_archive/` on disk).

### High

#### R-H1. Shared Blob-Stored Markdown & LaTeX Files Always Fail Rewriting in `applySharedNotes`
- **Where:** [shared-move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-move-links.ts#L60-L67), [shared-move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-move-links.ts#L124-L145).
- **Details:** `sharedLinkSource` reads blob-stored text files via `readSharedEntryBytes` and plans rewrites, but `applySharedNotes` unconditionally calls `readSharedText` (`requireSharedDoc`), throwing `not-shared-document` (404) instead of falling back to `saveSharedFileText`.

#### R-H2. `renameNotebook` Never Rewrites Any Links or Image Addresses
- **Where:** [notebooks.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/notebooks.ts#L84-L167).
- **Details:** Never invokes `followMovedLinks` and never rewrites `/api/markdown-assets/raw?document=OldNotebook/...`. Breaks all cross-notebook links and embeds in other notebooks (**Caught by oracle** on those notebooks).

#### R-H3. LaTeX Compiler (`openin_any=p`) Disagrees With `planLatex` & `verifyNotebook` — Rewrites Produce Uncompilable `../` and `_archive/` Paths
- **Where:** [build.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/latex/build.ts#L283), [build.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/latex/build.ts#L349), [build.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/latex/build.ts#L449-L455), [move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/move-links.ts#L238-L243), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1053-L1077).
- **Details:** (1) Renaming a notebook-root `.bib` referenced via `BIBINPUTS` from `paper/main.tex` rewrites `\bibliography{references}` to `\bibliography{../refs}` (blocked by `openin_any=p`). (2) Moving `main.tex` into a subfolder rewrites includes/graphics to `../...` (blocked by `openin_any=p` and `sharedSources`). (3) Archiving an `\include`d chapter rewrites to `_archive/...`, which `mirrorSourceFolders` skips (`_`-prefixed).
- **Oracle:** **Missed completely** (oracle shares `latexDependencies` and reports 0 findings).

#### R-H4. `writeLatexPath` Allows Commas (Breaking `\bibliography`) and Leading Spaces (Broken by `.trim()`)
- **Where:** [move-rewrites.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/move-rewrites.ts#L291-L293), [move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/move-links.ts#L294-L305), [path-occurrences.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/latex/path-occurrences.ts#L27-L51).
- **Details:** Renaming `refs.bib` → `Smith, 2024.bib` writes `\bibliography{Smith, 2024}`, which BibTeX and `readLatexBibliographyReferences` split into `Smith.bib` and `2024.bib`. Leading spaces in filenames are written unquoted and stripped by `.trim()` on re-read. **Caught immediately by oracle** (violating the oracle contract).

#### R-H5. `\documentclass[../main.tex]{subfiles}` Treated as Standalone Root
- **Where:** [dependencies.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/latex/dependencies.ts#L159), [project.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/latex/project.ts#L79-L86).
- **Details:** `latexDependencies` ignores `subfilesRootPath`, adding subfiles to `roots`. Moving a subfile triggers a spurious `latex-builds` conflict skip and an oracle false positive.

#### R-H6. Chart Block Rewriting Misses Indented/Flow/Quoted-Key/Multiline YAML, Hijacks `#` Comments, and Misses Escaped Apostrophes in Pre-Filter
- **Where:** [move-rewrites.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/move-rewrites.ts#L78-L118), [move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/move-links.ts#L352).
- **Details:** (1) `/^data\s*:\s*/` fails on indented YAML, flow YAML, `'data':`, and multiline values (all accepted by `js-yaml` and `verifyNotebook`). (2) Unanchored `/"data"\s*:\s*/` matches inside YAML `# "data": "sales.csv"` comments and rewrites the comment instead of the real key. (3) Single-quoted YAML `'don''t.csv'` fails `content.includes("don't.csv")` and `/[%&\\]/`, bypassing `planMovedLinks` completely. **All caught by oracle** (`chartDataMissing`).

#### R-H7. `destinationRange` Corrupts Markdown Alt Text or Misses Images Containing Code Spans With `[` or `]`
- **Where:** [markdown-image-sources.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/markdown-image-sources.ts#L25-L34).
- **Details:** Scans raw brackets without skipping backtick code spans: `` ![see `]` here](/api/files/raw/nb/img.png) `` corrupts alt text on rewrite; `` ![a `[` b](/api/files/raw/nb/img.png) `` skips the URL entirely. **Caught by oracle** (`imageMissing`).

### Medium & Low

- **R-M1. `writeDestinationPath` falsely skips angle-bracket links containing both whitespace and `&`/`\`** ([move-rewrites.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/move-rewrites.ts#L265-L280)) such as `[doc](<old/R&D notes.md>)` as `"unwritable"`.
- **R-M2. Parser & oracle divergence ([integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1012-L1025), [move-rewrites.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/move-rewrites.ts#L45-L75)):** `verifyNotebook` never checks HTML `<a href>` or Markdown `/api/files/raw/...` links; lack of `remarkGfm` misparses single-token footnotes `[^1]: old/doc.md` as reference links; `htmlOccurrences` fails to ignore inline `<code><a href="...">` split across AST nodes.
- **R-M3. `SharedOperationUnfinishedError` drops `linked.links`** ([shared-writes.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/collab/shared-writes.ts#L756-L760), [shared-writes.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/collab/shared-writes.ts#L863-L867)), leaving other open local tabs desynchronized from disk.
- **R-M4. Review snapshot & baseline rewrite gaps ([files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/files.ts#L330-L372), [markdown-reviews.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-reviews.ts#L175-L193), [markdown-assets.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-assets.ts#L541-L542)):** `files.ts` runs Images → Citations → Links (diverging from `moveTextRewrite`'s Images → Links → Citations); `rewriteReviewSnapshots` skips moved notes whenever images/citations already changed `doc.snapshot`; pending agent review baselines & undo originals drop rewrites for links the agent modified/removed; `copyMarkdownImageAssets` throws uncaught `URIError` on malformed `%ZZ` URLs and drops `?query#hash`.
- **R-L1. `planLatex` edge cases ([move-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/move-links.ts#L253-L308)):** Drops `listing.unreadable` (missing `unchecked`), skips cross-notebook `folder: true` `.tex` moves, rewrites inside `\verb`/`verbatim`, and never updates `\graphicspath`.

---

## 4. External Moves (File Explorer / Finder / Sync Client), Tree Upkeep, Try to Fix, Acknowledge & Directory Mode

### Critical

#### E-C1. macOS NFD/NFC Mismatch in `unreferencedMarkdownAssets` Causes `Acknowledge` (and Note-Save Pruning) to Permanently Delete Live, Displayed Images
- **Where:** [markdown-assets.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-assets.ts#L126-L151), [markdown-assets.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-assets.ts#L232-L310), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L908-L946), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L320-L324), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L491-L498).
- **Root Cause:** `unreferencedMarkdownAssets`, `rawEmbedsInOtherNotebooks`, and `cleanupMarkdownImageAssets` lowercase paths **without** `.normalize("NFC")`. On macOS, `readdir` yields NFD (`cafe\u0301.png`) while notes hold NFC (`caf\u00e9.png`). For any accented image outside `ownedPrefixes` (e.g., after an external move/rename of its note, or cross-note embed), `referenced.has(key)` returns `false`. Meanwhile `integrity.ts:912` calls `stat()` on the NFC path (succeeds on APFS), so `embedded` does **not** protect it. `integrity.ts` attaches `clear`, and `cleanup.ts` `rm`s the live image.
- **Impact:** Permanent deletion of live user images on macOS via `Acknowledge` or note save. **Caused by `integrity.ts` itself.**

#### E-C2. `getLinkedFolders()` Cache Completely Bypasses `.libera-folder.json` Identity Proof When a Linked Folder Is Externally Moved & Replaced While Running
- **Where:** [paths.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/paths.ts#L148-L186), [directory-mode.cjs](file:///Users/thinhhoang/Documents/project-libera/electron/directory-mode.cjs#L186-L236).
- **Root Cause:** `getLinkedFolders()` caches `LinkedFolder[]` keyed solely on `statSync(directory-mode.json)` and returns `cached.folders` without re-verifying the folder's `.libera-folder.json` marker. Moving `/Projects/Research` away in Finder/Explorer and placing an unrelated folder at that path leaves `directory-mode.json` unchanged, so `getTree()`, `verifyNotebook()`, `planNotebookRepair()`, and `planNotebookCleanup()` all treat the unrelated folder as the original linked notebook.
- **Impact:** Tree upkeep sets aside or cross-attaches records to unrelated files; Try to fix migrates records to the wrong folder; Acknowledge deletes the original folder's records. **Completely missed by `integrity.ts`.**

#### E-C3. Cross-Volume (`EXDEV`) Linked-Folder Ink Set-Aside Throws Uncaught `EXDEV`, Halts Ink Upkeep, and Leaks Unbounded `record.json` Directories
- **Where:** [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L52-L57), [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L592-L671), [pdf-sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/pdf-sidecars.ts#L87-L95), [paths.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/paths.ts#L229-L240).
- **Root Cause:** For a linked folder on a different volume (e.g., `D:\` vs `C:\` or external drive), `_ink` lives in `folder.path` while `.libera/orphaned-sidecars/ink/` lives under `getAdminRoot()`. `reconcileInkFolders` writes `record.json` at line 632 and calls `moveToFreeSlot` → `movePathExclusive` → `fs.rename` → uncaught `EXDEV`. Cleanup lines 635–636 are skipped, `reconcileInkFolders` aborts, and **every** subsequent `getTree()` refresh creates another empty `<now>-<uuid>/record.json` directory while starving all other ink reconciliation.
- **Oracle:** `integrity.ts:866-877` reads those empty `record.json` files without checking whether `ink/` exists, producing false reattachment promises or bogus kept-file counts.

### High

#### E-H1. Case-Only / Normalization-Only External Renames Rip Live PDF Sidecars & Ink Into `orphaned-sidecars/` After 30s (and 90-Day Expiry Permanently Deletes Markdown Ink)
- **Where:** [pdf-sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/pdf-sidecars.ts#L365-L496), [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L592-L668), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L788-L855).
- **Root Cause:** `fileExistence().isFile()` detects `Paper.pdf → paper.pdf` (or `Docs → docs`, NFC/NFD) as missing. `matchByIdentity` checks `slotTakenBy` → `pathExists` (`access`), which returns `true` on case/normalization-insensitive macOS/Windows because `Paper.pdf.json` aliases `paper.pdf.json`. Matching fails, so after 30s `setAside` rips the live sidecar/ink off disk into `orphaned-sidecars/`. For **Markdown ink** (no `source` hash) and **legacy PDF sidecars**, exact `originalPath` fails and `mayBeBack` returns `false`, so **90-day expiry permanently deletes them**. For hashed PDFs, `lastStoredScan` creates a 60s–5m blackout where adding any annotation blocks reattachment permanently.

#### E-H2. `aliasRename` (`repair.ts`) and `renameCaseAlias` (`fs-utils.ts`) Silently No-Op on Parent-Folder Case Renames, Corrupt Python Sidecar Paths, and Wedge Linux Retries
- **Where:** [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L156-L207), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L246-L269), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L643-L655), [fs-utils.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/fs-utils.ts#L294-L303).
- **Details:** (1) On macOS/Windows, renaming `Docs/paper.pdf → docs/paper.pdf` causes `aliasRename` / `renameCaseAlias` to move `Docs/paper.pdf.json` to `.moving` and back to `docs/paper.pdf.json`—which the OS puts right back into the existing `Docs/` directory! Try to fix reports `"moved"` while `listSidecars` still sees `Docs/paper.pdf.json` (infinite repair loop). (2) `movePythonAlias` renames `Note.py → note.py` inside `_assets/Note.md/`, breaking `pythonSidecarDocumentPath`. (3) On Linux, crashing between `publish()` (hard link, `nlink === 2n`) and `rm(source)` during a case-only repair causes `slotOf` line 162 (`foldedFileName(source) === foldedFileName(destination)`) to return `"same"` instead of `"ours"`, wedging retries on `reason: "own"`.

#### E-H3. Corrupt/Unreadable Set-Aside Records & Corrupt Live Orphaned Sidecars Are Offered for Deletion and Deleted by `Acknowledge`
- **Where:** [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L713), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L805-L809), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L860-L890), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L148-L156), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L271-L281).
- **Details:** (1) `readOrphans` and `integrity.ts:871` swallow parse/read errors without adding set-aside directories to `unsettled`; lines 882–890 then put every non-returning file into `clear: kept`, and `cleanup.ts`'s `setAsideOrigin` returns `null`, bypassing `gone(origin)` and deleting the files. (2) At `integrity.ts:713`, corrupt live orphaned sidecars `continue` without adding to `unread`, so `decided` becomes `true` and `Acknowledge` deletes them even though their recorded identity could not be read.

#### E-H4. No Mutual Exclusion Between Concurrent `getTree()` Upkeep, `applyNotebookRepair`, and `applyNotebookCleanup` (+ Backfill Bypasses Migration Fence)
- **Where:** [migration-fence.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/migration-fence.ts#L159-L170), [tree.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/tree.ts#L505-L540), [pdf-sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/pdf-sidecars.ts#L106-L118), [pdf-sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/pdf-sidecars.ts#L377-L387), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L574-L687).
- **Details:** `enterOperation` is a refcount, not a mutex. Two concurrent `GET /api/tree` calls past 30s both call `setAside` on the same PDF sidecar, creating two `<ts>-<uuid>-<name>` files in `orphaned-sidecars/` and permanently wedging Try to fix on `reason: "conflict"`. Upkeep can also race `applyRepair` or double-POST repair requests. Additionally, the background identity-backfill IIFE (`pdf-sidecars.ts:379-386`) runs outside `whenNotebookIdle` and `assertNotMigrating`.

#### E-H5. Shared-Notebook `staleness()` Checks Local-Notebook Attachments Against the Shared Manifest, Detaching Live Local Attachments
- **Where:** [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L254-L258), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L271-L281), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1192-L1203).
- **Details:** When `notebook` is shared, `cleanup.ts:273` routes **all** `action.gone` paths to `sharedGoneHold(view, libraryPath)` without checking if `libraryPath` is in `notebook`. For a reference in `SharedNB` attaching `LocalNB/paper.pdf`, `view.files.has("LocalNB/paper.pdf")` is always `false`, failing to hold a returned/aliased/offline local attachment and detaching it.

#### E-H6. `reconcileInkFolders` Never Clears `missingSince` When a File Returns
- **Where:** [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L541), [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L592-L638).
- **Details:** Unlike `pdf-sidecars.ts:388`, `ink.ts` never deletes a returned file from `missingSince`. After a single brief sync blip, any future transient disappearance sets aside `_ink/<file>` immediately with 0 ms grace.

#### E-H7. Linux Case-Only External Rename of a Markdown Note Hides Orphaned Python Code From Both `integrity.ts` and `repair.ts`
- **Where:** [markdown-assets.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-assets.ts#L133), [markdown-assets.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-assets.ts#L144-L145).
- **Details:** On case-sensitive Linux, renaming `Analysis.md → analysis.md` leaves `_assets/Analysis.md/Analysis.py` unreachable, yet `unreferencedMarkdownAssets` lowercases `owned` prefixes and excludes it from `unused`. Both Check Notebook and Try to fix report clean.

#### E-H8. `setAside()` Throws `ENAMETOOLONG` for PDF Filenames > ~179 Bytes, Starving All PDF Reconciliation (+ Duplicate Leak)
- **Where:** [pdf-sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/pdf-sidecars.ts#L106-L118), [pdf-sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/pdf-sidecars.ts#L423).
- **Details:** Prepending `${Date.now()}-${uuid8}-` (+23 B) and appending `.${pid}.${uuid}.tmp` (+48 B) pushes valid 180–255 B filenames over 255 B, throwing `ENAMETOOLONG` and aborting the entire notebook's `reconcilePdfSidecars` pass. Also, line 116 returns without removing the orphan file if the source changed mid-write.

#### E-H9. `scheduleReferenceReattach` Ignores Shared Notebooks & Migrations, Skips Hash Recheck Under Lock, and Omits Events/Mirrors
- **Where:** [references.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/references.ts#L489-L595).
- **Details:** Can repoint an undelivered shared PDF's attachment to a same-byte copy in another notebook or `_archive`; bypasses migration fence; commits under lock without re-verifying target hash/size; omits `publishReferenceEvent`, `scheduleBibMirror`, and `notifySearchReferenceChanges`.

### Medium & Low

- **E-M1. Oracle disagreement on multi-version ink folders (`integrity.ts:717` vs `ink.ts:568-579`):** `integrity.ts` reads `sources[0]` instead of detecting `"conflict"`, falsely promising reattachment or offering a partially-matching ink folder to Acknowledge.
- **E-M2. `Acknowledge` deadlocks with `Try to fix` on `reason: "own"` / `"unread"` / `"conflict"` ([cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L300), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L339)):** Treats every `unmatched` entry with `candidates.length > 0` as `ambiguous` with the wrong message *"more than one file has the name..."*, making stale records un-clearable from the UI when a different file of that name already has its own records.
- **E-M3. `.replaced-<hash>.json` annotation backups misclassified as orphans and deleted by `Acknowledge`** ([annotations.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/annotations.ts#L665-L670), [sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/sidecars.ts#L362-L364)).
- **E-M4. Shared set-aside live PDF annotations & ink:** `repair.ts:345` refuses them (`reason: "host"`), while `sharedMayClear` ([integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L433)) offers them to Acknowledge for deletion.
- **E-M5. `rawEmbedsInOtherNotebooks` skips offline linked folders** ([markdown-assets.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/markdown-assets.ts#L232-L241), [library-links.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/library-links.ts#L13-L19)), allowing Acknowledge / note pruning to delete images embedded by an offline linked folder.
- **E-M6. Windows & partial-failure gaps in `repair.ts` ([repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L110), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L172-L266), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L347), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L454-L463), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L635)):** Non-atomic `writeFile(..., flag: "wx")` for set-aside restore; missing `EINVAL` in `LINK_UNAVAILABLE`; `EPERM`/`EBUSY` handling on Windows directory renames & `rm(source)`; legacy Python sidecar not checked in `ownRecords()`; swallowed `readOrphans` errors.
- **E-M7. Cross-notebook external moves strand all per-notebook sidecars & records** (except hashed reference attachments); Acknowledge offers to delete them and 90-day expiry deletes set-aside records.
- **E-M8. `directory-mode.ts` & `electron/directory-mode.cjs` bugs ([directory-mode.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/directory-mode.ts#L47-L64), [directory-mode.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/directory-mode.ts#L164-L165), [directory-mode.cjs](file:///Users/thinhhoang/Documents/project-libera/electron/directory-mode.cjs#L151), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L577), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L563)):** Case-sensitive/non-realpath path checks; stale `unmarked: true` surviving writable upgrade; unlocked/non-UUID temp file; `assertRepairable` upgrading legacy linked folder `stateRoot` before `applyCleanup` token check (causing 409).
- **E-L1–L5:** Throttled upkeep skipped 5 min after incomplete/migrating walk (`tree.ts:423-430`); 60s `lastStoredScan` delay on restored PDFs; `prunePdfTextCaches` running on shared notebooks & using `stat()` instead of `fileExistence()`; `reconcileInkFolders` cross-type pool & nested-folder set-aside edge case; duplicate review docs wedging `Acknowledge` (`cleanup.ts:217` vs `markdown-reviews.ts:205`); Windows drive-letter casing in `cleanup.ts:423`; `localFileIdentity` `birthtime` collision on Linux; `references.ts:461` walking `_ink/`.

---

## 5. Collaboration & Shared Notebook Move Interactions

### Critical

#### S-C1. Shared PDF Rename/Delete Permanently Orphans Local Sidecars and Creates an Unbreakable Path-Reuse Deadlock on `pdfLive: true` Notebooks
- **Where:** [pdf-sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/pdf-sidecars.ts#L136-L217), [pdf-sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/pdf-sidecars.ts#L405-L408), [shared-record-follow.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-record-follow.ts#L138), [shared-record-follow.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-record-follow.ts#L160), [shared-record-follow.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-record-follow.ts#L339-L341), [pdf-marks.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/pdf-marks.ts#L210-L214), [shared-manifest-view.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-manifest-view.ts#L100-L102), [shared-writes.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/collab/shared-writes.ts#L743), [shared-writes.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/collab/shared-writes.ts#L914-L920).
- **Root Cause:**
  1. On rename (`Shared/a.pdf → Shared/b.pdf`), `followOneMove` **copies** `pdf-annotations`, `pdf-outline`, and `definitions` and never deletes the originals at `a.pdf`; `moveSharedLocalRecords` skips them; `reconcilePdfSidecars` skips `missing` on shared notebooks.
  2. On delete (`Shared/a.pdf`), `retireRemovedPdf` returns early because `pdfExists` is `false`; `removeLocalSidecars` skips `HOST_OWNED_SIDECARS`; and on `pdfLive: true`, `PdfMarksRuntime.sync()` calls `close(doc, true)`, **actively writing** `.libera/annotations/pdf/by-path/a.pdf.json` to disk!
  3. `verifyNotebook` reports `warning: orphanSideFile` for `Shared/a.pdf`. Because `hostOwnsSideFile("pdf-annotations", "Shared")` is `true` when `pdfLive: true`, **Acknowledge strips `clear`** and **Try to fix refuses (`reason: "host"`)**.
  4. Yet `assertNoLeftoverRecords` / `assertSharedPathFree` sees `.libera/annotations/pdf/by-path/a.pdf.json` and **permanently refuses** renaming `b.pdf` back to `a.pdf` or uploading a new `a.pdf` with **409 Conflict** ("run Check Notebook").
  5. Same orphan leak applies to pending local audio transcripts in [transcripts.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/transcripts.ts#L468-L522).

#### S-C2. `recordTransitions()` Always Defers During In-App `fileOp`, Completely Defeating M23 Server-ACK Rollback Protection in `followCommittedChange()`
- **Where:** [project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L1110-L1112), [project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L4168-L4217), [project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L4558-L4565), [shared-record-follow.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-record-follow.ts#L591-L611), [shared-writes.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/collab/shared-writes.ts#L750-L886).
- **Root Cause:** `fileOp()` writes the Yjs manifest (incrementing `manifestHub.pendingCount ≥ 1`) and immediately calls `applyManifest()`. Inside `recordTransitions()`, `manifestAcknowledged()` (`pendingCount === 0`) is **always `false`**, setting `transitionsDeferred = true` and recording zero rows in `manifest_transitions`. Immediately after `fileOp()` returns, `followCommittedChange()` drains an empty log, places every change into `uncovered`, and **immediately executes all local moves/deletes before server ACK** (permanently destroying local sidecars, reviews, stars, tags, pending agent reviews, and attachments if an offline or role-revoked delete is rolled back on reconnect). Later, when the server ACKs, `recordTransitions()` records the transition and replays it a second time.

### High

#### S-H1. Case-Only File/Folder Renames Break Implied Directories (`_ink/<file>`, `_assets/<note>`, Implied Subfolders) & Trigger Cross-OS Ping-Pong
- **Where:** [project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L1292-L1304), [project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L1443-L1463), [project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L3780-L3805).
- **Details:** `respellFolder` only runs on explicit `kind: "folder"` entries—never on `_ink/<file>/`, `_assets/<note>/`, or implied subfolders. On macOS/Windows, case-only renaming `Note.md → note.md` places companions right back into `_ink/Note.md/` / `_assets/Note.md/` before `pruneEmptyDirectories` runs; two scans later, `noteRespelling` (which only suppresses NFC differences, not case) rewrites the manifest companion path **back** to `_ink/Note.md/...`, permanently detaching ink and Python code from `note.md`. Similarly, a Linux case-only rename of an implied folder triggers a cross-OS rename ping-pong with macOS/Windows peers.

#### S-H2. `PdfMarksRuntime.resolve()` Uses Exact String Equality, Permanently Returning 503 on NFD/Case Mismatches
- **Where:** [pdf-marks.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/pdf-marks.ts#L342-L350), [service.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/service.ts#L2529-L2541).
- **Details:** `entry.path !== relative` fails whenever macOS disk NFD differs from manifest NFC (or case differs), causing `GET /pdf-docs/resolve` to permanently return HTTP 503 (`"Live PDF status is still loading."`), breaking live PDF marks, comments, and `verifyNotebook`'s `links` check.

#### S-H3. `shared-owner.ts` & `ink.ts` Bypass `sameManifestPath`, Disabling Companion Ownership Guard & Dropping Collaborator Ink
- **Where:** [shared-owner.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/collab/shared-owner.ts#L12), [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L390-L394), [ink.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/ink.ts#L517-L528).
- **Details:** Exact string comparison disables `ownerFileId` fencing and misses undelivered remote ink entries on NFD/case mismatches. Separately, `copyInkThroughEdit` reads ink from local disk instead of host blobs and writes without `ownerFileId` or `createOnly`.

#### S-H4. `shared-record-follow.ts` Uses Case-Sensitive Exact Path Maps in `judge()` and `orderTransitions()`
- **Where:** [shared-record-follow.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-record-follow.ts#L284-L286), [shared-record-follow.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-record-follow.ts#L368), [shared-record-follow.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-record-follow.ts#L445).
- **Details:** If `fil_1` leaves `Shared/Note.md` and `fil_2` occupies `Shared/note.md` before drain, `manifest.byPath.get("Shared/Note.md")` returns `undefined` → `judge()` returns `"own"`. On macOS/Windows, `fil_1`'s delete unlinks `fil_2`'s live sidecar inode, and `fil_1`'s move steals it! Similarly, case-differing chained moves (`Foo.md → Archive.md`, `Bar.md → foo.md`) aren't ordered and spuriously hold on `EEXIST`.

#### S-H5. Shared Batch Moves Skip Destination Leftover/Folder Preflight (`batch-files.ts:163-196`)
- **Where:** [batch-files.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/batch-files.ts#L163-L196).
- **Details:** `preflightSharedMove` never checks `assertNoLeftoverRecords`, manifest companion leftovers, or destination folder existence, committing items 1..k-1 irreversibly before failing item k.

### Medium

- **S-M1. External Finder/Explorer folder move splits any folder containing a duplicate-content file (e.g., an empty `.md` note)** ([project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L3316-L3322), [project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L3411-L3466)): `scan()` moves unique files, recreates the old folder + duplicate file from authority, and imports the moved duplicate as a new `fileId`/`docId` (breaking its comments/suggestions/live marks).
- **S-M2. `scheduleIntents()` violates `project.ts`'s queue serialization & in-memory intents strand companions across offline restarts** ([project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L1967-L1982), [manifest-intents.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/manifest-intents.ts#L11-L12)): `queueMicrotask` calls `writeManifest` outside `this.enqueue(...)`.
- **S-M3. `root-transitions.ts` drops pending agent reviews, merges swapped folder names, and is bypassed by `/api/tree?notebook=...`** ([root-transitions.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/root-transitions.ts#L18-L38), [notebooks.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/notebooks.ts#L153-L167), [route.ts](file:///Users/thinhhoang/Documents/project-libera/src/app/api/tree/route.ts#L30-L37)).
- **S-M4. Miscellaneous shared-move gaps:** Local inbound links pointing into a shared notebook are not rewritten on remote/Finder moves; `renameSharedFolder` ([shared-writes.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/collab/shared-writes.ts#L851)) omits `incomingNotes` for Python leftover checks; `displacedPath()` ([project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L1823-L1839)) hardcodes `kind: "file"` when displacing a local folder; `placeStagedMoves` ([move-journal.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/move-journal.ts#L187), [project.ts](file:///Users/thinhhoang/Documents/project-libera/electron/collab/notebooks/project.ts#L1239)) uses non-exclusive `movePath` and has an exception hole leaving `stagedWaiting` empty; `prunePdfTextCaches` deletes undelivered shared PDF caches.

---

## 6. Notebook Verification Oracle (`verifyNotebook` & `assertNotebookSound`)

### Critical

#### O-C1. `verifyNotebook`, `planNotebookRepair`, and `planNotebookCleanup` Treat Real Local Files in `Shared/_archive/` as Missing — Causing False Warnings, Cross-File Record Hijacking & Permanent Deletion
- **Where:** [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L638-L640), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1093-L1099), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1197-L1200), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L316), [repair.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/repair.ts#L409-L491), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L253-L258).
- **Root Cause:** `_archive/` in a shared notebook is strictly local-only (never in `manifestBefore.files`), and `project.ts` (`displacedPath`) + `shared-record-follow.ts` intentionally relocate displaced local files and their records into `Shared/_archive/`. Yet `integrity.ts`, `repair.ts`, and `cleanup.ts` judge `Shared/_archive/...` paths against `manifestBefore.files.has(...)` instead of disk:
  1. `verifyNotebook` falsely flags all sidecars, stars, tags, reviews, pending agent reviews, and reference attachments of `Shared/_archive/...` files as missing.
  2. `Try to fix` pairs `Shared/_archive/paper.pdf` → `Shared/paper.pdf`, **hijacking the displaced local file's private records onto a collaborator's unrelated file**.
  3. `Acknowledge` (`sharedGoneHold` checks only `view.files.has`) offers and **permanently deletes** the records of the intact `Shared/_archive/` file.

### High

#### O-H1. Exact-String `manifestBefore.files.has()` Causes False Positives & Alias-Deletion of Live Sidecars on NFD/Case Mismatches
- **Where:** [shared-manifest-view.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-manifest-view.ts#L44-L50), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L522), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L639), [cleanup.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/cleanup.ts#L242-L258).
- **Details:** Unlike local `goneHold` (which checks `physicalState` to refuse deletion through an OS alias), `sharedGoneHold` skips `physicalState`. On macOS/Windows, when local records use NFD/different casing vs manifest NFC, `verifyNotebook` emits false warnings and `Acknowledge` unlinks the **live** sidecar inode through the OS alias.

#### O-H2. Major False Negatives in `sharing` Check & `mayBeArriving`
- **Where:** [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1355-L1399), [shared-manifest-view.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-manifest-view.ts#L51), [shared-manifest-view.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/shared-manifest-view.ts#L74-L78).
- **Details:**
  1. **Zero verification of `entry.kind === "doc"`** content or size (a 0-byte or stale Markdown/LaTeX working copy passes `sharing: ok`).
  2. **Same-size blob replacement missed** (`entry.blobHash` is never checked).
  3. **Single unrelated `reconcilePending > 0`** downgrades *every* missing/differing file in the notebook to `info: sharedFileArriving` (ignored by `assertNotebookSound`).
  4. `before.folders` is never checked; disk-only companions (`_ink/*`, `_assets/*`, `.transcript`, unsupported extensions) are ignored; `stamp` omits `size` and cannot detect disk drift during the check.

#### O-H3. Shared Companion Transcripts (`<audio>.transcript`) Are Completely Invisible to `verifyNotebook` and `checkNothingLeftAt`
- **Where:** [sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/sidecars.ts#L105), [sidecars.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/sidecars.ts#L345-L371), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L260-L277), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L341-L351).
- **Details:** Corrupt, stale, or orphaned `<audio>.transcript` files are never walked by `listSidecars`, never read by `recordingDuration`, and never checked by `checkNothingLeftAt`.

#### O-H4. `assertNotebookSound` Ignores All `"info"` Findings — Masking Real Post-Move Corruption in Tests
- **Where:** [notebook-test-helpers.ts](file:///Users/thinhhoang/Documents/project-libera/scripts/editor/notebook-test-helpers.ts#L149-L156), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L696), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L725-L738), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L944-L945), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1124-L1135), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1329-L1331), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1391).
- **Details:** Real move bugs classified only as `"info"` pass `assertNotebookSound` silently: orphaned review comments (`reviewFileMissing`), broken agent undo history (`agentRunFileMissing`), left-behind Markdown images (`imageLeftBehind`/`imageUnused`), stale ink/sidecars after path reuse, misplaced ink chunks, unlisted leftover disk files in shared notebooks (`sharedFileNotListed`), and stale Global Search / index rows. Furthermore, [shared-integrity-oracle.test.ts](file:///Users/thinhhoang/Documents/project-libera/scripts/editor/shared-integrity-oracle.test.ts#L30-L76) uses a synthetic `StubHost` that never exercises real `Project`, `PdfMarksRuntime`, `fileOp`, NFD, `_archive`, or `pdfLive` flows.

### Medium

- **O-M1. Shared `.bib` tether check ignores `manifestBefore`** ([integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1210-L1213), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L431-L436)): False positive on arriving shared `.bib`, false negative on unretired deleted shared `.bib`, and neither Try to fix nor Acknowledge can fix/clear it.
- **O-M2. Additional unchecked state & false positives ([integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L464-L472), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L627), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1027-L1030), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1095), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1271-L1280)):** Starred/tagged folders in shared notebooks falsely flagged missing (`manifestBefore.folders` not checked); cross-notebook broken Markdown heading anchors silently skipped; corrupt link/citation index JSON silently passes on empty notebooks; `illustrationPath`, saved workspaces, `where-was-i`, `document-chat`, `notebookPanelExpandedPaths`, and live PDF comments unchecked; `readNotes` skips symlinks and `node_modules` even on non-linked notebooks.
- **O-M3. Read-only, route-vs-oracle, and budget loopholes ([integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L452), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L635-L647), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L882-L889), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1267), [integrity.ts](file:///Users/thinhhoang/Documents/project-libera/src/lib/storage/integrity.ts#L1275), [route.ts](file:///Users/thinhhoang/Documents/project-libera/src/app/api/notebooks/verify/route.ts#L20)):** `verifyNotebook` mutates in-memory `readCache` via `forgetNotebookLinkReads`; HTTP `/api/notebooks/verify` runs `settleSharedRecordsBeforeCheck` while `assertNotebookSound` does not; nested `_archive` disagrees with `reference-citations.ts`; `listSidecars`, `orphaned-sidecars` walk, and `readNotes` non-Markdown entries bypass `IntegrityBudget`.

---

## 7. Prioritized Remediation Roadmap

### P0 — Fix Data Loss, Deadlocks, Infinite Loops & Oracle-Caused Deletion First
1. **Normalize NFC everywhere paths are compared** (`foldedFileName` / `.normalize("NFC").toLowerCase()`): fix `unreferencedMarkdownAssets`, `rawEmbedsInOtherNotebooks`, `cleanupMarkdownImageAssets` (`E-C1`), `isCaseOnlyRename`, `withPathLocks`, `preflightLocalMove`, `migration.ts:buildPlan` (`L-H4`), `PdfMarksRuntime.resolve` (`S-H2`), `shared-owner.ts` & `ink.ts` (`S-H3`), `shared-record-follow.ts` `judge`/`orderTransitions` (`S-H4`), and `cleanup.ts` `sharedGoneHold` alias protection (`O-H1`).
2. **Fix `Shared/_archive/` authority in `integrity.ts`, `repair.ts`, and `cleanup.ts` (`O-C1`)**: check `isSharedNotebookPath(libraryPath)` (not `isSharedNotebookPath(notebook)`!) before consulting `manifestBefore`, so `_archive/` and other-notebook attachments (`E-H5`) are judged against disk.
3. **Break the shared PDF orphan / `pdfLive` 409 deadlock (`S-C1`)**: retire/remove old local PDF sidecars on confirmed move/delete (or set them aside under `orphaned-sidecars/`), stop `PdfMarksRuntime.close` from writing un-clearable live-path orphans on deliberate delete, and align `hostOwnsSideFile` with `assertNoLeftoverRecords`.
4. **Fix M23 rollback bypass (`S-C2`)**: either wait for/respect `transitionsDeferred` in `followCommittedChange` (do not delete local records via `uncovered` before server ACK) or reconcile local records via a reversible set-aside until ACK.
5. **Validate linked-folder `.libera-folder.json` marker against external replacement (`E-C2`)**: include marker `stat`/identity check in `getLinkedFolders()` cache validation (or re-verify on tree/verify/repair/cleanup entry).
6. **Fix `findAvailableCopyPath` `records.blocker` check (`L-C1`)**, pass `{ replaceEmpty: true }` in `moveFolderWithRecords`, `migration.ts`, and `followNotebookRootRename` (`L-C2`), and replace `holdsFiles` + `rm -rf` in `moveWithoutReplacing` with bottom-up `rmdir` + atomic `EXDEV` staging (`L-C3`).
7. **Fix UI data-loss races**: retarget `this.inFlight` in `InkWriter.retarget()` (`U-C1`), register `useSegmentDraft` with `pendingSaves` (`U-C2`), stamp `localFileIdentity` in `getFileNode` (`U-C3`), guard shared sources in `NotebookMigrationDialog` (`U-C4`), and include preset paths in `unsavedTabsUnder` (`U-C5`).

### P1 — Lock Discipline, Link Rewriter Parity, External Upkeep & Oracle Strengthening
8. **Lock & fence hardening**: add `withPathLocks` to folder ops, `deleteFile`, `writeInk`, and `writeDefinitions`; add an mtime grace period in `migration.ts:exclusively`; make `migration-fence.ts` case-folded; serialize upkeep/repair/cleanup with a per-notebook mutex instead of a refcount (`L-C4`, `E-H4`).
9. **Fix external-move upkeep & repair**: handle `EXDEV` in `reconcileInkFolders` (`E-C3`); support case/normalization aliases in `reconcilePdfSidecars`, `reconcileInkFolders`, `aliasRename`, and `renameCaseAlias` (`E-H1`, `E-H2`); guard corrupt sidecars/set-aside records as `unread`/`unsettled` (`E-H3`); clear `missingSince` in `ink.ts` (`E-H6`); fix `setAside` `ENAMETOOLONG` (`E-H8`) and `scheduleReferenceReattach` (`E-H9`).
10. **Fix link rewriting**: stop trusting lagging `notebook-links.json` for `/api/files/raw/` images, folder charts, `<a href>`, and live CRDT notes (`R-C1`); handle shared `_archive/` (`R-C2`) and blob-stored shared notes (`R-H1`); call `followMovedLinks` in `renameNotebook` (`R-H2`); fix LaTeX `BIBINPUTS`/`openin_any=p`/`subfiles`/comma/space bugs (`R-H3`–`R-H5`), chart YAML parsing (`R-H6`), and `destinationRange` code spans (`R-H7`).
11. **Fix `.bib` tether cold-start delivery (`L-H2`), post-takedown `.transcript` companions (`L-H3`), `destination-records.ts` gaps (`L-H5`), and `migration.ts` finalizing/staging/history bugs (`L-H6`)**.
12. **Fix renderer state & cross-window sync**: broadcast regular moves & link rewrites across windows (`U-H1`), fix `pendingSaves.moveUnsavedMany` ordering & `mounted` leak (`U-H2`), fix `MarkdownReviewProvider` unmount flush & `REVIEWS_MOVED_EVENT` (`U-H3`), flush/refresh `agentReviewStore` (`U-H4`), fix batch `payload === null` & `applyLinkRewritesToTabs` (`U-H5`, `U-H6`), and fix saved-workspace & split-pane retargeting (`U-H7`–`U-H10`).
13. **Harden the Verification Oracle & test harness (`O-H2`–`O-H4`)**: verify shared `doc` content/size, blob hashes, manifest folders, and `<audio>.transcript` companions; elevate `reviewFileMissing`, `imageLeftBehind`, and `sharedFileNotListed` (or assert explicit allowlists on `"info"` findings in `assertNotebookSound`); add real end-to-end `Project` + `PdfMarksRuntime` + `verifyNotebook` tests covering `pdfLive`, `_archive`, NFD/NFC, and case-only renames.
