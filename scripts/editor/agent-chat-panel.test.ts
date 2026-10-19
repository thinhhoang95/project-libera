import assert from "node:assert/strict";
import test from "node:test";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { OpenTab } from "../../src/components/libera/types";
import type { AgentWorkspaceBridge } from "../../src/components/libera/document-chat-panel";
import type { ChatStore } from "../../src/lib/document-chat";
import type { AgentEvent } from "../../src/lib/agent/types";

test("Agent mode sends open drafts and scope, shows activity, syncs tabs, and undoes changes", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "KeyboardEvent", "FileReader", "File", "localStorage"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const { createRoot } = await import("react-dom/client");
  const originalFetch = globalThis.fetch;
  let savedHistory: ChatStore | null = null;
  const agentRequests: Record<string, unknown>[] = [];
  const chatRequests: { messages: Record<string, unknown>[] }[] = [];
  const undoRequests: unknown[] = [];
  const events: AgentEvent[] = [
    { type: "run_started", runId: "run-0001-abcd", model: "test/provider-model" },
    { type: "text_delta", text: "Checking the plan." },
    { type: "tool_started", id: "c1", name: "Read", summary: "Reading Research/plan.md" },
    { type: "tool_finished", id: "c1", status: "ok", result: "3 lines", detail: "     1\t# Plan" },
    { type: "tasks_updated", tasks: [{ id: "1", subject: "Raise the budget", status: "completed" }] },
    { type: "tool_started", id: "c2", name: "Edit", summary: "Editing Research/plan.md", diff: { removed: "40k", added: "50k" } },
    { type: "file_changed", path: "Research/plan.md", created: false },
    { type: "tool_finished", id: "c2", status: "ok", result: "Edited" },
    { type: "tool_started", id: "c3", name: "Grep", summary: "Searching for “nothing”" },
    { type: "tool_finished", id: "c3", status: "error", result: "Invalid regular expression" },
    { type: "usage", usage: { inputTokens: 900, outputTokens: 30, cachedTokens: 100 } },
    { type: "usage", usage: { inputTokens: 1100, outputTokens: 20 } },
    { type: "text_delta", text: "Raised the budget in Research/plan.md." },
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
    if (url === "/api/agent/undo") {
      undoRequests.push(JSON.parse(String(init?.body)));
      return Response.json({ results: [{ path: "Research/plan.md", status: "restored", content: "# Plan\n\n40k\n", draft: "# Plan (unsaved)" }] });
    }
    if (url === "/api/document-chat") {
      chatRequests.push(JSON.parse(String(init?.body)));
      return Response.json({ text: "Chat answer", usage: { inputTokens: 1, outputTokens: 1 } });
    }
    throw new Error(`Unexpected request ${url}`);
  };

  const plan = { id: "Research/plan.md", file: { name: "plan.md", path: "Research/plan.md", notebook: "Research", fileType: "markdown" }, draft: "# Plan (unsaved)", saved: "# Plan", status: "dirty" } as OpenTab;
  const other = { id: "Research/other.md", file: { name: "other.md", path: "Research/other.md", notebook: "Research", fileType: "markdown" }, draft: "# Other", saved: "# Other", status: "clean" } as OpenTab;
  const pdf = { id: "Research/paper.pdf", file: { name: "paper.pdf", path: "Research/paper.pdf", notebook: "Research", fileType: "pdf" }, draft: "", saved: "", status: "clean" } as OpenTab;
  const synced: [string, string | undefined][] = [];
  const restored: [string, unknown][] = [];
  const refreshed: string[][] = [];
  const opened: string[] = [];
  const bridge: AgentWorkspaceBridge = {
    notebook: "Research",
    readTabDraft: (path) => path === plan.id ? "# Plan (live draft)" : path === other.id ? other.draft : null,
    syncTabFromDisk: async (path, baseline) => { synced.push([path, baseline]); return { content: "# Plan\n\n50k\n", keptDraft: false }; },
    restoreTabAfterUndo: (path, result) => { restored.push([path, result]); },
    refreshAfterChanges: async (created) => { refreshed.push(created); },
    openFile: (path) => { opened.push(path); },
  };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }); await act(flushPendingState); }
  async function mount() {
    await act(async () => root.render(createElement(DocumentChatPanel, { activeTab: plan, tabs: [plan, other, pdf], files: [plan.file, other.file], collapsed: false, mathMarkers: {}, onCollapsedChange: () => undefined, onCreateDraft: () => undefined, agentWorkspace: bridge })));
    await settle();
  }
  function modeButton(label: string) {
    return [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Assistant mode"] button')].find((button) => button.textContent === label)!;
  }
  async function type(text: string) {
    const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer, text);
      composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  try {
    await mount();
    assert.equal(modeButton("Chat").getAttribute("aria-pressed"), "true");
    assert.equal(host.querySelector('[aria-label="Agent permission"]'), null);
    await act(async () => { modeButton("Agent").click(); });
    await settle();
    assert.equal(modeButton("Agent").getAttribute("aria-pressed"), "true");
    assert.equal(window.localStorage.getItem("libera.chatMode"), "agent");
    assert.equal(savedHistory!.chats[0].mode, "agent");
    const permission = host.querySelector<HTMLSelectElement>(".libera-agent-permission select")!;
    assert.equal(permission.value, "open-files");
    assert.deepEqual([...permission.options].map((option) => option.textContent), ["Read Only", "Modify opened files only", "Modify all files in Notebook/Folder"]);
    assert.ok(host.textContent?.includes("It can modify the 2 files open in the editor."));
    assert.ok(host.textContent?.includes("Viewing plan.md · Can modify 2 open files"));
    await act(async () => { permission.value = "notebook"; permission.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(window.localStorage.getItem("libera.agentPermission"), "notebook");
    assert.ok(host.textContent?.includes("Can modify files in Research"));

    await type("Raise the budget to 50k");
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(); });
    await settle();
    assert.equal(agentRequests.length, 1);
    const sent = agentRequests[0] as { permission: string; activeFile: string; openFiles: string[]; drafts: Record<string, string>; notebook: string; messages: { text: string; contexts?: unknown[] }[]; model: string };
    assert.equal(sent.permission, "notebook");
    assert.equal(sent.activeFile, "Research/plan.md");
    assert.deepEqual(sent.openFiles, ["Research/plan.md", "Research/other.md"]);
    assert.deepEqual(sent.drafts, { "Research/plan.md": "# Plan (live draft)" });
    assert.equal(sent.notebook, "Research");
    assert.equal(sent.model, "test/provider-model");
    assert.equal(sent.messages.at(-1)!.text, "Raise the budget to 50k");
    assert.deepEqual(sent.messages.at(-1)!.contexts, [], "Agent mode passes the open file by path, not content");
    assert.deepEqual(synced, [["Research/plan.md", "# Plan (live draft)"]]);
    assert.deepEqual(refreshed, [[]]);

    const article = [...host.querySelectorAll<HTMLElement>(".libera-chat-message")].at(-1)!;
    assert.ok(article.textContent?.includes("Libera Agent"));
    assert.ok(article.textContent?.includes("Checking the plan."));
    assert.ok(article.textContent?.includes("Raised the budget in Research/plan.md."));
    const lines = [...article.querySelectorAll(".libera-agent-tool")].map((line) => [line.querySelector(".libera-agent-tool-summary")?.textContent, line.querySelector(".libera-agent-tool-result")?.textContent, line.getAttribute("data-status")]);
    assert.deepEqual(lines, [
      ["Reading Research/plan.md", "3 lines", "ok"],
      ["Editing Research/plan.md", "Edited", "ok"],
      ["Searching for “nothing”", "Invalid regular expression", "error"],
    ]);
    assert.deepEqual([...article.querySelectorAll(".libera-agent-diff [data-kind]")].map((span) => [span.getAttribute("data-kind"), span.textContent]), [["removed", "−Removed: 40k\n"], ["added", "+Added: 50k\n"]]);
    assert.ok(article.querySelector(".libera-agent-tasks")?.textContent?.includes("Raise the budget"));
    const stored = savedHistory!.chats[0].messages.at(-1)!;
    assert.equal(stored.text, "Checking the plan.\n\nRaised the budget in Research/plan.md.");
    assert.equal(stored.agent?.runId, "run-0001-abcd");
    assert.equal(stored.agent?.outcome, "completed");
    assert.deepEqual(stored.agent?.changes, [{ path: "Research/plan.md", created: false }]);
    assert.deepEqual(savedHistory!.chats[0].usageRequests?.[0].usage, { inputTokens: 2000, outputTokens: 50, cachedTokens: 100 });
    assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="Regenerate response"]')!.disabled, true, "Regenerating would lose track of unreverted changes");

    await act(async () => { article.querySelector<HTMLButtonElement>(".libera-agent-file")!.click(); });
    assert.deepEqual(opened, ["Research/plan.md"]);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Undo changes to Research/plan.md"]')!.click(); });
    await settle();
    assert.deepEqual(undoRequests, [{ runId: "run-0001-abcd", paths: ["Research/plan.md"] }]);
    assert.deepEqual(restored, [["Research/plan.md", { status: "restored", content: "# Plan\n\n40k\n", draft: "# Plan (unsaved)" }]]);
    assert.deepEqual(savedHistory!.chats[0].messages.at(-1)!.agent?.changes, [{ path: "Research/plan.md", created: false, reverted: true }]);
    assert.ok(article.querySelector(".libera-agent-changes")?.textContent?.includes("undone"));
    assert.equal(host.querySelector<HTMLButtonElement>('[aria-label="Regenerate response"]')!.disabled, false);

    // Mode and permission are fixed once the conversation starts.
    assert.equal(host.querySelector('[aria-label="Assistant mode"]'), null);
    assert.equal(host.querySelector(".libera-agent-permission"), null);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click(); });
    assert.equal(modeButton("Agent").getAttribute("aria-pressed"), "true", "New chats start in the last used mode");
    await act(async () => { modeButton("Chat").click(); });
    assert.equal(host.querySelector(".libera-agent-permission"), null);
    await type("Thanks");
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(); });
    await settle();
    assert.equal(chatRequests.length, 1);
    assert.equal(host.querySelector(".libera-chat-modebar"), null, "Chat conversations hide the bar entirely");
    assert.equal(window.localStorage.getItem("libera.chatMode"), "chat");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    dom.window.close();
  }
});
