import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { InkWriter } from "../../src/components/libera/ink/use-ink-document";
import { createAnnotationWriter } from "../../src/components/libera/use-annotation-writer";
import { useFlushWhenEditingEnds, useSegmentDraft, type SegmentDraft } from "../../src/components/libera/audio/editable-lines";
import { flushJournal, pendingSaves, resetPendingSavesForTests, unsavedJournal } from "../../src/components/libera/pending-saves";
import { encodeInkSamples, sampleBounds } from "../../src/lib/ink/codec";
import type { InkStroke } from "../../src/lib/ink/types";
import type { TranscriptSegment } from "../../src/lib/transcription/types";

// The renderer-side tests of the 2026-11-25 file-moving review (package W1). They touch no notebook on disk, so
// there is nothing for assertNotebookSound to check: every assertion is on what each writer sends and keeps.

const frame = { unit: "px" as const, width: 720, height: 240 };
const samples = [{ x: 10, y: 10, pressure: 0.5 }, { x: 50, y: 20, pressure: 0.5 }];
const mark: InkStroke = {
  id: "w1stroke", brush: "pen", color: "#000000", opacity: 1, width: 2, lineStyle: "solid",
  points: encodeInkSamples(samples), bounds: sampleBounds(samples), createdAt: "2026-11-25T00:00:00Z",
};

const abortable = (init: RequestInit | undefined, onAbort: () => Error = () => new DOMException("aborted", "AbortError")) =>
  new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(onAbort())));

// ---- U-C1 ------------------------------------------------------------------------------------------------

test("U-C1: a batch in flight when the file moves is retried at the new path, never the old one", async (t) => {
  resetPendingSavesForTests();
  const sent: string[] = [];
  let failFirst!: (error: Error) => void;
  t.mock.method(globalThis, "fetch", (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string };
    sent.push(body.path);
    if (sent.length === 1) return new Promise<Response>((_resolve, reject) => { failFirst = reject; });
    return Promise.resolve(Response.json({ path: body.path, author: "aaaaaa", chunks: [{ chunk: "block-w1", frame, strokes: [], revision: 2 }] }));
  });
  const writer = new InkWriter({ path: "Old/a.md", chunk: "block-w1", frame });
  pendingSaves.register("Old/a.md", "ink:block-w1", { dirty: false, save: () => writer.save(), writer, retarget: (path, sources) => writer.retarget(path, sources) });
  writer.push({ add: [mark] });
  const saving = assert.rejects(writer.save(), /gone/);
  assert.deepEqual(sent, ["Old/a.md"]);
  // The move commits while the PATCH is still in flight; the request then fails (the file is no longer there).
  pendingSaves.moveUnsaved("Old/a.md", "New/a.md");
  failFirst(new Error("gone"));
  await saving;
  // The batch waiting to be sent again is aimed at the new path, and so is everything after it.
  writer.push({ erase: [mark.id] });
  await writer.save();
  assert.deepEqual(sent.slice(1), ["New/a.md", "New/a.md"], "nothing may be written to the old path after the retarget");
  assert.equal(pendingSaves.isDirty("Old/a.md"), false);
  assert.equal(await unsavedJournal.get("Old/a.md", "ink:block-w1"), null);
  writer.discard();
});

// ---- U-M4 ------------------------------------------------------------------------------------------------

test("U-M4: an annotation save in flight when the file moves is dropped and sent again to the new path", async (t) => {
  resetPendingSavesForTests();
  const originalChannel = globalThis.BroadcastChannel;
  const channels: string[] = [];
  globalThis.BroadcastChannel = class {
    constructor(name: string) { channels.push(name); }
    postMessage() {}
    close() {}
  } as unknown as typeof BroadcastChannel;
  const requests: { path: string; signal?: AbortSignal | null }[] = [];
  t.mock.method(globalThis, "fetch", (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string; annotations: unknown[] };
    requests.push({ path: body.path, signal: init?.signal });
    // The first request is still running when the move commits; this one would answer (late) as a success.
    if (requests.length === 1) return abortable(init);
    return Promise.resolve(Response.json({ annotations: body.annotations }));
  });
  try {
    const saved: unknown[][] = [];
    const writer = createAnnotationWriter<{ id: string }>("pdf", "Old/a.pdf");
    writer.setCallbacks({ onSaved: (list) => saved.push(list), onError: () => undefined });
    pendingSaves.register("Old/a.pdf", "annotations:pdf", { dirty: false, save: () => writer.save(), writer, retarget: (path) => writer.retarget(path) });
    writer.schedule([{ id: "n1" }]);
    const saving = writer.save();
    pendingSaves.moveUnsaved("Old/a.pdf", "New/a.pdf");
    await saving;
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.path), ["Old/a.pdf", "New/a.pdf"]);
    assert.equal(requests[0].signal?.aborted, true, "the request aimed at the old path is cancelled");
    assert.equal(writer.dirty, false, "the second request saved the annotations");
    assert.deepEqual(channels, ["libera-annotations:pdf:New/a.pdf"], "nothing is broadcast for the old path");
    assert.equal(pendingSaves.isDirty("Old/a.pdf"), false);
    assert.equal(pendingSaves.isDirty("New/a.pdf"), false);
    assert.equal(saved.length, 1);
  } finally {
    globalThis.BroadcastChannel = originalChannel;
  }
});

test("U-M4: a success that answers after the move does not clear the unsaved annotations", async (t) => {
  resetPendingSavesForTests();
  const originalChannel = globalThis.BroadcastChannel;
  const channels: string[] = [];
  globalThis.BroadcastChannel = class {
    constructor(name: string) { channels.push(name); }
    postMessage() {}
    close() {}
  } as unknown as typeof BroadcastChannel;
  let answer!: (response: Response) => void;
  const paths: string[] = [];
  // A server that ignores the abort: the old request still completes as a success.
  t.mock.method(globalThis, "fetch", (_url: string | URL | Request, init?: RequestInit) => {
    paths.push((JSON.parse(String(init?.body)) as { path: string }).path);
    if (paths.length === 1) return new Promise<Response>((resolve) => { answer = resolve; });
    return Promise.resolve(Response.json({ annotations: [{ id: "n1" }] }));
  });
  try {
    const writer = createAnnotationWriter<{ id: string }>("pdf", "Old/b.pdf");
    writer.schedule([{ id: "n1" }]);
    const saving = writer.save();
    writer.retarget("New/b.pdf");
    answer(Response.json({ annotations: [{ id: "n1" }] }));
    await saving;
    assert.deepEqual(paths, ["Old/b.pdf", "New/b.pdf"], "the annotations still reach the new path");
    assert.equal(channels.includes("libera-annotations:pdf:Old/b.pdf"), false);
  } finally {
    globalThis.BroadcastChannel = originalChannel;
  }
});

// ---- U-H2 ------------------------------------------------------------------------------------------------

type Stored = { id: string; path: string; key: string; data: unknown; at: number };

/** A small asynchronous IndexedDB: every request answers on a later turn, as the real one does. */
function installFakeIndexedDb(initial: Stored[]) {
  const data = new Map(initial.map((record) => [record.id, record]));
  const later = (run: () => void) => setTimeout(run, 0);
  const store = {
    put: (record: Stored) => { data.set(record.id, record); },
    delete: (id: string) => { data.delete(id); },
    getAll() {
      const request: { result?: Stored[]; onsuccess?: () => void } = {};
      later(() => { request.result = [...data.values()]; request.onsuccess?.(); });
      return request;
    },
    get(id: string) {
      const request: { result?: Stored; onsuccess?: () => void } = {};
      later(() => { request.result = data.get(id); request.onsuccess?.(); });
      return request;
    },
    createIndex: () => undefined,
  };
  const database = {
    transaction() {
      const transaction: { objectStore: () => typeof store; oncomplete?: () => void } = { objectStore: () => store };
      later(() => transaction.oncomplete?.());
      return transaction;
    },
    createObjectStore: () => store,
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open() { const request: { result: unknown; onsuccess?: () => void } = { result: database }; later(() => request.onsuccess?.()); return request; } },
  });
  return {
    data,
    restore() { if (previous) Object.defineProperty(globalThis, "indexedDB", previous); else Reflect.deleteProperty(globalThis, "indexedDB"); },
  };
}

const stored = (path: string, key: string, data: unknown): Stored => ({ id: `${path}\u0000${key}`, path, key, data, at: 1 });

test("U-H2: a swap moves recovery records not yet read from IndexedDB without orphaning a staging record", async () => {
  const fake = installFakeIndexedDb([stored("N/a.pdf", "annotations:pdf", "from-a"), stored("N/b.pdf", "annotations:pdf", "from-b")]);
  try {
    resetPendingSavesForTests();
    await pendingSaves.moveUnsavedMany([{ from: "N/a.pdf", to: "N/b.pdf" }, { from: "N/b.pdf", to: "N/a.pdf" }]);
    assert.equal(await unsavedJournal.get("N/a.pdf", "annotations:pdf"), "from-b");
    assert.equal(await unsavedJournal.get("N/b.pdf", "annotations:pdf"), "from-a");
    await flushJournal();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const ids = [...fake.data.keys()];
    assert.deepEqual(ids.filter((id) => id.includes("moving-")), [], "no staging record is left behind");
    assert.equal(ids.length, 2);
    assert.equal(fake.data.get("N/a.pdf\u0000annotations:pdf")?.data, "from-b");
    assert.equal(fake.data.get("N/b.pdf\u0000annotations:pdf")?.data, "from-a");
  } finally {
    resetPendingSavesForTests();
    fake.restore();
  }
});

test("U-H2: a view that unmounts after its file moved is unregistered from the new path", () => {
  resetPendingSavesForTests();
  const unregister = pendingSaves.register("Old/c.pdf", "annotations:pdf", { dirty: false, save: async () => undefined, writer: { id: "w" }, retarget: () => undefined });
  pendingSaves.moveUnsaved("Old/c.pdf", "New/c.pdf");
  assert.ok(pendingSaves.getWriter("New/c.pdf", "annotations:pdf"));
  unregister();
  assert.equal(pendingSaves.getWriter("New/c.pdf", "annotations:pdf"), undefined, "a clean view that unmounted leaves the registry");
  // A dirty one stays for Save, and leaves when it is saved: it is no longer mounted.
  const again = pendingSaves.register("Old/d.pdf", "annotations:pdf", { dirty: true, save: async () => undefined, writer: { id: "w" }, retarget: () => undefined });
  pendingSaves.moveUnsaved("Old/d.pdf", "New/d.pdf");
  again();
  assert.ok(pendingSaves.getWriter("New/d.pdf", "annotations:pdf"));
  pendingSaves.setDirty("New/d.pdf", "annotations:pdf", false);
  assert.equal(pendingSaves.getWriter("New/d.pdf", "annotations:pdf"), undefined, "the unmounted entry is dropped once it is saved");
  resetPendingSavesForTests();
});

test("U-H2: a path discarded earlier counts again when something is journaled for it afterwards", async () => {
  const fake = installFakeIndexedDb([stored("N/e.pdf", "annotations:pdf", "stale")]);
  try {
    resetPendingSavesForTests();
    unsavedJournal.removePath("N/e.pdf");
    unsavedJournal.put("N/e.pdf", "annotations:image", "fresh");
    assert.equal(await unsavedJournal.get("N/e.pdf", "annotations:image"), "fresh");
    assert.equal(await unsavedJournal.get("N/e.pdf", "annotations:pdf"), null, "what was discarded stays discarded");
    unsavedJournal.removePath("N/e.pdf");
    unsavedJournal.put("N/e.pdf", "annotations:pdf", "after");
    assert.equal(pendingSaves.isDirty("N/e.pdf"), true);
  } finally {
    resetPendingSavesForTests();
    fake.restore();
  }
});

// ---- U-C2 ------------------------------------------------------------------------------------------------

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

const base: TranscriptSegment[] = [
  { start: 0, end: 1, text: "hello there", speaker: 0 } as TranscriptSegment,
  { start: 1, end: 2, text: "second line", speaker: 0 } as TranscriptSegment,
];

test("U-C2: unsaved transcript edits count as unsaved and follow the file instead of being saved to the old path", async () => {
  resetPendingSavesForTests();
  await withDom(async (container) => {
    const saves: { path: string; texts: string[] }[] = [];
    let draft!: SegmentDraft;
    function Probe({ path }: { path: string }) {
      draft = useSegmentDraft({
        base, saved: null, pendingPath: path,
        save: async ({ segments }) => { saves.push({ path, texts: segments.map((segment) => segment.text) }); },
      });
      useFlushWhenEditingEnds(draft.flush);
      return null;
    }
    const root = createRoot(container);
    await act(async () => { root.render(createElement(Probe, { path: "Old/memo.m4a" })); });
    assert.equal(pendingSaves.isDirty("Old/memo.m4a"), false);
    await act(async () => { draft.commit(0, "hello edited"); });
    assert.equal(pendingSaves.isDirty("Old/memo.m4a"), true, "the move prompt and Save all must see the edit");

    // The file moves; the tab's id changes, so the viewer unmounts and a new one mounts at the new path.
    pendingSaves.moveUnsaved("Old/memo.m4a", "New/memo.m4a");
    await act(async () => { root.render(null); });
    assert.deepEqual(saves, [], "nothing is saved to the old path on unmount after the move");
    assert.equal(pendingSaves.isDirty("New/memo.m4a"), true, "the edit is still unsaved, at the new path");
    assert.equal(pendingSaves.isDirty("Old/memo.m4a"), false);

    await act(async () => { root.render(createElement(Probe, { path: "New/memo.m4a" })); });
    await act(async () => { await unsavedJournal.get("New/memo.m4a", "transcript:segments"); });
    assert.deepEqual(draft.segments.map((segment) => segment.text), ["hello edited", "second line"], "the edit is back in the new view");
    await act(async () => { await pendingSaves.save("New/memo.m4a"); });
    assert.deepEqual(saves, [{ path: "New/memo.m4a", texts: ["hello edited", "second line"] }]);
    assert.equal(pendingSaves.isDirty("New/memo.m4a"), false);
    assert.equal(await unsavedJournal.get("New/memo.m4a", "transcript:segments"), null);
    await act(async () => { root.unmount(); });
  });
  resetPendingSavesForTests();
});

test("U-C2: without a move, closing the view still saves the edit and clears its unsaved state", async () => {
  resetPendingSavesForTests();
  await withDom(async (container) => {
    const saves: string[][] = [];
    let draft!: SegmentDraft;
    function Probe() {
      draft = useSegmentDraft({ base, saved: null, pendingPath: "A/memo.m4a", save: async ({ segments }) => { saves.push(segments.map((segment) => segment.text)); } });
      useFlushWhenEditingEnds(draft.flush);
      return null;
    }
    const root = createRoot(container);
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { draft.commit(1, "second edited"); });
    assert.equal(pendingSaves.isDirty("A/memo.m4a"), true);
    await act(async () => { root.unmount(); });
    assert.deepEqual(saves, [["hello there", "second edited"]]);
    assert.equal(pendingSaves.isDirty("A/memo.m4a"), false);
  });
  resetPendingSavesForTests();
});
