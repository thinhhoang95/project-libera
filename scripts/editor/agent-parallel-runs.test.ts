import assert from "node:assert/strict";
import test from "node:test";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { OpenTab } from "../../src/components/libera/types";
import type { AgentWorkspaceBridge } from "../../src/components/libera/document-chat-panel";
import type { ChatStore } from "../../src/lib/document-chat";
import type { AgentEvent } from "../../src/lib/agent/types";
import { agentWriteOverlap, agentWriteScope } from "../../src/components/libera/agent-write-scope";

test("Agent write scopes overlap on a shared notebook or file, and Read Only claims nothing", () => {
  const plan = { path: "Research/plan.md", notebook: "Research" };
  const diary = { path: "Diary/today.md", notebook: "Diary" };
  assert.equal(agentWriteScope("read-only", "Research", [plan]), null);
  assert.equal(agentWriteScope("notebook", undefined, [plan]), null);
  const research = agentWriteScope("notebook", "Research", [diary])!;
  assert.deepEqual(research, { notebook: "Research", files: [] }, "a notebook run claims the notebook, not the open files");
  assert.equal(agentWriteOverlap(research, agentWriteScope("notebook", "Research", [])!), "Research");
  assert.equal(agentWriteOverlap(research, agentWriteScope("notebook", "Diary", [])!), null);
  assert.equal(agentWriteOverlap(research, agentWriteScope("open-files", undefined, [diary, plan])!), "Research/plan.md");
  assert.equal(agentWriteOverlap(agentWriteScope("open-files", undefined, [diary])!, research), null);
  assert.equal(agentWriteOverlap(agentWriteScope("open-files", undefined, [plan])!, agentWriteScope("open-files", undefined, [diary, plan])!), "Research/plan.md");
  assert.equal(agentWriteOverlap(agentWriteScope("open-files", undefined, [plan])!, agentWriteScope("open-files", undefined, [diary])!), null);
});

test("chats respond in parallel: a new chat runs while another streams, and file-changing runs never overlap", async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "KeyboardEvent", "FileReader", "File", "localStorage"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const { createRoot } = await import("react-dom/client");
  const originalFetch = globalThis.fetch;
  let savedHistory: ChatStore | null = null;
  const encoder = new TextEncoder();
  const runs: { body: { permission: string; sessionId: string }; controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/state")) {
      if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); if (body.kind === "history") savedHistory = body.value; return Response.json({ saved: true }); }
      return Response.json({ history: savedHistory, panel: null, fontSize: null, model: "test/provider-model", alternativeModels: [], defaultReasoningEffort: "medium" });
    }
    if (url === "/api/agent") {
      const body = JSON.parse(String(init?.body));
      const signal = init!.signal!;
      // Each run streams until the test emits its events, like a long agent run.
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        runs.push({ body, controller, signal });
        signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
      } });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const plan = { id: "Research/plan.md", file: { name: "plan.md", path: "Research/plan.md", notebook: "Research", fileType: "markdown" }, draft: "# Plan", saved: "# Plan", status: "clean" } as OpenTab;
  const bridge: AgentWorkspaceBridge = {
    notebook: "Research",
    readTabDraft: () => "# Plan",
    syncTabFromDisk: async () => ({ content: "# Plan", keptDraft: false }),
    restoreTabAfterUndo: () => undefined,
    refreshAfterChanges: async () => undefined,
    openFile: () => undefined,
  };
  const host = document.getElementById("root")!;
  const root = createRoot(host);
  const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
  async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }); await act(flushPendingState); }
  async function emit(run: number, events: AgentEvent[]) {
    await act(async () => { for (const event of events) runs[run].controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); });
    await settle();
  }
  async function click(label: string) {
    await act(async () => { host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(); });
    await settle();
  }
  async function type(text: string) {
    const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer, text);
      composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  }
  async function choosePermission(value: string) {
    const permission = host.querySelector<HTMLSelectElement>(".libera-agent-permission select")!;
    await act(async () => { permission.value = value; permission.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  }
  const chatTitles = () => [...host.querySelectorAll<HTMLOptionElement>("#document-chat-history option")].map((option) => option.textContent);
  const alertText = () => [...host.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent).join(" ");
  try {
    await act(async () => root.render(createElement(DocumentChatPanel, { activeTab: plan, tabs: [plan], files: [plan.file], collapsed: false, mathMarkers: {}, onCollapsedChange: () => undefined, onCreateDraft: () => undefined, agentWorkspace: bridge })));
    await settle();
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Assistant mode"] button')].find((button) => button.textContent === "Agent")!.click(); });
    await choosePermission("notebook");
    await type("Tidy the plan");
    await click("Send message");
    assert.equal(runs.length, 1);
    await emit(0, [{ type: "run_started", runId: "run-a", model: "test/provider-model" }, { type: "text_delta", text: "Working on the plan." }]);
    assert.deepEqual(chatTitles(), ["Tidy the plan · Responding…"]);

    // A new chat while the first is still responding: the first keeps streaming.
    await click("New chat");
    assert.equal(runs[0].signal.aborted, false, "starting a new chat leaves the running one alone");
    assert.ok(host.querySelector('[aria-label="Send message"]'), "the new chat can send while the other responds");
    await type("Also rewrite the plan");
    await click("Send message");
    assert.equal(runs.length, 1, "a second run that may change the same notebook does not start");
    assert.match(alertText(), /The agent in “Tidy the plan” may still change Research\./);
    assert.equal(host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!.value, "Also rewrite the plan", "the refused prompt stays in the composer");

    await choosePermission("read-only");
    await click("Send message");
    assert.equal(runs.length, 2, "a Read Only agent runs alongside");
    assert.equal(runs[1].body.permission, "read-only");
    assert.notEqual(runs[1].body.sessionId, runs[0].body.sessionId);
    assert.deepEqual(chatTitles(), ["Also rewrite the plan · Responding…", "Tidy the plan · Responding…"]);
    await emit(1, [{ type: "run_started", runId: "run-b", model: "test/provider-model" }, { type: "text_delta", text: "Reading only." }]);

    // The first run's output lands in its own chat while the second is in view.
    await emit(0, [{ type: "text_delta", text: " Done tidying." }, { type: "done", outcome: "completed" }]);
    assert.ok(!host.textContent?.includes("Done tidying."), "the other chat's reply does not show here");
    assert.deepEqual(chatTitles(), ["Also rewrite the plan · Responding…", "Tidy the plan"]);
    assert.equal(savedHistory!.chats.find((item) => item.title === "Tidy the plan")!.messages.at(-1)!.text, "Working on the plan. Done tidying.");

    // Stop applies to the chat in view only.
    await click("Stop response");
    assert.equal(runs[1].signal.aborted, true);
    assert.deepEqual(chatTitles(), ["Also rewrite the plan", "Tidy the plan"]);
    const history = host.querySelector<HTMLSelectElement>("#document-chat-history")!;
    await act(async () => { history.value = savedHistory!.chats.find((item) => item.title === "Tidy the plan")!.id; history.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await settle();
    assert.ok(host.textContent?.includes("Working on the plan. Done tidying."));
    assert.equal(alertText(), "", "the stopped run's outcome stays with its own chat");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
  }
});
