import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "@tiptap/core";
import { NextRequest } from "next/server";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { findMarkdownBlockInsertionOffset, insertMarkdownBlock } from "../../src/lib/ai-write";
import { getTiptapBlockInsertionRange } from "../../src/lib/tiptap-editor-actions";
import { TiptapEditorActions } from "../../src/components/libera/tiptap-editor-actions";
import { QuickPromptsContext } from "../../src/components/libera/quick-prompt-input";
import { clearAiEditThread } from "../../src/components/libera/ai-edit-thread";
import { POST as write } from "../../src/app/api/ai-write/route";
import { POST as rewrite } from "../../src/app/api/ai-rewrite/route";
import { readDocumentContext } from "../../src/lib/ai-document-context";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "Event", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "getComputedStyle"] as const) {
  Object.defineProperty(globalThis, key, { value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key], configurable: true });
}
Object.assign(globalThis, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.assign(dom.window, { requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true });
Object.assign(dom.window.Range.prototype, {
  getClientRects: () => [],
  getBoundingClientRect: () => new dom.window.DOMRect(),
});
// React's legacy input-event fallback expects these IE hooks when jsdom moves
// focus into a controlled field.
Object.assign(dom.window.HTMLElement.prototype, {
  attachEvent(this: HTMLElement, name: string, listener: EventListener) {
    this.addEventListener(name.replace(/^on/, ""), listener);
  },
  detachEvent(this: HTMLElement, name: string, listener: EventListener) {
    this.removeEventListener(name.replace(/^on/, ""), listener);
  },
});
Object.assign(globalThis, { innerHeight: 768, innerWidth: 1024 });
after(() => dom.window.close());

const quickPrompts = [{ identifier: "expand", prompt: "Expand $1 with an example." }];

function create(content: string) {
  return new Editor({ extensions: createMarkdownExtensions("Notebook/note.md"), content, contentType: "markdown" });
}

async function typePrompt(input: HTMLTextAreaElement, value: string) {
  await act(async () => { input.blur(); input.focus(); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.setSelectionRange(value.length, value.length);
    const event = new dom.window.Event("propertychange", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "value" });
    input.dispatchEvent(event);
  });
}

async function pressEnter(input: HTMLTextAreaElement) {
  await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}

test("source Write with AI inserts a separate block after the caret's paragraph", () => {
  const value = "Intro line\nwrapped line\n\n## Next";
  assert.equal(findMarkdownBlockInsertionOffset(value, 3), 24);
  assert.equal(findMarkdownBlockInsertionOffset(value, 0), 24);
  assert.deepEqual(insertMarkdownBlock(value, 24, "\nNew text\n"), { value: "Intro line\nwrapped line\n\nNew text\n\n## Next", start: 25, end: 33 });
  // A caret on a blank line writes there; at the end of a document it appends.
  assert.equal(findMarkdownBlockInsertionOffset("A\n\nB", 2), 2);
  assert.equal(insertMarkdownBlock("A\n\nB", 2, "New").value, "A\n\nNew\n\nB");
  assert.equal(insertMarkdownBlock("A", findMarkdownBlockInsertionOffset("A", 1), "New").value, "A\n\nNew");
  assert.equal(insertMarkdownBlock("", 0, "New").value, "New");
});

test("visual Write with AI replaces an empty paragraph or follows the caret's block", () => {
  const editor = create("First paragraph\n\nSecond");
  try {
    const first = editor.state.doc.child(0);
    assert.deepEqual(getTiptapBlockInsertionRange(editor, 3), { from: first.nodeSize, to: first.nodeSize });
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph" }] });
    assert.deepEqual(getTiptapBlockInsertionRange(editor, 1), { from: 0, to: 2 });
  } finally {
    editor.destroy();
  }
});

test("right-click without a selection offers Write with AI with slash commands and inserts a new block", async () => {
  const editor = create("First paragraph\n\nSecond");
  document.body.append(editor.view.dom);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: { prompt: string; before: string; after: string } }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init?.body)) });
    return Response.json({ markdown: "New **block**" });
  }) as typeof fetch;
  // jsdom has no layout, so resolve the click to a spot inside the first paragraph.
  editor.view.posAtCoords = () => ({ pos: 3, inside: 1 });
  try {
    await act(async () => {
      root.render(createElement(QuickPromptsContext.Provider, { value: quickPrompts },
        createElement(TiptapEditorActions, { editor, documentPath: "Notebook/note.md", onError: (message: string) => { if (message) assert.fail(message); } })));
    });
    await act(async () => { editor.view.dom.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const menu = document.querySelector('[aria-label="Editor actions"]')!;
    assert.ok(menu.textContent?.includes("Write with AI"));
    assert.ok(!menu.textContent?.includes("AI Rewrite"), "selection-only actions are hidden without a selection");
    const input = document.querySelector<HTMLTextAreaElement>("#visual-ai-write")!;

    await typePrompt(input, "/exp");
    assert.ok(document.querySelector('[aria-label="Quick prompts"]')?.textContent?.includes("/expand"));
    await pressEnter(input);
    assert.equal(input.value, "Expand $1 with an example.");
    assert.equal(requests.length, 0, "Enter chooses the quick prompt without sending");

    await typePrompt(input, "Expand the idea with an example.");
    await pressEnter(input);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/ai-write");
    assert.equal(requests[0].body.prompt, "Expand the idea with an example.");
    assert.equal(requests[0].body.before, "First paragraph");
    assert.equal(requests[0].body.after, "Second");
    assert.equal(editor.getMarkdown(), "First paragraph\n\nNew **block**\n\nSecond");
    editor.commands.undo();
    assert.equal(editor.getMarkdown(), "First paragraph\n\nSecond");
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    editor.destroy();
    host.remove();
  }
});

test("AI Rewrite expands slash commands and the document-context checkbox persists", async () => {
  const editor = create("Rewrite me\n\nAfter");
  document.body.append(editor.view.dom);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  const threads: { id: string; turns: unknown[] }[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const { thread, ...body } = JSON.parse(String(init?.body));
    bodies.push(body);
    threads.push(thread);
    return Response.json({ rewrittenText: "Rewritten", thread: { id: thread.id, caching: true, turn: { user: "u", assistant: "Rewritten" } } });
  }) as typeof fetch;
  const cacheChip = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Cached AI thread"]');
  const openMenu = async () => {
    await act(async () => {
      editor.commands.setTextSelection({ from: 1, to: 8 });
      editor.view.dom.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    return document.querySelector<HTMLInputElement>("#visual-ai-document-context")!;
  };
  try {
    await act(async () => {
      root.render(createElement(QuickPromptsContext.Provider, { value: quickPrompts },
        createElement(TiptapEditorActions, { editor, documentPath: "Notebook/note.md", onError: () => {} })));
    });
    let checkbox = await openMenu();
    assert.equal(checkbox.checked, true, "the whole document is included by default");
    let input = document.querySelector<HTMLTextAreaElement>("#visual-ai-rewrite")!;
    await typePrompt(input, "Please /ex");
    await pressEnter(input);
    assert.equal(input.value, "Please Expand $1 with an example.");
    assert.deepEqual([input.selectionStart, input.selectionEnd], [14, 16]);
    await typePrompt(input, "Shorter");
    await pressEnter(input);
    assert.deepEqual(bodies[0], { text: "Rewrite", prompt: "Shorter", before: "", after: " me\n\nAfter" });
    assert.deepEqual(threads[0].turns, [], "the first request starts a thread");
    editor.commands.undo();

    checkbox = await openMenu();
    assert.equal(cacheChip()?.textContent, "1", "the cache indicator shows the thread continues");
    await act(async () => { checkbox.click(); });
    assert.equal(window.localStorage.getItem("libera-ai-include-document-context"), "false");
    assert.ok(!cacheChip(), "changing the document context ends the thread");
    input = document.querySelector<HTMLTextAreaElement>("#visual-ai-rewrite")!;
    await typePrompt(input, "Shorter");
    await pressEnter(input);
    assert.deepEqual(bodies[1], { text: "Rewrite", prompt: "Shorter" });
    assert.notEqual(threads[1].id, threads[0].id);
    assert.deepEqual(threads[1].turns, []);
    editor.commands.undo();
    assert.equal((await openMenu()).checked, false, "the choice is remembered");
    await act(async () => { cacheChip()!.click(); });
    assert.ok(!cacheChip(), "clicking the indicator clears the cache");
    input = document.querySelector<HTMLTextAreaElement>("#visual-ai-rewrite")!;
    await typePrompt(input, "Shorter");
    await pressEnter(input);
    assert.notEqual(threads[2].id, threads[1].id, "the next request starts from scratch");
    assert.deepEqual(threads[2].turns, []);
    editor.commands.undo();
  } finally {
    clearAiEditThread("Notebook/note.md");
    window.localStorage.clear();
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    editor.destroy();
    host.remove();
  }
});

test("document context is clipped around the marked spot", () => {
  assert.equal(readDocumentContext({ before: "Text" }), null);
  assert.equal(readDocumentContext({ before: " ", after: "" }), null);
  assert.deepEqual(readDocumentContext({ before: "abcdefgh", after: "ijkl" }, 8), { before: "cdefgh", after: "ij" });
  assert.deepEqual(readDocumentContext({ before: "ab", after: "cdefghijkl" }, 8), { before: "ab", after: "cdefgh" });
  assert.deepEqual(readDocumentContext({ before: "abcdefghijkl", after: "mnopqrst" }, 8), { before: "ghijkl", after: "mn" });
});

test("AI routes mark the insertion point or selection in the whole document", async () => {
  const keys = ["OPENROUTER_API_KEY", "LIBERA_AI_REWRITE_MODEL", "LIBERA_AI_REWRITE_PROMPT_CACHING"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.LIBERA_AI_REWRITE_MODEL = "custom/rewrite";
  process.env.LIBERA_AI_REWRITE_PROMPT_CACHING = "false";
  const calls: { model: string; messages: { role: string; content: string }[] }[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/endpoints")) return Response.json({ data: { endpoints: [] } });
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: "Written" } }] });
  };
  const request = (body: unknown) => new NextRequest("http://localhost/api/ai-write", { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify(body) });
  try {
    const response = await write(request({ prompt: "Add a conclusion", before: "# Essay\n\nBody", after: "\n\n## Notes" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { markdown: "Written" });
    assert.equal(calls[0].model, "custom/rewrite");
    assert.equal(calls[0].messages[1].content, "Full document, with the insertion point marked:\n<document>\n# Essay\n\nBody<<INSERT HERE>>\n\n## Notes\n</document>\n\nInstruction:\nAdd a conclusion");
    assert.equal((await write(request({ prompt: "Add a conclusion" }))).status, 200);
    assert.equal(calls[1].messages[1].content, "Instruction:\nAdd a conclusion", "no document when the checkbox is off");
    assert.equal((await write(request({ prompt: " ", before: "Text" }))).status, 400);

    assert.equal((await rewrite(request({ text: "Body", prompt: "Shorten", before: "# Essay\n\n", after: "\n\nEnd" }))).status, 200);
    assert.match(calls.at(-1)!.messages[1].content, /^Full document, with the selected Markdown marked:\n<document>\n# Essay\n\n<<SELECTION START>>Body<<SELECTION END>>\n\nEnd\n<\/document>\n\nRewrite instruction:\nShorten\n\nSelected Markdown:\nBody$/);
    assert.match(calls.at(-1)!.messages[0].content, /<<SELECTION START>> and <<SELECTION END>>/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});

test("AI Rewrite and Write with AI continue one cached thread per document", async () => {
  const keys = ["OPENROUTER_API_KEY", "LIBERA_AI_REWRITE_MODEL", "LIBERA_AI_REWRITE_PROMPT_CACHING", "LIBERA_AI_WRITE_PROMPT_CACHING"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.LIBERA_AI_REWRITE_MODEL = "cache/rewrite";
  delete process.env.LIBERA_AI_REWRITE_PROMPT_CACHING;
  delete process.env.LIBERA_AI_WRITE_PROMPT_CACHING;
  const calls: { session_id?: string; provider: { only?: string[] }; messages: { role: string; content: string | { text: string; cache_control?: object }[] }[] }[] = [];
  let reply = "Short";
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/endpoints")) return Response.json({ data: { endpoints: [{ tag: "anthropic", supported_parameters: ["cache_control"] }] } });
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 3000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: calls.length > 1 ? 2800 : 0 } } });
  };
  const request = (body: unknown) => new NextRequest("http://localhost/api/ai-rewrite", { method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` }, body: JSON.stringify(body) });
  const text = (content: string | { text: string }[]) => typeof content === "string" ? content : content.map((part) => part.text).join("");
  const long = "Lorem ipsum dolor sit amet.\n".repeat(200);
  try {
    const first = await (await rewrite(request({ text: "Body", prompt: "Shorten", before: `# Essay\n\n${long}`, after: "\n\nEnd", thread: { id: "thread-0001", turns: [] } }))).json();
    assert.equal(first.rewrittenText, "Short");
    assert.equal(first.thread.id, "thread-0001");
    assert.equal(first.thread.caching, true);
    assert.match(first.thread.turn.user, /^Full document, with the selected Markdown marked:\n<document>\n# Essay/);
    assert.equal(first.thread.turn.assistant, "Short");
    assert.equal(calls[0].session_id, "thread-0001", "sticky routing keeps the thread on one provider");
    assert.deepEqual(calls[0].provider.only, ["anthropic"]);

    reply = "New paragraph";
    const second = await (await write(request({ prompt: "Add a conclusion", before: `# Essay\n\n${long}Short`, after: "\n\nEnd", thread: { id: "thread-0001", turns: [first.thread.turn] } }))).json();
    assert.equal(second.markdown, "New paragraph");
    assert.deepEqual(second.thread.usage, { inputTokens: 3000, outputTokens: 5, cachedTokens: 2800 });
    const messages = calls[1].messages;
    assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.equal(text(messages[0].content), text(calls[0].messages[0].content), "rewrite and write share one system prompt");
    assert.equal(text(messages[1].content), first.thread.turn.user, "the first turn is replayed byte for byte");
    const followUp = text(messages[3].content);
    assert.match(followUp, /^Current text around the spot, with the insertion point marked:\n<excerpt>\n/);
    assert.match(followUp, /Short<<INSERT HERE>>\n\nEnd\n<\/excerpt>/);
    assert.ok(!followUp.includes("# Essay") && followUp.length < 4000, "follow-ups send only an excerpt, not the document again");
    assert.ok(Array.isArray(messages[0].content) && messages[0].content.at(-1)?.cache_control, "explicit providers get cache breakpoints");

    assert.equal((await rewrite(request({ text: "Body", prompt: "Shorten", thread: { id: "bad id!", turns: [] } }))).status, 400);
    process.env.LIBERA_AI_REWRITE_PROMPT_CACHING = "false";
    const uncached = await (await write(request({ prompt: "Add", thread: { id: "thread-0001", turns: [first.thread.turn] } }))).json();
    assert.equal(uncached.thread.caching, false, "the client drops the thread when caching is off");
    assert.equal(calls.at(-1)!.messages.length, 2, "no history is resent without caching");
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  }
});
