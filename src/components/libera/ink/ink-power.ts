"use client";

/*
 * Whether this computer is running on battery, from the Battery Status API
 * (Chromium, so Electron). On battery, ink surfaces draw at most 1.5 device
 * pixels per CSS pixel and skip the predicted tail of a stroke, which costs a
 * repaint per frame (docs/ink-plan.md, "Energy"). Unknown counts as plugged in.
 */

type BatteryManager = EventTarget & { charging: boolean };

let onBattery = false;
let started = false;
const listeners = new Set<() => void>();

function start() {
  if (started) return;
  started = true;
  const getBattery = (globalThis.navigator as Navigator & { getBattery?: () => Promise<BatteryManager> } | undefined)?.getBattery;
  if (typeof getBattery !== "function") return;
  void getBattery.call(navigator).then((battery) => {
    const update = () => {
      const next = !battery.charging;
      if (next === onBattery) return;
      onBattery = next;
      listeners.forEach((listener) => listener());
    };
    update();
    battery.addEventListener("chargingchange", update);
  }, () => undefined);
}

export const inkPower = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    start();
    return () => { listeners.delete(listener); };
  },
  get onBattery() {
    start();
    return onBattery;
  },
};
