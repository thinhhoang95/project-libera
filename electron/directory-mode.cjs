const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// Linked folders sit next to the notebooks in the library. Each one is
// addressed by a unique top-level name, exactly like a notebook, so files read
// as `name/notes.md`. The Next server and the Electron main process share this
// state file: the server links and removes folders, the main process reads it
// for menus and file reveals.
const MAX_RECENT_DIRECTORIES = 10;
const DIRECTORY_MODE_STATE_VERSION = 2;
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

/** A folder's name in Libera paths: its basename, made safe as a single segment. */
function baseFolderName(directoryPath) {
  const name = path.basename(directoryPath).trim().replace(/^\.+/, "").replace(/[\\/\0]/g, "-").trim();
  return name || "Folder";
}

function isValidFolderName(value) {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim() &&
    !value.startsWith(".") && !/[\\/\0]/.test(value);
}

/** Names already used by notebooks in the library. Hidden folders are not notebooks. */
function libraryNotebookNames(adminRoot) {
  try {
    return fs.readdirSync(adminRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Pick a name that no notebook or other linked folder uses. Names compare
 * case-insensitively because macOS and Windows file systems do.
 */
function uniqueFolderName(preferredName, takenNames) {
  const taken = new Set([...takenNames].map((name) => name.toLowerCase()));
  let candidate = preferredName;
  for (let index = 2; taken.has(candidate.toLowerCase()); index += 1) {
    candidate = `${preferredName} (${index})`;
  }
  return candidate;
}

function normalizeDirectoryModeState(value) {
  const folders = [];
  const recent = [];

  for (const item of Array.isArray(value?.folders) ? value.folders : []) {
    const folderPath = normalizeDirectoryPath(item?.path);
    if (!folderPath || !isValidFolderName(item?.name)) continue;
    if (folders.some((folder) => folder.path === folderPath || folder.name.toLowerCase() === item.name.toLowerCase())) continue;
    folders.push({ name: item.name, path: folderPath });
  }

  for (const item of Array.isArray(value?.recent) ? value.recent : []) {
    const normalized = normalizeDirectoryPath(item);
    if (normalized && !recent.includes(normalized)) recent.push(normalized);
    if (recent.length >= MAX_RECENT_DIRECTORIES) break;
  }

  return { version: DIRECTORY_MODE_STATE_VERSION, folders, recent };
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

/**
 * Version 1 kept one open folder that replaced the library. Its folder joins
 * the library under its basename unless a notebook already has that name.
 */
function migrateDirectoryModeState(adminRoot, value) {
  const current = normalizeDirectoryPath(value?.current);
  const folders = [];

  if (current) {
    folders.push({
      name: uniqueFolderName(baseFolderName(current), libraryNotebookNames(adminRoot)),
      path: current,
    });
  }

  return { version: DIRECTORY_MODE_STATE_VERSION, folders, recent: Array.isArray(value?.recent) ? value.recent : [] };
}

function readDirectoryModeState(adminRoot) {
  let value;

  try {
    value = JSON.parse(fs.readFileSync(directoryModeStatePath(adminRoot), "utf8"));
  } catch {
    return normalizeDirectoryModeState(null);
  }

  if (value?.version === DIRECTORY_MODE_STATE_VERSION) return normalizeDirectoryModeState(value);

  const migrated = migrateDirectoryModeState(adminRoot, value);
  try {
    return writeDirectoryModeState(adminRoot, migrated);
  } catch {
    // A read-only data folder still shows the migrated folders.
    return normalizeDirectoryModeState(migrated);
  }
}

function withRecentDirectory(recent, directoryPath) {
  return [directoryPath, ...recent.filter((item) => item !== directoryPath)].slice(0, MAX_RECENT_DIRECTORIES);
}

/** App-owned state for a folder (annotations, caches, metadata) lives in the data folder, not in the user's folder. */
function directoryStateRoot(adminRoot, directoryPath) {
  const key = createHash("sha256").update(normalizeDirectoryPath(directoryPath)).digest("hex").slice(0, 24);
  return path.join(adminRoot, ...DIRECTORY_STATE_ROOT, key);
}

/** The linked folder addressed by a top-level Libera path segment, if any. */
function findLinkedFolder(state, name) {
  return state.folders.find((folder) => folder.name === name) ?? null;
}

/**
 * Map a client-reported context root (the tree root) to where its workspace
 * state is stored. Notebooks and linked folders share the library's session,
 * so only the library root is accepted.
 */
function contextStateRoot(adminRoot, contextRoot) {
  const normalized = normalizeDirectoryPath(contextRoot);
  if (!normalized || normalized === normalizeDirectoryPath(adminRoot)) return adminRoot;
  return null;
}

module.exports = {
  MAX_RECENT_DIRECTORIES,
  baseFolderName,
  contextStateRoot,
  directoryModeStatePath,
  directoryStateRoot,
  findLinkedFolder,
  libraryNotebookNames,
  normalizeDirectoryModeState,
  normalizeDirectoryPath,
  readDirectoryModeState,
  uniqueFolderName,
  withRecentDirectory,
  writeDirectoryModeState,
};
