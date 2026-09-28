const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { setImmediate: nextTurn } = require("node:timers/promises");
const test = require("node:test");
const { maintainWindowsBackdrop } = require("../../electron/windows-backdrop.cjs");

function fixture() {
  const window = new EventEmitter();
  const nativeTheme = new EventEmitter();
  const hooks = new Map();
  const materials = [];
  let destroyed = false;
  window.isDestroyed = () => destroyed;
  window.setBackgroundMaterial = (material) => {
    assert.equal(destroyed, false);
    materials.push(material);
  };
  window.hookWindowMessage = (message, callback) => hooks.set(message, callback);
  window.close = () => {
    destroyed = true;
    window.emit("closed");
  };
  maintainWindowsBackdrop(window, nativeTheme);
  return { window, nativeTheme, hooks, materials };
}

test("restores the hidden caption after Electron's synchronous focus/blur repaint", async () => {
  const { window, materials } = fixture();
  await nextTurn();
  assert.deepEqual(materials, ["acrylic"]);

  for (const event of ["focus", "blur", "show"]) {
    materials.length = 0;
    window.emit(event);
    // Electron overwrites the caption *after* delivering the JS event.
    materials.push("native caption reset");
    assert.deepEqual(materials, ["native caption reset"]);
    await nextTurn();
    assert.deepEqual(materials, ["native caption reset", "acrylic"]);
  }
  window.close();
});

test("coalesces focus, theme and accent changes into one deferred refresh", async () => {
  const { window, nativeTheme, hooks, materials } = fixture();
  window.emit("show");
  window.emit("focus");
  nativeTheme.emit("updated");
  hooks.get(0x0320)();
  hooks.get(0x001a)();
  assert.deepEqual(materials, []);
  await nextTurn();
  assert.deepEqual(materials, ["acrylic"]);

  for (const message of [0x0320, 0x001a]) {
    hooks.get(message)();
    await nextTurn();
  }
  assert.equal(materials.length, 3);
  window.close();
});

test("closing cancels pending work and removes the shared theme listener", async () => {
  const { window, nativeTheme, materials } = fixture();
  assert.equal(nativeTheme.listenerCount("updated"), 1);
  window.close();
  assert.equal(nativeTheme.listenerCount("updated"), 0);
  nativeTheme.emit("updated");
  window.emit("focus");
  await nextTurn();
  assert.deepEqual(materials, []);
});
