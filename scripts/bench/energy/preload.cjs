// Preload for the energy bench window (context isolation off, so these land on
// the page's own window object).
//
// - liberaMenu: native context/action menus. The bench answers them from
//   window.__benchMenuChoice (the File actions menu picks the editor mode).
// - liberaAppMenu: the macOS menu bar bridge. Present so the app's menu-sync
//   work runs as it does in the desktop app; calls are only counted.
// - navigator.getBattery: reports "on battery" when BENCH_POWER=battery, so the
//   app takes its battery paths (ink, LaTeX auto-compile, decorative motion).

const counters = { appMenuUpdates: 0, menuPopups: 0 };

window.__benchCounters = counters;
window.__benchMenuChoice = null;

window.liberaMenu = {
  popup: async () => {
    counters.menuPopups += 1;
    const choice = window.__benchMenuChoice;
    window.__benchMenuChoice = null;
    return choice;
  },
};

window.liberaAppMenu = {
  update: () => { counters.appMenuUpdates += 1; },
  onSelect: () => () => {},
};

if (process.env.BENCH_POWER === "battery") {
  const battery = { charging: false, level: 0.6, chargingTime: Infinity, dischargingTime: 7200, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(Navigator.prototype, "getBattery", { configurable: true, value: () => Promise.resolve(battery) });
}
