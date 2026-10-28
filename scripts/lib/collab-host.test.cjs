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
