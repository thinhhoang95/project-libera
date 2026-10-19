# Real-Time Collaboration for the Electron App — Implementation Plan

**Status:** Draft for review
**Date:** 18 Oct 2026
**Assumed team:** 2–4 experienced engineers
**Assumed scope:** one document type first (rich text *or* LaTeX/Markdown source, decided in Phase 0)

---

## 0. Summary

We will build local-first collaborative editing:

- A **CRDT** (Yjs by default) runs inside the Electron app.
- An **established editor binding** connects the CRDT to the editor.
- A **server** handles authentication, permissions, durable storage and review decisions.

Typing never waits on the network.

Reliability is defined by an explicit **durability contract**. "Connected", "Saved on this device" and "Saved to workspace" are separate states, and each one is backed by a real acknowledgment.

Delivery order, with estimated elapsed time:

1. **Phase 0 — Decisions and spikes:** 2–3 weeks
2. **Phase 1 — Reliable real-time foundation:** 8–10 weeks
3. **Phase 2 — Comments and version history:** 6–8 weeks
4. **Phase 3 — Suggestions (tracked changes) and formal review:** 8–12 weeks
5. **Phase 4 — Hardening and private beta:** 4–6 weeks
6. **Phase 5 — Differentiators:** ongoing, prioritised by beta feedback

**Total to a hardened release: roughly 7–10 months.** Custom tracked changes or the LaTeX build platform can extend this.

---

## 1. Goals and non-goals

### Goals

- Multiple people edit the same document at once, with no perceptible typing latency.
- Editing continues offline. Nothing acknowledged as saved is ever lost.
- Recovery after sleep, network changes, crashes and token expiry is automatic and understandable.
- Comments stay attached to the right text through concurrent edits.
- Suggestions (tracked changes) and formal reviews follow explicit, predictable rules.
- Permissions are enforced by the server, not just hidden in the UI.

### Non-goals for v1

- Building our own CRDT/OT algorithm or editor.
- Peer-to-peer or LAN sync without the server.
- End-to-end encryption. It is incompatible with server-side validation; revisit only if the market requires it.
- Full document branching. Review checkpoints and proposals come first.
- Voice or video comments.
- High-fidelity .docx import/export. Basic export only.

---

## 2. Architecture

### 2.1 Components

| Component | Process | Responsibility |
|---|---|---|
| Editor + binding | Renderer | Rendering, input, IME, cursors, decorations for comments and suggestions |
| Renderer replica | Renderer | Y.Doc mirror of the hub's doc, synced over `MessagePort` |
| **DocHub** (one per open document) | Main process | Owns the local replica, local persistence, network sync, awareness relay, ack tracking |
| Local store | Main process (SQLite, WAL mode) | Append-only update log, snapshots, outbound queue, cached comments |
| Worker | Electron `utilityProcess` | Compaction, history reconstruction, diffing, search indexing (keeps main and renderer responsive) |
| Sync service | Server (Node) | Auth, permission checks on every update, persistence-before-ack, fan-out, awareness relay |
| API service | Server | Comment threads, mentions, notifications, revisions, reviews, approvals, invitations |
| Storage | Postgres + object storage | Update log, snapshots, thread data, audit log |
| Compaction job | Server | Periodic snapshots, log truncation, garbage collection |

### 2.2 Why the hub lives in the main process

- **One owner per document per machine.** Two windows on the same document share one replica and one persistence pipeline, so they cannot race each other.
- **Durability ordering.** The main process writes to SQLite before telling the UI "Saved on this device".
- **Network independence.** Reloading or crashing a renderer does not drop the connection or lose queued updates.

### 2.3 Document structure (per file)

Each file gets a root Y.Doc with **sub-documents split by permission**. The server can then accept or reject updates per sub-document according to the user's role.

| Sub-document | Contents | Who can write |
|---|---|---|
| `content` | Text / rich-text tree | Editors |
| `annotations` | Comment anchors and suggestion metadata (relative positions, keyed by ID) | Editors and commenters |
| `meta` | `schemaVersion`, title, settings | Owners and editors |

Comment *thread content* (messages, mentions, resolved state) lives in Postgres behind the API, not in the CRDT. Only the *anchor* lives in the doc.

For multi-file projects (LaTeX), add a **project manifest** Y.Doc. It holds the file tree, file IDs and asset references. Each file is its own document; renames and moves change only the manifest.

### 2.4 Edit flow (happy path)

1. A keystroke in the editor triggers a binding transaction, which updates the renderer Y.Doc.
2. The renderer forwards the update to the DocHub over `MessagePort`.
3. The DocHub appends it to the SQLite update log. Status: **Saved on this device**.
4. The DocHub batches updates (20–50 ms) and sends them to the sync service with `clientSeq`.
5. The server checks permissions, persists the update, assigns `serverSeq` and returns `ack{clientSeq, serverSeq}`. Status: **Saved to workspace**.
6. The server fans the update out to other clients, which apply it through the same path in reverse.

---

## 3. Durability contract and sync states

### 3.1 States shown to users

| State | Meaning | Backed by |
|---|---|---|
| Saved on this device | Every local edit is in the SQLite log | SQLite commit returned |
| Syncing… | Connected; N updates awaiting server ack | Outbound queue non-empty |
| Saved to workspace | Every local update acknowledged by the server | Queue empty, last ack received |
| Offline — N changes on this device | Not connected; edits safe locally | Connection down |
| Read-only — update required | Doc uses a newer schema than this client | `meta.schemaVersion` > supported |
| Access changed | Permission revoked or downgraded | Server close code |

### 3.2 Failure situations (these become acceptance criteria)

| Situation | Required behaviour |
|---|---|
| High latency | Local typing unaffected; remote edits arrive later; no UI jank |
| Temporary disconnect | Editing continues; queue grows; status shows offline count |
| Laptop sleep / network switch | Reconnect within ~2 s of resume (`powerMonitor` + network events), not on the next backoff tick |
| Reconnect after long offline | Re-authenticate, exchange state vectors, send/receive only the missing diff, then show a "while you were away" summary |
| App crash | All updates committed to SQLite are recovered on restart |
| Server crash | All acknowledged updates are recovered; unacknowledged ones are resent from the client queue |
| Token expiry | Silent refresh; if refresh fails, keep editing locally and prompt sign-in |
| Access revoked while offline | Local work preserved; sync refused; user can export their local copy |
| Old client reconnects | Server rejects protocol below the minimum version; client goes read-only if the doc schema is newer |
| Duplicate / reordered delivery | No effect. CRDT updates are idempotent and commutative; acks are keyed by `clientSeq` |

### 3.3 Hard rules

- **Never rebuild a collaborative doc from exported JSON or Markdown.** This breaks sync identity and duplicates content. Exports are one-way.
- **Never acknowledge before persisting**, on either the client or the server.
- **Every persisted update carries an authenticated author** (`userId`, `clientId`, server timestamp). Retrofitting authorship later is not possible.

---

## 4. Sync protocol

Base it on the y-protocols sync and awareness messages, and add an envelope:

```
Client → Server
  hello        { protocolVersion, appVersion, token, docId, stateVector }
  update       { docId, subdoc, clientSeq, update: bytes }
  awareness    { docId, state }            // ephemeral, never persisted

Server → Client
  welcome      { serverStateVector, minProtocolVersion, role }
  diff         { docId, subdoc, update }   // the changes the client is missing
  ack          { docId, clientSeq, serverSeq }
  reject       { docId, clientSeq, reason } // e.g. permission, schema
  remote       { docId, subdoc, update, serverSeq }
  awareness    { docId, states }
  close codes  4001 auth expired · 4003 access revoked · 4026 client too old
```

Details:

- **Batching:** 20–50 ms on the client. Cap batch size to protect against huge pastes; split large updates.
- **Backoff:** exponential with full jitter, capped at 30 s. Reset immediately on `resume` or a network-online event.
- **Awareness** (cursors, selection, name, colour, "viewing section X") expires after 30 s without a heartbeat.
- **Rejected updates:** the client must roll back locally. The simplest rollback: discard the local replica for that sub-document and reload it from the server state, keeping the rejected text available to export or copy so nothing silently disappears.

---

## 5. Data model

### 5.1 Client (SQLite)

```
updates(doc_id, subdoc, local_seq PK, update BLOB, origin, created_at,
        acked_server_seq NULL)
snapshots(doc_id, subdoc, upto_local_seq, state BLOB, state_vector BLOB, created_at)
outbound(doc_id, client_seq, local_seq)          -- pending server ack
doc_meta(doc_id, schema_version, last_seen_server_seq, last_opened_at)
threads_cache(thread_id, doc_id, json, updated_at) -- offline read of comments
pending_commands(id, kind, payload, created_at)   -- offline comment posts, review actions
```

### 5.2 Server (Postgres)

```
documents(id, project_id, kind, schema_version, created_by, created_at)
doc_updates(doc_id, subdoc, server_seq, user_id, client_id, client_seq,
            update BYTEA, received_at)            -- unique (doc_id, client_id, client_seq)
doc_snapshots(doc_id, subdoc, upto_server_seq, state BYTEA, state_vector BYTEA)
memberships(project_id, user_id, role)            -- owner | editor | commenter | viewer
revisions(id, doc_id, server_seq, label NULL, kind, created_by, created_at)
                                                  -- auto checkpoints + named versions
threads(id, doc_id, anchor_id, quote_text, status, created_by, created_at)
                                                  -- status: open | resolved | detached
messages(id, thread_id, author_id, body, mentions, created_at, edited_at)
suggestions(id, doc_id, author_id, status, created_at, decided_by, decided_at)
                                                  -- status: open | accepted | rejected | stale
reviews(id, doc_id, requested_by, base_revision_id, scope, status, created_at)
review_assignments(review_id, user_id, decision, decided_revision_id, decided_at)
audit_log(id, actor_id, action, target, details JSONB, at)
```

The `unique (doc_id, client_id, client_seq)` constraint makes resends idempotent at the server.

---

## 6. Feature design notes

### 6.1 Comments

- **Anchor** = start and end relative positions stored in `annotations` under `anchorId`. Threads reference `anchorId`.
- **Stored quote:** keep the original quoted text on the thread for context.
- **When the anchored text is deleted,** the thread becomes **detached**. It shows the original quote, an "attached text was deleted" notice and a **Reattach** action.
- **Defined behaviour for:**
  - Split paragraph: the anchor spans both parts.
  - Move block: the anchor moves with the text, using move semantics if the editor supports them; otherwise, delete + insert detaches the thread.
  - Copy/paste of commented text: anchors are *not* duplicated.
- **Offline:** posting a comment queues a command. The anchor syncs via the CRDT and the message via the API once online.
- **Notifications:** @mentions, replies to my threads, and resolutions of my threads, delivered in-app and by desktop/email digest.

### 6.2 Version history

- **Automatic checkpoints:** after 5 minutes idle, on session end and before any accept-all.
- **Named versions:** created by users.
- **Viewing:** reconstruct any revision from the nearest snapshot plus updates, in the worker process.
- **Diff view:** between any two revisions, with author attribution.
- **Restore:** applied as **new forward edits**, never by rewriting history. Restoring a whole doc and restoring a single section are both supported.

### 6.3 Suggestions (tracked changes)

**Phase 0 decision:** buy (e.g. an existing tracked-changes extension for the chosen editor) or build. Evaluate any option against the hard cases below before committing.

- **Rich text model:**
  - An insertion is real text with a `suggestion{id, author, kind: insert}` mark.
  - A deletion keeps the text with `kind: delete`, rendered as strikethrough.
  - A formatting change records the before and after marks.
- **Source-text (LaTeX) model:**
  - An insertion is real text plus a range in `annotations`.
  - A deletion removes the text from `content` and stores it in `annotations` with a relative position, so builds see the "accepted" view by default.
  - Decide whether the PDF preview can toggle to show suggestions applied or not.
- **Accept/reject** are commands applied against the *current* document. If the suggestion's target has changed since it was made, it is marked **stale** and shown for manual resolution.
- **Hard cases (these become test cases):**
  1. Alice proposes deleting a sentence while Bob edits inside it.
  2. Bob edits inside Alice's pending insertion.
  3. Two reviewers make opposite decisions concurrently. The server orders them; the first one wins and the second gets a conflict notice.
  4. A block containing several suggestions is deleted.
  5. An offline reviewer accepts a suggestion that has since changed. It is held as pending until the server validates it, and becomes stale if the target changed.
  6. Accept-all across multiple authors. A checkpoint is created first.
- **Permissions:** commenters may suggest. Because suggestions write to `content`, the server cannot cheaply verify that a commenter's binary update only adds suggestion-marked content. **Recommended:** commenters' suggestions go through a server command API, which the server applies as a trusted actor. Editors write directly. (Open question Q4.)

### 6.4 Formal review

- A review request names a **base revision** and a **scope**: the whole doc or an anchored section.
- An approval records the **revision it applies to**. Any later change in scope marks the approval **outdated**; it never silently stays green.
- **Review checkpoint mode:** the reviewer reads a frozen revision while drafting continues live. A banner shows "N changes since this revision", with a diff.
- Decisions are optimistic in the UI and authoritative only after server validation. Offline decisions stay pending.

### 6.5 Presence

- Shows each collaborator's cursor, selection, name and colour, plus the section they are in, in a sidebar mini-map.
- **Follow mode:** jump to and track a collaborator's viewport.
- **Quiet mode:** hide remote cursors while syncing continues.
- **Soft section ownership** (Phase 5): "Minh is rewriting §3" as a visible signal, not a lock.

### 6.6 Undo

- Per-user selective undo, using the UndoManager scoped to the local origin. Remote changes are never undone by my Undo.
- Accept/reject and restore actions are each a single undo step.

---

## 7. Electron specifics

- **Security:**
  - `sandbox: true`, `contextIsolation: true`, no `nodeIntegration` in renderers.
  - The preload exposes a minimal, typed IPC API.
  - Treat all document content and comments as untrusted input: sanitize rendered HTML and never pass content to shell or filesystem APIs.
- **Threading:** compaction, history reconstruction, diffing and search indexing run in `utilityProcess`. Budget: no main-process task over 10 ms.
- **Multi-window:** the DocHub registry is keyed by `docId`; extra windows attach as replicas.
- **External file edits** (source-text projects):
  - A watcher detects changes made by other tools.
  - Small changes are converted into CRDT operations via a text diff.
  - If the doc changed concurrently, show a reconciliation view. Never overwrite the shared doc from disk.
- **Auto-update:** coordinate app updates with `minProtocolVersion` so users are prompted to update before they are locked out.

---

## 8. Phased delivery

### Phase 0 — Decisions and spikes (2–3 weeks)

| Spike | Output |
|---|---|
| Editor choice (Tiptap/ProseMirror vs CodeMirror 6) | Decision record + prototype with Yjs binding + IME check (Vietnamese, Japanese, Chinese) |
| CRDT choice (Yjs default; quick check of Loro/Automerge) | Decision record |
| Sync server: Hocuspocus vs y-sweet vs custom on y-protocols | Decision record; must support persist-before-ack and per-sub-document permission hooks |
| Tracked changes: buy vs build | Run the six hard cases against candidates; decision + cost |
| Persistence kill-test prototype | SQLite WAL update log survives `kill -9` mid-typing with zero loss of committed updates |

**Exit:** all decisions recorded, and the open questions in section 13 answered.

### Phase 1 — Reliable real-time foundation (8–10 weeks)

| Milestone | Deliverable |
|---|---|
| M1.1 | Two clients typing together, with cursors and presence |
| M1.2 | DocHub in the main process, SQLite log, renderer replica via `MessagePort`, multi-window |
| M1.3 | Server persist-before-ack; `clientSeq`/`serverSeq`; the three save states in the UI |
| M1.4 | Reconnect: backoff with jitter, `powerMonitor` resume, network events, token refresh, state-vector diff |
| M1.5 | Roles and server-side permission enforcement per sub-document; revocation handling |
| M1.6 | Schema and protocol versioning; read-only mode for newer docs; forced-update flow |
| M1.7 | Snapshots and compaction (client and server); cold open of large docs |
| M1.8 | Test harness: convergence fuzzer, network chaos, kill tests, in CI |

**Exit criteria:**

- Every row of the section 3.2 table passes automated tests.
- Performance budgets in section 10 are met.
- 24-hour soak test with 10 simulated clients passes with zero divergence.

### Phase 2 — Comments and version history (6–8 weeks)

| Milestone | Deliverable |
|---|---|
| M2.1 | `annotations` sub-document anchors; threads API; sidebar aligned to scroll |
| M2.2 | Detached-thread state + reattach; split, move and paste behaviours |
| M2.3 | Mentions, notifications (in-app, desktop, email digest) |
| M2.4 | Automatic and named revisions; revision viewer; diff with attribution |
| M2.5 | Restore (whole doc and section) as forward edits |
| M2.6 | Offline comments via the pending-commands queue |

**Exit:** comments survive the 1,000-operation fuzz run with correct or explicitly detached anchors, and any revision can be reconstructed in under 2 s for a 1 MB doc.

### Phase 3 — Suggestions and formal review (8–12 weeks)

| Milestone | Deliverable |
|---|---|
| M3.1 | Suggest mode: insert, delete, (rich text) format; rendering; per-author colours |
| M3.2 | Accept/reject commands; stale detection; accept-all with checkpoint |
| M3.3 | Commenter suggestions via the server command API |
| M3.4 | Review requests: base revision, scope, assignments |
| M3.5 | Revision-bound approvals; outdated detection; review checkpoint mode |
| M3.6 | Audit log for review decisions |

**Exit:** all six hard cases have automated tests with documented, explainable outcomes.

### Phase 4 — Hardening and private beta (4–6 weeks)

- Load testing at the target number of collaborators per doc and concurrent active docs.
- Admin recovery tool: inspect a doc's update log, rebuild from any `serverSeq`, export.
- Backups with a tested restore drill.
- Crash reporting, telemetry and dashboards (section 11).
- Private beta with 3–5 real teams; weekly review of sync-related bug reports.

### Phase 5 — Differentiators (prioritised by beta feedback)

| Idea | Difficulty | Notes |
|---|---|---|
| **Return-to-work briefing** | Medium | What changed since my last visit, open threads mentioning me, decisions affecting my sections; optional AI summary |
| **AI edits as suggestions** | Medium–high | The AI is a visible author; its edits go through the suggestion pipeline |
| **Compile-aware LaTeX** (if source-text) | High | Build pinned to a revision; attribute a broken build to the edit that caused it; PDF↔source comment mapping (SyncTeX) |
| **Soft section ownership** | Low–medium | Uses awareness + annotations |
| **Private proposal workspace** | High | Draft a large rewrite privately, submit it as one suggestion group |
| **Semantic collision hints (simple version)** | Medium | Flag two authors editing the same paragraph within N seconds |

---

## 9. LaTeX/project track (only if the source-text model is chosen)

This is a parallel track adding about 2–4 months. It can start after Phase 1.

- Project manifest, file tree operations and binary asset upload with content hashing.
- Isolated build service (container per build, resource limits, timeouts) or a local build option in Electron.
- Builds pinned to a project revision (a set of `serverSeq` per file) so errors map to known source.
- SyncTeX-based source↔PDF navigation; comments anchored on the PDF that map to source.
- A shared build cache across the team.

---

## 10. Performance budgets

| Metric | Target (p95) |
|---|---|
| Keystroke to local paint | < 16 ms |
| Local edit to "Saved on this device" | < 50 ms |
| Remote edit visible to collaborator (same region) | < 300 ms |
| Cold open, 1 MB document | < 1.5 s |
| Resync after 1 hour offline with 2,000 local edits | < 2 s |
| Paste of 1 MB text | No UI freeze over 100 ms |
| 20 active collaborators on one doc | Budgets above still met |

---

## 11. Testing and observability

### Testing

- **Convergence fuzzer:** property-based tests (e.g. fast-check) with N clients and random edits, partitions, duplication and reordering. Assert identical state and correct anchors. Runs in CI and nightly at larger scale.
- **Chaos:** network latency, loss and disconnect injection (e.g. Toxiproxy) between client and server.
- **Kill tests:** `kill -9` the client and the server at random points; verify the durability contract.
- **Compatibility:** an old-client/new-doc matrix for every schema bump.
- **Manual matrix:** IME (Vietnamese Telex, Japanese, Chinese), screen readers, large pastes, Windows/macOS/Linux, sleep/resume.

### Observability

**Client metrics:**
- Queue depth and age of the oldest unacked update
- Reconnect count and duration
- Rejected updates
- Divergence checks (periodic state-vector hash comparison with the server)

**Server metrics:**
- Persist latency and fan-out latency
- Active rooms and collaborators per room
- Update log growth; snapshot and compaction lag

**Alerts:**
- Unacked updates older than 5 minutes for any client
- Divergence detected
- Persist latency p95 over 200 ms

---

## 12. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Tracked-changes complexity explodes | Phase 3 slips by months | Buy-vs-build spike in Phase 0; restrict v1 suggestion types; hard cases as tests early |
| Server can't validate CRDT updates by role | Permission bypass | Per-permission sub-documents; command API for commenter suggestions |
| Anchor drift or orphaned comments | Loss of trust | Detached state + quote + reattach; fuzz anchors in CI |
| History growth / large docs | Slow opens, storage cost | Snapshots, compaction, GC policy decided in Phase 1 |
| Schema evolution breaks old clients | Silent data loss | Schema version in `meta`; read-only mode; minimum protocol version |
| Reconnect storms after an outage | Server overload | Jittered backoff; server-side admission control |
| Editor binding gaps (tables, IME) | Bugs at edges | IME and table cases in the Phase 0 spike; budget for upstream fixes |
| Merged text is valid but semantically wrong | Confusing docs | Catch-up summary, simple collision hints, easy section restore |

---

## 13. Open questions for review

1. **Q1 — Document model:** rich text (Google Docs-like) or LaTeX/Markdown source (Overleaf-like)? This drives the editor choice, the suggestion model and whether section 9 applies.
2. **Q2 — Sync server:** self-hosted only, or is a hosted backend acceptable for Phase 1 to save time?
3. **Q3 — Team size and target date:** these confirm or adjust the timeline above.
4. **Q4 — Commenter permissions:** can commenters suggest edits? If yes, approve the server command API approach.
5. **Q5 — Expected scale:** maximum collaborators per document, and documents per team.
6. **Q6 — Data residency or compliance requirements:** these affect storage, audit retention and whether E2E encryption is needed.
7. **Q7 — Existing documents:** is there a migration from the current storage format? If so, a one-time import tool is needed (never a recurring re-import).
8. **Q8 — Tracked changes:** is a paid third-party component acceptable?

---

## 14. Decision log (fill in during Phase 0)

| ID | Decision | Options considered | Chosen | Rationale | Date | Owner |
|---|---|---|---|---|---|---|
| D1 | Editor | | | | | |
| D2 | CRDT library | | | | | |
| D3 | Sync server | | | | | |
| D4 | Tracked changes buy/build | | | | | |
| D5 | Local persistence | | | | | |
| D6 | Compaction/GC policy | | | | | |
