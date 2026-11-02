# Sync transition review — 1 November 2026

**Five additional findings are open: four P1 and one P2 (G30–G34).** Six failing scenarios reproduce them; two adjacent controls pass. This review follows the G25–G29 fixes and checks neighboring deletion, rename, join and revocation event orders in [the sync matrices](../features/notebook-sync.md).

Production code is unchanged by this review. The [standalone probes](../../scripts/collab/audit/sync-transition-review.mjs) use disposable accounts, separate working-copy directories and a local collaboration server. Cloud delivery, filesystem delay and a placement error are simulated. The queued-operation reproduction also uses the real loopback control server.

| Finding | Priority | Reproduced result | Matrix |
|---|---|---|---|
| G30 | P1 | Deletion archiving overwrites an external text edit arriving during temporary-file IO, then archives only the shared text. | A/B: delete file; X35 |
| G31 | P1 | A rename after an interrupted move overwrites that move's sole staged external copy. Both operations report success. | A/B: rename/move; X36 |
| G32 | P1 | A pending join recreates a removed root or overwrites a delivered sharing identity; with delayed bookkeeping, private files are imported into the invited project. | A: root replacement; B: join; X37 |
| G33 | P2 | Revocation stops a runtime with an explicit create queued; the real control server returns 204 although the create never runs and its input is not retained. | B: create × removed access; X38 |
| G34 | P1 | Album revocation deletes a matching photo, state and marker from another project delivered during cleanup. | A: root replacement × revoked access; X39 |

P1 identifies data loss or unintended sharing that should be fixed before relying on the affected timing. G33 is a narrower false-success/cancellation error. No additional lock cycle was established in this pass.

## G30 — deletion archiving lacks the text content fence

**Source:** [`SharedProject.archiveRemoved()`](../../electron/collab/notebooks/project.ts), especially the disk observation followed by `writeFileAtomic(target, ..., this.diskGuard())`.

Deletion preserves shared text by writing it back to the working path before moving it to `_archive`. The root/lease guard does not compare the disk bytes observed earlier. This path does not use the content fence added to ordinary text materialization, stale-copy repair, merge resolution and terminal preservation for G26.

**Reproduction:** share `note.md`, wait for its text hub to load, and delete it through the file-operation API. Hold the archive operation's temporary-file write; deliver `external input during delete archive` at `note.md`; finish IO. Deletion returns success. The external input is absent from the working folder, `_archive` and hidden notebook bookkeeping. Only the shared text survives.

**Correction:** preserve the current external file under a content guard and write the latest CRDT text directly to a separate available recovery name, or otherwise fence every write against the observed destination. A changed source must not be overwritten simply because its shared entry was removed. A control with external input already present before the archive observation preserves both versions; the failure specifically requires input arriving after that observation.

**Test:** `deleting a text file preserves an external edit arriving during archive IO`.

## G31 — an interrupted move's staging path is reused destructively

**Source:** [`SharedProject.applyManifest()`](../../electron/collab/notebooks/project.ts), its two-phase move staging at `.libera/collab/moving/<fileId>` and the final-placement failure handler.

A failed move from staging to its destination leaves the bytes in that deterministic staging path. The failure handler advances the layout to the new path with an unknown hash. Materialization then recreates that destination from the shared baseline. There is no recovery record that reserves the existing staged bytes. A subsequent rename of the same file ID stages its new source into the same filename, replacing the earlier recovery copy.

**Reproduction:** pause normal scanning, place a distinct unimported external edit at `a.md`, and rename it to `b.md`. Inject EIO only for the staging-to-`b.md` placement. The API still reports success; the external input remains in staging while `b.md` becomes the shared baseline. Rename `b.md` to `c.md` normally. That operation reports success too. The original external input is now absent from the entire notebook, including hidden staging and `_archive`; `c.md` contains the shared baseline.

**Correction:** treat an existing staging artifact as unfinished durable work. Resume its placement or move it to a unique recovery location before reusing the staging name. Track the source/destination/file identity across failure and restart; do not advance the layout in a way that abandons staged user input. The reproduction covers an injected placement error followed by another rename, not a full process crash.

**Test:** `a later rename cannot overwrite recovery bytes left by an interrupted move`.

## G32 — a join completion trusts the folder created before its IO wait

**Source:** [`NotebookServiceImpl.finishJoin()`](../../electron/collab/notebooks/service.ts), the newly created folder followed by unguarded `writeMarker()` and registration of that root.

Initial sharing now captures root/operation identity, but invitation joining still writes its marker without a guard. The recursive parent creation and asynchronous temporary-file write can outlive removal or replacement of the newly created directory. The runtime validates the marker only after the join has overwritten it.

**Reproductions:**

- Hold marker parent-directory IO after `createFolder()` creates the join root, remove the root, then finish IO. The join recreates it, materializes content and returns 200.
- Account B joins account A's notebook. While the join's marker temp-file IO is pending, replace the root with a cloud copy of B's different private shared notebook. Deliver its valid marker and private file before its `.libera` bookkeeping. Resume the join. It overwrites B's private marker with the invited project's marker and returns 200. Its scanner imports the private file into A's project; A receives the exact private text. A's GET of B's original private project still returns 404.

Both replacement identities belong to the joining account, matching one-account cloud synchronization. The disclosure depends on marker/content arriving before bookkeeping. An earlier probe using a complete foreign state copy demonstrated marker overwrite but did not establish disclosure. Server membership checks remain intact: A receives the text through the project the client incorrectly imported it into.

**Correction:** after allocating a join folder, capture its directory incarnation, account/API lifetime and marker absence, and fence every subsequent write and registration. Cancel if that folder disappears or a different marker/root arrives. Do not let a pending join convert a different cloud identity into unexplained files eligible for import.

**Tests:** `a pending join cannot commit into a missing root`; `a pending join cannot commit into a foreign root`.

## G33 — stopping a runtime silently resolves queued explicit mutations

**Source:** [`SharedProject.enqueue()`](../../electron/collab/notebooks/project.ts), `if (this.stopped) return undefined as T`; [control-server response handling](../../electron/collab/control/server.ts), which turns an undefined successful body into HTTP 204.

Stopping sets `stopped` before waiting for the queue. Tasks admitted before that transition but not yet started therefore resolve successfully without running. This is reasonable for disposable background passes but is also used for explicit user operations, including create-file and merge resolution.

**Reproduction:** hold a member's in-flight text materialization, send a real loopback HTTP create-file request and verify it queues behind that write. Remove the member on the real server, wait for its runtime to stop, then release IO. The create responds **204 with an empty body**. There is no new manifest entry, disk file or notebook recovery copy of the submitted text. The task body never began, so server-side refusal and HTTP upload persistence cannot protect that input.

The notebook router double reports a default 200 for this undefined body; the final probe uses the real control server to establish the actual 204. No renderer input-clearing behavior is assumed.

**Correction:** distinguish discarded background tasks from cancelled explicit requests. Reject an explicit operation with an actionable stopped/revoked error if its runtime ends before execution; do not fulfill its typed result with undefined. Preserve queued input when the application promises recovery.

**Test:** `a file creation queued before revocation cannot be silently acknowledged after the runtime stops`.

## G34 — album revocation checks marker identity only once before destructive IO

**Source:** [`NotebookServiceImpl.takeAlbumAway()`](../../electron/collab/notebooks/service.ts), the photo-deletion loop and subsequent `_archive`, `.libera`, checkpoint and marker cleanup.

The method reads one marker after stopping the runtime, then performs multiple asynchronous deletions using the old root path and cached photo names. Those deletions have no root/marker fence. A replacement arriving during the first wait is treated as the album that lost access, even if it is a different valid sharing identity belonging to the same account.

**Reproduction:** B joins A's shared album. Remove B and hold its first cleanup `fs.rm(common.png)`. Replace the entire root with a cloud copy of a different real album owned by B, including its own `common.png`, second photo, valid marker and state. Resume cleanup. The different album's `common.png`, marker and state disappear; its other photo remains. B's original independent album fixture is unchanged, but the delivered working copy has been damaged by the old revocation.

**Correction:** fence every destructive commit against the complete captured folder/root identity and the relevant photo identity. Cancel cleanup when the root changes; do not remove a replacement marker or bookkeeping. A single marker read before several filesystem awaits does not establish ownership of later path contents.

**Test:** `album revocation cannot delete photos and bookkeeping from a replacement project`.

## Controls, verification and limits

| Passing control | Observed result | Limit |
|---|---|---|
| Account changes while an invitation acceptance response is pending | Existing REST cancellation returns 503; no join marker or local project is installed for the other account. | Does not protect join folder IO after a successful acceptance. |
| External input exists before deletion's archive observation | Both shared and external texts remain in `_archive`; no live file remains. | Does not protect bytes arriving during the subsequent temporary-file IO. |

The new audit reports **eight scenarios: six failing and two passing**, corresponding to five findings. Node also counts the failed parent, so its total is **9 tests, 2 passed, 7 failed**. These assertions retain required matrix behavior. The audit stays outside the normal test glob while its findings are open.

```sh
node --require ./scripts/editor/setup.cjs --import tsx --test \
  scripts/collab/audit/sync-transition-review.mjs
```

The probe passes JavaScript syntax checking and targeted ESLint. **38 selected existing tests pass**: notebook lifecycle, tree events, takedown, album host behavior, the previous lifecycle regressions and their recovery cases. No production code or previous assertions changed in this review.

The tests do not run a real OneDrive/iCloud client, real Windows sharing failures, full process/power-loss crashes or distributed production servers. They establish the named event orders and IO boundaries, not every delivery permutation. Broader clock-skew and missing-base combinations remain unverified as recorded in the main matrices.
