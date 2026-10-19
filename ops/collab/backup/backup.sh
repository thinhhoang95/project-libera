#!/usr/bin/env bash
# Nightly backup of the Libera collab stack (SETUP.md §8). Run by
# libera-collab-backup.timer (or cron) as root on the VPS:
#
#   /srv/libera-collab/backup/backup.sh
#
# What it writes under $BACKUP_DIR (default /srv/libera-collab/backups):
#   daily/<stamp>/   libera.dump (pg_dump --format=custom), counts.json (row
#                    counts in the dump's own snapshot), SHA256SUMS
#   weekly/<stamp>/  hard links to the Sunday daily set
#   base/<stamp>/    base.tar.gz (pg_basebackup, for point-in-time recovery
#                    with the WAL archive), backup-label, SHA256SUMS
#   blobs/<set>/     level-0 tar of the blob volume on Sundays, then one
#                    differential tar per day (GNU tar --listed-incremental)
#   wal-archive/     written continuously by Postgres (archive_command);
#                    pruned here to what the oldest kept base backup needs
#
# Rotation: 14 daily and 8 weekly dumps, BASE_BACKUPS_KEEP base backups (and
# the WAL since the oldest of them), 8 blob sets. Optional off-site copy with
# rclone (OFFSITE_RCLONE_REMOTE, or OFFSITE_S3_* for an S3-compatible
# endpoint). Settings: backup.env.example.
#
# Untested against real Postgres and Docker in this repository's CI; the
# restore drill (restore-drill.sh) is the test, run it before relying on this.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

KEEP_DAILY="${KEEP_DAILY:-14}"
KEEP_WEEKLY="${KEEP_WEEKLY:-8}"
KEEP_BLOB_SETS="${KEEP_BLOB_SETS:-8}"
BASE_BACKUPS_KEEP="${BASE_BACKUPS_KEEP:-4}"
# Day of week (1 = Monday ... 7 = Sunday) for the weekly dump, base backup and level-0 blob tar.
WEEKLY_DAY="${WEEKLY_DAY:-7}"
OFFSITE_RCLONE_REMOTE="${OFFSITE_RCLONE_REMOTE:-}"
OFFSITE_S3_BUCKET="${OFFSITE_S3_BUCKET:-}"
BACKUP_HEALTHCHECK_URL="${BACKUP_HEALTHCHECK_URL:-}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WEEKDAY="$(date -u +%u)"
mkdir -p "$BACKUP_DIR"/{daily,weekly,base,blobs,wal-archive}
chmod 0700 "$BACKUP_DIR"

# One backup at a time.
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || die "Another backup is running"

# ------------------------------------------------------------------ 1. logical dump

dump_database() {
  local dir="$BACKUP_DIR/daily/$STAMP" snapshot counts
  mkdir -p "$dir.partial"
  log "pg_dump to $dir"

  # Hold a repeatable-read transaction open, export its snapshot, count rows
  # in it, and dump that same snapshot: counts.json then describes exactly
  # what the dump contains, and the restore drill compares the two.
  coproc PSQL { psql_exec; }
  printf '%s\n' "begin isolation level repeatable read read only;" "select pg_export_snapshot();" >&"${PSQL[1]}"
  IFS= read -r -t 60 snapshot <&"${PSQL[0]}" || die "Could not export a snapshot"
  [[ "$snapshot" =~ ^[0-9A-F-]+$ ]] || die "Unexpected snapshot id: $snapshot"

  local tables=(accounts projects memberships documents doc_updates doc_snapshots revisions blobs threads messages suggestions reviews audit_log)
  if [[ "$(psql_exec -c "select to_regclass('public.quarantined_updates') is not null")" == "t" ]]; then
    tables+=(quarantined_updates)
  fi
  local query="select json_build_object("
  local first=1 table
  for table in "${tables[@]}"; do
    [[ $first == 1 ]] || query+=","
    query+="'$table', (select count(*) from $table)"
    first=0
  done
  query+=");"
  printf '%s\n' "$query" >&"${PSQL[1]}"
  IFS= read -r -t 600 counts <&"${PSQL[0]}" || die "Could not count rows"
  printf '%s\n' "$counts" >"$dir.partial/counts.json"

  compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom --compress=6 \
    --snapshot="$snapshot" >"$dir.partial/libera.dump"

  printf '%s\n' "commit;" >&"${PSQL[1]}"
  exec {PSQL[1]}>&-
  wait "$PSQL_PID" || true

  # The dump must be readable, not just written.
  compose exec -T postgres pg_restore --list <"$dir.partial/libera.dump" >/dev/null || die "pg_restore cannot read the new dump"
  (cd "$dir.partial" && sha256sum libera.dump counts.json >SHA256SUMS)
  mv "$dir.partial" "$dir"
  log "dump: $(du -h "$dir/libera.dump" | cut -f1), counts $(cat "$dir/counts.json")"

  if [[ "$WEEKDAY" == "$WEEKLY_DAY" ]] || [[ -z "$(ls -A "$BACKUP_DIR/weekly")" ]]; then
    cp -al "$dir" "$BACKUP_DIR/weekly/$STAMP"
    log "weekly copy: weekly/$STAMP"
  fi
}

# ------------------------------------------------------------------ 2. base backup + WAL pruning

base_backup() {
  local dir="$BACKUP_DIR/base/$STAMP" marker latest label
  mkdir -p "$dir.partial"
  log "pg_basebackup to $dir"
  marker="$(compose exec -T postgres sh -c 'ls -1 /wal-archive/*.backup 2>/dev/null | sort | tail -n 1' || true)"
  # -X none: the WAL comes from the archive, which is why pruning below keeps
  # everything the oldest base backup needs.
  compose exec -T postgres pg_basebackup -U "$PG_USER" -D - -Ft -X none --checkpoint=fast --label="libera-$STAMP" \
    | gzip -6 >"$dir.partial/base.tar.gz"

  # The backup history file (<wal>.<offset>.backup) names the first WAL
  # segment this base backup needs. Wait for Postgres to archive it.
  for _ in $(seq 1 60); do
    latest="$(compose exec -T postgres sh -c 'ls -1 /wal-archive/*.backup 2>/dev/null | sort | tail -n 1' || true)"
    if [[ -n "$latest" && "$latest" != "$marker" ]]; then break; fi
    psql_exec -c "select pg_switch_wal();" >/dev/null
    sleep 5
  done
  [[ -n "$latest" && "$latest" != "$marker" ]] || die "The base backup's history file was not archived"
  label="$(basename "$latest")"
  printf '%s\n' "$label" >"$dir.partial/backup-label"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$dir.partial/started-at"
  (cd "$dir.partial" && sha256sum base.tar.gz backup-label >SHA256SUMS)
  mv "$dir.partial" "$dir"
  log "base backup: $(du -h "$dir/base.tar.gz" | cut -f1), WAL from $label"
}

prune_base_and_wal() {
  local old oldest
  while IFS= read -r old; do
    [[ -n "$old" ]] || continue
    log "removing base backup $old"
    rm -rf -- "$old"
  done < <(beyond_newest "$BACKUP_DIR/base" "$BASE_BACKUPS_KEEP")
  oldest="$(find "$BACKUP_DIR/base" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' -printf '%f\n' | sort | head -n 1)"
  if [[ -z "$oldest" ]]; then
    log "no base backup yet: WAL archive left as is"
    return
  fi
  # pg_archivecleanup removes every segment older than the one the label names.
  compose exec -T postgres pg_archivecleanup /wal-archive "$(cat "$BACKUP_DIR/base/$oldest/backup-label")"
  log "WAL archive pruned to base backup $oldest ($(du -sh "$BACKUP_DIR/wal-archive" | cut -f1) left)"
}

# ------------------------------------------------------------------ 3. blobs

backup_blobs() {
  local driver volume blob_set level
  driver="$(env_value BLOB_DRIVER)"
  if [[ "$driver" == "s3" ]]; then
    log "BLOB_DRIVER=s3: blobs are not on this host; enable bucket versioning instead (SETUP.md §8)"
    return
  fi
  volume="$(compose_volume blob-data)"
  blob_set="$(find "$BACKUP_DIR/blobs" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tail -n 1)"
  if [[ -z "$blob_set" || "$WEEKDAY" == "$WEEKLY_DAY" ]]; then
    blob_set="$STAMP"
    level=0
    mkdir -p "$BACKUP_DIR/blobs/$blob_set"
  else
    level=1
  fi
  log "blobs: level $level into blobs/$blob_set"
  # Level 0 writes level0.snar; each differential starts from a copy of it,
  # so restoring needs level 0 plus the newest differential only. Blobs are
  # immutable and content-addressed, so a differential only ever adds files.
  docker run --rm --network none \
    -v "$volume:/data:ro" -v "$BACKUP_DIR/blobs/$blob_set:/backup" \
    "$PG_IMAGE" bash -euo pipefail -c "
      if [[ $level == 0 ]]; then
        tar --listed-incremental=/backup/level0.snar -czf /backup/blobs-$STAMP-level0.tar.gz -C /data .
      else
        cp /backup/level0.snar /tmp/diff.snar
        tar --listed-incremental=/tmp/diff.snar -czf /backup/blobs-$STAMP-diff.tar.gz -C /data .
      fi"
  (cd "$BACKUP_DIR/blobs/$blob_set" && sha256sum blobs-*.tar.gz >SHA256SUMS)
  local old
  while IFS= read -r old; do
    [[ -n "$old" ]] && rm -rf -- "$old" && log "removing blob set $old"
  done < <(beyond_newest "$BACKUP_DIR/blobs" "$KEEP_BLOB_SETS")
}

# ------------------------------------------------------------------ 4. rotation

rotate_dumps() {
  local old
  while IFS= read -r old; do
    [[ -n "$old" ]] && rm -rf -- "$old" && log "removing $old"
  done < <(beyond_newest "$BACKUP_DIR/daily" "$KEEP_DAILY"; beyond_newest "$BACKUP_DIR/weekly" "$KEEP_WEEKLY")
  # Leftovers of interrupted runs.
  find "$BACKUP_DIR"/{daily,weekly,base} -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mmin +1440 -exec rm -rf {} +
}

# ------------------------------------------------------------------ 5. off-site

offsite_copy() {
  local remote
  local -a env_args=()
  if [[ -n "$OFFSITE_RCLONE_REMOTE" ]]; then
    remote="$OFFSITE_RCLONE_REMOTE"
  elif [[ -n "$OFFSITE_S3_BUCKET" ]]; then
    # An on-the-fly S3 remote; credentials go through the environment, never argv.
    remote=":s3:${OFFSITE_S3_BUCKET}/${OFFSITE_S3_PREFIX:-libera-collab}"
    env_args=(
      -e RCLONE_S3_PROVIDER="${OFFSITE_S3_PROVIDER:-Other}"
      -e RCLONE_S3_ENDPOINT="${OFFSITE_S3_ENDPOINT:?OFFSITE_S3_ENDPOINT is required with OFFSITE_S3_BUCKET}"
      -e RCLONE_S3_REGION="${OFFSITE_S3_REGION:-us-east-1}"
      -e RCLONE_S3_ACCESS_KEY_ID="${OFFSITE_S3_ACCESS_KEY:?OFFSITE_S3_ACCESS_KEY is required}"
      -e RCLONE_S3_SECRET_ACCESS_KEY="${OFFSITE_S3_SECRET_KEY:?OFFSITE_S3_SECRET_KEY is required}"
    )
  else
    log "no off-site copy configured (OFFSITE_RCLONE_REMOTE or OFFSITE_S3_BUCKET)"
    return
  fi
  log "off-site copy to $remote"
  # copy, not sync: a local deletion (or an attacker on this host) never
  # deletes the off-site copy. Expire old objects with a bucket lifecycle rule.
  local -a flags=(--exclude ".backup.lock" --exclude "*.partial/**" --transfers 4 --checksum)
  if command -v rclone >/dev/null 2>&1 && [[ ${#env_args[@]} -eq 0 ]]; then
    rclone copy "$BACKUP_DIR" "$remote" "${flags[@]}"
  else
    local config="${RCLONE_CONFIG:-$HOME/.config/rclone/rclone.conf}"
    local -a mounts=(-v "$BACKUP_DIR:/backups:ro")
    [[ -f "$config" ]] && mounts+=(-v "$config:/config/rclone/rclone.conf:ro")
    docker run --rm "${mounts[@]}" "${env_args[@]}" "$RCLONE_IMAGE" copy /backups "$remote" "${flags[@]}"
  fi
}

# ------------------------------------------------------------------ main

main() {
  log "backup $STAMP starting (root $LIBERA_COLLAB_ROOT)"
  compose exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null || die "postgres is not ready"
  dump_database
  if [[ "$WEEKDAY" == "$WEEKLY_DAY" ]] || [[ -z "$(find "$BACKUP_DIR/base" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial')" ]]; then
    base_backup
  fi
  prune_base_and_wal
  backup_blobs
  rotate_dumps
  offsite_copy
  date -u +%Y-%m-%dT%H:%M:%SZ >"$BACKUP_DIR/last-success"
  if [[ -n "$BACKUP_HEALTHCHECK_URL" ]]; then
    curl -fsS -m 10 --retry 3 "$BACKUP_HEALTHCHECK_URL" >/dev/null || log "healthcheck ping failed"
  fi
  log "backup $STAMP finished"
}

main "$@"
