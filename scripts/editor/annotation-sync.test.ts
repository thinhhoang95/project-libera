import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { broadcastSavedAnnotations, useAnnotationSync } from "../../src/components/libera/annotation-sync";

test("annotation sync ignores own saves but accepts remote saves and releases its channel", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  for (const key of ["window", "document", "navigator"] as const) {
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalChannel = globalThis.BroadcastChannel;
  const channels = new Set<Channel>();
  class Channel {
    listeners: ((event: MessageEvent) => void)[] = [];
    constructor(readonly name: string) { channels.add(this); }
    addEventListener(_type: string, receive: (event: MessageEvent) => void) { this.listeners.push(receive); }
    postMessage(data: unknown) {
      for (const channel of channels) {
        if (channel !== this && channel.name === this.name) {
          for (const receive of channel.listeners) receive({ data: structuredClone(data) } as MessageEvent);
        }
      }
    }
    close() { channels.delete(this); }
  }
  globalThis.BroadcastChannel = Channel as unknown as typeof BroadcastChannel;
  const received: unknown[] = [];
  function Receiver({ label }: { label: string }) {
    useAnnotationSync("pdf", "paper.pdf", (annotations) => received.push({ label, annotations }));
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(Receiver, { label: "initial" })));
    const name = [...channels][0].name;
    broadcastSavedAnnotations("pdf", "paper.pdf", [{ id: "own" }]);
    assert.deepEqual(received, [], "Saving must not trigger a second local annotation update");
    assert.equal(channels.size, 1, "The temporary publishing channel is closed");
    await act(async () => root.render(createElement(Receiver, { label: "latest" })));
    const remote = new Channel(name);
    remote.postMessage({ sender: "another-window", kind: "pdf", path: "paper.pdf", annotations: [{ id: "remote" }] });
    assert.deepEqual(received, [{ label: "latest", annotations: [{ id: "remote" }] }]);
    remote.postMessage({ sender: "another-window", kind: "image", path: "paper.pdf", annotations: [] });
    remote.postMessage({ sender: "another-window", kind: "pdf", path: "other.pdf", annotations: [] });
    assert.equal(received.length, 1);
    remote.close();
    await act(async () => root.unmount());
    assert.equal(channels.size, 0);
  } finally {
    await act(async () => root.unmount());
    globalThis.BroadcastChannel = originalChannel;
    dom.window.close();
  }
});
