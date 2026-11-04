import assert from "node:assert/strict";
import test from "node:test";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { OpenTab } from "../../src/components/libera/types";
import type { ChatContext, ChatMessage, ChatStore } from "../../src/lib/document-chat";

// 8,000 words, ten to a line: line N starts with word (N - 1) * 10.
const draft = Array.from({ length: 800 }, (_, line) => Array.from({ length: 10 }, (_, word) => `w${line * 10 + word}`).join(" ")).join("\n");

test("dragging a Markdown document's card picks a page budget, and follow-ups send only new text", async () => {
  const dom = new JSDOM('<!doctype html><body><textarea class="markdown-editor-input"></textarea><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "KeyboardEvent", "FileReader"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const { createRoot } = await import("react-dom/client");
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  const originalFetch = globalThis.fetch;
  let savedHistory: ChatStore | null = null;
  const requests: { messages: ChatMessage[] }[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/state")) {
      if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); if (body.value?.chats) savedHistory = body.value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory });
    }
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ text: "Answer" });
  };
  const tab = (line: number) => ({ id: "md", file: { name: "long.md", path: "notes/long.md", fileType: "markdown" }, draft, saved: draft, status: "clean", viewState: { markdown: { line } } }) as OpenTab;
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  async function render(line: number) {
    const active = tab(line);
    await act(async () => root.render(createElement(DocumentChatPanel, { activeTab: active, files: [active.file], tabs: [active], collapsed: false, mathMarkers: {}, onCollapsedChange: () => {}, onCreateDraft: () => {} } as never)));
    await act(flushPendingState);
  }
  const chip = () => host.querySelector<HTMLElement>('.libera-context-chip[data-kind="document"]')!;
  const title = () => chip().querySelector(".libera-context-chip-title")!.textContent;
  const fire = async (type: string, clientX: number) => { await act(async () => { chip().dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX })); }); };
  async function send(text: string) {
    await act(async () => {
      const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(flushPendingState);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(); });
    await act(flushPendingState);
  }
  async function quote(passage: string) {
    const textarea = document.querySelector<HTMLTextAreaElement>(".markdown-editor-input")!;
    textarea.value = draft;
    const start = draft.indexOf(passage);
    textarea.setSelectionRange(start, start + passage.length);
    await act(async () => textarea.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, code: "KeyL", shiftKey: true, metaKey: true })));
    await act(flushPendingState);
  }
  const sentDocument = (): ChatContext | undefined => requests.at(-1)!.messages.at(-1)!.contexts?.find((context) => context.kind === "document");
  const hasWord = (context: ChatContext | undefined, word: string) => new RegExp(`(^|\\s)${word}(\\s|$)`).test(context?.text ?? "");
  try {
    await render(401);
    assert.equal(title(), "long.md");
    assert.ok(chip().hasAttribute("data-adjustable"));

    // Dragging shows pages; Escape leaves things as they were.
    await fire("pointerdown", 300);
    await fire("pointermove", 200);
    assert.match(title()!, /^\d+ pages$/);
    assert.ok(chip().hasAttribute("data-dragging"));
    await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(title(), "long.md");
    assert.equal(chip().querySelector(".libera-context-chip-badge"), null);

    // Dragging all the way left is one page; the name comes back on release.
    await fire("pointerdown", 300);
    await fire("pointermove", 20);
    assert.equal(title(), "1 page");
    await fire("pointerup", 20);
    assert.equal(title(), "long.md");
    assert.equal(chip().querySelector(".libera-context-chip-badge")?.textContent, "1p");
    await fire("pointerdown", 300);
    await fire("pointermove", 368);
    const dragged = Number(title()!.split(" ")[0]);
    assert.ok(dragged > 1 && dragged < 16);
    await fire("pointermove", 342);
    await fire("pointerup", 342);
    const budget = Number(chip().querySelector(".libera-context-chip-badge")!.textContent!.replace("p", ""));
    assert.ok(budget >= 2);

    // Around the page in view: line 401 is word 4,000.
    await send("What is here?");
    const first = sentDocument()!;
    assert.ok(hasWord(first, "w4000"));
    assert.ok(!hasWord(first, "w100"));
    assert.equal(first.excerpt!.pages, budget);
    assert.equal(first.pageCount, 16);
    assert.ok(chip().hasAttribute("data-sent"), "What the reader sees already went");

    // Inside what went: the quote travels alone.
    await quote("w4001 w4002");
    await send("And this?");
    assert.equal(sentDocument(), undefined);
    assert.ok(requests.at(-1)!.messages.at(-1)!.contexts?.some((context) => context.kind === "selection"));

    // Outside it: only the text around the new quote, none of what went before.
    await quote("w7000 w7001");
    await send("And that?");
    const added = sentDocument()!;
    assert.ok(hasWord(added, "w7000"));
    assert.ok(!hasWord(added, "w4000"));

    // Scrolling past everything sent shows the card as new again.
    await render(101);
    assert.equal(chip().hasAttribute("data-sent"), false);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
