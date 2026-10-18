# Shared settings and helpers for backup.sh and restore-drill.sh. Sourced,
# not executed. Every setting can be overridden in the environment or in
# $LIBERA_COLLAB_ROOT/backup.env (see backup.env.example).

# Where deploy installs the stack (docker-compose.prod.yml, .env, deployed-image).
LIBERA_COLLAB_ROOT="${LIBERA_COLLAB_ROOT:-/srv/libera-collab}"

if [[ -f "$LIBERA_COLLAB_ROOT/backup.env" ]]; then
  # shellcheck disable=SC1091
  source "$LIBERA_COLLAB_ROOT/backup.env"
fi

# Backups live next to the WAL archive the postgres service writes
# (docker-compose.prod.yml mounts $BACKUP_DIR/wal-archive at /wal-archive).
BACKUP_DIR="${BACKUP_DIR:-$LIBERA_COLLAB_ROOT/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-$LIBERA_COLLAB_ROOT/docker-compose.prod.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-libera-collab}"
PG_USER="${PG_USER:-libera}"
PG_DB="${PG_DB:-libera}"
# The image used for helper containers (tar, pg tools); already pulled for the stack.
PG_IMAGE="${PG_IMAGE:-postgres:16-bookworm}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.68.2}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --project-directory "$LIBERA_COLLAB_ROOT" "$@"
}

# psql inside the running postgres service, unaligned and quiet.
psql_exec() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -qAt -U "$PG_USER" -d "$PG_DB" "$@"
}

# The Docker volume name of a compose volume (e.g. blob-data).
compose_volume() {
  local name="$1" volume
  volume="$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.volume=$name")"
  [[ -n "$volume" ]] || die "No Docker volume for $name in project $COMPOSE_PROJECT"
  printf '%s\n' "$volume"
}

# Newest entries first; prints the paths beyond the first $2 entries of directory $1.
beyond_newest() {
  local dir="$1" keep="$2"
  [[ -d "$dir" ]] || return 0
  find "$dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r | tail -n +"$((keep + 1))" | sed "s|^|$dir/|"
}

# Reads KEY=value from the stack's .env without sourcing it (values may contain spaces or $).
env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$LIBERA_COLLAB_ROOT/.env" | tail -n 1
}
