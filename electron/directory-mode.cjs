const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Directory mode keeps one external folder open instead of the notebook library.
// The Next server and the Electron main process share this state file: the
// server mounts and closes folders, the main process reads it for menus, file
// reveals and shutdown checkpoints.
const MAX_RECENT_DIRECTORIES = 10;
const DIRECTORY_MODE_STATE_PATH = [".libera", "directory-mode.json"];
const DIRECTORY_STATE_ROOT = [".libera", "directories"];

function normalizeDirectoryPath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return "";
  const resolved = path.resolve(value.trim());
  // Keep filesystem roots intact; strip trailing separators everywhere else.
  return resolved.length > path.parse(resolved).root.length
    ? resolved.replace(/[\\/]+$/, "")
    : resolved;
}

function directoryModeStatePath(adminRoot) {
  return path.join(adminRoot, ...DIRECTORY_MODE_STATE_PATH);
}

function normalizeDirectoryModeState(value) {
  const current = normalizeDirectoryPath(value?.current);
  const recent = [];

  for (const item of Array.isArray(value?.recent) ? value.recent : []) {
    const normalized = normalizeDirectoryPath(item);
    if (normalized && !recent.includes(normalized)) recent.push(normalized);
    if (recent.length >= MAX_RECENT_DIRECTORIES) break;
  }

  return { version: 1, current: current || null, recent };
}

function readDirectoryModeState(adminRoot) {
  try {
    return normalizeDirectoryModeState(
      JSON.parse(fs.readFileSync(directoryModeStatePath(adminRoot), "utf8")),
    );
  } catch {
    return normalizeDirectoryModeState(null);
  }
}

function writeDirectoryModeState(adminRoot, state) {
  const normalized = normalizeDirectoryModeState(state);
  const target = directoryModeStatePath(adminRoot);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return normalized;
}

function withRecentDirectory(recent, directoryPath) {
  return [directoryPath, ...recent.filter((item) => item !== directoryPath)].slice(0, MAX_RECENT_DIRECTORIES);
}

/** App-owned state for a directory (sessions, annotations, caches) lives in the data folder, not in the user's directory. */
function directoryStateRoot(adminRoot, directoryPath) {
  const key = createHash("sha256").update(normalizeDirectoryPath(directoryPath)).digest("hex").slice(0, 24);
  return path.join(adminRoot, ...DIRECTORY_STATE_ROOT, key);
}

/**
 * Map a client-reported context root (the tree root) to where its workspace
 * state is stored. Unknown directories are rejected so a stale page cannot
 * write sessions for folders that were never opened.
 */
function contextStateRoot(adminRoot, contextRoot) {
  const normalizedAdminRoot = normalizeDirectoryPath(adminRoot);
  const normalized = normalizeDirectoryPath(contextRoot);

  if (!normalized || normalized === normalizedAdminRoot) return adminRoot;

  const state = readDirectoryModeState(adminRoot);
  if (normalized !== state.current && !state.recent.includes(normalized)) return null;
  return directoryStateRoot(adminRoot, normalized);
}

module.exports = {
  MAX_RECENT_DIRECTORIES,
  contextStateRoot,
  directoryModeStatePath,
  directoryStateRoot,
  normalizeDirectoryModeState,
  normalizeDirectoryPath,
  readDirectoryModeState,
  withRecentDirectory,
  writeDirectoryModeState,
};
