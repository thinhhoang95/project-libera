import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { flushPendingState } from "../../src/components/libera/deferred-save";
import type { ChatStore } from "../../src/lib/document-chat";

for (const mode of ["chat", "agent"] as const) {
  for (const ending of ["completed", "stopped", "failed"] as const) {
    test(`${mode} saves sent and ${ending} turns, without typing or streaming checkpoints`, async (context) => {
      const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: "http://localhost", pretendToBeVisual: true });
      for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node", "KeyboardEvent"] as const) {
        Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
      }
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
      const { createRoot } = await import("react-dom/client");
      const { DocumentChatPanel } = await import("../../src/components/libera/document-chat-panel");
      context.mock.timers.enable({ apis: ["setTimeout"] });
      const originalFetch = globalThis.fetch;
      let history: ChatStore = { activeId: "chat-1", chats: [{ id: "chat-1", title: "New chat", messages: [], prompt: "", selections: [], mode, agentPermission: "read-only" }] };
      const saves: ChatStore[] = [];
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      let failBeforeReply = false;
      globalThis.fetch = async (input, init) => {
        if (String(input) === "/api/document-chat/state") {
          if (init?.method === "PUT") {
            const body = JSON.parse(String(init.body));
            assert.equal(body.kind, "history");
            history = body.value;
            saves.push(history);
            return Response.json({ saved: true });
          }
          return Response.json({ history, model: "test/model" });
        }
        assert.equal(String(input), mode === "agent" ? "/api/agent" : "/api/document-chat");
        if (failBeforeReply) return Response.json({ error: "Request failed" }, { status: 500 });
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "application/x-ndjson" } });
      };
      const host = document.getElementById("root")!;
      let root = createRoot(host);
      const props = { activeTab: null, collapsed: false, mathMarkers: {}, onCollapsedChange: () => undefined, onCreateDraft: () => undefined };
      async function advance(ms: number) { await act(async () => { context.mock.timers.tick(ms); }); }
      async function click(label: string) {
        await act(async () => {
          const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
          assert.ok(button, label);
          button.click();
        });
      }
      async function type(text: string) {
        await act(async () => {
          const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')!;
          Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer, text);
          composer.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
      }
      async function emit(event: object) {
        await act(async () => { stream.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`)); });
        await advance(50);
      }
      try {
        await act(async () => { root.render(createElement(DocumentChatPanel, props)); });
        await advance(120_000);
        assert.equal(saves.length, 0, "loading unchanged history and waiting is read-only");
        await type("First draft");
        await advance(120_000);
        await type("Send this");
        await advance(120_000);
        assert.equal(saves.length, 0, "typing and pausing must not save");

        await click("Send message");
        assert.equal(saves.length, 1, "sending saves immediately without an explicit close flush");
        assert.equal(history.chats[0].messages.at(-1)?.text, "Send this");
        assert.equal(history.chats[0].usageRequests?.length, 1, "the request ledger is saved with the sent message");
        if (mode === "agent") await emit({ type: "run_started", runId: "run-0001-abcd", model: "test/model" });
        await emit({ type: mode === "agent" ? "text_delta" : "delta", text: "Partial answer" });
        await emit({ type: "usage", usage: { inputTokens: 10, outputTokens: 2 } });
        if (mode === "agent") {
          await emit({ type: "tool_started", id: "read-1", name: "Read", summary: "Reading a note" });
          await emit({ type: "tool_finished", id: "read-1", status: "ok", result: "Read" });
          await emit({ type: "tasks_updated", tasks: [{ id: "1", subject: "Read notes", status: "completed" }] });
        }
        await type("Next unsent draft");
        await advance(120_000);
        assert.equal(saves.length, 1, "tokens, tools, usage, and draft changes create no streaming checkpoint");
        assert.ok(host.textContent?.includes("Partial answer"), "streaming still updates the UI");

        if (ending === "stopped") await click("Stop response");
        else if (ending === "failed") await emit({ type: "error", message: "Connection failed" });
        else await emit({ type: "done", outcome: "completed" });
        assert.equal(saves.length, 2, "finishing, stopping, or failing saves the final state");
        assert.equal(history.chats[0].messages.at(-1)?.text, "Partial answer");
        assert.deepEqual(history.chats[0].usageRequests?.at(-1)?.usage, { inputTokens: 10, outputTokens: 2, ...(mode === "agent" ? { cachedTokens: 0 } : {}) });
        if (mode === "agent") assert.equal(history.chats[0].messages.at(-1)?.agent?.outcome, ending === "completed" ? "completed" : ending === "stopped" ? "stopped" : "error");
        else assert.equal(history.chats[0].messages.at(-1)?.status, ending === "completed" ? undefined : "interrupted");
        assert.equal(history.chats[0].prompt, "Next unsent draft");
        await advance(120_000);
        assert.equal(saves.length, 2, "there is no trailing autosave");

        // An early failure restores the composer and persists the rollback.
        failBeforeReply = true;
        await click("Send message");
        assert.equal(history.chats[0].prompt, "Next unsent draft");
        assert.equal(history.chats[0].messages.length, 2);
        assert.equal(history.chats[0].usageRequests?.length, 2);
        const beforeClose = saves.length;
        await type("Recover this draft on close");
        await advance(120_000);
        assert.equal(saves.length, beforeClose);
        await act(flushPendingState);
        assert.equal(saves.length, beforeClose + 1);
        assert.equal(history.chats[0].prompt, "Recover this draft on close");
        await act(flushPendingState);
        assert.equal(saves.length, beforeClose + 1, "duplicate close events do not save again");

        await act(async () => { root.unmount(); });
        root = createRoot(host);
        await act(async () => { root.render(createElement(DocumentChatPanel, props)); });
        assert.equal(host.querySelector<HTMLTextAreaElement>('[aria-label="Chat prompt"]')?.value, "Recover this draft on close");
        assert.equal(saves.length, beforeClose + 1, "restoring unchanged history does not save");

        const beforeNewChat = saves.length;
        await click("New chat");
        assert.equal(saves.length, beforeNewChat + 1, "creating a conversation saves immediately");
        await act(async () => {
          const select = host.querySelector<HTMLSelectElement>("#document-chat-history")!;
          select.value = "chat-1";
          select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
        });
        assert.equal(saves.length, beforeNewChat + 2, "switching conversations saves immediately");
        await click("Branch conversation");
        assert.equal(saves.length, beforeNewChat + 3, "branching saves immediately");

        if (ending === "completed") {
          failBeforeReply = false;
          await type("One more request");
          await click("Send message");
          if (mode === "agent") await emit({ type: "run_started", runId: "run-0002-abcd", model: "test/model" });
          await emit({ type: mode === "agent" ? "text_delta" : "delta", text: "Partial answer at close" });
          await type("Draft at close");
          const beforeActiveClose = saves.length;
          await advance(120_000);
          assert.equal(saves.length, beforeActiveClose);
          await act(flushPendingState);
          assert.equal(saves.length, beforeActiveClose + 1, "closing during a response saves its latest tokens and draft");
          assert.equal(history.chats.find((chat) => chat.id === history.activeId)?.messages.at(-1)?.text, "Partial answer at close");
          await act(async () => { root.unmount(); });
          root = createRoot(host);
          await act(async () => { root.render(createElement(DocumentChatPanel, props)); });
          const restored = history.chats.find((chat) => chat.id === history.activeId)!;
          assert.equal(restored.messages.at(-1)?.text, "Partial answer at close");
          assert.equal(restored.messages.at(-1)?.status, "interrupted");
          assert.equal(restored.prompt, "Draft at close");
        }
      } finally {
        await act(async () => { root.unmount(); });
        globalThis.fetch = originalFetch;
        dom.window.close();
      }
    });
  }
}
