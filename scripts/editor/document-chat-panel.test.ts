import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { OpenTab } from "../../src/components/libera/types";
import type { ChatStore } from "../../src/lib/document-chat";

test("chat captures both editors, sends the draft, and restores saved conversations", async () => {
  const dom = new JSDOM('<!doctype html><body><textarea class="markdown-editor-input">Source paragraph</textarea><div class="libera-tiptap" contenteditable="true">Visual\nparagraph\nhidden line</div><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "KeyboardEvent", "FileReader", "File"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const { createRoot } = await import("react-dom/client");
  const originalFetch = globalThis.fetch;
  const requests: { model?: string; reasoningEffort?: string; messages: { contexts: { text: string; kind: string }[]; photos?: { dataUrl: string; name: string }[] }[] }[] = [];
  let menuAction = "manage-chats";
  let exported: { fileName: string; content: string } | null = null;
  let createdDraft: { fileName: string; content: string } | null = null;
  let notebookExport: { parentPath: string; content: string; name: string } | null = null;
  window.liberaMenu = { popup: async (menu) => {
    const firstItem = menu.items[0];
    if (firstItem.type !== "separator" && firstItem.id.startsWith("chat-model-")) {
      assert.deepEqual(menu.items.map((item) => item.type !== "separator" && [item.label, item.type, item.checked]), [
        ["test/provider-model", "radio", true],
        ["test/alternative-model", "radio", false],
      ]);
      return menuAction;
    }
    assert.equal(menu.items[0].type !== "separator" && menu.items[0].label, "Manage Chats");
    const exportItem = menu.items[1];
    assert.ok(exportItem.type !== "separator" && exportItem.submenu?.length === 3);
    return menuAction;
  } };
  window.liberaExport = { saveMarkdownFile: async (input) => { exported = input; return { canceled: false }; }, exportMarkdownPdf: async () => ({ canceled: true }) };
  let savedFontSize: number | null = null;
  let savedHistory: ChatStore | null = null;
  let fileReads = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("/api/files?")) { fileReads++; return Response.json({ file: { fileType: "markdown" }, content: "# Curated reference" }); }
    if (String(input) === "/api/tree") return Response.json({ notebooks: [{ name: "Notes", children: [{ kind: "folder", path: "Notes/Exports", children: [] }] }] });
    if (String(input) === "/api/files") { notebookExport = JSON.parse(String(init?.body)); return Response.json({}); }
    if (String(input).endsWith("/state")) {
      if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); if (body.kind === "font-size") savedFontSize = body.value; else savedHistory = body.value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory, panel: null, fontSize: savedFontSize, model: "test/provider-model", alternativeModels: ["test/alternative-model"], defaultReasoningEffort: "max" });
    }
    requests.push(JSON.parse(String(init?.body))); return Response.json({ text: [
      "````markdown", "# A helpful answer", "", "**Bold** and *italic* with `inline code`.", "",
      "- First", "  - Nested", "- [x] Done", "", "> Quoted passage", "",
      "| Column | Value |", "| --- | --- |", "| A | B |", "",
      "```js", "const x = 1;", "```", "",
      String.raw`Inline \(x^2\) and display:`, "", String.raw`\[E=mc^2\]`, "",
      "[Reference](https://example.com)", "", "![Image](https://example.com/image.png)", "",
      '<script>alert("unsafe")</script>', "````",
    ].join("\n"), usage: { inputTokens: 1200, outputTokens: 42, cachedTokens: 1000 } });
  };
  const host = document.getElementById("root")!;
  let root = createRoot(host);
  const tab = { id: "draft-1", file: { name: "Draft.md", path: "notes/Draft.md", fileType: "markdown" }, draft: "# Unsaved document", saved: "# Saved", status: "dirty" } as OpenTab;
  const mathMarkers = { inlineMathMarkers: "@@ @@", blockMathMarkers: "%% %%" };
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }); }
  async function mount() { await act(async () => root.render(createElement(DocumentChatPanel, { activeTab: tab, files: [tab.file, { ...tab.file, name: "curated.md", path: "notes/curated.md" }], tabs: [tab], quickPrompts: [{ identifier: "summarize", prompt: "Summarize $1 in bullets." }, { identifier: "review", prompt: "Review this text." }], collapsed: false, mathMarkers, onCollapsedChange: () => undefined, onCreateDraft: (snapshot) => { createdDraft = snapshot; } }))); await settle(); }
  async function click(label: string) { await act(async () => { const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); assert.ok(button); button.click(); }); }
  function stored() { assert.ok(savedHistory); return savedHistory; }
  try {
    await mount();
    assert.equal(host.querySelector('[aria-label="Chat token usage"]')?.textContent, "000");
    assert.equal(host.querySelector('[aria-label="Model: test/provider-model"]')?.textContent, "provider-model");
    menuAction = "chat-model-1";
    await click("Model: test/provider-model");
    assert.equal(host.querySelector('[aria-label="Model: test/alternative-model"]')?.textContent, "alternative-model");
    menuAction = "manage-chats";
    assert.ok(!host.textContent?.includes("Enter to send"));
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
    assert.equal(stored().chats[0].selections[1].text, "Visual\nparagraph\nhidden line");
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
    assert.equal(host.querySelector('[aria-label="Chat token usage"]')?.textContent, "1.2K421K");
    assert.deepEqual(stored().chats[0].usageRequests?.[0].usage, { inputTokens: 1200, outputTokens: 42, cachedTokens: 1000 });
    assert.equal(requests[0].model, "test/alternative-model");
    assert.equal(requests[0].reasoningEffort, "high");
    assert.deepEqual(requests[0].messages[0].contexts.map((item) => item.text), [tab.draft, "Visual\nparagraph\nhidden line"]);
    const contextSummaries = host.querySelectorAll<HTMLElement>(".libera-chat-message details summary");
    assert.equal(contextSummaries[0]?.textContent, "Draft.md");
    assert.equal(contextSummaries[0]?.getAttribute("aria-label"), "Document: Draft.md");
    assert.ok(contextSummaries[0]?.querySelector("svg"));
    assert.equal(contextSummaries[1]?.textContent, "Visual paragraph…");
    assert.equal(contextSummaries[1]?.getAttribute("aria-label"), "Selection: Visual paragraph…");
    assert.ok(contextSummaries[1]?.querySelector("svg"));
    assert.equal(contextSummaries[1]?.querySelector(".inline-flex"), null, "The excerpt must flow beside the native disclosure marker");
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
    menuAction = "create-draft";
    await click("Chat settings");
    assert.ok(createdDraft);
    assert.equal(exported, null);
    assert.equal(notebookExport, null);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    menuAction = "save-md";
    await click("Chat settings");
    assert.ok(exported);
    assert.deepEqual(createdDraft, exported);
    assert.ok((exported as { content: string }).content.includes("## User\n\nExplain this"));
    assert.ok((exported as { content: string }).content.includes("## Assistant\n\n# A helpful answer"));
    assert.ok((exported as { content: string }).content.includes("Inline @@x^2@@"));
    assert.ok((exported as { content: string }).content.includes("%%\nE=mc^2\n%%"));
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
    assert.equal(host.querySelector('[aria-label="Chat token usage"]')?.textContent, "000");
    const history = host.querySelector<HTMLSelectElement>("#document-chat-history")!;
    assert.ok(history.classList.contains("font-semibold"));
    assert.ok(history.parentElement?.querySelector("svg"));
    await act(async () => { history.value = firstId; history.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.ok(host.textContent?.includes("A helpful answer"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.equal(host.querySelector('[aria-label="Chat token usage"]')?.textContent, "1.2K421K");
    menuAction = "increase-font-size";
    await click("Chat settings");
    assert.equal(savedFontSize, 15);
    assert.equal(host.querySelector<HTMLElement>(".libera-chat-markdown")?.style.getPropertyValue("--markdown-body-font-size"), "15px");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.equal(host.querySelector<HTMLElement>(".libera-chat-markdown")?.style.getPropertyValue("--markdown-body-font-size"), "15px");
    const nativeMenu = window.liberaMenu;
    delete window.liberaMenu;
    await click("Chat settings");
    await act(async () => {
      const decrease = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === "Decrease Font Size");
      assert.ok(decrease);
      decrease.click();
    });
    assert.equal(savedFontSize, 14);
    assert.equal(host.querySelector<HTMLElement>(".libera-chat-markdown")?.style.getPropertyValue("--markdown-body-font-size"), "14px");
    createdDraft = null;
    await click("Chat settings");
    await act(async () => {
      const createDraft = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === "Create a new draft");
      assert.ok(createDraft);
      createDraft.click();
    });
    assert.deepEqual(createdDraft, exported);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    window.liberaMenu = nativeMenu;
    menuAction = "manage-chats";
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



    // Slash commands insert configured quick prompts without sending and select $1.
    const beforeQuickPrompt = requests.length;
    await act(async () => {
      const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "/sum");
      prompt.setSelectionRange(4, 4);
      prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(host.querySelector('[role="listbox"]')?.getAttribute("aria-label"), "Quick prompts");
    assert.ok(host.textContent?.includes("/summarize"));
    await act(async () => host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    await settle();
    const quickPromptInput = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
    assert.equal(requests.length, beforeQuickPrompt, "Enter inserts a quick prompt without sending it");
    assert.equal(stored().chats[0].prompt, "Summarize $1 in bullets.");
    assert.deepEqual([quickPromptInput.selectionStart, quickPromptInput.selectionEnd], [10, 12]);

    // References attach complete file snapshots, including unsaved open tabs.
    async function mentionFile(query: string) {
      await act(async () => {
        const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, query);
        prompt.setSelectionRange(query.length, query.length);
        prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.ok(host.querySelector('[role="listbox"]'));
      await act(async () => host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
      await settle();
    }
    const beforeReferences = requests.length;
    await mentionFile("Compare @cu");
    assert.equal(requests.length, beforeReferences, "Enter selects a file without sending");
    assert.equal(stored().chats[0].selections[0].text, "# Curated reference");
    await mentionFile("Compare @curated.md with @dr");
    assert.equal(stored().chats[0].selections[1].text, "# Unsaved document");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.ok(host.textContent?.includes("File: curated.md"));
    await click("Remove file: Draft.md");
    await mentionFile("Compare @curated.md with @dr");
    await click("Send message");
    await settle();
    const referenced = requests.at(-1)!.messages.at(-1)!.contexts;
    assert.equal(referenced.filter((context) => context.text === "# Unsaved document").length, 1);
    assert.ok(referenced.some((context) => context.text === "# Curated reference"));
    assert.equal(stored().chats[0].selections.length, 0);

    const readsBeforeRepeat = fileReads;
    await mentionFile("Again @cu");
    assert.equal(fileReads, readsBeforeRepeat, "Previously attached files are not fetched again");
    assert.equal(stored().chats[0].selections.length, 0, "Previously attached files do not become new attachments");
    await click("Send message");
    await settle();
    assert.deepEqual(requests.at(-1)!.messages.at(-1)!.contexts, []);

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
    const usageBeforeStream = stored().chats[0].usageRequests?.length ?? 0;
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
    await emit({ type: "usage", usage: { inputTokens: 2000, outputTokens: 80, cachedTokens: 1500 } });
    await emit({ type: "usage", usage: { inputTokens: 2000, outputTokens: 80, cachedTokens: 1500 } });
    await emit({ type: "done" });
    assert.equal(stored().chats[0].usageRequests?.length, usageBeforeStream + 1, "Repeated usage frames update the same request");
    assert.deepEqual(stored().chats[0].usageRequests?.at(-1)?.usage, { inputTokens: 2000, outputTokens: 80, cachedTokens: 1500 });
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
    assert.ok(host.querySelector('[aria-label="Chat token usage"]')?.textContent?.includes("≥"));
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.ok(host.textContent?.includes("Keep this partial answer"));

    // Branching an earlier answer copies only its history and retains the source.
    globalThis.fetch = mockFetch;
    const originalChat = structuredClone(stored().chats[0]);
    assert.ok(originalChat.messages.length > 2);
    assert.match(host.querySelector("time")!.textContent!, /^\d{2}:\d{2}$/);
    assert.equal(host.querySelector("time")!.dateTime, originalChat.messages[1].createdAt);
    await click("Branch conversation");
    await settle();
    const branchId = stored().activeId;
    const activeChat = () => stored().chats.find((item) => item.id === branchId)!;
    assert.notEqual(branchId, originalChat.id);
    assert.deepEqual(stored().chats[0], originalChat);
    assert.deepEqual(activeChat().messages, originalChat.messages.slice(0, 2));
    assert.equal(activeChat().usageRequests?.length, 1);
    assert.equal(host.querySelector('[aria-label="Chat token usage"]')?.textContent, "1.2K421K");
    assert.equal(activeChat().prompt, "");
    assert.deepEqual(activeChat().excludedDocumentPaths, originalChat.excludedDocumentPaths);
    assert.equal(host.querySelectorAll('[aria-label="Regenerate response"]').length, 1);

    // A failed retry restores the original answer; retry keeps composer drafts.
    await act(async () => {
      const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Unsent follow-up");
      prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    globalThis.fetch = async (input, init) => String(input).endsWith("/state") ? mockFetch(input, init) : Response.json({ error: "Retry failed" }, { status: 500 });
    await click("Regenerate response");
    await settle();
    assert.deepEqual(activeChat().messages, originalChat.messages.slice(0, 2));
    assert.equal(activeChat().prompt, "Unsent follow-up");
    globalThis.fetch = mockFetch;
    await click("Regenerate response");
    await settle();
    assert.equal(requests.at(-1)!.messages.length, 1);
    assert.deepEqual(requests.at(-1)!.messages[0].photos, originalChat.messages[0].photos);
    assert.equal(activeChat().messages.length, 2);
    assert.notEqual(activeChat().messages[1].id, originalChat.messages[1].id);
    assert.ok(activeChat().messages[1].createdAt);
    assert.equal(activeChat().prompt, "Unsent follow-up");
    assert.deepEqual(stored().chats[0], originalChat);
    assert.equal(activeChat().usageRequests?.length, 3, "Retries remain recorded even when replies are replaced or restored");
    assert.equal(host.querySelector('[aria-label="Chat token usage"]')?.textContent, "≥2.4K≥84≥2K");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    assert.equal(stored().activeId, branchId);
    assert.equal(host.querySelector("time")!.dateTime, activeChat().messages[1].createdAt);
    const branchMessages = structuredClone(activeChat().messages);
    await act(async () => {
      const history = host.querySelector<HTMLSelectElement>("#document-chat-history")!;
      history.value = originalChat.id;
      history.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await click("Regenerate response");
    await settle();
    assert.equal(requests.at(-1)!.messages.length, 1, "Regenerating an older response excludes later turns");
    assert.equal(stored().chats[0].messages.length, 2);
    assert.deepEqual(activeChat().messages, branchMessages, "Regenerating the source leaves its branch intact");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    globalThis.fetch = originalFetch;
  }
});
