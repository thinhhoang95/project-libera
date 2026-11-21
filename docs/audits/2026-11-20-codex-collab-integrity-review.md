# Shared notebook integrity review

Reviewed the clean `main` working tree at `b3f6269`. This was a read-only static review. I changed no files, started no app processes, and ran no tests.  
The most serious failures happen when a path changes owners while the editor, host, and working folder have different views of it. A stale action can delete the replacement file, move its records, or carry a draft onto it.  
A shared file operation can commit before its local records follow. The current recovery paths cover some PDF and audio sidecars, with no durable replay for the full set of records.  
External renames can split one file into two identities. Several scanner, materialization, and SQLite failure paths can also leave healthy-looking sync sessions unable to make progress.  
Check Notebook evaluates the disk. It can miss manifest-to-disk gaps, predict upkeep that shared notebooks skip, and offer actions the shared-notebook guards always refuse.  
The findings below distinguish code-confirmed behavior from timing- or provider-dependent outcomes. References to earlier audit IDs identify surviving portions or distinct regressions.

### Findings

#### S1. A stale shared tree can authorize a move or delete of the replacement file

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `src/lib/storage/tree.ts:625`, `src/lib/storage/tree.ts:639`, `src/lib/collab/tree-file-ids.ts:24`, `electron/collab/notebooks/project.ts:3084`  
**Scenario** A follower still shows A at `paper.pdf`; the manifest now has B there. Equal sizes cause the tree to stamp A’s row with B’s ID. A size mismatch or listing timeout leaves the ID absent, and the host accepts a path-only operation. Either way, Delete can delete B. This is the surviving part of November 19 finding 1.  
**Fix direction** Bind actionable rows to manifest identities and mark disk projections whose ownership is unverified. Require an identity for destructive shared file actions.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, exercise equal-size replacement, unequal-size replacement, and a listing timeout with separate follower bytes.

#### S2. A routine incremental refresh strips a previously correct shared file ID

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
**Where** `src/lib/storage/tree.ts:658`, `src/lib/tree-merge.ts:109`, `src/lib/tree-merge.ts:117`, `src/components/libera/use-libera-workspace.ts:624`  
**Scenario** Open a correctly identified tree. A working-copy write triggers the lightweight metadata endpoint. Its node comes from `getFileNode`, and the patch replaces the prior node with that disk node. A later path reuse leaves Rename or Delete without the identity check the original row had. This is a separate route around the November 19 finding 1 fix.  
**Fix direction** Carry the validated manifest identity through incremental refreshes and invalidate the row when the identity no longer matches.  
**Test** In `scripts/editor/shared-tree-batches.test.ts`, refresh a shared file incrementally, reuse its path, and verify that the old action is refused.

#### S3. Folder actions can affect a different subtree from the one confirmed

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `src/components/libera/use-libera-workspace.ts:4799`, `src/lib/collab/shared-writes.ts:824`, `src/lib/collab/shared-writes.ts:843`, `electron/collab/notebooks/project.ts:3208`  
**Scenario** Open Delete Folder on `Drafts`. A collaborator renames that folder and creates a new `Drafts`, or adds a descendant during the confirmation. The host enumerates the current prefix and deletes its occupants. Rename likewise applies the current host prefix but moves local sidecars using a Next-side listing captured earlier.  
**Fix direction** Bind folder operations to a manifest revision and a reviewed set of descendant IDs. Return the exact committed mapping.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, replace a confirmed folder and add a child between the listing and the host operation.

#### S4. A committed move or delete has no durable local-record continuation

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `src/lib/collab/shared-writes.ts:700`, `src/lib/collab/shared-writes.ts:710`, `src/lib/collab/shared-writes.ts:772`, `src/lib/collab/shared-writes.ts:826`, `src/lib/collab/shared-writes.ts:851`, `src/app/api/files/route.ts:22`  
**Scenario** The host commits `a.md → b.md`. The response is lost, Next exits, or a readback fails. The local follow-up is plain sequential code after the request. A retry can fail at the old source or fail the expected-ID check, while the host’s staged-file journal contains no local record work. A normal storage error also omits the committed mapping used by the renderer.  
**Fix direction** Give explicit operations durable IDs and results. Persist the exact file-ID mapping and resume each local record step idempotently.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, drop the host response and interrupt after successive record steps, then retry and compare with Check Notebook.

#### S5. Path reuse between manifest commit and record cleanup can destroy someone else’s work

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `records`  
**Where** `src/lib/collab/shared-writes.ts:697`, `src/lib/collab/shared-writes.ts:710`, `src/lib/collab/shared-writes.ts:782`, `src/lib/collab/shared-writes.ts:852`, `src/lib/storage/workspace-metadata.ts:292`  
**Scenario** After a move or delete commits, a collaborator reuses the source path and the user adds a review, tags, or sidecars to the new file. The first operation still moves or deletes by the old path. A destination tag save after preflight can also be overwritten by the move’s queued metadata update.  
**Fix direction** Carry record ownership or the recorded version into each follow-up and hold records whose owner or version changed.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, pause after the host commit, reuse the source and save records at both paths, then resume.

#### S6. Pending local agent reviews are omitted from shared moves and deletes

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `records`  
**Where** `src/lib/collab/shared-writes.ts:710`, `src/lib/collab/shared-writes.ts:789`, `src/lib/collab/shared-writes.ts:830`, `src/lib/collab/shared-writes.ts:860`, `src/lib/storage/files.ts:521`, `src/lib/agent/review-store.ts:290`  
**Scenario** Share a notebook with a local pending agent review, then move or delete the note. The shared wrappers omit the pending-review transfer and discard used by local operations. The old baseline can keep blocking a path or remain attached to a path subsequently reused.  
**Fix direction** Include local pending reviews in the committed record mapping and provide a deliberate discard or recovery outcome on delete.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, seed a pending review, then exercise single and folder move and delete after sharing.

#### S7. Pre-share agent undo history never follows a shared rename

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `records`  
**Where** `src/lib/collab/shared-writes.ts:710`, `src/lib/collab/shared-writes.ts:830`, `src/lib/storage/files.ts:372`, `src/lib/storage/files.ts:544`, `src/lib/agent/snapshots.ts:229`  
**Scenario** An agent run changes a local file. The notebook is shared and the file is renamed. The shared wrapper never records `movedTo` for the earlier path-based run. Shared runs already carry document IDs, but that leaves the earlier run stranded.  
**Fix direction** Rebind pre-share history to the adopted identity and current path, with undo applied through the host while the file is shared.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, run a local agent edit, share, rename, and exercise Undo against the original file identity.

#### S8. A shared folder rename can give one note two review documents

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `records`  
**Where** `src/lib/collab/shared-writes.ts:822`, `src/lib/collab/shared-writes.ts:830`, `src/lib/storage/markdown-reviews.ts:122`, `src/lib/storage/markdown-reviews.ts:139`, `src/lib/storage/files.ts:619`  
**Scenario** The destination holds an empty review or gains a nonempty review after preflight. The folder wrapper uses unconditional prefix rekeying. It can leave both review IDs under one destination key or retarget a destination review created for another file. The single-file helper also drops the structured outcome when a review is held.  
**Fix direction** Use the committed per-file pairs and the review store’s collision-aware transaction. Return held and conflicting records as part of the result.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, plant an empty destination review and inject a nonempty one after preflight.

#### S9. Attachment and bibliography failures can look like successful shared moves

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `references`  
**Where** `src/lib/collab/shared-writes.ts:711`, `src/lib/collab/shared-writes.ts:831`, `src/lib/storage/references.ts:296`, `src/lib/storage/references.ts:312`, `src/lib/storage/references.ts:371`, `src/lib/references/bib-tether.ts:1025`  
**Scenario** A shared move succeeds while an attached reference library is offline, corrupt, or fails during its update. The attachment helper skips or logs the failure. The tether is driven by a separate move event, outside the move’s completion record. The caller can receive success with either pointer still at the old path. This extends the earlier F95 deferred-library gap to shared moves.  
**Fix direction** Return per-library and tether outcomes, and retain the committed mapping for stores that could not be updated.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, inject an attachment-write failure and a tether failure after a committed move.

#### S10. Shared sidecar transfer can unlink a newer source record

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `sidecars`  
**Where** `src/lib/collab/shared-writes.ts:745`, `src/lib/collab/shared-writes.ts:751`, `src/lib/storage/fs-utils.ts:239`  
**Scenario** Copy an image annotation or a note definition to its destination. Between the copy and `rm(old)`, an editor or OneDrive publishes a newer record at the old slot. The move deletes the new record and keeps the old snapshot. The local repair fix for F72 does not cover this shared wrapper.  
**Fix direction** Publish exclusively and retire only the source version actually copied, under the record owner’s write coordination.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, replace the old sidecar after destination publication and verify both versions remain recoverable.

#### S11. A case-only shared rename can leave local records at the old spelling

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `sidecars`  
**Where** `src/lib/collab/shared-writes.ts:691`, `src/lib/collab/shared-writes.ts:745`, `src/lib/storage/pdf-sidecars.ts:178`, `src/lib/storage/integrity.ts:1023`  
**Scenario** On a case-insensitive volume, rename `Photo.png` to `photo.png`. The same-item check allows it. The source sidecar occupies the destination under the filesystem’s alias rules, so exclusive copy cannot perform the spelling change. Path-keyed records may move while the sidecar’s listing retains the spelling the verifier considers orphaned.  
**Fix direction** Apply a guarded temporary-name rename to sidecar aliases after establishing that the two spellings name the same source slot.  
**Test** In `scripts/editor/notebook-oracle-agreement.test.ts`, run a shared case-only image and PDF rename on an aliasing volume and check exact sidecar spellings.

#### S12. Shared extension changes check the manifest kind but omit incompatible local records

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `src/lib/collab/shared-writes.ts:682`, `src/lib/collab/shared-writes.ts:739`, `electron/collab/notebooks/project.ts:2930`, `src/lib/storage/files.ts:348`  
**Scenario** Rename an annotated image blob to a PDF extension. Both are blobs, so the host kind check can pass. The local annotation kind applies only to the source and the move helper silently skips it. The earlier November 19 finding 20 fix covers shared companion checks but leaves this local-record branch.  
**Fix direction** Apply the record-loss preflight to both local and manifest-backed records before accepting a type-changing rename.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, rename annotated image and PDF blobs across types with and without local records.

#### S13. A shared rename can silently strand a companion at a contested destination

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `electron/collab/notebooks/project.ts:2862`, `electron/collab/notebooks/project.ts:2893`, `electron/collab/notebooks/project.ts:2917`, `electron/collab/notebooks/project.ts:3184`  
**Scenario** The main destination is free, but its ink folder, transcript slot, or Python slot is occupied in the manifest. Each companion helper can return an empty list for an occupied or invalid destination. The primary rename still commits. The moved file loses access to its companion and can resolve the other one.  
**Fix direction** Plan required companion changes alongside the primary move and refuse or surface a conflict before publishing any of them.  
**Test** In `scripts/collab/notebooks-sync.test.ts`, seed each destination companion in the manifest while leaving the primary path free.

#### S14. A folder rename leaves shared Python code under the old `_assets` prefix

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `electron/collab/notebooks/project.ts:3168`, `electron/collab/notebooks/project.ts:3194`, `src/lib/collab/shared-writes.ts:822`, `src/lib/storage/files.ts:625`  
**Scenario** Rename `Drafts` containing `a.md` with Python code under `_assets/Drafts`. The folder batch selects descendants of `Drafts`, and Python companion handling runs only for a nonfolder rename. The destination preflight also receives no incoming-note list for Python slots. November 19 finding 13’s folder follow-up still misses this manifest-owned record.  
**Fix direction** Expand every affected note into its Python companion move and validate all destination slots.  
**Test** In `scripts/collab/notebooks-sync.test.ts`, rename a nested shared folder with Python code and test a preexisting target script.

#### S15. Shared delete removes host-owned working files from Next

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `src/lib/collab/shared-writes.ts:779`, `src/lib/collab/shared-writes.ts:789`, `src/lib/collab/shared-writes.ts:860`, `src/lib/storage/sidecars.ts:211`, `src/lib/storage/sidecars.ts:263`, `src/lib/storage/markdown-assets.ts:392`  
**Scenario** Delete on a follower before the writer archives the file, or while a host deletion is still optimistic. The generic cleanup recursively removes disk ink and can unlink the Python script. OneDrive can propagate the unlink before the writer archives newer external ink or code. A rejected host delete can restore its server version while those local bytes are gone.  
**Fix direction** Restrict Next cleanup to local record stores. Route manifest-owned companions and their recovery through the host.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, delay the writer, delete from a follower, and reject the manifest update after local cleanup would run.

#### S16. Shared folder delete leaves Python companions live on the server

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `electron/collab/notebooks/project.ts:3208`, `electron/collab/notebooks/project.ts:3217`, `electron/collab/notebooks/project.ts:2902`, `src/lib/storage/sidecars.ts:263`  
**Scenario** Delete `Drafts` containing a note with Python code. Neither the folder-prefix manifest deletion nor the sidecar-directory cleanup selects the disjoint `_assets/Drafts` code. The script remains in the manifest and can be inherited by a new note at the same path.  
**Fix direction** Include owned Python code in the committed delete set, and apply reference-aware reachability rules to any associated images.  
**Test** In `scripts/collab/notebooks-sync.test.ts`, delete and recreate a shared folder and assert that its new note has none of the deleted note’s code.

#### S17. Shared batch preflight misses collisions it claims to check

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-batch`  
**Where** `src/lib/storage/batch-files.ts:129`, `src/lib/collab/protocol/schema.ts:315`, `docs/features/multi-file-selection.md:48`  
**Scenario** Select NFC and NFD spellings of the same basename from two directories and move them into a third. Preflight lowercases the names without normalizing them. The first move commits, and the host refuses the second. Preflight also excludes a selected file already in the destination from its collision set.  
**Fix direction** Use the host’s reservation key and include stationary occupants when validating the proposed layout.  
**Test** In `scripts/editor/notebook-batch-files.test.ts`, assert a preflight refusal for composed/decomposed names and a selected stationary occupant.

#### S18. Batch results omit files whose host operation committed before an error

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-batch`  
**Where** `src/lib/storage/batch-files.ts:172`, `src/lib/storage/batch-files.ts:219`, `src/lib/collab/shared-writes.ts:716`, `src/lib/collab/shared-writes.ts:794`, `src/components/libera/use-libera-workspace.ts:4217`, `src/components/libera/use-libera-workspace.ts:4262`  
**Scenario** The second file moves, then a sidecar step reports failure. The batch records it only as failed because the wrapper throws a plain storage error. A committed delete followed by cleanup failure similarly stays out of `deleted`. Saved workspaces and open-tab handling receive the wrong set.  
**Fix direction** Return committed and unfinished outcomes independently, and apply the committed portion to workspace state.  
**Test** In `scripts/editor/notebook-batch-files.test.ts`, fail the second item’s cleanup after host commit for both move and delete.

#### S19. A mixed archive and active batch is routed by its first item

**Severity** P3 · **Confidence** confirmed by reading the code · **Area** `shared-batch`  
**Where** `src/app/api/files/batch/route.ts:41`, `src/app/api/files/batch/route.ts:44`, `src/lib/collab/shared-notebook.ts:128`, `src/lib/storage/batch-files.ts:219`  
**Scenario** With the archive visible, select an archived recovery file and an active shared file from the same notebook. The first item decides the storage handler for both. Reversing selection order changes which operations can succeed before the other storage domain refuses.  
**Fix direction** Classify each item before mutation and make the allowed mixed-selection behavior explicit.  
**Test** In `scripts/editor/notebook-batch-files.test.ts`, submit the same mixed selection in both orders.

#### S20. Batch delete repeats library-wide upkeep between files

**Severity** P3 · **Confidence** confirmed by reading the code · **Area** `shared-batch`  
**Where** `src/app/api/files/batch/route.ts:46`, `src/lib/collab/shared-writes.ts:798`, `src/lib/storage/tree.ts:448`, `src/lib/storage/tree.ts:465`  
**Scenario** Delete many shared files. Each wrapper can wait for disk removal and calls `getTree()`, whose return value the batch discards. With follower lag and a large library, this delays later deletes and inserts repeated upkeep passes between them.  
**Fix direction** Return per-file delete outcomes directly and perform one bounded refresh after the batch.  
**Test** In `scripts/editor/notebook-batch-files.test.ts`, delete multiple files with lagging disk copies and count tree reads and waits.

#### S21. A successful shared move gives no warning for links it breaks

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `links`  
**Where** `docs/features/move-link-refactor.md:3`, `docs/features/move-link-refactor.md:68`, `src/lib/collab/shared-writes.ts:700`, `src/lib/collab/shared-writes.ts:719`, `src/lib/storage/integrity.ts:897`, `src/lib/storage/integrity.ts:984`  
**Scenario** Move a note with relative chart or image paths, a linked PDF, or a LaTeX dependency. The shared wrapper returns no rewrite or skipped-path report. The verifier later reports the break on a settled working copy. Local notes linking to the moved shared file also receive no move follow-up.  
**Fix direction** Assess the affected paths against the committed layout and report skipped rewrites. Apply supported shared text changes through document authority with a text precondition.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, cover incoming links from both notebook types, moved-note embeds, charts, and LaTeX dependencies.

#### S22. A shared move can silently change which file an intact-looking link opens

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `links`  
**Where** `src/lib/collab/shared-writes.ts:700`, `src/lib/storage/integrity.ts:934`, `src/lib/storage/move-links.ts:119`  
**Scenario** `Drafts/index.md` links to `paper.pdf` and resolves to the local sibling. Move that sibling away while a root-level `paper.pdf` remains, or move the note beside a different `paper.pdf`. The path still resolves and Check Notebook can pass even though it now opens a different file.  
**Fix direction** Compare before and after resolution by file identity in the move planner, using the verifier’s resolver. Rewrite through the host or report the changed target.  
**Test** In `scripts/editor/notebook-oracle-agreement.test.ts`, verify the target ID across fallback and shadowing cases.

#### S23. Copying current shared text still requires a disk source

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `src/lib/storage/files.ts:942`, `src/lib/storage/files.ts:949`, `src/lib/storage/files.ts:961`, `src/lib/collab/shared-writes.ts:882`  
**Scenario** A follower can resolve and read a newly made note through the host, but OneDrive has yet to deliver its disk file. Copy out fetches live text and then attempts an exclusive disk copy before writing it. Copy in begins with `getFileNode` and hits the same physical prerequisite. This is a remaining DL-9/DATA-6 case.  
**Fix direction** Build the copy from an identity-bound authoritative source snapshot and publish the supplied bytes exclusively.  
**Test** In `scripts/editor/collab-critical-storage.test.ts`, copy a manifest-only note to a local notebook and to another available shared destination.

#### S24. A joined host’s “entry absent” answer can copy a deleted blob from disk

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `electron/collab/notebooks/project.ts:3019`, `src/lib/storage/shared-source.ts:54`, `src/lib/storage/files.ts:946`, `src/lib/collab/shared-writes.ts:928`  
**Scenario** A collaborator deletes or moves a binary. A stale follower row remains. The blob endpoint says the old entry is absent, and the caller treats that like an unavailable authority and copies stale local bytes. An intentional Copy can thereby republish a deleted version. This is a narrower DATA-6 gap.  
**Fix direction** Distinguish an authoritative negative lookup from an unavailable authority. Expose a separately identified recovery copy when the user requests disk bytes.  
**Test** In `scripts/editor/collab-critical-storage.test.ts`, copy a deleted PDF whose old bytes are still on the follower.

#### S25. Shared copy follows the requested destination after the host chooses another path

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `electron/collab/notebooks/project.ts:3265`, `src/lib/collab/shared-writes.ts:909`, `src/lib/collab/shared-writes.ts:930`, `src/lib/collab/shared-writes.ts:934`, `src/lib/collab/shared-writes.ts:938`  
**Scenario** Another member claims `copy.pdf` during upload. The host preserves both and returns the new file’s suffixed path. The wrapper uses that path for audio transcripts, but uses the requested path for non-live PDF annotations, search notification, and the returned file. It can give the other member’s PDF the copied notes. This is a remaining caller-side variant of November 19 finding 25.  
**Fix direction** Use the committed file ID and resolved path for every copy follow-up and verify ownership when publishing the records.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, inject a concurrent destination claim for text, audio, and non-live PDF copies.

#### S26. Copy into a shared notebook leaves cited keys in the source namespace

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `references`  
**Where** `src/lib/collab/shared-writes.ts:893`, `src/lib/collab/shared-writes.ts:909`, `src/lib/storage/files.ts:992`, `docs/audits/2026-11-20-move-integrity-triage.md:54`  
**Scenario** Copy a note citing `@smith` into a shared notebook where the key identifies a different paper. The copy carries the original key and skips the reference mapping. The earlier F11 triage explicitly left this branch open.  
**Fix direction** Map references and rewrite the copy’s text before the host creates its document.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, copy into an empty library and into one with a conflicting citation key.

#### S27. Shared Markdown copy can alter unrelated text and leave orphan uploads

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `links`  
**Where** `src/lib/collab/shared-writes.ts:900`, `src/lib/collab/shared-writes.ts:905`, `src/lib/collab/shared-writes.ts:909`  
**Scenario** An image address also appears in a code example or prose. Copy replaces every occurrence with `split(...).join(...)`. If a later asset read or note creation fails, earlier image blobs are already live under `_assets` without a document that owns them.  
**Fix direction** Rewrite parsed image destination spans and use a recoverable copy operation that records the assets it created before publication.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, reuse an image address in a code fence and fail the second upload or final creation.

#### S28. Copy into sharing drops several copyable local records

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `records`  
**Where** `src/lib/collab/shared-writes.ts:893`, `src/lib/collab/shared-writes.ts:912`, `src/lib/collab/shared-writes.ts:930`, `src/lib/storage/files.ts:977`, `src/lib/storage/files.ts:997`  
**Scenario** Copy an image with annotations or ink, or a note with Python code and local review comments. The shared copy branch handles image embeds, PDF seed data, and audio transcripts, then returns without the broader metadata and review copy used by the local path. The copy succeeds with missing work.  
**Fix direction** Specify and apply the same copy policy for supported records, publishing shared companions through the host and giving copied records their own identities.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, copy a fixture with each supported record kind and check the resulting file and records.

#### S29. Create and upload can inherit records a move would refuse to touch

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `records`  
**Where** `src/lib/collab/shared-writes.ts:632`, `src/lib/collab/shared-writes.ts:970`, `src/lib/storage/files.ts:569`, `electron/collab/notebooks/project.ts:3095`  
**Scenario** A remote move leaves a tag, old image annotation, or review at a now-vacant path. New Note or Upload checks the disk and manifest for the name, then creates a fresh identity there. The new file can inherit those records and Check Notebook sees an existing owner path.  
**Fix direction** Use the same destination-record check for name reuse, and preserve record ownership across the final create commit.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, seed records at a vacant shared path and create a new note or upload an image there.

#### S30. A stale whole-file text save can recreate or overwrite a shared entry

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `shared-move-in-app`  
**Where** `src/app/api/files/route.ts:96`, `src/app/api/files/route.ts:162`, `src/lib/collab/shared-writes.ts:462`, `electron/collab/notebooks/project.ts:3120`  
**Scenario** A text-type file stored as a blob is open while a collaborator moves, deletes, or replaces it. The shared save branch drops `baseVersion` and sends `write-blob` without the file ID or base hash. At the old path it can create a new identity, or replace the blob of a different file.  
**Fix direction** Require the original file ID and blob revision for replacement, and separate replace from creation.  
**Test** In `scripts/editor/collab-critical-storage.test.ts`, save stale edits after a move, a delete, and same-path replacement.

#### S31. Remote changes omit most of the local record stores

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `remote-move`  
**Where** `electron/collab/notebooks/project.ts:3501`, `src/components/libera/collab/forward-search-changes.ts:75`, `src/lib/collab/shared-writes.ts:708`, `src/lib/storage/integrity.ts:1023`  
**Scenario** A collaborator renames or removes a file this installation tagged, starred, reviewed, or attached to a reference. The event forwarding covers PDF and audio sidecars and search invalidation. Image annotations, definitions, stars, tags, local reviews, agent history, attachments, and tether state receive no corresponding identity transition. Reuse of the old path can reassign them.  
**Fix direction** Apply a persistent, per-installation record transition keyed by project and file ID on writers and followers.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, simulate remote rename and delete with every local store populated, then reuse the old path.

#### S32. A move event’s file ID is discarded before a draft is retargeted

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
**Where** `src/lib/collab/ui/tree-changes.ts:48`, `src/components/libera/use-libera-workspace.ts:4043`, `src/components/libera/use-libera-workspace.ts:3958`, `src/lib/storage/files.ts:96`  
**Scenario** A moves to `b.md`, then B occupies `b.md` before the event fetch completes. The renderer fetches the destination from disk, discards the event’s ID, and applies the mapping by source path. The old draft or unsaved ink can follow B. The simultaneous-mapping fix for November 19 finding 24 does not validate the lookup.  
**Fix direction** Verify both the tab’s identity and the destination identity against the event. Resolve the current path by ID for chained moves.  
**Test** In `scripts/editor/shared-tree-changes.test.ts`, delay the first fetch, reuse the destination, and verify that the draft stays with A.

#### S33. A follower misses a tab move after the bounded destination retries

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
**Where** `src/lib/collab/ui/tree-changes.ts:68`, `src/components/libera/use-libera-workspace.ts:4043`, `electron/collab/notebooks/project.ts:1255`  
**Scenario** OneDrive delivers the destination after the final lookup retry. The mapping is discarded. The later arrival emits `files-changed`, which refreshes metadata but carries no move to replay. The open tab stays at the old path. This is the remaining late-arrival case from November 19 finding 24.  
**Fix direction** Retain unresolved moves by file ID and retry on verified arrival or a later manifest read.  
**Test** In `scripts/editor/shared-tree-changes.test.ts`, deliver the destination after all configured retry delays and retain the open draft.

#### S34. Remote moves update live tabs but omit saved workspace state

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `renderer-state`  
**Where** `src/components/libera/use-libera-workspace.ts:603`, `src/components/libera/use-libera-workspace.ts:4007`, `src/components/libera/use-libera-workspace.ts:4053`, `src/components/libera/use-saved-workspaces.ts:364`  
**Scenario** Save a workspace with a tab and draft, close it, then receive a remote rename. The host-event branch calls only the live retarget path. Reopening the workspace can restore the old path, and a later occupant can receive the stale draft.  
**Fix direction** Apply confirmed remote mappings to saved workspaces through the same durable workspace change path used by explicit operations.  
**Test** In `scripts/editor/shared-tree-changes.test.ts`, rename a file while its saved workspace is inactive and then reopen it.

#### S35. PDF and audio move replay disappears on restart or event loss

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `sidecars`  
**Where** `src/lib/storage/pdf-sidecars.ts:201`, `src/lib/storage/pdf-sidecars.ts:220`, `src/lib/storage/transcripts.ts:458`, `src/components/libera/collab/forward-search-changes.ts:42`, `electron/collab/notebooks/project.ts:429`  
**Scenario** The destination is absent, the renderer forwards the move, and Next restarts before delivery. The pending move lives in memory. A restarted follower builds from an empty layout and may emit only additions. A move that happened before a forwarding window subscribed has the same gap. November 19 finding 14 remains at these boundaries.  
**Fix direction** Persist and replay a host-generated mapping acknowledged by the local record consumer.  
**Test** In `scripts/editor/collab-critical-storage.test.ts`, restart Next between event receipt and delivery, and separately start the renderer after the move.

#### S36. Legacy PDF sidecars cannot follow even a known shared rename

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `sidecars`  
**Where** `src/lib/storage/pdf-sidecars.ts:178`, `src/lib/storage/pdf-sidecars.ts:315`, `src/lib/storage/pdf-sidecars.ts:341`, `src/lib/collab/shared-writes.ts:705`  
**Scenario** Rename a PDF whose annotation, outline, or definition sidecar has no recorded hash. The follow handler requires a hash match and shared upkeep skips ordinary reattachment. The shared move wrapper reports success, and the old sidecar can stay at the old path indefinitely.  
**Fix direction** Capture ownership before explicit moves. For remote changes, expose ambiguous legacy records for review using the host’s stable move evidence.  
**Test** In `scripts/editor/notebook-shared-move-integrity.test.ts`, move a PDF whose legacy records lack source identity and assert a recovery outcome for each record.

#### S37. A live PDF import can pair an old sidecar read with a new PDF path

**Severity** P1 · **Confidence** likely · **Area** `live-pdf`  
**Where** `electron/collab/notebooks/pdf-marks.ts:200`, `electron/collab/notebooks/pdf-marks.ts:377`, `electron/collab/notebooks/pdf-marks.ts:397`, `electron/collab/notebooks/pdf-marks.ts:534`  
**Scenario** A rename arrives while an import reads a sidecar. The import captures one target, while `sync` changes `doc.path` and the later ownership check consults that mutable path. With a reused path and legacy mtime evidence, the sidecar can be attributed to the wrong PDF.  
**Fix direction** Capture and revalidate a single file-ID, path, and blob-version tuple throughout the import.  
**Test** In `scripts/collab/pdf-runtime-recovery.test.ts`, pause a legacy sidecar read, rename the PDF, reuse the old name, and resume import.

#### S38. A shared recording can receive an old pending transcript after a move

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `sidecars`  
**Where** `src/lib/storage/transcripts.ts:141`, `src/lib/storage/transcripts.ts:148`, `src/lib/storage/transcripts.ts:429`, `src/lib/storage/transcripts.ts:475`  
**Scenario** A pending local transcript follows a move by copying the old sidecar. If a second rename happens before the first copy arrives, the second event sees no source sidecar to copy. Conversely, a replacement recording at a reused path can display the old pending correction in preference to its companion, with the mismatch reported only as stale.  
**Fix direction** Keep pending transcript state with the recording ID and track its current companion revision across moves.  
**Test** In `scripts/editor/collab-critical-storage.test.ts`, run a delayed two-hop rename and a subsequent path reuse with a pending correction.

#### S39. External case and Unicode renames disagree with the verifier indefinitely

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `external-move-shared`  
**Where** `electron/collab/notebooks/project.ts:2319`, `electron/collab/notebooks/project.ts:2363`, `electron/collab/notebooks/project.ts:2542`, `src/lib/storage/integrity.ts:1023`  
**Scenario** Finder changes `Résumé.pdf` to a case or normalization variant. The scanner’s folded map treats it as the same occupied manifest path and excludes it from new-file candidates. It emits no rename mapping. The verifier’s exact-segment rule can mark the old records missing even though the scanner considers the file present. This is a residual November 19 finding 22 case.  
**Fix direction** Define how an observed alternate spelling is represented and make the host, tree, and verifier agree while preserving the ID.  
**Test** In `scripts/editor/notebook-oracle-agreement.test.ts`, exercise external case and normalization changes of both a file and its parent.

#### S40. An external rename plus edit creates a second shared identity

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `external-move-shared`  
**Where** `electron/collab/notebooks/project.ts:2617`, `electron/collab/notebooks/project.ts:2661`, `electron/collab/notebooks/project.ts:2697`  
**Scenario** Rename `a.md` and edit the new path before the next scan, with or without the app open. The hash no longer matches, so the scanner can restore `a.md` and import the edited version as a new document. Threads, suggestions, ink, and local records stay with the restored identity. November 19 finding 19 explicitly left this case open.  
**Fix direction** Offer a recoverable rename reconciliation when observations support a move but bytes differ. Preserve both inputs and the original document ID pending resolution.  
**Test** In `scripts/collab/audit-1119-scanner.test.ts`, rename and edit between scans and assert the original document’s annotations remain recoverable with the edit.

#### S41. A unique byte match can still select the wrong external rename

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `external-move-shared`  
**Where** `electron/collab/notebooks/project.ts:2621`, `electron/collab/notebooks/project.ts:2629`, `electron/collab/notebooks/project.ts:2646`  
**Scenario** OneDrive temporarily hides `a.md`. The user independently places a byte-identical file at `b.md`. It is the sole matching candidate, so the scanner gives B the shared ID, threads, and history of A. The uniqueness checks from November 19 finding 19 address competing matches, leaving this ambiguous one-to-one case.  
**Fix direction** Require stronger evidence of a move or ask for reconciliation before assigning an existing identity when absence or delivery is uncertain.  
**Test** In `scripts/collab/notebooks-synced-folder.test.ts`, hide the old path while creating an independently copied identical file.

#### S42. External rename inference uses weaker companion and type rules than explicit rename

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `external-move-shared`  
**Where** `electron/collab/notebooks/project.ts:2625`, `electron/collab/notebooks/project.ts:2647`, `electron/collab/notebooks/project.ts:2930`, `electron/collab/notebooks/project.ts:3611`  
**Scenario** Externally rename a Markdown note with Python code, or rename a Markdown document to a different supported text kind. The inferred move keeps the old document kind and handles ink and transcripts, with no Python move and no equivalent type-loss preflight.  
**Fix direction** Share the explicit operation’s type and companion planner with inferred moves, including a recoverable conflict outcome.  
**Test** In `scripts/collab/audit-1119-scanner.test.ts`, externally rename a note with Python code and separately change its text type.

#### S43. Whole-folder external moves leave two folder identities

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `external-move-shared`  
**Where** `electron/collab/notebooks/project.ts:2358`, `electron/collab/notebooks/project.ts:2623`, `electron/collab/notebooks/project.ts:2664`, `electron/collab/notebooks/project.ts:2716`  
**Scenario** Rename a directory that has an explicit manifest folder entry. Its files may individually match, but folder records are excluded from rename pairing. The old folder remains in the manifest and can be recreated while a new folder gets another ID. A move out to a local notebook likewise restores the shared source with no indication that the external move became a copy.  
**Fix direction** Recognize or reconcile directory transitions and report cross-notebook restoration where shared deletion requires explicit intent.  
**Test** In `scripts/collab/notebooks-sync.test.ts`, externally move a folder with empty descendants and separately move a tracked file into a local notebook.

#### S44. Retired-path history can both resurrect deleted content and suppress intentional restoration

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `external-move-shared`  
**Where** `electron/collab/notebooks/project.ts:1135`, `electron/collab/notebooks/project.ts:2598`, `electron/collab/notebooks/project.ts:2754`, `electron/collab/notebooks/project.ts:2768`  
**Scenario** A delayed version whose hash the writer never recorded can be imported as a new ID at a retired path. Conversely, intentionally copying back byte-identical content at a retired path always looks late. A follower’s retirement can have no hashes, making every unexplained replacement look late after promotion. This is the remaining G23/STALE-7 classification gap.  
**Fix direction** Preserve retirement evidence across handoff and expose ambiguous returns as explicit restore or import choices.  
**Test** In `scripts/collab/notebooks-synced-peers.test.ts`, cover an unknown prior version, an intentional identical restore, and a hashless follower retirement.

#### S45. A companion save can recreate a record at a vacated owner path

**Severity** P2 · **Confidence** likely · **Area** `records`  
**Where** `src/lib/storage/ink.ts:327`, `src/lib/storage/ink.ts:347`, `src/lib/storage/ink.ts:399`, `src/lib/storage/transcripts.ts:199`, `electron/collab/notebooks/project.ts:3120`  
**Scenario** An ink or transcript save starts from an existing file, then a remote rename or delete moves the owner before publication. The companion request includes a companion precondition when available, but no owner-file precondition. A first save can create the companion under the old path, especially while a follower still has the source bytes.  
**Fix direction** Bind companion mutations to the owner file ID and current path at the host, and resolve or refuse a stale owner before creating a companion.  
**Test** In `scripts/collab/notebooks-sync.test.ts`, hold a first ink or transcript write across a remote rename and delete.

#### S46. Remote move staging trusts a source’s size and mtime as proof of ownership

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `host-materialize`  
**Where** `electron/collab/notebooks/project.ts:1004`, `electron/collab/notebooks/project.ts:1019`, `electron/collab/notebooks/project.ts:1443`  
**Scenario** A provider or editor puts a different same-size file at the source and preserves mtime. `holdsOwnBytes` returns true without hashing, and staging moves the replacement. Even after a successful hash read, the stage operation uses the root/lease guard without a source-content check. This is an incomplete fix for November 19 finding 4.  
**Fix direction** Verify source content or a version with equivalent strength and fence staging to that source.  
**Test** In `scripts/collab/audit-1119-materialize.test.ts`, replace the source with the same stats and separately replace it after the hash observation.

#### S47. A remote move can separate a local-only destination file from its records

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `host-materialize`  
**Where** `electron/collab/notebooks/project.ts:1037`, `electron/collab/notebooks/project.ts:1421`, `src/lib/storage/integrity.ts:1023`  
**Scenario** A writer has a locally created `b.png` with annotations and tags that have yet to be imported. A collaborator moves a manifest file to `b.png`. The host archives the existing bytes and publishes the other file at `b.png`. The destination’s path-based records remain there and can now belong to the wrong image.  
**Fix direction** Preserve an identity-bound recovery mapping for displaced content and protect its local records before the incoming entry claims the path.  
**Test** In `scripts/collab/audit-1119-materialize.test.ts`, place a local-only annotated image at a collaborator’s rename destination.

#### S48. Startup move recovery acts on an obsolete destination before reading current authority

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `host-materialize`  
**Where** `electron/collab/notebooks/project.ts:429`, `electron/collab/notebooks/move-journal.ts:78`, `electron/collab/notebooks/move-journal.ts:99`, `electron/collab/notebooks/move-journal.ts:151`  
**Scenario** A move to `b.md` is staged when the process stops. Before restart a collaborator moves the same ID to `c.md`. Startup compares against the journal’s `b.md` and can discard the stage as a duplicate or archive it. It consumes the record before the manifest-aware replay can resolve `c.md`. This is a remaining STALE-3/G31 recovery gap.  
**Fix direction** Preserve the stage until a caught-up manifest supplies the current destination or confirms the identity was removed.  
**Test** In `scripts/collab/notebooks-sync-recovery.test.ts`, restart after staging while a peer moves the ID again.

#### S49. A bounded read budget can repeatedly starve later files

**Severity** P2 · **Confidence** likely · **Area** `external-move-shared`  
**Where** `electron/collab/notebooks/project.ts:2352`, `electron/collab/notebooks/project.ts:2400`, `electron/collab/notebooks/project.ts:2542`, `electron/collab/notebooks/project.ts:2579`, `electron/collab/notebooks/project.ts:2750`  
**Scenario** Earlier tracked blobs are repeatedly dirty, unstable, or failing upload. Each pass starts in the same order and those files can consume the budget before later paths or any fresh files are read. A recurring retry need not advance the scan frontier.  
**Fix direction** Carry a scan cursor or give deferred groups fair turns and back off failed paths individually.  
**Test** In `scripts/collab/audit-1119-scan-liveness.test.ts`, keep early blobs pending across multiple passes and require import of a late file.

#### S50. Large scanner and folder changes can still produce unsendable manifest updates

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `host-sqlite`  
**Where** `electron/collab/notebooks/project.ts:2716`, `electron/collab/notebooks/project.ts:2736`, `electron/collab/notebooks/project.ts:3184`, `electron/collab/core/outbound.ts:358`, `electron/collab/core/outbound.ts:382`  
**Scenario** One scan discovers thousands of long-path entries, or a folder rename adds a large ink subtree to its first batch. The scan writes one transaction, and folder batching accounts for the primary entries before appending companions. An oversized Yjs update remains unsendable and can block dependent work. This is a remaining DL-7/November 19 finding 33 path.  
**Fix direction** Bound transactions by actual encoded size, including companion operations, and make an unsendable operation recoverable.  
**Test** In `scripts/collab/host-sync.test.ts`, lower the update limit and drive both a scan import and a companion-heavy folder rename through it.

#### S51. A stalled filesystem operation can hold the host and a Next-side record lock

**Severity** P1 · **Confidence** likely · **Area** `deadlock`  
**Where** `electron/collab/notebooks/project.ts:800`, `electron/collab/notebooks/project.ts:2509`, `electron/collab/notebooks/project.ts:3275`, `electron/collab/notebooks/scan-reads.ts:85`, `src/lib/collab/host-client.ts:67`, `src/lib/storage/ink.ts:338`  
**Scenario** A provider hangs on a post-upload reread, staged blob read, or the stat after a timed scan read. The project queue stops. Next’s file operations have no call deadline, and ink holds its per-record lock across such calls. Later saves to that record cannot progress. This is the remaining filesystem chain from DL-1/November 19 finding 30.  
**Fix direction** Bound the whole provider operation, return an explicit uncertain outcome for mutations, and release Next locks while durable host work is pending.  
**Test** In `scripts/collab/audit-1119-scan-liveness.test.ts`, hang the post-read stat and upload reread, then verify later operations have a bounded outcome.

#### S52. A failure to place a folder can still report materialization complete

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `host-materialize`  
**Where** `electron/collab/notebooks/project.ts:781`, `electron/collab/notebooks/project.ts:1056`, `electron/collab/notebooks/project.ts:1071`, `electron/collab/notebooks/service.ts:2170`  
**Scenario** Creating an empty manifest folder fails on the working filesystem. The folder loop logs the refusal, then a layout record is still installed. `isMaterialized()` checks the record and requires a hash only for nonfolders, so join can return `materialized: true`. The folder error also does not set `needsRetry`.  
**Fix direction** Track confirmed placement for folders and verify it in join status with an actionable error and retry.  
**Test** In `scripts/collab/notebooks-reconcile-view.test.ts`, refuse creation of an empty shared folder after join.

#### S53. The catch-up gate can remain open across a manifest rebuild or reconnect

**Severity** P1 · **Confidence** likely · **Area** `host-materialize`  
**Where** `electron/collab/notebooks/project.ts:510`, `electron/collab/notebooks/project.ts:865`, `electron/collab/notebooks/project.ts:877`, `electron/collab/notebooks/project.ts:1839`, `electron/collab/core/doc-hub.ts:863`  
**Scenario** A writer has opened the manifest once. It disconnects or rolls back a rejected manifest update while cloud changes continue to arrive. Catch-up is remembered by doc ID for the lifetime of the runtime. The old eligibility can survive into a scan or materialization while the replacement state is still catching up. This is an incomplete catch-up boundary adjacent to November 19 finding 2.  
**Fix direction** Bind disk eligibility to a validated manifest and document generation, and explicitly handle reconnect or rollback before applying uncertain disk work.  
**Test** In `scripts/collab/notebooks-sync-recovery.test.ts`, deliver cloud changes between a manifest rollback and the successful reopen.

#### S54. Control operations can report success for a manifest update still only in memory

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `host-sqlite`  
**Where** `electron/collab/core/doc-hub.ts:324`, `electron/collab/core/doc-hub.ts:647`, `electron/collab/core/doc-hub.ts:656`, `electron/collab/notebooks/project.ts:1492`, `electron/collab/notebooks/project.ts:3238`  
**Scenario** SQLite returns `BUSY` or an I/O error during a rename. The Yjs transaction has changed the live manifest and the update is parked for an in-memory retry. The control caller can proceed into materialization and return success. A crash before retry loses the change while disk or Next-side records may already have moved.  
**Fix direction** Expose a durable commit result to control callers and defer disk materialization and record follow-up for undurable changes.  
**Test** In `scripts/collab/host-store.test.ts` and `scripts/collab/notebooks-sync-recovery.test.ts`, fail the manifest append and terminate before its retry.

#### S55. SQLite failure while handling `Opened` can leave a live socket with a stuck document

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `host-sqlite`  
**Where** `electron/collab/core/doc-hub.ts:796`, `electron/collab/core/doc-hub.ts:815`, `electron/collab/core/doc-hub.ts:712`, `electron/collab/core/sync-client.ts:701`  
**Scenario** `updateDocMeta` or `noteServerSeq` throws while processing `Opened`. Those writes are outside the append-failure path that schedules a reopen. The dispatcher logs and keeps the connection alive. The first open can remain incomplete until unrelated reconnect or recovery activity. This is a distinct SQLite failure path from the fixed DATA-2 remote append case.  
**Fix direction** Retry or reopen on failure of any durable step in `Opened`, and keep the document in an explicit catch-up state.  
**Test** In `scripts/collab/host-sync.test.ts`, inject one `BUSY` at each metadata write while keeping the socket healthy.

#### S56. SQLite’s owner lock can admit two hosts

**Severity** P1 · **Confidence** likely · **Area** `host-sqlite`  
**Where** `electron/collab/core/store.ts:379`, `electron/collab/core/store.ts:394`, `electron/collab/core/store.ts:432`, `electron/collab/core/store.ts:551`, `server/src/sync/server.ts:350`  
**Scenario** One process creates the lock file and is paused before writing its payload, or a live host misses its heartbeat during a prolonged suspend. A second process can remove the lock. The old owner’s next heartbeat simply returns on token mismatch and its SQLite connection remains active. Two owners can race schema upgrades or run distinct live hubs under the same persisted client identity.  
**Fix direction** Make ownership acquisition and loss enforceable for the full database lifetime, including contention during initial lock publication.  
**Test** In `scripts/collab/host-store.test.ts`, pause between exclusive creation and payload write, and separately resume an old owner after takeover.

#### S57. One unopened PDF command can block every later offline command

**Severity** P1 · **Confidence** likely · **Area** `deadlock`  
**Where** `electron/collab/core/host.ts:198`, `electron/collab/core/pending-commands.ts:131`, `electron/collab/core/pending-commands.ts:157`, `server/src/sync/server.ts:244`  
**Scenario** The first durable command is a PDF comment whose document never opens, for example because the project is at its PDF document cap. The host turns that into a transient retry. The queue retries only its first row and blocks unrelated later comments and decisions across the account.  
**Fix direction** Bound prerequisites and allow independent document queues to progress. Keep blocked commands visible and recoverable.  
**Test** In `scripts/collab/host-commands.test.ts`, prevent a PDF hub from opening and require a subsequent unrelated comment to settle.

#### S58. Command replay can apply an effect twice

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `server-sync`  
**Where** `server/src/api/commands.ts:116`, `server/src/api/commands.ts:124`, `server/src/api/commands.ts:127`  
**Scenario** Two submissions with one command ID both see no result, or the process exits after running the handler and before persisting its receipt. The unique constraint deduplicates receipts, but handlers with independently allocated effects can execute twice. November 12 WRITE-5 is still present.  
**Fix direction** Claim the command ID before applying the effect and make the effect and receipt atomic or resumably idempotent.  
**Test** In `scripts/collab/integration-host-server.test.ts`, overlap duplicate commands and inject a stop between the mutation and receipt.

#### S59. Manifest reference validation checks document kind but fails to bind file identity

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `server-sync`  
**Where** `server/src/sync/validate.ts:420`, `server/src/sync/server.ts:470`, `electron/collab/notebooks/project.ts:1626`  
**Scenario** A malformed or recovered manifest names one existing document under two file IDs or associates a document with a different file ID. The reference validator checks project and kind. The host’s runtime is keyed by doc ID and overwrites its `fileId` when it sees the second entry. Materialization and records can follow the wrong member. This is the identity part left by November 19 finding 35.  
**Fix direction** Validate the file-ID/document binding and uniqueness of document ownership before accepting the manifest change.  
**Test** In `scripts/collab/integration-host-server.test.ts`, submit a manifest with conflicting file ownership for an otherwise valid document and assert refusal.

#### S60. The document-delete API can tombstone a live manifest target

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `server-sync`  
**Where** `server/src/api/documents.ts:186`, `server/src/sync/server.ts:383`, `server/src/sync/validate.ts:429`, `electron/collab/notebooks/project.ts:1626`  
**Scenario** A document is deleted through the document API while the manifest still points to it, or after reference validation and before a pending manifest publication. The API marks the DB row deleted independently. The file stays listed, while its hub cannot open and the legitimate entry has no bytes on a new device.  
**Fix direction** Couple notebook document deletion to the manifest transition and revalidate references at the persistence boundary.  
**Test** In `scripts/collab/integration-host-server.test.ts`, attempt an API deletion of a referenced note and interleave document deletion with first publication.

#### S61. PostgreSQL takedown and document deletion still acquire intersecting locks in opposite orders

**Severity** P2 · **Confidence** likely · **Area** `deadlock`  
**Where** `server/src/api/projects.ts:208`, `server/src/sync/store.ts:145`, `server/src/sync/store.ts:193`, `server/src/api/documents.ts:192`, `server/src/auth/access.ts:135`  
**Scenario** Manifest persistence locks the manifest row and later tombstones a content row. Takedown locks document IDs in sorted order and can hold that content row before waiting for the manifest. The REST document-delete path also locks membership before the document. PostgreSQL can abort one transaction and retrying a busy notebook can repeat the conflict. This is an incomplete November 19 finding 32 fix.  
**Fix direction** Use one project mutation lock order across manifest tombstones, REST deletion, and closing/takedown.  
**Test** Extend `server/test/audit-1119-takedown.test.ts` with a real PostgreSQL interleaving where the content document sorts before the manifest.

#### S62. Concurrent project deletion can miss the final orphaned blob

**Severity** P3 · **Confidence** likely · **Area** `server-sync`  
**Where** `server/src/api/projects.ts:231`, `server/src/blobs/gc.ts:29`, `server/src/blobs/gc.ts:45`  
**Scenario** Two projects are the last holders of the same blob. Each takedown deletes its own reference and checks for another before either commits. Each can see the other’s still-visible row and skip registering the orphan. The collector never sees the now-unreferenced hash.  
**Fix direction** Serialize last-reference retirement by hash or periodically reconcile untracked objects against the reference table.  
**Test** Extend `server/test/audit-1119-takedown.test.ts` or add a PostgreSQL blob-GC test with concurrent final-reference deletion.

#### S63. Check Notebook can pass a broken manifest projection

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
**Where** `src/lib/storage/integrity.ts:492`, `src/lib/storage/integrity.ts:507`, `src/lib/storage/integrity.ts:580`, `electron/collab/notebooks/project.ts:3039`  
**Scenario** A manifest-only file never arrives, an old disk file survives a remote delete, or a replacement blob has stale bytes. The verifier inventories the disk and has no manifest comparison. It can pass an empty follower, treat a retired disk file as a valid owner, or label a legitimate record orphaned during delivery. The disk-only scope is documented, so the gap is the missing sync verdict and ability to distinguish transient lag.  
**Fix direction** Add a read-only host comparison using a stable manifest view and report unavailable or changing authority as partial.  
**Test** In `scripts/editor/notebook-integrity.test.ts`, cover manifest-only, disk-only, stale-version, and actively materializing entries.

#### S64. Live PDF annotation links are judged using a lagging sidecar

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
**Where** `src/lib/storage/integrity.ts:966`, `src/lib/storage/annotations.ts:366`, `electron/collab/notebooks/pdf-marks.ts:478`  
**Scenario** A live mark exists on the server but its recovery sidecar is absent or behind on the follower. Check Notebook flags the link as broken. A removed mark that survives in the stale sidecar can pass.  
**Fix direction** Ask the live PDF authority for IDs when available and mark the annotation-position check partial when current IDs cannot be established.  
**Test** In `scripts/editor/notebook-integrity.test.ts`, add and remove a live mark while delaying its sidecar.

#### S65. The verifier predicts reattachment that shared upkeep explicitly skips

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `verifier`  
**Where** `src/lib/storage/integrity.ts:756`, `src/lib/storage/integrity.ts:788`, `src/lib/storage/pdf-sidecars.ts:341`, `src/lib/storage/pdf-sidecars.ts:371`, `src/lib/storage/ink.ts:568`  
**Scenario** A PDF or ink record has one same-byte candidate at a different path. Check Notebook says the record will follow on the next open. Shared PDF upkeep requires its specific pending mapping or a return to the old path for set-aside records, and shared ink upkeep exits entirely. The report can keep promising repair indefinitely.  
**Fix direction** Share the actual eligibility rules between the verifier and upkeep, including shared pending moves and archive handling.  
**Test** In `scripts/editor/notebook-oracle-agreement.test.ts`, compare verifier predictions with upkeep for shared active paths and archived recovery copies.

#### S66. Try to fix offers a dead end for shared records

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `repair`  
**Where** `src/components/libera/notebook-integrity-dialog.tsx:165`, `src/components/libera/notebook-integrity-dialog.tsx:236`, `src/lib/storage/repair.ts:111`, `docs/features/notebook-integrity.md:93`  
**Scenario** A shared move leaves an old tag or annotation. The move tells the user to run Check Notebook. The dialog offers Try to fix and both the plan and apply routes refuse it. Even a uniquely named local record with a known shared move has no supported recovery action.  
**Fix direction** Expose the actual capability in the report and offer a host-coordinated recovery path for local records. Keep name-based pairing for the manual repair workflow.  
**Test** In `scripts/editor/notebook-oracle-agreement.test.ts`, create a shared orphan and assert that the report’s offered action can actually be completed.

#### S67. Acknowledge advertises removals it always refuses on shared notebooks

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `acknowledge`  
**Where** `src/lib/storage/integrity.ts:764`, `src/lib/storage/integrity.ts:1025`, `src/components/libera/notebook-integrity-dialog.tsx:166`, `src/lib/storage/cleanup.ts:371`, `src/lib/storage/cleanup.ts:542`  
**Scenario** The report marks stale cache or confirmed obsolete local records as clearable. The dialog offers Acknowledge, but GET and POST both use `assertRepairable`, including for local-only archive records under a shared root. The refusal protects unsettled shared data, while users cannot clear even safe local findings.  
**Fix direction** Return action eligibility with findings. Allow narrowly scoped local cleanup only when ownership and manifest state are established at commit.  
**Test** In `scripts/editor/notebook-cleanup.test.ts`, distinguish a confirmed obsolete local cache, a local archive record, and a follower record awaiting delivery.

#### S68. A share can start during migration, Try to fix, or Acknowledge

**Severity** P1 · **Confidence** likely · **Area** `lifecycle`  
**Where** `electron/collab/notebooks/service.ts:1683`, `electron/collab/notebooks/service.ts:1784`, `electron/collab/notebooks/service.ts:2015`, `src/lib/storage/migration.ts:1817`, `src/lib/storage/migration.ts:1880`, `src/lib/storage/cleanup.ts:542`, `src/lib/storage/migration-fence.ts:157`  
**Scenario** Next validates a local notebook and starts applying a migration or cleanup. The host concurrently snapshots it and installs a shared marker. The process-local fence does not reserve the lifecycle transition, and a running local operation can proceed into publication, unlink, or finalization after the notebook becomes shared. If interrupted, migration resume then refuses the shared notebook.  
**Fix direction** Use a cross-process lifecycle reservation from before the host captures its share input through marker installation. Revalidate the reservation at destructive commits.  
**Test** In `scripts/collab/notebooks-share-lifecycle-recovery.test.ts`, pause a migration or cleanup after its local guard and attempt to share the same root.

#### S69. Initial sharing can delete the only copy of a newer local transcript

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `lifecycle`  
**Where** `electron/collab/notebooks/transcript-conversion.ts:64`, `electron/collab/notebooks/transcript-conversion.ts:78`, `electron/collab/notebooks/service.ts:1784`, `electron/collab/notebooks/service.ts:2020`  
**Scenario** A recording has an older `.transcript` companion left by takedown or an interrupted share and a newer hidden local transcript. Conversion preserves the existing companion but still lists the local sidecar for deletion after marker installation. The share publishes the older transcript and removes the correction. This is a surviving edge of November 19 finding 18.  
**Fix direction** Confirm that the uploaded companion contains the sidecar version before removing the local file. Surface conflicts and preserve both versions.  
**Test** In `scripts/collab/notebooks-share-retry.test.ts`, seed differing companion and sidecar transcripts, then repeat with a local edit during upload.

#### S70. Local Markdown review migration can orphan comments or attach them to a replacement note

**Severity** P1 · **Confidence** likely · **Area** `lifecycle`  
**Where** `electron/collab/control/review-migration.ts:58`, `electron/collab/control/routes-threads.ts:402`, `electron/collab/control/routes-threads.ts:428`, `electron/collab/control/routes-threads.ts:464`  
**Scenario** Share a notebook with local review comments. Before running the optional comment transfer, another member renames the note and puts a similar note at the old path. Target selection resolves the stored local key against the current project. Comments may be skipped if the path vanished, or migrate to the new document and be marked transferred.  
**Fix direction** Establish the local-review-to-file-ID mapping when the notebook is first shared, then use it to resolve the current document for transfer.  
**Test** In `scripts/collab/p2-migration.test.ts`, share, rename and reuse a path before migrating local comments.

#### S71. Takedown can delete server-only review and PDF comment work

**Severity** P1 · **Confidence** confirmed by reading the code · **Area** `lifecycle`  
**Where** `electron/collab/notebooks/project.ts:680`, `electron/collab/notebooks/project.ts:711`, `electron/collab/notebooks/pdf-marks.ts:505`, `electron/collab/notebooks/pdf-marks.ts:547`, `server/src/api/projects.ts:228`  
**Scenario** The owner takes down a notebook with shared Markdown threads or with current PDF comments unavailable to this device’s export. The conversion exports text, blobs, and open PDF sidecars. It has no Markdown thread, suggestion, or review export, and final PDF comment reads may fall back to cached sidecar contents. The server then deletes the authority. This is a remaining export gap after November 19 finding 8’s fence work.  
**Fix direction** Make the frozen export enumerate every relevant document and record store, and require a verified or explicitly incomplete recovery result before project deletion.  
**Test** In `scripts/collab/notebooks-takedown.test.ts`, include shared-only Markdown comments, pending suggestions, and a PDF with a delayed comment fetch.

#### S72. A receiving device cannot retrieve final binaries after takedown

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `lifecycle`  
**Where** `electron/collab/notebooks/service.ts:1420`, `electron/collab/notebooks/project.ts:753`, `server/src/api/projects.ts:231`, `server/src/api/blobs.ts:39`  
**Scenario** The owner takes down a project while another installation still lacks its last binary version. The receiving installation tries to recover binaries after the deletion event, when the blob route no longer has project membership or blob rows. Without cached bytes, it keeps an older or missing file and may write an incomplete-takedown note. This is DATA-17, adjacent to G03.  
**Fix direction** Provide a bounded terminal recovery export or identify a complete downloadable recovery source before retiring access.  
**Test** In `scripts/collab/notebooks-takedown.test.ts`, delay delivery to a separate receiving root and take down the share without a cached final blob.

#### S73. Rebinding a moved notebook root leaves library-level records under its former name

**Severity** P2 · **Confidence** confirmed by reading the code · **Area** `lifecycle`  
**Where** `electron/collab/notebooks/service.ts:742`, `src/lib/storage/paths.ts:192`, `src/lib/storage/integrity.ts:1063`  
**Scenario** Rename a shared notebook’s top-level folder outside the app. Host discovery can rebind the project to the new root, while stars, tags, review keys, agent history, attachments, and saved workspace paths still use the former notebook prefix. Reusing that notebook name can hide the stale records from the missing-path checks. G18 restores the host binding without repairing these record stores.  
**Fix direction** Emit and durably apply the root identity transition to library-level records when the host rebinds.  
**Test** In `scripts/collab/notebooks-boundary-recovery.test.ts` and `scripts/editor/notebook-shared-move-integrity.test.ts`, rename a shared root with records populated, then reuse the old name.

#### S74. The sync reference still describes external deletes that the scanner will restore

**Severity** P3 · **Confidence** confirmed by reading the code · **Area** `docs`  
**Where** `docs/features/notebook-sync.md:39`, `docs/features/notebook-sync.md:93`, `electron/collab/notebooks/project.ts:2661`, `docs/features/notebook-sync.md:155`  
**Scenario** The working-folder description and Matrix A lead a reader to expect deletion after a complete scan and grace period. Current code restores unmatched missing entries and requires explicit host deletion. The same document still labels the original G30–G33 reproductions open, despite current guards that address those original cases.  
**Fix direction** Update the described behavior and mark the original cases separately from the surviving failure modes, with current regression references.  
**Test** In `scripts/collab/notebooks-sync.test.ts`, assert external deletion restores working bytes while explicit host deletion retires the identity.

### Coverage

- **Read in full** — `electron/collab/notebooks/layout.ts`, `manifest-intents.ts`, `documents.ts`, `scan-reads.ts`, `transcript-conversion.ts`; `electron/collab/core/sqlite.ts`, `authority.ts`, `pending-commands.ts`; `server/src/api/blobs.ts`, `server/src/blobs/gc.ts`, `server/src/db/database.ts`, `migrate.ts`; `src/lib/collab/ui/tree-changes.ts`, `tree-file-ids.ts`, `src/lib/storage/shared-source.ts`; `src/components/libera/collab/forward-search-changes.ts`; the files and batch routes, and the notebook verify, repair, and cleanup routes. I read the multi-file selection feature doc in full.
- **Read the relevant sections and skimmed surrounding material** — the other four feature docs, the five November 1 audits, the November 12 and 19 audits, and the November 20 review and triage. In the host, this covered file operations, watcher and scanner, materialization, layout and retirement, staged recovery, PDF handling, share/join/rebind/revocation, persistence, outbound batching, compaction, and divergence. In the server, it covered room admission and writes, manifest validation and persistence, document and project mutations, commands, and blob lifetime. In Next and the renderer, it covered shared wrappers, file and folder handling, batch and drag/drop, workspace retargeting, verifier and cleanup, sidecar and record ownership, attachment and tether moves, and index refresh entry points. I checked the named regression files for placement of the proposed tests.
- **Unreviewed in depth** — the complete migration SQL history, full compaction-worker and recovery-ledger internals, the search worker and database implementation, every live-review reducer and server review endpoint, and all OS-specific cloud-provider behavior. I found no closed Next-to-host lock cycle in the paths traced. The stalls reported above have identifiable waits or queues. Provider races and PostgreSQL interleavings remain static findings until exercised on those systems.