# Collaboration implementation plan (Phase 0 – Phase 4)

**Status:** plan, nothing implemented yet
**Date:** 18 Oct 2026
**Reads with:** [README.md](README.md) (the collaboration map) and [source-plan.md](source-plan.md) (the original plan; "§" references point there)

This plan turns the source plan into work items for this repo. Each milestone lists what it changes, which existing code it builds on, how it is tested, and when it is done. Milestone IDs match the source plan's where they line up. Extra milestones specific to Libera are marked ★.

---

## 0. Starting point: what Libera is today

These facts drive most of the decisions below. They come from a survey of the codebase on 18 Oct 2026.

| Area | Today | Why it matters |
|---|---|---|
| Process model | In production the Next.js server runs **inside the Electron main process** (`electron/main.cjs` → `startNextServer` requires `.next/standalone/server.js`). In development it is a child process. The renderer talks to it over HTTP on a random localhost port. IPC is used only for native features (`electron/preload.cjs`). | The DocHub cannot simply live in "main" without sharing an event loop with Next. → D7: utilityProcess host. |
| Identity | A single password and a hard-coded session subject `admin` (`src/lib/auth.ts:10`). Storage is rooted at `users/admin`. No user ID reaches any route. | Collaboration accounts are new. They sit beside the local password and do not replace it. |
| Saving | Manual save. `PATCH /api/files` writes the whole file with no revision or mtime check (`src/lib/storage/files.ts:129`). No file watchers. Unsaved drafts live in the workspace session and the recovery journal. | Shared files need a different save path (the host), and a watcher for edits made outside Libera. |
| Editors | Visual: Tiptap 3 with a Markdown round-trip. The draft is a string, serialized after 250 ms (`use-tiptap-draft.ts`). Source Markdown is a **textarea** with a highlight overlay (`markdown-editor.tsx`, about 1,900 lines). LaTeX and code use CodeMirror 6. External changes replace the whole document (`setContent`, full CodeMirror replace). | `y-codemirror.next` covers LaTeX and code. Source Markdown needs a CodeMirror port (D8). Visual needs a bridge (D1). Every whole-document replacement must become incremental on shared tabs. |
| Inline AI diffs | Tiptap `tiptap-changes.ts` has `applied` and `preview` modes, grouping, a change bar and shortcuts. CodeMirror `latex/codemirror/review.ts` has applied-mode hunks only. Neither persists changes or records an author. | This is the rendering layer for suggestions. CodeMirror needs a preview mode. |
| Review mode | Threads, replies, resolve, reattach and search. Anchors are source UTF-16 offsets plus quote, prefix and suffix, remapped by diffing snapshots (`src/lib/markdown-review.ts`). Stored in a single `markdown-reviews.json` with a revision CAS. Messages carry `author?: "agent"` only. | The UI is reused. Storage and anchoring get a shared implementation. |
| AI | Every AI call goes to OpenRouter from the local Next server. Rewrite, Write and Format results are applied by the client. Agentic review applies accepted edits to a server-held snapshot and pushes it back as a draft. The agent's Edit/Write uses `fs.writeFile` directly (`src/lib/agent/tools.ts:701`). | Every write path must become authored, and route through the host for shared files. |
| Local data | `node:sqlite` with sqlite-vec, already packaged (`src/lib/search/database.ts`, `electron/prepare-dist.cjs`). | The host's SQLite needs no new native dependency. |
| Push channels | None. No WebSocket or SSE, only NDJSON streams for AI. `ws` and `esbuild` are already in `node_modules` as transitive dependencies. | WebSocket sync and the MessagePort plumbing are new. |
| Electron | Version 37.6 (Node 22). No `requestSingleInstanceLock`, no `utilityProcess`, no `powerMonitor`. The main window has `contextIsolation: true`, but `sandbox` is not set. | Add a single-instance lock (two instances must never share one SQLite log), plus `powerMonitor` wiring. Sandbox is Phase 4. |
| Tests | `npm run test:editor` (node:test + tsx + jsdom, about 90 files). Route handlers are tested directly with `NextRequest` against temporary data directories. | Collab tests use the same harness. The server gets its own. |

---

## 1. Decisions taken by this plan

The source plan leaves these to Phase 0. The codebase settles most of them. Phase 0 spikes confirm each one or trigger its fallback.

| ID | Decision | Choice | Fallback if the spike fails |
|---|---|---|---|
| D1 | Document model (Q1) | **Source text** (`Y.Text`) for `.md` and `.tex`. The Visual editor uses the block bridge (map §7.2). | Shared Markdown edits only in Source (CodeMirror). Visual becomes a live, read-only rendered view with a "Switch to Source to edit" banner. Comments and suggestions still work in it. |
| D2 | CRDT | Yjs 13, y-protocols, y-codemirror.next | — (Loro/Automerge checked for one day in S1 only) |
| D3 | Sync server | Custom: `ws` + y-protocols, with the envelope from §4 | Hocuspocus with a custom extension, only if persist-before-ack can be done in `beforeHandleMessage` |
| D4 | Tracked changes (Q8) | Build overlay suggestions (map §7.5). No paid component: the vendor options target rich-text trees, not source text. | Restrict v1 suggestions to "select, then propose a replacement" (no free-typing suggest mode) |
| D5 | Local persistence | `node:sqlite`, WAL, `synchronous=FULL` for the update log | — |
| D6 | Compaction / GC | See map §11 | Tune after load tests in Phase 4 |
| D7 | Host process | Electron `utilityProcess` | Main process, with Next's work moved off the hot path |
| D8 | Markdown Source editor | Port to CodeMirror 6, behind a preference until it reaches parity | A textarea binding to `Y.Text` (diff-based), without suggest mode in Source |
| D9 | Server stack | Node 22, TypeScript, Fastify, `ws`, Postgres 16 + Kysely, zod, pino, prom-client, S3-compatible blobs | — |
| D10 | Hosting (Q2) | Self-hosted. Docker Compose on the existing VPS behind nginx | A separate VPS if load tests demand it |
| D11 | Sharing unit | Shared notebook | — |
| D12 | AI identity | AI is an attributed actor that runs locally with the user's key. It can comment and suggest, never decide. | — |
| D13 ★ | Shared code layout | `src/lib/collab/protocol/` is pure TypeScript, imported by the app and bundled by esbuild into the host and the server | — |
| D14 ★ | Commenter suggestions (Q4) | Commenters may suggest. Overlay suggestions write only `annotations`, so no command API is needed to create them. Accepting goes through a server command. | — |

---

## 2. Repository layout after Phase 1

```
server/                       collab server: own package.json + lockfile, not an npm workspace
  src/
    index.ts                  boot: Fastify HTTP + ws upgrade on /sync
    sync/                     rooms, protocol handler, persist-before-ack, fan-out, awareness
    api/                      accounts, auth, projects, members, invitations, blobs, threads,
                              suggestions, decisions, revisions, reviews, admin
    db/                       Kysely schema, migrations/ (SQL), repositories
    storage/                  blob store (S3 or disk), snapshot store
    jobs/                     compaction, checkpoints, notification digests
    auth/                     password hashing, JWT, refresh rotation, role checks
  test/                       unit, integration (testcontainers or compose), fuzz, chaos
  Dockerfile
  tsconfig.json               excluded from the app's tsconfig
electron/
  collab/                     host source (TypeScript); core has no Electron imports
    core/                     DocHub, registry, sqlite store, outbound queue, sync client, materializer
    adapters/                 utilityProcess entry, MessagePort bridge, control API server
    dist/host.cjs             esbuild output (gitignored), copied by prepare-dist
  collab-host.cjs             main-process glue: spawn/restart host, powerMonitor, net, safeStorage
src/lib/collab/
  protocol/                   message codecs, close codes, versions, Actor, schema keys (shared)
  client/                     replica, attach/detach, status store, awareness
  bindings/                   codemirror (y-codemirror.next wrapper), tiptap-ytext bridge
  review-store/               ReviewStore interface, local + shared implementations
  suggestions/                overlay model, CodeMirror preview-mode extension, Tiptap adapter
src/components/libera/collab/ share dialog, members, sign-in, status pill, presence, history,
                              suggestions panel, review requests, reconciliation view
src/app/api/collab/           local routes proxying to the host control API
ops/collab/                   docker-compose.dev.yml, docker-compose.prod.yml, nginx site,
                              backup + restore scripts, Grafana dashboards, Toxiproxy config
scripts/collab/               app-side tests (node:test), kill tests, soak runner
SETUP.md                      server and client setup (see §9)
```

Build and config changes in M1.0:

- `tsconfig.json`: exclude `server/`.
- `eslint.config.mjs`: add a separate block for `server/`.
- `next.config.ts` → `outputFileTracingExcludes`: add `./server/**/*` (see commit c1248d1 for why this list matters).
- `scripts/electron-dev.cjs` and `scripts/build-electron-next.cjs`: run the esbuild host bundle.
- `electron/prepare-dist.cjs`: copy `electron/collab/dist/`.
- `.gitignore`: add `electron/collab/dist/`, `server/node_modules`, `server/dist`.

---

## 3. Phase 0 — Decisions and spikes (2–3 weeks)

Each spike goes on a throwaway branch, ends with a short decision record in `docs/collaboration/decisions/Dn-*.md`, and updates map §11.

| Spike | Question | Pass criteria |
|---|---|---|
| **S1 Visual bridge** (D1) | Can Tiptap stay in step with `Y.Text` by re-serializing only touched blocks? | Two replicas, one Visual and one CodeMirror, type concurrently in the same paragraph, list and table. Both converge. No edit rewrites blocks it did not touch. Vietnamese Telex, Japanese and Chinese IME commit correctly. Remote typing does not move the local caret. A 1 MB note stays within 16 ms per keystroke. |
| **S2 CodeMirror Markdown** (D8) | What does porting `markdown-editor.tsx` cost? | A feature inventory of the textarea editor (toolbar actions in `textarea-editing.ts`, Smart Paste, box colour, file-link picker, slides, snip, Fix ChatGPT equations, highlight layer) with an estimate per item. A prototype with y-codemirror.next and remote cursors. |
| **S3 Host + SQLite kill test** (D5, D7) | Does the update log survive `kill -9` mid-typing on Windows and macOS, including external ExFAT volumes? | A scripted typist sends 10k updates. The host is killed at random times. On restart every update that had been reported committed is present. Measure commit latency (budget < 50 ms p95). |
| **S4 MessagePort plumbing** | Can the host hand a `MessagePort` to the main window and to sandboxed child windows (`/file-window`, `/latex-pdf-window`) through the preload? | Two windows attach to one DocHub and edit live. Reloading a renderer does not drop queued updates. |
| **S5 Server persist-before-ack** (D3) | Is the custom envelope workable on y-protocols? | A minimal server: `hello`/`welcome`/`update`/`ack`/`remote` with Postgres. A kill test on the server: no acked update is ever lost, and unacked updates are resent and deduplicated by `(doc_id, client_id, client_seq)`. |
| **S6 Overlay suggestions** (D4) | Do the six hard cases (§6.3) have explainable outcomes in the overlay model? | Scripted tests for each hard case with the outcomes in §6.4 below. A CodeMirror preview-mode decoration prototype. |
| **S7 Watcher + materializer** | Is `fs.watch` reliable enough on Windows, macOS and ExFAT? | Self-writes are always ignored. External edits are always detected within 2 s, or by the fallback poll (mtime/size every 5 s). Atomic rename does not break the open PDF viewer or search indexing. |

**Phase 0 exit.**

- D1–D14 are recorded.
- The open questions in §11 below are answered (or defaults accepted).
- `docs/collaboration/README.md` §11 is updated.

---

## 4. Phase 1 — Reliable real-time foundation (10–12 weeks)

This is longer than the source plan's 8–10 weeks. It adds the CodeMirror Markdown port, shared notebooks on disk, and sign-in.

### M1.0 ★ Scaffolding

- Create `server/` (Fastify + `ws`), `ops/collab/docker-compose.dev.yml` (Postgres, MinIO, Mailpit, Toxiproxy), `electron/collab/` with the esbuild bundle, and `src/lib/collab/protocol/`.
- Add the feature flag `LIBERA_COLLAB=1`, plus Preferences → Collaboration (server URL, sign-in).
- Write the first version of **`SETUP.md`** (see §9), and link it from `README.md`.
- Add CI jobs for the server and host tests, and `npm run test:collab`.
- **Done when** `docker compose up` plus `npm run electron:dev` shows a "Connected to collab server (dev)" status in Preferences.

### M1.1 Server sync core

- The protocol from §4: `hello`, `welcome`, `diff`, `update`, `ack`, `reject`, `remote`, `awareness`, and close codes 4001, 4003 and 4026. Codecs live in `src/lib/collab/protocol/`.
- Rooms keyed by `docId`, with lazy load from snapshot + log and eviction when idle.
- **Persist-before-ack:** within a room, updates are written one at a time with `INSERT … ON CONFLICT (doc_id, client_id, client_seq) DO NOTHING`, then acked, then fanned out.
- Awareness relay: never persisted, with a 30 s TTL.
- Tables: `documents`, `doc_updates`, `doc_snapshots`.
- **Tests:** a protocol unit suite, and a two-client integration test with a headless client (the host's `core/` running under plain Node).

### M1.2 ★ Accounts, auth and projects

- Tables: `accounts`, `refresh_tokens`, `projects`, `memberships`, `invitations`.
- Email + password (argon2id). Invitation links by email (Mailpit in development). JWT access tokens (15 min) and rotating refresh tokens (30 days).
- REST:
  - `/auth/*`
  - `/projects`
  - `/projects/:id/members`
  - `/invitations/:token/accept`
- Desktop:
  - A sign-in dialog in Preferences → Collaboration.
  - The refresh token is stored with `safeStorage` by `electron/collab-host.cjs`, and the host receives an access token.
  - The local app password and the `admin` storage root are unchanged.
- **Done when** two accounts can sign in from two machines and one can invite the other to a project.

### M1.3 DocHub host in a utilityProcess (source M1.2)

- `electron/collab-host.cjs`:
  - Starts the host with `utilityProcess.fork` and restarts it with backoff.
  - Forwards `powerMonitor` resume/suspend and `net` online events.
  - Adds `app.requestSingleInstanceLock()`.
  - Flushes the host on quit, inside the existing `prepareToQuit` / `state-flush.cjs` sequence.
- Host core:
  - A DocHub registry keyed by `docId`.
  - The SQLite store with tables from §5.1 plus `docs`, `projects` and `blobs_cache` (map §8).
  - An outbound queue with `clientSeq`.
  - A sync client (one WebSocket per server, multiplexing docs).
- The control API is served on `127.0.0.1:<port>` with a per-launch token. The URL and token are passed to Next as `LIBERA_COLLAB_HOST_URL` / `LIBERA_COLLAB_HOST_TOKEN`, following the `LIBERA_SEARCH_WORKER_PATH` pattern in `main.cjs`.
- **Tests:**
  - The host core runs under plain Node in `scripts/collab/`.
  - Kill tests from S3 run in CI.

### M1.4 Renderer replica and editor bindings (source M1.1, M1.2)

- `src/lib/collab/client/`:
  - `attach(docId)` → requests a port through preload (`collab:attach`), builds a `Y.Doc`, and syncs with the hub.
  - Detach on unmount, keeping the hub alive while any window is attached.
- **The Y.Doc outlives editor mounts.** Editors are keyed by tab and unmount on tab switch (`docs/audits/2026-09-14-tab-lifecycle.md`). A shared tab keeps its replica in a tab-level registry, not in the editor component.
- **LaTeX and code:** `latex-editor.tsx` and `code-editor.tsx` get a collab mode.
  - y-codemirror.next replaces the "publish after 250 ms" and the full-replace `Transaction.remote` path (`latex-editor.tsx:297-316`).
  - A Yjs `UndoManager` scoped to the local origin replaces CodeMirror `history()` on shared tabs.
- **Markdown Source:** the CodeMirror 6 port (D8). It runs behind a preference first and becomes the default once it reaches parity.
  - Port the toolbar actions in `textarea-editing.ts` to CodeMirror commands.
  - Port the highlight overlay to a CodeMirror language plus decorations.
  - Port Smart Paste, box colour, the file-link picker, slide controls, snipping, and "Fix ChatGPT equations".
  - The textarea editor stays for non-shared files until parity is verified by the existing editor tests.
- **Visual:** `src/lib/collab/bindings/tiptap-ytext.ts` (the block bridge from S1).
  - `use-tiptap-draft.ts` gets a shared-mode path that never calls `setContent` on the whole document.
  - Undo on shared tabs uses the bridge's local-origin `UndoManager`, not Tiptap's history.
- **Existing consumers of `tab.draft` keep working.**
  - For shared tabs, `getTabDraft` (`use-libera-workspace.ts:739`) reads `ytext.toString()`.
  - Callers include AI context, LaTeX compile staging, the Links dialog, export and the review snapshot.
- **Presence** (M1.1 of the source plan):
  - Cursors, selections, name and colour through y-protocols awareness.
  - Avatars in the tab bar.
  - Quiet mode (§6.5).
- **Done when** two machines edit the same `.tex` and `.md` file in every editor mode, with cursors visible, and stay converged.

### M1.5 ★ Shared notebooks: share, join, manifest, disk copy, assets

- **Share** (notebook menu → "Share notebook…"):
  1. Creates a project.
  2. Runs a **one-time import** (Q7) that builds one document per text file, uploads binaries as blobs and builds the manifest. Existing review threads are imported as threads authored by the owner (Phase 2 data model; until Phase 2 they stay local).
  3. Writes `.libera-shared.json`.
- **Join** (invitation link or Preferences → Collaboration → "Join"):
  - Creates `users/admin/<name>/` and materializes it.
  - A name clash adds a suffix.
  - Linked (directory-mode) folders cannot be shared in v1.
- The manifest drives the notebook tree. `src/lib/storage` reads the shared folder like any notebook. Create, rename, move and delete in the Notebooks panel call `/api/collab/manifest/*` → the host → manifest operations.
- Materializer and watcher from S7:
  - `PATCH /api/files` and the other text-writing routes return `409 shared-document` for files under a shared root, and their callers use the host instead.
  - The writers to audit are `files.ts`, the agent's `writeAgentFile`, OCR "Convert PDF to Markdown", gallery saves into notebook folders, and markdown-assets uploads.
- Blobs: `PUT /blobs/:hash` and `GET /blobs/:hash`, with the hash checked on upload. Markdown `_assets/` and LaTeX figures resolve through the materialized files, so preview, export and `latexmk` need no changes.
- Reconciliation view on `@codemirror/merge` for conflicting external edits.
- **Done when** a notebook with Markdown, images and a multi-file LaTeX project (with `.bib`) shares and joins.
  - The joiner compiles the same PDF.
  - Search finds shared text.
  - Backlinks work.

### M1.6 Save states and workspace integration (source M1.3)

- A status pill per shared tab, showing the six states in map §6, fed by host events (queue depth, oldest unacked age, connection state).
- Shared tabs:
  - Have no Save button and no dirty dot.
  - Report zero to the updater's `set-dirty-document-count`.
  - Are excluded from the session draft journal and the recovery journal (`workspaces:checkpoint`). The host's SQLite is their journal.
- `beforeunload` and quit: wait for the host's "all local edits committed" signal (fast, local), not for server acks.
- **Done when** every state in map §6 is reachable in a scripted test and visible in the UI.

### M1.7 Reconnect and lifecycle (source M1.4)

- Exponential backoff with full jitter, capped at 30 s. Reset immediately on resume or online.
- After resume:
  1. Re-authenticate.
  2. Exchange state vectors.
  3. Send the queue and receive the diff.
  4. Show the "while you were away" summary: changed files and authors, from manifest and update metadata.
- Token refresh is silent. If refresh fails, editing continues locally and the user is asked to sign in.
- Server admission control (connection rate limit) against reconnect storms.
- **Done when** every row of §3.2 passes as an automated test (M1.12).

### M1.8 Roles and enforcement (source M1.5)

- The server checks the role per sub-document on every `update`, and per command. A `reject` triggers the client rollback in §4: reload the sub-document from the server and keep the rejected text exportable through "Copy my unsynced text".
- Revocation:
  - Close code 4003, and the status shows "Access changed".
  - The local copy becomes read-only, with Export.
  - The materialized folder gets a "no longer shared" marker. It is never deleted automatically.
- The UI hides actions the role does not allow (map §4 table).

### M1.9 Schema and protocol versioning (source M1.6)

- `meta.schemaVersion` with read-only mode, and `minProtocolVersion` in `welcome`.
- The forced-update flow uses the existing updater (`electron/updater.cjs`): "Update required to keep syncing".
- The server rejects protocol versions below the minimum with 4026.
- Compatibility matrix test for old client × new document.

### M1.10 Snapshots and compaction (source M1.7)

- Client: the host snapshots every 500 updates or 1 MB, in a worker thread inside the host.
- Server: a compaction job snapshots every 2,000 updates. Log retention follows D6.
- Cold open from snapshot plus log tail.

### M1.11 ★ AI on shared documents, Phase 1 level

The aim is that nothing AI does to a shared file is anonymous or bypasses the host.

- **Actor and provenance:** local edits carry a provenance tag in the Yjs transaction origin. The host writes it to `updates.origin`, and the server stores the user plus provenance in `doc_updates`.
- **Rewrite, Write, Format and Image to Markdown:** the result is applied as one undo step with provenance `ai:<feature>`. Reject in the change bar uses the local `UndoManager`. On shared tabs the applied-mode change bar keeps working as it does today.
- **Agentic review:** the plan and proposals stay in the user's local review session, as today. Accept no longer applies to a server snapshot. It sends the proposal's `{start, end, before, after}` edits to the replica as one transaction, with provenance `ai:agentic-review`, after checking `before` against the live text.
- **Agent:**
  - `writeAgentFile` (`src/lib/agent/tools.ts:701`) detects shared paths and calls the host control API `applyEdits(docId, edits, provenance: {feature: "agent", runId})` instead of `fs.writeFile`.
  - `readCurrentText` reads from the host.
  - Run undo for shared files sends inverse edits and reports a conflict when the text has changed since. This reuses the hash check in `snapshots.ts`.
  - "Modify all files in Notebook/Folder" is unavailable in shared notebooks until Phase 3.
- **Leave review comments:** disabled for shared documents until M2.3, with an explanation in the skill result.
- **Document chat:** unchanged. Context for shared tabs comes from the replica.

### M1.12 Test harness (source M1.8)

- **Convergence fuzzer** (`scripts/collab/fuzz.test.ts`, fast-check):
  - N headless hosts against a real server, with random edits, partitions, duplication and reordering.
  - Asserts identical `Y.Text` content and state vectors.
- **Chaos:** Toxiproxy between host and server (latency, loss, resets), in compose.
- **Kill tests:** host and server, at random points.
- **Durability matrix:** one test per row of §3.2.
- **24 h soak** with 10 simulated clients (`scripts/collab/soak.ts`), run nightly.

**Phase 1 exit (as in the source plan, plus):**

- Every row of §3.2 passes.
- The §10 budgets are met.
- The 24 h soak shows zero divergence.
- Every existing `npm run test:editor` test passes, so non-shared notebooks have no regressions.

---

## 5. Phase 2 — Comments and version history (6–8 weeks)

### M2.1 Shared comments on the existing review UI

- **`ReviewStore` interface** (`src/lib/collab/review-store/`), extracted from today's calls in `markdown-review-context.tsx`. The methods are `load`, `comment`, `reply`, `edit`, `resolve`, `reattach`, `delete` and `subscribe`.
  - `LocalReviewStore` wraps the existing `/api/markdown-reviews` routes unchanged.
  - `SharedReviewStore` uses anchors in `annotations` and `/threads` on the server, with live updates pushed over the sync socket as `thread-event` messages.
- **Anchors become `RelativePosition`s.** `start` and `end` are resolved against `Y.Text`. The selection gesture, block expansion (`paragraphRange`) and the Cmd/Ctrl+Alt+M shortcut stay the same.
- **Authors everywhere.**
  - `ReviewMessage` gets a full `actor`, with avatar, name and colour in `markdown-review-ui.tsx`.
  - Editing and deleting are allowed only for your own messages; owners can delete any message.
- The sidebar is aligned to scroll position in Visual and both CodeMirror editors.

### M2.2 Detached threads and reattach

- **Detached:** both anchor positions resolve to the same point, or the quote is gone. The thread shows the stored quote, a "text was deleted" notice, and **Reattach to selection** (the action already exists).
- Split, move and paste behaviour follow §6.1.
  - Copy-paste never duplicates anchors, because anchors are not part of the copied text.
  - Moving a block with cut and paste detaches the thread, with a reattach suggestion found by quote match. This reuses the `mapAnchor` quote search in `markdown-review.ts`.
- **Test:** the 1,000-operation anchor fuzz from the Phase 2 exit criteria.

### M2.3 Mentions, notifications, and AI-authored comments

- `@name` in comment bodies, using the existing `@` picker pattern from agentic review, against project members.
- In-app notifications: a bell in the rail.
- Desktop notifications through Electron `Notification`.
- A daily email digest from the server job.
- **The leave-review-comments skill on shared documents.** `finishPass` (`src/lib/agent/skills/leave-review-comments.ts:137`) calls the host or server with `createThread` commands carrying actor `{kind: "ai", feature: "review-comments", onBehalfOf}` in place of `addReviewThreads`. The UI shows "AI · requested by Minh". This replaces today's `author: "agent"` badge with a richer actor. Local documents keep the existing path and show the same badge.

### M2.4 Revisions, viewer, diff with attribution

- **Automatic checkpoints:** after 5 minutes idle, at session end, and before accept-all and restore. Named versions: "Name this version…".
- **Viewer:**
  - Reconstructs a revision in the host's worker from snapshot plus updates, or fetches it from the server for old ranges.
  - A read-only CodeMirror view, with a diff between any two revisions on `@codemirror/merge`.
  - Author attribution per changed range from update metadata, colour-coded by actor. AI provenance is shown as "AI rewrite · Minh".
- **Panel:** a "History" entry in the file actions menu.

### M2.5 Restore

- Restoring a whole document or a selected section is applied as **forward edits**: a diff from current to target, applied as actor `system: restore` on behalf of the user. A checkpoint is taken first.

### M2.6 Offline comments

- `pending_commands` in the host. Commands carry an idempotency key, which the server's `commands` table enforces.
- Anchors sync through the CRDT immediately. Messages post when the client is online.
- The UI shows a "pending" chip on unsent messages.

**Phase 2 exit (as in the source plan):**

- Anchors survive the 1,000-operation fuzz run: they are either correct or explicitly detached.
- Any revision of a 1 MB document reconstructs in under 2 s.

---

## 6. Phase 3 — Suggestions, AI as a suggester, formal review (8–12 weeks)

### 6.1 Milestones

#### M3.1 Overlay suggestions: model and rendering

- Model as in map §7.5, under `annotations/suggestions`.
- **Rendering:**
  - Visual editor: convert overlays to `TrackedChange { mode: "preview" }` in `tiptap-changes.ts`. Add `actor`, a per-author colour, and a timestamp to `TrackedChange`, and have the change bar step through them.
  - CodeMirror: a new `src/lib/collab/suggestions/codemirror.ts`. It shows deletions as strike-through marks and insertions as widgets, groups them with Accept/Reject actions, and shares hunk diffing with `latex/codemirror/review.ts` (`diffTexts`).
- **A Suggestions panel** next to Comments, listing pending, stale and decided suggestions, filterable by author, including AI.

#### M3.2 Suggest mode

- **CodeMirror (Source and LaTeX).** A "Suggesting" toggle. A `transactionFilter` turns user changes into overlay operations instead of `content` changes. Contiguous typing extends the same suggestion. A commenter's editor is always in suggest mode.
- **Visual.** "Suggest edit" on a selection opens a replacement prompt (the AI Rewrite popover UI without the AI). Free typing in suggest mode in Visual is a stretch goal. This is the D4 fallback scope.
- **Editing a pending suggestion** is allowed for its author only, and changes the overlay's `replacement`. Others reply to it as a thread.

#### M3.3 Decisions as server commands (source M3.2, M3.3)

- `POST /suggestions/:id/decision {accept|reject, idempotencyKey}`. The server, inside the room's write lock:
  1. Checks the role.
  2. Checks that the text at the anchor still equals `baseQuote`. If not, it marks the suggestion **stale**.
  3. For accept, applies the replacement to `content` as a trusted update with actor `{user: decider}` and provenance `{suggestionId, suggestedBy}`.
  4. Updates the overlay status.
  5. Writes the audit log.
  6. Broadcasts.
- **Accept-all:** takes a checkpoint first, then applies the decisions in document order. Stale suggestions are skipped and listed.
- **Optimistic UI:** the card shows "Accepting…". Offline decisions go to `pending_commands` and are validated on reconnect.
- **Each accept or reject is one undo step for the decider.** Undo after accept is a new command, `revert`, which restores `baseQuote` if the replaced text is unchanged and otherwise reports a conflict.

#### M3.4 ★ AI as an authored suggester (the "author API" for AI)

Every AI write path on shared documents now produces overlay suggestions with actor `{kind: "ai", onBehalfOf: me, feature, model, runId}`:

| Feature | Change |
|---|---|
| Rewrite / Write / Format / Image to Markdown | `replaceTiptapRangeWithMarkdown(…track)` and `applyAiProposal` create a suggestion instead of applying. The UX is unchanged: the result appears inline with Accept and Reject. Collaborators see it too, as "AI · on behalf of Minh". Accept goes through M3.3, so the user must be an editor. A commenter's AI suggestion simply stays pending for an editor. |
| Agentic review | `ReviewSuggestion.edits` (source offsets on the session snapshot) map to anchors on the live `Y.Text`. Each proposal becomes one suggestion group, and linked proposals share a `groupId` that M3.3 accepts atomically. "Request revision" replaces the group, and the old one becomes superseded and withdrawn. The plan conversation stays private to the requesting user. |
| Agent Edit/Write | In shared notebooks, `writeAgentFile` creates suggestions through the control API. The agent's tool result says "suggested, pending review". Run undo withdraws the run's pending suggestions. The permission modes become **Read Only / Suggest in opened files / Suggest in notebook**. New files from the agent are a manifest suggestion (Phase 3 stretch) or are refused. |
| Leave review comments | Already authored in M2.3 |

**Server-side rule:** a decision command whose actor kind is `ai` is rejected with `ai-cannot-decide`.

#### M3.5 Formal review (source M3.4, M3.5)

- **Review request:** base revision, scope (whole document or an anchored section in `annotations/reviewScopes`), assignees, and an optional "run AI review first" that triggers agentic review as the requester.
- **Approvals** record the revision they apply to. Any later change inside the scope marks the approval **outdated**, computed on the server from updates touching the scope's anchor range.
- **Review checkpoint mode:** the reviewer reads the frozen revision (the M2.4 viewer) while drafting continues. A banner says "N changes since this revision", with a diff.
- UI:
  - A "Reviews" section in the Comments rail.
  - A request dialog from the tab bar, next to the Review mode toggle.

#### M3.6 Audit log

- `audit_log` records every decision, approval, role change, restore and accept-all, with the full actor.
- Owners can view it in Project settings.

### 6.2 Hard cases and the outcomes this design gives

| # | Case | Outcome |
|---|---|---|
| 1 | Alice suggests deleting a sentence while Bob edits inside it | Bob's edit lands in `content`. Alice's overlay anchor still spans the sentence, but the text no longer equals `baseQuote`, so it shows as **stale** with the old and new text. Alice or an editor can "Refresh suggestion" to re-base it on the current text. |
| 2 | Bob edits inside Alice's pending insertion | It cannot happen directly, because the insertion is not in `content`. Bob can reply, or make a competing suggestion. Only Alice can edit her suggestion's text. |
| 3 | Two reviewers decide opposite ways at once | The server serializes them. The first decision wins and the second gets `409 already-decided` with the winner, shown as a conflict notice. |
| 4 | A block containing several suggestions is deleted | All their anchors collapse. Each suggestion becomes **stale (target removed)** and is listed in the panel. None is applied. |
| 5 | An offline reviewer accepts a suggestion that has since changed | The decision is held in `pending_commands`. On reconnect the server finds `baseQuote` no longer matches and marks the suggestion stale. The reviewer is told, and their optimistic accept is rolled back in the UI. |
| 6 | Accept-all across several authors | Checkpoint first. Decisions apply in document order inside one server batch. Stale suggestions are skipped and reported. One undo step reverts the batch. |
| 7 ★ | An AI suggestion based on an old snapshot (agentic review's generation took 40 s and the text changed meanwhile) | When it is created, the snapshot's `before` texts are matched against the live text. Matching edits become live suggestions. Non-matching edits become stale at once and show as "conflicted", the same state agentic review uses today. |

**Phase 3 exit:** every row above has an automated test with the stated outcome.

---

## 7. Phase 4 — Hardening and private beta (4–6 weeks)

- **Load testing.** A headless-host load generator (`server/test/load/`) at the target scale (Q5: assumed 20 collaborators per document and 200 concurrently active documents). Check §10 budgets and persist latency p95 < 200 ms.
- **Admin recovery tool** (`server/src/admin/cli.ts`, run with `docker compose exec collab npm run admin -- …`):
  - Inspect a document's update log by user and time.
  - Rebuild from any `serverSeq`.
  - Export a document or a project as files.
  - Detach a corrupt update range into quarantine.
  - Force a snapshot.
- **Backups.**
  - Nightly `pg_dump` plus WAL archiving (pgBackRest or wal-g) to object storage.
  - Blob bucket versioning.
  - A documented **restore drill** in `SETUP.md`, run once before beta and quarterly after.
- **Observability** (§11): prom-client metrics on the server, and client metrics reported by the host in batches. Dashboards and alerts:
  - Unacked updates older than 5 min
  - Divergence-check failures (hourly state-vector hash compare)
  - Persist latency p95 > 200 ms
- **Crash reporting:** Sentry-compatible (self-hosted GlitchTip) for Electron main, the host, the renderer and the server. Document content is never included, only IDs and sizes.
- **Security hardening.**
  - `sandbox: true` on the main window. Audit the preload for APIs that need it (the `sendSync` workspace calls).
  - Sanitize rendered collaborator content.
  - Validate manifest paths.
  - Rate limits on the API.
  - Dependency audit.
  - A threat-model review of the AI prompt-injection boundary (map §10).
- **Manual matrix** (§11):
  - IME (Vietnamese Telex, Japanese, Chinese) in all three editor modes
  - Large pastes
  - Sleep/resume on Windows and macOS
  - ExFAT volumes
  - Screen reader smoke test
- **Private beta** with 3–5 teams:
  - Enable `LIBERA_COLLAB` per account.
  - An in-app "Report sync problem" button attaches host diagnostics (queue state, recent errors, no content).
  - A weekly triage of sync bugs.

**Phase 4 exit:**

- Two weeks of beta with zero acknowledged-data-loss incidents.
- The restore drill passes.
- All alerts are wired up.

---

## 8. Workstreams and timeline

These streams can run in parallel once Phase 0 ends. With 2–4 engineers (Q3):

| Stream | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| A. Server | M1.0, M1.1, M1.2, M1.8, M1.9, M1.10 (server parts) | Threads API, notifications, revisions | Decisions, reviews, audit |
| B. Host and Electron | M1.3, M1.5, M1.7, M1.10 (client parts) | Pending commands, revision reconstruction | Offline decisions |
| C. Editors | M1.4 (CodeMirror Markdown port, Visual bridge, bindings), M1.6 | Anchors, sidebar alignment, history viewer | Overlay rendering, suggest mode |
| D. AI and review | M1.11 | M2.3 AI comments, `ReviewStore` | M3.4 AI suggestions, agentic review mapping |

| Phase | Estimate | Cumulative |
|---|---|---|
| 0 | 2–3 weeks | 3 weeks |
| 1 | 10–12 weeks | about 4 months |
| 2 | 6–8 weeks | about 6 months |
| 3 | 8–12 weeks | about 8.5 months |
| 4 | 4–6 weeks | **about 10 months** |

The biggest swing factors:

- **S1:** if the Visual bridge fails, D1's fallback saves about 3 weeks in Phase 1 but reduces Visual editing.
- **S2:** the size of the CodeMirror Markdown port.

---

## 9. `SETUP.md` (to be written in M1.0, kept current with every milestone)

Planned contents:

1. **Overview.** What runs where (link to the map), and the ports.
2. **Local development.**
   - Prerequisites: Docker Desktop and Node 22.
   - `docker compose -f ops/collab/docker-compose.dev.yml up -d` (Postgres, MinIO, Mailpit, Toxiproxy).
   - `cd server && npm ci && npm run migrate && npm run dev`.
   - Then `LIBERA_COLLAB=1 npm run electron:dev`.
   - Seeding two test accounts with `npm run seed`. Credentials go in `server/.env.example`, never in chat or docs.
   - Running a second desktop instance against the same server with a separate `--user-data-dir`. Two Libera instances must not share one data directory.
   - Mailpit URL for invitation emails.
3. **Server configuration reference.** Every environment variable (`DATABASE_URL`, `BLOB_*`, `JWT_SECRET`, `SMTP_*`, `PUBLIC_URL`, `MIN_PROTOCOL_VERSION`, …) with defaults. Keep `server/.env.example` in step.
4. **Client configuration.** Preferences → Collaboration, the `LIBERA_COLLAB` flag, and where host data lives (`userData/collab/`).
5. **Tests.**
   - `npm run test:collab`
   - `cd server && npm test`
   - Fuzz, chaos and kill-test commands, with their run times
6. **Production deployment on the Libera VPS.**
   - DNS for `libera-collab.intuelle.com`.
   - nginx site with WebSocket upgrade (`ops/collab/nginx/`), and certificates through the existing Let's Encrypt setup.
   - `docker compose -f ops/collab/docker-compose.prod.yml up -d`.
   - Migrations on deploy.
   - Zero-downtime restart notes: clients reconnect with backoff.
7. **Upgrades and versioning.** Bumping `minProtocolVersion` together with an app release (§7 auto-update).
8. **Backups and the restore drill**, step by step.
9. **Admin recovery tool** usage.
10. **Troubleshooting.** Stuck "Syncing…", "Access changed", the forced-update screen, and how to collect host diagnostics.

---

## 10. Risks specific to Libera

| Risk | Mitigation |
|---|---|
| The Visual bridge produces churn or caret jumps in complex blocks (tables, nested lists, math) | S1 tests exactly these. Block-scoped serialization limits the damage. D1 fallback. |
| CodeMirror Markdown port regressions in a heavily used editor | Behind a preference, migrated feature by feature against the existing editor tests. The textarea stays for local files until parity. |
| A forgotten file-write path bypasses the host and silently forks a shared file | `409 shared-document` guard at the storage layer (`src/lib/storage/files.ts` and siblings), not per route. The watcher catches the rest as external edits. A test enumerates every writer. |
| The main process doing Next work starves collab | D7 utilityProcess host |
| Two app instances share one SQLite log | `requestSingleInstanceLock`, plus a SQLite lock check at host start |
| A collaborator's text prompt-injects another user's agent | Agent capped at suggest in shared notebooks. AI can never decide. Shared `AGENT_NOTES.md` is labelled as collaborator-authored in the agent prompt. |
| ExFAT and external volumes (already a pain point in `electron:dev`) break watchers or atomic renames | S7 covers ExFAT. A poll fallback. |
| Byte-identical Markdown is not guaranteed after Visual edits (normalization) | Limited to edited blocks. Documented in the user docs. Attribution shows who changed what. |

---

## 11. Open questions (answers needed before Phase 0 ends)

1. **Q3. Team size and target date.** Section 8 assumes 2–4 engineers. With one engineer, run the streams one after another; expect roughly double the time.
2. **Q5. Scale.** Assumed: at most 20 collaborators per document, about 50 files per shared notebook, about 200 active documents on the server. Is that right?
3. **Q6. Data residency and compliance.** Is the existing VPS location acceptable for document content? Does anything need audit retention beyond the default?
4. **Sign-in method.** Is email + password with invitations enough for the beta, or are Google/Microsoft sign-in needed?
5. **Linked (directory-mode) folders.** They are excluded from sharing in v1. Is that acceptable?
6. **AI cost model.** Each user's own OpenRouter key pays for their AI actions, including AI review on shared documents. Or should there be a team key on the server later?
7. **Visual-mode fallback.** If S1 fails, is "edit shared Markdown in Source, view in Visual" acceptable for the beta?
