// Electron main for one energy-bench run: opens the app served at
// BENCH_CONFIG.url in a 1440x900 window, signs in, prepares one scenario, then
// drives it with real input events (webContents.sendInputEvent goes through
// Chromium's input pipeline, as a user's typing and scrolling do) while
// recording what the work cost.
//
// It prints machine-readable lines the orchestrator (run.mjs) reads:
//   BENCH_START <epoch ms>   BENCH_END <epoch ms>   BENCH_RESULT <json>
// and BENCH_ERROR <message> on failure.

const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");

const config = JSON.parse(process.env.BENCH_CONFIG || "{}");
const SETTLE_MS = config.settleMs ?? 5000;

app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.setName("Libera Bench");
// Each run starts from an empty profile: no cookies, local storage or caches carried over.
if (config.userData) app.setPath("userData", config.userData);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fs = require("node:fs");
// Written synchronously to a file: Electron's stdout to a pipe is only flushed
// late, and a run that is killed would otherwise leave no trace.
const emit = (line) => { if (config.logFile) fs.appendFileSync(config.logFile, `${line}\n`); else process.stdout.write(`${line}\n`); };
const step = (text) => emit(`BENCH_STEP ${text}`);

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let win;
let contents;
const requests = new Map();

function countRequest(details) {
  try {
    const url = new URL(details.url);
    if (!url.pathname.startsWith("/api/")) return;
    const key = `${details.method} ${url.pathname}`;
    requests.set(key, (requests.get(key) ?? 0) + 1);
  } catch { /* not a URL we care about */ }
}

const js = (code) => contents.executeJavaScript(code, true);

/** Never hangs: a page that is navigating or busy answers within a second or not at all. */
function jsWithin(code, ms = 2000) {
  return Promise.race([js(code), sleep(ms).then(() => { throw new Error("timeout"); })]);
}

async function waitFor(code, timeoutMs = 30000, label = code) {
  step(`waiting for ${label}`);
  const started = Date.now();
  for (;;) {
    const value = await jsWithin(code).catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(100);
  }
}

/* ---- Input ------------------------------------------------------------------ */

const send = (event) => contents.sendInputEvent(event);

async function key(keyCode, modifiers = []) {
  send({ type: "keyDown", keyCode, modifiers });
  send({ type: "keyUp", keyCode, modifiers });
  await sleep(16);
}

function typeChar(character) {
  if (character === "\n") {
    send({ type: "keyDown", keyCode: "Enter" });
    send({ type: "char", keyCode: "\r" });
    send({ type: "keyUp", keyCode: "Enter" });
    return;
  }
  const keyCode = character === " " ? "Space" : character;
  send({ type: "keyDown", keyCode });
  send({ type: "char", keyCode: character });
  send({ type: "keyUp", keyCode });
}

/** Types like a person: ~8-14 characters a second, slower after spaces. */
async function typeText(text, random) {
  for (const character of text) {
    typeChar(character);
    await sleep(55 + random() * 50 + (character === " " ? random() * 90 : 0));
  }
}

async function mouse(type, x, y, extra = {}) {
  send({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, ...extra });
}

async function click(x, y) {
  await mouse("mouseMove", x, y);
  await mouse("mouseDown", x, y);
  await sleep(40);
  await mouse("mouseUp", x, y);
  await sleep(60);
}

async function drag(from, to, steps = 12, stepMs = 25) {
  await mouse("mouseMove", from.x, from.y);
  await mouse("mouseDown", from.x, from.y);
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    await mouse("mouseMove", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    await sleep(stepMs);
  }
  await mouse("mouseUp", to.x, to.y);
  await sleep(60);
}

async function wheel(x, y, deltaY) {
  send({ type: "mouseWheel", x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY, canScroll: true });
}

/** The centre (or a point) of the first element matching `selector`, in window coordinates. */
async function rectOf(selector, filter = "() => true") {
  return js(`(() => {
    const accept = ${filter};
    for (const element of document.querySelectorAll(${JSON.stringify(selector)})) {
      const r = element.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && accept(element, r)) {
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  })()`);
}

/* ---- App steps -------------------------------------------------------------- */

async function signIn() {
  step("loading the app");
  await contents.loadURL(config.url);
  const status = await js(`fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: ${JSON.stringify(config.password)} }) }).then((r) => r.status)`);
  if (status !== 200) throw new Error(`Sign-in failed with HTTP ${status}`);
  await contents.loadURL(config.url);
  await waitFor(`!!document.querySelector(".libera-app-shell")`, 60000, "the app shell");
  await sleep(1500);
}

/** Opens a file with Go to file (⌘P), as a user does. */
async function openFile(libraryPath) {
  await key("p", ["meta"]);
  await waitFor(`!!document.querySelector('input[placeholder^="Go to file"]')`, 10000, "Go to file");
  contents.insertText(libraryPath.split("/").at(-1));
  await sleep(700);
  await key("Enter");
  await waitFor(`!document.querySelector('input[placeholder^="Go to file"]')`, 10000, "the palette to close");
}

async function openNoteVisual() {
  await openFile(config.files.note);
  await waitFor(`!!document.querySelector(".libera-tiptap")`, 30000, "the Visual editor");
}

async function switchNoteToSource() {
  await js(`window.__benchMenuChoice = "editor-source"`);
  const button = await rectOf('button[aria-label="File actions"]');
  if (!button) throw new Error("No File actions button");
  await click(button.x, button.y);
  // The Source editor is the classic textarea unless the CodeMirror one is chosen in Preferences.
  await waitFor(`!!document.querySelector("textarea.markdown-editor-input, .cm-content")`, 30000, "the Source editor");
}

/** Clicks at the end of a paragraph near the middle of the visible editor, so typing lands there. */
async function placeCaret(blockSelector) {
  await js(`(() => {
    const blocks = [...document.querySelectorAll(${JSON.stringify(blockSelector)})].filter((b) => (b.textContent ?? "").length > 80);
    const target = blocks[Math.floor(blocks.length / 2)];
    target?.scrollIntoView({ block: "center" });
  })()`);
  await sleep(600);
  const target = await rectOf(blockSelector, "(element, r) => (element.textContent ?? '').length > 80 && r.top > innerHeight * 0.3");
  if (!target) throw new Error(`No ${blockSelector} to type into`);
  await click(target.right - 6, target.bottom - 8);
  await key("End");
}

const TEXT = [
  "Battery life depends on how much work each keystroke starts across the window. ",
  "We measure the renderer, the GPU and the server while typing at a steady pace. ",
  "Pauses let drafts publish, outlines update and background timers run. ",
  "A selection then extends across this sentence before the caret returns. ",
  "Scrolling a little between sentences keeps the layout honest as well. ",
  "The same text, pauses and gestures are replayed for both versions. ",
];

/* ---- Scenarios -------------------------------------------------------------- */

const scenarios = {
  idle: {
    async setup() { await openFile(config.files.pdf); await sleep(3000); await openNoteVisual(); },
    async run() { await sleep(60000); },
  },

  "idle-background": {
    async setup() { await openFile(config.files.pdf); await sleep(3000); await openNoteVisual(); },
    async run() {
      // Another window takes focus; Libera stays visible behind it, as when the user works in another app.
      const other = new BrowserWindow({ width: 320, height: 200, x: 1100, y: 40, show: true });
      await other.loadURL("about:blank");
      other.focus();
      await sleep(60000);
      other.destroy();
    },
  },

  "visual-typing": {
    async setup() { await openNoteVisual(); await placeCaret(".libera-tiptap > p"); },
    async run() {
      const random = seeded(101);
      for (let index = 0; index < TEXT.length; index += 1) {
        await typeText(TEXT[index], random);
        await sleep(1500 + random() * 1500);
        if (index === 2) {
          // Extend a selection word by word, as a drag or shift-select does.
          for (let step = 0; step < 12; step += 1) await key("Left", ["shift", "alt"]);
          await sleep(1500);
          await key("End");
        }
        if (index === 4) {
          const editor = await rectOf(".libera-tiptap");
          for (let tick = 0; tick < 8; tick += 1) { await wheel(editor.x, Math.min(editor.y, 700), -120); await sleep(120); }
          await sleep(800);
          for (let tick = 0; tick < 8; tick += 1) { await wheel(editor.x, Math.min(editor.y, 700), 120); await sleep(120); }
          await sleep(800);
        }
      }
      await key("Enter");
      await typeText("A new paragraph begins and the outline follows it. ", random);
      await sleep(3000);
    },
  },

  "source-typing": {
    async setup() {
      await openNoteVisual();
      await switchNoteToSource();
      // Into the middle of the source, at the end of a line.
      const input = await rectOf("textarea.markdown-editor-input, .cm-content");
      await click(input.x, input.y);
      await key("End");
    },
    async run() {
      const random = seeded(202);
      for (let index = 0; index < TEXT.length; index += 1) {
        await typeText(TEXT[index], random);
        if (index === 1) { await typeText("See [the notes](", random); await sleep(800); await key("Escape"); await typeText("other.md) and @", random); await sleep(800); await key("Escape"); }
        await sleep(1500 + random() * 1500);
        if (index === 3) {
          const editor = await rectOf("textarea.markdown-editor-input, .cm-scroller");
          for (let tick = 0; tick < 8; tick += 1) { await wheel(editor.x, Math.min(editor.y, 700), -120); await sleep(120); }
          await sleep(800);
          for (let tick = 0; tick < 8; tick += 1) { await wheel(editor.x, Math.min(editor.y, 700), 120); await sleep(120); }
        }
      }
      await sleep(3000);
    },
  },

  "pdf-annotate": {
    async setup() {
      await openFile(config.files.pdf);
      await waitFor(`document.querySelectorAll(".pdf-text-layer span").length > 20`, 60000, "the PDF text layer");
      await sleep(1500);
    },
    async run() {
      const random = seeded(303);
      for (let round = 0; round < 5; round += 1) {
        const page = await rectOf(".pdf-text-layer");
        // Read down the document: a few seconds of steady wheel scrolling.
        for (let tick = 0; tick < 14; tick += 1) { await wheel(page?.x ?? 700, 450, -120); await sleep(300 + random() * 200); }
        await sleep(1500);
        // Highlight a line of text: drag across it, then pick a colour from the selection actions.
        const line = await rectOf(".pdf-text-layer span", "(element, r) => r.width > 160 && r.top > 220 && r.bottom < innerHeight - 160");
        if (line) {
          await drag({ x: line.left + 2, y: line.y }, { x: line.right - 2, y: line.y }, 14, 30);
          await sleep(700);
          const highlight = await rectOf('button[aria-label^="Highlight "]');
          if (highlight) await click(highlight.x, highlight.y);
          await sleep(1500);
        }
        if (round === 2) {
          // A few pen strokes, then back to the select tool.
          await key("p");
          await sleep(300);
          for (let stroke = 0; stroke < 3; stroke += 1) {
            const y = 300 + stroke * 60;
            await drag({ x: 500, y }, { x: 800, y: y + 20 }, 24, 20);
            await sleep(500);
          }
          await key("v");
          await sleep(1000);
        }
      }
      for (const label of ["Zoom in", "Zoom out"]) {
        const button = await rectOf(`button[aria-label="${label}"]`);
        if (button) { await click(button.x, button.y); await sleep(1500); }
      }
      await sleep(2000);
    },
  },

  "latex-typing": {
    async setup() {
      await openFile(config.files.latex);
      await waitFor(`!!document.querySelector(".cm-content")`, 30000, "the LaTeX editor");
      // The compile on open finishes before measuring.
      await waitFor(`!!document.querySelector(".libera-latex-editor, .cm-content") && !document.body.innerText.includes("Compiling your document")`, 120000, "the first compile");
      await sleep(4000);
      // A wrapped paragraph can fill the whole editor, so click a point inside it rather than a line's edge.
      const editor = await rectOf(".cm-content");
      await click(editor.left + 60, 450);
      await key("End");
    },
    async run() {
      const random = seeded(404);
      for (let index = 0; index < 5; index += 1) {
        await typeText(TEXT[index], random);
        // Long enough for an automatic compile to start in either version on mains power.
        await sleep(3500 + random() * 1500);
      }
      await sleep(6000);
    },
  },

  panels: {
    async setup() { await openFile(config.files.pdf); await sleep(3000); await openNoteVisual(); await sleep(1000); },
    async run() {
      // Drag the sidebar edge back and forth, then switch between the two tabs.
      const handle = await rectOf(".cursor-col-resize", "(element, r) => r.left < innerWidth / 2");
      if (handle) {
        for (let pass = 0; pass < 4; pass += 1) {
          await drag({ x: handle.x, y: 400 }, { x: handle.x + 160, y: 400 }, 40, 16);
          await drag({ x: handle.x + 160, y: 400 }, { x: handle.x, y: 400 }, 40, 16);
        }
      }
      await sleep(1000);
      for (let step = 0; step < 10; step += 1) { await key("Tab", ["control"]); await sleep(1200); }
      await sleep(2000);
    },
  },
};

/* ---- Measurement -------------------------------------------------------------- */

async function cdpMetrics() {
  const { metrics } = await contents.debugger.sendCommand("Performance.getMetrics");
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

function cpuByProcess() {
  return new Map(app.getAppMetrics().map((metric) => [metric.pid, { type: metric.type, cpu: metric.cpu.cumulativeCPUUsage ?? 0, wakeups: metric.cpu.idleWakeupsPerSecond }]));
}

async function measure(scenario) {
  const cdpBefore = await cdpMetrics();
  const cpuBefore = cpuByProcess();
  const countersBefore = await js("({ ...window.__benchCounters })");
  requests.clear();
  const wakeupSamples = [];
  const sampler = setInterval(() => {
    let total = 0;
    for (const metric of app.getAppMetrics()) total += metric.cpu.idleWakeupsPerSecond;
    wakeupSamples.push(total);
  }, 1000);
  const start = Date.now();
  emit(`BENCH_START ${start} ${JSON.stringify(app.getAppMetrics().map((metric) => metric.pid))}`);
  await scenario.run();
  const end = Date.now();
  emit(`BENCH_END ${end}`);
  clearInterval(sampler);
  const cdpAfter = await cdpMetrics();
  const cpuAfter = cpuByProcess();
  const countersAfter = await js("({ ...window.__benchCounters })");

  const cpu = {};
  for (const [pid, after] of cpuAfter) {
    const before = cpuBefore.get(pid)?.cpu ?? 0;
    cpu[after.type] = (cpu[after.type] ?? 0) + Math.max(0, after.cpu - before);
  }
  const delta = (name) => (cdpAfter[name] ?? 0) - (cdpBefore[name] ?? 0);
  const wakeups = wakeupSamples.slice(1);
  return {
    durationS: (end - start) / 1000,
    electronCpuS: cpu,
    idleWakeupsPerS: wakeups.length ? wakeups.reduce((sum, value) => sum + value, 0) / wakeups.length : null,
    renderer: {
      taskMs: delta("TaskDuration") * 1000,
      scriptMs: delta("ScriptDuration") * 1000,
      layoutMs: delta("LayoutDuration") * 1000,
      styleMs: delta("RecalcStyleDuration") * 1000,
      layouts: delta("LayoutCount"),
      styleRecalcs: delta("RecalcStyleCount"),
      heapMb: (cdpAfter.JSHeapUsedSize ?? 0) / 1048576,
    },
    appMenuUpdates: countersAfter.appMenuUpdates - countersBefore.appMenuUpdates,
    requests: Object.fromEntries([...requests].sort()),
  };
}

async function main() {
  await app.whenReady();
  session.defaultSession.webRequest.onCompleted({ urls: ["*://*/*"] }, countRequest);
  win = new BrowserWindow({
    width: 1440, height: 900, x: 0, y: 0, show: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: false, sandbox: false, nodeIntegration: false },
  });
  contents = win.webContents;

  const scenario = scenarios[config.scenario];
  if (!scenario) throw new Error(`Unknown scenario ${config.scenario}`);
  await signIn();
  step("setting up the scenario");
  await scenario.setup();
  step("measuring");
  win.focus();
  // Attached only now: loading the app swaps the renderer process, which closes an earlier attachment.
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  await contents.debugger.sendCommand("Performance.enable", { timeDomain: "timeTicks" });
  await sleep(SETTLE_MS);
  const result = await measure(scenario);
  if (config.shotFile) {
    // Evidence that the session did what it says (text typed, highlights made).
    try { fs.writeFileSync(config.shotFile, (await contents.capturePage()).toPNG()); } catch { /* best effort */ }
  }
  emit(`BENCH_RESULT ${JSON.stringify(result)}`);
}

async function fail(error) {
  // What the window showed when it failed, for the orchestrator to keep.
  if (config.failureShot && contents) {
    try { fs.writeFileSync(config.failureShot, (await Promise.race([contents.capturePage(), sleep(3000).then(() => null)]))?.toPNG() ?? Buffer.alloc(0)); } catch { /* best effort */ }
  }
  emit(`BENCH_ERROR ${String(error?.stack ?? error).replace(/\n/g, " | ")}`);
  app.exit(1);
}

// A run that stops making progress fails on its own, with a screenshot, instead of being killed blind.
setTimeout(() => void fail(new Error("Watchdog: no result within the time limit")), config.watchdogMs ?? 210000);

main().then(() => app.exit(0), fail);
