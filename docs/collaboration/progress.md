# Collaboration progress tracker

The single place that says what is done. Every line maps to an item in
[implementation-plan.md](implementation-plan.md). A line is ticked only when its
code is merged into the `collaboration` branch **and** the verification named on
the line passes. Items that need people or production access (beta teams, the
restore drill on the real VPS, the manual IME matrix) are marked 👤. Code can
prepare them, but only a person can finish them.

Legend: ☐ not started · ◐ in progress · ☑ done and verified · 👤 needs a person

## Status (18 Oct 2026)

Phases 1–4 are implemented and merged on `collaboration` (local only, not pushed). Test results on the final tree:

- `npm run test:collab`: 378/378
- `cd server && npm test`: 141/141
- `npm run test:editor`: baseline only (4 fail + 2 cancelled, the same as before collaboration)
- `npm run test:collab-e2e`: every step passes. That is two real app instances against a real server; after the last fixes it passed twice on a fresh build.

What is left needs a person or a production environment (👤 items below):
- IME matrix (Vietnamese Telex, Japanese, Chinese) in all three editors
- typing speed on a 1 MB note
- the watcher on macOS and ExFAT
- the first real deploy (DNS, Docker and `.env` on the VPS)
- backups and the restore drill on real Postgres
- a load test against Postgres at the target scale
- the private beta

Known limitations still open:
- Free-typing suggest mode in Visual (Visual has "Suggest edit" on a selection instead)
- Follow mode only in CodeMirror editors
- The agent cannot create new files in shared notebooks
- Deleting or pruning images in shared notebooks still returns 409
- Blobs through the host are capped at 11 MB
- A local-only deletion the server never received is not recovered by the divergence re-open
- AI chat http-image exfiltration path (see `security.md`)
- Dependency audit not done

## Checks from the end-to-end run and review (18 Oct 2026)

- ☑ Two-user end-to-end run of the real app (`npm run test:collab-e2e`, `scripts/collab/e2e/`): share, join, identical disks, live typing in Source, Visual and LaTeX, concurrent edits, status pill, presence, offline and reconnect, clean quit. Bugs it found and their fixes:
  - ☑ Collaboration status stuck after the local login (401 never retried) → retries with backoff and on focus
  - ☑ "Connecting…" stuck after Create account (stale response over a newer event) → responses are confirmed with a fresh request
  - ☑ Visual typing swallowed when a collaborator's caret was at the end of the document → caret widget has no text nodes
  - ☑ Shared comments not listed in the Comments panel (the store called `queueMicrotask` unbound, which Electron refuses); first click on "Add comment" ignored when a collaborator typed mid-click → fixed in Phase 3b (`p3b-comments.test.ts`)
- ☑ A collaborator's new, renamed or deleted file reaches the disk and the Notebooks tree at once (`tree-changed`; open tabs follow moves) (`scripts/collab/notebooks-tree-events.test.ts`)
- ☑ Remote edits no longer write the working copy per keystroke: write after 2 s of quiet, at most every 15 s; the CRDT in SQLite stays the real copy
- ☑ Global Search sees collaborators' edits (host `files-changed` → `POST /api/search/changes`)
- ☑ Accounts are unique by email (case-insensitive) and the email cannot change; the desktop restores its session on launch (refresh token encrypted with safeStorage), and a device stays signed in until unused for 90 days (sliding). The e2e run checks this after a relaunch.
- ☑ LaTeX toolbar: no scrollbar, vertical wheel scrolls it sideways

## Known pre-existing test failures

`npm run test:editor` on this Windows checkout fails 4 tests and cancels 2: global-search-cache, global-search-triggers, global-search, pdf-chat-route and pdf-storage-lifecycle. They fail identically on the base commit 7008487, before any collaboration work. The likely cause is the mixed `node_modules`: the macOS dependency set is active here (`npm run deps:status` reports the win32 cache as stale). Every collaboration merge is checked against this baseline (547 of 554 passing after D8).

## Waves

| Wave | Content | Branches | Status |
|---|---|---|---|
| 0 | Scaffolding (M1.0): dependencies, protocol, schema, server skeleton | `collaboration` | ☑ |
| 1 | Server sync · server API · host core · CodeMirror Markdown · Visual bridge · editor collab library | `collab/sync`, `collab/api`, `collab/host`, `collab/cmmd`, `collab/bridge`, `collab/edlib` | ☑ |
| 1b | Server: revisions, restore, decisions, reviews, audit | `collab/srv23` | ☑ |
| 2 | Electron host integration · shared notebooks · collab UI · test harness · editor wiring · Phase 1 AI | `collab/elec`, `collab/notebooks`, `collab/ui`, `collab/harness`, `collab/wire`, `collab/ai` | ☑ |
| 3 | Phase 2: comments, mentions, notifications, history, restore, offline commands | `collab/p2` | ☑ |
| 4 | Phase 3: suggestions, suggest mode, decisions, AI suggester, reviews, audit | `collab/p3a`, `collab/p3b` | ☑ |
| 5 | Phase 4: load, admin CLI, backups, observability, crash reporting, hardening | `collab/srv4`, `collab/p4d` | ◐ (👤 items left) |

## Phase 0: decisions and spikes

The spikes are carried out as the first, tested slice of the matching milestone, not as throwaway branches. Their pass criteria become tests.

- ☐ S1 Visual bridge: convergence, untouched blocks preserved, IME hold (tests in M1.4); 👤 real IME check
- ☑ S2 CodeMirror Markdown inventory and parity list (`decisions/D8-codemirror-markdown.md`)
- ☑ S3 Host SQLite kill test (M1.3)
- ☐ S4 MessagePort to main and child windows (M1.4/M2 wave 2)
- ☑ S5 Server persist-before-ack kill test (M1.1)
- ☐ S6 Overlay suggestions: hard cases scripted (M3.1)
- ☑ S7 Watcher and materializer self-write and external-edit tests (M1.5); 👤 ExFAT and macOS check
- ☐ Decision records D1–D14 in `decisions/`

## Phase 1: reliable real-time foundation

### M1.0 Scaffolding
- ☑ Dependencies: yjs, y-protocols, lib0, y-codemirror.next, fast-check, esbuild (app); server package with lockfile
- ☑ `src/lib/collab/protocol/`: codec, messages, actor, roles, schema, REST contracts, local replica protocol (`npm run test:collab`)
- ☑ Server skeleton on Fastify with PGlite or Postgres, migrations, full schema, tokens, access helpers, error handling (`cd server && npm test`)
- ☑ Build config: tsconfig/eslint excludes, Next tracing exclude, gitignore, host esbuild bundle script
- ☑ `SETUP.md` first version (local development on PGlite, configuration, tests, deployment)
- ☑ Server Dockerfile; `ops/collab` production and development compose files; nginx site with WebSocket upgrade; `npm run collab:deploy` (dry run verified; 👤 first real deploy needs DNS, Docker and `.env` on the VPS)
- ◐ CI workflow `.github/workflows/collab.yml` (written; runs once the branch is pushed to GitHub)
- ☐ Feature flag `LIBERA_COLLAB` and Preferences → Collaboration

### M1.1 Server sync core
- ☑ hello/welcome, version check (4026), auth (4001/4002), token refresh on the socket, ping/pong, frame limits
- ☑ open/opened with state-vector diff per sub-document; rooms loaded from snapshot + tail, unloaded when idle
- ☑ Persist-before-ack, dedupe on (doc, client, clientSeq), serverSeq ordering
- ☑ Fan-out `remote`; awareness relay, removal on disconnect, 90 s silent-socket drop
- ☑ Role check per sub-document, reject reasons, annotation ownership, suggestion status rules, manifest path validation
- ☑ RoomService: transact, withDocs, membershipChanged, documentDeleted, accountRevoked
- ☑ Event forwarding from the bus to subscribers (doc, project, user scopes)
- ☑ Admission control (per-IP rate, per-account sockets, 4029; 4050 on shutdown)
- ☑ Server kill test: no acknowledged update lost (`server/test/sync-kill.test.ts`, PGlite on disk)

### M1.2 Accounts, auth and projects
- ☑ Register (invitation or open sign-up), login, refresh rotation with reuse detection, logout, /me, password change, rate limits
- ☑ Projects CRUD, members, roles, invitations (email + link), accept; audit entries
- ☑ Documents create (one-time import), updates feed with baseSnapshot, delete
- ☑ Blobs PUT/GET/HEAD with hash check (disk driver; S3 driver with SigV4 checked against AWS vectors; 👤 not yet tried against a real S3 service)
- ☑ Mail (SMTP or log)
- ◐ Desktop sign-in dialog (UI merged: account dialog, colour, connection wording); `safeStorage` refresh token in wave 2 (Electron host)

### M1.3 DocHub host
- ☑ SQLite store (WAL, `synchronous=FULL`): updates, snapshots, outbound, doc_meta, threads_cache, pending_commands, docs, projects, blobs_cache, rejected edits; owner lock
- ☑ DocHub registry, replica attach/detach, multi-window (in-memory ports; MessagePort adapter in wave 2)
- ☑ Outbound queue with clientSeq, batching, identical resends after restart
- ☑ Sync client: one socket, multiplexed docs, ack tracking, rejects with rollback, backoff with full jitter, nudge, token refresh, 4026/access-revoked handling; verified against the real server (`scripts/collab/integration-host-server.test.ts`)
- ☐ Control API on loopback with a per-launch token
- ☐ utilityProcess entry, main-process glue (restart, powerMonitor, net, single-instance lock, quit flush)
- ☑ Host kill test (S3): p95 append commit about 2 ms on this machine

### M1.4 Replica and bindings
- ☑ Renderer replica client over MessagePort, tab-level registry outliving editor mounts (`scripts/collab/wire-*.test.ts`)
- ☑ LaTeX and code editors: y-codemirror.next, local-origin UndoManager
- ☑ Markdown Source on CodeMirror 6 with feature parity, behind Preferences → Source editor (Classic default); external-document seam for the binding; parity table in `decisions/D8-codemirror-markdown.md`. 👤 Before the default flips: try it in the running app, run the IME matrix, and check typing on a 1 MB note
- ☑ Visual block bridge (S1): about 2 ms per keystroke on 1 MB; wired so the editor starts empty and the bridge builds it. 👤 Real IME check
- ☑ `getTabDraft` reads the replica for shared tabs; programmatic draft writers rerouted through minimal-diff Y writes with provenance
- ☑ Presence: avatars with sections, quiet mode, follow mode (CodeMirror only; not Visual)

### M1.5 Shared notebooks
- ☑ Share: UI dialog; host import (exact text, blobs, folders, manifest), marker, retry-safe pending file
- ☑ Join: UI dialog; host accepts the invitation and materializes everything with hash-checked blobs; name-clash suffix
- ☑ Manifest-driven file ops: create, rename, move, delete (editor+); remote deletes go to `_archive`
- ☑ Materializer (atomic, debounced, case-clash suffixes, path-escape refusal) and watcher (fs.watch plus a 5 s poll; self-writes ignored by hash); `409 shared-document` guard on every Libera writer (`scripts/collab/notebooks-guard.test.ts`). 👤 Watcher not yet tried on macOS or ExFAT
- ☑ Blob sync both ways
- ☑ Reconciliation: host side, routes and `ReconcileView` (`@codemirror/merge`)

### M1.6 Save states
- ☑ Status pill for all seven states, mounted per shared tab
- ☑ No Save or dirty state on shared tabs; updater count 0; journals and checkpoints skip shared tabs; no disk reloads
- ☐ Quit waits for local commit

### M1.7 Reconnect
- ☐ Backoff with full jitter capped at 30 s; immediate reset on resume and online
- ☐ Re-auth, state-vector exchange, "while you were away" summary
- ☐ Silent token refresh; sign-in prompt keeps local editing

### M1.8 Roles
- ◐ Reject rollback with "Copy my unsynced text": host side and banner component merged; mounting in editor wiring
- ☑ Revocation: sync stops, folder kept, marker `revoked: true`, resolvePath read-only (export UI banner merged; mounting in editor wiring)
- ◐ UI hides disallowed actions in share/members dialogs (`can()`); editor-side read-only in editor wiring

### M1.9 Versioning
- ☐ schemaVersion read-only mode; minProtocolVersion; forced-update flow; compatibility test

### M1.10 Snapshots and compaction
- ☑ Client snapshots (500 updates or 1 MB) in a worker thread; only acked updates are pruned
- ☑ Server compaction job (2,000 updates), retention that keeps revision snapshots
- ☐ Cold open from snapshot plus tail

### M1.11 AI at Phase 1 level
- ☑ Provenance on every local edit, stored server-side
- ☑ Rewrite/Write/Format/Image applied with `ai:<feature>` provenance as one undo step (Visual included)
- ☑ Agentic review accept through the replica, with a `before` check
- ☑ Agent Edit/Write through the control API with ai/agent provenance; undo as inverse edits with conflict check; notebook-wide mode refused; role checks; AGENT_NOTES in shared notebooks labelled untrusted
- ☑ Leave review comments disabled on shared docs (until M2.3)

### M1.12 Test harness
- ◐ Convergence fuzzer: anchor fuzz (1,000 operations) and a two-replica fuzz exist; the multi-host fuzz against the real server is in wave 2
- ☐ Chaos proxy (latency, loss, resets)
- ☐ Kill tests in CI
- ☐ Durability matrix: one test per §3.2 row
- ☐ Soak runner (24 h nightly; 👤 schedule on CI)

## Open gaps found during integration

- ☑ Libera's own writers for shared files go through the host: shared tabs have no Save; the agent, OCR convert, uploads, markdown images, edited images and image generation into notebooks (blobs). Remaining: deleting/pruning images in shared notebooks still returns 409; blobs through the host are capped at 11 MB.
- ☑ `GET /v1/projects/:id/documents` added for the host's `ApiClient.listDocuments` (members; live documents, no manifest).
- ☑ Divergence check: server digest endpoint plus an hourly host comparison with recovery. Edge left: a local-only deletion the server never received cannot be recovered by the re-open.

## Phase 2: comments and history
- ☑ Server: revisions (named, auto checkpoints job, reconstruction at any seq), restore of a whole doc or a section as minimal forward edits (M2.4/M2.5 server sides)
- ☑ Client library: RelativePosition anchors, detach and reattach candidates, 1,000-operation anchor fuzz (`src/lib/collab/anchors.ts`)
- ☑ Server: threads, messages, status, reattach, notifications (mentions, replies, resolved, invitations), digest job, idempotent offline commands endpoint (M2.1/M2.3/M2.6 server sides)
- ☑ M2.1 `ReviewStore` interface; local store (unchanged behaviour) and shared store; RelativePosition anchors; authors (AI shown as "AI · requested by X"); panel follows scroll (best effort)
- ☑ M2.2 Detached state with stored quote, reattach to selection, "found similar text"; anchor fuzz in the library
- ☑ M2.3 Bell, @ member picker, desktop notifications (with a switch), server mentions and digest; AI-authored review comments on shared docs (the leave-review-comments skill creates threads through the host with an AI actor; `scripts/collab/ai-shared-writes.test.ts`, `p3b-agent.test.ts`)
- ☑ M2.4 Automatic and named revisions, session-end revisions; History panel with a revision viewer and diffs coloured by author (AI provenance labelled)
- ☑ M2.5 Restore whole document or a selection as forward edits, with a checkpoint
- ☑ M2.6 Offline comments through pending commands, with pending/failed chips, retry and discard; plus a one-time migration of local comments into a shared notebook

## Phase 3: suggestions and review
- ☑ Server: suggestion mirror, decisions serialized in the room (stale checks incl. insertion neighbours, groups all-or-nothing, accept-all with checkpoint, revert, offline replay), reviews with revision-bound approvals and outdated detection, audit entries; hard cases 1–7 end to end (`server/test/hard-cases.test.ts`)
- ☑ Server: annotation authorship enforced for every role (new records in the sender's name, no re-attribution, suggestion actor = creator) (`server/test/sync-authorship.test.ts`)
- ☑ Client library: overlay model, stale detection, groups, snapshot-edit mapping, CodeMirror preview and suggest mode, Tiptap preview with authors; hard cases 1, 2, 4 and 7 at model level (`scripts/collab/edlib-*.test.ts`)
- ☑ M3.1 Overlay suggestions rendered in every shared editor with author colours and AI labels; Suggestions panel (filters, groups, stepping, accept/reject all, withdraw/edit own, undo acceptance)
- ◐ M3.2 Suggest mode in CodeMirror (toggle; forced for commenters; IME held until compositionend); "Suggest edit" in Visual; editing your own suggestion. Not done: free typing in suggest mode in Visual
- ☑ M3.3 Decisions through the server (exactly once), accept-all with checkpoint, revert, offline decisions queued and replayed
- ☑ M3.4 AI as suggester: rewrite/write/format/image (3a); agentic review proposals as AI groups with stale mapping, revision withdraw and server decisions (`p3b-agentic-review.test.ts`); agent Edit/Write as suggestions, undo withdraws, Read Only / Suggest in opened files / Suggest in notebook, commenters suggest (`p3b-agent.test.ts`, `ai-shared-writes.test.ts`, `ai-host-e2e.test.ts`); `ai-cannot-decide` (server)
- ☑ M3.5 Review requests (whole doc or anchored selection, AI review first), Reviews tab, revision-bound approvals, outdated detection, offline decisions, checkpoint mode, notifications open the review (`p3b-reviews.test.ts`)
- ☑ M3.6 Audit log and owner-only Activity log viewer with action filter and paging (`p3b-audit.test.ts`)
- ☑ Hard cases 1–7 automated (server end to end in `server/test/hard-cases.test.ts`; 1, 2, 4, 7 also at model level)

Phase 3 part B also fixed the shared Comments panel staying empty in Electron (the store called `queueMicrotask` as its own method, which browsers refuse), the passage popover closing when a collaborator typed mid-click, and authors not being able to withdraw a stale suggestion on the server (`p3b-comments.test.ts`). Replies to suggestions are linked comment threads (`p3b-reply.test.ts`).

## Phase 4: hardening and beta
- ☐ Load generator and results against §10 budgets
- ☐ Admin recovery CLI (inspect, rebuild, export, quarantine, snapshot)
- ☐ Backup scripts (pg_dump + WAL archiving) and restore drill script; 👤 drill on the real VPS
- ☑ Metrics, dashboards, alerts (server); client telemetry with counts only, incl. reconnect time and host restarts
- ☑ Crash reporting without content (server reporter); desktop diagnostics bundle with scrubbing
- ◐ Main, setup and export windows sandboxed; allowlist sanitizer for collaborator Markdown; API rate limits; threat model in `security.md`. Remaining: dependency audit; AI chat http-image exfiltration path (documented in security.md)
- ☑ "Report sync problem" diagnostics (copy or save, scrubbed)
- ☐ 👤 Manual matrix (IME, sleep/resume, ExFAT, screen reader)
- ☐ 👤 Private beta with 3–5 teams
