import { inkPower } from "@/components/libera/ink/ink-power";

/**
 * Keeps `data-window-inactive` and `data-on-battery` on the document element so
 * stylesheets can pause decorative animations (the AI glow) while the window is
 * in the background or the computer runs on battery. Safe to call repeatedly.
 */
let installed = false;

export function installWindowActivityAttributes() {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  const root = document.documentElement;
  const setFlag = (name: string, on: boolean) => {
    if (on) { if (root.getAttribute(name) !== "true") root.setAttribute(name, "true"); }
    else if (root.hasAttribute(name)) root.removeAttribute(name);
  };
  const updateWindow = () => setFlag("data-window-inactive", document.hidden || !document.hasFocus());
  const updateBattery = () => setFlag("data-on-battery", inkPower.onBattery);
  window.addEventListener("focus", updateWindow);
  window.addEventListener("blur", updateWindow);
  document.addEventListener("visibilitychange", updateWindow);
  inkPower.subscribe(updateBattery);
  updateWindow();
  updateBattery();
}
