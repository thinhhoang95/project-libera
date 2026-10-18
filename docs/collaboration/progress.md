# Collaboration progress tracker

The single place that says what is done. Every line maps to an item in
[implementation-plan.md](implementation-plan.md). A line is ticked only when its
code is merged into the `collaboration` branch **and** the verification named on
the line passes. Items that need people or production access (beta teams, the
restore drill on the real VPS, the manual IME matrix) are marked 👤. Code can
prepare them, but only a person can finish them.

Legend: ☐ not started · ◐ in progress · ☑ done and verified · 👤 needs a person

## Status at pause (18 Oct 2026)

Merged on `collaboration` and green: server (110 tests), desktop-side collaboration (250 tests), editor suite at baseline. Merged branches: protocol and server skeleton, server sync, server REST API, server revisions/decisions/reviews, host core, CodeMirror Markdown editor, Visual bridge, editor library, collaboration UI, shared notebooks, Electron host integration, test harness. Three host recovery bugs found by the harness are fixed.

Not merged yet: editor wiring (`collab/wire`) and server Phase 4 (`collab/srv4`) were still running at the pause; check their clones under the session scratchpad before restarting them. Still to do after those: Phase 1 AI rerouting (M1.11), Phase 2 client (shared ReviewStore, history viewer, restore UI, offline comments UI), Phase 3 client (suggestions panel, suggest mode in the editors, decisions UI, AI as suggester, review requests UI, audit viewer), Phase 4 desktop (sandbox, sanitizing, diagnostics, divergence check), and every 👤 item.

## Known pre-existing test failures

`npm run test:editor` on this Windows checkout fails 4 tests and cancels 2: global-search-cache, global-search-triggers, global-search, pdf-chat-route and pdf-storage-lifecycle. They fail identically on the base commit 7008487, before any collaboration work. The likely cause is the mixed `node_modules`: the macOS dependency set is active here (`npm run deps:status` reports the win32 cache as stale). Every collaboration merge is checked against this baseline (547 of 554 passing after D8).

## Waves

| Wave | Content | Branches | Status |
|---|---|---|---|
| 0 | Scaffolding (M1.0): dependencies, protocol, schema, server skeleton | `collaboration` | ☑ |
| 1 | Server sync · server API · host core · CodeMirror Markdown · Visual bridge · editor collab library | `collab/sync`, `collab/api`, `collab/host`, `collab/cmmd`, `collab/bridge` (running), `collab/edlib` | ◐ |
| 1b | Server: revisions, restore, decisions, reviews, audit | `collab/srv23` | ☑ |
| 2 | Electron host integration · shared notebooks · collab UI · test harness (running); editor wiring and Phase 1 AI next | `collab/elec`, `collab/notebooks`, `collab/ui`, `collab/harness` | ◐ |
| 3 | Phase 2: comments, mentions, notifications, history, restore, offline commands | — | ☐ |
| 4 | Phase 3: suggestions, suggest mode, decisions, AI suggester, reviews, audit | — | ☐ |
| 5 | Phase 4: load, admin CLI, backups, observability, crash reporting, hardening | — | ☐ |

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
- ☐ Renderer replica client over MessagePort, tab-level registry outliving editor mounts
- ☐ LaTeX and code editors: y-codemirror.next, local-origin UndoManager
- ☑ Markdown Source on CodeMirror 6 with feature parity, behind Preferences → Source editor (Classic default); external-document seam for the binding; parity table in `decisions/D8-codemirror-markdown.md`. 👤 Before the default flips: try it in the running app, run the IME matrix, and check typing on a 1 MB note
- ☐ Visual block bridge (S1)
- ☐ `getTabDraft` reads the replica for shared tabs
- ◐ Presence: library done (awareness user state, sections, quiet mode, follow mode); UI in wave 2

### M1.5 Shared notebooks
- ☑ Share: UI dialog; host import (exact text, blobs, folders, manifest), marker, retry-safe pending file
- ☑ Join: UI dialog; host accepts the invitation and materializes everything with hash-checked blobs; name-clash suffix
- ☑ Manifest-driven file ops: create, rename, move, delete (editor+); remote deletes go to `_archive`
- ☑ Materializer (atomic, debounced, case-clash suffixes, path-escape refusal) and watcher (fs.watch plus a 5 s poll; self-writes ignored by hash); `409 shared-document` guard on every Libera writer (`scripts/collab/notebooks-guard.test.ts`). 👤 Watcher not yet tried on macOS or ExFAT
- ☑ Blob sync both ways
- ☑ Reconciliation: host side, routes and `ReconcileView` (`@codemirror/merge`)

### M1.6 Save states
- ◐ Status pill component for all seven states (merged); mounting per tab in editor wiring
- ☐ No Save or dirty state on shared tabs; updater count; journals skip shared tabs
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
- ☐ Provenance on every local edit, stored server-side
- ☐ Rewrite/Write/Format/Image applied with `ai:<feature>` provenance; reject = local undo
- ☐ Agentic review accept through the replica, with a `before` check
- ☐ Agent Edit/Write through the control API; undo as inverse edits; notebook-wide mode disabled
- ☐ Leave review comments disabled on shared docs (until M2.3)

### M1.12 Test harness
- ◐ Convergence fuzzer: anchor fuzz (1,000 operations) and a two-replica fuzz exist; the multi-host fuzz against the real server is in wave 2
- ☐ Chaos proxy (latency, loss, resets)
- ☐ Kill tests in CI
- ☐ Durability matrix: one test per §3.2 row
- ☐ Soak runner (24 h nightly; 👤 schedule on CI)

## Open gaps found during integration

- ☐ Reroute Libera's own writers for shared files to the host: Save (no Save on shared tabs), the agent's Edit/Write (M1.11), OCR convert, uploads and image saves into shared notebooks (as blobs through file ops). Until then they get a clear 409.
- ☐ Host `ApiClient.listDocuments` has no server route; the notebooks code works around it. Add `GET /v1/projects/:id/documents` or remove the client method.
- ☐ Divergence check: server digest endpoint (Phase 4 agent) plus an hourly host comparison.

## Phase 2: comments and history
- ☑ Server: revisions (named, auto checkpoints job, reconstruction at any seq), restore of a whole doc or a section as minimal forward edits (M2.4/M2.5 server sides)
- ☑ Client library: RelativePosition anchors, detach and reattach candidates, 1,000-operation anchor fuzz (`src/lib/collab/anchors.ts`)
- ☑ Server: threads, messages, status, reattach, notifications (mentions, replies, resolved, invitations), digest job, idempotent offline commands endpoint (M2.1/M2.3/M2.6 server sides)
- ☐ M2.1 `ReviewStore` interface; local and shared stores; RelativePosition anchors; authors on messages; sidebar alignment
- ☐ M2.2 Detached state and reattach; split, move and paste rules; 1,000-operation anchor fuzz
- ◐ M2.3 Notifications bell UI merged (grouped, mark read, open document); server mentions/digest done; desktop notifications, mention picker and AI-authored comments pending
- ☐ M2.4 Automatic and named revisions; viewer; diff with attribution
- ☐ M2.5 Restore (whole or section) as forward edits
- ☐ M2.6 Offline comments through pending commands with idempotency

## Phase 3: suggestions and review
- ☑ Server: suggestion mirror, decisions serialized in the room (stale checks incl. insertion neighbours, groups all-or-nothing, accept-all with checkpoint, revert, offline replay), reviews with revision-bound approvals and outdated detection, audit entries; hard cases 1–7 end to end (`server/test/hard-cases.test.ts`)
- ☑ Server: annotation authorship enforced for every role (new records in the sender's name, no re-attribution, suggestion actor = creator) (`server/test/sync-authorship.test.ts`)
- ☑ Client library: overlay model, stale detection, groups, snapshot-edit mapping, CodeMirror preview and suggest mode, Tiptap preview with authors; hard cases 1, 2, 4 and 7 at model level (`scripts/collab/edlib-*.test.ts`)
- ☐ M3.1 Overlay model; Tiptap preview rendering with authors; CodeMirror preview extension; Suggestions panel
- ☐ M3.2 Suggest mode in CodeMirror; "Suggest edit" in Visual; editing your own suggestion
- ☐ M3.3 Decision commands with stale check and exactly-once apply; accept-all checkpoint; revert; offline decisions
- ☐ M3.4 AI as suggester: rewrite/write/format/image; agentic review groups; agent suggest modes; `ai-cannot-decide`
- ☐ M3.5 Review requests, revision-bound approvals, outdated detection, checkpoint mode
- ☐ M3.6 Audit log and viewer
- ☐ Hard cases 1–7 automated

## Phase 4: hardening and beta
- ☐ Load generator and results against §10 budgets
- ☐ Admin recovery CLI (inspect, rebuild, export, quarantine, snapshot)
- ☐ Backup scripts (pg_dump + WAL archiving) and restore drill script; 👤 drill on the real VPS
- ☐ Metrics, dashboards, alerts
- ☐ Crash reporting without content
- ☐ Main-window sandbox; content sanitizing; rate limits; dependency audit; prompt-injection review
- ☐ "Report sync problem" diagnostics
- ☐ 👤 Manual matrix (IME, sleep/resume, ExFAT, screen reader)
- ☐ 👤 Private beta with 3–5 teams
