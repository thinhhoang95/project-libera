import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import { applyGallery } from "../../src/components/libera/gallery-store";
import { DEFAULT_IMAGE_GENERATION_SETTINGS, type ImageGenerationSettings } from "../../src/lib/image-generation";
import type { LiberaTree } from "../../src/lib/types";

for (const failedRead of [false, true]) {
  test(`image generation saves on commit/generate/close, without typing timers${failedRead ? " after a failed settings read" : ""}`, async (context) => {
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
    for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "KeyboardEvent"] as const) {
      Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    }
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const { createRoot } = await import("react-dom/client");
    const { ImageGenerationPanel } = await import("../../src/components/libera/image-generation-panel");
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const storage = context.mock.method(dom.window.Storage.prototype, "setItem");
    const originalFetch = globalThis.fetch;
    const model = DEFAULT_IMAGE_GENERATION_SETTINGS.model;
    const settings: ImageGenerationSettings = { model, paramsByModel: {}, destination: { kind: "gallery", album: "" } };
    const writes: ImageGenerationSettings[] = [];
    let complete!: () => void;
    let generated = 0;
    globalThis.fetch = async (input, init) => {
      switch (String(input)) {
        case "/api/image-generation/settings":
          if (init?.method === "PUT") {
            writes.push(JSON.parse(String(init.body)));
            return Response.json({ saved: true });
          }
          return failedRead ? Response.json({ error: "Settings unavailable" }, { status: 500 }) : Response.json(settings);
        case "/api/image-generation/models":
          return Response.json({ models: [{ id: model, name: "Image model", parameters: { n: { type: "range", min: 1, max: 4 } } }] });
        case "/api/image-generation":
          generated++;
          await new Promise<void>((resolve) => { complete = resolve; });
          return Response.json({ files: [] });
        default: throw new Error(`Unexpected request ${input}`);
      }
    };
    applyGallery({ root: "", albums: [], photos: [] });
    const host = document.getElementById("root")!;
    const root = createRoot(host);
    async function advance() { await act(async () => { context.mock.timers.tick(120_000); }); }
    async function input(id: string, value: string) {
      await act(async () => {
        const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
        const proto = field instanceof dom.window.HTMLInputElement ? dom.window.HTMLInputElement.prototype : dom.window.HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    }
    try {
      await act(async () => { root.render(createElement(ImageGenerationPanel, { tree: { root: "", notebooks: [] } as unknown as LiberaTree, onFilesSaved: () => undefined, onOpenFile: () => undefined })); });
      await advance();
      assert.equal(writes.length, 0, "loading settings is read-only");
      await act(flushPendingState);
      assert.equal(writes.length, 0, "close without edits never overwrites unread settings");
      await input("image-generation-prompt", "A draft prompt");
      await input("image-generation-n", "2");
      await advance();
      assert.equal(writes.length, 0, "editing settings has no timer save");
      assert.equal(storage.mock.callCount(), 0, "typing does not write browser storage");

      // Keyboard submission does not rely on a blur to save the latest values.
      await act(async () => {
        host.querySelector("#image-generation-prompt")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      });
      assert.equal(generated, 1);
      assert.equal(writes.length, 1);
      assert.equal(writes[0].paramsByModel[model].n, 2);
      assert.equal(window.localStorage.getItem("libera.imageGeneration.prompt"), "A draft prompt");
      await input("image-generation-prompt", "Changed during generation");
      await advance();
      assert.equal(storage.mock.callCount(), 1);
      await act(async () => { complete(); });
      assert.equal(window.localStorage.getItem("libera.imageGeneration.prompt"), "Changed during generation");
      assert.equal(writes.length, 1, "completion deduplicates unchanged settings");

      await input("image-generation-n", "3");
      await advance();
      assert.equal(writes.length, 1);
      await act(async () => {
        host.querySelector("#image-generation-n")!.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
      });
      assert.equal(writes.length, 2, "leaving a field commits settings");
      assert.equal(writes.at(-1)?.paramsByModel[model].n, 3);

      await input("image-generation-prompt", "Draft recovered on close");
      await input("image-generation-n", "4");
      await act(flushPendingState);
      assert.equal(writes.length, 3);
      assert.equal(writes.at(-1)?.paramsByModel[model].n, 4);
      assert.equal(window.localStorage.getItem("libera.imageGeneration.prompt"), "Draft recovered on close");
      const storedPrompts = storage.mock.callCount();
      await act(flushPendingState);
      assert.equal(writes.length, 3);
      assert.equal(storage.mock.callCount(), storedPrompts, "duplicate close events do not write again");
    } finally {
      await act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
      dom.window.close();
    }
  });
}
