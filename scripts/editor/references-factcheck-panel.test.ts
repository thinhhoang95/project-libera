import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import type { OpenTab } from "../../src/components/libera/types";
import type { ChatStore } from "../../src/lib/document-chat";
import type { AgentEvent } from "../../src/lib/agent/types";
import { FACT_CHECK_REQUEST_EVENT, type FactCheckRequestDetail } from "../../src/lib/references/types";

function installDom() {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "HTMLSelectElement", "HTMLButtonElement", "Element", "Node", "KeyboardEvent", "FileReader", "File", "localStorage", "CustomEvent", "Event"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  return dom;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  await act(flushPendingState);
}

test("a fact-check request opens the AI panel and starts an Agent run with the skill preloaded", async () => {
  installDom();
  const { createRoot } = await import("react-dom/client");
  const originalFetch = globalThis.fetch;
  let savedHistory: ChatStore | null = null;
  const agentRequests: Record<string, unknown>[] = [];
  const events: AgentEvent[] = [
    { type: "run_started", runId: "run-factcheck-1", model: "test/provider-model" },
    { type: "text_delta", text: "**Fact-check of Research/draft.md**" },
    { type: "suggestions_added", path: "Research/draft.md", count: 2 },
    { type: "done", outcome: "completed" },
  ];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/state")) {
      if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); if (body.kind === "history") savedHistory = body.value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory, panel: null, fontSize: null, model: "test/provider-model", alternativeModels: [], defaultReasoningEffort: "medium" });
    }
    if (url === "/api/agent") {
      agentRequests.push(JSON.parse(String(init?.body)));
      return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const draft = { id: "Research/draft.md", file: { name: "draft.md", path: "Research/draft.md", notebook: "Research", fileType: "markdown" }, draft: "Claim [@smith2020].", saved: "Claim [@smith2020].", status: "clean" } as OpenTab;
  const collapsedChanges: boolean[] = [];
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const { DocumentChatPanel, factCheckPrompt } = await import("../../src/components/libera/document-chat-panel");
  const render = (collapsed: boolean) => root.render(createElement(DocumentChatPanel, {
    activeTab: draft, tabs: [draft], files: [draft.file], collapsed, mathMarkers: {},
    onCollapsedChange: (value: boolean) => { collapsedChanges.push(value); }, onCreateDraft: () => undefined,
    agentWorkspace: { notebook: "Research", readTabDraft: () => null, syncTabFromDisk: async () => null, restoreTabAfterUndo: () => undefined, refreshAfterChanges: async () => undefined, openFile: () => undefined },
  }));
  try {
    // The panel is closed and in Chat mode with an earlier conversation.
    window.localStorage.setItem("libera.chatMode", "chat");
    window.localStorage.setItem("libera.agentPermission", "read-only");
    savedHistory = { chats: [{ id: "old", title: "Earlier", messages: [{ id: "m1", role: "user", text: "Hello", createdAt: "2026-10-18T00:00:00.000Z" }, { id: "m2", role: "assistant", text: "Hi", createdAt: "2026-10-18T00:00:01.000Z" }], prompt: "", selections: [] }], activeId: "old" };
    await act(async () => render(true));
    await settle();

    await act(async () => { window.dispatchEvent(new CustomEvent<FactCheckRequestDetail>(FACT_CHECK_REQUEST_EVENT, { detail: { path: "Research/draft.md", webSearch: true } })); });
    assert.deepEqual(collapsedChanges, [false], "the AI panel opens");
    await act(async () => render(false));
    await settle();

    assert.equal(agentRequests.length, 1);
    const sent = agentRequests[0] as { skill: string; webSearch: boolean; permission: string; activeFile: string; messages: { role: string; text: string }[] };
    assert.equal(sent.skill, "fact-check-citations");
    assert.equal(sent.webSearch, true);
    assert.equal(sent.permission, "read-only");
    assert.equal(sent.activeFile, "Research/draft.md");
    assert.deepEqual(sent.messages.map((message) => [message.role, message.text]), [["user", factCheckPrompt("Research/draft.md")]], "a new chat, not the earlier conversation");
    assert.equal(factCheckPrompt("Research/draft.md"), "Fact-check the citations in Research/draft.md.");
    assert.equal(savedHistory!.chats.length, 2);
    const started = savedHistory!.chats.find((chat) => chat.id === savedHistory!.activeId)!;
    assert.equal(started.mode, "agent");
    assert.equal(started.messages.at(-1)!.text, "**Fact-check of Research/draft.md**");
    assert.deepEqual(started.messages.at(-1)!.agent!.suggestions, [{ path: "Research/draft.md", count: 2 }]);
    assert.ok(host.textContent?.includes("Fact-check the citations in Research/draft.md."));
  } finally {
    await act(flushPendingState);
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});

test("the Fact-check citations toolbar button dispatches the request and is off without citations", async () => {
  installDom();
  const { createRoot } = await import("react-dom/client");
  const { FactCheckButton, mayHaveCitations } = await import("../../src/components/libera/markdown-toolbar");
  assert.equal(mayHaveCitations("Mail me at a@b.com."), false);
  assert.equal(mayHaveCitations("As shown [@smith2020, p. 3]."), true);
  assert.equal(mayHaveCitations("Smith [-@smith2020] says"), true);
  assert.equal(mayHaveCitations("@smith2020 argues"), true);
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const requests: FactCheckRequestDetail[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent<FactCheckRequestDetail>).detail);
  window.addEventListener(FACT_CHECK_REQUEST_EVENT, listener);
  try {
    await act(async () => root.render(createElement(FactCheckButton, { documentPath: "Research/draft.md", markdown: "No citations." })));
    const button = () => host.querySelector<HTMLButtonElement>('[aria-label="Fact-check citations"]')!;
    assert.equal(button().disabled, true);
    assert.match(button().title, /no citations/);
    await act(async () => root.render(createElement(FactCheckButton, { documentPath: "Research/draft.md", markdown: "A claim [@smith2020]." })));
    assert.equal(button().disabled, false);
    await act(async () => { button().click(); });
    assert.deepEqual(requests, [{ path: "Research/draft.md" }]);
    await act(async () => root.render(createElement(FactCheckButton, { documentPath: "Untitled", markdown: "A claim [@smith2020].", disabled: true })));
    assert.equal(button().disabled, true, "untitled drafts have no library path to check");
  } finally {
    window.removeEventListener(FACT_CHECK_REQUEST_EVENT, listener);
    await act(async () => root.unmount());
  }
});
