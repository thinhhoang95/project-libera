#!/usr/bin/env bash
# Restore drill for the Libera collab stack (SETUP.md §8). Run before the
# beta and quarterly after, as root on the VPS (or any Docker host holding a
# copy of the backups):
#
#   /srv/libera-collab/backup/restore-drill.sh                  # latest nightly dump
#   /srv/libera-collab/backup/restore-drill.sh --dump <dir>     # a given daily/ or weekly/ set
#   /srv/libera-collab/backup/restore-drill.sh --target-time '2026-10-18 09:30:00+00'
#                                     # point in time: base backup + WAL replay
#
# Steps:
#   1. Starts a throwaway Postgres container on a private network.
#   2. Restores the dump with pg_restore, or, with --target-time, unpacks the
#      newest base backup taken before that time and replays the WAL archive
#      up to it (recovery_target_time), then promotes.
#   3. Restores the newest blob set (level 0 plus the newest differential).
#   4. Runs `cli.js verify --blobs` in a one-off collab container against the
#      restored database: every document reconstructs, snapshots match the
#      log, counts match the dump's counts.json, every blob is present.
#   5. Starts the collab server on 127.0.0.1:$DRILL_PORT (default 4410)
#      against it and checks /healthz and /v1/version.
#   6. Prints a pass/fail report and removes everything (unless --keep).
#
# The live stack is never touched: the WAL archive and backups are mounted
# read-only, and the drill database does not archive.
#
# Untested against real Postgres and Docker in this repository's CI.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

DRILL_PORT="${DRILL_PORT:-4410}"
DUMP_SET=""
TARGET_TIME=""
KEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump) DUMP_SET="$2"; shift 2 ;;
    --target-time) TARGET_TIME="$2"; shift 2 ;;
    --port) DRILL_PORT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "Unknown option $1" ;;
  esac
done

ID="libera-drill-$(date -u +%Y%m%d%H%M%S)-$$"
NETWORK="$ID"
PG_CONTAINER="$ID-pg"
CLI_CONTAINER="$ID-cli"
COLLAB_CONTAINER="$ID-collab"
PG_VOLUME="$ID-pgdata"
BLOB_VOLUME="$ID-blobs"
WORK="$(mktemp -d)"
STARTED=$(date +%s)
declare -a REPORT=()
FAILED=0

pass() { REPORT+=("PASS  $*"); log "PASS $*"; }
fail() { REPORT+=("FAIL  $*"); log "FAIL $*"; FAILED=1; }

cleanup() {
  if [[ $KEEP == 1 ]]; then
    log "--keep: left $PG_CONTAINER, $COLLAB_CONTAINER, network $NETWORK and volumes $PG_VOLUME, $BLOB_VOLUME"
  else
    docker rm -f "$COLLAB_CONTAINER" "$CLI_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm -f "$PG_VOLUME" "$BLOB_VOLUME" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# The image currently deployed (scripts/setup-collab-server.cjs writes it).
COLLAB_IMAGE="${COLLAB_IMAGE:-$(sed -n 's/^COLLAB_IMAGE=//p' "$LIBERA_COLLAB_ROOT/deployed-image" 2>/dev/null || true)}"
[[ -n "$COLLAB_IMAGE" ]] || die "Set COLLAB_IMAGE or deploy once so $LIBERA_COLLAB_ROOT/deployed-image exists"
DRILL_PASSWORD="drill-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
DRILL_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')"

# A private bridge network: the drill database is never published; the drill
# server is published on 127.0.0.1:$DRILL_PORT only.
docker network create "$NETWORK" >/dev/null
docker volume create "$PG_VOLUME" >/dev/null
docker volume create "$BLOB_VOLUME" >/dev/null

wait_for_postgres() {
  for _ in $(seq 1 120); do
    if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs --tail 50 "$PG_CONTAINER" >&2 || true
  die "The drill database did not start"
}

# ------------------------------------------------------------------ 2a. logical restore

restore_dump() {
  if [[ -z "$DUMP_SET" ]]; then
    DUMP_SET="$(find "$BACKUP_DIR/daily" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' | sort | tail -n 1)"
  fi
  [[ -n "$DUMP_SET" && -f "$DUMP_SET/libera.dump" ]] || die "No dump found (looked in $BACKUP_DIR/daily)"
  log "restoring dump $DUMP_SET"
  if (cd "$DUMP_SET" && sha256sum --quiet -c SHA256SUMS); then pass "checksums of $(basename "$DUMP_SET")"; else fail "checksums of $DUMP_SET"; fi

  docker run -d --name "$PG_CONTAINER" --network "$NETWORK" \
    -e POSTGRES_USER="$PG_USER" -e POSTGRES_DB="$PG_DB" -e POSTGRES_PASSWORD="$DRILL_PASSWORD" \
    -v "$PG_VOLUME:/var/lib/postgresql/data" "$PG_IMAGE" >/dev/null
  wait_for_postgres
  local begin=$(date +%s)
  if docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" --exit-on-error --no-owner --role="$PG_USER" \
    <"$DUMP_SET/libera.dump"; then
    pass "pg_restore ($(( $(date +%s) - begin )) s, dump $(du -h "$DUMP_SET/libera.dump" | cut -f1))"
  else
    fail "pg_restore"
  fi
  cp "$DUMP_SET/counts.json" "$WORK/counts.json"
}

# ------------------------------------------------------------------ 2b. point-in-time restore

restore_pitr() {
  local target_epoch base="" candidate started
  target_epoch="$(date -u -d "$TARGET_TIME" +%s)" || die "Cannot parse --target-time $TARGET_TIME"
  # The newest base backup that started before the target time.
  while IFS= read -r candidate; do
    started="$(date -u -d "$(cat "$candidate/started-at")" +%s)"
    if (( started <= target_epoch )); then base="$candidate"; fi
  done < <(find "$BACKUP_DIR/base" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' | sort)
  [[ -n "$base" ]] || die "No base backup before $TARGET_TIME"
  log "point-in-time restore from $base to $TARGET_TIME"
  if (cd "$base" && sha256sum --quiet -c SHA256SUMS); then pass "checksums of base $(basename "$base")"; else fail "checksums of base $base"; fi

  # Unpack as the postgres user (uid 999 in the official image) and ask for recovery.
  docker run --rm --network none -v "$PG_VOLUME:/var/lib/postgresql/data" -v "$base:/base:ro" "$PG_IMAGE" bash -euo pipefail -c "
    cd /var/lib/postgresql/data
    tar -xzf /base/base.tar.gz
    touch recovery.signal
    cat >>postgresql.auto.conf <<CONF
restore_command = 'cp /wal-archive/%f %p'
recovery_target_time = '$TARGET_TIME'
recovery_target_action = 'promote'
archive_mode = 'off'
CONF
    chown -R postgres:postgres /var/lib/postgresql/data
    chmod 0700 /var/lib/postgresql/data"

  docker run -d --name "$PG_CONTAINER" --network "$NETWORK" \
    -v "$PG_VOLUME:/var/lib/postgresql/data" -v "$BACKUP_DIR/wal-archive:/wal-archive:ro" \
    "$PG_IMAGE" postgres -c archive_mode=off >/dev/null
  wait_for_postgres
  local promoted=0
  for _ in $(seq 1 600); do
    if [[ "$(docker exec "$PG_CONTAINER" psql -qAt -U "$PG_USER" -d "$PG_DB" -c 'select pg_is_in_recovery()' 2>/dev/null)" == "f" ]]; then
      promoted=1
      break
    fi
    sleep 1
  done
  if [[ $promoted == 1 ]]; then pass "WAL replayed to $TARGET_TIME and promoted"; else fail "recovery did not finish within 10 minutes"; fi
  # The restored cluster keeps the production password; give the drill its own.
  docker exec "$PG_CONTAINER" psql -qAt -U "$PG_USER" -d "$PG_DB" -c "alter user $PG_USER password '$DRILL_PASSWORD'" >/dev/null
}

# ------------------------------------------------------------------ 3. blobs

restore_blobs() {
  local blob_set level0 diff
  if [[ "$(env_value BLOB_DRIVER)" == "s3" ]]; then
    REPORT+=("SKIP  blobs: BLOB_DRIVER=s3 (bucket versioning covers them)")
    return 1
  fi
  blob_set="$(find "$BACKUP_DIR/blobs" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
  if [[ -z "$blob_set" ]]; then
    fail "no blob backup in $BACKUP_DIR/blobs"
    return 1
  fi
  level0="$(basename "$(ls -1 "$blob_set"/blobs-*-level0.tar.gz | tail -n 1)")"
  diff="$(ls -1 "$blob_set"/blobs-*-diff.tar.gz 2>/dev/null | sort | tail -n 1 || true)"
  diff="${diff:+$(basename "$diff")}"
  docker run --rm --network none -v "$BLOB_VOLUME:/data" -v "$blob_set:/backup:ro" "$PG_IMAGE" bash -euo pipefail -c "
    tar --listed-incremental=/dev/null -xzf /backup/$level0 -C /data
    if [[ -n '$diff' ]]; then tar --listed-incremental=/dev/null -xzf /backup/$diff -C /data; fi
    chmod -R a+rwX /data"
  pass "blobs restored from $(basename "$blob_set") ($level0${diff:+ + $diff})"
}

# ------------------------------------------------------------------ main

if [[ -n "$TARGET_TIME" ]]; then restore_pitr; else restore_dump; fi
BLOBS=1
restore_blobs || BLOBS=0

DATABASE_URL="postgres://$PG_USER:$DRILL_PASSWORD@$PG_CONTAINER:5432/$PG_DB"
collab_env=(-e NODE_ENV=production -e JWT_SECRET="$DRILL_SECRET" -e DATABASE_URL="$DATABASE_URL" -e BLOB_DIR=/data/blobs -e LOG_LEVEL=warn)

# 4. Verify the restored database before any server touches it (a running
# server's compaction job would change the counts).
verify_args=(verify --json)
[[ $BLOBS == 1 ]] && verify_args+=(--blobs)
[[ -f "$WORK/counts.json" ]] && verify_args+=(--expect /drill/counts.json)
begin=$(date +%s)
# Top-level numbers of the pretty-printed verify report (no jq or node needed on the host).
json_number() {
  sed -n "s/^  \"$1\": \([0-9]*\),\{0,1\}\$/\1/p" "$WORK/verify.json" | head -n 1
}
if docker run --rm --name "$CLI_CONTAINER" --network "$NETWORK" "${collab_env[@]}" \
  -v "$BLOB_VOLUME:/data/blobs:ro" -v "$WORK:/drill:ro" \
  "$COLLAB_IMAGE" node dist/admin/cli.js "${verify_args[@]}" >"$WORK/verify.json"; then
  blobs_checked="$(json_number blobsChecked)"
  pass "verify ($(( $(date +%s) - begin )) s): $(json_number documents) documents, $(json_number updatesReplayed) updates replayed, $(json_number snapshotsChecked) snapshots, ${blobs_checked:-no} blobs checked"
else
  fail "verify: $(head -c 2000 "$WORK/verify.json")"
fi

# 5. The server starts against the restored data and answers.
docker run -d --name "$COLLAB_CONTAINER" --network "$NETWORK" "${collab_env[@]}" \
  -p "127.0.0.1:$DRILL_PORT:4400" -v "$BLOB_VOLUME:/data/blobs" "$COLLAB_IMAGE" >/dev/null
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS -m 5 "http://127.0.0.1:$DRILL_PORT/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ $healthy == 1 ]]; then
  pass "collab server healthy on the restored data at 127.0.0.1:$DRILL_PORT ($(curl -fsS -m 5 "http://127.0.0.1:$DRILL_PORT/v1/version"))"
else
  docker logs --tail 50 "$COLLAB_CONTAINER" >&2 || true
  fail "collab server did not become healthy"
fi
if [[ $KEEP == 1 ]]; then
  log "--keep: the drill server stays at http://127.0.0.1:$DRILL_PORT; inspect with docker exec $COLLAB_CONTAINER node dist/admin/cli.js ..."
fi

echo
echo "Restore drill $ID  ($(( $(date +%s) - STARTED )) s)"
echo "Source: ${TARGET_TIME:+point in time $TARGET_TIME}${TARGET_TIME:-dump $DUMP_SET}"
printf '  %s\n' "${REPORT[@]}"
if [[ $FAILED == 0 ]]; then
  echo "RESULT: PASS"
else
  echo "RESULT: FAIL"
  exit 1
fi
