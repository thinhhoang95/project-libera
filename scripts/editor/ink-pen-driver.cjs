// Emulated stylus, touch and mouse input for an Electron window, through the
// Chrome DevTools Protocol (docs/ink-plan.md, "Emulated pen for tests").
// `Input.dispatchMouseEvent` with `pointerType: "pen"` carries pressure
// (`force`) and tilt, so ink code can be driven without stylus hardware.
// Coordinates are CSS pixels from the top-left of the page's viewport.

const PROTOCOL_VERSION = "1.3";

/**
 * @param {import("electron").WebContents} webContents
 */
async function createPenDriver(webContents) {
  const debug = webContents.debugger;
  if (!debug.isAttached()) debug.attach(PROTOCOL_VERSION);
  const send = (method, params) => debug.sendCommand(method, params);
  let touchEnabled = false;

  /** One pen sample; pressure 0–1 and tilt in degrees, as PointerEvent reports them. */
  function penEvent(type, point, { buttons = 1, button = "left" } = {}) {
    return send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button,
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
      pointerType: "pen",
      force: point.pressure ?? 0.5,
      tiltX: point.tiltX ?? 0,
      tiltY: point.tiltY ?? 0,
      twist: point.twist ?? 0,
    });
  }

  return {
    /** A pen hovering in range, without touching: pointermove with no buttons. */
    async penHover(points) {
      for (const point of points) await penEvent("mouseMoved", point, { buttons: 0, button: "none" });
    },

    /**
     * A pen stroke: hover over the first point, down there, through the rest,
     * up at the last. A press with no move before it would be routed to
     * wherever the pointer last was; a real pen always hovers first.
     */
    async penStroke(points, { buttons = 1, button = "left" } = {}) {
      const [first, ...rest] = points;
      await penEvent("mouseMoved", { ...first, pressure: 0 }, { buttons: 0, button: "none" });
      await penEvent("mousePressed", first, { buttons, button });
      for (const point of rest) await penEvent("mouseMoved", point, { buttons, button });
      await penEvent("mouseReleased", points.at(-1), { buttons: 0, button });
    },

    async mouseStroke(points) {
      const [first, ...rest] = points;
      const event = (type, point, buttons) => send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
      await event("mousePressed", first, 1);
      for (const point of rest) await event("mouseMoved", point, 1);
      await event("mouseReleased", points.at(-1), 0);
    },

    /** One finger dragged from `from` to `to` in `steps` moves. */
    async touchDrag(from, to, steps = 10, id = 1) {
      if (!touchEnabled) {
        await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        touchEnabled = true;
      }
      const at = (t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id, radiusX: 8, radiusY: 8, force: 1 });
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(0)] });
      for (let step = 1; step <= steps; step += 1) await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(step / steps)] });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    },

    /** A finger resting at a point (a palm) while `during` runs, then lifted. */
    async touchHold(point, during, id = 2) {
      if (!touchEnabled) {
        await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        touchEnabled = true;
      }
      const touch = { ...point, id, radiusX: 20, radiusY: 20, force: 1 };
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touch] });
      try { await during(); } finally { await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); }
    },

    detach() {
      if (debug.isAttached()) debug.detach();
    },
  };
}

/** Points along a gentle wave, with pressure rising and tilt drifting, like handwriting. */
function handwritingPoints(from, to, count = 24) {
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0 : index / (count - 1);
    return {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t + Math.sin(t * Math.PI * 3) * 6,
      pressure: Math.round((0.2 + 0.7 * t) * 100) / 100,
      tiltX: Math.round(-20 + 30 * t),
      tiltY: 15,
    };
  });
}

module.exports = { createPenDriver, handwritingPoints };
