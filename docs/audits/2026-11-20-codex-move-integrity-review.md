Static review of `main` at `e996943`. I read the integrity and migration specs first, left the working tree unchanged, and did not run the app or tests.  
**Try to fix violates the name-only rule.** It can prefer a differently named file, reject the sole same-name candidate, or bypass same-name ambiguity.  
**Direct moves can overwrite work.** Destination checks precede replacing filesystem operations, and several record writes have separate race windows.  
**Acknowledge can delete newer work at a reviewed path.** Its token covers action addresses, while several actions lack an execution-time check that the data is still stale.  
**Migration can strand or misreport a move.** Staging rollback, citation rewrites, and finalization recovery have different assumptions about what is on disk.  
**Check Notebook can report a clean or actionable result for an incomplete view.** Archive scope, unreadable records, and filesystem comparison rules differ across the checker, repair, cleanup, and upkeep.  
**Open tabs need their own integrity checks.** A successful disk operation can leave duplicate tabs, stale save baselines, or drafts and pending writes at the wrong path.  
The findings distinguish code-confirmed behavior from likely or platform-dependent outcomes. The planned link refactor has its own section.

### Findings

Test filenames below are under `scripts/editor/` unless marked **new**. Fault-injection and platform-specific scenarios are proposed tests.

#### Direct file and folder operations

**F1 — A destination file can be overwritten after the availability check**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `in-app-move`  
- **Where** `src/lib/storage/files.ts:229`, `src/lib/storage/files.ts:300`, `src/lib/storage/files.ts:731`, `src/lib/storage/files.ts:761`, `src/lib/storage/fs-utils.ts:55`.
- **Scenario** Another window or sync client creates the destination after preflight. On filesystems where `rename` replaces an existing file, Move, Rename, or Archive overwrites the arrival, then starts relocating the source records.
- **Fix direction** Publish without replacement at the filesystem operation. Use a distinct, identity-checked operation for spelling-only renames.
- **Test** Create the destination between preflight and publish. Assert that both files and their records survive. `notebook-move-integrity.test.ts`.

**F2 — A stale local action can move or delete a replacement source**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `in-app-move`  
- **Where** `src/app/api/files/route.ts:110`, `src/app/api/files/route.ts:124`, `src/lib/storage/files.ts:300`, `src/lib/storage/files.ts:870`.
- **Scenario** Open Move or Delete on `A/paper.pdf`. Explorer moves it away and a sync client puts another PDF at that path. The local operation acts on the replacement. The local route delegates by path, while the shared branch passes an expected file ID.
- **Fix direction** Bind local actions to the selected source and revalidate immediately before the destructive step.
- **Test** Replace the source after the dialog opens for local move, archive, and delete. `notebook-move-integrity.test.ts`.

**F3 — A sidecar written during a direct move can be destroyed**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `sidecars`  
- **Where** `src/lib/storage/files.ts:262`, `src/lib/storage/sidecars.ts:114`, `src/lib/storage/sidecars.ts:173`, `src/lib/storage/fs-utils.ts:89`, `src/lib/storage/markdown-assets.ts:351`.
- **Scenario** After the destination-record check, a PDF annotation, ink folder, transcript, definition, or Python sidecar arrives at the destination. The direct file move uses replacement helpers and can erase it.
- **Fix direction** Use exclusive publication for user records and conditional rollback for records already transferred.
- **Test** Write a destination annotation or Python file after preflight and before transfer. `notebook-move-integrity.test.ts`.

**F4 — A late bookkeeping error leaves a completed move looking like a failed one**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `in-app-move`  
- **Where** `src/lib/storage/files.ts:269`, `src/lib/storage/files.ts:288`, `src/components/libera/use-libera-workspace.ts:3935`.
- **Scenario** The document and sidecars move, then review rekeying, workspace metadata, history, or the final read fails. The route returns an error after the old path is gone. The renderer refreshes the tree without retargeting the old tab, and a retry at the original path cannot finish the missing steps.
- **Fix direction** Return the committed path mapping and per-store failures, with a way to complete the failed steps.
- **Test** Fail each post-publish step and check the response, tab mapping, and remaining records. `notebook-move-integrity.test.ts`.

**F5 — Archive commits the file and pending review before moving sidecars**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `in-app-move`  
- **Where** `src/lib/storage/files.ts:300`, `src/lib/storage/files.ts:771`.
- **Scenario** Archive a recording whose destination sidecar directory is blocked by a file. The raw `rename` and pending-review wrapper run first. A subsequent sidecar move fails, leaving the recording archived while its record remains at the original path. Ordinary Move has a document rollback for this failure.
- **Fix direction** Route Archive through the same preflight and commit path as Move.
- **Test** Block the archive transcript parent and assert that archive either completes or leaves the source intact. `notebook-operations-integrity.test.ts`.

**F6 — Workspace metadata mutations can silently erase each other**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `records`  
- **Where** `src/lib/storage/workspace-metadata.ts:192`, `src/lib/storage/workspace-metadata.ts:271`, `src/lib/storage/workspace-metadata.ts:284`, `src/lib/storage/workspace-metadata.ts:313`, `src/lib/storage/workspace-metadata.ts:344`.
- **Scenario** Move a tagged file while another window stars a file or saves expanded folders. Both operations read the same workspace JSON, then write whole snapshots. The last writer can undo the move’s rekey or erase the unrelated edit.
- **Fix direction** Serialize read-modify-write across writers, or use revision-checked updates that retry against fresh state.
- **Test** Interleave two mutations after their reads and check that both survive. `notebook-move-integrity.test.ts`.

**F7 — Changing a file type can carry ink the new editor cannot use**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `sidecars`  
- **Where** `src/lib/storage/sidecars.ts:97`, `src/lib/storage/sidecars.ts:125`, `src/lib/storage/ink.ts:65`, `src/lib/storage/integrity.ts:458`.
- **Scenario** Rename an inked PDF to a supported image or Markdown extension. Both types support the ink *kind*, so the type-change guard permits the move, but the new editor rejects the old page chunks. The verifier can then offer to remove that ink.
- **Fix direction** Check compatibility of the saved chunks when the file type changes.
- **Test** Cover PDF page ink, image ink, and Markdown block ink across supported extension changes. `notebook-move-integrity.test.ts`.

**F8 — Destination checks miss older annotation layouts**  
**Severity** P1 · **Confidence** likely · **Area** `sidecars`  
- **Where** `src/lib/storage/files.ts:267`, `src/lib/storage/files.ts:475`, `src/lib/storage/sidecars.ts:235`, `src/lib/storage/annotations.ts:400`.
- **Scenario** A vacant destination name has legacy flat annotations and no by-path sidecar. The move checks the by-path slot and proceeds. When the arriving file opens, the legacy migrator can interpret it as the sole owner and attach the older work.
- **Fix direction** Inspect legacy destination slots with the same ambiguity rules the owner uses.
- **Test** Rename an unannotated PDF onto a vacant basename with only a legacy annotation file. `notebook-move-integrity.test.ts`.

**F9 — Copy reserves the document name but inherits or replaces destination records**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `in-app-move`  
- **Where** `src/lib/storage/files.ts:820`, `src/lib/storage/files.ts:849`, `src/lib/storage/files.ts:864`, `src/lib/storage/files.ts:1082`.
- **Scenario** Copy to a vacant name with stale annotations, Python, ink, tags, an attachment, or a review. Name selection considers the document only. Some existing records become the copy’s records, while copy helpers replace other records with the source’s.
- **Fix direction** Allocate a name using the destination-record guard and publish copied records exclusively.
- **Test** Seed a vacant copy name with a review, a tag, and a sidecar. Assert that the copy gets a different name. `notebook-operations-integrity.test.ts`.

**F10 — Copy accepts a new file type but writes source-type records**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `in-app-move`  
- **Where** `src/lib/storage/files.ts:800`, `src/lib/storage/files.ts:837`, `src/lib/storage/files.ts:849`, `src/lib/storage/files.ts:1082`.
- **Scenario** Copy an annotated `paper.pdf` as `paper.png`, or a Markdown note as `.txt`. The destination extension passes validation, then the source’s type drives byte and sidecar copying. The result can open in the wrong viewer and leave incompatible records.
- **Fix direction** Require a compatible type for Copy and use explicit conversion for type changes that need it.
- **Test** Copy a PDF and a note using supported but incompatible destination extensions. `notebook-operations-integrity.test.ts`.

**F11 — Cross-notebook copy leaves Markdown citations in the destination namespace**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `in-app-move`  
- **Where** `src/lib/storage/files.ts:394`, `src/lib/storage/files.ts:837`, `src/lib/storage/files.ts:864`.
- **Scenario** Copy a note citing `@smith` to a notebook where that key is absent or belongs to another paper. Copy rewrites images and copies reviews, but never runs the cited-reference copy and key mapping. The copied citation can disappear or resolve to the wrong entry.
- **Fix direction** Apply the cited-reference copy and key mapping to cross-notebook copies, including copies of the review snapshot.
- **Test** Copy a note with a missing key and a colliding key into a second notebook. `notebook-operations-integrity.test.ts`.

**F12 — A damaged review index can make name allocation loop indefinitely**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `records`  
- **Where** `src/lib/storage/files.ts:486`, `src/lib/storage/files.ts:522`, `src/lib/storage/files.ts:651`, `src/lib/storage/files.ts:761`, `src/lib/storage/destination-records.ts:52`, `src/lib/storage/migration.ts:687`.
- **Scenario** With malformed review-index JSON, the guard conservatively reports review records for every candidate name. Archive File, Archive Folder, and migration suffix allocation keep looking for a name that can never pass.
- **Fix direction** Surface store-wide unreadability as a blocker before entering name allocation.
- **Test** Corrupt the review index and require a bounded error for all three operations. `notebook-move-integrity.test.ts`.

**F13 — Folder rollback can move unrelated destination records back to the source**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `folder-ops`  
- **Where** `src/lib/storage/files.ts:1007`, `src/lib/storage/files.ts:1027`, `src/lib/storage/sidecars.ts:215`, `src/lib/storage/fs-utils.ts:115`.
- **Scenario** A destination sidecar subtree arrives after preflight. A folder sidecar step fails on it, then rollback reverses the entire sidecar prefix, including kinds that never moved. It can take independently arrived destination records back to the source. Rollback errors are suppressed.
- **Fix direction** Track individual completed transfers and reverse only those, reporting any rollback that cannot finish.
- **Test** Insert a destination subtree halfway through the sidecar loop and fail a later kind. `notebook-operations-integrity.test.ts`.

**F14 — Folder moves omit destination Python code from preflight**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `folder-ops`  
- **Where** `src/lib/storage/files.ts:514`, `src/lib/storage/files.ts:1034`, `src/lib/storage/markdown-assets.ts:351`.
- **Scenario** Rename `Drafts` to vacant `Project`, where `_assets` still contains Python for the old `Project/a.md`. The folder guard does not check that code. Source code can overwrite it, or the incoming note can inherit it when it has no code.
- **Fix direction** Include Python ownership in the folder destination check and move code exclusively.
- **Test** Exercise folder rename and archive with stale destination code, both with and without source code. `notebook-operations-integrity.test.ts`.

**F15 — A partial folder walk strands Python but lets the rename succeed**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `folder-ops`  
- **Where** `src/lib/storage/markdown-assets.ts:397`, `src/lib/storage/files.ts:599`, `src/lib/storage/files.ts:658`, `src/lib/storage/files.ts:1034`.
- **Scenario** A child directory can be renamed with its parent but cannot be listed during the note scan. The scan returns the notes it saw. The folder moves, while code for unseen notes stays under the old asset paths.
- **Fix direction** Surface incomplete scans before moving, or enumerate associated code independently of the note walk.
- **Test** Inject an unreadable child containing a note with code and rename its parent. `notebook-operations-integrity.test.ts`.

**F16 — Folder deletion skips asset cleanup for notes missed by its scan**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `folder-ops`  
- **Where** `src/lib/storage/files.ts:681`, `src/lib/storage/files.ts:685`, `src/lib/storage/markdown-assets.ts:190`.
- **Scenario** A large notebook hits the 20,000-entry scan cap, or one unreadable note stops a directory scan. Delete Folder uses only the returned documents and ignores `complete`. It can delete the folder while leaving undiscovered Python and image assets behind.
- **Fix direction** Establish a complete inventory for the deletion scope or report which cleanup could not complete.
- **Test** Fail a read before another note in the deleted subtree and inspect its code and images afterward. `notebook-operations-integrity.test.ts`.

**F17 — Delete can return success with pending agent changes at the deleted path**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `records`  
- **Where** `src/lib/storage/files.ts:685`, `src/lib/storage/files.ts:880`, `src/lib/agent/review-store.ts:119`, `src/lib/agent/review-store.ts:178`.
- **Scenario** Delete a reviewed note or its folder. The operation deletes Markdown review comments but does not explicitly settle pending agent changes. The pending record remains until a later read. If the name is reused before then, the old baseline can be compared with the replacement note.
- **Fix direction** Handle pending agent reviews explicitly as part of confirmed deletion.
- **Test** Delete, recreate the same path, then list pending reviews. `notebook-operations-integrity.test.ts`.

**F18 — Pending agent review transfer checks destination ownership outside its locks**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `records`  
- **Where** `src/lib/storage/files.ts:488`, `src/lib/agent/review-store.ts:281`, `src/lib/agent/review-store.ts:306`, `src/lib/storage/repair.ts:573`.
- **Scenario** A pending review is created at the destination after preflight. `withMovedReview` and the folder variant write the source entry over it while holding the locks, without checking that the destination is still free. If the document move then fails, rollback can remove the overwritten slot.
- **Fix direction** Check destination ownership inside the same locks that cover publication and rollback.
- **Test** Add a destination review between the guard and lock acquisition for direct move and repair. `notebook-move-integrity.test.ts`, `notebook-repair.test.ts`.

**F19 — A late review collision is discarded from the direct move result**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `records`  
- **Where** `src/lib/storage/files.ts:288`, `src/lib/storage/files.ts:783`, `src/lib/storage/markdown-reviews.ts:139`.
- **Scenario** A destination review gains comments between preflight and rekeying. `moveReviewPaths` correctly holds the source review and returns the old key. Direct move and archive ignore that return value and report success.
- **Fix direction** Surface the held review in the result and preserve the path mapping for recovery.
- **Test** Add a destination comment during the move and assert that the result identifies the old review. `notebook-move-integrity.test.ts`.

**F20 — A review can be removed even when the source had no review to replace it**  
**Severity** P3 · **Confidence** confirmed by reading the code · **Area** `records`  
- **Where** `src/lib/storage/markdown-reviews.ts:143`, `src/lib/storage/markdown-reviews.ts:154`, `src/lib/storage/repair.ts:615`.
- **Scenario** Fix a star-only or attachment-only pair. The destination has an automatically created empty review. `moveReviewPaths` can delete the destination review even though there is no source review, because replacement is driven by the path map.
- **Fix direction** Replace a destination review only when an actual source review is ready to take its place.
- **Test** Repair a star-only move and assert that the open destination review retains its ID. `notebook-repair.test.ts`.

#### Renderer and drag and drop

**F21 — A save can recreate the old name after a move or overwrite a new arrival**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/lib/storage/files.ts:185`, `src/lib/storage/files.ts:197`, `electron/collab/notebooks/fs-ops.ts:270`.
- **Scenario** Save validates the text version, then waits to publish its temporary file. Move the file during that interval, or put another file at the name. The final unguarded rename publishes the save at the old path.
- **Fix direction** Coordinate local saves and moves and validate the expected source at publication under that coordination.
- **Test** Pause a save after version validation, move the file, then resume it. `notebook-move-integrity.test.ts`.

**F22 — A second Save can replace an unrelated file at the old path**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/components/libera/use-libera-workspace.ts:3152`, `src/components/libera/use-libera-workspace.ts:3175`.
- **Scenario** Move a dirty note externally and put different text at its old path. The first Save conflicts. The handler automatically adopts the replacement’s content as the saved baseline for the old draft. Pressing Save again overwrites the replacement.
- **Fix direction** Preserve the original baseline and require an explicit conflict decision before writing against the replacement.
- **Test** Replace a dirty tab’s path and exercise two ordinary Save clicks. **New** `notebook-move-renderer.test.ts`.

**F23 — Migration’s Save all bypasses the normal save conflict check**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/components/libera/use-libera-workspace.ts:3154`, `src/components/libera/use-libera-workspace.ts:4029`, `src/app/api/files/route.ts:144`.
- **Scenario** Edit a note locally, then change it on disk. Migration’s Save all sends the local draft without `baseVersion` and can overwrite the external edit before the migration starts. An already-running normal save can also overlap this path.
- **Fix direction** Use the same guarded save operation as ordinary Save and await an existing save for that document.
- **Test** Edit a dirty migration candidate externally before Save all. **New** `notebook-move-renderer.test.ts`.

**F24 — Repair can create two open tabs with the same ID**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/components/libera/use-libera-workspace.ts:3816`, `src/components/libera/use-libera-workspace.ts:4188`, `src/components/libera/pending-saves.ts:290`.
- **Scenario** Open `Old/a.md`, move it externally, then open `New/a.md` before repairing a star or sidecar. Repair maps the old tab to the new ID while retaining the existing tab. Drafts share a path-keyed slot and pending-save entries with the same key can be overwritten.
- **Fix direction** Resolve dual-open destinations before retargeting and preserve both drafts when they differ.
- **Test** Give both tabs different drafts and pending ink, then apply repair. **New** `notebook-move-renderer.test.ts`.

**F25 — Retargeting uses a captured tab list for drafts and a current list for tabs**  
**Severity** P1 · **Confidence** likely · **Area** `renderer-state`  
- **Where** `src/components/libera/use-libera-workspace.ts:3816`, `src/components/libera/use-libera-workspace.ts:3832`, `src/components/libera/use-libera-workspace.ts:4144`, `src/components/libera/use-libera-workspace.ts:4363`.
- **Scenario** Open or edit a tab while the move request or destination reload is pending. The draft transfer iterates the earlier `tabs` closure, while the state update renames the current tabs. A new tab can change IDs without moving its latest draft entry.
- **Fix direction** Use one current tab snapshot for tab, draft, and pending-save remapping.
- **Test** Delay the response, open and edit the source during the wait, then verify the latest text after retargeting. **New** `notebook-move-renderer.test.ts`.

**F26 — Retargeting after repair can keep an obsolete saved baseline**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/components/libera/use-libera-workspace.ts:1638`, `src/components/libera/use-libera-workspace.ts:3844`, `src/components/libera/use-libera-workspace.ts:4196`.
- **Scenario** Move and edit a note outside the app, then repair its records. The renderer fetches the destination text, but `movedTabText` returns early when there is no rewrite map. A clean tab can continue showing old text, and a dirty tab retains a stale baseline even though the new contents were fetched.
- **Fix direction** Reconcile fetched text on every retarget. Reload clean tabs and preserve dirty edits with a conflict state when needed.
- **Test** Repair an externally moved and edited note with one clean and one dirty scenario. **New** `notebook-move-renderer.test.ts`.

**F27 — Archive can close a tab that became dirty during the request**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/components/libera/use-libera-workspace.ts:1396`, `src/components/libera/use-libera-workspace.ts:4301`, `src/components/libera/use-libera-workspace.ts:4528`.
- **Scenario** Start archiving a clean file or folder and type before the request returns. The completion path removes the tab and forgets its draft. A failed text save in `error` state can also pass the initial `tabUnsaved` gate.
- **Fix direction** Retarget open tabs through archive and preserve drafts made while the operation is pending.
- **Test** Type during a delayed archive and archive a tab with a failed save. **New** `notebook-move-renderer.test.ts`.

**F28 — Delete confirmation leaves unsaved edits implicit**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/components/libera/use-libera-workspace.ts:4275`, `src/components/libera/use-libera-workspace.ts:4494`, `src/components/libera/workspace-confirm-dialog.tsx:29`, `messages/en.json:7846`.
- **Scenario** Delete a file or folder with a dirty tab. The generic confirmation names the disk item, then success forgets the text draft. It gives no indication that unsaved editor work will also be lost.
- **Fix direction** Include dirty descendants and pending edits in the confirmation and provide a way to preserve draft text.
- **Test** Delete a folder containing a dirty note and check the confirmation and resulting draft handling. **New** `notebook-move-renderer.test.ts`.

**F29 — Drop can target the wrong folder when names have significant spaces**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `drag-drop-ui`  
- **Where** `src/components/libera/notebook-panel.tsx:689`, `src/components/libera/use-libera-workspace.ts:3951`, `src/components/libera/use-libera-workspace.ts:3961`, `src/lib/storage/paths.ts:54`.
- **Scenario** Drag to a folder or notebook whose valid name starts with a space. The destination string is trimmed, and cross-notebook routing trims every component. If a sibling with the stripped name exists, the operation can target that sibling.
- **Fix direction** Pass tree node paths unchanged and validate typed input separately.
- **Test** Drop into ` Drafts` and `Drafts`, within a notebook and across notebooks. **New** `notebook-move-renderer.test.ts`.

**F30 — An older drop can clear a newer drag**  
**Severity** P3 · **Confidence** likely · **Area** `drag-drop-ui`  
- **Where** `src/components/libera/notebook-panel.tsx:187`, `src/components/libera/notebook-panel.tsx:689`, `src/components/libera/notebook-panel.tsx:1492`.
- **Scenario** Drop file A during a slow move, then begin dragging file B. The first request’s completion clears the shared drag state, so B’s drop may be ignored. The notebook header handler also accepts the drop without the helper’s propagation guard.
- **Fix direction** Consume drag state synchronously and scope completion to the drag that initiated it.
- **Test** Start a second drag while the first drop request is held open. **New** `notebook-move-renderer.test.ts`.

**F31 — Local external changes refresh the tree without following the editor**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/components/libera/use-libera-workspace.ts:623`, `src/components/libera/use-libera-workspace.ts:685`, `src/components/libera/use-libera-workspace.ts:3852`, `src/components/libera/use-libera-workspace.ts:4188`.
- **Scenario** A sync client moves a file while the window remains focused. Local files have no move event. A later focus refresh updates the rail but gives the tab no move mapping. A note with only an unsaved draft may have no repair-eligible records, so Try to fix cannot retarget it either.
- **Fix direction** Mark missing tab paths explicitly and let the user reconnect the tab or save a new file.
- **Test** Move a record-free dirty note outside the app and trigger focus refresh. **New** `notebook-move-renderer.test.ts`.

**F32 — Repair’s renderer update is local to one window and has no replay**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
- **Where** `src/components/libera/notebook-integrity-dialog.tsx:175`, `src/components/libera/use-libera-workspace.ts:4215`, `src/components/libera/use-libera-workspace.ts:4225`.
- **Scenario** Another window has the old tab open, or the initiating window loses the response after the server commits. The path mapping travels only through a `window` event. A second plan may be empty, leaving the old tabs, drafts, or saved workspace paths unchanged.
- **Fix direction** Deliver committed repair mappings across windows and make missed mappings replayable.
- **Test** Repair in one window with a dirty source tab in another, then simulate a lost response. **New** `notebook-move-renderer.test.ts`.

#### External moves, tree upkeep, and linked folders

**F33 — Case-only ancestor renames look present to sidecar upkeep**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/sidecars.ts:307`, `src/lib/storage/pdf-sidecars.ts:246`, `src/lib/storage/ink.ts:535`, `src/lib/storage/library-links.ts:82`.
- **Scenario** Rename `Folder` to `folder` on a case-insensitive filesystem while leaving `Paper.pdf` unchanged. The verifier’s generic lookup treats the old ancestor spelling as absent. The sidecar orphan check reads the old parent through its alias and checks only the basename, while upkeep uses `stat` on the old spelling. The sidecar-only move can disappear from Check Notebook even though repair could rekey it.
- **Fix direction** Share an exact-segment path lookup for record ownership and handle aliases explicitly during transfer.
- **Test** Exercise a case-only ancestor rename and an NFC/NFD ancestor rename on an aliasing filesystem. `notebook-integrity-coverage.test.ts`.

**F34 — Automatic reattachment can overwrite a sidecar saved meanwhile**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/pdf-sidecars.ts:322`, `src/lib/storage/pdf-sidecars.ts:356`, `src/lib/storage/ink.ts:571`, `src/lib/storage/ink.ts:605`, `src/lib/storage/fs-utils.ts:95`.
- **Scenario** Open the moved PDF and add an annotation after upkeep checks that the slot is free. Live-sidecar reattachment removes the destination before moving, and set-aside JSON reattachment publishes with a replacing rename. The new annotation can disappear. Ink has the same check-to-move gap.
- **Fix direction** Use exclusive publication for reattachment and retain the source until the destination has been verified.
- **Test** Insert an annotation or ink save after upkeep checks the destination. **New** `notebook-external-move-upkeep.test.ts`.

**F35 — Different pages in one ink folder can belong to different file versions**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/ink.ts:525`, `src/lib/storage/ink.ts:560`, `src/lib/storage/ink.ts:587`, `src/lib/storage/integrity.ts:478`.
- **Scenario** Draw on one PDF, replace it, then draw another page before moving the replacement. `folderSource` picks the first recorded source and uses it to transfer or set aside the entire folder. A PDF matching that first record can receive ink from the other version as well.
- **Fix direction** Refuse automatic whole-folder reattachment when recorded page sources disagree and report the conflict.
- **Test** Seed two ink pages with different source identities and put both candidate PDFs on disk. **New** `notebook-external-move-upkeep.test.ts`.

**F36 — An interrupted ink set-aside can become undiscoverable**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/ink.ts:584`, `src/lib/storage/ink.ts:596`, `src/lib/storage/repair.ts:201`, `src/lib/storage/integrity.ts:557`.
- **Scenario** The ink folder moves into the set-aside directory, then the process exits before writing `record.json`. Tree upkeep and repair cannot identify its original path. The verifier can subsequently include the unclassified ink files in generic set-aside cleanup.
- **Fix direction** Record the origin before moving the folder and recognize incomplete set-aside operations during recovery.
- **Test** Fail the origin-record write after the ink folder moves, then run verification and cleanup planning. `notebook-cleanup.test.ts`.

**F37 — Set-aside data can expire while its file remains recoverable**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/pdf-sidecars.ts:59`, `src/lib/storage/pdf-sidecars.ts:345`, `src/lib/storage/ink.ts:596`.
- **Scenario** A PDF or inked file returns after a long offline period, but its destination slot has work of its own or matching is ambiguous. Once the set-aside age exceeds 90 days, a normal tree load deletes the saved work without the Acknowledge preview.
- **Fix direction** Make the upkeep expiry rule and its exceptions explicit, and preserve unresolved user-work conflicts for an informed decision.
- **Test** Age an orphan with a returned but occupied destination and run upkeep. **New** `notebook-external-move-upkeep.test.ts`.

**F38 — Identity-based upkeep can select a copy from an incomplete tree**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/tree.ts:314`, `src/lib/storage/tree.ts:368`, `src/lib/storage/tree.ts:410`, `src/lib/storage/pdf-sidecars.ts:379`.
- **Scenario** The actual moved PDF is in a hidden archive, beyond the linked-folder tree cap, or in a subtree still syncing. An identical copy is visible. Upkeep passes only the visible candidates to the matcher, which gives the copy the old sidecar as if it were unique.
- **Fix direction** Build upkeep’s candidate set independently of rail visibility and defer reattachment when the relevant scan is incomplete.
- **Test** Put identical PDFs inside and outside a hidden archive, then repeat with a truncated linked tree. **New** `notebook-external-move-upkeep.test.ts`.

**F39 — Upkeep treats distinct case-sensitive sidecar slots as occupied aliases**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `sidecars`  
- **Where** `src/lib/storage/pdf-sidecars.ts:287`, `src/lib/storage/pdf-sidecars.ts:379`, `src/lib/storage/ink.ts:563`, `src/lib/storage/integrity.ts:527`.
- **Scenario** On a case-sensitive volume, `Foo.pdf` has annotations and `foo.pdf` is the unique moved file whose bytes match another orphan. The lowercased occupancy set hides the free `foo.pdf` slot.
- **Fix direction** Compare occupancy using actual filesystem slot semantics. Keep repair’s name equivalence independent of slot equality.
- **Test** Create both spellings on a case-sensitive fixture and test automatic reattachment. **New** `notebook-external-move-upkeep.test.ts`.

**F40 — A same-path replacement is adopted by records that have no version check**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/pdf-sidecars.ts:284`, `src/lib/storage/annotations.ts:364`, `src/lib/storage/integrity.ts:481`, `src/lib/storage/integrity.ts:748`.
- **Scenario** Replace an image or note at the same name. The image annotation inspector has no recorded source identity, and stars, tags, comments, and attachments are checked for path existence. The replacement can display old work with no finding. The PDF legacy backfill can also record the currently present PDF as the source of identity-less older annotations.
- **Fix direction** When the app observes replacement, distinguish that event from an ordinary edit before applying path-only records. Treat legacy annotation ownership as unknown when it cannot be established.
- **Test** Replace an image with annotations and a PDF with identity-less annotations at their existing paths. `notebook-integrity-coverage.test.ts`.

**F41 — Local cache pruning can race a returning recording or in-flight move**  
**Severity** P3 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/tree.ts:368`, `src/lib/storage/transcripts.ts:365`, `src/lib/storage/transcripts.ts:380`.
- **Scenario** The source audio returns after prune observes `ENOENT` but before it removes the waveform. The waveform is lost and must rebuild. Conversely, a directory replacing the audio path passes the existence test and leaves the waveform behind. Transcripts are retained by this pruner.
- **Fix direction** Require the source to be a file and coordinate cache deletion with source changes.
- **Test** Recreate the recording between the failed `stat` and deletion, and exercise a directory at the old path. **New** `notebook-external-move-upkeep.test.ts`.

**F42 — A directory that races away can abort the entire tree refresh**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `src/lib/storage/tree.ts:248`, `src/lib/storage/tree.ts:273`, `src/lib/storage/tree.ts:291`, `src/lib/storage/tree.ts:398`, `src/components/libera/use-libera-workspace.ts:700`.
- **Scenario** Explorer or OneDrive removes a child between `readdir` and `stat`, or a linked subtree becomes unreadable. The main walk can throw rather than isolate the child. The focus-refresh handler suppresses the error, leaving the old rail visible.
- **Fix direction** Isolate raced absences and unreadable subtrees, and carry completeness into the refresh result.
- **Test** Remove a listed child immediately before its `stat` and verify that other notebooks still refresh. **New** `notebook-external-move-upkeep.test.ts`.

**F43 — Linked-folder state can be inherited by a replacement directory**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `electron/directory-mode.cjs:36`, `electron/directory-mode.cjs:197`, `src/lib/storage/directory-mode.ts:133`, `src/lib/storage/paths.ts:148`.
- **Scenario** Rename the linked directory externally and create another directory at its old local location. A saved local location is accepted without the marker check used for unresolved foreign locations. On an uncached writable read the replacement can be stamped with the former ID, and the link continues carrying old name-keyed records.
- **Fix direction** Verify the existing marker for known local links before adopting or stamping a replacement path.
- **Test** Replace a linked root with an unmarked directory containing a same-named note. **New** `notebook-linked-move-integrity.test.ts`.

**F44 — Relinking a moved folder can create a new notebook alias**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `external-move-tree-upkeep`  
- **Where** `electron/directory-mode.cjs:36`, `src/lib/storage/directory-mode.ts:133`, `src/lib/storage/directory-mode.ts:165`.
- **Scenario** Move a read-only linked folder without a usable marker, then open its new physical location. Matching uses the old physical path or folder ID. A new alias can be allocated, leaving the former alias’s stars, tags, comments, and sessions behind.
- **Fix direction** Provide a relink operation that explicitly updates the existing alias when automatic association is unavailable.
- **Test** Move and reconnect an unmarked read-only linked folder. **New** `notebook-linked-move-integrity.test.ts`.

**F45 — Background reference reattachment can repoint a record that changed during the scan**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `records`  
- **Where** `src/lib/storage/references.ts:449`, `src/lib/storage/references.ts:492`, `src/lib/storage/references.ts:508`, `src/lib/storage/tree.ts:454`.
- **Scenario** Reattachment scans a missing attachment. Before it acquires the library lock, the original returns or the attachment at the same path is updated. The commit checks entry ID and path, but does not recheck the missing source or compare the current attachment’s recorded size and hash with the one used to select the destination.
- **Fix direction** Revalidate the attachment and both paths when committing the reattachment.
- **Test** Return the original or update its attachment after candidate selection and before the library transaction. `notebook-integrity-coverage.test.ts`.

**F46 — Reference reattachment can declare an incomplete search unique**  
**Severity** P1 · **Confidence** likely · **Area** `records`  
- **Where** `src/lib/storage/references.ts:412`, `src/lib/storage/references.ts:465`, `src/lib/storage/references.ts:492`.
- **Scenario** One matching PDF is visible and another sits beyond the global walk cap or inside a temporarily unreadable folder. Both situations are silently skipped. The visible PDF can inherit an attachment even across notebooks, including a library whose live sync state the background pass did not consult.
- **Fix direction** Propagate candidate-scan completeness and defer repointing when uniqueness cannot be established.
- **Test** Hide the second equal candidate behind a read error or the entry cap. `notebook-integrity-coverage.test.ts`.

#### Check Notebook and indexes

**F47 — Archive coverage depends on which check is running**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/integrity.ts:257`, `src/lib/storage/integrity.ts:321`, `src/lib/storage/integrity.ts:547`, `src/lib/storage/integrity.ts:715`, `src/lib/storage/repair.ts:176`.
- **Scenario** Move a PDF, a Python-owning note, or a TeX project into `_archive` externally. Markdown reading includes archived notes, while the visible candidate list excludes the top-level archive. Sidecar return prediction and Python-owner suggestions miss archived candidates, LaTeX dependency checking omits archived sources, and Try to fix still searches them.
- **Fix direction** Set and expose one archive scope for integrity checks wherever the archived item can affect the verdict.
- **Test** Verify the same fixtures outside and inside the archive, with the rail archive hidden. `notebook-integrity-coverage.test.ts`.

**F48 — The verifier misses records its read-only inventory never enumerates**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/sidecars.ts:268`, `src/lib/storage/integrity.ts:393`, `src/lib/storage/annotations.ts:400`.
- **Scenario** Move a PDF or image externally while its saved annotations exist only in a legacy layout. The by-path inventory does not report those records. Repair uses that same inventory, and a later editor load can still discover legacy annotations.
- **Fix direction** Add read-only enumeration of legacy layouts and report ambiguous ownership without triggering upgrades.
- **Test** Verify, then plan repair on a moved file with only legacy annotations. `notebook-integrity-coverage.test.ts`.

**F49 — An unreadable file or folder can silently pass a record check**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/sidecars.ts:307`, `src/lib/storage/sidecars.ts:341`, `src/lib/storage/integrity.ts:415`, `src/lib/storage/integrity.ts:439`, `src/lib/storage/integrity.ts:748`, `src/lib/storage/integrity.ts:818`.
- **Scenario** A target’s bytes cannot be read, a linked attachment target is offline, or another library cannot be inspected. Some paths suppress missing findings appropriately but also suppress the partial status. A read failure during a same-size sidecar comparison similarly returns `null` without being counted as unverified.
- **Fix direction** Carry an unknown result into the affected check’s completeness, including unreadable cross-library inputs.
- **Test** Inject permission failures into sidecar source reads, record path probes, and reference-library reads. `notebook-integrity-coverage.test.ts`.

**F50 — Corrupt review documents can be presented as ordinary removable reviews**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/review-files.ts:193`, `src/lib/storage/review-files.ts:204`, `src/lib/storage/integrity.ts:755`, `src/lib/storage/integrity.ts:766`.
- **Scenario** A review index is readable and its document exists, but the document is truncated or corrupt. The check tests that the document exists and never validates its contents. If the note is gone, the review receives the ordinary cleanup action. Legacy reviews are similarly only announced, without checking their stored paths.
- **Fix direction** Inspect indexed documents and legacy keys read-only, and protect unreadable review work from cleanup.
- **Test** Verify a live and a missing note with a corrupt indexed document, plus a legacy-only review store. `notebook-integrity-coverage.test.ts`.

**F51 — A deleted annotation sidecar can make its deep link pass**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/annotations.ts:352`, `src/lib/storage/integrity.ts:697`.
- **Scenario** Move or delete the only annotation sidecar while its PDF remains. A note links to an annotation ID in that PDF. `savedAnnotationIds` returns `null` for an absent sidecar and for an unreadable one. The verifier reports neither a missing annotation nor a partial link check.
- **Fix direction** Distinguish confirmed absence, legacy location, and unreadable annotation storage.
- **Test** Link to a known annotation, remove its sidecar, then repeat with an unreadable sidecar. `notebook-integrity-coverage.test.ts`.

**F52 — A stale recording cache can yield the wrong link verdict**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/integrity.ts:203`, `src/lib/storage/integrity.ts:705`.
- **Scenario** Replace a 60-second recording with a 10-second one at the same path. A link to 40 seconds passes when the old transcript supplies the duration. The reverse replacement can falsely flag a valid link. The link check does not consult the source validity of the duration it uses.
- **Fix direction** Compare against a duration known to belong to the current recording, or mark the position unchecked.
- **Test** Replace an audio file with a shorter and longer one while preserving its old transcript and waveform. `notebook-integrity-coverage.test.ts`.

**F53 — Link extraction and anchor checking can disagree with rendering**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/markdown-link-occurrences.ts:46`, `src/lib/markdown-image-sources.ts:57`, `src/lib/storage/integrity.ts:652`.
- **Scenario** A Markdown reference label is defined twice. Link extraction uses the last definition, while CommonMark reference resolution uses the first. A stale duplicate can hide a broken link or produce a spurious one. For HTML anchors, a string in a code example can satisfy the check, while a valid single-quoted `id` can fail it.
- **Fix direction** Align reference definition precedence and parse actual HTML anchor attributes.
- **Test** Move the first definition’s target, and cover real and fenced HTML anchors with both quote styles. `notebook-integrity-coverage.test.ts`.

**F54 — Path probes accept directories and dangling links as image or TeX targets**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/integrity.ts:219`, `src/lib/storage/integrity.ts:633`, `src/lib/storage/integrity.ts:724`.
- **Scenario** Move an image or included TeX file away and leave a directory or dangling symlink at the old name. `lstat` says present, so the image or TeX check passes a target the consumer cannot read as a file.
- **Fix direction** Probe the readable target type required by each consumer, with separate missing and unknown outcomes.
- **Test** Replace a local embed and LaTeX include with a directory and a dangling symlink. `notebook-integrity-coverage.test.ts`.

**F55 — A shared TeX chapter can be checked against only one project root**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/latex/dependencies.ts:71`, `src/lib/latex/dependencies.ts:81`, `src/lib/latex/dependencies.ts:113`, `src/lib/storage/integrity.ts:716`.
- **Scenario** Two main files include the same chapter, which names `plot` relative to each main file. The collector deduplicates on reference kind and written text per chapter. Moving the plot out of one root can pass because the retained candidates belong to the root where it still exists.
- **Fix direction** Track references per main-file context and report which build loses the dependency.
- **Test** Build the dependency inventory for two mains sharing a chapter and move one root’s figure. `notebook-integrity-coverage.test.ts`.

**F56 — The checker does substantial work outside its cancellation and size budgets**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/integrity.ts:166`, `src/lib/storage/integrity.ts:265`, `src/lib/storage/integrity.ts:321`, `src/lib/storage/integrity.ts:360`, `src/lib/storage/integrity.ts:528`, `src/lib/storage/integrity.ts:571`, `src/app/api/notebooks/verify/route.ts:27`.
- **Scenario** A notebook has huge text files, an extensive directory tree, or several large PDF candidates. Enumeration and identity matching run outside incremental budget checks. A text file is read in full before its decoded length is compared with the byte limit. `run` calls `allows()` but still starts the check when it returns false. Stop can appear immediate in the UI while server reads continue.
- **Fix direction** Thread budget and abort handling through the walks, record readers, hash streams, and check dispatcher. Count raw bytes before accepting a read.
- **Test** Use small limits, an oversized first note, a large no-note tree, and an aborted orphan hash scan. `notebook-integrity.test.ts`.

**F57 — Incomplete source scans can still produce actionable cleanup findings**  
**Severity** P1 · **Confidence** likely · **Area** `verifier`  
- **Where** `src/lib/storage/integrity.ts:321`, `src/lib/storage/integrity.ts:389`, `src/lib/storage/integrity.ts:581`, `src/lib/storage/integrity.ts:589`, `src/lib/storage/cleanup.ts:135`.
- **Scenario** A limit truncates the visible source inventory, but only the notebook category records that truncation. Sidecar-return and asset-owner decisions can proceed with the incomplete inventory, then emit cleanup actions from categories that appear complete. Cleanup filters by the category that emitted the action.
- **Fix direction** Propagate each missing input to the checks that depend on it and suppress their deletion actions.
- **Test** Put a returning target or a candidate owner beyond an injected visible-file cap and inspect the cleanup plan. `notebook-cleanup.test.ts`.

**F58 — `checkNothingLeftAt` can return clean without inspecting a record slot**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
- **Where** `src/lib/storage/integrity.ts:229`, `src/lib/storage/sidecars.ts:235`, `src/lib/storage/fs-utils.ts:9`, `src/lib/storage/migration.ts:1433`.
- **Scenario** An old sidecar slot is inaccessible, or a legacy/set-aside record still points to the old path. The final migration check examines current registry paths through `pathExists`, which collapses access errors to false. It also has no check of old stars, tags, reviews, attachments, or tether pointers.
- **Fix direction** Propagate unknown slots as unverified and check source records covered by the migration’s clean-result promise.
- **Test** Deny a sidecar probe and inject an old metadata pointer after finalization. `notebook-integrity-coverage.test.ts`.

**F59 — Search keeps an obsolete spelling after a case-only rename**  
**Severity** P2 · **Confidence** likely · **Area** `indexes`  
- **Where** `src/lib/storage/files.ts:277`, `src/lib/search/indexer.ts:700`, `src/lib/search/indexer.ts:720`, `src/lib/storage/integrity.ts:914`.
- **Scenario** On a case-insensitive volume, a targeted update receives both `Paper.pdf` and `paper.pdf`. The old spelling can still open, so it can be indexed instead of retired. The verifier can see an obsolete row while the targeted updater keeps it readable through the alias.
- **Fix direction** Use the committed move mapping or an exact directory lookup to retire the old search key.
- **Test** Start with an indexed PDF, perform a case-only rename, and assert a single row after the targeted update. **New** `notebook-move-index-integrity.test.ts`.

**F60 — Search verification misses a wrong or absent row at a path that still exists**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `indexes`  
- **Where** `src/lib/search/database.ts:140`, `src/lib/storage/integrity.ts:908`.
- **Scenario** Move one note away and put a different one at the old name. The database can still hold the first note’s text at the old path, with no row for the moved file. The verifier reads path strings only and checks for missing indexed paths, so both defects pass.
- **Fix direction** Compare eligible indexed paths and available row freshness metadata, respecting Search exclusions and unavailable roots.
- **Test** Seed a stale row at a reused path and omit the destination row. `notebook-integrity-coverage.test.ts`.

**F61 — Index rebuilds can publish an incomplete snapshot as current**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `indexes`  
- **Where** `src/lib/storage/notebook-links.ts:114`, `src/lib/storage/notebook-links.ts:132`, `src/lib/storage/reference-citations.ts:85`, `src/lib/storage/reference-citations.ts:114`.
- **Scenario** A partial sync or external folder move makes several notes temporarily unreadable. Link and citation rebuilds omit those notes and publish the remaining snapshot, which can erase backlink or citation rows until another rebuild. A verifier scan can also reuse stored hashes without checking that the derived destinations or keys are correct.
- **Fix direction** Preserve known entries for unreadable inputs, retire entries on confirmed absence, and report an incomplete rebuild.
- **Test** Fail a subtree read and one individual note during rebuild, then restore access. **New** `notebook-move-index-integrity.test.ts`.

**F62 — Acknowledge can rebuild the citation index without clearing its finding**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `indexes`  
- **Where** `src/lib/storage/integrity.ts:876`, `src/lib/storage/integrity.ts:898`, `src/lib/storage/cleanup.ts:296`, `src/lib/storage/reference-citations.ts:121`, `src/lib/storage/reference-citations.ts:162`.
- **Scenario** An archived note had a citation index entry, then leaves the archive outside the app. Check flags the old row. With the archive hidden, Acknowledge’s rebuild preserves archived entries from the previous index, so it reports clearing the finding while the next check still finds it.
- **Fix direction** Use an archive-inclusive rebuild for this cleanup action, or explicitly retire verified absent archived keys.
- **Test** Index an archived citing note, remove it, hide the archive, and apply Acknowledge. `notebook-cleanup.test.ts`.

**F63 — Verification’s read-only SQLite check has a file-lifetime race**  
**Severity** P3 · **Confidence** speculative · **Area** `verifier`  
- **Where** `src/lib/search/database.ts:140`, `src/app/api/notebooks/verify/route.ts:38`.
- **Scenario** The checker sees both WAL companion files, then the last writer disconnects before `DatabaseSync` opens. The prerequisite that makes the read-only open side-effect-free may have changed. The exact outcome depends on SQLite, platform permissions, and journal state.
- **Fix direction** Coordinate with an existing database connection or use a documented read mode that guarantees no companion-file creation in that situation.
- **Test** Close the last writer between the companion-file check and the database open, observing filesystem writes. `notebook-integrity.test.ts`.

#### Try to fix

**F64 — Content identity overrides the required name match**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `docs/features/notebook-integrity.md:30`, `src/lib/storage/repair.ts:301`, `src/lib/storage/repair.ts:369`, `scripts/editor/notebook-repair-identity.test.ts:43`.
- **Scenario** A differently named file has the recorded bytes and the sole same-name candidate does not. Repair can move the old path’s annotations, stars, reviews, and attachments to the differently named file. It can also reject the sole same-name candidate when the content differs, or bypass name ambiguity entirely when a content match is unique.
- **Fix direction** Make the normalized basename and the documented one-source, one-destination rule the pairing decision for every record kind.
- **Test** Replace the contradictory identity expectations with different-name, changed-byte, and duplicate-name cases that enforce the name rule. `notebook-repair-identity.test.ts`.

**F65 — The implemented lowercase comparison is weaker than case folding**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `docs/features/notebook-integrity.md:31`, `src/lib/storage/repair.ts:100`, `src/lib/storage/integrity.ts:595`.
- **Scenario** On a case-sensitive filesystem, names that full Unicode case folding equates can remain distinct under JavaScript lowercasing, such as names containing `ß` and `SS`. Repair can miss a pair or treat a folded duplicate as unique. Asset recovery hints also lowercase without NFC.
- **Fix direction** Define and consistently use the documented Unicode equivalence for names and ambiguity.
- **Test** Cover `ß` and `SS`, Greek sigma spellings, and decomposed accents, including duplicate candidates. `notebook-repair.test.ts`.

**F66 — Repair can discard a candidate with its own byte-identical records from the “own” decision**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:325`, `src/lib/storage/repair.ts:347`, `src/lib/storage/repair.ts:486`, `src/lib/storage/repair.ts:590`.
- **Scenario** An independently existing destination has the same sidecar bytes, or its ink folder contains all the source files plus extra pages. `alreadyThere` infers a prior repair from equality or a subset match. The planner drops the `own` blocker and apply deletes the source record.
- **Fix direction** Treat a pre-existing record as own unless the operation can establish that it published that exact record itself.
- **Test** Seed identical outlines and an ink destination containing the source as a strict subset. `notebook-repair.test.ts`.

**F67 — An unreadable record inventory is treated as an empty one**  
**Severity** P1 · **Confidence** likely · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:189`, `src/lib/storage/repair.ts:201`, `src/lib/storage/repair.ts:214`, `src/lib/storage/repair.ts:224`, `src/lib/storage/repair.ts:466`.
- **Scenario** The visible notebook is readable, but one sidecar store, the review index, or the asset scan is incomplete. Repair still matches using the records it saw. It can miss a second missing path of the same name, overlook destination ownership, or move a subset while reporting the pair as repaired.
- **Fix direction** Carry store completeness into the name-plan decision and block pairs whose uniqueness or ownership could not be checked.
- **Test** Fail a store read that hides an ambiguous source or destination record. `notebook-repair.test.ts`.

**F68 — Repair misses a `.bib` whose only record is a tether in another library**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:226`, `src/lib/storage/repair.ts:233`, `src/lib/storage/integrity.ts:837`, `src/lib/references/bib-tether.ts:1054`.
- **Scenario** Notebook B’s library is tethered to `A/old/refs.bib`. Move the `.bib` to `A/new/refs.bib`. Check on B reports the broken tether. Repair on B excludes A’s path, and repair on A reads only A’s tether. The batch updater could remap the tether if the planner emitted the pair.
- **Fix direction** Enumerate all relevant tether owners during repair planning.
- **Test** Move a `.bib` with only a cross-library tether and assert that repair follows it. `notebook-repair.test.ts`.

**F69 — Undo-only history cannot make a repair pair**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/integrity.ts:774`, `src/lib/storage/repair.ts:181`, `src/lib/storage/repair.ts:235`, `src/lib/storage/repair.ts:630`.
- **Scenario** A note has completed agent-run history and no other supported records. Move it to another folder under the same name. Check reports that Undo is unavailable. Repair only updates history as a side effect of a pair made by another record.
- **Fix direction** Include eligible undo-only paths in the same name rule or explicitly expose a way to reconnect that history.
- **Test** Externally move a note with an undoable run and no pending review, tags, or sidecars. `notebook-repair.test.ts`.

**F70 — The repair token can approve newer records or a replacement candidate**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:270`, `src/lib/storage/repair.ts:437`, `src/lib/storage/repair.ts:514`.
- **Scenario** A candidate in the name-only branch is replaced by a same-size file with the same mtime, or the sidecar contents change while its kind remains the same. The token can remain unchanged. After token comparison, there is also no per-pair revalidation that the source is still absent or the destination is still the reviewed item.
- **Fix direction** Bind confirmation to the reviewed record instances and validate paths at commit. Keep validation of a preview separate from name-based pairing.
- **Test** Replace a candidate while preserving size and mtime, and return the old file after token comparison. `notebook-repair.test.ts`.

**F71 — Repair’s case-alias path can overwrite or strand a sidecar**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:121`, `src/lib/storage/repair.ts:497`, `src/lib/storage/repair.ts:565`, `src/lib/storage/markdown-assets.ts:351`.
- **Scenario** Case-only repair moves a sidecar to a temporary name, then uses a replacing rename to publish it. A destination created in between can be overwritten, and a failed second rename leaves the source under the temporary name. Meanwhile Python can see its own alias as a taken slot or be hidden by case-insensitive ownership checks.
- **Fix direction** Detect exact aliases separately from hard links, make the intermediate transition recoverable, and apply consistent alias handling to Python.
- **Test** Inject failure between the two renames and repair a case-only note rename with Python on a case-insensitive volume. `notebook-repair.test.ts`.

**F72 — Repair can delete a newer source sidecar after copying older bytes**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:136`, `src/lib/storage/repair.ts:146`, `src/lib/storage/repair.ts:160`, `src/lib/storage/markdown-assets.ts:363`.
- **Scenario** Repair copies a source annotation or ink folder exclusively. An editor or sync client then updates the source before repair removes it. The newer work is deleted while the destination holds the older snapshot. On a failed ink copy, rollback can similarly delete a destination child that another writer replaced after it was created.
- **Fix direction** Check that each slot still holds the version being retired or rolled back, under the same coordination used by writers.
- **Test** Update the source after copying and replace a copied destination child before rollback. `notebook-repair-identity.test.ts`.

**F73 — A partial repair can create its own permanent “own records” blocker**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:325`, `src/lib/storage/repair.ts:387`, `src/lib/storage/repair.ts:589`, `src/lib/storage/repair.ts:615`.
- **Scenario** Repair moves a transcript or annotations and removes the old sidecar, then a later kind fails. If metadata or another record still makes the old path a candidate, the retry has no old sidecar to compare. In mixed cases, remaining records of that kind can now be blocked by the destination created by the first attempt. Store-batch failures can also leave a retry with a different set of visible records or a different pairing.
- **Fix direction** Track completion at record granularity and let retries resume the confirmed mapping for records still pending.
- **Test** Fail after a successful sidecar transfer, with another record of that kind still outstanding and tags or reviews left to move. `notebook-repair-identity.test.ts`.

**F74 — Multiple set-aside records for one slot are planned as a single move**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:192`, `src/lib/storage/repair.ts:211`, `src/lib/storage/repair.ts:539`.
- **Scenario** Two generations of a sidecar were set aside under the same original path. Planning collapses them to one kind label, while apply queues two writes to the same free destination. The first wins by enumeration order and the second is refused after writes have started.
- **Fix direction** Detect multiple payloads for one destination slot during planning and report the conflict before applying the pair.
- **Test** Create two different set-aside annotation records of one original path and verify the plan is explicit and write-free. `notebook-repair.test.ts`.

**F75 — Repair can report a pair moved when bookkeeping failed or no record moved**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:573`, `src/lib/storage/repair.ts:587`, `src/lib/storage/repair.ts:609`, `src/components/libera/notebook-integrity-dialog.tsx:175`.
- **Scenario** Upkeep or the pending-review reader removes the source record after replan, leaving no work for the pair, or review rekeying fails in the later batch. `moved` is populated before the batch results and can include zero-work pairs. The UI then retargets tabs and workspaces from that claim.
- **Fix direction** Return actual per-record outcomes and a separately validated mapping for renderer retargeting.
- **Test** Disappear the only record after replan, then separately fail the only bookkeeping step. `notebook-repair.test.ts`.

**F76 — Merely listing pending reviews can erase work before repair**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/agent/review-store.ts:119`, `src/lib/agent/review-store.ts:178`, `src/lib/storage/repair.ts:235`, `src/lib/storage/integrity.ts:771`.
- **Scenario** Move a note externally and open the pending-review list before Check Notebook. The list settles the missing file by deleting its pending baseline. Repair’s later read-only scan cannot recover what the list removed.
- **Fix direction** Keep a pending entry on observed absence and distinguish explicit discard or confirmed in-app deletion.
- **Test** Move a note with pending agent changes, list reviews, and then plan repair. `notebook-repair.test.ts`.

**F77 — Repair, cleanup, and upkeep can overlap a new migration**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `repair`  
- **Where** `src/lib/storage/repair.ts:514`, `src/lib/storage/cleanup.ts:303`, `src/lib/storage/tree.ts:413`, `src/lib/storage/migration.ts:1576`, `src/lib/storage/migration-fence.ts:42`.
- **Scenario** The apply guard sees no unfinished migration. One starts before a repair or cleanup action, or after a tree pass has already checked the fence. The operations can move or delete records migration has staged or still needs. An unreadable journal is also excluded from `listInterruptedMigrations`, so the apply guard cannot establish whether it affects the notebook.
- **Fix direction** Use shared operation coordination for the affected notebooks and fail closed when a journal could affect them but cannot be read.
- **Test** Start a migration after repair or cleanup passes its guard, and repeat with an unreadable active journal. `notebook-repair.test.ts`, `notebook-cleanup.test.ts`.

#### Acknowledge

**F78 — A cleanup token can authorize deleting a newly saved sidecar or ink file**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
- **Where** `src/lib/storage/cleanup.ts:156`, `src/lib/storage/cleanup.ts:242`, `src/lib/storage/cleanup.ts:312`.
- **Scenario** The user previews deletion of stale ink. A new file is saved at the same ink filename after apply replans. The action still holds only the path and filename, so cleanup removes the new work. A replacement review or updated transcript at the same action address has the same preview problem.
- **Fix direction** Bind destructive actions to the reviewed record version and recheck staleness at the point of removal.
- **Test** Replace individual ink, transcript, and review records after the apply-time plan but before deletion. `notebook-cleanup.test.ts`.

**F79 — Cleanup’s presence check disagrees with exact-path verification**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
- **Where** `src/lib/storage/library-links.ts:82`, `src/lib/storage/cleanup.ts:206`, `src/lib/storage/cleanup.ts:244`.
- **Scenario** Check finds an obsolete case-only or NFC/NFD alias. If repair cannot pair it and cleanup offers the exact-path record, `lstat` still resolves the old spelling. Apply refuses, so the preview promises an action it cannot take. A directory replacing a former file similarly counts as present to cleanup and absent to the verifier.
- **Fix direction** Separate exact file presence from physical alias and directory existence, and use the same decision in plan and apply.
- **Test** Apply cleanup to a stale case variant and a missing-file review whose name is now a folder. `notebook-cleanup.test.ts`.

**F80 — Cleanup can remove set-aside ink after its owner returns**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
- **Where** `src/lib/storage/integrity.ts:557`, `src/lib/storage/integrity.ts:575`, `src/lib/storage/cleanup.ts:111`, `src/lib/storage/cleanup.ts:257`.
- **Scenario** A set-aside file is approved for cleanup. Its owner returns after verification but before deletion. `set-aside` actions carry no `gone` check, so execution never checks the returned owner. In a multi-file ink folder, an early failure can also leave the remaining ink without its origin record.
- **Fix direction** Revalidate the origin and return status at deletion, and handle the recovery record and its payload as one unit.
- **Test** Restore the owner during apply and fail one child in a multi-page set-aside deletion. `notebook-cleanup.test.ts`.

**F81 — Cleanup can delete an image used from another notebook**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
- **Where** `src/lib/storage/markdown-assets.ts:73`, `src/lib/storage/markdown-assets.ts:138`, `src/lib/storage/markdown-assets.ts:224`, `src/lib/storage/integrity.ts:625`, `src/lib/storage/cleanup.ts:265`.
- **Scenario** The original note moves or disappears and a note in another notebook still embeds its old `_assets` image by a raw URL. Ordinary asset pruning checks cross-notebook raw embeds. Acknowledge derives its unused list without that check and can delete the image.
- **Fix direction** Share the cross-library asset-reference inventory and hold deletion when the relevant consumers cannot be scanned.
- **Test** Reference an unowned image from another notebook using both supported raw URL forms. `notebook-cleanup.test.ts`.

**F82 — Cleanup can delete images that became referenced after the preview**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
- **Where** `src/lib/storage/integrity.ts:625`, `src/lib/storage/cleanup.ts:265`, `src/components/libera/notebook-integrity-dialog.tsx:190`.
- **Scenario** An editor uses the image in a dirty draft, or saves a note referencing it after apply’s scan. Cleanup warns generically about unsaved notes but never consults editor state or checks for a new reference before removing the file.
- **Fix direction** Coordinate with open drafts and protect new references established before deletion.
- **Test** Add an image to a dirty note while Acknowledge is open, then save it during apply. `notebook-cleanup.test.ts`.

**F83 — An absolute tether can be removed after its file returns or the tether changes**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
- **Where** `src/lib/storage/integrity.ts:843`, `src/lib/storage/cleanup.ts:288`, `src/lib/references/bib-tether.ts:956`.
- **Scenario** The absolute `.bib` is restored after replan, or another window changes the tether after the equality check and before `untetherBibFile` acquires its lock. Cleanup can remove a valid tether or the newly selected one. An unreadable parent can also receive the same offer as an accessible parent because the code only excludes `absent`.
- **Fix direction** Compare and remove the tether within one transaction and require known absence of its accessible target.
- **Test** Return the `.bib`, change the target mid-apply, and inject an unknown parent state. `notebook-cleanup.test.ts`.

**F84 — Cleanup can report success when no filesystem removal happened**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
- **Where** `src/lib/storage/cleanup.ts:218`, `src/lib/storage/cleanup.ts:227`, `src/lib/storage/cleanup.ts:279`, `src/lib/storage/cleanup.ts:314`.
- **Scenario** A sidecar parent becomes unreadable. `realpath` failure causes `remove` to skip the operation, and the action still enters `done`. `pruneReviews` can likewise keep a record the cleanup action counted as removed. The user sees a successful count and the finding returns.
- **Fix direction** Distinguish removed, already absent, unreadable, and deliberately held outcomes.
- **Test** Fail `realpath` with a permission error and make review settlement keep the entry. `notebook-cleanup.test.ts`.

**F85 — The cleanup preview hides the individual files behind grouped deletion**  
**Severity** P3 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
- **Where** `docs/features/notebook-integrity.md:52`, `src/lib/storage/integrity.ts:502`, `src/lib/storage/integrity.ts:579`, `src/lib/storage/cleanup.ts:184`, `src/components/libera/notebook-integrity-dialog.tsx:313`.
- **Scenario** Several annotations or ink payloads are set aside. The preview lists a notebook-level finding with a count and consequence, while the individual action paths remain server-side. The user cannot tell which original files’ work they are confirming for deletion.
- **Fix direction** Expose concrete record paths and origins in the preview, with expandable groups for large sets.
- **Test** Plan cleanup for two set-aside owners and verify that both appear in the confirmation model. `notebook-cleanup.test.ts`.

#### Migration and collaboration

**F86 — Local cross-notebook PATCH can bypass migration entirely**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `cross-notebook`  
- **Where** `src/app/api/files/route.ts:110`, `src/app/api/files/route.ts:124`, `src/components/libera/use-libera-workspace.ts:3958`, `src/lib/storage/files.ts:260`.
- **Scenario** The UI routes both Move and notebook-rail drop through migration. An existing or direct API caller can still specify another local notebook and take the direct move path, bypassing the journal, move preview, and migration finalization for PDF reference entries.
- **Fix direction** Route cross-notebook mutations through one operation contract at the server boundary.
- **Test** Send cross-notebook requests through both PATCH shapes and assert consistent migration behavior. `notebook-move-integrity.test.ts`.

**F87 — Migration’s fallback publication can replace a concurrent arrival**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `cross-notebook`  
- **Where** `src/lib/storage/migration.ts:1024`, `src/lib/storage/migration.ts:1138`.
- **Scenario** Hard links are unsupported, or a hidden folder is published by rename. Another file or an empty directory appears after the destination check. A replacing `rename` can replace it. Cross-device hidden folders also have an extended gap between the check and final rename.
- **Fix direction** Use a publish primitive that guarantees non-replacement for the actual filesystem and item kind.
- **Test** Force the no-hard-link branch and place a competing entry immediately before rename. **New** `notebook-migration-integrity-races.test.ts`.

**F88 — Cross-device hidden-folder migration can delete changed source contents**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `cross-notebook`  
- **Where** `src/lib/storage/migration.ts:1048`, `src/lib/storage/migration.ts:1099`, `src/lib/storage/migration.ts:1105`, `src/lib/storage/migration.ts:1144`.
- **Scenario** A hidden folder is copied across drives. The digest compares names, kinds, sizes, and symlink targets. A same-size nested edit can pass, and any new source child after the digest check can be lost when retirement recursively removes the original folder.
- **Fix direction** Retire only source entries shown to have been copied and preserved. Keep any changed or newly arrived entries.
- **Test** Edit a nested file without changing its length, then add another file after publication. **New** `notebook-migration-integrity-races.test.ts`.

**F89 — Staging rollback can remove user assets created after planning**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `cross-notebook`  
- **Where** `src/lib/storage/migration.ts:987`, `src/lib/storage/migration.ts:1617`.
- **Scenario** The preflight sees no destination-owned asset directory and records `stagingBegan`. A sync client delivers user files there before staging finishes or the process exits. If the copied-image manifest was never written, rollback recursively removes the directory based on the initial absence assumption.
- **Fix direction** Record and remove only staging-owned entries, or stage in a private directory before publishing assets.
- **Test** Crash with `stagingBegan` recorded and a separately created image present in the destination note’s asset directory. **New** `notebook-migration-integrity-races.test.ts`.

**F90 — Migration can lose citation rewrite state across a crash**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `cross-notebook`  
- **Where** `src/lib/references/moves.ts:195`, `src/lib/storage/migration.ts:1329`, `src/lib/storage/migration.ts:1342`.
- **Scenario** A citation collision causes a note to be rewritten. The process exits before `journal.references` and its key map are saved. A retry can read the already rewritten note, produce no map for the original key, and leave the pending baseline, active draft, and Undo text pointing at the wrong citation.
- **Fix direction** Persist the planned rewrite and its completion state before publishing rewritten text.
- **Test** Crash after one citation rewrite and before saving the rewrite result. **New** `notebook-migration-integrity-races.test.ts`.

**F91 — Citation rewriting can make a valid migration fail its own identity checks**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `cross-notebook`  
- **Where** `src/lib/references/moves.ts:204`, `src/lib/storage/migration.ts:1066`, `src/lib/storage/migration.ts:1454`, `src/lib/storage/migration.ts:1680`.
- **Scenario** A Markdown file’s citations are rewritten after publication. Final verification compares the resulting text with the earlier image-stage hash, so a successful rewrite can yield “is not the note that moved.” If a later step fails, resume can also reject the legitimately rewritten destination because it no longer has the original inode or staged text.
- **Fix direction** Record and accept each migration-owned destination state and verify against the final expected state.
- **Test** Trigger citation collisions for same-device and staged notes, and force a finalization retry after rewriting. **New** `notebook-migration-integrity-races.test.ts`.

**F92 — Migration can finalize a published file whose records never followed**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `cross-notebook`  
- **Where** `src/lib/storage/migration.ts:1182`, `src/lib/storage/migration.ts:1271`, `src/lib/storage/migration.ts:1544`, `src/lib/storage/migration.ts:1680`.
- **Scenario** A document is published and retired, then sidecar movement fails. Stop can proceed with that item still `published`, excluding it from bookkeeping. If finalization is interrupted, resume infers `finished` from the destination existing and the old file being gone, without checking that the sidecar step succeeded.
- **Fix direction** Persist or independently verify each item’s sidecar and review completion before using it in finalization steps.
- **Test** Fail a sidecar after publication, choose Stop, interrupt finalization, then resume. **New** `notebook-migration-integrity-races.test.ts`.

**F93 — Migration’s destination reservation is inconsistent across filesystem types**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `cross-notebook`  
- **Where** `src/lib/storage/migration.ts:644`, `src/lib/storage/migration.ts:650`, `src/lib/storage/migration.ts:687`.
- **Scenario** On a case-sensitive volume, an existing differently cased destination entry is missed by an exact `lstat`, despite the documented case-insensitive namespace. Planned folder names, by contrast, are deduplicated by lowercase, so one planned spelling can suppress validation of another exact path.
- **Fix direction** Resolve existing and planned name collisions through the same directory-listing policy and validate every exact parent path.
- **Test** Migrate into a case-sensitive destination containing case variants of files and folders. **New** `notebook-migration-integrity-races.test.ts`.

**F94 — Staging and direct reference remaps can mutate state outside the documented preview**  
**Severity** P3 · **Confidence** confirmed by reading the code · **Area** `docs`  
- **Where** `docs/features/notebook-migration.md:12`, `docs/features/notebook-migration.md:40`, `src/lib/storage/migration.ts:586`, `src/lib/storage/migration.ts:756`, `src/lib/storage/migration.ts:954`, `src/lib/storage/migration.ts:1624`, `src/lib/storage/paths.ts:50`.
- **Scenario** Migration Plan calls `ensureAdminRoot` and is not wrapped in `withReadOnlyStorage`, so a linked-folder read can upgrade state during preview. Staging can upgrade source annotations and Python before the document moves, which cancellation does not reverse. Staging also saves a journal before each item despite the documented write frequency.
- **Fix direction** Make preview genuinely read-only, defer source upgrades or describe their committed effects, and reconcile the documented journal write frequency with the implementation.
- **Test** Plan against an old linked-folder state, then cancel staging with legacy sidecars and inspect the filesystem. **New** `notebook-migration-integrity-races.test.ts`.

**F95 — Reference and tether updates can be lost while a linked library is offline**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `records`  
- **Where** `src/lib/storage/references.ts:275`, `src/lib/storage/references.ts:290`, `src/lib/storage/references.ts:365`, `src/lib/references/bib-tether.ts:1054`.
- **Scenario** An offline linked folder’s library has an attachment to a file in a connected notebook. Move that file. The offline library is absent from the remap list and therefore contributes no failure. When it reconnects, the old pointer remains. The batch tether pass likewise filters unresolved linked folders unless a runtime already names one.
- **Fix direction** Enumerate accessible linked-library state independently of document availability and report or defer remaps for unavailable state.
- **Test** Move a file with an attachment and tether owned by an unresolved linked notebook, then reconnect it. `notebook-move-integrity.test.ts`.

**F96 — Shared file and folder moves can adopt stale local destination records**  
**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `collab`  
- **Where** `src/lib/collab/shared-writes.ts:690`, `src/lib/collab/shared-writes.ts:704`, `src/lib/collab/shared-writes.ts:724`, `src/lib/collab/shared-writes.ts:796`, `src/lib/storage/repair.ts:107`.
- **Scenario** A shared destination is free in the host manifest, but this computer has a tag, review, or image sidecar there. The host moves the file before the local-record checks. A tag can be replaced, a stale record can attach to the arriving file, and a single-file move ignores the list of sidecars that stayed behind. The resulting shared notebook is ineligible for Try to fix.
- **Fix direction** Preflight applicable local records and return explicit local bookkeeping outcomes alongside the host mapping.
- **Test** Move a shared image onto an empty manifest slot with local annotations and tags. **New** `notebook-shared-move-integrity.test.ts`.

**F97 — Shared deletes leave local review and reference records behind**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `collab`  
- **Where** `src/lib/collab/shared-writes.ts:755`, `src/lib/collab/shared-writes.ts:816`, `src/lib/storage/files.ts:886`.
- **Scenario** Delete a shared note or folder locally. The host removes its manifest entries, but these wrappers do not remove Markdown review comments or detach library reference attachments the way local deletion does. The stale pointers remain, and Acknowledge refuses the shared notebook.
- **Fix direction** Tie local record cleanup to the confirmed host deletion, with explicit handling for recoverable archive copies.
- **Test** Delete a shared file and folder with local review comments and cross-library attachments. **New** `notebook-shared-move-integrity.test.ts`.

**F98 — Copying shared text can silently fall back to a stale working copy**  
**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `collab`  
- **Where** `src/lib/storage/files.ts:811`, `src/lib/storage/files.ts:824`, `src/lib/storage/files.ts:1053`.
- **Scenario** The host cannot answer a text read, and the local cloud copy is behind. The method’s comment promises to read the shared version before creating a file, but the implementation swallows the host error and copies the disk bytes. The copy can be missing collaborators’ work.
- **Fix direction** Refuse or explicitly label a disk-only copy when the authoritative snapshot is unavailable.
- **Test** Make the host read fail while its last known text differs from the working copy. **New** `notebook-shared-move-integrity.test.ts`.

**F99 — Migration’s written instructions contradict current review and drop behavior**  
**Severity** P3 · **Confidence** confirmed by reading the code · **Area** `docs`  
- **Where** `docs/features/notebook-migration.md:7`, `docs/features/notebook-migration.md:19`, `docs/features/notebook-migration.md:44`, `src/lib/storage/migration.ts:739`, `src/lib/storage/migration.ts:1233`, `src/lib/storage/migration.ts:1579`, `src/components/libera/use-libera-workspace.ts:3961`.
- **Scenario** The migration doc describes drag and drop as direct, says Run replans without checking links, and describes failed finalization steps as reported without blind retry. Current drop opens migration across notebooks, Run recomputes warnings, a failed step is retried once, and a crash-marked in-progress step can run again.
- **Fix direction** Align the documentation with the actual entry points and retry semantics, and specify which steps can safely replay.
- **Test** Assert that a cross-notebook drop opens review, a changed warning invalidates the token, and an interrupted finalize step has a defined replay outcome. **New** `notebook-migration-integrity-races.test.ts`.

### Inputs for the planned link refactor

- **Resolve before editing, with the editor’s actual precedence.** Use `resolveMarkdownFileLink` and `linkCandidates`. The resolver decodes path segments, normalizes `.` and `..`, tries a path relative to the linking note, then tries a workspace-root path such as `Other/folder/file.md`. Leading `/` is excluded from this ordinary link resolver. Treat unprefixed workspace paths as potentially shadowed by a relative path. Re-resolve each generated URL against the final layout. Preserve local fragment-only links and external schemes. `src/lib/markdown-file-links.ts:79`, `src/lib/markdown-file-links.ts:105`, `src/lib/markdown-file-links.ts:230`, `src/lib/markdown-file-links.ts:261`, `src/lib/storage/library-links.ts:36`.
- **Map both ends of every affected link.** Include links into the moving file from notes that stay, links out of a moved note to files that stay, links between items moving together, explicit links back to the moved note itself, and links whose fallback changes because an arriving file shadows the old target. Include folder prefixes, exact per-file suffixes chosen by migration, case-only and NFC/NFD spelling changes, archives, and connected linked notebooks. Use the complete committed mapping for a partial migration. The warning code already simulates parts of this graph. `src/lib/storage/files.ts:344`, `src/lib/storage/migration.ts:780`, `src/lib/storage/migration.ts:827`.
- **Preserve positions and encoding.** Change the path without interpreting an opaque saved-position payload as ordinary path text. Preserve heading anchors, percent encoding, saved view state, annotation IDs, audio times, quotation context, and any query or fragment syntax the producer emits. Check the result against the same heading, annotation, and duration checks the verifier applies. A migrated annotation link needs its annotation ID to survive too. `src/lib/markdown-file-links.ts:152`, `src/lib/markdown-file-links.ts:173`, `src/lib/markdown-file-links.ts:203`, `src/lib/markdown-file-links.ts:294`, `src/lib/storage/integrity.ts:678`, `src/lib/storage/integrity.ts:692`, `src/lib/storage/annotations.ts:352`.
- **Edit syntax spans, including reference definitions.** Handle inline destinations, full/collapsed/shortcut reference syntax, first-definition precedence, angle-bracket destinations, escapes, titles, and repeated references. A definition may be shared by a link and an image, whose resolvers differ. Split it when a single destination cannot preserve both meanings. Preserve fenced examples and unrelated source formatting. The link occurrence helper gives resolved occurrences and lines, and the image helper already identifies destination spans and applies edits from the end of the string. `src/lib/markdown-link-occurrences.ts:41`, `src/lib/markdown-image-sources.ts:24`, `src/lib/markdown-image-sources.ts:48`, `src/lib/markdown-image-sources.ts:96`.
- **Separate notebook files from notebook-owned assets.** Reuse `markdownImageTargets`, `getMarkdownImageAssetBySource`, and `rewriteMarkdownImageSources` for inline and reference images and HTML `<img src>`. Recognize `/api/files/raw/...`, `/api/markdown-assets/raw?document=…&asset=…`, and `_assets/...` sources. The asset URL’s document selects a notebook namespace even when that document has moved. An ordinary notebook image may move, stay, or be copied into `_assets`. An embedded asset can remain where it is, or be copied once for several movers. Keep the original namespace for already missing assets to avoid accidentally resolving a destination image of the same name. `src/lib/storage/markdown-assets.ts:38`, `src/lib/storage/markdown-assets.ts:111`, `src/lib/storage/markdown-assets.ts:460`, `src/lib/storage/markdown-assets.ts:581`, `src/lib/storage/markdown-assets.ts:609`.
- **Keep unsaved uploads, Python figures, and ink renderings reachable.** Include owned but unembedded uploads that are present in a draft, Python figure source histories, ink rendering SVGs, and assets still referenced by a note in any notebook. Coordinate asset rewrites with pruning and preserve source files until all affected consumers have committed. Use the existing migration batch mapping to recognize a notebook image moving with a note. `src/lib/storage/markdown-assets.ts:214`, `src/lib/storage/markdown-assets.ts:236`, `src/lib/storage/markdown-assets.ts:351`, `src/lib/storage/markdown-assets.ts:451`.
- **Handle chart datasets as a separate path form.** Parse `chart` fences and rewrite only the `.csv` or `.tsv` file value. The resolver uses the deck directory and clamps traversal at the notebook boundary. If a move makes a cross-notebook dataset unrepresentable, account for it in the move plan. Check charts in staying and moving notes, including datasets that the rail does not list. `src/lib/slide-charts.ts:92`, `src/lib/slide-charts.ts:99`, `src/lib/slide-charts.ts:118`, `src/lib/storage/integrity.ts:668`, `src/lib/storage/migration.ts:792`.
- **Handle LaTeX in project context.** Preserve `\input`, `\include`, relative import variants, `\includegraphics` and `\includegraphics*`, `\graphicspath`, `\includepdf`, `\lstinputlisting`, and bibliography dependencies. Distinguish the main file’s directory, the child’s directory for imports that use it, and notebook-root bibliography fallbacks. Retain omitted-extension behavior and include files absent from the tree. One chapter may be read from several mains. Mark macro-generated names unresolved when static rewriting cannot establish the target. `src/lib/latex/dependencies.ts:35`, `src/lib/latex/dependencies.ts:45`, `src/lib/latex/dependencies.ts:58`, `src/lib/latex/dependencies.ts:87`, `src/lib/storage/integrity.ts:715`.
- **Apply the same transform to history and drafts.** Use a deterministic transform and a recorded before/after mapping for on-disk text, pending-agent baselines, review snapshots and anchors, undo originals and drafts, open buffers, saved workspaces, and pending image/ink saves. For staying notes rewritten because they link into the move, update their save baselines and preserve dirty edits too. Compose image, link, and citation rewrites in the same order on server and renderer. `src/lib/storage/files.ts:409`, `src/lib/storage/files.ts:423`, `src/lib/storage/migration.ts:1342`, `src/lib/agent/snapshots.ts:270`, `src/components/libera/use-libera-workspace.ts:1638`, `src/components/libera/use-libera-workspace.ts:4051`.
- **Respect collaboration and abort semantics.** Use the shared host’s document and file IDs for shared notebook moves. Apply text rewrites through live document authority, including affected notes that stay, and guard against intervening edits. A path-only working-copy event gives an incomplete basis for a write. Keep shared cross-notebook migration’s existing refusal. For local moves, publish the rewrite set with the move outcome so interrupted and cross-window consumers can follow it. `src/lib/collab/shared-writes.ts:677`, `src/lib/storage/sidecar-lifecycle.ts:9`, `src/lib/storage/migration.ts:605`, `src/components/libera/use-libera-workspace.ts:4091`.
- **Use the verifier as a postcondition and check target identity in tests.** After updating derived link, citation, and Search entries, run the image, link, chart, and LaTeX checks against the committed layout. Also assert that each rewritten URL opens the *intended* target. Existence-only verification cannot detect valid URLs that resolve to the wrong copy. Exercise open drafts, pre-existing broken links, ambiguous fallbacks, read failures, and a resumed partial move. `src/lib/storage/integrity.ts:629`, `src/lib/storage/integrity.ts:644`, `src/lib/storage/integrity.ts:715`, `src/lib/storage/integrity.ts:850`, `src/lib/storage/notebook-links.ts:105`, `src/lib/storage/reference-citations.ts:114`, `src/lib/storage/search-updates.ts:11`.

### Coverage

- **Read fully for this review** — Both requested feature docs, the verify, repair, cleanup, and migration API routes, and the core implementations in `repair.ts`, `cleanup.ts`, `integrity.ts`, `sidecars.ts`, `sidecar-lifecycle.ts`, `fs-utils.ts`, `library-links.ts`, `pdf-identity.ts`, `destination-records.ts`, `markdown-link-occurrences.ts`, and `search-updates.ts`.
- **Read the relevant functions and skimmed surrounding code** — `files.ts`, `migration.ts`, `migration-fence.ts`, `tree.ts`, `pdf-sidecars.ts`, `ink.ts`, `annotations.ts`, `transcripts.ts`, `paths.ts`, both directory-mode implementations, `notebooks.ts`, `markdown-assets.ts`, `workspace-metadata.ts`, `file-tags.ts`, `starred-files.ts`, `review-files.ts`, `markdown-reviews.ts`, agent `review-store.ts` and `snapshots.ts`, `references.ts`, `bib-tether.ts`, `moves.ts`, `reference-citations.ts`, `notebook-links.ts`, Search database and indexer, local file routes, shared write wrappers, and the Markdown, image, chart, and LaTeX resolvers. In the renderer I traced the relevant handlers in `notebook-panel.tsx`, `libera-app.tsx`, `use-libera-workspace.ts`, both notebook dialogs, and `pending-saves.ts`.
- **Tests** — Read test names and relevant assertions in the requested integrity, operations, move, repair, repair-identity, and cleanup files. The identity tests explicitly encode some of the behavior that conflicts with the name-only spec. Proposed race cases are static deductions and remain unexecuted.
- **Remaining coverage limits** — I did not exhaustively trace the Electron collaboration host’s manifest journal, every per-editor save implementation, every legacy annotation or ink format, or native filesystem behavior on macOS and Windows. The collaboration findings concern the storage and renderer paths inspected here. Platform-dependent outcomes are called out where the filesystem determines them.