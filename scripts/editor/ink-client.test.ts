import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { InkSurface, type InkChange } from "../../src/components/libera/ink/ink-surface";
import { PhotoInkLayer } from "../../src/components/libera/ink/photo-ink-layer";
import { InkWriter, useInkDocument } from "../../src/components/libera/ink/use-ink-document";
import { pendingSaves, unsavedJournal, resetPendingSavesForTests } from "../../src/components/libera/pending-saves";
import { inkTools } from "../../src/components/libera/ink/use-ink-tools";
import { emptyInkAuthorFile, encodeInkSamples, sampleBounds } from "../../src/lib/ink/codec";
import { InkHistory } from "../../src/lib/ink/history";
import { applyInkOps } from "../../src/lib/ink/merge";
import { IDENTITY_PHOTO_VIEW } from "../../src/lib/ink/frame";
import type { InkOps, InkStroke } from "../../src/lib/ink/types";

const frame = { unit: "px" as const, width: 720, height: 240 };
const samples = [{ x: 10, y: 10, pressure: 0.5 }, { x: 50, y: 20, pressure: 0.5 }];
const mark: InkStroke = {
  id: "client1", brush: "pen", color: "#000000", opacity: 1, width: 2, lineStyle: "solid",
  points: encodeInkSamples(samples), bounds: sampleBounds(samples), createdAt: "2026-10-25T00:00:00Z",
};

test("the recovery journal keeps a save batch separate from edits made while it is in flight", async (t) => {
  resetPendingSavesForTests();
  const target = { path: "Notes/in-flight.md", chunk: "block-client1", frame };
  let fail!: (error: Error) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((_resolve, reject) => { fail = reject; }));
  const writer = new InkWriter(target);
  writer.push({ add: [mark] });
  const saving = assert.rejects(writer.save(), /offline/);
  writer.push({ erase: [mark.id] });
  const kept = await unsavedJournal.get<{ retry: InkOps; pending: InkOps }>(target.path, "ink:block-client1");
  assert.deepEqual(kept?.retry.add, [mark], "a crash before the response must retain the sent batch");
  assert.deepEqual(kept?.pending.erase, [mark.id], "Undo is replayed after that batch");
  fail(new Error("offline"));
  await saving;
  writer.discard();
});

test("recovery retries the exact saved frame before a newer resize", async (t) => {
  resetPendingSavesForTests();
  const target = { path: "Notes/resize.md", chunk: "block-client1", frame: { ...frame, height: 300 } };
  let fail!: (error: Error) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((_resolve, reject) => { fail = reject; }));
  const writer = new InkWriter(target);
  writer.markFrame();
  const saving = assert.rejects(writer.save(), /offline/);
  writer.setTarget({ ...target, frame: { ...frame, height: 400 } });
  writer.markFrame();
  fail(new Error("offline"));
  await saving;
  const kept = await unsavedJournal.get<Parameters<InkWriter["restore"]>[0]>(target.path, "ink:block-client1");
  const restored = new InkWriter({ ...target, frame: { ...frame, height: 400 } });
  restored.restore(kept!);
  const heights: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    heights.push(body.frame.height);
    return Response.json({ path: target.path, author: "aaaaaa", chunks: [{ chunk: target.chunk, frame: body.frame, strokes: [], revision: heights.length }] });
  });
  await restored.save();
  assert.deepEqual(heights, [300, 400]);
  writer.discard();
});

test("discard during a failing Save cannot resurrect the discarded ink", async (t) => {
  resetPendingSavesForTests();
  let fail!: (error: Error) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>((_resolve, reject) => { fail = reject; }));
  const target = { path: "Notes/discard.md", chunk: "block-client1", frame };
  const writer = new InkWriter(target);
  writer.push({ add: [mark] });
  const saving = assert.rejects(writer.save(), /offline/);
  writer.discard();
  fail(new Error("offline"));
  await saving;
  assert.equal(writer.idle, true);
  assert.equal(pendingSaves.isDirty(target.path), false);
  assert.equal(await unsavedJournal.get(target.path, "ink:block-client1"), null);
});

async function withDom(run: (container: HTMLElement) => Promise<void>) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const replacements = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  try { await run(dom.window.document.getElementById("root")!); }
  finally {
    for (const key of Object.keys(replacements)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

test("a lost save response is retried before newer changes, even when they cancel the saved operation", async () => {
  const originalFetch = globalThis.fetch;
  const originalChannel = globalThis.BroadcastChannel;
  let channels = 0;
  globalThis.BroadcastChannel = class {
    constructor() { channels += 1; }
    postMessage() {}
    close() { channels -= 1; }
  } as unknown as typeof BroadcastChannel;
  let file = emptyInkAuthorFile({ key: "aaaaaa" }, frame);
  let attempts = 0;
  let responseLost!: () => void;
  const lost = new Promise<void>((resolve) => { responseLost = resolve; });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { ops: InkOps };
    file = applyInkOps(file, body.ops);
    attempts += 1;
    if (attempts === 1) {
      await lost;
      throw new Error("response lost after the server wrote the stroke");
    }
    return Response.json({ path: "Notes/a.md", author: "aaaaaa", chunks: [{ chunk: "block-client1", frame, strokes: file.strokes.map((stroke) => ({ stroke, author: "aaaaaa" })), revision: file.revision }] });
  };
  const writer = new InkWriter({ path: "Notes/a.md", chunk: "block-client1", frame });
  try {
    writer.push({ add: [mark] });
    const saving = writer.save();
    writer.push({ erase: [mark.id] });
    responseLost();
    await assert.rejects(saving, /response lost/);
    await writer.save();
    assert.equal(file.strokes.length, 0, "Undo reaches disk even if the first save's response was lost");
    assert.equal(writer.idle, true);
    assert.equal(channels, 0, "save broadcasts close their channels");
  } finally {
    writer.discard();
    globalThis.fetch = originalFetch;
    globalThis.BroadcastChannel = originalChannel;
  }
});

test("ink is written only on Save; a failed Save keeps it for the next, and closing writes nothing", async () => withDom(async (container) => {
  const originalFetch = globalThis.fetch;
  let patches = 0;
  const payload = { path: "Notes/a.md", author: "aaaaaa", chunks: [{ chunk: "block-client1", frame, strokes: [], revision: 0 }] };
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH" && ++patches === 1) throw new Error("temporarily offline");
    return Response.json(payload);
  };
  let ink!: ReturnType<typeof useInkDocument>;
  function Harness() {
    ink = useInkDocument({ path: "Notes/a.md", chunk: "block-client1", frame });
    return null;
  }
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { ink.change({ add: [mark], removed: [] }); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(patches, 0, "drawing alone writes nothing");
    assert.equal(pendingSaves.isDirty("Notes/a.md"), true, "the file counts as unsaved");
    await act(async () => { await assert.rejects(ink.save(), /offline/); });
    assert.equal(pendingSaves.isDirty("Notes/a.md"), true, "a failed Save keeps the changes");
    await act(async () => { await ink.save(); });
    assert.equal(patches, 2);
    assert.equal(pendingSaves.isDirty("Notes/a.md"), false);
    await act(async () => { ink.change({ add: [{ ...mark, id: "client2" }], removed: [] }); });
    await act(async () => { root.unmount(); });
    assert.equal(patches, 2, "closing the view writes nothing; the change waits in the recovery journal");
    assert.equal(pendingSaves.isDirty("Notes/a.md"), true, "and still counts as unsaved");
    pendingSaves.discard("Notes/a.md");
    assert.equal(pendingSaves.isDirty("Notes/a.md"), false, "Close without saving drops it");
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test("a reload started before a save cannot replace the newly saved ink with an older response", async () => withDom(async (container) => {
  const originalFetch = globalThis.fetch;
  const empty = { path: "Notes/a.md", author: "aaaaaa", chunks: [{ chunk: "block-client1", frame, strokes: [], revision: 0 }] };
  const saved = { ...empty, chunks: [{ ...empty.chunks[0], strokes: [{ stroke: mark, author: "aaaaaa" }], revision: 1 }] };
  let gets = 0;
  let finishReload!: (response: Response) => void;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") return Response.json(saved);
    if (++gets === 1) return Response.json(empty);
    if (gets === 2) return new Promise<Response>((resolve) => { finishReload = resolve; });
    return Response.json(saved);
  };
  let ink!: ReturnType<typeof useInkDocument>;
  function Harness() {
    ink = useInkDocument({ path: "Notes/a.md", chunk: "block-client1", frame });
    return null;
  }
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    const reload = ink.reload();
    await act(async () => { ink.change({ add: [mark], removed: [] }); });
    await act(async () => { await ink.save(); });
    await act(async () => { finishReload(Response.json(empty)); await reload; });
    assert.deepEqual(ink.strokes.map((item) => item.stroke.id), [mark.id]);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
  }
}));

test("a note saves unmounted ink blocks, and remounting during Save reuses the writer", async (t) => withDom(async (container) => {
  resetPendingSavesForTests();
  const path = "Notes/unmounted.md";
  const payload = { path, author: "aaaaaa", chunks: [{ chunk: "block-client1", frame, strokes: [], revision: 0 }] };
  let current: { path: string; author: string; chunks: Array<{ chunk: string; frame: typeof frame; strokes: Array<{ stroke: InkStroke; author: string }>; revision: number }> } = payload;
  let finish!: (response: Response) => void;
  let patches = 0;
  let sentHeight = 0;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      patches += 1;
      sentHeight = JSON.parse(String(init.body)).frame.height;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    return Response.json(current);
  });
  let ink!: ReturnType<typeof useInkDocument>;
  function Harness() { ink = useInkDocument({ path, chunk: "block-client1", frame }); return null; }
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { ink.change({ add: [mark], removed: [] }); });
    await act(async () => { ink.setHeight(420); });
    await act(async () => { root.render(null); });
    const saving = pendingSaves.save(path);
    assert.equal(patches, 1, "Save still reaches the ink after switching to Markdown source mode");
    assert.equal(sentHeight, 420);
    await act(async () => { root.render(createElement(Harness)); });
    assert.deepEqual(ink.strokes.map((item) => item.stroke.id), [mark.id]);
    assert.equal(ink.frame.height, 420, "a remount retains the unsaved resize too");
    await act(async () => {
      current = { ...payload, chunks: [{ ...payload.chunks[0], frame: { ...frame, height: 420 }, strokes: [{ stroke: mark, author: "aaaaaa" }], revision: 1 }] };
      finish(Response.json(current));
      await saving;
    });
    assert.equal(pendingSaves.isDirty(path), false, "a remount does not replay the batch after it succeeds");
    assert.deepEqual(ink.strokes.map((item) => item.stroke.id), [mark.id]);
  } finally { await act(async () => { root.unmount(); }); }
}));

test("a focus reload overtaking the initial photo load still recovers its unsaved ink once", async (t) => withDom(async (container) => {
  resetPendingSavesForTests();
  const id = "aaaaaa-bbbbbb";
  const payload = { path: id, author: "aaaaaa", chunks: [{ chunk: "photo", frame, strokes: [], revision: 0 }], photo: { original: frame, view: IDENTITY_PHOTO_VIEW, viewSize: frame, changed: false } };
  unsavedJournal.put(`gallery:${id}`, "ink:photo", { retry: null, pending: { add: [mark] }, resized: false, frame });
  let first!: (response: Response) => void;
  let gets = 0;
  t.mock.method(globalThis, "fetch", async () => ++gets === 1 ? new Promise<Response>((resolve) => { first = resolve; }) : Response.json(payload));
  let ink!: ReturnType<typeof useInkDocument>;
  function Harness() { ink = useInkDocument({ path: id, photoId: id, chunk: "photo", frame }); return null; }
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { await ink.reload(); });
    await act(async () => { first(Response.json(payload)); });
    assert.deepEqual(ink.strokes.map((item) => item.stroke.id), [mark.id]);
    assert.ok(ink.photo, "a recovered photo still has its coordinate view");
    await act(async () => { ink.change({ add: [], removed: [{ stroke: mark, author: "aaaaaa" }] }); });
    assert.equal(pendingSaves.isDirty(`gallery:${id}`), false);
    await act(async () => { await ink.reload(); });
    assert.deepEqual(ink.strokes, [], "a later reload does not apply recovery again");
  } finally { await act(async () => { root.unmount(); }); pendingSaves.discard(`gallery:${id}`); }
}));

test("Discard ink on a changed photo clears unsaved operations as well as the saved layer", async (t) => withDom(async (container) => {
  resetPendingSavesForTests();
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  const replacements = { ResizeObserver: class { observe() {} disconnect() {} }, IntersectionObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} };
  for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    for (const name of Object.keys(replacements)) {
      if (originals[name]) Object.defineProperty(globalThis, name, originals[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const canvas = new Proxy({}, { get: (_target, key) => key === "then" ? undefined : () => {} });
  t.mock.method(window.HTMLCanvasElement.prototype, "getContext", () => canvas as CanvasRenderingContext2D);
  const id = "aaaaaa-discard";
  const path = `gallery:${id}`;
  unsavedJournal.put(path, "ink:photo", { retry: null, pending: { add: [mark] }, resized: false, frame });
  let discarded = false;
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") discarded = true;
    return Response.json({ path: id, author: "aaaaaa", chunks: [{ chunk: "photo", frame, strokes: [], revision: 0 }], photo: { original: frame, view: IDENTITY_PHOTO_VIEW, viewSize: frame, changed: !discarded } });
  });
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(PhotoInkLayer, { photoId: id, version: "1", drawing: false, toolbarSlot: null, onPan() {}, onEdited() {} })); });
    const discard = [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard ink");
    assert.ok(discard);
    await act(async () => { discard.click(); });
    assert.equal(discarded, true);
    assert.equal(pendingSaves.isDirty(path), false);
    assert.equal(await unsavedJournal.get(path, "ink:photo"), null, "a later Save cannot bring back discarded strokes");
  } finally { await act(async () => { root.unmount(); }); pendingSaves.discard(path); }
}));

test("a partial eraser reports only strokes that existed before each change", async (context) => withDom(async (container) => {
  const property = (target: object, key: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else Reflect.deleteProperty(target, key);
    });
  };
  const globals = {
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    Path2D: class { moveTo() {} lineTo() {} quadraticCurveTo() {} closePath() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const [key, value] of Object.entries(globals)) property(globalThis, key, value);
  const canvas = new Proxy({}, { get: (_target, key) => key === "then" ? undefined : () => {} });
  context.mock.method(window.HTMLCanvasElement.prototype, "getContext", () => canvas as CanvasRenderingContext2D);
  context.mock.getter(window.HTMLElement.prototype, "clientWidth", () => 720);
  context.mock.getter(window.HTMLElement.prototype, "clientHeight", () => 240);
  context.mock.method(window.HTMLElement.prototype, "getBoundingClientRect", () => ({ left: 0, top: 0, width: 720, height: 240 }) as DOMRect);
  const captures = new Set<number>();
  property(window.HTMLElement.prototype, "setPointerCapture", (id: number) => { captures.add(id); });
  property(window.HTMLElement.prototype, "hasPointerCapture", (id: number) => captures.has(id));
  property(window.HTMLElement.prototype, "releasePointerCapture", (id: number) => { captures.delete(id); });
  const points = [{ x: 10, y: 80, pressure: 0.5 }, { x: 300, y: 80, pressure: 0.5 }];
  const original = { ...mark, points: encodeInkSamples(points), bounds: sampleBounds(points) };
  let file = applyInkOps(emptyInkAuthorFile({ key: "aaaaaa" }, frame), { add: [original] });
  const history = new InkHistory("aaaaaa");
  const changes: InkChange[] = [];
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(InkSurface, {
      frame, strokes: [{ stroke: original, author: "aaaaaa" }],
      tools: { ...inkTools.get(), tool: "eraser", eraserMode: "partial", eraserRadius: 8 },
      mouseDraws: true,
      onChange(change) {
        changes.push(change);
        history.record({ added: change.add, removed: change.removed.map((item) => ({ ...item, author: "aaaaaa" })), gesture: change.gesture });
        file = applyInkOps(file, { add: change.add, erase: change.removed.map((item) => item.stroke.id) });
      },
    })); });
    const surface = container.firstElementChild!;
    const pointer = (type: string, x: number) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: 80 });
      surface.dispatchEvent(event);
    };
    await act(async () => { pointer("pointerdown", 100); pointer("pointermove", 170); pointer("pointerup", 170); });
    const existing = new Set([original.id]);
    for (const change of changes) {
      for (const item of change.removed) {
        assert.ok(existing.delete(item.stroke.id), "temporary fragments are not undo restorations");
      }
      for (const stroke of change.add) existing.add(stroke.id);
    }
    const erased = file.strokes.map((stroke) => stroke.id).sort();
    file = applyInkOps(file, history.undo()!);
    assert.deepEqual(file.strokes.map((stroke) => stroke.id), [original.id]);
    file = applyInkOps(file, history.redo()!);
    assert.deepEqual(file.strokes.map((stroke) => stroke.id).sort(), erased);
  } finally {
    await act(async () => { root.unmount(); });
    context.mock.restoreAll();
  }
}));

test("unsaved ink follows its note through a move, open or unmounted, with its block's rendering", async () => withDom(async (container) => {
  resetPendingSavesForTests();
  const originalFetch = globalThis.fetch;
  const patches: Array<{ path: string; rendering?: string }> = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { path: string; rendering?: string };
      patches.push({ path: body.path, rendering: body.rendering });
    }
    return Response.json({ path: "Notes/a.md", author: "aaaaaa", chunks: [{ chunk: "block-movetest1", frame, strokes: [], revision: 0 }] });
  };
  const sources = { "_assets/a/ink-movetest1.svg": "_assets/Other/b/ink-movetest1.svg" };
  let ink!: ReturnType<typeof useInkDocument>;
  function Harness({ path, rendering }: { path: string; rendering: string }) {
    ink = useInkDocument({ path, chunk: "block-movetest1", frame, rendering });
    return null;
  }
  const root = createRoot(container);
  try {
    // An open view: the note is moved to another notebook, as retargetOpenTab does.
    await act(async () => { root.render(createElement(Harness, { path: "Notes/a.md", rendering: "_assets/a/ink-movetest1.svg" })); });
    await act(async () => { ink.change({ add: [mark], removed: [] }); });
    await act(async () => {
      pendingSaves.moveUnsaved("Notes/a.md", "Other/b.md", { sources });
      root.render(createElement(Harness, { path: "Other/b.md", rendering: sources["_assets/a/ink-movetest1.svg"] }));
    });
    assert.equal(pendingSaves.isDirty("Notes/a.md"), false, "nothing is left at the old path");
    assert.equal(pendingSaves.isDirty("Other/b.md"), true);
    assert.equal(await unsavedJournal.get("Notes/a.md", "ink:block-movetest1"), null);
    assert.ok(await unsavedJournal.get("Other/b.md", "ink:block-movetest1"), "the recovery record moved");
    await act(async () => { await ink.save(); });
    assert.deepEqual(patches.at(-1), { path: "Other/b.md", rendering: "_assets/Other/b/ink-movetest1.svg" });

    // An unmounted view (source mode): its retained writer follows a rename too.
    await act(async () => { ink.change({ add: [{ ...mark, id: "moved2" }], removed: [] }); });
    await act(async () => { root.unmount(); });
    pendingSaves.moveUnsaved("Other/b.md", "Other/c.md");
    assert.equal(pendingSaves.isDirty("Other/c.md"), true);
    await pendingSaves.save("Other/c.md");
    assert.deepEqual(patches.at(-1), { path: "Other/c.md", rendering: "_assets/Other/b/ink-movetest1.svg" }, "a rename in one notebook keeps the asset source");
    assert.equal(pendingSaves.isDirty("Other/c.md"), false);
  } finally {
    globalThis.fetch = originalFetch;
    resetPendingSavesForTests();
  }
}));

test("renaming a folder moves the recovery records of files under it, and only those", () => {
  resetPendingSavesForTests();
  unsavedJournal.put("Notes/Papers/a.pdf", "annotations:pdf", ["kept"]);
  unsavedJournal.put("Notes/Papers 2/b.pdf", "annotations:pdf", ["other folder"]);
  pendingSaves.moveUnsaved("Notes/Papers", "Notes/Reading", { prefix: true });
  return (async () => {
    assert.deepEqual(await unsavedJournal.get("Notes/Reading/a.pdf", "annotations:pdf"), ["kept"]);
    assert.equal(await unsavedJournal.get("Notes/Papers/a.pdf", "annotations:pdf"), null);
    assert.equal(pendingSaves.isDirty("Notes/Reading/a.pdf"), true);
    assert.deepEqual(await unsavedJournal.get("Notes/Papers 2/b.pdf", "annotations:pdf"), ["other folder"], "a sibling with a similar name stays");
    resetPendingSavesForTests();
  })();
});
