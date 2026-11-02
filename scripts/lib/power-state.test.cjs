const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { publishPowerState } = require("../../electron/power-state.cjs");

test("Electron publishes adapter transitions and removes heartbeat/listeners on shutdown", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "libera-power-test-"));
  const file = path.join(directory, "power.json");
  const monitor = new EventEmitter();
  let battery = false;
  monitor.isOnBatteryPower = () => battery;
  const dispose = publishPowerState(monitor, file);
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  try {
    assert.equal(read().onBattery, false);
    battery = true; monitor.emit("on-battery");
    assert.equal(read().onBattery, true);
    battery = false; monitor.emit("on-ac");
    assert.equal(read().onBattery, false);
    monitor.isOnBatteryPower = () => { throw new Error("unavailable"); };
    monitor.emit("resume");
    assert.equal(read().onBattery, null);
    assert.ok(read().checkedAt > 0);
  } finally {
    dispose();
    assert.equal(fs.existsSync(file), false);
    assert.equal(monitor.listenerCount("on-ac"), 0);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
