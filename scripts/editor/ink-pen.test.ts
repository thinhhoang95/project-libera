// What a stylus delivers in this Electron, checked with an emulated pen
// (ink-pen-harness.cjs, ink-pen-driver.cjs) since no stylus hardware is
// available yet (docs/ink-plan.md, "Input"). These are the facts ink-input
// relies on; device tuning still needs real hardware.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(__filename);

type ProbeEvent = {
  where: "surface" | "scroller" | "page";
  type: string;
  pointerType: string;
  pointerId: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  buttons: number;
  coalesced: number;
  predicted: number;
  samples: Array<{ pressure: number; tiltX: number; tiltY: number }>;
};

type Report = {
  electron: string;
  features: { coalesced: boolean; predicted: boolean; rawUpdate: boolean; desynchronized: boolean };
  stroke: { sent: Array<{ x: number; y: number; pressure: number; tiltX: number; tiltY: number }>; received: ProbeEvent[]; frameDelays: number[] };
  hover: ProbeEvent[];
  eraserButton: ProbeEvent[];
  mouse: ProbeEvent[];
  touchOnSurface: ProbeEvent[];
  touchScroll: { scrollTop: number; events: ProbeEvent[] };
  penOnScroller: { scrollTop: number; events: ProbeEvent[] };
  palmDuringPen: ProbeEvent[];
};

function electronBinary(): string | null {
  try {
    const binary = require("electron") as unknown as string;
    return typeof binary === "string" && existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

const binary = electronBinary();
const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
let report: Report | null = null;

async function probe(): Promise<Report> {
  if (report) return report;
  const userData = mkdtempSync(path.join(tmpdir(), "libera-ink-pen-"));
  try {
    const env = { ...process.env };
    // Inherited from a parent Electron app (an IDE), these would make the
    // child act as Node or report to the parent's crash handler.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CHROME_CRASHPAD_PIPE_NAME;
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(binary!, [path.join(__dirname, "ink-pen-harness.cjs"), `--user-data-dir=${userData}`], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Electron did not finish.\n${stderr}`));
      }, 90_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(stdout);
      });
    });
    const line = output.split("\n").find((entry) => entry.startsWith("INK_PEN_REPORT "));
    assert.ok(line, `the harness reported: ${output.slice(0, 2000)}`);
    report = JSON.parse(line.slice("INK_PEN_REPORT ".length)) as Report;
    return report;
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

const skip = !binary ? "Electron is not installed" : headless ? "no display" : false;
const options = { skip, timeout: 120_000 };

test("Electron: a pen's pressure and tilt reach pointer events unchanged", options, async () => {
  const { stroke } = await probe();
  // Pressed samples only: the hover before the stroke has no buttons.
  const samples = stroke.received.filter((event) => event.where === "surface" && event.type !== "pointerup" && event.buttons !== 0).flatMap((event) => {
    assert.equal(event.pointerType, "pen");
    return event.samples;
  });
  assert.equal(samples.length, stroke.sent.length, "no sample is lost, however events are grouped into frames");
  samples.forEach((sample, index) => {
    assert.ok(Math.abs(sample.pressure - stroke.sent[index].pressure) < 0.01, `pressure ${sample.pressure} for ${stroke.sent[index].pressure}`);
    assert.equal(sample.tiltX, stroke.sent[index].tiltX);
    assert.equal(sample.tiltY, stroke.sent[index].tiltY);
  });
  assert.equal(stroke.received.filter((event) => event.type === "pointerdown").length, 1);
  assert.equal(stroke.received.at(-1)?.type, "pointerup");
  assert.ok(!stroke.received.some((event) => event.type === "pointercancel"), "a pen stroke on a touch-action: none surface is never cancelled");
});

test("Electron: the features ink-input uses exist in a secure context", options, async () => {
  const { features, stroke } = await probe();
  assert.equal(features.coalesced, true, "getCoalescedEvents");
  assert.equal(features.predicted, true, "getPredictedEvents");
  const moves = stroke.received.filter((event) => event.type === "pointermove");
  assert.ok(moves.every((event) => event.coalesced >= 1), "every move carries its coalesced samples");
  assert.ok(moves.some((event) => event.predicted > 0), "prediction starts once the pen is moving");
  // A desynchronized canvas depends on the GPU; ink-renderer falls back when it is not offered.
  assert.equal(typeof features.desynchronized, "boolean");
});

test("Electron: a hovering pen is seen before it touches", options, async () => {
  const { hover } = await probe();
  assert.ok(hover.length > 0);
  for (const event of hover) {
    assert.equal(event.pointerType, "pen");
    assert.equal(event.type, "pointermove");
    assert.equal(event.buttons, 0);
  }
});

test("Electron: fingers on an ink surface reach it as touch pointers, and a resting palm is a separate pointer", options, async () => {
  const { touchOnSurface, palmDuringPen } = await probe();
  assert.ok(touchOnSurface.length > 2);
  assert.ok(touchOnSurface.every((event) => event.pointerType === "touch"));
  assert.ok(!touchOnSurface.some((event) => event.type === "pointercancel"), "touch-action: none leaves panning to ink-input");

  const palm = palmDuringPen.filter((event) => event.pointerType === "touch");
  const pen = palmDuringPen.filter((event) => event.pointerType === "pen");
  assert.ok(palm.length >= 1 && pen.length > 2, "both the palm and the pen are delivered; rejecting the palm is ink-input's job");
  assert.notEqual(palm[0].pointerId, pen[0].pointerId);
});

test("Electron: outside ink surfaces, fingers and pens both pan the page", options, async () => {
  const { touchScroll, penOnScroller } = await probe();
  // Why ink surfaces must set touch-action: none before a pen touches them
  // (on hover): otherwise the pen scrolls instead of drawing.
  assert.ok(touchScroll.scrollTop > 0, "a finger scrolls a touch-action: auto panel");
  assert.ok(touchScroll.events.some((event) => event.type === "pointercancel"));
  assert.ok(penOnScroller.scrollTop > 0, "an emulated pen scrolls it too");
});

test("Electron: the pen's eraser button cannot be emulated", options, async () => {
  const { eraserButton } = await probe();
  // CDP has no eraser button: buttons: 32 arrives as an ordinary press.
  // Eraser-end handling stays untested until hardware is available.
  assert.ok(eraserButton.length > 0);
  assert.ok(eraserButton.every((event) => (event.buttons & 32) === 0));
});
