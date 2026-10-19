const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const os = require("node:os");

// Linked folders sit next to the notebooks in the library. Each one is
// addressed by a unique top-level name, exactly like a notebook, so files read
// as `name/notes.md`. The Next server and the Electron main process share this
// state file: the server links and removes folders, the main process reads it
// for menus and file reveals.
const MAX_RECENT_DIRECTORIES = 10;
const DIRECTORY_MODE_STATE_VERSION = 2;
const DIRECTORY_MODE_STATE_PATH = [".libera", "directory-mode.json"];
const DIRECTORY_STATE_ROOT = [".libera", "directories"];
const FOLDER_ID_FILE = ".libera-folder.json";
const VALID_FOLDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function directoryMachineKey() {
  return process.env.LIBERA_MACHINE_ID || createHash("sha256")
    .update(JSON.stringify([os.hostname(), os.homedir(), process.platform])).digest("hex").slice(0, 24);
}

function readFolderId(directoryPath) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directoryPath, FOLDER_ID_FILE), "utf8"));
    return value.version === 1 && VALID_FOLDER_ID.test(value.id) ? value.id : null;
  } catch { return null; }
}

function legacyDirectoryStateRoot(adminRoot, directoryPath) {
  const key = createHash("sha256").update(normalizeDirectoryPath(directoryPath)).digest("hex").slice(0, 24);
  return path.join(adminRoot, ...DIRECTORY_STATE_ROOT, key);
}

/** Only this tiny identity marker lives in the user's folder; app state stays in the library. */
function ensureDirectoryIdentity(adminRoot, directoryPath, previousId) {
  if (!fs.statSync(directoryPath, { throwIfNoEntry: false })?.isDirectory()) return previousId || null;
  let id = readFolderId(directoryPath);
  if (!id) {
    id = VALID_FOLDER_ID.test(previousId) ? previousId : randomUUID();
    try {
      const temporary = path.join(directoryPath, `${FOLDER_ID_FILE}.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, id })}\n`, { flag: "wx" });
        try { fs.linkSync(temporary, path.join(directoryPath, FOLDER_ID_FILE)); } catch (error) {
          if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"].includes(error.code)) throw error;
          fs.copyFileSync(temporary, path.join(directoryPath, FOLDER_ID_FILE), fs.constants.COPYFILE_EXCL);
        }
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    } catch {
      // Read-only folders remain usable with their existing local state.
      id = readFolderId(directoryPath) || (VALID_FOLDER_ID.test(previousId) ? previousId : null);
    }
  }
  if (id) {
    const legacy = legacyDirectoryStateRoot(adminRoot, directoryPath);
    const target = path.join(adminRoot, ...DIRECTORY_STATE_ROOT, id);
    if (fs.existsSync(legacy)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.renameSync(legacy, target);
      else {
        fs.cpSync(legacy, target, { recursive: true, force: false });
        fs.renameSync(legacy, `${legacy}.migrated-${randomUUID()}`);
      }
      // When merging, retain a recovery copy that will not be imported again.
    }
  }
  return id;
}

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
    const locations = Object.fromEntries(Object.entries(item?.locations && typeof item.locations === "object" ? item.locations : {})
      .filter(([key, value]) => key && typeof value === "string" && value && !value.includes("\0")));
    const folderPath = normalizeDirectoryPath(locations[directoryMachineKey()] || item?.path);
    if (!folderPath || !isValidFolderName(item?.name)) continue;
    if (folders.some((folder) => folder.path === folderPath || folder.name.toLowerCase() === item.name.toLowerCase())) continue;
    folders.push({ name: item.name, path: folderPath,
      ...(VALID_FOLDER_ID.test(item.id) ? { id: item.id } : {}),
      ...(Object.keys(locations).length ? { locations } : {}),
      ...(Object.keys(locations).length && !locations[directoryMachineKey()] ? { unresolved: true } : {}),
    });
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

  if (value?.version === DIRECTORY_MODE_STATE_VERSION) {
    const state = normalizeDirectoryModeState(value);
    let changed = false;
    const folders = state.folders.map((folder) => {
      try {
        if (!fs.statSync(folder.path, { throwIfNoEntry: false })?.isDirectory()) return folder;
        // A path from another computer may name an unrelated local directory.
        // Auto-connect only if its synced marker proves the folder's identity.
        if (folder.unresolved && (!folder.id || readFolderId(folder.path) !== folder.id)) return folder;
        const id = ensureDirectoryIdentity(adminRoot, folder.path, folder.id);
        const locations = { ...folder.locations, [directoryMachineKey()]: folder.path };
        const upgraded = { ...folder, ...(id ? { id } : {}), locations };
        delete upgraded.unresolved;
        if (JSON.stringify(upgraded) !== JSON.stringify(folder)) changed = true;
        return upgraded;
      } catch { return folder; }
    });
    if (changed) {
      try { return writeDirectoryModeState(adminRoot, { ...state, folders }); } catch { return { ...state, folders }; }
    }
    return state;
  }

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
function directoryStateRoot(adminRoot, directoryPath, folderId) {
  const id = VALID_FOLDER_ID.test(folderId) ? folderId : readFolderId(directoryPath);
  const legacy = legacyDirectoryStateRoot(adminRoot, directoryPath);
  const target = id ? path.join(adminRoot, ...DIRECTORY_STATE_ROOT, id) : legacy;
  // If migration could not write the Master directory, old state stays readable.
  return !fs.existsSync(target) && fs.existsSync(legacy) ? legacy : target;
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
  directoryMachineKey,
  ensureDirectoryIdentity,
  legacyDirectoryStateRoot,
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
