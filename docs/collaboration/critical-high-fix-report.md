# Collaboration findings R01–R21

Implemented in `fix/collab-critical-high`, based on `c1cbf0e`. All changes remain uncommitted. R22–R48 were not implemented. The G33/R22 scenario was excluded when running the original transition audit.

**Result: 16 Fixed, 5 Mitigated.** “Mitigated” means the data-loss path is closed conservatively, with the functionality trade-off described below.

Regression suite abbreviations:

- **P:** `scripts/collab/notebooks-critical-projects.test.ts`, using `support/critical-project-cases.mjs`.
- **S:** `scripts/collab/notebooks-critical-storage.test.ts`, using `support/critical-storage-cases.mjs`.
- **T:** `scripts/collab/notebooks-critical-transitions.test.ts`, using the R11–R14 scenarios extracted from the existing transition audit into `support/critical-transition-cases.mjs`.
- **E:** `scripts/editor/collab-critical-storage.test.ts`.

| Finding | Status | Change | Regression test name |
|---|---|---|---|
| R01 | Fixed | Preserve CR characters in CodeMirror so editor and Y.Text offsets agree. | `edlib-codemirror`: “R01: CRLF and mixed endings retain identical CodeMirror and Y.Text offsets” |
| R02 | Fixed | Resolve displayed collision paths to file IDs; preserve identity through async writes. | P: “R02: collision paths select one stable identity for replace, rename and delete” |
| R03 | Fixed | Persist the immutable document payload and original baseline before creation. | P: “R03: lost document-create response retains its original payload and intervening disk edits” |
| R04 | Mitigated | Stop inferring shared deletions from provider absence. | P: “R04: delayed provider absence never tombstones a materialized text or blob”; album variant |
| R05 | Fixed | Inferred deletion is removed, so an upload cannot publish a stale absence. | P: “R05: restore while an unrelated upload waits cannot publish a shared deletion” |
| R06 | Fixed | Merge author ink against authoritative host bytes and conditionally replace that version. | S: “R06: repeated successful follower ink saves retain additions and erasures without disk delivery” |
| R07 | Fixed | Submit and verify the exact reviewed shared/disk text; freeze the dialog snapshot. | P: “R07: reconciliation rejects an unreviewed shared version” and disk variant; `notebooks-reconcile-view` |
| R08 | Mitigated | Persist a profile-local adoption fence when inherited bookkeeping is absent or invalid. | P: “R08: missing bookkeeping on a new writer quarantines late unexplained files across restart” |
| R09 | Fixed | Historical hashes with newer mtimes require reconciliation. | P: “R09: historical bytes with a newer mtime require reconciliation” |
| R10 | Mitigated | Refuse bibliography writes into shared targets, including absolute/symlink tether targets. | E: “R10: generated mirrors refuse shared targets before touching bibliography bytes”; two tether variants |
| R11 | Fixed | Write shared recovery directly into the archive, then archive the live disk file. | T: “deleting a text file preserves an external edit arriving during archive IO” |
| R12 | Fixed | Allocate a unique staging artifact for every move attempt. | T: “a later rename cannot overwrite recovery bytes left by an interrupted move” |
| R13 | Fixed | Fence join marker/state writes and registration against root, marker and account/API lifetime. | T: “a pending join cannot commit into a missing root” and foreign-root variant |
| R14 | Fixed | Recheck root/share identity and detach cleanup targets before deleting them. | T: “album revocation cannot delete photos and bookkeeping from a replacement project” |
| R15 | Fixed | Export and verify current blobs before takedown; atomically check the exported manifest sequence on the server. | P: follower takedown and failed-download variants; server: “R15: server deletion rejects an export from an older manifest sequence” |
| R16 | Mitigated | Keep exact unreviewed sidecar bytes before imports/exports can replace existing IDs. | `pdf-live-host`: “R16: existing-ID sidecar edits and comment changes survive import in exact recovery bytes” |
| R17 | Fixed | Publish gallery add/edit/remove/delete through explicit host mutations, including large staged uploads. | S: “R17: follower gallery add, replace, remove and delete publish explicit manifest mutations”; large-photo variant |
| R18 | Fixed | Abort unavailable gallery scans before destructive index reconciliation. | E: “R18: unavailable gallery readdir preserves indexed originals and ink” and stat variant |
| R19 | Fixed | Tombstone every file ID and reject resurrection, including identities retired before the SQL migration. | `server/test/collab-critical`: “R19: an offline blob rename cannot resurrect a retired file identity”; folder variant |
| R20 | Mitigated | Use exclusive, content-identified sidecar copies and retain recovery sources; path-only events never erase work. | E: occupied destinations/swaps/reused paths, replaced-root, audio transfer and pruning-recovery tests |
| R21 | Fixed | Recover refused attachment drafts into ordinary dirty, journaled draft tabs. | `p3a-editors`: “R21: viewer attachment recovers a refused local draft before shared mirroring”; commenter variant |

## Per-finding implementation and limitations

**R01.** Files: `src/lib/collab/bindings/codemirror.ts`, `react-codemirror.ts`, and `scripts/collab/edlib-codemirror.test.ts`. The shared binding explicitly splits on LF and retains CR as a counted character. Attachment checks exact equality. Local/remote edits, selection and undo are covered. Existing CRLF and mixed endings remain intact; this does not perform an end-of-line conversion.

**R02.** Files: `electron/collab/notebooks/layout.ts`, `project.ts`, and P. Subtree selection, replacement and destination checks use computed display paths. Operations retain the selected file ID; blob replacement checks the current identity/version after upload. A concurrent rename can still complete the replacement on that same identity. The existing collision-control fixture now waits for its second peer's manifest before issuing commands. No identity redesign was introduced.

**R03.** Files: `electron/collab/notebooks/state.ts`, `service.ts`, and P. Share plans save `initialText` with the document identity before the first request. Replays retain the original uploaded hash even if the disk changed. Materialization then sees intervening disk edits instead of trusting them as already uploaded. Legacy checkpoints without an initial payload retain their old hash rather than claiming the new disk hash is a server baseline.

**R04.** Files: `electron/collab/notebooks/project.ts`, P, and the existing album/notebook tests. A complete scan and elapsed grace period are no longer deletion authorization. Explicit host delete operations still propagate; missing working copies are recovered from shared authority. This intentionally stops Finder/Explorer/provider deletions from deleting files for collaborators. It applies to notebooks and albums. A product workflow for acknowledging external deletion intent remains open.

**R05.** Files: `electron/collab/notebooks/project.ts` and P. The vulnerable inferred-delete closure is gone. Restoring a missing file during another file's upload cannot publish a shared deletion, regardless of how long the upload takes. This uses the R04 policy instead of adding another absence check to an unsafe inference.

**R06.** Files: `src/lib/storage/ink.ts`, `src/lib/collab/{local-api,host-client,shared-writes}.ts`, `electron/collab/notebooks/{project,service}.ts`, and S. A new host blob-read endpoint returns the current file ID, hash and bytes. Ink uses that author state and sends identity/hash preconditions, or exclusive creation when absent. Incomplete host responses are rejected; there is no stale-disk fallback. The regression saves additions, erases, restarts the storage author cache and saves again without any cloud author-file delivery. An unavailable authoritative blob makes the save fail explicitly instead of acknowledging a destructive replacement.

**R07.** Files: `src/components/libera/collab/reconcile/{reconcile-api.ts,reconcile-view.tsx}`, `src/lib/collab/local-api.ts`, `electron/collab/notebooks/{project,service}.ts`, P, `notebooks-reconcile-view.test.ts`, and the existing reconciliation callers/tests. The dialog retains its original reviewed snapshot even when props refresh. The host rejects stale or missing reviewed versions with 409 before changing shared text. A later disk race remains covered by the existing content fence. Older callers must include the reviewed versions.

**R08.** Files: `electron/collab/core/store.ts`, `electron/collab/notebooks/{state,project,service}.ts`, and P. Missing/invalid inherited state enables an adoption fence persisted in the host's account-scoped SQLite database. A late or older cloud checkpoint cannot clear it. Unexplained files stay on disk without receiving new shared identities; known-identity renames and explicit host creates still work. Explicit joins initialize bookkeeping in their newly allocated, incarnation-guarded folder. There is no bulk adoption/review UI yet; unexplained files need deliberate review and copying through a free host-created path.

**R09.** Files: `electron/collab/notebooks/state.ts`, P and `notebooks-synced-folder.test.ts`. A remembered historical hash remains uncertain even with a newer mtime. Text opens reconciliation rather than silently rolling back; historical binary replacement also requires an explicit host mutation. Known provider copies retaining their original timestamps still follow the existing stale-copy policy.

**R10.** Files: `src/lib/collab/shared-notebook.ts`, `src/lib/references/{bib-mirror,bib-tether}.ts`, and E. Absolute target checking covers lexical paths, real paths and symlink parents. Mirror and tether writers check before writing and again before replacement. This deliberately refuses shared generated bibliography output rather than implementing a partial host integration. Guarded host text generation for mirrors/tethers remains open; existing bibliography bytes are preserved for every role.

**R11.** Files: `electron/collab/notebooks/project.ts`, T and `scripts/collab/audit/sync-transition-review.mjs`. The latest CRDT text is written directly to a free archive destination. The live path is never overwritten to manufacture an archive; its current disk bytes are then moved into another archive name. Both versions survive an edit during recovery IO.

**R12.** Files: `electron/collab/notebooks/project.ts` and T. Staging names include a unique move-attempt ID, so a subsequent rename cannot replace an earlier interrupted move's sole copy. Existing artifacts remain under `.libera/collab/moving/`. Automatic journaling/replay of interrupted moves remains open; manual recovery is retained.

**R13.** Files: `electron/collab/notebooks/service.ts`, T and the original transition audit. Join guards check directory device/inode/birthtime, marker absence or the just-installed identity, account, API object and service lifetime. Marker/state IO and registration use the guard. A suspended join cannot recreate a removed folder or bind a replacement project. Account-change cancellation is also tested.

**R14.** Files: `electron/collab/notebooks/service.ts`, T and the original transition audit. Cleanup captures root incarnation and rechecks the complete sharing identity before each operation. Targets are renamed to unique profile-local cleanup paths before asynchronous recursive deletion, so pending deletion no longer addresses a replacement root. If detachment is unavailable, including across volumes, cleanup retains the original rather than risking a replacement. Existing best-effort cleanup semantics remain.

**R15.** Files: `electron/collab/{core/api-client.ts,notebooks/project.ts,notebooks/service.ts}`, `src/lib/collab/protocol/api.ts`, `server/src/api/{projects,system}.ts`, P and `server/test/collab-critical.test.ts`. Takedown obtains and hash-verifies every current manifest blob, including follower copies missing from disk, before server deletion. Notebook disk versions are archived when distinct. The server locks the manifest row and checks the exported sequence in the deletion transaction. Missing downloads or a changed manifest preserve the server project. The desktop requires the new server capability. This exports current files, not the server's complete revision history.

**R16.** Files: `electron/collab/notebooks/pdf-marks.ts` and `scripts/collab/pdf-live-host.test.ts`. Unreviewed input is retained byte-for-byte under `.libera/collab/rejected-pdf/<fileId>-<content-hash>.json` before it can be replaced. Existing-ID mark edits and comment/status/message input survive there, including terminal export. Known runtime-generated copies do not generate recovery on every normal rewrite. Ambiguous field merging and a recovery UI remain open; the implementation preserves rather than guesses.

**R17.** Files: `src/lib/storage/{gallery,gallery-shared-mutations}.ts`, the host file-operation preconditions in `project.ts`/`local-api.ts`, and S. Gallery creation, copying into an album, replacement, reversion, removal and deletion publish host mutations. Follower disk files are not used as the writer. Stale edits are rejected by expected hash; removals include file identity. Large photos use guarded UUID staging names accepted by the host. Published photos remain indexed before provider delivery. Cloud-delivered pixels can still lag, and a second edit from stale pixels is refused until refreshed.

**R18.** Files: `src/lib/storage/gallery.ts` and E. Album `readdir` and photo `stat` failures abort reconciliation instead of becoming empty or missing results. Both original backups and photo ink are asserted unchanged. One unavailable path can postpone the whole gallery refresh; that is the conservative completeness trade-off.

**R19.** Files: `server/src/db/migrations/009_file_tombstones.sql`, `server/src/db/types.ts`, `server/src/sync/{server,store}.ts` and `server/test/collab-critical.test.ts`. Every removed stable file ID is tombstoned in the manifest commit transaction. Added identities are checked independently of kind/path. Retired root-map keys in public Yjs snapshot/update encoding also reject older-server deletions that predate the SQL table. Tests remove the SQL tombstone to exercise that upgrade case. Fresh IDs may still deliberately recreate a filename. Apply the server migration during rollout.

**R20.** Files: `src/lib/storage/{pdf-sidecars,transcripts,sidecar-lifecycle}.ts`, `src/lib/collab/shared-writes.ts`, E and `voice-memos-shared.test.ts`. Lifecycle handling copies only portable-content-matched snapshots into empty destinations, with root incarnation/source/destination checks. Sources and occupied destinations remain; swaps and identity-less records are deferred. Path-only removals do not erase sidecars. Audio inputs additionally receive content-addressed recovery records under `.libera/collab/sidecar-recovery/`, surviving later orphan pruning and local conversion. Full project/file-identity lifecycle transactions and automatic swap placement remain open; recovery and preservation take priority over automatic movement.

**R21.** Files: `src/components/libera/use-libera-workspace.ts`, `src/lib/collab/client/apply-text.ts` and `scripts/collab/p3a-editors.test.ts`. Pending-draft adoption checks its result. Refused viewer/commenter/not-ready drafts are copied into ordinary recovered draft tabs before the original tab mirrors shared text. Those tabs remain dirty and keep their text in the normal session journal. Recovery uses a Markdown draft container while preserving the original text.

## Validation

FINAL_VALIDATION

## Additional observations

FINAL_OBSERVATIONS
