const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("an unchanged dirty document count is not broadcast again", () => {
  const handlers = new Map();
  const electron = { app: { isPackaged: false, getVersion: () => "1.0.0" }, dialog: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? electron : originalLoad.call(this, request, ...rest); };
  let createUpdaterService;
  try { ({ createUpdaterService } = require("../../electron/updater.cjs")); } finally { Module._load = originalLoad; }
  const sent = [];
  const webContents = { send: (channel, state) => sent.push([channel, state]) };
  const window = { webContents, isDestroyed: () => false };
  createUpdaterService({ getMainWindow: () => window, onBeforeInstall: () => undefined }).initialize();
  const setCount = handlers.get("updater:set-dirty-document-count");
  const event = { sender: webContents };
  setCount(event, 0);
  assert.equal(sent.length, 0, "0 is already the starting count");
  setCount(event, 2);
  setCount(event, 2);
  setCount(event, 5);
  assert.equal(sent.length, 1, "only a change of unsaved state is published");
  assert.equal(sent[0][1].hasUnsavedDocuments, true);
  setCount(event, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1].hasUnsavedDocuments, false);
});
