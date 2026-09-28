import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, Profiler, StrictMode, useRef } from "react";
import { MarkdownTextWidth } from "../../src/components/libera/markdown-text-width";
import { MarkdownDisplayPreferencesProvider, useMarkdownDisplayPreferences } from "../../src/components/libera/markdown-display-preferences";

test("shared display preferences restore on reopen and dragging queues one CSS update without React commits or saves", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const { createRoot } = await import("react-dom/client");
  const oldFetch = globalThis.fetch;
  let saved = { textWidth: 60, textScale: 120 }, writes = 0, commits = 0;
  globalThis.fetch = async (_url, init) => {
    saved = JSON.parse(String(init?.body)); writes++;
    return Response.json(saved);
  };
  let settings!: ReturnType<typeof useMarkdownDisplayPreferences>;
  function Canvas() {
    const canvasRef = useRef<HTMLDivElement>(null);
    settings = useMarkdownDisplayPreferences();
    return createElement("div", null,
      createElement(MarkdownTextWidth, { canvasRef }),
      createElement("div", { ref: canvasRef, id: "canvas" }, "Document content"));
  }
  const root = createRoot(document.getElementById("root")!);
  const render = async () => act(async () => root.render(createElement(StrictMode, null,
    createElement(Profiler, { id: "width", onRender: () => commits++ },
      createElement(MarkdownDisplayPreferencesProvider, { initialPreferences: saved }, createElement(Canvas))))));
  const fire = (input: HTMLInputElement, value: number) => {
    input.value = String(value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  try {
    window.localStorage.setItem("libera.markdown.text-width", "20");
    await render();
    let input = document.querySelector("input")!;
    let canvas = document.getElementById("canvas")!;
    assert.equal(input.value, "60", "Disk preferences override old browser-only settings");
    assert.equal(settings.preferences.textScale, 120);
    assert.equal(canvas.style.getPropertyValue("--markdown-text-width"), "0.6");
    commits = 0;
    await act(async () => { for (let width = 1; width <= 100; width++) fire(input, width); });
    assert.equal(frames.size, 1);
    assert.equal(commits, 0, "Dragging must not reconcile the document or slider");
    assert.equal(writes, 0, "No persistence work during dragging");
    await act(async () => {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(0));
    });
    assert.equal(canvas.style.getPropertyValue("--markdown-text-width"), "1");
    assert.equal(input.getAttribute("aria-valuetext"), "Full width");
    await act(async () => input.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true })));
    assert.deepEqual(saved, { textWidth: 100, textScale: 120, outlineExpansionLevel: 6 });
    assert.equal(writes, 1);

    await act(async () => {
      for (let scale = 75; scale <= 150; scale += 5) settings.updatePreferences({ textScale: scale });
    });
    assert.equal(writes, 1, "Scale updates are debounced");
    await act(async () => settings.flushPreferences());
    assert.deepEqual(saved, { textWidth: 100, textScale: 150, outlineExpansionLevel: 6 });
    assert.equal(writes, 2);
    await act(async () => root.render(null));
    await render();
    input = document.querySelector("input")!;
    canvas = document.getElementById("canvas")!;
    assert.equal(input.value, "100");
    assert.equal(settings.preferences.textScale, 150);
    assert.equal(canvas.style.getPropertyValue("--markdown-text-width"), "1");
    await act(async () => {
      fire(input, 0);
      input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Home", bubbles: true }));
    });
    assert.equal(frames.size, 0);
    assert.equal(saved.textWidth, 0, "Zero width is retained, not treated as missing");
    await act(async () => fire(input, 50));
    await act(async () => root.render(null));
    assert.equal(frames.size, 0, "Unmount cancels pending CSS work");
    saved = { textWidth: 999, textScale: -50 };
    await render();
    assert.equal(document.querySelector("input")!.value, "100");
    assert.equal(settings.preferences.textScale, 75);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    dom.window.close();
  }
});

test("legacy width migrates once, failed saves can retry, and pagehide flushes pending scale", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.setItem("libera.markdown.text-width", "44");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const oldFetch = globalThis.fetch;
  let fail = true, writes = 0;
  let saved: unknown;
  globalThis.fetch = async (_url, init) => {
    writes++;
    if (fail) return Response.json({ error: "Disk unavailable" }, { status: 500 });
    saved = JSON.parse(String(init?.body));
    return Response.json(saved);
  };
  let settings!: ReturnType<typeof useMarkdownDisplayPreferences>;
  function Consumer() { settings = useMarkdownDisplayPreferences(); return null; }
  try {
    await act(async () => root.render(createElement(MarkdownDisplayPreferencesProvider, null, createElement(Consumer))));
    assert.equal(settings.preferences.textWidth, 44);
    await act(async () => settings.flushPreferences());
    assert.equal(writes, 1);
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Could not save/);
    fail = false;
    await act(async () => document.querySelector("button")!.click());
    assert.equal(writes, 2);
    assert.deepEqual(saved, { textWidth: 44, textScale: 100, outlineExpansionLevel: 6 });
    assert.equal(document.querySelector('[role="alert"]'), null);
    await act(async () => settings.updatePreferences({ textScale: 125 }));
    assert.equal(writes, 2);
    await act(async () => window.dispatchEvent(new dom.window.Event("pagehide")));
    assert.deepEqual(saved, { textWidth: 44, textScale: 125, outlineExpansionLevel: 6 });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    dom.window.close();
  }
});
