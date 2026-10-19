const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { requestStateFlush } = require("../../electron/state-flush.cjs");

// Exercise the actual window-close and application-quit handlers with Electron's
// destroyed-object behavior, without opening the user's app or data directory.
function shutdownHarness() {
  const source = readFileSync(path.join(__dirname, "../../electron/main.cjs"), "utf8");
  const ipcMain = new EventEmitter();
  const contents = new EventEmitter();
  contents.mainFrame = {};
  contents.destroyed = false;
  contents.isDestroyed = () => contents.destroyed;
  const requests = [];
  contents.send = (channel, id) => { assert.equal(channel, "state:flush"); requests.push(id); };
  const window = new EventEmitter();
  window.destroyed = false;
  window.cancelClose = false;
  window.isDestroyed = () => window.destroyed;
  Object.defineProperty(window, "webContents", { get() {
    if (window.destroyed) throw new Error("Object had been destroyed");
    return contents;
  } });
  const errors = [];
  const stops = [];
  const app = new EventEmitter();
  let exits = 0;
  app.quit = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    app.emit("before-quit", event);
    if (!event.prevented) exits++;
  };
  window.close = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    window.emit("close", event);
    if (event.prevented || window.cancelClose) return;
    window.destroyed = contents.destroyed = true;
    contents.emit("destroyed");
    window.emit("closed");
    app.emit("window-all-closed");
  };
  const server = { pid: 123 };
  const scope = vm.createContext({
    mainWindow: window, rendererStateReady: true, quitRequested: false,
    shutdownComplete: false, shutdownPromise: null, isQuitting: false,
    nextProcess: server, ipcMain, requestStateFlush, app, process: new EventEmitter(), console,
    updaterService: { dispose() {} }, stopProcessTree: async (child) => { stops.push(child); },
    dialog: { showErrorBox: (title, message) => errors.push({ title, message }) },
  });
  const closeStart = source.indexOf("  let closingAfterFlush = false;");
  const closeEnd = source.indexOf("  if (isWindowsGlass)", closeStart);
  assert.ok(closeStart >= 0 && closeEnd > closeStart);
  vm.runInContext(source.slice(closeStart, closeEnd), scope);
  const quitStart = source.indexOf("function prepareToQuit()");
  assert.ok(quitStart >= 0);
  vm.runInContext(source.slice(quitStart), scope);
  const acknowledge = (error) => {
    assert.ok(requests.length, "close requests a session save");
    ipcMain.emit("state:flushed", { sender: contents, senderFrame: contents.mainFrame }, requests.at(-1), error);
  };
  return { window, contents, scope, requests, acknowledge, errors, stops, server, app, get exits() { return exits; } };
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

for (const action of ["close window", "quit application"]) {
  test(`${action} saves before destruction and stops the server without a destroyed-object error`, async () => {
    const h = shutdownHarness();
    if (action === "close window") h.window.close(); else h.app.quit();
    assert.equal(h.window.destroyed, false);
    assert.equal(h.stops.length, 0, "the server stays alive until the save completes");
    h.acknowledge(); await settle();
    assert.equal(h.window.destroyed, true);
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 1, "shutdown does not request a second save from a destroyed window");
    assert.deepEqual(h.stops, [h.server]);
    assert.ok(h.exits > 0);
    assert.equal(h.scope.mainWindow, null);
    assert.equal(h.scope.rendererStateReady, false);
  });
}

test("canceling an unsaved-document close keeps the server alive and a later close saves again", async () => {
  const h = shutdownHarness();
  h.window.cancelClose = true;
  h.app.quit(); h.acknowledge(); await settle();
  assert.equal(h.window.destroyed, false);
  assert.equal(h.stops.length, 0);
  assert.deepEqual(h.errors, []);
  h.window.cancelClose = false;
  h.window.close(); h.acknowledge(); await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.window.destroyed, true);
  assert.deepEqual(h.stops, [h.server]);
  assert.deepEqual(h.errors, []);
});

test("a failed session save leaves the window and server available for a successful retry", async () => {
  const h = shutdownHarness();
  h.window.close(); h.acknowledge("Disk unavailable"); await settle();
  assert.equal(h.window.destroyed, false);
  assert.equal(h.stops.length, 0);
  assert.equal(h.errors[0]?.message, "Disk unavailable");
  h.window.close(); h.acknowledge(); await settle();
  assert.equal(h.window.destroyed, true);
  assert.deepEqual(h.stops, [h.server]);
  assert.equal(h.errors.length, 1, "a successful retry adds no destroyed-object error");
});
