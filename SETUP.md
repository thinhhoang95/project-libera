# Setting up Libera collaboration

This guide covers the collaboration server in `server/` and how the desktop app connects to it. For the architecture, read [docs/collaboration/README.md](docs/collaboration/README.md). For what is built so far, see [docs/collaboration/progress.md](docs/collaboration/progress.md). Sections marked *(lands in Mx.y)* describe parts that are planned but not merged yet.

---

## 1. Overview

| Piece | Where | Default address |
|---|---|---|
| Collab server (REST API and WebSocket sync) | `server/`, Node 22 | `http://127.0.0.1:4400` (REST under `/v1`, sync at `/sync`) |
| Database | Postgres 16 in production; embedded PGlite in development and tests | `server/data/pglite` |
| Blob storage (images, PDFs) | Local disk, or any S3-compatible service | `server/data/blobs` |
| Collab host (on each desktop) | `electron/collab/`, bundled to `electron/collab/dist/host.cjs`, runs in an Electron utilityProcess | Local SQLite in Electron `userData/collab/` |
| Production deployment | `ops/collab/` (Docker Compose, nginx), `scripts/setup-collab-server.cjs` | `https://collab.libera.intuelle.com` |

**You do not need Docker for development.** The server runs on PGlite (Postgres compiled to WebAssembly) with blobs on disk, and writes emails to its log.

---

## 2. Local development

### Prerequisites

- Node.js 22.12 or newer (`node -v`)
- The app's dependencies (`npm run deps:setup`, as described in README.md)
- Optional: Docker Desktop, only for the extra services in §2.5

### 2.1 Start the server

```bash
cd server
npm ci
cp .env.example .env
npm run dev
```

`npm run dev` applies migrations automatically, then listens on `http://127.0.0.1:4400` and restarts when files change. Check it:

```bash
curl http://127.0.0.1:4400/v1/version
```

You can also start it from the repository root with `npm run collab:server`.

### 2.2 Create test accounts

```bash
cd server
npm run seed
```

This creates two development accounts, `alice@example.test` and `bob@example.test`, and a project they share. The password is `SEED_PASSWORD` from `server/.env`, or `libera-dev-password` when it is not set. Keep real credentials out of the repository and out of chat.

`ALLOW_OPEN_SIGNUP=1` in the example `.env` lets anyone register without an invitation. Production sets it to `0`.

### 2.3 Run the desktop app against it *(lands in M1.3–M1.6)*

```bash
npm run collab:build-host
npm run electron:dev
```

1. Open Preferences → Collaboration.
2. Set the server URL to `http://127.0.0.1:4400` and sign in.
3. Share a notebook from its menu ("Share notebook…").

To be a second user on the same computer, start another instance with its own user-data directory:

```bash
npx electron . --user-data-dir="%TEMP%\libera-second-user"
```

Each instance must use its own data directory. Libera holds a single-instance lock per data directory, and the collab host's SQLite log refuses to open twice.

### 2.4 Invitation emails

Without `SMTP_URL`, the server logs every email, including invitation links, at `info` level. Copy the link from the server output.

### 2.5 Optional services (Docker)

```bash
docker compose -f ops/collab/docker-compose.dev.yml up -d
```

This starts:

- **Postgres 16** on `127.0.0.1:55432`. To use it, set `DATABASE_URL=postgres://libera:libera@127.0.0.1:55432/libera` in `server/.env`.
- **Mailpit** (SMTP `127.0.0.1:51025`, web UI `http://127.0.0.1:58025`). To use it, set `SMTP_URL=smtp://127.0.0.1:51025`.
- **Toxiproxy** on `127.0.0.1:54401`, forwarding to the server on 4400. Point the desktop app at `http://127.0.0.1:54401` and add latency or packet loss through its API on `127.0.0.1:58474`, for example:

```bash
curl -X POST http://127.0.0.1:58474/proxies/collab/toxics -d "{\"type\":\"latency\",\"attributes\":{\"latency\":800,\"jitter\":400}}"
```

For the **S3 blob driver**, use any S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2, SeaweedFS, Garage) and set `BLOB_DRIVER=s3` and the `BLOB_S3_*` variables (§3).

---

## 3. Server configuration

All variables are read by `server/src/config.ts`. `server/.env.example` is the development template. `ops/collab/.env.example` is the production template.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` enforces a strong `JWT_SECRET` and complete S3 settings |
| `HOST` / `PORT` | `127.0.0.1` / `4400` | Listen address. `PORT=0` picks a free port (tests). |
| `PUBLIC_URL` | `http://127.0.0.1:4400` | Base URL used in invitation links |
| `DATABASE_URL` | `pglite://./data/pglite` | `postgres://…`, `pglite://<dir>`, or `pglite://memory` |
| `JWT_SECRET` | development value | Signs access tokens. At least 32 random characters in production. |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime (15 min) |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime. Tokens rotate on every use. |
| `INVITATION_TTL_DAYS` | `14` | Invitation link lifetime |
| `ALLOW_OPEN_SIGNUP` | off | `1` allows registering without an invitation |
| `BLOB_DRIVER` | `disk` | `disk` or `s3` |
| `BLOB_DIR` | `./data/blobs` | Disk driver location |
| `BLOB_S3_ENDPOINT`, `BLOB_S3_REGION`, `BLOB_S3_BUCKET`, `BLOB_S3_ACCESS_KEY`, `BLOB_S3_SECRET_KEY` | — | S3 driver settings |
| `MAX_BLOB_BYTES` | `104857600` | Largest uploaded file (100 MB) |
| `SMTP_URL` | unset | `smtp://user:pass@host:587`. When unset, emails go to the log. |
| `MAIL_FROM` | `Libera <no-reply@libera.local>` | Sender address |
| `MIN_PROTOCOL_VERSION` | protocol minimum | Raise it to force older apps to update (§7) |
| `MIN_APP_VERSION` | `0.0.0` | Shown to clients that are too old |
| `METRICS_TOKEN` | unset | Bearer token for `GET /metrics`. When unset, only 127.0.0.1 may read metrics. |
| `SYNC_CONNECTIONS_PER_MINUTE` | `60` | New WebSocket connections per IP per minute |
| `SYNC_MAX_SOCKETS_PER_ACCOUNT` | `8` | Open sockets per account |
| `SNAPSHOT_EVERY_UPDATES` | `2000` | Updates between server snapshots |
| `LOG_RETENTION_DAYS` | `90` | Covered updates older than this may be pruned |
| `ROOM_IDLE_MS` | `60000` | Unload a document from memory after this long without clients |
| `LOG_LEVEL` | `info` | pino log level |
| `ERROR_REPORT_DSN` | unset | Sentry-compatible DSN for error reports (§10.3) |
| `ERROR_REPORT_ENVIRONMENT` | `NODE_ENV` | Environment tag on error reports |
| `TRUST_PROXY` | off | `1` behind nginx, so client IPs come from `X-Forwarded-For` |

---

## 4. Client configuration *(lands in M1.3–M1.6)*

- **Preferences → Collaboration:** server URL, sign-in and sign-out, display name and colour.
- **`LIBERA_COLLAB=1`:** enables collaboration features while they are in beta.
- **Local data:** `userData/collab/<accountId>.sqlite` (update log, outbound queue, offline commands). The refresh token is stored encrypted with Electron `safeStorage`.
- **Shared notebooks** appear under the master directory like other notebooks. Each one carries a `.libera-shared.json` marker. Their files are a working copy written by Libera. Editing them in other programs is supported (Libera merges the edits in), but deleting the marker does not unshare the notebook.

---

## 5. Tests

| Command | What it runs |
|---|---|
| `cd server && npm test` | Server tests on in-memory PGlite: sync, API, kill test |
| `cd server && npx tsc --noEmit -p tsconfig.json` | Server type check |
| `cd server && npm run load -- --help` | Load generator (see docs/collaboration/testing-load.md) |
| `npm run test:collab` | App-side collaboration tests: protocol, host core, bindings, anchors, suggestions |
| `npm run test:editor` | Existing editor tests (must keep passing) |
| `npm run collab:build-host` | Bundles the collab host and confirms it builds |

`LIBERA_COLLAB_FUZZ_RUNS` raises the number of fuzz iterations; the nightly CI run uses 2000. CI is defined in `.github/workflows/collab.yml`.

---

## 6. Production deployment (Libera VPS)

The collab server runs in Docker on the same VPS as the update feed, behind the host's nginx.

### 6.1 One-time server preparation

1. **DNS.** Add an `A` (and `AAAA`) record for `collab.libera.intuelle.com` that points to the VPS.
2. **Docker.** Install Docker Engine and the Compose plugin on the VPS:

```bash
ssh root@185.214.135.181 "curl -fsSL https://get.docker.com | sh"
```

3. **Environment file.** Create `/srv/libera-collab/.env` from `ops/collab/.env.example`, fill in strong random values, and run `chmod 600`. Never commit it.

### 6.2 Deploy

From a machine that holds the server's SSH key, on a clean commit:

```bash
npm run collab:deploy
```

The script (`scripts/setup-collab-server.cjs`) does the following:

1. Packs `server/`, the shared protocol and `ops/collab/` from `HEAD` with `git archive`, so uncommitted changes are never deployed.
2. Builds the image `libera-collab:<commit>` on the VPS.
3. Installs the compose file and the nginx site (WebSocket upgrade on `/sync`).
4. On first run, obtains the Let's Encrypt certificate.
5. Starts the stack and waits for `https://collab.libera.intuelle.com/healthz`.

Migrations run automatically when the container starts.

Overrides:

- `LIBERA_COLLAB_SSH_TARGET`
- `LIBERA_COLLAB_SSH_KEY`
- `LIBERA_COLLAB_REMOTE_ROOT` (default `/srv/libera-collab`)
- `LIBERA_COLLAB_DOMAIN`

Add `-- --dry-run` to print the remote commands without running them.

Each deploy also installs `ops/collab/backup/` to `<remote root>/backup/` and `ops/collab/monitoring/` to `<remote root>/monitoring/`. Local files there (`metrics_token`, `alertmanager.yml`) are kept; `backup.env` lives one level up. See §8 and §10.

### 6.3 Restarts

Clients reconnect on their own, with jittered backoff, and keep editing offline in the meantime. A restart closes sockets with code 4050. Nothing acknowledged is lost, because every update is in Postgres before it is acknowledged.

---

## 7. Upgrades and versioning

- `PROTOCOL_VERSION` and `DOC_SCHEMA_VERSION` live in `src/lib/collab/protocol/version.ts`.
- When a release changes the wire protocol:
  1. Ship the app release first.
  2. Wait for clients to update.
  3. Raise `MIN_PROTOCOL_VERSION` and `MIN_APP_VERSION` in the server `.env`, then redeploy.
- Older apps get close code 4026 and show "Update required to keep syncing". Their local edits stay safe on the device.
- When the document schema changes, older apps open newer documents read-only.

---

## 8. Backups and restore drill

The scripts live in `ops/collab/backup/` and are installed to `/srv/libera-collab/backup/` by every deploy (§6.2). They run as root on the VPS and drive the compose stack through `docker compose`.

> **Untested here.** `backup.sh`, `restore-drill.sh` and the systemd units have not been run against real Postgres, Docker or systemd; this repository's CI has none of them. The verification step (`cli.js verify`) is tested on PGlite. Run the restore drill (§8.4) once by hand before the beta and treat its result as the test. Two assumptions in particular: psql inside a bash coprocess flushes each result line (used to export the dump's snapshot), and `pg_basebackup -X none` leaves its `.backup` history file in the WAL archive.

### 8.1 What is backed up

Everything goes to `/srv/libera-collab/backups/` (`BACKUP_DIR`):

| Path | What | Kept |
|---|---|---|
| `daily/<stamp>/` | `libera.dump` (`pg_dump --format=custom`), `counts.json` (row counts taken in the same snapshot as the dump), `SHA256SUMS` | 14 |
| `weekly/<stamp>/` | Hard links to the Sunday (`WEEKLY_DAY`) daily set | 8 |
| `base/<stamp>/` | `base.tar.gz` (`pg_basebackup`, weekly), `backup-label` (the first WAL file it needs), `started-at` | `BASE_BACKUPS_KEEP` (4) |
| `wal-archive/` | Written continuously by Postgres (`archive_command` in `docker-compose.prod.yml`) | Pruned with `pg_archivecleanup` to what the oldest kept base backup needs |
| `blobs/<set>/` | Level-0 tar of the blob volume on Sundays, then one differential per day (GNU tar `--listed-incremental`) | 8 sets |
| `last-success` | Time of the last complete run | |

Point-in-time recovery uses a base backup plus the WAL archive, so the PITR window is `BASE_BACKUPS_KEEP` weeks. A `pg_dump` cannot have WAL replayed on top of it; it is the simpler, portable copy.

With `BLOB_DRIVER=s3` the blobs are not on the VPS: enable versioning on the bucket instead (the plan's "blob bucket versioning").

### 8.2 Install the nightly backup

1. Deploy once (§6.2) so `/srv/libera-collab/backup/` exists.
2. Optional settings: `cp /srv/libera-collab/backup/backup.env.example /srv/libera-collab/backup.env`, `chmod 600` it and edit. Retention, the weekly day, the off-site target and a healthcheck URL are set there.
3. Install the timer:

```bash
cp /srv/libera-collab/backup/libera-collab-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now libera-collab-backup.timer
systemctl start libera-collab-backup.service     # first run now
journalctl -u libera-collab-backup -n 50         # its output
```

   Without systemd, use the line in `backup/crontab.example` (`crontab -e` as root).
4. Check: `ls /srv/libera-collab/backups/{daily,base,blobs}` and `cat /srv/libera-collab/backups/last-success`. The first run also takes a base backup.

The timer runs at 03:15 UTC (`Persistent=true` catches up after downtime). Set `BACKUP_HEALTHCHECK_URL` (healthchecks.io or similar) so a missed night alerts someone.

### 8.3 Off-site copy

`backup.sh` ends with `rclone copy` of the whole backup directory. Either:

- `OFFSITE_RCLONE_REMOTE=<remote>:<path>` for a remote set up with `rclone config` (wrap it in an rclone `crypt` remote to encrypt), or
- `OFFSITE_S3_ENDPOINT`, `OFFSITE_S3_BUCKET`, `OFFSITE_S3_ACCESS_KEY`, `OFFSITE_S3_SECRET_KEY` (and optionally `_REGION`, `_PREFIX`, `_PROVIDER`) for any S3-compatible service. Credentials are passed through the environment, never on the command line.

If `rclone` is not installed, the script runs the `rclone/rclone` image. It copies and never deletes off-site, so a compromised or wiped VPS cannot remove the off-site copies; expire old objects with a bucket lifecycle rule (for example after 70 days).

### 8.4 Restore drill

Run it before the beta, then quarterly. The `libera-collab-restore-drill.timer` runs it on the first Sunday of each quarter at 05:00 UTC:

```bash
/srv/libera-collab/backup/restore-drill.sh                       # newest daily dump
/srv/libera-collab/backup/restore-drill.sh --dump /srv/libera-collab/backups/weekly/<stamp>
/srv/libera-collab/backup/restore-drill.sh --target-time '2026-10-18 09:30:00+00'   # point in time
/srv/libera-collab/backup/restore-drill.sh --keep               # leave the drill containers running
```

What it does, without touching the live stack:

1. Creates a private Docker network and a throwaway Postgres container. The WAL archive and backups are mounted read-only, and the drill database does not archive.
2. Restores the data in one of two ways:
   - **Default:** checks `SHA256SUMS`, then `pg_restore`s the dump.
   - **With `--target-time`:** unpacks the newest base backup that started before that time, replays the WAL with `recovery_target_time`, and promotes.
3. Restores the newest blob set: level 0 plus the newest differential.
4. Runs `node dist/admin/cli.js verify --blobs --expect counts.json` in a one-off container of the deployed image, before any server touches the data. Without `--target-time` it compares against the dump's counts; a point-in-time restore has no counts file to compare. The checks are listed in §9.4.
5. Starts the collab server against the restored data on `127.0.0.1:4410` (`DRILL_PORT`) and checks `/healthz` and `/v1/version`.
6. Prints a PASS/FAIL report, exits non-zero on failure, and removes the containers, volumes and network (unless `--keep`).

Record each drill (date, dump, duration, result) in the ops log. A failed drill is a release blocker for the beta.

### 8.5 Restoring for real

1. Stop the server so no client writes meanwhile: `docker compose -f docker-compose.prod.yml stop collab`. Clients keep editing offline.
2. Run the drill with `--keep` against the backup you want, and confirm it passes.
3. Replace the live database:
   - **From a dump:** `docker compose exec -T postgres dropdb -U libera libera && docker compose exec -T postgres createdb -U libera libera`, then `docker compose exec -T postgres pg_restore -U libera -d libera --exit-on-error < backups/daily/<stamp>/libera.dump`.
   - **To a point in time:** stop postgres, move its volume aside, and unpack the base backup with `recovery.signal` exactly as `restore_pitr` in `restore-drill.sh` does.
4. Start `collab` again. Clients reconnect and re-send whatever they hold that the server lacks. Edits made after the restore point come back from the clients that still have them.

## 9. Admin recovery tool

```bash
docker compose -f docker-compose.prod.yml exec collab node dist/admin/cli.js <command> [options]   # production
cd server && npm run admin -- <command> [options]                                                # development
```

The CLI opens `DATABASE_URL` itself and applies pending migrations. On PGlite, stop `npm run dev` first: a PGlite directory can only be open in one process. Output is human-readable; add `--json` for scripts. It exits 0 on success, 1 on failure (including problems found by `verify`), and 2 on usage errors. Run it inside the collab container: commands that rewrite storage ask the running server over loopback whether the document is loaded. That route refuses proxied requests and needs `METRICS_TOKEN` when one is set; nginx never routes `/internal/`.

### 9.1 Looking

| Command | What it shows |
|---|---|
| `docs list --project <id> [--include-deleted]` | Documents with kind, manifest path, last seq, log size |
| `doc inspect <docId> [--updates <from>..<to>] [--limit n]` | Kind, path, last seq, snapshots, the retained log by sub-document, by user and actor (`user`, `ai:<feature>`, `system:<reason>`), by UTC day and by provenance; `--updates` prints the entries |
| `doc text <docId> [--at <serverSeq>]` | The text (the manifest as `path kind id` lines), now or at a seq |
| `accounts list` | Accounts with project count and active sessions |
| `audit tail [--project <id>] [--limit n] [--follow]` | The audit log, newest last |

`--at` refuses seqs that retention compacted away unless a revision snapshot sits exactly there.

### 9.2 Exporting

- `doc export <docId> --out <file> [--at <seq>]` writes the text.
- `project export <projectId> --out <dir>` needs an empty or new directory. It writes every manifest entry at its path: documents as text, blobs as their bytes, folders as folders. Under `.libera-export/` it adds `manifest.json`, blobs no entry references (`blobs/<hash>`), and live documents missing from the manifest (`unlisted/`). Unsafe paths and case clashes are skipped and listed.

### 9.3 Repairing

- **`doc snapshot <docId>`** writes a snapshot of every sub-document at the current seq. It is safe at any time.
- **`doc rebuild <docId> --to <serverSeq> [--subdoc <name>] [--dry-run]`** restores the state at that seq as a new forward update. Nothing in the history is rewritten.
  - It runs through a collab server started inside the CLI process, as actor `system:migration`, and adds a `pre-restore` revision first: restoring that revision undoes the rebuild.
  - It prints a line diff of the text and the changed map keys.
  - It refuses while the document's room is loaded on the running server. Ask its collaborators to close it and wait `ROOM_IDLE_MS`, or stop the server and pass `--server-stopped`.
- **`account disable <email>`** blocks sign-in, revokes every refresh token and asks the running server to close the account's sockets. If no server answers, open sockets end when their access token expires. Undo it with **`account enable <email>`**.
- **`account reset-password <email>`** sets a random 20-character temporary password, prints it once and revokes every session. Give it to the user over a trusted channel and ask them to change it after signing in.

**`doc quarantine <docId> --range <from>..<to> (--dry-run | --yes)`: dangerous.** It is the only command that removes updates from history. Use it only when a range makes a document unloadable or corrupt and `doc rebuild` cannot help. Always run `--dry-run` first.

- It moves the range into `quarantined_updates`, together with every later update that can no longer be integrated without it; the dry run lists these as *dependent*. It then deletes the snapshots that include the range and writes a new snapshot from the remaining log. All of this happens in one transaction.
- It refuses while the room is loaded (as for rebuild) and when retention has already compacted part of the range into a snapshot.
- **Collaborators who already hold the quarantined changes keep them**, and a resend or reconcile uploads them again. Every affected collaborator must discard their local copy of the document afterwards.
- Revisions inside or after the range now show history without those updates.

To undo a quarantine run, take its id from the output or from `audit tail` (action `admin.document.quarantine`, `details.quarantineId`). Stop the server or make sure the room is not loaded, then run:

```sql
begin;
insert into doc_updates (doc_id, subdoc, server_seq, account_id, client_id, client_seq, actor, provenance, update, size, received_at)
  select doc_id, subdoc, server_seq, account_id, client_id, client_seq, actor, provenance, update, size, received_at
  from quarantined_updates where quarantine_id = '<qrn_…>';
delete from quarantined_updates where quarantine_id = '<qrn_…>';
-- The snapshot written by the quarantine lacks these updates; drop it so rooms replay the log.
delete from doc_snapshots where doc_id = '<docId>' and upto_server_seq >= <from>;
commit;
```

Then run `doc snapshot <docId>` and `verify --doc <docId>`. To get a shell: `docker compose exec postgres psql -U libera libera`.

### 9.4 Checking

`verify [--doc <id>] [--project <id>] [--include-deleted] [--expect <counts.json>] [--blobs]` is read-only and works on Postgres and PGlite. For every document and sub-document it checks:

- `last_server_seq` covers the log and the snapshots.
- Each update's `size` matches its bytes.
- Every snapshot decodes, holds nothing pending, and has the right stored state vector.
- Replaying the retained log integrates every update and reproduces every later snapshot exactly.
- What a room would load (the latest snapshot plus the tail) equals the replayed state.

On top of that, `--expect` compares table counts with a backup's `counts.json`, and `--blobs` checks that every recorded blob is in the blob store. Run it after any manual repair.

## 10. Monitoring and alerts

### 10.1 Prometheus, Alertmanager and Grafana

`ops/collab/monitoring/` is installed to `/srv/libera-collab/monitoring/` by every deploy (§6.2). The optional compose override adds Prometheus, Alertmanager and Grafana, each bound to `127.0.0.1` only.

1. Set `METRICS_TOKEN` in `/srv/libera-collab/.env` to a random value. Without it, `/metrics` answers 127.0.0.1 only, and Prometheus runs in another container. Then write the same value to the token file:

```bash
printf '%s' '<METRICS_TOKEN value>' > /srv/libera-collab/monitoring/metrics_token
chmod 644 /srv/libera-collab/monitoring/metrics_token    # read by the prometheus container user
```

2. `cp monitoring/alertmanager.example.yml monitoring/alertmanager.yml`, `chmod 600` it, and fill in the SMTP account and on-call address. Alertmanager does not read environment variables.
3. Add `GRAFANA_ADMIN_PASSWORD=<random>` to `.env`.
4. Start the stack:

```bash
cd /srv/libera-collab
docker compose -f docker-compose.prod.yml -f monitoring/docker-compose.monitoring.yml up -d
```

5. Reach the UIs through an SSH tunnel: `ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 root@185.214.135.181`, then open `http://127.0.0.1:3000` and sign in as `admin`. The "Libera collab server" dashboard is provisioned.

The dashboard covers:

- rooms and sockets;
- persist and fan-out latency (p50, p95, p99);
- updates per second by source;
- rejects by reason;
- connections and client reconnects;
- client unacked updates;
- divergence checks;
- compaction lag and job ages;
- log size, snapshots and the ten largest logs;
- quarantined rows;
- HTTP p95 by route and 5xx rates;
- memory, event-loop lag and CPU.

The server has no other monitoring stack. Without the override, `curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:4400/metrics` on the VPS still works.

### 10.2 Alerts

The rules are in `monitoring/alerts.yml`:

| Alert | Fires when |
|---|---|
| LiberaCollabDown / LiberaCollabNotScraped | The scrape fails for 2 min / has no target for 10 min |
| LiberaPersistLatencyHigh | Persist p95 > 200 ms for 10 min (source plan §11) |
| LiberaFanoutLatencyHigh, LiberaEventLoopLagHigh | Fan-out p95 > 50 ms, event-loop lag p99 > 500 ms |
| LiberaRejectRateHigh | More than 2 % of client updates rejected (excluding `not-open`) |
| LiberaUnackedUpdatesStale | Any installation reports an update unacked for more than 5 minutes |
| LiberaDivergenceDetected | Any divergence-check failure reported in the last hour |
| LiberaSyncInternalErrors, LiberaHttpErrors | Sync internal errors > 5 in 10 min; 5xx > 0.1/s |
| LiberaMemoryHigh | RSS > 1.5 GB for 15 min |
| LiberaReconnectStorm | More than 5 new sockets per second for 10 min |
| LiberaCompactionStalled | No compaction success for 30 min, or sub-documents over the snapshot threshold |
| LiberaQuarantinedUpdates (info) | `doc quarantine` ran |

The backup has no Prometheus metric; use `BACKUP_HEALTHCHECK_URL` (§8.2).

### 10.3 Error reports

Set `ERROR_REPORT_DSN` to a Sentry-compatible DSN, preferably a self-hosted GlitchTip. The server then sends reports from the 500 path of the API, the sync frame, update and listener error paths, failed jobs, unhandled rejections and uncaught exceptions. `ERROR_REPORT_ENVIRONMENT` sets the environment tag (default `NODE_ENV`).

Reports never contain document text, comment bodies, emails or tokens. They are built from an allowlist:

- the error type;
- the message, with quoted text, emails, tokens, Postgres key details and long blobs removed, cut to 300 characters;
- stack frames;
- id-shaped tags (`docId`, `route`, `accountId`, …);
- numeric extras (sizes, counts).

At most 30 reports per minute are sent.

### 10.4 Client contract: telemetry and the divergence check

The desktop host reports counts about once a minute with `POST /v1/telemetry` (`TelemetryReport` in `src/lib/collab/protocol/api.ts`, authenticated, at most 6 per minute per account, 429 with `retry-after` beyond that). A report holds:

- `clientId`, `appVersion`, `protocolVersion`;
- `pendingUpdates`, `oldestUnackedSeconds`, `pendingCommands`, `openDocuments`;
- the counters `reconnects`, `rejects` (by reason), `divergenceChecks` and `divergenceFailures`.

The counters are **increments since the previous accepted report**. Reports carry counts and versions only: never content, paths or document ids. The server keeps each installation's latest gauges for 15 minutes and exports aggregates only (no ids in labels). These include `libera_client_stale_unacked_clients` (installations with an update unacked for more than 300 s) and `libera_client_divergence_failures_total`.

For the hourly divergence check, the host calls `GET /v1/documents/:docId/digest` (any member; `DocumentDigest`). The response holds:

- `serverSeq`;
- `stateVectors[subdoc]`: base64 of `Y.encodeStateVector`;
- `contentSha256`: the sha256 hex of the UTF-8 content `source` text, or, for the manifest, of `canonicalJson(files.toJSON())`.

The check is conclusive only when the host's state vector for `content` (or `manifest`) equals the server's. Then the hashes must match, and a mismatch counts as a divergence failure. When the vectors differ, edits are in flight; skip the check and try again later.

## 11. Troubleshooting

| Symptom | Check |
|---|---|
| A tab stays on "Syncing…" | Server reachable? Look at `GET /healthz` and the server log. The host retries with backoff, and edits are safe locally. |
| "Access changed" | Your role was reduced or you were removed. Local work is kept and can be exported. |
| "Update required" | The server's `MIN_PROTOCOL_VERSION` is above this app's protocol version. Update the app. |
| Invitation link missing | Without `SMTP_URL`, the link is in the server log. |
| `JWT_SECRET must be set…` at start | Production refuses the development secret. Set a random value of at least 32 characters. |
| `cli.js doc rebuild` / `doc quarantine` says the document is loaded | Its room is still in memory. Ask collaborators to close it and wait `ROOM_IDLE_MS`, or stop the server and pass `--server-stopped` (§9.3). |
| Restore drill fails at verify | The JSON on stdout names the document, sub-document and check; see §9.4. Do not rely on that backup set. |
| LiberaUnackedUpdatesStale fires | Check rejects by reason, `libera_sync_errors_total` and the error reporter; the affected edits are safe on the device. |
