# Sync lifecycle review — 1 November 2026

**G25–G29 are fixed.** All eight original scenarios now pass and run in the normal collaboration suite. This review follows G20–G24 and checks initial sharing, durable retry checkpoints, audience identity and asynchronous filesystem commits against [the sync matrices](../features/notebook-sync.md).

The descriptions below retain the failures observed before the fixes. Reproductions use disposable libraries/accounts and local collaboration servers; cloud delivery and filesystem delays are simulated. Each correction describes the implemented behavior.

| Finding | Priority | Failure before the fix | Matrix |
|---|---|---|---|
| G25 | P1 | A fresh share reuses another recent project with the same title and exposes its note to that project's existing member. | B: create/share; X30 |
| G26 | P1 | Text materialization overwrites an external edit arriving during temporary-file IO, without archive or reconciliation. | A/B: modify text; X31 |
| G27 | P1 | Explicit file creation overwrites an independent file arriving at the previously empty destination during HTTP creation. | A/B: create file; X32 |
| G28 | P1 | Initial sharing recreates a removed root or overwrites another project's marker/state delivered at that root during upload. | A: delete/replace notebook root; X33 |
| G29 | P2 | An all-uploaded checkpoint resumed by another account returns HTTP 200 for an inaccessible project and deletes the original retry plan. | X20, X34 |

P1 means fix before relying on the affected behavior. G29 is a narrower correctness/recovery failure; its reproduction does not bypass the server's access checks.

## G25 — project-name matching inherits an unrelated sharing audience

**Previous source:** [`orphanProject()` (removed)](../../electron/collab/notebooks/service.ts), called by every initial `doShare()` without a recorded project ID.

Orphan discovery matches owner, name, kind, recent creation time and an untouched manifest. These are not proof that the server project belongs to this share attempt. An empty manifest can already have accepted members/invitations. The code does not require a retry checkpoint that identifies the original creation request, and it does not distinguish that audience from a new share.

**Reproduction:** create a recent empty project named `SameTitleDifferentNotebook`, invite a second account and let it join. The owner's desktop has not adopted that project. Share a different local notebook containing `private.md` using the same display name. The returned project ID equals the existing project's ID, and the previously joined member receives `private material intended for a new membership` as live text.

This is observed unintended disclosure through the wrong client-selected project identity. Server membership enforcement remains intact: that member is legitimately authorized for the project the client accidentally reused.

**Implemented correction:** save an operation key before creation and send it as `creationId`. The server reserves `(account_id, operation_id)` and creates the project, manifest, membership and audit event in one transaction. Concurrent/repeated requests return the same IDs; a new operation always gets an independent audience. Changed request metadata is refused. Migration `007_project_creations.sql` retains keys after project deletion, so a delayed retry cannot resurrect the project. Desktop sharing requires the advertised `projectCreationKeys` capability and confirmation of the key in the creation response; older servers return an actionable update-required result before a POST is sent.

Copies of one checkpoint derive the same folder lease key from that operation identity. They use the actual granted/refused lease outcome when starting their runtimes, preserving a single folder writer.

**Test:** `a fresh share cannot adopt another project's existing membership just by matching its name`.

## G26 — text writes omit the destination-content fence

**Source:** [`materializeDoc()` and `writeDoc()`](../../electron/collab/notebooks/project.ts); [`writeFileAtomic()`](../../electron/collab/notebooks/fs-ops.ts).

The materializer reads and classifies disk bytes, then writes the selected shared text through a guard that checks root identity and writer lifetime. That guard does not compare the destination content observed earlier. Temporary-file IO and busy-file retries occur after the observation. A filesystem editor or cloud delivery during those waits is overwritten before a queued scan can see it. Updating the materialized hash/base afterward makes the resulting disk/shared pair look consistent.

**Reproduction:** materialize `shared change\noriginal\n`, hold the temporary-file write, and replace `note.md` with `external edit during materialization`. Release IO. The disk and hub both contain the shared text; the external input is absent from the archive, and there are zero reconciliations.

**Implemented correction:** `contentGuard()` compares the destination's observed hash or absence before committing, including each busy-file retry and fallback copy. Text materialization and stale-copy repair also recheck current manifest document/path identity. A changed destination triggers another scan/reconciliation instead of overwriting bytes or advancing the baseline. Merge resolution retains the chosen shared text and returns 409 if new disk input arrives. Terminal text preservation keeps external input in place and archives the latest shared text when possible; disappearing roots still leave the durable local collaboration log.

The reproduction delays temp-file IO rather than a rename after its final guard. It does not claim a filesystem compare-and-swap or eliminate the final check/syscall race.

**Test:** `text materialization preserves an external edit arriving during temp-file IO`.

## G27 — an empty create destination is trusted across an HTTP wait

**Source:** [`createFileEntry()`](../../electron/collab/notebooks/project.ts), especially the initial `statIfExists()`, server create/upload, and unconditional disk write.

Explicit creation checks that the local path is absent only before its HTTP operation. Once that returns, it writes the original input without checking whether external bytes arrived at the destination. Root/lease checks do not establish continued absence. The queued scanner cannot preserve those bytes first because the create operation holds the project queue.

**Reproduction:** request a new `new.md` containing `Libera input`, pause its document creation, and deliver `independent cloud arrival` at that path. Resume HTTP. The request returns **200**, disk contains `Libera input`, and no archive contains the external bytes.

**Implemented correction:** after HTTP creation/upload, recheck the current manifest and destination. Archive an independent arriving file under a content guard, then write the submitted input only while the destination remains absent. If it changes again, retain the submitted server identity and let normal materialization preserve/reconcile the new bytes. A concurrent collaborative entry uses collision layout, retaining both document identities and texts.

**Test:** `a new file cannot overwrite external bytes delivered while its server creation waits`.

## G28 — initial sharing has no root-identity fence after uploads

**Source:** [`doShare()`](../../electron/collab/notebooks/service.ts), including checkpoint writes after HTTP, `writeBase()`, `writeState()` and `writeMarker()`; these calls omit a write guard.

A root is checked at share entry. Subsequent asynchronous network operations can outlive its deletion/replacement, and recursive parent creation recreates it. A new valid marker arriving at the same path is overwritten by the suspended share. The runtime guards introduced for ordinary materialization do not cover this initial-share phase.

**Reproductions:**

- Pause the initial blob upload, remove the entire notebook root, then complete the upload. Sharing returns **200**; the root and an active marker exist again.
- During the same wait, replace the root with a separate cloud copy of a different real shared notebook. Sharing still returns **200**. Its new project ID replaces the delivered notebook's marker, and its state/base bookkeeping is written inside the replacement copy.

The second variant establishes a cross-project identity overwrite, beyond a resurrected empty directory. Both replacement projects belong to the same account, as is normal for one account syncing multiple notebooks.

**Implemented correction:** capture the root's directory identity, account/API lifetime, saved operation and initial marker absence. All checkpoint/base/state/marker writes and upload journal changes check that identity after waits. A removed/replaced root or foreign marker cancels completion with 409; guarded parent creation cannot recreate the root. Pending roots are excluded from discovery for the entire attempt.

Before updating the cloud checkpoint, save `{ root, plan }` to the profile's `notebook-lifecycle/share-attempts/<operationId>.json`, outside the cloud root. This preserves known project/file identities even when the root disappears after a successful upload. A recovery test restores that plan and the user's files to a local root, then resumes the same project. Successful completion removes its own cloud/profile checkpoint.

**Tests:** `an initial share cannot recreate a notebook removed during upload`; `an initial share cannot overwrite another shared identity delivered during upload`.

## G29 — completed upload checkpoints skip current-account authorization

**Source:** [`doShare()`](../../electron/collab/notebooks/service.ts), which reuses persisted project/manifest IDs and uploaded flags; [the share-plan schema](../../electron/collab/notebooks/state.ts), which records no account/server identity.

When HTTP uploads remain, a wrong-account resume hits the server and is refused. Once all files are marked uploaded, that incidental authorization check disappears. The resume skips creation/upload, optimistically writes the old manifest ID in the new account's host, writes a new-account marker, and deletes the original plan. A failed manifest acknowledgement only sets `synced: false`; the operation still returns success for a server project the account cannot access.

**Reproduction:** inject an interruption immediately after the final uploaded checkpoint is durably renamed, before the manifest/marker stage. Stop that host, then resume using a separate host/database for another account and the same library. The result is **HTTP 200**, the old project ID, and `synced: false`. A real GET using the new account returns **404** for that project. The old checkpoint is gone; the new marker and local project claim the new account/owner role for the old ID.

The test shortens only the acknowledgement wait from 15 seconds to 250 ms. It injects a checkpoint-boundary failure; it does not claim coverage of an actual process crash. Server access remains refused, so this reproduction establishes false success and lost retry identity, not content disclosure to the new account.

**Implemented correction:** plans include account, server, kind and operation identity. A foreign authority or malformed operation key is refused without rewriting the plan. Before inventory/checkpoint changes and again before publication, a recorded project must pass a real GET verifying current owner role, owner ID, kind and manifest ID. This also validates legacy plans lacking authority fields. Uploaded flags cannot skip authorization. Account/API changes and manifest denial/closure cancel final publication and preserve recovery state.

**Test:** `an entirely uploaded checkpoint still requires current-account authorization before publication`.

## Passing controls and validation

| Scenario | Result after the fixes |
|---|---|
| Fresh share with a title matching an existing audience | New project ID; the existing member receives no private document. |
| External text arrives during temp-file IO | External bytes remain; a reconciliation exposes both versions. |
| External file arrives during explicit creation | External bytes are archived; submitted input remains live. |
| Root removed/replaced during initial upload | 409; no root resurrection or foreign marker overwrite. |
| Partially or entirely uploaded plan resumed by another account | Refused; original checkpoint remains. |
| Concurrent collaborative creates at one path | Two live IDs and both texts through collision layout. |

The [eight original audit scenarios](../../scripts/collab/audit/sync-lifecycle-review.mjs) pass through [the normal-suite wrapper](../../scripts/collab/notebooks-share-lifecycle-regressions.test.ts). The parent counts as another test, for **9 passing tests**.

[Additional recovery tests](../../scripts/collab/notebooks-share-lifecycle-recovery.test.ts) cover busy-file retries, server capability upgrades, immutable creation names, legacy authority/manifest checks, foreign-server and invalid operation keys, recovery outside a removed cloud root, account changes at completion, simultaneous checkpoint copies, terminal text preservation and merge input arriving during IO. Server tests cover concurrent keyed POSTs, separate accounts, changed requests, retained keys after takedown, and ignoring OS metadata during migration discovery.

```sh
node --require ./scripts/editor/setup.cjs --import tsx --test \
  scripts/collab/notebooks-share-lifecycle-regressions.test.ts \
  scripts/collab/notebooks-share-lifecycle-recovery.test.ts
```

New shares require the matching server release, which applies migration 007 at startup and advertises durable creation keys. This change does not deploy the server. Known-project legacy checkpoints can resume after fresh owner/manifest validation; legacy checkpoints without a recorded project ID cannot infer an old project by title.

Validation completed: **229 desktop/client tests** and **163 server tests** pass, including earlier sync, lifecycle, lease, takedown and album regressions. Targeted lint, the application/host collaboration typecheck, server typecheck, host bundle and server build pass. The full repository typecheck still reports existing errors in unrelated editor tests.

No new lock cycle was established. Remaining limits include real provider hydration/conflict timing, real Windows sharing failures, full process/power-loss crashes, broader clock skew/missing-base combinations, and production distributed-server concurrency. Fault-injected checkpoint and content boundaries do not establish those guarantees.
