import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import type { OpenTab } from "../../src/components/libera/types";
import type { AgentWorkspaceBridge } from "../../src/components/libera/document-chat-panel";
import { validateAgentRunRecord, type AgentEvent } from "../../src/lib/agent/types";
import { newReview } from "../../src/lib/markdown-review";
import type { ChatStore } from "../../src/lib/document-chat";

test("Agent mode: the web search toggle persists and is sent; child runs and suggested edits show, and the open review reloads", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "KeyboardEvent", "MouseEvent", "FileReader", "File", "localStorage", "DOMParser", "MutationObserver"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const { createRoot } = await import("react-dom/client");
  const originalFetch = globalThis.fetch;
  let savedHistory: ChatStore | null = null;
  const agentRequests: Record<string, unknown>[] = [];
  const reviewReads: string[] = [];
  const review = { ...newReview("Research/plan.md", "# Plan", "review-1"), enabled: false };
  const events: AgentEvent[] = [
    { type: "run_started", runId: "run-0002-abcd", model: "test/model" },
    { type: "tool_started", id: "c1", name: "CheckCitations", summary: "Checking 3 citations" },
    { type: "subagent_started", id: "sub-1", label: "Checking smith2020, lee2021" },
    { type: "subagent_step", id: "sub-1", step: { id: "r1", name: "Read", summary: "Reading smith2020.pdf", status: "running" } },
    { type: "subagent_step", id: "sub-1", step: { id: "r1", name: "Read", summary: "Reading smith2020.pdf", status: "ok", result: "Pages 1-4" } },
    { type: "usage", usage: { inputTokens: 500, outputTokens: 10 } },
    { type: "subagent_step", id: "sub-1", step: { id: "w1", name: "WebSearch", summary: "Searching the web for “lee 2021”", status: "ok", result: "2 sources" } },
    { type: "subagent_finished", id: "sub-1", label: "Checking smith2020, lee2021", outcome: "completed", usage: { inputTokens: 500, outputTokens: 10 } },
    { type: "subagent_started", id: "sub-2", label: "Checking park2019" },
    { type: "subagent_finished", id: "sub-2", label: "Checking park2019", outcome: "budget", usage: { inputTokens: 0, outputTokens: 0 } },
    { type: "tool_finished", id: "c1", status: "ok", result: "2 checks" },
    { type: "suggestions_added", path: "Research/plan.md", count: 2 },
    { type: "usage", usage: { inputTokens: 1000, outputTokens: 40 } },
    { type: "text_delta", text: "Two suggested edits in Research/plan.md." },
    { type: "done", outcome: "completed" },
  ];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/state")) {
      if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); if (body.kind === "history") savedHistory = body.value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory, panel: null, fontSize: null, model: "test/model", alternativeModels: [], defaultReasoningEffort: "medium" });
    }
    if (url === "/api/agent") {
      agentRequests.push(JSON.parse(String(init?.body)));
      return new Response(events.map((event) => `${JSON.stringify(event)}\n`).join(""), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (url.startsWith("/api/markdown-reviews")) {
      if (init?.method === "POST") return Response.json(review);
      reviewReads.push(url);
      return Response.json(review);
    }
    throw new Error(`Unexpected request ${url}`);
  };

  const plan = { id: "Research/plan.md", file: { name: "plan.md", path: "Research/plan.md", notebook: "Research", fileType: "markdown" }, draft: "# Plan", saved: "# Plan", status: "clean" } as OpenTab;
  const bridge: AgentWorkspaceBridge = {
    notebook: "Research", readTabDraft: () => "# Plan", syncTabFromDisk: async () => ({ content: "# Plan", keptDraft: false }),
    restoreTabAfterUndo: () => undefined, refreshAfterChanges: async () => undefined, openFile: () => undefined,
  };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  const { MarkdownReviewProvider } = await import("../../src/components/libera/markdown-review-context");
  let commentsShown = 0;
  async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }); await act(flushPendingState); }
  async function mount() {
    const panel = createElement(DocumentChatPanel, { activeTab: plan, tabs: [plan], files: [plan.file], collapsed: false, mathMarkers: {}, onCollapsedChange: () => undefined, onCreateDraft: () => undefined, agentWorkspace: bridge });
    // eslint-disable-next-line react/no-children-prop
    await act(async () => root.render(createElement(MarkdownReviewProvider, { activeTab: plan, getDraft: () => "# Plan", applyDraft: () => true, recoverDraft: () => {}, openChat: () => {}, openComments: () => { commentsShown++; }, children: panel })));
    await settle();
  }
  const toggle = () => host.querySelector<HTMLInputElement>(".libera-agent-web-search input")!;
  try {
    await mount();
    assert.equal(host.querySelector(".libera-agent-web-search"), null, "the toggle belongs to Agent mode");
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Assistant mode"] button')].find((button) => button.textContent === "Agent")!.click(); });
    await settle();
    assert.equal(toggle().checked, false, "web search is off by default");
    assert.match(host.querySelector(".libera-agent-web-search")!.textContent!, /Allow web search/);
    await act(async () => { toggle().click(); });
    assert.equal(toggle().checked, true);
    assert.equal(window.localStorage.getItem("libera.agentWebSearch"), "true");
    assert.ok(host.textContent!.includes("· Web search on"));

    // A fresh panel restores the setting.
    await act(async () => root.render(createElement("div")));
    await mount();
    assert.equal(toggle().checked, true, "the toggle is saved like the mode");

    const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Fact-check the citations");
      composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(); });
    await settle();
    assert.equal(agentRequests.length, 1);
    assert.equal(agentRequests[0].webSearch, true);

    const article = [...host.querySelectorAll<HTMLElement>(".libera-chat-message")].at(-1)!;
    const subagents = [...article.querySelectorAll<HTMLElement>(".libera-agent-subagent")];
    assert.deepEqual(subagents.map((line) => [line.querySelector(".libera-agent-tool-summary")!.textContent, line.querySelector(".libera-agent-tool-result")!.textContent, line.getAttribute("data-status")]), [
      ["Checking smith2020, lee2021", "2 steps · done", "ok"],
      ["Checking park2019", "0 steps · not started (token budget used up)", "error"],
    ]);
    assert.deepEqual([...subagents[0].querySelectorAll(":scope ol .libera-agent-tool-summary")].map((line) => line.textContent), ["Reading smith2020.pdf", "Searching the web for “lee 2021”"]);
    assert.ok(article.querySelector('[aria-label="Suggested edits"]')!.textContent!.includes("Research/plan.md2 suggestions"));

    const stored = savedHistory!.chats[0].messages.at(-1)!.agent!;
    assert.equal(validateAgentRunRecord(stored), true);
    assert.deepEqual(stored.suggestions, [{ path: "Research/plan.md", count: 2 }]);
    const sub = stored.steps.find((step) => step.kind === "subagent" && step.id === "sub-1");
    assert.deepEqual(sub, { kind: "subagent", id: "sub-1", label: "Checking smith2020, lee2021", status: "finished", outcome: "completed", usage: { inputTokens: 500, outputTokens: 10 }, stepCount: 2, steps: [
      { id: "r1", name: "Read", summary: "Reading smith2020.pdf", status: "ok", result: "Pages 1-4" },
      { id: "w1", name: "WebSearch", summary: "Searching the web for “lee 2021”", status: "ok", result: "2 sources" },
    ] });
    assert.deepEqual(savedHistory!.chats[0].usageRequests?.[0].usage, { inputTokens: 1500, outputTokens: 50, cachedTokens: 0 }, "child usage is in the total");

    // The suggestions landed on the open document: its review is reloaded and the Comments panel shown.
    assert.deepEqual(reviewReads, ["/api/markdown-reviews?id=review-1"]);
    assert.equal(commentsShown, 1);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
