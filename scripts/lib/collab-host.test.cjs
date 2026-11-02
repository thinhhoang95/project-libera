const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

test("the single-instance lock and focus behavior work with collaboration on or off", async () => {
  for (const enabled of ["0", "1"]) {
    for (const ownsLock of [true, false]) {
      const app = new EventEmitter();
      let claims = 0;
      app.requestSingleInstanceLock = () => { claims++; return ownsLock; };
      const calls = [];
      const window = {
        isDestroyed: () => false, isMinimized: () => true,
        restore: () => calls.push("restore"), show: () => calls.push("show"), focus: () => calls.push("focus"),
      };
      const scope = vm.createContext({
        require: (name) => name === "electron" ? { app, ipcMain: new EventEmitter() } : require(name),
        module: { exports: {} }, __dirname: path.resolve(__dirname, "../../electron"), console,
        process: { env: { LIBERA_COLLAB: enabled }, platform: process.platform },
      });
      vm.runInContext(readFileSync(path.join(__dirname, "../../electron/collab-host.cjs"), "utf8"), scope);
      const host = scope.module.exports.createCollabHost({ getMainWindow: () => window });
      assert.equal(host.claimSingleInstance(), ownsLock);
      assert.equal(claims, 1);
      app.emit("second-instance");
      assert.deepEqual(calls, ownsLock ? ["restore", "show", "focus"] : []);
      if (enabled === "0") {
        await host.start({});
        await host.stop();
        assert.deepEqual(Object.keys(host.environment()), []);
      }
    }
  }
});

test("Next and the utility host receive the same profile-local lifecycle directory", async () => {
  const app = new EventEmitter();
  app.getPath = () => path.resolve("/device/userData");
  app.getVersion = () => "test";
  let startMessage;
  const child = new EventEmitter();
  child.postMessage = (message) => {
    if (message.t === "start") {
      startMessage = message;
      queueMicrotask(() => child.emit("message", { t: "ready", url: "http://127.0.0.1:4567", port: 4567, storeSchemaVersion: 1 }));
    } else if (message.t === "shutdown") queueMicrotask(() => child.emit("exit", 0));
  };
  child.kill = () => child.emit("exit", 0);
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const electron = {
    app, ipcMain, utilityProcess: { fork: () => child }, powerMonitor: new EventEmitter(),
    net: { isOnline: () => true }, BrowserWindow: { getAllWindows: () => [] },
  };
  const net = { createServer: () => {
    const probe = new EventEmitter();
    probe.listen = (_port, _address, callback) => callback();
    probe.address = () => ({ port: 4567 });
    probe.close = (callback) => callback();
    return probe;
  } };
  const scope = vm.createContext({
    require: (name) => name === "electron" ? electron : name === "node:net" ? net : require(name),
    module: { exports: {} }, __dirname: path.resolve(__dirname, "../../electron"),
    console: { log() {}, warn() {}, error() {} }, process: { env: {}, platform: process.platform },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(readFileSync(path.join(__dirname, "../../electron/collab-host.cjs"), "utf8"), scope);
  const profile = path.join(app.getPath(), "profiles", "research");
  const host = scope.module.exports.createCollabHost({ hostPath: __filename, getUserData: () => profile });
  try {
    await host.start({ dataDir: path.resolve("/cloud/library") });
    assert.equal(startMessage.userData, profile);
    assert.equal(host.environment().LIBERA_COLLAB_LIFECYCLE_DIR, path.join(startMessage.userData, "collab", "notebook-lifecycle"));
    assert.equal(host.environment().LIBERA_COLLAB_HOST_URL, "http://127.0.0.1:4567");
  } finally { await host.stop(); }
});
