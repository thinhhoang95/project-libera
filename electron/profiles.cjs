const fs = require("node:fs");
const path = require("node:path");
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { defaultSearchIndexFile, normalizeSearchPreferences } = require("./search-preferences.cjs");

// People who share one computer each get a profile: their own preferences,
// master directory, password and collaboration sign-in. One profile runs at a
// time; switching restarts the app with the other profile's settings.
//
// A normal start opens the last user who signed in. Choosing another user on
// the sign-in screen sets nextProfileId, which only the following start uses:
// if that person never signs in, the start after it is back to the last user.
//
// The first profile is the original install. Its files stay where they always
// were (userData/<config file>, userData/collab), so a single-user install
// needs no migration and an older app version still opens it. Every other
// profile lives in userData/profiles/<id>/ with the same layout.
const PROFILES_FILE = "profiles.json";
const PROFILES_VERSION = 1;
const DEFAULT_PROFILE_ID = "default";
const PROFILE_ID = /^p-[0-9a-f]{12}$/;
const MAX_PROFILES = 8;
const MAX_NAME_LENGTH = 60;

function isProfileId(id) {
  return id === DEFAULT_PROFILE_ID || (typeof id === "string" && PROFILE_ID.test(id));
}

function profilesPath(userData) {
  return path.join(userData, PROFILES_FILE);
}

/** The folder that plays the role of userData for one profile. */
function profileRoot(userData, id) {
  if (!isProfileId(id)) throw new Error("This user does not exist.");
  return id === DEFAULT_PROFILE_ID ? userData : path.join(userData, "profiles", id);
}

function profileConfigPath(userData, id, configFileName) {
  return path.join(profileRoot(userData, id), configFileName);
}

function normalizeProfileName(value) {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new Error("Enter a name for this user.");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Use a name of at most ${MAX_NAME_LENGTH} characters.`);
  return name;
}

/**
 * The saved profiles. Without a profiles file the install has one user, named
 * after the default profile's "Your name" preference.
 */
function readProfiles(userData, defaultName = "", configFileName = "libera-electron-config.json") {
  const fallbackName = (typeof defaultName === "string" && defaultName.trim()) || "Libera";
  let stored = null;
  try {
    stored = readRegistry(userData);
  } catch (error) {
    if (error.code !== "ENOENT") {
      // Keep the original until recovery is explicitly saved, with a copy for
      // diagnosis even after the recovered list becomes the live registry.
      preserveRegistry(userData);
      stored = { profiles: recoverProfiles(userData, configFileName) };
    }
  }
  const seen = new Set([DEFAULT_PROFILE_ID]);
  const profiles = [];
  const storedProfiles = Array.isArray(stored?.profiles) ? stored.profiles : [];
  const storedDefault = storedProfiles.find((profile) => profile?.id === DEFAULT_PROFILE_ID);
  profiles.push({ id: DEFAULT_PROFILE_ID, name: safeName(storedDefault?.name) || fallbackName });
  for (const profile of storedProfiles) {
    if (!profile || !PROFILE_ID.test(profile.id) || seen.has(profile.id)) continue;
    const name = safeName(profile.name);
    if (!name) continue;
    seen.add(profile.id);
    profiles.push({ id: profile.id, name });
  }
  const known = (id) => profiles.some((profile) => profile.id === id);
  return {
    version: PROFILES_VERSION,
    lastSignedInProfileId: known(stored?.lastSignedInProfileId) ? stored.lastSignedInProfileId : DEFAULT_PROFILE_ID,
    nextProfileId: known(stored?.nextProfileId) ? stored.nextProfileId : null,
    profiles,
  };
}

function readRegistry(userData) {
  const stored = JSON.parse(fs.readFileSync(profilesPath(userData), "utf8"));
  if (!stored || stored.version !== PROFILES_VERSION || !Array.isArray(stored.profiles)) {
    throw new Error("The users registry is invalid.");
  }
  return stored;
}

function preserveRegistry(userData) {
  const target = profilesPath(userData);
  try {
    const backup = `${target}.corrupt-${fs.statSync(target).mtimeMs}`;
    try { fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== "EEXIST" || !fs.readFileSync(target).equals(fs.readFileSync(backup))) throw error;
    }
    return backup;
  } catch {
    // An unreadable original must stay in place; writeProfiles refuses to
    // replace it unless a backup can actually be made.
    return null;
  }
}

function recoverProfiles(userData, configFileName) {
  let folders;
  try {
    folders = fs.readdirSync(path.join(userData, "profiles"), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Could not recover the users registry: ${error.message}`);
  }
  return folders.filter((entry) => entry.isDirectory() && PROFILE_ID.test(entry.name)).map((entry) => {
    let name = "";
    try {
      name = safeName(JSON.parse(fs.readFileSync(profileConfigPath(userData, entry.name, configFileName), "utf8")).yourName);
    } catch { /* A broken config still belongs in the recovered user list. */ }
    return { id: entry.name, name: name || `User ${entry.name.slice(2)}` };
  });
}

function safeName(value) {
  try {
    return normalizeProfileName(value);
  } catch {
    return "";
  }
}

function writeProfiles(userData, state) {
  fs.mkdirSync(userData, { recursive: true });
  try {
    readRegistry(userData);
  } catch (error) {
    if (error.code !== "ENOENT") {
      const recovered = recoverProfiles(userData, "libera-electron-config.json");
      if (!recovered.length || recovered.some((profile) => !state.profiles.some((item) => item.id === profile.id)) || !preserveRegistry(userData)) {
        throw new Error("The damaged users registry was kept unchanged. Restore profiles.json from a backup before changing users.");
      }
    }
  }
  const target = profilesPath(userData);
  const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  const body = {
    version: PROFILES_VERSION,
    lastSignedInProfileId: state.lastSignedInProfileId,
    ...(state.nextProfileId ? { nextProfileId: state.nextProfileId } : {}),
    profiles: state.profiles.map(({ id, name }) => ({ id, name })),
  };
  fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
}

/**
 * The profile this start opens, and the state to save: a one-time choice is
 * used up by the start it was made for.
 */
function resolveStartupProfile(state, isComplete = () => true) {
  let profileId = state.nextProfileId ?? state.lastSignedInProfileId;
  let failedProfile = null;
  if (profileId !== DEFAULT_PROFILE_ID && !isComplete(profileId)) {
    failedProfile = state.profiles.find((profile) => profile.id === profileId);
    const candidates = [state.lastSignedInProfileId, ...state.profiles.map((profile) => profile.id).reverse()];
    profileId = candidates.find((id) => id !== failedProfile.id && isComplete(id)) ?? DEFAULT_PROFILE_ID;
  }
  return {
    profileId, failedProfile,
    state: { ...state, nextProfileId: null, lastSignedInProfileId: failedProfile ? profileId : state.lastSignedInProfileId },
    changed: Boolean(state.nextProfileId || failedProfile),
  };
}

function isProfileConfigComplete(config) {
  return Boolean(config && [config.dataDir, config.openaiApiKey, config.passwordHash].every((value) => typeof value === "string" && value.trim()));
}

function profileSessionPartition(id) {
  if (!isProfileId(id)) throw new Error("This user does not exist.");
  return id === DEFAULT_PROFILE_ID ? null : `persist:profile-${id}`;
}

function assertUniqueName(state, name, exceptId) {
  const key = name.toLocaleLowerCase();
  if (state.profiles.some((profile) => profile.id !== exceptId && profile.name.toLocaleLowerCase() === key)) {
    throw new Error(`There is already a user named ${name}.`);
  }
}

function findProfile(state, id) {
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile) throw new Error("This user does not exist.");
  return profile;
}

/** Adds a profile to the state; the caller writes its config file and the state. */
function addProfile(state, name) {
  const normalized = validateNewProfile(state, name);
  let id;
  do id = `p-${randomBytes(6).toString("hex")}`;
  while (state.profiles.some((profile) => profile.id === id));
  const profile = { id, name: normalized };
  return { state: { ...state, profiles: [...state.profiles, profile] }, profile };
}

function validateNewProfile(state, name) {
  if (state.profiles.length >= MAX_PROFILES) throw new Error(`Libera supports up to ${MAX_PROFILES} users on one computer.`);
  const normalized = normalizeProfileName(name);
  assertUniqueName(state, normalized);
  return normalized;
}

function renameProfile(state, id, name) {
  findProfile(state, id);
  const normalized = normalizeProfileName(name);
  assertUniqueName(state, normalized, id);
  return { ...state, profiles: state.profiles.map((profile) => profile.id === id ? { ...profile, name: normalized } : profile) };
}

/** runningId is the user this app instance serves; they cannot remove themself. */
function removeProfile(state, id, runningId) {
  findProfile(state, id);
  if (id === DEFAULT_PROFILE_ID) throw new Error("The first user cannot be removed.");
  if (id === runningId) throw new Error("Switch to another user before removing this one.");
  return {
    ...state,
    lastSignedInProfileId: state.lastSignedInProfileId === id ? DEFAULT_PROFILE_ID : state.lastSignedInProfileId,
    nextProfileId: state.nextProfileId === id ? null : state.nextProfileId,
    profiles: state.profiles.filter((profile) => profile.id !== id),
  };
}

/** The user chosen on the sign-in screen opens at the next start only. */
function chooseNextProfile(state, id) {
  findProfile(state, id);
  return { ...state, nextProfileId: id };
}

/** After a successful sign-in, normal starts open this user. */
function recordSignIn(state, id) {
  findProfile(state, id);
  return { ...state, lastSignedInProfileId: id, nextProfileId: state.nextProfileId === id ? null : state.nextProfileId };
}

/**
 * A removed profile's settings folder is moved aside, not deleted: it holds
 * the collaboration database, which may have changes not yet uploaded.
 */
function moveProfileAside(userData, id, now = Date.now()) {
  if (id === DEFAULT_PROFILE_ID) throw new Error("The first user cannot be removed.");
  const source = profileRoot(userData, id);
  if (!fs.existsSync(source)) return null;
  const target = path.join(userData, "profiles", ".removed", `${id}-${now}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  return target;
}

function directoryKey(directoryPath) {
  let ancestor = path.resolve(stripWindowsPrefix(directoryPath));
  const remaining = [];
  for (;;) {
    try {
      ancestor = fs.realpathSync.native(ancestor);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      remaining.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  const resolved = path.resolve(stripWindowsPrefix(ancestor), ...remaining);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function stripWindowsPrefix(value) {
  return value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

function pathsOverlap(left, right) {
  const a = directoryKey(left);
  const b = directoryKey(right);
  const inside = (parent, child) => child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
  return a === b || inside(a, b) || inside(b, a);
}

/**
 * The other profile, if any, whose master directory is the same folder as
 * dataDir or contains it, or sits inside it. Two people's libraries must not
 * overlap: each profile's app state lives in its master directory.
 */
function findDataDirConflict(entries, id, dataDir) {
  if (typeof dataDir !== "string" || !dataDir.trim()) return null;
  for (const entry of entries) {
    if (entry.id === id || typeof entry.dataDir !== "string" || !entry.dataDir.trim()) continue;
    if (pathsOverlap(dataDir, entry.dataDir)) return entry;
  }
  return null;
}

function effectiveIndexFile(config, configPath) {
  const custom = normalizeSearchPreferences(config.search).indexFile;
  if (custom) return custom;
  if (typeof config.dataDir !== "string" || !config.dataDir.trim()) return "";
  return defaultSearchIndexFile({
    adminRoot: path.join(config.dataDir, "users", "admin"), configPath,
  });
}

function findStorageConflict(entries, id, candidate) {
  for (const entry of entries) {
    if (entry.id === id) continue;
    for (const left of [candidate.dataDir, candidate.indexFile]) {
      for (const right of [entry.dataDir, entry.indexFile]) {
        if (left && right && pathsOverlap(left, right)) return entry;
      }
    }
  }
  return null;
}

function assertOutsideUserData(dataDir, userData) {
  if (pathsOverlap(dataDir, userData)) {
    throw new Error("Choose a master directory separate from Libera's application storage folder (userData). It cannot contain or be inside that folder.");
  }
}

/** Matches the admin session token issued by src/lib/auth.ts. */
function verifyProfileSession(token, secret, now = Date.now()) {
  if (typeof token !== "string" || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expected = createHmac("sha256", secret).update(parts[0]).digest("base64url");
  const signature = Buffer.from(parts[1]);
  if (signature.length !== expected.length || !timingSafeEqual(signature, Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload.sub === "admin" && typeof payload.exp === "number" && payload.exp > now;
  } catch {
    return false;
  }
}

function createProfileQueue() {
  let pending = Promise.resolve();
  return (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
}

module.exports = {
  DEFAULT_PROFILE_ID,
  MAX_PROFILES,
  addProfile,
  assertOutsideUserData,
  chooseNextProfile,
  createProfileQueue,
  directoryKey,
  effectiveIndexFile,
  findDataDirConflict,
  findStorageConflict,
  isProfileId,
  isProfileConfigComplete,
  moveProfileAside,
  normalizeProfileName,
  profileConfigPath,
  profileRoot,
  profileSessionPartition,
  pathsOverlap,
  readProfiles,
  recordSignIn,
  removeProfile,
  renameProfile,
  resolveStartupProfile,
  stripWindowsPrefix,
  validateNewProfile,
  verifyProfileSession,
  writeProfiles,
};
