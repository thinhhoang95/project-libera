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

## 8. Backups and restore drill *(lands in Phase 4)*

Postgres archives its WAL to `/srv/libera-collab/backups/wal-archive`, configured in `docker-compose.prod.yml`. Phase 4 adds nightly base backups, off-site copies, and a scripted restore drill. This section will describe the steps.

## 9. Admin recovery tool *(lands in Phase 4)*

`docker compose exec collab node dist/admin/cli.js …` will let you inspect a document's update log, rebuild it from any `serverSeq`, export documents, quarantine a corrupt update range, and force a snapshot.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| A tab stays on "Syncing…" | Server reachable? Look at `GET /healthz` and the server log. The host retries with backoff, and edits are safe locally. |
| "Access changed" | Your role was reduced or you were removed. Local work is kept and can be exported. |
| "Update required" | The server's `MIN_PROTOCOL_VERSION` is above this app's protocol version. Update the app. |
| Invitation link missing | Without `SMTP_URL`, the link is in the server log. |
| `JWT_SECRET must be set…` at start | Production refuses the development secret. Set a random value of at least 32 characters. |
