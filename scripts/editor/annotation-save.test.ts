import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useAnnotationWriter } from "../../src/components/libera/use-annotation-writer";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import type { PdfTextAnnotation } from "../../src/lib/types";

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

for (const kind of ["pdf", "image"] as const) {
  test(`${kind} annotation flush drains the debounce, serializes requests, retries errors and saves on cleanup`, async (t) => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    for (const key of ["window", "document", "navigator"] as const) {
      Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let nativeFlush: (() => Promise<void>) | undefined;
    window.liberaPersistence = { onFlush: (flush) => { nativeFlush = flush; return () => { nativeFlush = undefined; }; } };
    const writes: Array<{ body: { path: string; annotations: PdfTextAnnotation[] }; resolve: () => void; reject: (error: Error) => void }> = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, `/api/${kind}-annotations`);
      assert.equal(init?.method, "PATCH");
      assert.equal(init?.keepalive, false, "Electron waits for the normal request without the keepalive size limit");
      const body = JSON.parse(String(init?.body));
      return new Promise<Response>((resolve, reject) => {
        writes.push({ body, reject, resolve: () => resolve(Response.json({ annotations: body.annotations })) });
      });
    });
    const annotation = (text: string) => [{ id: text, text } as PdfTextAnnotation];
    const saved: string[] = [];
    const errors: unknown[] = [];
    let schedule!: (annotations: PdfTextAnnotation[]) => void;
    function Viewer({ path }: { path: string }) {
      schedule = useAnnotationWriter<PdfTextAnnotation>(kind, path, (annotations) => { saved.push(annotations[0].id); }, (error) => errors.push(error));
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    try {
      await act(async () => root.render(createElement(Viewer, { path: "Notes/one" })));
      schedule(annotation("first"));
      let finished = false;
      const flush = nativeFlush!().then(() => { finished = true; });
      assert.equal(writes.length, 1, "no debounce wait on shutdown");
      schedule(annotation("latest"));
      writes[0].resolve(); await settle();
      assert.equal(writes.length, 2);
      assert.equal(finished, false);
      assert.deepEqual(saved, [], "an old response cannot replace a newer edit");
      writes[1].resolve(); await flush;
      assert.deepEqual(saved, ["latest"]);
      schedule(annotation("retry"));
      const failed = assert.rejects(nativeFlush!(), /Disk unavailable/);
      writes[2].reject(new Error("Disk unavailable")); await failed;
      assert.equal(errors.length, 1);
      const retry = nativeFlush!();
      assert.equal(writes[3].body.annotations[0].id, "retry");
      writes[3].resolve(); await retry;

      schedule(annotation("old-file"));
      await act(async () => root.render(createElement(Viewer, { path: "Notes/two" })));
      assert.equal(writes[4].body.path, "Notes/one", "changing files saves using the original path");
      schedule(annotation("on-unmount"));
      await act(async () => root.unmount());
      assert.equal(writes[5].body.path, "Notes/two");
      assert.ok(nativeFlush, "unmounted viewers stay in the shutdown flush until their save finishes");
      const cleanupFlush = flushPendingState();
      writes[4].resolve(); writes[5].resolve(); await cleanupFlush;
      assert.deepEqual(saved, ["latest", "retry"], "cleanup responses do not update a different file or an unmounted viewer");
      assert.equal(nativeFlush, undefined);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });

  test(`${kind} shutdown awaits an annotation autosave which is already in flight`, async (t) => {
    const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
    for (const key of ["window", "document", "navigator"] as const) {
      Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    }
    let release!: () => void;
    let writes = 0;
    t.mock.method(globalThis, "fetch", async () => {
      writes++;
      await new Promise<void>((resolve) => { release = resolve; });
      return Response.json({ annotations: [] });
    });
    let schedule!: (annotations: PdfTextAnnotation[]) => void;
    function Viewer() {
      schedule = useAnnotationWriter<PdfTextAnnotation>(kind, "Notes/one", () => {}, () => {});
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(createElement(Viewer)));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      schedule([]);
      t.mock.timers.tick(350); await settle();
      assert.equal(writes, 1);
      let finished = false;
      const flush = flushPendingState().then(() => { finished = true; });
      await settle(); assert.equal(finished, false);
      release(); await flush;
      assert.equal(writes, 1, "shutdown waits for the existing request without duplicating it");
    } finally {
      await act(async () => root.unmount());
      await settle();
      dom.window.close();
    }
  });
}
