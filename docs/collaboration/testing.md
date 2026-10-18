# Collaboration testing

**Last updated:** 18 Oct 2026

This page explains how to run the collaboration tests, what each one proves, and how long it takes. It covers the harness from plan M1.12: the chaos proxy, the multi-host cluster driver, the convergence fuzzer, the durability matrix for source-plan §3.2, the performance checks for §10, and the soak runner.

## Running the tests

| Command | What it runs | Time |
|---|---|---|
| `npm run test:collab` | Every `scripts/collab/*.test.ts`: unit tests, host tests, the host/server integration test and the harness | about 2.5 min wall time (150–163 s measured, against 27 s before the harness) (the files run in parallel; the durability matrix is the longest) |
| `node --require ./scripts/editor/setup.cjs --import tsx --test scripts/collab/harness-durability.test.ts` | One harness file on its own | see the table below |
| `LIBERA_COLLAB_HEAVY=1 npm run test:collab` | The same with the heavy cases turned on | about 10–15 min |
| `node --import tsx scripts/collab/soak.ts --minutes 5` | The soak runner | as long as `--minutes`, plus about 30 s of setup |

The harness needs nothing beyond the repo's dependencies. There is no Docker and no Postgres: the server runs in a child process on an embedded PGlite database in a temp directory, and the chaos proxy is plain Node.

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `LIBERA_COLLAB_HEAVY` | unset | `1` turns on the heavy cases: 200 fuzz runs with longer schedules, 10,000 offline edits instead of 2,000, 5 host kills instead of 2, 10 s of duplicate/reorder chaos, 60 s of 20-collaborator typing |
| `LIBERA_COLLAB_FUZZ_RUNS` | 20 (200 when heavy) | Number of fuzz schedules |
| `LIBERA_COLLAB_FUZZ_SEED` | random, printed | Replays a fuzz run |
| `LIBERA_COLLAB_FUZZ_PATH` | unset | With the seed, jumps straight to the failing schedule (printed on failure) |
| `LIBERA_COLLAB_FUZZ_SHRINK` | unset | `1` lets fast-check shrink a failing schedule (slow: each run takes seconds) |
| `LIBERA_COLLAB_PERF_SLACK` | 3 | Multiplier on the §10 budgets in assertions, so a loaded CI machine does not flake. The measured numbers are always printed. |
| `LIBERA_HARNESS_DEBUG` | unset | `1` prints host warnings and every host event |

Every measurement is printed as a line starting with `[collab-perf]`, so `npm run test:collab 2>&1 | grep collab-perf` shows them all.

### Replaying a fuzz failure

A failing fuzz run prints a line like:

```
[collab-fuzz] FAILED. Replay with LIBERA_COLLAB_FUZZ_SEED=1298322125 LIBERA_COLLAB_FUZZ_PATH=37 LIBERA_COLLAB_FUZZ_RUNS=20
```

Run only the fuzzer with those variables. fast-check's error message also contains the counterexample: the number of hosts, the typists' seed, and the list of actions.

```
LIBERA_COLLAB_FUZZ_SEED=1298322125 LIBERA_COLLAB_FUZZ_PATH=37 \
  node --require ./scripts/editor/setup.cjs --import tsx --test scripts/collab/harness-fuzz.test.ts
```

## The harness

All support code lives in `scripts/collab/harness/`.

| File | What it is |
|---|---|
| `chaos-proxy.ts` | A TCP proxy with one listen port (a `ProxyLink`) per simulated client. Each link controls, at runtime: one-way latency with jitter (order preserved), bandwidth per direction, stalls (both directions or one), black holes (accept and hold, forward nothing), silent death of open sockets (a network switch), partitions (reset open connections and every new one), resets on command or at random intervals, and duplication or reordering of sync frames. REST and the sync WebSocket of a client share its link, so they fail together. After the WebSocket upgrade the proxy parses frames, so it duplicates or swaps whole `update`, `remote` and `ack` frames without corrupting the stream. |
| `cluster.ts` | `Cluster` starts the server and the proxy and creates hosts. It registers accounts, creates projects, invites members, changes roles, creates docs, restarts the server on the same data directory and port (crash or deploy, optionally with new settings), and waits for convergence. `HarnessHost` wraps a real `CollabHost` with its own SQLite file and link. `TokenSession` is one sign-in, with a single-flight refresh, because refresh tokens rotate and a reused one revokes the session. |
| `server-reader.ts` | Reads the server's copy of a doc with a fresh WebSocket straight to the server (not through the proxy). Convergence checks compare every host with this, so hosts that agree on something the server lacks still fail. |
| `typist.ts` | Seeded random typists using `hub.applyLocalChange`: inserts, deletes, replaces, newlines and multi-line pastes, with emoji (surrogate pairs and ZWJ sequences), decomposed Vietnamese (combining marks), CJK and RTL text. Positions never split a surrogate pair or a combining sequence. `MarkerTypist` types unique `<tag:n>` markers so tests can say exactly which edits survived. |
| `markers.ts` | Finds markers in text and in the host's SQLite log, split into acknowledged and committed. |
| `host-child.ts` | A host in its own process that types markers and prints each one after its commit returns. The kill tests `SIGKILL` it. |
| `collaborator-child.ts` | A collaborator in its own process for the 20-collaborator check. Twenty hosts in one process would share one event loop and measure the test process, not the product. |
| `stats.ts` | Percentiles, the slack factor and the `[collab-perf]` reporter. |

**Convergence** means: every host has the same content text and the same content state vector, no host has unacknowledged edits, and a fresh server reader sees the same text and state vector.

## What each test proves

### `harness-proxy.test.ts` (about 6 s)

A self-test of the proxy against a `ws` echo server. Each fault does what the other tests rely on: latency without reordering, the bandwidth cap, partitions, black holes, silent socket death that spares new sockets, per-direction stalls, duplication of whole sync frames only, reordering of server frames, and a reset when the upstream is down.

### `harness-durability.test.ts` (about 2.5 min)

One test per row of source-plan §3.2, using real hosts and the real server through the proxy.

| §3.2 row | Test | What is asserted |
|---|---|---|
| High latency | `high latency` | With an 800 ms round trip, `applyLocalChange` returns in under 50 ms (p95), and the edit is already in SQLite when it returns. The status changes within 50 ms of the edit. Remote edits arrive at least 750 ms later. The event loop never stalls for 250 ms or more. Every edit arrives exactly once. |
| Temporary disconnect | `temporary disconnect` | While partitioned, the status is `offline` and `pending` grows by one per edit, with the detail `Offline — N changes on this device.` Every edit is in SQLite. The other host keeps syncing. After the heal (no nudge), the queue drains and everyone converges. |
| Laptop sleep / network switch | `laptop sleep` | With a long backoff pending (about 18 s), a healed network alone does not reconnect within 1 s, but `nudge()` reconnects within 2 s (measured: 10–13 ms). |
| | `network switch` (**todo**) | `nudge()` should replace a socket that silently died within about 2 s. It takes about 5.2 s. See the product gaps below. |
| | `server restart` (**todo**) | A reconnect attempt refused while the server was down should not delay recovery. It delays it by up to 15 s. See the product gaps below. |
| Reconnect after long offline | `long offline` | 2,000 offline edits (10,000 when heavy) plus 50 remote edits resync after `nudge()`. Only the missing diff comes down (about 800 bytes for a 22,000-character doc), and resync stays under 2 s × slack. Every surviving edit arrives exactly once. The "while you were away" summary is UI and is not covered here. |
| App crash | `app crash` | A host in a child process is killed with `SIGKILL` mid-typing, twice (5 times when heavy) on the same database. A relaunch while partitioned shows every edit whose commit returned, from SQLite alone. After the heal, the server has each one exactly once. Resent batches reuse their clientSeq. |
| Server crash | `server crash` | Two hosts type until both have acknowledged edits. The server is killed with `SIGKILL` at a random moment, and the hosts are partitioned until a fresh reader has checked the restarted server. Every acknowledged edit (taken from `acked_server_seq` in each host's SQLite) is on the server. After the heal, the unacknowledged ones are resent, and every edit is present exactly once. |
| Token expiry | `token expiry` | Runs on its own server with `ACCESS_TOKEN_TTL_SECONDS=3`. A token that expires while the host is offline is refreshed silently on reconnect (close 4001, then refresh), with no `needs-sign-in`. When the session is signed out on the server, the host goes to `needs-sign-in`, editing continues locally (`offline`, `N changes on this device. Sign in to sync.`, rows in SQLite, nothing on the server), and signing in again syncs everything. A live socket outliving its token is not tested: the server allows 60 s of grace (`SyncTimings.tokenGraceMs`). |
| Access revoked while offline | `access revoked while online` | This is the control case. Removing a connected member shows `access-changed`, makes the doc read-only (`access-revoked`), and keeps the local text. |
| | `access revoked while offline` | Edits made offline by a member who was removed meanwhile never reach the server or other hosts. They stay in the member's text and in SQLite (exportable). |
| | `... becomes read-only` (**todo**) | On reconnect the doc should show Access changed and become read-only. It stays writable. See the product gaps below. |
| | `access reduced to viewer` | Offline edits by a member who was made a viewer are rejected (`forbidden`). The rejected text, including those edits, is kept for "Copy my unsynced text". The doc reloads the server's state and is read-only (`role`). |
| Old client reconnects | `old client` | After a deploy with `MIN_PROTOCOL_VERSION=2`, the host goes to `update-required` and keeps local edits (`offline`, `Update Libera to keep syncing.`, rows in SQLite). Nudges cause no reconnect attempts. After the "update" (minimum back to 1, host restarted), everything syncs. Read-only for a newer doc schema is not covered, because the schema version of a server doc cannot be changed from outside. |
| Duplicate / reordered delivery | `duplicate and reordered delivery` | Three hosts type while their links duplicate half the sync frames and reorder 30% of server frames (hundreds of each per run). Every edit appears exactly once after convergence. Then an explicit identical resend: the update reaches the server, the ack is held and discarded with a reset, and the host resends the same clientSeq and bytes. The server log holds no `(clientId, update)` pair twice. |

### `harness-fuzz.test.ts` (about 60–75 s for 20 runs)

The convergence fuzzer. Each run creates a new doc and 3–5 fresh hosts, then runs a fast-check schedule of 4–14 actions (up to 30 when heavy). Actions are drawn from:

- random edits
- partitions, heals with a nudge, resets and black holes
- stalls, latency and jitter
- duplication and reordering rates
- waits
- graceful host restarts
- server restarts (kill or graceful)

At the end every fault heals, and every host and the server must converge within 45 s. Hosts use `connectTimeoutMs: 2000` and a 3 s backoff cap, so faults heal in seconds. The product defaults are covered by the durability matrix. 100 runs (seed 1298322125) and the default 20-run suite runs all passed.

### `harness-perf.test.ts` (about 60 s)

The §10 budgets, measured on loopback. See the measured numbers below.

### `scripts/collab/soak.ts`

Ten hosts, each typing at a bursty human rate, run through the proxy for `--minutes`. Chaos fires every 5–20 s, picked at random:

- partitions of 1–3 hosts for 3–18 s
- latency up to 450 ms with jitter
- random resets
- duplication and reordering
- black holes
- stalls
- network switches with a nudge
- graceful host restarts

The server is also killed or restarted every `--server-restart-minutes` (default 4).

Every `--check-minutes` (default 1), typing and chaos stop, everything heals, and the run waits for convergence with the server (timeout `--convergence-timeout-s`, default 120). It logs one JSON line per check: edits, doc size, server seq, convergence time, chaos counts, resets, duplicated and reordered frames, and RSS. It exits with code 1 on divergence and 2 if the harness crashed. Hosts run with the product's default timeouts and with compaction on.

Nightly CI runs `node --import tsx scripts/collab/soak.ts --minutes 1440`.

## Measured numbers (§10 budgets)

These were measured on 18 Oct 2026 on an i9-12900HK (20 threads) with Windows 11 and Node 22.17. Numbers marked "suite" are from the full parallel `npm run test:collab` run, which loads the machine. The others are from the file run on its own.

| Metric | Budget (p95) | Measured |
|---|---|---|
| Local edit to "Saved on this device" (connected) | < 50 ms | p50 1.5 ms, p95 2.2–2.7 ms, max 7.7 ms |
| Local edit to "Saved on this device" (offline) | < 50 ms | p95 2.3–3.7 ms |
| Local edit with an 800 ms round trip | < 50 ms | p95 2.3–5.4 ms; the status changes 3.5–6 ms after the edit |
| Remote edit visible to a collaborator, loopback | < 300 ms | p50 36–43 ms, p95 53–62 ms |
| Remote edit visible, 40 ms round trip to the server | < 300 ms | p95 about 110 ms on its own; up to 500 ms in the loaded suite |
| Cold open of a 1 MB doc from the host's SQLite (1,700-edit log) | < 1.5 s | 90–114 ms from the log, 21–40 ms from a snapshot |
| First open of a 1 MB doc on an empty host (from the server) | n/a | 70–111 ms |
| Resync after offline: 2,000 local edits (+50 remote) | < 2 s | 139–307 ms (nudge to acknowledged and converged) |
| Resync after offline: 2,000 local + 200 remote edits | < 2 s | 130–594 ms |
| Paste of 1 MB | no freeze > 100 ms | `applyLocalChange` with the SQLite commit: 8–20 ms; visible on the other host after 270–670 ms; host event loop delay max 17–31 ms |
| 20 active collaborators (one process each, 2 edits/s each) | budgets above still met | local commit p95 7–7.6 ms; remote visible p50 55 ms, p95 91–101 ms, max 150–189 ms |

The resync numbers above exclude the time a host can spend stuck in `connecting` because of the refused-handshake gap below. With that gap, a host that tried to reconnect during the partition resyncs 15–16 s after the heal, not after 0.3 s. The long-offline tests wait for the stuck attempt to time out before they measure.

## Soak result

A 6-minute run (`--minutes 6 --server-restart-minutes 2 --seed 4242`) on 18 Oct 2026 found **zero divergence** and exited 0.

- Activity: 7,488 edits from 10 hosts, final server seq 6,727, and the doc held at about 150,000 characters by the size cap.
- Chaos: 2 server kills, 7 partitions, 2 black holes, 5 random-reset phases, 7 latency phases, 1 duplicate/reorder phase (228 duplicated and 180 reordered frames), 1 network switch, 2 stalls, 1 host restart, and 77 connection resets in total.
- Convergence: all 6 checks converged. Most took 0.2–3.3 s. The worst took 12.9 s, right after a server kill, which is the refused-handshake gap below. RSS stayed at 300–450 MB for the whole harness process: 10 hosts, the proxy and the typists.

## Product gaps found by the harness

The three todo tests above stay in the suite as todos. Fix them in the product code, then remove the `todo` option.

1. **Silently dead socket after a network switch** (`§3.2 network switch: nudge() replaces a socket that silently died within ~2 s`). When the socket is `connected`, `SyncClient.nudge()` sends a ping. It drops the socket only after `nudgePongTimeoutMs`, which defaults to 5000 ms, and `CollabHostOptions` cannot set it. The host reconnects about 5.2 s after resume, against the ~2 s of §3.2.
2. **Refused handshake leaves the client in `connecting` for 15 s** (`§3.2 server restart: a reconnect attempt refused while the server was down does not delay recovery`).
   - `SyncClient.connect()` assumes that "an error is always followed by close". With Node's built-in WebSocket (undici 6.21 in Node 22.17; Electron's main process uses the same), a handshake that fails with ECONNREFUSED or a reset fires `onerror`, or nothing, but never `onclose`, and `readyState` stays CONNECTING.
   - The client waits for `connectTimeoutMs` (15 s), and `nudge()` does nothing while it is connecting.
   - So after a server restart or a brief partition, recovery takes about 11–16 s instead of the backoff delay or the nudge. The soak's convergence checks after a server kill take about 13 s for this reason.
   - Reproduce in plain Node: `new WebSocket("ws://127.0.0.1:<closed port>")` never fires `close`.
3. **Access revoked while offline is not shown as revoked** (`§3.2 access revoked while offline: on reconnect the doc shows Access changed and becomes read-only`).
   - The server answers the reconnect's `open` with `closed{reason: "not-found"}`, because `documentAccess()` returns null for a non-member. `DocHub.handleClosed` treats `not-found` as "This document is not on the server."
   - The doc stays writable, with status `offline` or `saved-local` instead of `access-changed`. A revocation seen while online is handled correctly.
   - The edits are not lost: they stay in SQLite and in the text.

Smaller observations that are not failing tests:

- While connected, a local edit's state is `syncing` with `pending` ≥ 1. `saved-local` only appears before the server has answered `open`. `protocol/local.ts` says the hub echoes `saved-local` after persisting. The durable fact, the edit in SQLite before `applyLocalChange` returns, is asserted either way.
- From reading `sync-client.ts` (not tested): `SyncClient` refreshes a live token `refreshLeadMs` (60 s) before expiry. With an access-token TTL shorter than that, the delay is 0 on every reschedule, so a provider that reports `accessTokenExpiresAt` would refresh in a loop. The production TTL is 15 minutes, so this only matters for test settings. The harness's token provider does not report an expiry, for this reason.
