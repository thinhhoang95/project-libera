import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { OpenTab } from "../../src/components/libera/types";
import type { ChatStore } from "../../src/lib/document-chat";

test("chat captures both editors, sends the draft, and restores saved conversations", async () => {
  const dom = new JSDOM('<!doctype html><body><textarea class="markdown-editor-input">Source paragraph</textarea><div class="libera-tiptap" contenteditable="true">Visual paragraph</div><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "KeyboardEvent", "FileReader", "File"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const { createRoot } = await import("react-dom/client");
  const originalFetch = globalThis.fetch;
  const requests: { reasoningEffort?: string; messages: { contexts: { text: string; kind: string }[]; photos?: { dataUrl: string; name: string }[] }[] }[] = [];
  let menuAction = "manage-chats";
  let exported: { fileName: string; content: string } | null = null;
  let notebookExport: { parentPath: string; content: string; name: string } | null = null;
  window.liberaMenu = { popup: async (menu) => {
    assert.equal(menu.items[0].type !== "separator" && menu.items[0].label, "Manage Chats");
    const exportItem = menu.items[1];
    assert.ok(exportItem.type !== "separator" && exportItem.submenu?.length === 2);
    return menuAction;
  } };
  window.liberaExport = { saveMarkdownFile: async (input) => { exported = input; return { canceled: false }; }, exportMarkdownPdf: async () => ({ canceled: true }) };
  let savedHistory: ChatStore | null = null;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/tree") return Response.json({ notebooks: [{ name: "Notes", children: [{ kind: "folder", path: "Notes/Exports", children: [] }] }] });
    if (String(input) === "/api/files") { notebookExport = JSON.parse(String(init?.body)); return Response.json({}); }
    if (String(input).endsWith("/state")) {
      if (init?.method === "PUT") { savedHistory = JSON.parse(String(init.body)).value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory, panel: null, defaultReasoningEffort: "max" });
    }
    requests.push(JSON.parse(String(init?.body))); return Response.json({ text: [
      "````markdown", "# A helpful answer", "", "**Bold** and *italic* with `inline code`.", "",
      "- First", "  - Nested", "- [x] Done", "", "> Quoted passage", "",
      "| Column | Value |", "| --- | --- |", "| A | B |", "",
      "```js", "const x = 1;", "```", "",
      String.raw`Inline \(x^2\) and display:`, "", String.raw`\[E=mc^2\]`, "",
      "[Reference](https://example.com)", "", "![Image](https://example.com/image.png)", "",
      '<script>alert("unsafe")</script>', "````",
    ].join("\n") });
  };
  const host = document.getElementById("root")!;
  let root = createRoot(host);
  const tab = { id: "draft-1", file: { name: "Draft.md", path: "notes/Draft.md", fileType: "markdown" }, draft: "# Unsaved document", saved: "# Saved", status: "dirty" } as OpenTab;
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }); }
  async function mount() { await act(async () => root.render(createElement(DocumentChatPanel, { activeTab: tab, collapsed: false, onCollapsedChange: () => undefined }))); await settle(); }
  async function click(label: string) { await act(async () => { const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); assert.ok(button); button.click(); }); }
  function stored() { assert.ok(savedHistory); return savedHistory; }
  try {
    await mount();
    assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]')?.value, "max");
    assert.equal(stored().chats[0].reasoningEffort, undefined);
    assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="New chat"]')?.disabled, true);
    await click("New chat");
    assert.equal(stored().chats.length, 1);
    await act(async () => {
      const reasoning = host.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]')!;
      reasoning.value = "high"; reasoning.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    const source = document.querySelector<HTMLTextAreaElement>(".markdown-editor-input")!;
    source.setSelectionRange(0, source.value.length);
    await act(async () => { source.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, code: "KeyL", ctrlKey: true, shiftKey: true })); });
    await settle();
    assert.equal(stored().chats[0].selections[0].text, "Source paragraph");
    const visual = document.querySelector<HTMLElement>(".libera-tiptap")!;
    const range = document.createRange(); range.selectNodeContents(visual);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    await act(async () => { visual.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, code: "KeyL", metaKey: true, shiftKey: true })); });
    await settle();
    assert.equal(stored().chats[0].selections[1].text, "Visual paragraph");
    await click("Remove selection 1");
    assert.equal(stored().chats[0].selections.length, 1);
    const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Explain this");
      composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Send message");
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoningEffort, "high");
    assert.deepEqual(requests[0].messages[0].contexts.map((item) => item.text), [tab.draft, "Visual paragraph"]);
    assert.ok(host.textContent?.includes("A helpful answer"));
    const rendered = host.querySelectorAll(".libera-chat-markdown")[1];
    assert.equal(rendered.querySelector("h1")?.textContent, "A helpful answer");
    assert.equal(rendered.querySelector("strong")?.textContent, "Bold");
    assert.equal(rendered.querySelector("em")?.textContent, "italic");
    assert.ok(rendered.querySelector("ul ul"));
    assert.ok(rendered.querySelector('input[type="checkbox"][checked]'));
    assert.ok(rendered.querySelector("blockquote"));
    assert.equal(rendered.querySelector("tbody td")?.textContent, "A");
    assert.equal(rendered.querySelector("pre code.language-js")?.textContent?.trim(), "const x = 1;");
    assert.ok(rendered.querySelector(".katex"));
    assert.ok(rendered.querySelector(".katex-display"));
    assert.equal(rendered.querySelector("a")?.getAttribute("href"), "https://example.com");
    assert.equal(rendered.querySelector("script"), null);
    assert.equal(rendered.querySelector("img"), null);
    assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="New chat"]')?.disabled, false);
    menuAction = "save-md";
    await click("Chat settings");
    assert.ok(exported);
    assert.ok((exported as { content: string }).content.includes("## User\n\nExplain this"));
    assert.ok((exported as { content: string }).content.includes("## Assistant\n\n# A helpful answer"));
    menuAction = "save-notebook";
    await click("Chat settings");
    await settle();
    await act(async () => {
      const destination = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
      destination.value = "Notes/Exports"; destination.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLFormElement>('[role="dialog"] form')!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.ok(notebookExport);
    assert.equal((notebookExport as { parentPath: string }).parentPath, "Notes/Exports");
    assert.equal((notebookExport as { content: string }).content, (exported as { content: string }).content);
    menuAction = "manage-chats";
    const firstId = stored().activeId;
    await click("New chat");
    assert.equal(stored().chats.length, 2);
    const history = host.querySelector<HTMLSelectElement>("#document-chat-history")!;
    assert.ok(history.classList.contains("font-semibold"));
    assert.ok(history.parentElement?.querySelector("svg"));
    await act(async () => { history.value = firstId; history.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.ok(host.textContent?.includes("A helpful answer"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.equal(stored().activeId, firstId);
    assert.equal(host.querySelector<HTMLSelectElement>('[aria-label="Reasoning effort"]')?.value, "high");
    assert.ok(host.textContent?.includes("A helpful answer"));
    assert.ok(host.textContent?.includes("already included"));
    await click("Chat settings");
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => {
      const name = document.querySelector<HTMLInputElement>('[aria-label="Chat name: Explain this"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name, "Research notes");
      name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Rename chat: Explain this");
    assert.equal(stored().chats.find((chat) => chat.id === firstId)?.title, "Research notes");
    await click("Select chat: Research notes");
    const deleteSelected = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent?.includes("Delete selected"))!;
    await act(async () => deleteSelected().click());
    assert.equal(stored().chats.length, 1);
    assert.notEqual(stored().activeId, firstId);
    await click("Close dialog");
    await click("New chat");
    const oldIds = stored().chats.map((chat) => chat.id);
    await click("Chat settings");
    await act(async () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click());
    await act(async () => deleteSelected().click());
    assert.equal(stored().chats.length, 1);
    assert.ok(!oldIds.includes(stored().activeId));
    assert.equal(stored().chats[0].messages.length, 0);
    await click("Close dialog");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.equal(stored().chats.length, 1);
    assert.ok(!oldIds.includes(stored().activeId));

    // Renaming an empty chat must survive its first prompt; deleting an in-flight
    // chat must cancel its request without restoring the deleted conversation.
    await click("Chat settings");
    await act(async () => {
      const name = document.querySelector<HTMLInputElement>('[aria-label="Chat name: New chat"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(name, "My chat");
      name.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Rename chat: New chat");
    await click("Close dialog");
    const mockFetch = globalThis.fetch;
    let aborted = false;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/state")) return mockFetch(input, init);
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("Aborted"));
      }));
    };
    await act(async () => {
      const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Another question");
      prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("Send message");
    assert.equal(stored().chats[0].title, "My chat");
    const deletedId = stored().activeId;
    await click("Chat settings");
    await click("Select chat: My chat");
    await act(async () => deleteSelected().click());
    await settle();
    assert.equal(aborted, true);
    assert.ok(!stored().chats.some((chat) => chat.id === deletedId));
    assert.equal(stored().chats[0].messages.length, 0);
    assert.ok(!host.textContent?.includes("Response stopped"));
    await click("Close dialog");
    globalThis.fetch = mockFetch;
    const photoInput = host.querySelector<HTMLInputElement>('[aria-label="Attach photos"]')!;
    Object.defineProperty(photoInput, "files", { configurable: true, value: [new dom.window.File([new Uint8Array([137, 80, 78, 71])], "photo.png", { type: "image/png" })] });
    await act(async () => photoInput.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    await settle();
    assert.equal(stored().chats[0].photos?.[0].name, "photo.png");
    assert.ok(host.querySelector('img[alt="photo.png"]'));
    await click("Remove document context");
    assert.ok(!host.textContent?.includes("Context:"));
    await click("Send message");
    await settle();
    const photoRequest = requests.at(-1)!;
    assert.ok(photoRequest.messages.at(-1)?.photos?.[0].dataUrl.startsWith("data:image/png;base64,"));
    assert.ok(photoRequest.messages.every((message) => !message.contexts.some((context) => context.kind === "document")));
    assert.equal(stored().chats[0].photos?.length, 0);
    assert.ok(stored().chats[0].messages[0].photos?.length);
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.ok(!host.textContent?.includes("Context:"));
    assert.ok(host.querySelector('img[alt="photo.png"]'));



    let streamController: ReadableStreamDefaultController<Uint8Array>;
    let streamCanceled = false;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/state")) return mockFetch(input, init);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
        cancel() { streamCanceled = true; },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    };
    async function askStream() {
      await act(async () => {
        const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Stream this");
        prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await click("Send message");
    }
    async function emit(event: object) {
      await act(async () => {
        streamController.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
        await new Promise((resolve) => setTimeout(resolve, 65));
      });
    }
    await askStream();
    const log = host.querySelector<HTMLDivElement>('[role="log"]')!;
    let height = 1000;
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 200 });
    await emit({ type: "delta", text: "**Streaming" });
    assert.ok(host.textContent?.includes("Streaming"));
    assert.equal(log.scrollTop, 1000);
    await act(async () => { log.scrollTop = 120; log.scrollLeft = 30; log.dispatchEvent(new dom.window.Event("scroll")); });
    height = 1200;
    await emit({ type: "delta", text: " response**" });
    assert.equal(log.scrollTop, 120, "Incoming text must not move a reader who scrolled up");
    assert.equal(log.scrollLeft, 30, "Incoming text must preserve horizontal position");
    assert.equal(host.querySelectorAll('.libera-chat-markdown strong').item(host.querySelectorAll('.libera-chat-markdown strong').length - 1)?.textContent, "Streaming response");
    await act(async () => { log.scrollTop = 1000; log.dispatchEvent(new dom.window.Event("scroll")); });
    height = 1400;
    await emit({ type: "delta", text: " continues" });
    assert.equal(log.scrollTop, 1400, "Returning to the bottom resumes following the answer");
    await act(async () => { log.scrollTop = 200; log.dispatchEvent(new dom.window.Event("scroll")); });
    await emit({ type: "done" });
    assert.equal(log.scrollTop, 200, "Finishing the response must also preserve the reading position");
    assert.equal(stored().chats[0].messages.at(-1)?.text, "**Streaming response** continues");
    assert.equal(stored().chats[0].messages.at(-1)?.status, undefined);

    await askStream();
    await emit({ type: "delta", text: "Keep this partial answer" });
    await click("Stop response");
    await settle();
    assert.equal(streamCanceled, true);
    assert.equal(stored().chats[0].messages.at(-1)?.text, "Keep this partial answer");
    assert.equal(stored().chats[0].messages.at(-1)?.status, "interrupted");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.ok(host.textContent?.includes("Keep this partial answer"));
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.fetch = originalFetch;
  }
});
