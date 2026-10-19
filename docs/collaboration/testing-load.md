# Load testing the collab server

This note covers the Phase 4 load generator (implementation plan §7) and the results so far.

The targets are:

- 20 collaborators per document and 200 concurrently active documents (Q5);
- persist latency p95 under 200 ms;
- remote edits visible to collaborators in under 300 ms at p95 (source plan §10).

## How to run it

```bash
cd server
npm run load -- --help
npm run load                                    # the target: 200 docs x 20 clients, 3 typists each, 60 s
npm run load -- --docs 50 --typists 1 --cps 2 --duration 30 --out ../load.json
npm run load -- --database-url postgres://libera:libera@127.0.0.1:55432/libera   # spawned server on Postgres
npm run load -- --url http://staging:4400 --metrics-token <token>               # a running server
```

`server/test/load/run.ts` runs in five stages:

1. **Server.** It spawns a server (`test/load/server.ts`) with production settings and jobs on. The data is PGlite in a temp directory unless `--database-url` is given. The single-IP limits are raised: sign-up, sockets per account and connections per minute.
2. **Fixtures.** It creates the fixtures through the REST API: `--clients` accounts, projects of `--docs-per-project` documents with every account invited as an editor, and markdown documents of about 4 KB.
3. **Clients.** It opens `--clients` sync clients per document over worker threads. All clients of a document share a worker, so remote-visible latency is measured on one clock.
   - Every client sends hello and open, pings every 20 s, and keeps a y-protocols awareness state (15 s heartbeat).
   - `--typists` clients per document type in bursts of 3–12 s at `--cps` characters per second (one update per keystroke), with pauses of 2–8 s. Each typist sends 10 % deletions and a cursor awareness update at most every 500 ms.
4. **Measurement.** After `--warmup` seconds it measures for `--duration` seconds:
   - client-side ack and remote-visible latency;
   - the server's persist and fan-out histograms (difference of two `/metrics` scrapes);
   - rejects, errors and unexpected closes;
   - server RSS, CPU, event-loop lag, rooms and sockets;
   - the generator's own event-loop delay, which shows whether the generator was the bottleneck.
5. **Output.** It prints JSON, also written to `--out` when given.

Against `--url`, the target needs these settings:

- `ALLOW_OPEN_SIGNUP=1`, or accounts `load-<n>@load.libera.test` with the generator's password;
- a high `SYNC_MAX_SOCKETS_PER_ACCOUNT` and `SYNC_CONNECTIONS_PER_MINUTE`;
- registration is limited to 30 per hour per IP, which is enough for 20 accounts.

Never point it at production.

## Results (2026-10-18, Windows 11 laptop, 20 cores, 32 GB; server on PGlite)

There is no Postgres or Docker on this machine. Every run used the spawned server on file-backed PGlite, the development database, with the generator on the same machine.

| Scenario | Updates/s | Ack p50 / p95 / p99 | Remote visible p95 | Persist p50 / p95 / p99 (server) | Fan-out p95 (server) | Server CPU | RSS | Event-loop lag p99 | Problems |
|---|---|---|---|---|---|---|---|---|---|
| 4 docs × 5 clients, 2 typists (smoke) | 26 | 3.8 / 8.7 / 13 ms | 9.1 ms | 1.8 / 3.4 / 4.7 ms | 0.5 ms | 16 % | 403 MiB | 19 ms | none |
| **200 docs × 20 clients, awareness only** (4000 sockets) | 0 (287 awareness/s sent, 5445 relayed/s) | – | – | – | – | 8 % | 415 MiB | 29 ms | none |
| 50 docs × 20 clients, 1 typist at 2 cps | 64 | 9.6 / 96 / 154 ms | 98 ms | 3.2 / 6.1 / 10 ms | 1.0 ms | 53 % | 405 MiB | 125 ms | none |
| 50 docs × 20 clients, 3 typists at 5 cps | ~450 offered | – | – | – | – | saturated | – | > 30 s | `/metrics` timed out; run aborted |
| 200 docs × 20 clients, 3 typists at 5 cps (the target) | ~1800 offered | – | – | – | – | saturated | – | – | not measurable on PGlite |

In the 4000-socket run, all 4000 clients opened within 21 s at 200 connections per second. Open latency was p50 8.6 ms, p95 18 ms and p99 41 ms.

What this shows:

- **Connections, rooms and presence at full scale are fine.** 4000 sockets in 200 rooms, with awareness heartbeats relayed to 19 peers each, cost 8 % of one core and 415 MiB.
- **On PGlite the update path saturates at roughly 100–150 updates/s.** PGlite runs Postgres as WASM on the server's own thread. Each update costs a lookup for idempotency plus a transaction of four statements, about 8 ms of CPU per update including fan-out. Its queries also resolve as microtasks without I/O, so under load they starve the event loop. HTTP requests, pings and reads on other sockets then wait seconds, which is why ack p95 (96 ms) is far above persist p95 (6 ms) at 64 updates/s. Above about 150 updates/s the server stops answering.
- **The persist budget is not threatened at the load PGlite sustains.** Persist p95 stayed at 6 ms, far under 200 ms.
- **The target (about 1800 updates/s across 4000 sockets) has not been measured.** It needs real Postgres. There, each query is network I/O that yields the event loop, and the CPU per update drops to the Yjs probe and apply plus fan-out.

## Still to do

- Run the target scenario against Postgres 16 on the VPS hardware, or on a staging copy: `npm run load -- --database-url postgres://…`. Record the results here. That run decides whether the §10 budgets hold at Q5 scale.
- If the server's single thread turns out to be the limit on Postgres, profile it first with `node --cpu-prof` on `test/load/server.ts`. Likely costs are the probe copy per update and the `findPersisted` lookup.
- Repeat after major changes to the sync pipeline, and before the beta opens to more teams.
