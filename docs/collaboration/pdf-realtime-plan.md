# Real-time PDF collaboration plan

**Status:** built on `feat/pdf-realtime-collab`, 6 Nov 2026. [Changes from this plan](#what-changed-while-building) are at the end. The user guide is [Live PDFs](../features/live-pdfs.md).

Shared PDFs should behave like shared Markdown: everyone with access sees markup appear live, works offline without losing anything, and converges on the same result. Today a shared PDF's bytes sync as a blob, and all its markup and comments stay on one computer.

## Goals

- Highlights, shapes, ink, text notes, spaces and comments reach collaborators in real time.
- People see each other: who is on which page, their pointer, selection and strokes as they are drawn. Anyone can follow someone's view.
- Every role that can annotate gets every annotation tool, on anyone's marks.
- The Markdown durability promise holds: saved locally first, no Save button, nothing lost offline or in a crash, and every device converges.
- Rename, move, copy, delete, share, join, leave and PDF replacement all keep annotations correct.

## Non-goals

- Changing PDF bytes. Markup stays an overlay, and export stays as it is.
- Importing annotations embedded in the PDF file.
- Image annotations and shared-album ink. The same design could extend to them later.
- Suggestion mode on PDFs. Marks apply directly.
- Notebooks that are not shared. They keep the sidecar and the Save flow unchanged.

## Where things stand today

| Area | Today | Why it matters |
|---|---|---|
| Storage | One JSON sidecar per PDF: `.libera/annotations/pdf/by-path/<path>.json`. It holds marks and `comments`, and is keyed by path. | `.libera` is ignored by the sync scan. |
| Writes | The viewer keeps a whole list and PATCHes the whole list on Save ([use-annotation-writer.ts](../../src/components/libera/use-annotation-writer.ts)). | Whole-list writes overwrite other people. |
| Undo | Snapshots of the whole list ([pdf-viewer.tsx](../../src/components/libera/pdf-viewer.tsx), `commitAnnotations`, `stepHistory`). | Undo would erase collaborators' work. |
| Windows | `BroadcastChannel` adopts the saved list ([annotation-sync.ts](../../src/components/libera/annotation-sync.ts)). | Replaced by the shared replica. |
| Ink | PDF strokes are `PdfInkAnnotation` records in the sidecar. The per-author `_ink` format has not reached PDFs (ink plan, phase 1), and live co-drawing is one of its non-goals. | See [decision 4](#decisions). |
| Comments | Sidecar threads with no author ([pdf-comments.ts](../../src/lib/storage/pdf-comments.ts)). | No names, mentions or notifications. |
| Readers | Deep search, the search index, the agent's ReadComments and annotated export read the sidecar. | They must keep working. |

Reusable as they are: DocHub, SQLite update log, outbound queue, compaction, reject rollback, awareness relay, queued commands, server threads, durability chrome, the chaos and fuzz harness.

## Design

### 1. One document per shared PDF, found without the manifest

Each shared PDF gets a document of a new kind, `pdf`.

- **The id is derived:** `docId = "pdf_" + hash(projectId, fileId)`. Any client can compute it offline, so annotating a PDF nobody has marked needs no network round trip, and two offline clients cannot create two documents.
- **The manifest does not change.** This matters: old hosts parse manifest entries into known fields and write them back ([layout.ts](../../electron/collab/notebooks/layout.ts), `parseEntry`), so a new field on a blob entry would be stripped by the next rename from an old client.
- **Commenters can start one.** Creating a document needs `manage-files` today, and manifest writes need an editor. The server instead gets or creates a `pdf` document on first use, requiring only `comment`, after checking that `fileId` is a blob ending in `.pdf`.
- **Identity follows `fileId`,** so rename and move carry annotations with no extra work. This removes the path-keyed sidecar problem for shared PDFs.

Server changes: migration `008` widens the `documents.kind` check, `DocKind` and the create schema gain `pdf`, and the project document list tells hosts which PDFs have documents.

### 2. The document model

Everything lives in the `annotations` sub-document, because the role check already lets commenters write it and not `content`. `content` stays empty, and `meta` gains `sourceHash`, the PDF version last seen.

```text
annotations (Y.Doc)
  pdfMarks: Y.Map<markId, Y.Map>
    id, type, pageNumber, createdBy, createdAt      immutable
    updatedBy, updatedAt
    geometry    JSON: rects, from/to, points, rect, y/height/band/column
    style       JSON: color, strokeWidth, markup, shape, fontSize, fontFamily, fill
    space       the parent space's id, if any
    text        Y.Text, text notes only
    sourceHash  the PDF version the mark was placed on
    deleted     { by, at } when deleted
  anchors: existing map, now also holding PDF comment anchors
  imports: Y.Map<sidecarHash, { by, at }>
```

- **Field groups merge independently.** One person moving a note while another recolours it keeps both changes. Two people moving the same note: the last write wins, and both clients agree which.
- **Note text is a `Y.Text`,** so two people can type in one note at once.
- **Deletes are soft.** A hard `Y.Map` delete would silently discard an offline edit to the same mark, and a re-import could resurrect it. A `deleted` field keeps both cases recoverable and makes undo a field flip. Purging old tombstones is a later concern.
- **Paint order** is `createdAt`, then `id`, as ink merging already does, so every computer draws the same stack.
- **Unknown fields and types stay in the map,** preserving the rule `withPreservedUnknowns` enforces today. The adapter only writes fields it knows. A newer `schemaVersion` opens read-only, as for text.

The server's `annotationViolation` needs a new branch for `pdfMarks`. The existing rule that commenters only touch records they created must not apply there, and records must be allowed to contain nested types. It still enforces immutable fields, `createdBy` matching the sender, valid colours and numbers, and size limits. The same validator ships in `protocol/` so clients refuse a bad record before it can poison the queue.

### 3. Viewer: swap the store, keep the tools

Rewriting a 3,600-line viewer around Yjs is the biggest avoidable risk. Instead, add a `PdfAnnotationStore` interface with two implementations:

- **Local:** today's writer, unchanged for notebooks that are not shared.
- **Shared:** an immutable snapshot from the replica, plus `commitAnnotations(updater)` implemented as a diff. It runs the same updater, compares old and new lists by id, and applies only the changed field groups in one transaction.

Most tools then keep working untouched. What does change:

- **Undo** uses a `Y.UndoManager` limited to this window's own changes, as the text bindings do. A gesture stays one step, including a space deleted with its contents.
- **Save** goes away on shared tabs: the writer, dirty dot and journal are bypassed, Cmd/Ctrl+S shows status, and the shared status chrome appears.
- **Gestures in progress** stay local. A remote change to a mark being dragged applies when the drag ends. If the mark was deleted remotely, the drag is cancelled with a notice.
- **Rendering** invalidates only the pages touched, batched per animation frame. Spaces already restore the reading position when annotations change elsewhere, which keeps a collaborator's new space from moving your page.

### 4. Live presence and drawing

Awareness carries what never needs saving, under a new validated `pdf` key:

```text
pdf: { page, top, bottom, tool, pointer: {page, x, y}, selection: [ids],
       textSelection: {page, rects}, draft: {id, seq, kind, tail} }
```

- **Others' pages:** avatars on the page rail, and a viewport outline. Positions are page fractions, so zoom and window size do not matter.
- **Follow:** click an avatar to track their page and scroll. Your first manual scroll stops it.
- **Strokes while drawing:** awareness sends whole states, so sending the full stroke each time grows quadratically. Drafts send only new points with a sequence number, about every 50 ms. Receivers assemble a ghost in the author's colour. On pen-up the real mark, with the same id, replaces it. A gap in the sequence just waits for the commit.
- **Shapes, moves and space drags** send a draft outline. Others see a marker rather than a page that reflows on every frame, and the layout changes on commit.
- **Typing** needs no draft: it is the `Y.Text`, with remote carets.
- **Limits:** the client caps state size, and the server gains a per-socket rate limit. Awareness has neither today, and PDF presence is much chattier than a text caret.

Local pen latency must not change: presence work runs after the stroke is drawn, off the input path.

### 5. Host, disk and readers

- `NotebookProject` gains a PDF runtime: a hub per PDF document, following manifest changes.
- **The CRDT is the source of truth.** The sidecar becomes a read-only copy, written by the folder's writer host only, debounced about 60 s because every write is an upload on a synced folder. Followers never write it. Deep search, the index and export keep reading the sidecar.
- **Writes are refused:** `/api/pdf-annotations` answers `409 shared-document` for shared paths, like text files.
- **Nothing is ever rebuilt from the sidecar** after import, so a stale copy from OneDrive cannot change shared state.
- **Scale:** text documents all hold a hub. Only PDFs that have a document get one here, and idle hubs close. Spike S3 tests this on a large notebook.

### 6. Migrating existing annotations

On share, join, or the first run of a new build, each host imports each sidecar once.

- Marks keep their ids and are added only if neither the mark nor a tombstone exists. This makes import idempotent and resurrection-proof, even when two devices read the same synced sidecar.
- `imports` records the sidecar's hash, so unchanged sidecars are skipped.
- Imports are chunked to stay under the 4 MB update limit.
- Two people with different local marks on the same PDF get the union. Their marks become visible to everyone, so the share dialog must say so first.
- Local comments become server threads with idempotent ids, authored by the importer, keeping their original dates in metadata.
- If a sidecar changes afterwards, for example from an old build on a synced device, only unseen ids are added.

### 7. Comments

Shared PDF comments move to the server threads Markdown uses, which brings authors, mentions, notifications, the offline queue and pending chips. Their anchors are `{segments, quote}` records in `anchors`, and PDFs need no remapping. The agent's ReadComments and ReplyToComment switch to the host's thread calls for shared PDFs and post as an AI actor. Comment rules stay as they are: anyone who can comment can reply, and people edit only their own messages.

### 8. Roles

| Action on a shared PDF | Owner | Editor | Commenter | Viewer |
|---|:-:|:-:|:-:|:-:|
| See marks, comments and presence live | ✓ | ✓ | ✓ | ✓ |
| Create, edit, move and delete anyone's marks | ✓ | ✓ | ✓ | |
| Comment and reply | ✓ | ✓ | ✓ | |
| Replace, rename or delete the PDF file | ✓ | ✓ | | |

Author and last editor are kept on every mark, and shown on hover and in the activity log, because anyone can change anyone's work.

## Edge cases

### Network and crashes

| Case | Expected behaviour |
|---|---|
| Disconnect during a stroke | The stroke commits locally at pen-up and syncs later. Others' ghost clears at the awareness timeout. |
| Long offline session on both sides | Both sets of marks merge. Concurrent changes to one field: last write wins. Note text merges by character. |
| Renderer crash mid-gesture | Committed marks are in SQLite. Only the unfinished gesture is lost, as with an uncommitted keystroke. |
| Host crash or kill | The WAL replays and the queue resends. Duplicate delivery changes nothing. |
| Server restart or lost ack | The existing reconnect and idempotent resend apply. |
| PDF never opened on this device, then offline | Annotating works and merges later. The tab says it may not show everything yet. |
| PDF bytes not downloaded yet | Marks wait, and the tab shows the download state. |

### Cross-talk between people

| Case | Expected behaviour |
|---|---|
| Edit a note while someone deletes it | The delete wins on screen, and the text survives in the tombstone. The editor gets a notice with Restore. |
| Move and recolour together | Both apply. |
| Undo after someone edited your mark | Undo reverts only your own change. |
| Undo a create that others have since edited | The mark is soft-deleted, so it stays recoverable. |
| Two overlapping spaces on one page | `reconcilePdfSpaces` runs at render time on the same inputs, so everyone gets the same layout. Its result is never written back, which would cause a write loop. |
| Delete a space while someone draws in it | Its known contents go with it. A mark added concurrently stays visible at the cut with a Restore space option, not lost. |
| Resize a space below its content | The displayed height covers the lowest mark, the same on every client. |
| Remote space opens above your reading position | Your reading anchor holds. |
| Role reduced while offline | The server rejects the queue. Unsent marks are kept and offered as a download, not just dropped. `subdocText` needs a PDF form, because rollback saves text today. |

### Devices and files

| Case | Expected behaviour |
|---|---|
| Same account on two computers | Each has its own SQLite and client id, and they merge like two people. Undo is per window. |
| Two windows on one computer | Both attach to one hub and need no `BroadcastChannel`. |
| OneDrive folder, writer and follower installs | Only the writer writes the sidecar. CRDT state never comes from the folder. |
| OneDrive delivers an old sidecar | Ignored, or only unseen ids are added. |
| Old build on a device or with a collaborator | It sees no live marks, and its edits stay local until it updates. The app shows an update prompt. |
| Rename or move | Nothing changes: `fileId` is stable. |
| Copy a PDF | The copy gets a new `fileId`. Its marks are copied into a new document with new ids, matching what a copy does today. |
| Delete the PDF, offline edits pending | The document is soft-deleted. Late updates are rejected and saved to `.libera/orphaned-sidecars/`. |
| Same PDF added back later | A new `fileId` means a new document. Marks are not silently reattached. |
| PDF replaced with a new version | See below. |
| Unshare, leave or access revoked | The last state is written to a normal local sidecar, so the person keeps it. |
| Move into or out of a shared notebook | Into: import. Out: export to a sidecar. |

**PDF replacement.** "PDFs do not change" is no longer safe once anyone can replace the blob, and compiled LaTeX PDFs change on every build. When the blob hash differs from a mark's `sourceHash`:

- Highlights and comments search for their quote on the same page and nearby pages, and move if found uniquely.
- Everything else stays put, and is flagged as placed on an earlier version.
- Nothing is deleted, and a banner offers review.
- Presence says when two people are on different versions.

## Security

Collaborators' text becomes untrusted input. The note renderer already sanitizes Markdown, but the threat model changes, so it gets a fresh review: `docs/collaboration/security.md` needs a section for notes, colours, `fill` values and awareness fields. Every remote field is validated on the server and again before rendering.

## Phases

Sizes are relative: S is days, M is about one to two weeks, L is several weeks.

| # | Phase | Size | Done when |
|---|---|---|---|
| 0 | Spikes S1–S5 | M | Each has a measured answer or a fallback. |
| 1 | Protocol and server: `pdf` kind, derived ids, get-or-create, validators, rate limits | M | Server tests pass. Old clients are unaffected. |
| 2 | Host: PDF runtime, import, sidecar copy, file lifecycle | L | Two hosts converge on marks with no UI. |
| 3 | Viewer store, undo, no Save, status chrome | L | Highlights, shapes and ink sync live between two apps. |
| 4 | Notes as `Y.Text`, spaces under concurrency | L | Co-typing works, and the space cases above pass. |
| 5 | Presence, ghosts, Follow | M | You can watch someone draw and follow their view. |
| 6 | Comments on server threads, agent, migration | M | Mentions and offline comments work. |
| 7 | PDF replacement, history and restore, reviews on PDFs | L | Replacement cases pass, and marks can be restored. |

Phases 1 to 3 deliver the first usable version, with field-level sync. Roll out behind a per-project flag: server first, then the app, then migration. Hold the migration until every member's build is new enough, because old builds cannot see the result.

### Spikes

| Spike | Question | Fallback |
|---|---|---|
| S1 | Does the diff adapter cover every viewer gesture? | Convert the awkward tools to explicit operations. |
| S2 | Can the note's Tiptap editor bind through `tiptap-ytext.ts`? | Bind notes to source text while editing, rendered at rest. |
| S3 | Hub cost with 500 PDFs per notebook? | Open hubs only for recently used PDFs, and fetch the rest on idle. |
| S4 | Are `reconcilePdfSpaces` and `normalizeSpaceLayout` deterministic under any arrival order? | Fix the tie-breaks first. Phase 4 depends on this. |
| S5 | Bytes per stroke in Yjs for heavy ink? | Store points packed with the ink codec. |

## Testing

- **Convergence fuzz:** extend the existing fuzzer with mark operations, undo, spaces and offline schedules. Invariant: all clients reach identical rendered state, and no acknowledged mark disappears unless a delete was recorded.
- **Chaos proxy:** duplicates, reordering, drops and disconnects during strokes.
- **Durability matrix:** kill the renderer, host and server at each stage of a mark's journey.
- **Multi-device:** two hosts on one folder (writer and follower), a stale sidecar delivery, and mixed old and new builds.
- **Migration:** repeat imports, two devices importing at once, and imports after deletes.
- **Performance:** add to `harness-perf`. Proposed budgets, to confirm in phase 0:
  - ghost visible within 150 ms at p95 on a good network
  - committed mark within 300 ms at p95
  - no change to local pen latency
  - a 10,000-mark PDF opens without a visible stall
- **Two-user e2e:** extend `scripts/collab/e2e/two-users.ts` with a PDF session.

## Decisions

All settled on 6 Nov 2026.

1. **Can viewers annotate? No.** Commenters and above get every tool, and viewers see everything live but stay read-only. An assigned reviewer who is a viewer needs to be made a commenter to annotate.
2. **Can anyone change anyone's marks? Yes.** Authorship stays visible and every change is undoable by its author, but there is no lock on someone else's work.
3. **Does migration make private marks visible? Yes,** with a warning when sharing. Per-person opt-in was rejected because it would leave old marks behind.
4. **Which ink format? Today's `PdfInkAnnotation` shape, in the CRDT.** Shared PDFs do not go through `_ink` blobs, which cannot be live. Ink phase 1 will need a matching CRDT path.
5. **How do compiled LaTeX PDFs behave? Like any PDF,** using the replacement rules, so marks on them will be flagged often. Disabling marks on compile outputs was rejected.

## What changed while building

**Spike results**

| Spike | Result |
|---|---|
| S1 | The diff adapter covered every viewer gesture, so no tool needed converting. |
| S2 | The fallback was used: notes bind through their source text. The editor applies the smallest change to its document, so the caret holds, and merges three ways when a collaborator's text arrives during its debounce. |
| S3 | 500 hubs with 20 marks each took 340 ms and 51 MB, so every PDF with a document gets a hub. |
| S4 | Deterministic under 40 shuffled arrival orders. Nothing needed fixing. |
| S5 | About 12 KB per 500-point stroke. Points stay as JSON. |

**Design changes**

- **Documents are made by `open`, not by a separate request.** `open` for a `pdf_` document carries the project and file. A separate create step left a window where an offline hub with local marks read a missing document as lost access. Because it happens at `open`, the file cannot be checked against the manifest, whose update may still be queued.
- **Undo is not `Y.UndoManager`.** Undoing a create would hard-delete the mark, which breaks soft deletes and is refused by the server. `SharedPdfStore` keeps field-level history instead. A press applies one step, and a step someone has overwritten is used up without reaching further back.
- **Rollout is an owner setting, not a per-project flag plus a hold.** `pdfLive` in the manifest's settings is off until the owner turns it on. It cannot be turned off.
- **Comment anchors are in `pdfAnchors`,** not `anchors`, which holds Yjs positions.
- **Sidecar import is a server operation.** `POST /v1/documents/:docId/pdf-import` validates plain marks and comment anchors, then creates only absent keys inside the PDF room's serialized batch. Clients never create imported nested maps independently. Imports and long comment conversations are chunked; existing marks, tombstones, anchors and imported threads keep their identities across devices and accounts. This REST addition keeps the sync wire unchanged and requires the documented server-first rollout.
- **Deleted PDFs leave document tombstones even if never opened.** Removing a blob PDF inserts its derived, deleted document row in the manifest update's persistence transaction. Late opens get `document-deleted`, and stale blob re-adds are rejected.
- **Unsaved local work at activation has private recovery.** Pending writer and journal work, including buffered note text, is kept in the local journal and offered through **Download recovery**. It is not silently discarded or sent through a sidecar Save after activation.
- **The sidecar copy is marked with its document id.** A sidecar naming another document, such as one that arrived with a copied PDF, counts as local work.

**Not done as planned**

- Imported comments are dated when they reach the server. Their original dates are not kept.
- When a PDF is replaced, comments do not search for their quote. Highlights do.
- A review decision does not go out of date when marks change.
- Follow tracks scroll position only.
- The relocation search reads pages either side of the mark, so a passage moved further is flagged, not found.

