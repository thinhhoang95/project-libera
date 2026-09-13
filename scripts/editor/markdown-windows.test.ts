import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useMarkdownWindows } from "../../src/components/libera/use-markdown-windows";
import type { OpenTab } from "../../src/components/libera/types";

test("Markdown windows refresh independently using current drafts and fall back to saved files", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const file = { kind: "file" as const, name: "note.md", path: "Book/note.md", notebook: "Book", fileType: "markdown" as const, createdAt: "", updatedAt: "", size: 0 };
  let tabs: OpenTab[] = [{ id: file.path, file, draft: "stale state", saved: "saved", status: "dirty" }];
  let draft = "unsaved draft";
  const responses: Array<Array<{ content?: string; error?: string }>> = [[], []];
  const children = responses.map((messages) => ({ closed: false, postMessage: (data: { content?: string; error?: string }) => messages.push(data) }));
  let nextChild = 0;
  dom.window.open = () => children[nextChild++] as unknown as Window;
  let duplicate!: ReturnType<typeof useMarkdownWindows>;
  let error = "";
  function Harness() {
    duplicate = useMarkdownWindows(tabs, () => draft, (message) => { error = message; });
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  const oldFetch = globalThis.fetch;
  async function request(index: number, origin = "http://localhost") {
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", {
        origin, source: children[index] as unknown as Window,
        data: { type: "libera-markdown-refresh", requestId: 1 },
      }));
    });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    duplicate(file);
    duplicate(file);
    await request(0);
    await request(1);
    assert.equal(responses[0][0].content, "unsaved draft");
    assert.equal(responses[1][0].content, "unsaved draft");
    draft = "latest unsaved edits";
    await act(async () => root.render(createElement(Harness)));
    assert.equal(responses[0].length, 1, "editing must not push updates");
    await request(0);
    assert.equal(responses[0][1].content, draft);
    assert.equal(responses[1].length, 1, "refresh only updates the requesting window");
    await request(0, "https://untrusted.example");
    assert.equal(responses[0].length, 2);
    tabs = [];
    globalThis.fetch = async () => new Response(JSON.stringify({ file, content: "latest saved file" }));
    await act(async () => root.render(createElement(Harness)));
    await request(1);
    assert.equal(responses[1][1].content, "latest saved file");
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "File no longer exists" }), { status: 404 });
    await request(1);
    assert.equal(responses[1][2].error, "File no longer exists");
    dom.window.open = () => null;
    duplicate(file);
    assert.match(error, /Could not open/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = oldFetch;
    dom.window.close();
  }
});
