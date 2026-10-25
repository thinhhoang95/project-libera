// Electron main script for ink-pen.test.ts: opens a probe page with a drawing
// surface (touch-action: none) and a scrolling panel, drives them with the
// emulated pen, finger and mouse of ink-pen-driver.cjs, and prints one JSON
// line describing what the renderer received. It checks the pointer-event
// features ink-input relies on in this Electron (docs/ink-plan.md, "Input").
// Run with a throwaway --user-data-dir; it never touches the user's profile.

const http = require("node:http");
const { app, BrowserWindow } = require("electron");
const { createPenDriver, handwritingPoints } = require("./ink-pen-driver.cjs");

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>ink pen probe</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  #surface { position: absolute; left: 20px; top: 20px; width: 400px; height: 300px; touch-action: none; background: #fff; }
  #scroller { position: absolute; left: 460px; top: 20px; width: 300px; height: 300px; overflow: auto; touch-action: auto; }
  #scroller div { height: 3000px; background: linear-gradient(#eee, #999); }
</style>
<canvas id="surface" width="400" height="300"></canvas>
<div id="scroller"><div></div></div>
<script>
  const log = [];
  const frames = [];
  const fields = (event, where) => ({
    where,
    type: event.type,
    pointerType: event.pointerType,
    pointerId: event.pointerId,
    isPrimary: event.isPrimary,
    pressure: Math.round(event.pressure * 1000) / 1000,
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    button: event.button,
    buttons: event.buttons,
    coalesced: typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents().length : -1,
    predicted: typeof event.getPredictedEvents === "function" ? event.getPredictedEvents().length : -1,
    // Moves within one frame arrive as one event; its coalesced events are every sample.
    samples: (event.type === "pointermove" && typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [event])
      .map((sample) => ({ pressure: Math.round(sample.pressure * 1000) / 1000, tiltX: sample.tiltX, tiltY: sample.tiltY })),
  });
  document.addEventListener("pointerdown", (event) => { if (event.target === document.documentElement || event.target === document.body) log.push(fields(event, "page")); });
  for (const id of ["surface", "scroller"]) {
    const element = document.getElementById(id);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      element.addEventListener(type, (event) => {
        log.push(fields(event, id));
        if (id === "surface" && type === "pointermove" && event.buttons) {
          const handled = performance.now();
          requestAnimationFrame(() => frames.push(performance.now() - handled));
        }
      });
    }
  }
  const canvas = document.getElementById("surface");
  const context = canvas.getContext("2d", { desynchronized: true });
  window.__probe = {
    take() { const copy = log.splice(0); return copy; },
    frames() { return frames.splice(0); },
    scrollTop() { return document.getElementById("scroller").scrollTop; },
    resetScroll() { document.getElementById("scroller").scrollTop = 0; },
    features() {
      return {
        coalesced: typeof PointerEvent.prototype.getCoalescedEvents === "function",
        predicted: typeof PointerEvent.prototype.getPredictedEvents === "function",
        rawUpdate: "onpointerrawupdate" in window,
        desynchronized: Boolean(context.getContextAttributes && context.getContextAttributes().desynchronized),
        maxTouchPoints: navigator.maxTouchPoints,
        devicePixelRatio: window.devicePixelRatio,
      };
    },
  };
</script>`;

const settle = (window) => window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
const take = (window) => window.webContents.executeJavaScript("window.__probe.take()", true);

/** Serves the probe from 127.0.0.1: a secure context, like the app, where getCoalescedEvents exists. */
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

app.whenReady().then(async () => {
  let window;
  const server = await serve();
  try {
    // Shown off-screen: hidden windows may not composite, and input needs a live widget.
    window = new BrowserWindow({ x: -3000, y: 0, width: 800, height: 400, show: true, frame: false, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } });
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await settle(window);
    const pen = await createPenDriver(window.webContents);
    // For about 0.7 s after loading, emulated presses are dropped (moves are
    // not): tap outside the surfaces until a press arrives.
    window.webContents.focus();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await pen.penStroke([{ x: 440, y: 380 }, { x: 442, y: 381 }]);
      await settle(window);
      if ((await take(window)).some((event) => event.type === "pointerdown")) break;
    }
    const report = { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform };

    report.features = await window.webContents.executeJavaScript("window.__probe.features()", true);

    const stroke = handwritingPoints({ x: 60, y: 120 }, { x: 360, y: 160 });
    await pen.penStroke(stroke);
    await settle(window);
    report.stroke = { sent: stroke, received: await take(window), frameDelays: await window.webContents.executeJavaScript("window.__probe.frames()", true) };

    await pen.penHover([{ x: 100, y: 100 }, { x: 110, y: 104 }, { x: 120, y: 108 }]);
    await settle(window);
    report.hover = await take(window);

    await pen.penStroke(handwritingPoints({ x: 60, y: 200 }, { x: 200, y: 220 }, 8), { buttons: 32, button: "left" });
    await settle(window);
    report.eraserButton = await take(window);

    await pen.mouseStroke([{ x: 80, y: 60 }, { x: 140, y: 70 }, { x: 200, y: 80 }]);
    await settle(window);
    report.mouse = await take(window);

    await pen.touchDrag({ x: 220, y: 250 }, { x: 220, y: 60 }, 12);
    await settle(window);
    report.touchOnSurface = await take(window);

    await window.webContents.executeJavaScript("window.__probe.resetScroll()", true);
    await pen.touchDrag({ x: 610, y: 280 }, { x: 610, y: 60 }, 12);
    await new Promise((resolve) => setTimeout(resolve, 300));
    report.touchScroll = { scrollTop: await window.webContents.executeJavaScript("window.__probe.scrollTop()", true), events: await take(window) };

    await window.webContents.executeJavaScript("window.__probe.resetScroll()", true);
    await pen.penStroke(handwritingPoints({ x: 610, y: 280 }, { x: 610, y: 60 }, 12));
    await new Promise((resolve) => setTimeout(resolve, 300));
    report.penOnScroller = { scrollTop: await window.webContents.executeJavaScript("window.__probe.scrollTop()", true), events: await take(window) };

    await pen.touchHold({ x: 380, y: 280 }, () => pen.penStroke(handwritingPoints({ x: 60, y: 60 }, { x: 300, y: 90 }, 10)));
    await settle(window);
    report.palmDuringPen = await take(window);

    pen.detach();
    window.destroy();
    server.close();
    process.stdout.write(`INK_PEN_REPORT ${JSON.stringify(report)}\n`);
    app.exit(0);
  } catch (error) {
    process.stdout.write(`INK_PEN_FAILED ${error && error.stack}\n`);
    window?.destroy();
    server.close();
    app.exit(1);
  }
});
