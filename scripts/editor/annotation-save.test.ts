import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useAnnotationWriter, type AnnotationWriter } from "../../src/components/libera/use-annotation-writer";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import { pendingSaves, unsavedJournal, resetPendingSavesForTests, flushJournal } from "../../src/components/libera/pending-saves";
import type { PdfTextAnnotation } from "../../src/lib/types";

// Annotations are written only when the person saves, as notes are
// (pending-saves.ts): every write to a synced notebook is an upload.

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

for (const kind of ["pdf", "image"] as const) {
  test(`${kind} annotations are written only on Save, one request at a time, and kept unsaved until one succeeds`, async (t) => {
    resetPendingSavesForTests();
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    for (const key of ["window", "document", "navigator"] as const) {
      Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const writes: Array<{ body: { path: string; annotations: PdfTextAnnotation[] }; resolve: () => void; reject: (error: Error) => void }> = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, `/api/${kind}-annotations`);
      assert.equal(init?.method, "PATCH");
      const body = JSON.parse(String(init?.body));
      return new Promise<Response>((resolve, reject) => {
        writes.push({ body, reject, resolve: () => resolve(Response.json({ annotations: body.annotations })) });
      });
    });
    const annotation = (text: string) => [{ id: text, text } as PdfTextAnnotation];
    const saved: string[] = [];
    const errors: unknown[] = [];
    let writer!: AnnotationWriter<PdfTextAnnotation>;
    function Viewer({ path }: { path: string }) {
      writer = useAnnotationWriter<PdfTextAnnotation>(kind, path, (annotations) => { saved.push(annotations[0].id); }, (error) => errors.push(error));
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(createElement(Viewer, { path: "Notes/one" })));
      writer.schedule(annotation("first"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(writes.length, 0, "an edit alone writes nothing");
      assert.equal(pendingSaves.isDirty("Notes/one"), true, "the file counts as unsaved");
      await flushPendingState();
      assert.equal(writes.length, 0, "quitting keeps the edit in the local journal, not the notebook");
      assert.deepEqual(await unsavedJournal.get(`Notes/one`, `annotations:${kind}`), annotation("first"), "the journal can bring it back after a crash");

      const first = pendingSaves.save("Notes/one");
      assert.equal(writes.length, 1);
      writer.schedule(annotation("latest"));
      writes[0].resolve(); await first;
      assert.deepEqual(saved, [], "an older response does not replace a newer edit");
      assert.equal(pendingSaves.isDirty("Notes/one"), true, "an edit made during a save stays unsaved");
      const second = pendingSaves.save("Notes/one");
      await settle();
      assert.equal(writes[1].body.annotations[0].id, "latest");
      writes[1].resolve(); await second;
      assert.deepEqual(saved, ["latest"]);
      assert.equal(pendingSaves.isDirty("Notes/one"), false);

      writer.schedule(annotation("retry"));
      const failed = assert.rejects(pendingSaves.save("Notes/one"), /Disk unavailable/);
      await settle();
      writes[2].reject(new Error("Disk unavailable")); await failed;
      assert.equal(errors.length, 1);
      assert.equal(pendingSaves.isDirty("Notes/one"), true, "a failed save keeps the edit");
      const retry = pendingSaves.save("Notes/one");
      await settle();
      assert.equal(writes[3].body.annotations[0].id, "retry");
      writes[3].resolve(); await retry;

      writer.schedule(annotation("old-file"));
      await act(async () => root.render(createElement(Viewer, { path: "Notes/two" })));
      assert.equal(writes.length, 4, "switching files writes nothing");
      assert.equal(pendingSaves.isDirty("Notes/one"), true, "the first file's edit waits in the journal");
      assert.equal(pendingSaves.isDirty("Notes/two"), false);
      pendingSaves.discard("Notes/one");
      assert.equal(pendingSaves.isDirty("Notes/one"), false, "Close without saving drops it");
      assert.equal(await unsavedJournal.get("Notes/one", `annotations:${kind}`), null);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
}

test("annotations remain in memory after the journal timer fires without IndexedDB", async () => {
  resetPendingSavesForTests();
  unsavedJournal.put("Notes/offline.png", "annotations:image", [{ id: "kept" }]);
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.deepEqual(await unsavedJournal.get("Notes/offline.png", "annotations:image"), [{ id: "kept" }]);
  pendingSaves.discard("Notes/offline.png");
  assert.equal(await unsavedJournal.get("Notes/offline.png", "annotations:image"), null);
});

test("an unmounted annotation writer can save and is reused if the view returns during Save", async (t) => {
  resetPendingSavesForTests();
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  let finish!: (response: Response) => void;
  let writes = 0;
  t.mock.method(globalThis, "fetch", () => {
    writes += 1;
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  let writer!: AnnotationWriter<PdfTextAnnotation>;
  function Viewer() { writer = useAnnotationWriter<PdfTextAnnotation>("image", "Notes/hidden.png", () => {}, () => {}); return null; }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Viewer)));
    const first = writer;
    writer.schedule([{ id: "kept" } as PdfTextAnnotation]);
    await act(async () => root.render(null));
    const saving = pendingSaves.save("Notes/hidden.png");
    assert.equal(writes, 1);
    await act(async () => root.render(createElement(Viewer)));
    assert.equal(writer, first);
    await act(async () => { finish(Response.json({ annotations: [{ id: "kept" }] })); await saving; });
    assert.equal(writer.dirty, false);
    assert.equal(pendingSaves.isDirty("Notes/hidden.png"), false);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test("annotation recovery owns its pending state and cannot replay a Save completed while reading the journal", async (t) => {
  resetPendingSavesForTests();
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const kept = [{ id: "recovered" } as PdfTextAnnotation];
  unsavedJournal.put("Notes/recovery.pdf", "annotations:pdf", kept);
  let writer!: AnnotationWriter<PdfTextAnnotation>;
  function Viewer() { writer = useAnnotationWriter<PdfTextAnnotation>("pdf", "Notes/recovery.pdf", () => {}, () => {}); return null; }
  const root = createRoot(document.getElementById("root")!);
  t.mock.method(globalThis, "fetch", async () => Response.json({ annotations: kept }));
  try {
    await act(async () => root.render(createElement(Viewer)));
    assert.deepEqual(await writer.recover(), kept);
    assert.equal(writer.dirty, true, "the viewer need not schedule a recovered snapshot again");
    let finishRead!: (value: PdfTextAnnotation[]) => void;
    t.mock.method(unsavedJournal, "get", () => new Promise<PdfTextAnnotation[]>((resolve) => { finishRead = resolve; }));
    const recovery = writer.recover();
    await pendingSaves.save("Notes/recovery.pdf");
    finishRead(kept);
    assert.equal(await recovery, null, "an older read cannot bring back the just-saved annotations");
    assert.equal(writer.dirty, false);
    assert.equal(pendingSaves.isDirty("Notes/recovery.pdf"), false);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test("discard while IndexedDB is opening removes old records instead of resurrecting them", async (t) => {
  resetPendingSavesForTests();
  const path = "gallery:discarded";
  const key = "ink:photo";
  const record = { id: `${path}\u0000${key}`, path, key, data: { pending: {} }, at: 1 };
  const disk = new Map([[record.id, record]]);
  let finishScan!: () => void;
  const db = {
    transaction() {
      const transaction = { oncomplete: null as (() => void) | null, objectStore: () => ({
        getAll() {
          const request = { result: [record], onsuccess: null as (() => void) | null };
          finishScan = () => request.onsuccess?.();
          return request;
        },
        delete(id: string) { disk.delete(id); queueMicrotask(() => transaction.oncomplete?.()); },
      }) };
      return transaction;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() {
    const request = { result: db, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
    resetPendingSavesForTests();
  });
  const reading = unsavedJournal.get(path, key);
  pendingSaves.discard(path);
  await settle();
  finishScan();
  assert.equal(await reading, null);
  await settle();
  assert.equal(pendingSaves.isDirty(path), false);
  assert.equal(disk.has(record.id), false, "Discard removes the on-disk copy too");
});

test("Close without saving clears a gallery tab's ink, while deletion keeps its recovery copy", async (t) => {
  resetPendingSavesForTests();
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  const { useLiberaWorkspace } = await import("../../src/components/libera/use-libera-workspace");
  const { emptyTree } = await import("../../src/components/libera/api-client");
  const { emptyWorkspaceLibrary } = await import("../../src/lib/workspaces");
  const { applyGallery } = await import("../../src/components/libera/gallery-store");
  const date = "2026-10-25T00:00:00Z";
  const photo = { id: "p1", path: "one.png", name: "one.png", folder: "", albumIds: [], createdAt: date, updatedAt: date, size: 1, starred: false, edited: false };
  const gallery = { root: "/test/gallery-save", albums: [], photos: [photo] };
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("/api/workspaces")) return Response.json(init?.method === "PUT" ? { saved: true } : emptyWorkspaceLibrary());
    if (String(url).startsWith("/api/gallery")) return Response.json(gallery);
    return Response.json({ ...emptyTree(), root: "/test/gallery-save" });
  });
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { applyGallery(gallery); workspace.openGalleryPhoto(photo); });
    unsavedJournal.put("gallery:p1", "ink:photo", { pending: {} });
    const withTab = new dom.window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(withTab);
    assert.equal(withTab.defaultPrevented, true, "an open tab's ink still blocks quitting");
    await act(async () => workspace.closeTab("gallery:p1"));
    assert.equal(workspace.workspaceConfirmDialog?.mode, "close-tab");
    await act(async () => { await workspace.submitWorkspaceConfirmDialog(); });
    assert.equal(pendingSaves.isDirty("gallery:p1"), false);
    assert.equal(await unsavedJournal.get("gallery:p1", "ink:photo"), null);
    await act(async () => { workspace.openGalleryPhoto(photo); });
    unsavedJournal.put("gallery:p1", "ink:photo", { pending: {} });
    await act(async () => { applyGallery({ ...gallery, photos: [] }); });
    assert.equal(workspace.tabs.some((tab) => tab.id === "gallery:p1"), false);
    assert.notEqual(await unsavedJournal.get("gallery:p1", "ink:photo"), null, "a file disappearing does not mean Discard");
    const afterDeletion = new dom.window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterDeletion);
    assert.equal(afterDeletion.defaultPrevented, false, "unreachable recovery must not trap the app open");
    const unregister = pendingSaves.register("gallery:overlay", "ink:photo", { dirty: true, save: async () => {}, discard() {} });
    const withOverlay = new dom.window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(withOverlay);
    assert.equal(withOverlay.defaultPrevented, true, "a gallery view without a workspace tab is still protected");
    pendingSaves.discard("gallery:overlay");
    unregister();
  } finally {
    await act(async () => root.unmount());
    pendingSaves.discard("gallery:p1");
    dom.window.close();
  }
});

test("quitting waits for a journal transaction whose coalescing timer already fired", async (t) => {
  resetPendingSavesForTests();
  let completeWrite!: () => void;
  const db = { transaction() {
    const transaction = { oncomplete: null as (() => void) | null, objectStore: () => ({
      getAll() {
        const request = { result: [], onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
      put() { completeWrite = () => transaction.oncomplete?.(); },
    }) };
    return transaction;
  } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() {
    const request = { result: db, onsuccess: null as (() => void) | null };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else Reflect.deleteProperty(globalThis, "indexedDB");
    resetPendingSavesForTests();
  });
  unsavedJournal.put("Notes/quitting.pdf", "annotations:pdf", [{ id: "kept" }]);
  await new Promise((resolve) => setTimeout(resolve, 850));
  let finished = false;
  const flushing = flushJournal().then(() => { finished = true; });
  await settle();
  assert.equal(finished, false, "quitting cannot finish while an earlier journal write is uncommitted");
  completeWrite();
  await flushing;
  assert.equal(finished, true);
});

test("unsaved annotations follow a renamed file and save to its new path", async (t) => {
  resetPendingSavesForTests();
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  for (const key of ["window", "document", "navigator"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { path: string; annotations: PdfTextAnnotation[] };
    paths.push(body.path);
    return Response.json({ annotations: body.annotations });
  });
  let writer!: AnnotationWriter<PdfTextAnnotation>;
  function Viewer({ path }: { path: string }) {
    writer = useAnnotationWriter<PdfTextAnnotation>("pdf", path, () => {}, () => {});
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Viewer, { path: "Notes/old.pdf" })));
    writer.schedule([{ id: "moved", text: "moved" } as PdfTextAnnotation]);
    await act(async () => {
      pendingSaves.moveUnsaved("Notes/old.pdf", "Notes/new.pdf");
      root.render(createElement(Viewer, { path: "Notes/new.pdf" }));
    });
    assert.equal(pendingSaves.isDirty("Notes/old.pdf"), false);
    assert.equal(pendingSaves.isDirty("Notes/new.pdf"), true);
    assert.deepEqual(await unsavedJournal.get("Notes/new.pdf", "annotations:pdf"), [{ id: "moved", text: "moved" }]);
    await pendingSaves.save("Notes/new.pdf");
    assert.deepEqual(paths, ["Notes/new.pdf"]);
    assert.equal(pendingSaves.isDirty("Notes/new.pdf"), false);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    resetPendingSavesForTests();
  }
});
