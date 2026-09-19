import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { OpenTab } from "../../src/components/libera/types";
import type { ChatMessage, ChatStore } from "../../src/lib/document-chat";

test("PDF selections retain their source and files attach once across turns, tabs and reloads", async () => {
  const dom = new JSDOM('<!doctype html><body><div class="libera-pdf-viewer" data-pdf-path="notes/paper.pdf"><div class="pdf-text-layer">Selected PDF passage</div></div><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "KeyboardEvent"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const { createRoot } = await import("react-dom/client");
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  const originalFetch = globalThis.fetch;
  let savedHistory: ChatStore | null = null;
  const requests: { messages: ChatMessage[] }[] = [];
  const pdfReads: string[] = [];
  let failPdf = false;
  let failChat = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/state")) {
      if (init?.method === "PUT") { savedHistory = JSON.parse(String(init.body)).value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory });
    }
    if (url.startsWith("/api/document-chat/pdf?")) {
      pdfReads.push(url);
      return failPdf ? Response.json({ error: "PDF could not be read" }, { status: 500 }) : Response.json({ text: "## Page 1\n\nComplete PDF text\n\n## Page 2\n\nMore content" });
    }
    assert.equal(url, "/api/document-chat");
    requests.push(JSON.parse(String(init?.body)));
    return failChat ? Response.json({ error: "Chat failed" }, { status: 500 }) : Response.json({ text: "Answer" });
  };
  const pdf = { id: "pdf", file: { name: "paper.pdf", path: "notes/paper.pdf", fileType: "pdf" }, draft: "", saved: "", status: "clean" } as OpenTab;
  const markdown = { ...pdf, id: "md", file: { ...pdf.file, name: "a.md", path: "notes/a.md", fileType: "markdown" }, draft: "# Unsaved A" } as OpenTab;
  const otherMarkdown = { ...markdown, id: "md-b", file: { ...markdown.file, name: "b.md", path: "notes/b.md" }, draft: "# Unsaved B" };
  const host = document.getElementById("root")!;
  let root = createRoot(host);
  let opened = false;
  async function render(tab: OpenTab, collapsed = false) {
    await act(async () => root.render(createElement(DocumentChatPanel, { activeTab: tab, collapsed, mathMarkers: {}, onCollapsedChange: () => { opened = true; }, onCreateDraft: () => undefined })));
  }
  async function click(label: string) { await act(async () => { const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); assert.ok(button); button.click(); }); }
  async function prompt(text: string) {
    await act(async () => {
      const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  async function send(text = "Explain this") { await prompt(text); await click("Send message"); }
  function chat() { assert.ok(savedHistory); return savedHistory.chats.find((item) => item.id === savedHistory!.activeId)!; }
  async function selectPdf(metaKey = true) {
    const range = document.createRange(); range.selectNodeContents(document.querySelector(".pdf-text-layer")!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    // Native PDF text selection leaves focus on body, not on the text layer.
    await act(async () => document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, code: "KeyL", shiftKey: true, metaKey, ctrlKey: !metaKey })));
  }
  const documents = () => requests.at(-1)!.messages.flatMap((message) => message.contexts ?? []).filter((context) => context.kind === "document");
  try {
    await render(pdf, true);
    await selectPdf();
    assert.equal(opened, true);
    assert.equal(chat().selections.find((context) => context.kind === "selection")?.text, "Selected PDF passage");
    await selectPdf(false);
    assert.equal(chat().selections.length, 2, "Repeated shortcut does not duplicate the selection or PDF");
    assert.equal(pdfReads.length, 0, "Switching or selecting does not read the PDF yet");
    await render(markdown);
    await send();
    assert.equal(pdfReads.length, 1);
    assert.deepEqual(documents().map((context) => context.path).sort(), [markdown.file.path, pdf.file.path]);
    assert.match(documents().find((context) => context.path === pdf.file.path)!.text, /Page 2/);
    assert.ok(requests.at(-1)!.messages.at(-1)!.contexts?.some((context) => context.kind === "selection"));
    await render(otherMarkdown);
    await send();
    assert.equal(documents().length, 3);
    await render(markdown);
    await send();
    assert.deepEqual(requests.at(-1)!.messages.at(-1)!.contexts, []);
    await render(pdf);
    await selectPdf();
    await send();
    assert.equal(pdfReads.length, 1);
    assert.equal(documents().length, 3);
    assert.equal(requests.at(-1)!.messages.at(-1)!.contexts?.[0].kind, "selection");
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(pdf);
    await send();
    assert.equal(pdfReads.length, 1, "Reloaded conversations reuse their PDF snapshot");
    assert.deepEqual(requests.at(-1)!.messages.at(-1)!.contexts, []);
    await click("Regenerate response");
    assert.equal(pdfReads.length, 1);
    await click("Branch conversation");
    await send();
    assert.equal(pdfReads.length, 1, "Branches reuse documents present in their history");
    await click("New chat");
    failPdf = true;
    const before = requests.length;
    await send("Keep my question");
    assert.equal(requests.length, before, "Extraction failures do not send a context-free message");
    assert.equal(chat().prompt, "Keep my question");
    assert.equal(chat().messages.length, 0);
    assert.ok(host.textContent?.includes("PDF could not be read"));
    failPdf = false;
    failChat = true;
    await click("Send message");
    assert.equal(chat().prompt, "Keep my question");
    assert.equal(chat().messages.length, 0);
    failChat = false;
    await click("Send message");
    assert.equal(chat().messages.length, 2);
    assert.equal(documents().length, 1);
    await click("New chat");
    await click("Remove document context");
    const reads = pdfReads.length;
    await send();
    assert.equal(pdfReads.length, reads, "Excluded PDFs are not loaded");
    assert.equal(documents().length, 0);
    await render({ ...pdf, file: { ...pdf.file, path: "notes/different.pdf" } });
    await selectPdf();
    assert.equal(chat().selections.length, 0, "A stale selection from another PDF is ignored");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
