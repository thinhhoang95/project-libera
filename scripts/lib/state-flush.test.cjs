const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { requestStateFlush } = require("../../electron/state-flush.cjs");

test("quit waits for the matching main-frame acknowledgement and cleans listeners", async () => {
  const ipc = new EventEmitter();
  let id;
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {}, send: (channel, requestId) => { assert.equal(channel, "state:flush"); id = requestId; } });
  let done = false;
  const flush = requestStateFlush(contents, ipc).then(() => { done = true; });
  ipc.emit("state:flushed", { sender: {}, senderFrame: contents.mainFrame }, id);
  ipc.emit("state:flushed", { sender: contents, senderFrame: {} }, id);
  ipc.emit("state:flushed", { sender: contents, senderFrame: contents.mainFrame }, "old request");
  await Promise.resolve(); assert.equal(done, false);
  ipc.emit("state:flushed", { sender: contents, senderFrame: contents.mainFrame }, id);
  await flush;
  assert.equal(done, true);
  assert.equal(ipc.listenerCount("state:flushed"), 0);
  assert.equal(contents.listenerCount("destroyed"), 0);
});

test("failed saves and unresponsive renderers reject instead of silently quitting", async () => {
  const ipc = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {}, send: (_channel, id) => {
    ipc.emit("state:flushed", { sender: contents, senderFrame: contents.mainFrame }, id, "Disk unavailable");
  } });
  await assert.rejects(requestStateFlush(contents, ipc), /Disk unavailable/);
  assert.equal(ipc.listenerCount("state:flushed"), 0);
  assert.equal(contents.listenerCount("destroyed"), 0);
  contents.send = () => {};
  await assert.rejects(requestStateFlush(contents, ipc, 10), /timed out/);
  assert.equal(ipc.listenerCount("state:flushed"), 0);
  await requestStateFlush({ isDestroyed: () => true }, ipc);
});

test("local crash recovery is isolated by library and leaves the synced directory untouched", async (context) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { writeWorkspaceRecovery, localWorkspaceRecoveryRoot } = require("../../electron/workspace-recovery.cjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "libera-local-recovery-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const libraryRoot = path.join(directory, "OneDrive", "Library");
  const localRoot = localWorkspaceRecoveryRoot(path.join(directory, "user-data"), libraryRoot);
  assert.notEqual(localRoot, localWorkspaceRecoveryRoot(path.join(directory, "user-data"), `${libraryRoot}-other`));
  const body = JSON.stringify({ version: 1, updatedAt: 123, workspaces: [], activeWorkspaceId: null, librarySession: null });
  writeWorkspaceRecovery(localRoot, body);
  assert.equal(await fs.readFile(path.join(localRoot, ".libera-workspaces-recovery.json"), "utf8"), body);
  await assert.rejects(fs.stat(libraryRoot), { code: "ENOENT" });
  assert.equal(localWorkspaceRecoveryRoot(path.join(directory, "user-data"), libraryRoot), localRoot, "restarting on another port keeps the same recovery path");
  await fs.mkdir(libraryRoot, { recursive: true });
  await fs.writeFile(path.join(libraryRoot, ".libera-workspaces.json"), JSON.stringify({ ...JSON.parse(body), updatedAt: 124, activeWorkspaceId: "other" }));
  writeWorkspaceRecovery(localRoot, JSON.stringify({ ...JSON.parse(body), updatedAt: 125 }), libraryRoot);
  assert.equal(JSON.parse(await fs.readFile(path.join(localRoot, ".libera-workspaces-recovery.json"), "utf8")).updatedAt, 125,
    "returning to earlier contents refreshes recovery when a newer synced snapshot differs");
});

test("destruction during a pending save cleans listeners without reading a destroyed frame", async () => {
  const ipc = new EventEmitter();
  const contents = new EventEmitter();
  const frame = {};
  let dead = false;
  let id;
  let frameReads = 0;
  contents.isDestroyed = () => dead;
  Object.defineProperty(contents, "mainFrame", { get() {
    frameReads++;
    if (dead) throw new Error("Object had been destroyed");
    return frame;
  } });
  contents.send = (_channel, requestId) => { id = requestId; };
  const rejection = assert.rejects(requestStateFlush(contents, ipc), /closed before its session finished saving/);
  dead = true;
  contents.emit("destroyed");
  await rejection;
  assert.equal(ipc.listenerCount("state:flushed"), 0);
  assert.equal(contents.listenerCount("destroyed"), 0);
  assert.doesNotThrow(() => ipc.emit("state:flushed", { sender: contents, senderFrame: frame }, id));
  assert.equal(frameReads, 1, "the native frame is accessed only while alive");
});

test("a failed flush request removes both acknowledgement and destruction listeners", async () => {
  const ipc = new EventEmitter();
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => false,
    send: () => { throw new Error("Could not send save request"); },
  });
  await assert.rejects(requestStateFlush(contents, ipc), /Could not send save request/);
  assert.equal(ipc.listenerCount("state:flushed"), 0);
  assert.equal(contents.listenerCount("destroyed"), 0);
});
