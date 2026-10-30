const fs = require("node:fs");

// A file also reaches Next when it runs in a child process during development.
// A fresh file per app session and a heartbeat prevent trusting stale AC state.
function publishPowerState(powerMonitor, file) {
  const update = () => {
    let onBattery = null;
    try { onBattery = powerMonitor.isOnBatteryPower(); } catch { /* Unknown blocks AC-only work. */ }
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ onBattery, checkedAt: Date.now() }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      try { fs.rmSync(file, { force: true }); } catch { /* A stale heartbeat expires. */ }
    }
  };
  const events = ["on-ac", "on-battery", "resume"];
  for (const event of events) powerMonitor.on(event, update);
  update();
  const timer = setInterval(update, 30_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const event of events) powerMonitor.removeListener(event, update);
    for (const target of [file, `${file}.tmp`]) {
      try { fs.rmSync(target, { force: true }); } catch { /* Already removed. */ }
    }
  };
}

module.exports = { publishPowerState };
