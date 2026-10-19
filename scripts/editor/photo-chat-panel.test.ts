import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { OpenTab } from "../../src/components/libera/types";
import type { ChatMessage, ChatStore } from "../../src/lib/document-chat";
import type { ChatViewedPhoto } from "../../src/components/libera/document-chat-panel";

test("a photo viewed in the gallery is attached once per chat and replaces the document as context", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "KeyboardEvent", "FileReader"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const { createRoot } = await import("react-dom/client");
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  const originalFetch = globalThis.fetch;
  let savedHistory: ChatStore | null = null;
  const requests: { messages: ChatMessage[] }[] = [];
  const photoReads: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/state")) {
      if (init?.method === "PUT") { savedHistory = JSON.parse(String(init.body)).value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory });
    }
    if (url.startsWith("/api/gallery/raw/")) {
      photoReads.push(url);
      return { ok: true, blob: async () => new dom.window.Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }) } as Response;
    }
    assert.equal(url, "/api/document-chat");
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ text: "Answer" });
  };
  const markdown = { id: "md", file: { name: "a.md", path: "notes/a.md", fileType: "markdown" }, draft: "# Unsaved A", saved: "", status: "dirty" } as OpenTab;
  const sunset: ChatViewedPhoto = { source: "gallery:p1:2026-01-01-4", name: "sunset.png", url: "/api/gallery/raw/sunset.png?v=1" };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  async function render(viewedPhoto: ChatViewedPhoto | null) {
    await act(async () => root.render(createElement(DocumentChatPanel, { viewedPhoto, activeTab: markdown, files: [markdown.file], tabs: [markdown], collapsed: false, mathMarkers: {}, onCollapsedChange: () => undefined, onCreateDraft: () => undefined })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  async function click(label: string) { await act(async () => { const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); assert.ok(button, label); button.click(); }); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
  async function send(text: string) {
    await act(async () => {
      const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Send message");
  }
  const lastUser = () => requests.at(-1)!.messages.filter((message) => message.role === "user").at(-1)!;
  try {
    await render(sunset);
    assert.match(host.textContent ?? "", /Context: sunset\.png \(photo\)/);
    assert.match(host.textContent ?? "", /Describe this photo/);
    assert.ok(!host.querySelector('[aria-label="Send message"]')!.hasAttribute("disabled"), "The viewed photo alone can be sent");

    await send("What is in this photo?");
    assert.equal(lastUser().photos?.length, 1);
    assert.equal(lastUser().photos![0].source, sunset.source);
    assert.match(lastUser().photos![0].dataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(lastUser().contexts ?? [], [], "The covered Markdown editor is not sent while a photo is viewed");
    assert.match(host.textContent ?? "", /sunset\.png \(already included\)/);

    await send("And the colors?");
    assert.equal(requests.length, 2);
    assert.equal(lastUser().photos?.length ?? 0, 0, "Follow-ups do not attach the photo again");
    assert.equal(requests.at(-1)!.messages[0].photos?.[0]?.source, sunset.source, "The photo stays in the history the model sees");
    assert.equal(photoReads.length, 1);

    // An edited photo is a new version, so it is attached again.
    const edited = { ...sunset, source: "gallery:p1:2026-02-02-9", url: "/api/gallery/raw/sunset.png?v=2" };
    await render(edited);
    await send("What changed?");
    assert.equal(lastUser().photos?.[0]?.source, edited.source);

    // Removing the photo context keeps it out until it is included again.
    const beach = { source: "gallery:p2:2026-01-01-4", name: "beach.png", url: "/api/gallery/raw/beach.png?v=1" };
    await render(beach);
    await click("Remove photo context");
    assert.match(host.textContent ?? "", /beach\.png is not included/);
    await send("Unrelated question");
    assert.equal(lastUser().photos?.length ?? 0, 0);
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Include")!.click(); });
    await send("Now about the beach");
    assert.equal(lastUser().photos?.[0]?.source, beach.source);

    // Leaving the viewer brings the document back as context.
    await render(null);
    assert.match(host.textContent ?? "", /Context: a\.md/);

    const { applyGallery } = await import("../../src/components/libera/gallery-store");
    await act(async () => { applyGallery({ root: "gallery", albums: [], photos: [], deletedPhotoIds: ["p1"] }); });
    await send("Continue without the deleted sunset");
    const remainingSources = requests.at(-1)!.messages.flatMap((message) => message.photos?.map((photo) => photo.source) ?? []);
    assert.ok(remainingSources.includes(beach.source), "unrelated photo attachments are retained");
    assert.ok(!remainingSources.includes(sunset.source) && !remainingSources.includes(edited.source), "every deleted version leaves the live chat and future requests");
    assert.ok(!savedHistory!.chats.some((chat) => chat.messages.some((message) => message.photos?.some((photo) => photo.source?.startsWith("gallery:p1:")))), "the open panel cannot save its old copies again");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
