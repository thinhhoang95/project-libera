const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const profileLogic = require("../../electron/profiles.cjs");
const {
  DEFAULT_PROFILE_ID,
  MAX_PROFILES,
  addProfile,
  chooseNextProfile,
  findDataDirConflict,
  moveProfileAside,
  profileConfigPath,
  readProfiles,
  recordSignIn,
  removeProfile,
  renameProfile,
  resolveStartupProfile,
  writeProfiles,
} = require("../../electron/profiles.cjs");

function sessionToken(secret, payload = { sub: "admin", exp: Date.now() + 60_000 }) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${crypto.createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

const mainSource = fs.readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

// Run the actual main-process functions and IPC handlers against temporary data.
function mainHarness() {
  const userData = temporaryUserData();
  const contents = new EventEmitter();
  let token = sessionToken("running-secret");
  contents.session = { cookies: {
    get: async (filter) => {
      assert.equal(filter.url, "http://localhost:3456");
      assert.equal(filter.name, "libera_session");
      return token ? [{ value: token }] : [];
    },
    remove: async () => { token = ""; },
  } };
  contents.send = () => {};
  const window = new EventEmitter();
  window.webContents = contents;
  window.isDestroyed = () => window.destroyed;
  window.close = () => {};
  const app = new EventEmitter();
  const effects = [];
  app.getPath = () => userData;
  app.relaunch = () => effects.push("relaunch");
  app.quit = () => effects.push("quit");
  const handlers = new Map();
  const setupContents = {};
  const scope = vm.createContext({
    ...profileLogic, ...crypto, fs, fsp: { ...fs.promises }, path, Buffer, console,
    app, mainWindow: window, nextServerUrl: "http://localhost:3456", runningSessionSecret: "running-secret",
    session: { defaultSession: contents.session, fromPartition: () => contents.session },
    runningProfileId: "default", profileSignedIn: false, profileAuthVersion: 0, pendingProfileSwitch: null,
    queueProfileMutation: profileLogic.createProfileQueue(), isQuitting: false,
    CONFIG_FILE_NAME: "config.json", APP_DISPLAY_NAME: "Libera", normalizeYourName: (value) => value || "",
    clearLoginCookie: async (session, url) => session.cookies.remove(url, "libera_session"),
    showMessageBox: async () => ({ response: 0 }),
    mode: "configuration", setupHost: { webContents: setupContents, close() {} }, setupWindow: window,
    savedConfig: null, nativeTheme: {},
    validateSetupInput: (input, existing) => ({ ...existing, ...input }),
    resolveEditorThemes: require("../../electron/editor-themes.cjs").resolveEditorThemes,
    normalizedImportedPreferences: (input) => input, parsePreferencesBackup: (input) => input,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    isSameOrigin: (a, b) => new URL(a).origin === new URL(b).origin,
  });
  vm.runInContext(mainSource.slice(mainSource.indexOf("function readProfileConfig("), mainSource.indexOf("function assertSafePathSegment(")), scope);
  vm.runInContext(mainSource.slice(mainSource.indexOf("function createPasswordHash("), mainSource.indexOf("function readConfig(")), scope);
  vm.runInContext(mainSource.slice(mainSource.indexOf("async function writeConfig("), mainSource.indexOf("function normalizedImportedPreferences(")), scope);
  vm.runInContext(mainSource.slice(mainSource.indexOf("async function importPreferences("), mainSource.indexOf("function getConfigStatus(")), scope);
  vm.runInContext("function readConfig() { return readProfileConfig(getRunningProfileId()); }", scope);
  vm.runInContext(mainSource.slice(mainSource.indexOf("    // Users: only Preferences"), mainSource.indexOf('    ipcMain.handle("setup:load-ai-chat-custom-instruction-file"')), scope);
  vm.runInContext(mainSource.slice(mainSource.indexOf("  function assertProfilesSender("), mainSource.indexOf('  ipcMain.handle("window:minimize"')), scope);
  vm.runInContext(mainSource.slice(mainSource.indexOf('    ipcMain.handle("setup:save"'), mainSource.indexOf('    setupHost.on("closed"')), scope);
  const config = { dataDir: path.join(userData, "..", `${path.basename(userData)}-notes`), yourName: "Vy", openaiApiKey: "key", passwordHash: scope.createPasswordHash("vy password"), sessionSecret: "running-secret" };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(config));
  const rendererEvent = { sender: contents, senderFrame: { url: "http://localhost:3456/" } };
  const setupEvent = { sender: setupContents };
  return {
    scope, userData, effects, window, contents, handlers, config, app,
    setToken(value) { token = value; },
    signIn: () => handlers.get("profiles:signed-in")(rendererEvent),
    signOut: () => handlers.get("profiles:signed-out")(rendererEvent),
    switchFromSignIn: (id) => handlers.get("profiles:switch")(rendererEvent, id),
    invoke: (name, ...args) => handlers.get(name)(setupEvent, ...args),
    closeAccepted() { window.destroyed = true; scope.mainWindow = null; window.emit("closed"); },
    async add(name, dataDir = path.join(userData, "..", `${path.basename(userData)}-${name}`)) {
      await scope.createProfile({ name, dataDir, password: "other password", passwordConfirmation: "other password" });
      return readProfiles(userData).profiles.find((profile) => profile.name === name);
    },
  };
}

function temporaryUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "libera-profiles-"));
}

test("an install without a profiles file has one user, named after its preferences", () => {
  const userData = temporaryUserData();
  const state = readProfiles(userData, "Vy");
  assert.deepEqual(state.profiles, [{ id: DEFAULT_PROFILE_ID, name: "Vy" }]);
  assert.equal(state.lastSignedInProfileId, DEFAULT_PROFILE_ID);
  assert.equal(state.nextProfileId, null);
  assert.equal(readProfiles(userData, "").profiles[0].name, "Libera");
});

test("the first user keeps the original config file; others get a folder of their own", () => {
  const userData = temporaryUserData();
  assert.equal(profileConfigPath(userData, DEFAULT_PROFILE_ID, "config.json"), path.join(userData, "config.json"));
  const { profile } = addProfile(readProfiles(userData), "Bob");
  assert.equal(profileConfigPath(userData, profile.id, "config.json"), path.join(userData, "profiles", profile.id, "config.json"));
  assert.throws(() => profileConfigPath(userData, "../escape", "config.json"), /does not exist/);
});

test("profiles round-trip, and the last signed-in user survives a restart", () => {
  const userData = temporaryUserData();
  let { state, profile } = addProfile(readProfiles(userData, "Vy"), "  Bob   Smith ");
  assert.equal(profile.name, "Bob Smith");
  state = recordSignIn(state, profile.id);
  writeProfiles(userData, state);
  const read = readProfiles(userData, "Vy");
  assert.equal(read.lastSignedInProfileId, profile.id);
  assert.equal(resolveStartupProfile(read).profileId, profile.id);
  assert.deepEqual(read.profiles.map((item) => item.name), ["Vy", "Bob Smith"]);
});

test("a user chosen on the sign-in screen opens once; the last signed-in user opens after that", () => {
  const userData = temporaryUserData();
  const { state, profile } = addProfile(readProfiles(userData, "Vy"), "Bob");
  writeProfiles(userData, chooseNextProfile(state, profile.id));

  // The restart after choosing Bob opens Bob and uses up the choice.
  let startup = resolveStartupProfile(readProfiles(userData, "Vy"));
  assert.equal(startup.profileId, profile.id);
  assert.equal(startup.changed, true);
  writeProfiles(userData, startup.state);

  // Bob never signed in: the next start is Vy's again.
  startup = resolveStartupProfile(readProfiles(userData, "Vy"));
  assert.equal(startup.profileId, DEFAULT_PROFILE_ID);
  assert.equal(startup.changed, false);

  // Once Bob signs in, normal starts open Bob.
  writeProfiles(userData, recordSignIn(readProfiles(userData, "Vy"), profile.id));
  assert.equal(resolveStartupProfile(readProfiles(userData, "Vy")).profileId, profile.id);
});

test("names are required and unique, ignoring case", () => {
  const { state } = addProfile(readProfiles(temporaryUserData(), "Vy"), "Bob");
  assert.throws(() => addProfile(state, "bob"), /already a user named/);
  assert.throws(() => addProfile(state, "   "), /Enter a name/);
  assert.throws(() => renameProfile(state, DEFAULT_PROFILE_ID, "BOB"), /already a user named/);
  assert.equal(renameProfile(state, DEFAULT_PROFILE_ID, "Vy Tran").profiles[0].name, "Vy Tran");
});

test("only other, non-first users can be removed, and they are forgotten", () => {
  let { state, profile } = addProfile(readProfiles(temporaryUserData(), "Vy"), "Bob");
  assert.throws(() => removeProfile(state, DEFAULT_PROFILE_ID, DEFAULT_PROFILE_ID), /first user/);
  assert.throws(() => removeProfile(state, profile.id, profile.id), /Switch to another user/);
  state = chooseNextProfile(recordSignIn(state, profile.id), profile.id);
  state = removeProfile(state, profile.id, DEFAULT_PROFILE_ID);
  assert.deepEqual(state.profiles.map((item) => item.id), [DEFAULT_PROFILE_ID]);
  assert.equal(state.lastSignedInProfileId, DEFAULT_PROFILE_ID);
  assert.equal(state.nextProfileId, null);
});

test("stale user ids fall back to the first user", () => {
  const userData = temporaryUserData();
  fs.writeFileSync(path.join(userData, "profiles.json"), JSON.stringify({
    version: 1,
    lastSignedInProfileId: "p-000000000000",
    nextProfileId: "p-999999999999",
    profiles: [{ id: "p-111111111111", name: "Bob" }, { id: "bad id", name: "Eve" }],
  }));
  const state = readProfiles(userData, "Vy");
  assert.equal(state.lastSignedInProfileId, DEFAULT_PROFILE_ID);
  assert.equal(state.nextProfileId, null);
  assert.deepEqual(state.profiles.map((item) => item.name), ["Vy", "Bob"]);
});

test("the number of users is capped", () => {
  let state = readProfiles(temporaryUserData(), "Vy");
  for (let index = 1; index < MAX_PROFILES; index += 1) state = addProfile(state, `User ${index}`).state;
  assert.throws(() => addProfile(state, "One more"), /up to/);
});

test("a removed user's settings are moved aside, not deleted", () => {
  const userData = temporaryUserData();
  const { profile } = addProfile(readProfiles(userData), "Bob");
  const configPath = profileConfigPath(userData, profile.id, "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{}");
  const target = moveProfileAside(userData, profile.id, 42);
  assert.equal(target, path.join(userData, "profiles", ".removed", `${profile.id}-42`));
  assert.equal(fs.existsSync(path.join(target, "config.json")), true);
  assert.equal(fs.existsSync(configPath), false);
  assert.throws(() => moveProfileAside(userData, DEFAULT_PROFILE_ID), /first user/);
});

test("master directories of different users must not overlap", () => {
  const root = path.resolve(os.tmpdir(), "libera-dirs");
  const entries = [
    { id: DEFAULT_PROFILE_ID, name: "Vy", dataDir: path.join(root, "vy") },
    { id: "p-111111111111", name: "Bob", dataDir: path.join(root, "bob") },
  ];
  assert.equal(findDataDirConflict(entries, "p-111111111111", path.join(root, "vy"))?.name, "Vy");
  assert.equal(findDataDirConflict(entries, "p-111111111111", path.join(root, "vy", "inner"))?.name, "Vy");
  assert.equal(findDataDirConflict(entries, "p-111111111111", root)?.name, "Vy");
  assert.equal(findDataDirConflict(entries, "p-111111111111", path.join(root, "bob", "notes")), null);
  assert.equal(findDataDirConflict(entries, "p-111111111111", path.join(root, "vy-two")), null);
  assert.equal(findDataDirConflict(entries, DEFAULT_PROFILE_ID, path.join(root, "vy")), null);
});

test("canonical paths resolve junctions, new descendants, roots and Windows namespace aliases", () => {
  const root = temporaryUserData();
  const real = path.join(root, "real");
  const alias = path.join(root, "alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  const entries = [{ id: "alice", dataDir: path.join(real, "new", "notes") }];
  assert.equal(profileLogic.findDataDirConflict(entries, "bob", path.join(alias, "new")), entries[0]);
  assert.equal(profileLogic.findDataDirConflict([{ id: "alice", dataDir: alias }], "bob", real)?.id, "alice");
  assert.equal(profileLogic.pathsOverlap(path.parse(root).root, real), true);
  assert.equal(profileLogic.pathsOverlap(real, `${real}-two`), false);
  assert.equal(profileLogic.stripWindowsPrefix("\\\\?\\UNC\\server\\share\\notes"), "\\\\server\\share\\notes");
  assert.equal(profileLogic.stripWindowsPrefix("\\\\?\\D:\\notes"), "D:\\notes");
  if (process.platform === "win32") assert.equal(profileLogic.directoryKey(`\\\\?\\${real.toUpperCase()}`), profileLogic.directoryKey(real));
});

test("master directories cannot overlap application storage through aliases or missing descendants", () => {
  const root = temporaryUserData();
  const storage = path.join(root, "app");
  const alias = path.join(root, "alias");
  fs.mkdirSync(storage);
  fs.symlinkSync(storage, alias, process.platform === "win32" ? "junction" : "dir");
  for (const candidate of [storage, root, path.join(alias, "profiles", "new"), alias]) {
    assert.throws(() => profileLogic.assertOutsideUserData(candidate, storage), /application storage/);
  }
  assert.doesNotThrow(() => profileLogic.assertOutsideUserData(path.join(root, "notes"), alias));
});

test("effective custom and default indices are isolated from other masters and index files in both directions", () => {
  const root = temporaryUserData();
  const alice = { id: "alice", dataDir: path.join(root, "alice"), indexFile: path.join(root, "indices", "alice.sqlite") };
  const find = (candidate) => profileLogic.findStorageConflict([alice], "bob", candidate);
  assert.equal(find({ dataDir: path.join(root, "bob"), indexFile: alice.indexFile }), alice);
  assert.equal(find({ dataDir: path.join(root, "indices"), indexFile: path.join(root, "bob.sqlite") }), alice);
  assert.equal(find({ dataDir: path.join(root, "bob"), indexFile: path.join(alice.dataDir, "search.sqlite") }), alice);
  assert.equal(find({ dataDir: path.join(root, "bob"), indexFile: path.join(root, "alice") }), alice);
  assert.equal(find({ dataDir: path.join(root, "bob"), indexFile: path.join(root, "bob.sqlite") }), null);
  assert.equal(profileLogic.effectiveIndexFile({ dataDir: alice.dataDir, search: { indexFile: alice.indexFile } }, path.join(root, "config.json")), alice.indexFile);
  assert.equal(profileLogic.effectiveIndexFile({ search: { indexFile: alice.indexFile } }, path.join(root, "config.json")), alice.indexFile);
  const defaultIndex = profileLogic.effectiveIndexFile({ dataDir: alice.dataDir }, path.join(root, "config.json"));
  assert.equal(find({ dataDir: path.join(root, "bob"), indexFile: defaultIndex }), null);
  assert.equal(profileLogic.findStorageConflict([{ ...alice, indexFile: defaultIndex }], "bob", { dataDir: path.join(root, "bob"), indexFile: defaultIndex })?.id, "alice");
});

test("session proof rejects wrong profiles, expired or archive tokens, malformed and forged tokens", () => {
  const verify = profileLogic.verifyProfileSession;
  assert.equal(verify(sessionToken("alice"), "alice"), true);
  assert.equal(verify(sessionToken("alice"), "bob"), false);
  assert.equal(verify(sessionToken("alice", { sub: "admin", exp: Date.now() - 1 }), "alice"), false);
  assert.equal(verify(sessionToken("alice", { sub: "archive", exp: Date.now() + 60_000 }), "alice"), false);
  for (const token of [undefined, "bad", "a.b", `${sessionToken("alice")}x`, `${sessionToken("alice")}.extra`]) assert.equal(verify(token, "alice"), false);
});

test("every Users IPC requires verified sign-in, rechecks expiry and revokes management on logout", async () => {
  const h = mainHarness();
  const actions = [
    ["setup:list-profiles"], ["setup:add-profile", {}], ["setup:rename-profile", "default", "New"],
    ["setup:remove-profile", "p-111111111111"], ["setup:switch-profile", "p-111111111111"],
  ];
  for (const args of actions) await assert.rejects(h.invoke(...args), /Sign in first/);
  h.setToken(sessionToken("other-profile"));
  await assert.rejects(h.signIn(), /Sign in first/);
  h.setToken(sessionToken("running-secret"));
  await h.signIn();
  assert.equal((await h.invoke("setup:list-profiles")).profiles.length, 1);
  h.setToken(sessionToken("running-secret", { sub: "admin", exp: 1 }));
  await assert.rejects(h.invoke("setup:list-profiles"), /Sign in first/);
  h.setToken(sessionToken("running-secret"));
  await h.signOut();
  for (const args of actions) await assert.rejects(h.invoke(...args), /Sign in first/);
});

test("renaming and removing another user verify their password, including the first user", async () => {
  const h = mainHarness();
  await h.signIn();
  const bob = await h.add("Bob");
  await assert.rejects(h.invoke("setup:rename-profile", bob.id, "Robert", "wrong"), /correct master password/);
  await assert.rejects(h.invoke("setup:remove-profile", bob.id, "wrong"), /correct master password/);
  await h.invoke("setup:rename-profile", bob.id, "Robert", "other password");
  assert.equal(readProfiles(h.userData).profiles[1].name, "Robert");
  h.scope.runningProfileId = bob.id;
  await assert.rejects(h.invoke("setup:rename-profile", "default", "Alice", "wrong"), /correct master password/);
  h.scope.runningProfileId = "default";
  await h.invoke("setup:remove-profile", bob.id, "other password");
  assert.equal(readProfiles(h.userData).profiles.length, 1);
});

test("queued creation preserves renames and other additions and revalidates names, limits and paths", async () => {
  const h = mainHarness();
  await h.signIn();
  const create = h.add("Bob");
  const rename = h.invoke("setup:rename-profile", "default", "Alice");
  const ann = h.add("Ann");
  await Promise.all([create, rename, ann]);
  assert.deepEqual(readProfiles(h.userData).profiles.map((p) => p.name), ["Alice", "Bob", "Ann"]);
  const duplicate = await Promise.allSettled([h.add("Chris"), h.add("chris")]);
  assert.equal(duplicate.filter((r) => r.status === "fulfilled").length, 1);
  const shared = path.join(h.userData, "..", `${path.basename(h.userData)}-shared`);
  const overlap = await Promise.allSettled([h.add("Dan", shared), h.add("Eve", path.join(shared, "inner"))]);
  assert.equal(overlap.filter((r) => r.status === "fulfilled").length, 1);
  await h.add("Frank");
  await h.add("Grace");
  const limit = await Promise.allSettled([h.add("Hank"), h.add("Ivy")]);
  assert.equal(limit.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(readProfiles(h.userData).profiles.length, MAX_PROFILES);
});

test("removal rereads after confirmation and preserves interleaved additions and renames", async () => {
  const h = mainHarness();
  await h.signIn();
  const bob = await h.add("Bob");
  let confirm;
  h.scope.showMessageBox = () => new Promise((resolve) => { confirm = resolve; });
  const removing = h.invoke("setup:remove-profile", bob.id, "other password");
  await settle();
  await h.add("Ann");
  await h.invoke("setup:rename-profile", "default", "Alice");
  confirm({ response: 0 });
  await removing;
  assert.deepEqual(readProfiles(h.userData).profiles.map((p) => p.name), ["Alice", "Ann"]);
});

test("creation refuses app storage and master folders containing another user's custom index", async () => {
  const h = mainHarness();
  await h.signIn();
  await assert.rejects(h.add("Bob", path.join(h.userData, "profiles", "notes")), /application storage/);
  const shared = path.join(h.userData, "..", `${path.basename(h.userData)}-indices`);
  fs.writeFileSync(path.join(h.userData, "config.json"), JSON.stringify({ ...h.config, search: { indexFile: path.join(shared, "alice.sqlite") } }));
  await assert.rejects(h.add("Bob", shared), /overlaps storage/);
});

test("switch commits only after closure; cancellation, failed saves and thrown closes leave no relaunch queued", async () => {
  for (const outcome of ["cancel", "failed-save", "throw", "accept"]) {
    const h = mainHarness();
    await h.signIn();
    const bob = await h.add("Bob");
    await h.signOut();
    if (outcome === "throw") h.window.close = () => { throw new Error("close failed"); };
    const switching = h.switchFromSignIn(bob.id);
    assert.equal(readProfiles(h.userData).nextProfileId, null);
    assert.equal(h.scope.isQuitting, false);
    assert.deepEqual(h.effects, []);
    if (outcome === "throw") await assert.rejects(switching, /close failed/);
    else {
      if (outcome === "cancel") h.contents.emit("will-prevent-unload");
      else if (outcome === "failed-save") h.window.emit("profile-close-failed");
      else h.closeAccepted();
      assert.equal((await switching).switched, outcome === "accept");
    }
    assert.equal(readProfiles(h.userData).nextProfileId, outcome === "accept" ? bob.id : null);
    assert.equal(h.scope.isQuitting, outcome === "accept");
    assert.deepEqual(h.effects, outcome === "accept" ? ["relaunch", "quit"] : []);
    assert.equal(h.scope.pendingProfileSwitch, null);
    assert.equal(h.contents.listenerCount("will-prevent-unload"), 0);
    if (outcome !== "accept") { h.app.quit(); assert.equal(readProfiles(h.userData).nextProfileId, null); }
  }
});

test("Preferences save and import reject indices in another master, shared index aliases and app-storage masters", async () => {
  const h = mainHarness();
  await h.signIn();
  const bob = await h.add("Bob");
  const bobConfigPath = profileConfigPath(h.userData, bob.id, "config.json");
  const bobConfig = JSON.parse(fs.readFileSync(bobConfigPath, "utf8"));
  const indexDir = path.join(h.userData, "..", `${path.basename(h.userData)}-index`);
  const alias = path.join(h.userData, "..", `${path.basename(h.userData)}-alias`);
  fs.mkdirSync(indexDir);
  fs.symlinkSync(indexDir, alias, process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(bobConfigPath, JSON.stringify({ ...bobConfig, search: { indexFile: path.join(indexDir, "bob.sqlite") } }));
  const candidates = [
    { ...h.config, search: { indexFile: path.join(bobConfig.dataDir, "index.sqlite") } },
    { ...h.config, search: { indexFile: path.join(alias, "bob.sqlite") } },
    { ...h.config, dataDir: indexDir },
    { ...h.config, dataDir: path.join(h.userData, "profiles", "new") },
    { ...h.config, dataDir: path.dirname(h.userData) },
  ];
  for (const candidate of candidates) {
    await assert.rejects(h.invoke("setup:save", candidate), /overlaps storage|application storage/);
    const backup = path.join(h.userData, "backup.json");
    fs.writeFileSync(backup, JSON.stringify(candidate));
    h.scope.dialog = { showOpenDialog: async () => ({ filePaths: [backup] }) };
    await assert.rejects(h.scope.importPreferences(h.window), /overlaps storage|application storage/);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.userData, "config.json"), "utf8")), h.config);
});

test("creation rereads names, profile limits and paths immediately before committing the registry", async () => {
  for (const conflict of ["name", "limit", "path"]) {
    const h = mainHarness();
    await h.signIn();
    const notes = path.join(h.userData, "..", `${path.basename(h.userData)}-bob`);
    const originalMkdir = h.scope.fsp.mkdir;
    let changed = false;
    h.scope.fsp.mkdir = async (...args) => {
      await originalMkdir(...args);
      if (changed) return;
      changed = true;
      let state = readProfiles(h.userData);
      const added = addProfile(state, conflict === "name" ? "Bob" : "Other");
      state = added.state;
      if (conflict === "limit") while (state.profiles.length < MAX_PROFILES) state = addProfile(state, `User ${state.profiles.length}`).state;
      writeProfiles(h.userData, state);
      if (conflict === "path") {
        const configPath = profileConfigPath(h.userData, added.profile.id, "config.json");
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ dataDir: notes }));
      }
    };
    await assert.rejects(h.add("Bob", notes), /already a user|up to|overlaps storage/);
    assert.equal(readProfiles(h.userData).profiles.length, conflict === "limit" ? MAX_PROFILES : 2);
  }
});

test("switching uses the real close/flush/quit handlers and never carries a cancelled switch into a later quit", async () => {
  for (const outcome of ["accept", "cancel", "failed-save", "throw"]) {
    const h = mainHarness();
    await h.signIn();
    const bob = await h.add("Bob");
    let flushes = 0;
    let acknowledge;
    const errors = [];
    h.scope.requestStateFlush = () => {
      flushes += 1;
      return new Promise((resolve, reject) => { acknowledge = (error) => error ? reject(new Error(error)) : resolve(); });
    };
    Object.assign(h.scope, {
      rendererStateReady: true, quitRequested: false, shutdownComplete: false, shutdownPromise: null,
      statefulContents: new Set(), childWindows: new Set(), startupInProgress: false,
      updaterService: { dispose() {} }, collabHost: { stop: async () => {} },
      nextProcess: {}, stopProcessTree: async () => {}, process: new EventEmitter(),
      dialog: { showErrorBox: (_title, message) => errors.push(message) },
    });
    h.app.quit = () => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      h.app.emit("before-quit", event);
      if (!event.prevented) h.effects.push("quit");
    };
    let cancel = outcome === "cancel";
    let closeThrows = outcome === "throw";
    h.window.close = () => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      h.window.emit("close", event);
      if (event.prevented) return;
      if (closeThrows) throw new Error("close failed");
      if (cancel) { h.contents.emit("will-prevent-unload"); return; }
      h.window.destroyed = true;
      h.window.emit("closed");
      h.app.emit("window-all-closed");
    };
    const closeStart = mainSource.indexOf("  let closingAfterFlush = false;");
    vm.runInContext(mainSource.slice(closeStart, mainSource.indexOf("  if (isWindowsGlass)", closeStart)), h.scope);
    vm.runInContext(mainSource.slice(mainSource.indexOf("function prepareToQuit()")), h.scope);
    const switching = h.scope.switchToProfile(bob.id);
    assert.equal(flushes, 1);
    assert.equal(h.window.destroyed, undefined);
    assert.equal(h.scope.isQuitting, false);
    assert.deepEqual(h.effects, []);
    acknowledge(outcome === "failed-save" ? "Disk unavailable" : null);
    assert.equal((await switching).switched, outcome === "accept");
    await settle();
    if (outcome === "accept") {
      assert.equal(readProfiles(h.userData).nextProfileId, bob.id);
      assert.equal(h.effects[0], "relaunch");
      assert.equal(h.scope.shutdownComplete, true);
      assert.equal(flushes, 1);
    } else {
      assert.equal(readProfiles(h.userData).nextProfileId, null);
      assert.equal(h.scope.isQuitting, false);
      assert.deepEqual(h.effects, []);
      assert.deepEqual(errors, outcome === "failed-save" ? ["Disk unavailable"] : outcome === "throw" ? ["close failed"] : []);
      cancel = false;
      closeThrows = false;
      h.app.quit();
      acknowledge();
      await settle();
      assert.equal(flushes, 2);
      assert.equal(h.scope.shutdownComplete, true);
      assert.equal(h.effects.includes("relaunch"), false);
      assert.equal(readProfiles(h.userData).nextProfileId, null);
    }
  }
});

test("Preferences saves and user creation share the same directory reservation queue", async () => {
  for (const saveFirst of [true, false]) {
    const h = mainHarness();
    await h.signIn();
    const shared = path.join(h.userData, "..", `${path.basename(h.userData)}-shared`);
    const save = () => h.invoke("setup:save", { ...h.config, dataDir: shared });
    const add = () => h.add("Bob", shared);
    const results = await Promise.allSettled(saveFirst ? [save(), add()] : [add(), save()]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.match(results[1].reason.message, /overlaps storage/);
    assert.equal(readProfiles(h.userData).profiles.length, saveFirst ? 1 : 2);
  }
});

test("a corrupt registry recovers named and broken profile folders and preserves the evidence", () => {
  for (const damaged of ["{ interrupted", "null", '{"version":1,"profiles":{}}']) {
    const userData = temporaryUserData();
    const target = path.join(userData, "profiles.json");
    fs.writeFileSync(target, damaged);
    for (const [id, config] of [["p-111111111111", '{"yourName":"Bob"}'], ["p-222222222222", "broken"]]) {
      const file = profileConfigPath(userData, id, "config.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, config);
    }
    fs.mkdirSync(path.join(userData, "profiles", ".removed"));
    const recovered = readProfiles(userData, "Alice", "config.json");
    assert.deepEqual(recovered.profiles.map((profile) => profile.name), ["Alice", "Bob", "User 222222222222"]);
    assert.equal(fs.readFileSync(target, "utf8"), damaged, "reading never replaces the original");
    const backups = fs.readdirSync(userData).filter((name) => name.startsWith("profiles.json.corrupt-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(userData, backups[0]), "utf8"), damaged);
    readProfiles(userData, "Alice", "config.json");
    assert.equal(fs.readdirSync(userData).filter((name) => name.startsWith("profiles.json.corrupt-")).length, 1);
    assert.throws(() => writeProfiles(userData, { ...recovered, profiles: recovered.profiles.slice(0, 1) }), /kept unchanged/);
    writeProfiles(userData, recovered);
    assert.equal(readProfiles(userData).profiles.length, 3);
    assert.equal(fs.readFileSync(path.join(userData, backups[0]), "utf8"), damaged);
  }
});

test("unreadable registries recover folders but cannot be overwritten when preservation fails", (t) => {
  const userData = temporaryUserData();
  const target = path.join(userData, "profiles.json");
  const file = profileConfigPath(userData, "p-111111111111", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"yourName":"Bob"}');
  fs.writeFileSync(target, "original bytes");
  const read = fs.readFileSync;
  const copy = fs.copyFileSync;
  const denied = () => { throw Object.assign(new Error("Permission denied"), { code: "EACCES" }); };
  t.mock.method(fs, "readFileSync", (file, ...args) => file === target ? denied() : read(file, ...args));
  t.mock.method(fs, "copyFileSync", (file, ...args) => file === target ? denied() : copy(file, ...args));
  const recovered = readProfiles(userData, "Alice", "config.json");
  assert.equal(recovered.profiles[1].name, "Bob");
  assert.throws(() => writeProfiles(userData, recovered), /kept unchanged/);
  assert.equal(read(target, "utf8"), "original bytes");
});

test("default-only recovery and an inaccessible profiles directory never replace a damaged registry", () => {
  const userData = temporaryUserData();
  const target = path.join(userData, "profiles.json");
  fs.writeFileSync(target, "damaged");
  assert.throws(() => writeProfiles(userData, readProfiles(userData)), /kept unchanged/);
  fs.writeFileSync(path.join(userData, "profiles"), "not a directory");
  assert.throws(() => readProfiles(userData), /Could not recover/);
  assert.equal(fs.readFileSync(target, "utf8"), "damaged");
});

test("startup skips a broken chosen profile, clears the choice and keeps default first-run setup", () => {
  const base = readProfiles(temporaryUserData());
  const alice = addProfile(base, "Alice");
  const bob = addProfile(recordSignIn(alice.state, alice.profile.id), "Bob");
  const chosen = chooseNextProfile(bob.state, bob.profile.id);
  const complete = { dataDir: "D:/notes", openaiApiKey: "key", passwordHash: "hash" };
  for (const broken of [undefined, null, {}, [], { ...complete, dataDir: "" }, { ...complete, openaiApiKey: " " }, { ...complete, passwordHash: null }]) {
    assert.equal(profileLogic.isProfileConfigComplete(broken), false);
    const startup = resolveStartupProfile(chosen, (id) => profileLogic.isProfileConfigComplete(id === bob.profile.id ? broken : complete));
    assert.equal(startup.profileId, alice.profile.id);
    assert.equal(startup.failedProfile.name, "Bob");
    assert.equal(startup.changed, true);
    assert.equal(startup.state.nextProfileId, null);
    assert.equal(resolveStartupProfile(startup.state).profileId, alice.profile.id);
  }
  const fallback = resolveStartupProfile(recordSignIn(bob.state, bob.profile.id), () => false);
  assert.equal(fallback.profileId, "default");
  assert.equal(fallback.state.lastSignedInProfileId, "default");
  const firstRun = resolveStartupProfile(base, () => false);
  assert.equal(firstRun.failedProfile, null);
  assert.equal(firstRun.changed, false);
  assert.equal(firstRun.profileId, "default");
});

test("startup reads broken configs safely and never modifies their folders", async () => {
  const h = mainHarness();
  await h.signIn();
  const bob = await h.add("Bob");
  const file = profileConfigPath(h.userData, bob.id, "config.json");
  fs.writeFileSync(file, "null");
  writeProfiles(h.userData, recordSignIn(readProfiles(h.userData), bob.id));
  h.scope.runningProfileId = null;
  assert.equal(h.scope.getRunningProfileId(), "default");
  await settle();
  assert.equal(h.scope.startupProfileError.name, "Bob");
  assert.equal(readProfiles(h.userData).lastSignedInProfileId, "default");
  assert.equal(fs.readFileSync(file, "utf8"), "null");
});

test("default Chromium storage stays put and other users get distinct persistent partitions", () => {
  const h = mainHarness();
  const defaultSession = h.scope.session.defaultSession;
  assert.equal(h.scope.getProfileSession(), defaultSession);
  const partitions = new Map();
  h.scope.session.fromPartition = (name) => {
    if (!partitions.has(name)) partitions.set(name, {});
    return partitions.get(name);
  };
  h.scope.runningProfileId = "p-111111111111";
  const alice = h.scope.getProfileSession();
  assert.equal(alice, partitions.get("persist:profile-p-111111111111"));
  assert.equal(h.scope.getProfileSession(), alice);
  h.scope.runningProfileId = "p-222222222222";
  assert.notEqual(h.scope.getProfileSession(), alice);
  assert.notEqual(h.scope.getProfileSession(), defaultSession);
  for (const match of mainSource.matchAll(/webPreferences:\s*\{/g)) {
    assert.match(mainSource.slice(match.index, match.index + 110), /session: getProfileSession\(\)/);
  }
});

test("collaboration frame trust includes the running profile's session", () => {
  const profileSession = {};
  const otherSession = {};
  const top = {};
  const window = { isDestroyed: () => false, webContents: { session: profileSession, mainFrame: top } };
  const scope = vm.createContext({
    nextServerUrl: "http://localhost:3456", getProfileSession: () => profileSession,
    BrowserWindow: { getAllWindows: () => [window] },
    isSameOrigin: (left, right) => new URL(left).origin === new URL(right).origin,
    createCollabHost: (options) => options,
  });
  vm.runInContext(mainSource.slice(mainSource.indexOf("const collabHost = createCollabHost("), mainSource.indexOf("const hasInstanceLock")), scope);
  const trust = vm.runInContext("collabHost.isTrustedFrame", scope);
  assert.equal(trust({ url: "http://localhost:3456/file-window", top }), true);
  window.webContents.session = otherSession;
  assert.equal(trust({ url: "http://localhost:3456/file-window", top }), false);
  window.webContents.session = profileSession;
  assert.equal(trust({ url: "https://example.com", top }), false);
});

test("startup overlap repair is offered once and cancellation or continued conflicts stop startup", async () => {
  for (const outcome of ["repair", "quit", "cancel", "still-conflicts"]) {
    const h = mainHarness();
    await h.signIn();
    const bob = await h.add("Bob");
    const bobConfig = h.scope.readProfileConfig(bob.id);
    const conflicting = { ...h.config, search: { indexFile: path.join(bobConfig.dataDir, "index.sqlite") } };
    let dialogs = 0;
    let preferences = 0;
    h.scope.showMessageBox = async (_parent, options) => {
      dialogs++;
      assert.match(options.detail, /Bob/);
      return { response: outcome === "quit" ? 1 : 0 };
    };
    h.scope.createSetupWindow = async () => {
      preferences++;
      return outcome === "cancel" ? null : outcome === "still-conflicts" ? conflicting : h.config;
    };
    vm.runInContext(mainSource.slice(mainSource.indexOf("async function validateStartupStorage("), mainSource.indexOf("async function bootstrap(")), h.scope);
    if (outcome === "repair") assert.equal(await h.scope.validateStartupStorage(conflicting), h.config);
    else await assert.rejects(h.scope.validateStartupStorage(conflicting), /canceled|overlaps storage/);
    assert.equal(dialogs, 1);
    assert.equal(preferences, outcome === "quit" ? 0 : 1);
    assert.equal(await h.scope.validateStartupStorage(h.config), h.config);
    assert.equal(dialogs, 1, "valid startup needs no recovery dialog");
    assert.throws(() => h.scope.assertProfileStorageAvailable({ ...h.config, dataDir: h.userData }), /application storage/);
  }
});
