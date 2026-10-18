import "./setup.cjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { anchorAt, decideAgentSuggestions, newReview, requestAgentRevision, syncReview, type AgentSuggestion, type ReviewDocument } from "../../src/lib/markdown-review";
import { tiptapChangesKey } from "../../src/lib/tiptap-changes";
import { CodeMirrorTextareaAdapter } from "../../src/lib/markdown-codemirror/textarea-adapter";

// Pending agent suggestions in both editors and the Comments panel: the same
// proposed-change preview as Agentic Review, decided with Accept, Reject and
// Request revision.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "Window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "MouseEvent", "KeyboardEvent", "DOMParser", "MutationObserver", "Event"] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
  Object.defineProperty(globalThis, key, { value: (dom.window[key] as (...args: never[]) => unknown).bind(dom.window), configurable: true });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, innerHeight: 768, innerWidth: 1024 });
Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() });
Object.assign(dom.window.HTMLElement.prototype, {
  attachEvent(this: HTMLElement, name: string, listener: EventListener) { this.addEventListener(name.replace(/^on/, ""), listener); },
  detachEvent(this: HTMLElement, name: string, listener: EventListener) { this.removeEventListener(name.replace(/^on/, ""), listener); },
});
after(() => dom.window.close());

const SOURCE = "The Q3 budget is 40k.\n\nAtlas launches in May.\n";

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function storedReview(): ReviewDocument {
  const start = SOURCE.indexOf("40k");
  const anchor = anchorAt(SOURCE, { start, end: start + 3 });
  const suggestion: AgentSuggestion = {
    id: "agent-1", version: 1, title: "Use the table's figure", reason: "The summary table says 45k.", commentIds: [],
    edits: [{ start, end: start + 3, before: "40k", after: "45k" }], anchors: [anchor], status: "pending", author: "agent", createdAt: "2026-10-18T00:00:00.000Z",
  };
  return { ...newReview("Notes/plan.md", SOURCE, "review-id"), enabled: true, agentSuggestions: [suggestion] };
}

/** The review route, in memory, with the real review functions. */
function mockReviewRoute() {
  let stored = storedReview();
  const actions: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    actions.push(body);
    if (body.action === "load" || !body.action) return Response.json(stored);
    let doc = syncReview(structuredClone(stored), body.snapshot);
    if (body.action === "agent-decision") doc = decideAgentSuggestions(doc, body.ids, body.decision, "tx");
    if (body.action === "agent-revision") doc = requestAgentRevision(doc, body.suggestionId, body.text, () => crypto.randomUUID());
    stored = { ...doc, revision: stored.revision + 1 };
    return Response.json(stored);
  };
  return { actions, restore: () => { globalThis.fetch = originalFetch; }, get stored() { return stored; } };
}

async function mount(editor: (draft: string, onChange: (text: string) => void) => ReturnType<typeof createElement>) {
  const { MarkdownReviewProvider, useMarkdownReview } = await import("../../src/components/libera/markdown-review-context");
  const { ReviewComments } = await import("../../src/components/libera/markdown-review-ui");
  let review!: NonNullable<ReturnType<typeof useMarkdownReview>>;
  function Probe() { review = useMarkdownReview()!; return null; }
  function Harness() {
    const [draft, setDraft] = useState(SOURCE);
    const draftRef = useRef(SOURCE);
    const tab = { id: "Notes/plan.md", draft, saved: SOURCE, status: "clean", file: { fileType: "markdown", path: "Notes/plan.md" } } as never;
    const onChange = (text: string) => { draftRef.current = text; setDraft(text); };
    // eslint-disable-next-line react/no-children-prop
    return createElement(MarkdownReviewProvider, {
      activeTab: tab, getDraft: () => draftRef.current,
      applyDraft: (_id: string, before: string, next: string) => { if (before !== draftRef.current) return false; draftRef.current = next; setDraft(next); return true; },
      recoverDraft: () => {}, openChat: () => {}, openComments: () => {},
      children: [createElement(Probe, { key: "probe" }), createElement(ReviewComments, { key: "comments" }), editor(draft, onChange)],
    });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(Harness)); });
  await settle(50);
  return { host, get review() { return review; }, async dispose() { await act(async () => root.unmount()); host.remove(); } };
}

function button(host: HTMLElement, label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
}

test("Visual: a pending agent suggestion previews inline, lists in Comments, and Accept applies it as one undoable change", async () => {
  const route = mockReviewRoute();
  const { TiptapMarkdownEditor } = await import("../../src/components/libera/tiptap-markdown-editor");
  const h = await mount((draft, onChange) => createElement(TiptapMarkdownEditor, {
    key: "editor", documentPath: "Notes/plan.md", value: draft, fontSizePx: 16, lineHeight: 1.5, markdownZoom: 100,
    onMarkdownZoomChange: () => {}, onChange, onSave: async () => {}, onOpenFileLink: async () => false,
  }));
  try {
    const editor = (h.host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
    const changes = tiptapChangesKey.getState(editor.state)!.changes;
    assert.ok(changes.length > 0, "the suggestion is previewed as a proposed change");
    assert.ok(changes.every((change) => change.group === "agent-1" && change.label === "Agent edit 1" && change.mode === "preview"));

    // The Comments panel: marked Agent, counted next to the comments.
    assert.match(h.host.querySelector(".review-comments header")!.textContent!, /0 open · 1 suggested/);
    const card = h.host.querySelector<HTMLElement>('[aria-label="Suggested edit 1: Use the table\'s figure"]')!;
    assert.ok(card.textContent!.includes("Agent"));
    assert.ok(card.textContent!.includes("The summary table says 45k."));
    assert.deepEqual([...card.querySelectorAll("pre")].map((pre) => pre.textContent), ["40k", "45k"]);

    await act(async () => { button(card, "Accept")!.click(); });
    await settle(20);
    assert.deepEqual(route.actions.at(-1)!.ids, ["agent-1"]);
    assert.equal(route.actions.at(-1)!.action, "agent-decision");
    assert.equal(h.review.snapshot(), "The Q3 budget is 45k.\n\nAtlas launches in May.\n");
    assert.match(editor.getText(), /45k/);
    assert.equal(tiptapChangesKey.getState(editor.state)!.changes.length, 0, "decided suggestions are no longer previewed");
    assert.equal(h.host.querySelector('[aria-label^="Suggested edit 1"]'), null);
    // The editor's undo takes back the whole acceptance at once.
    await act(async () => { editor.commands.undo(); });
    assert.match(editor.getText(), /40k/);
  } finally { await h.dispose(); route.restore(); }
});

test("Source: CodeMirror highlights pending agent suggestions; Reject and Request revision go to the review", async () => {
  const route = mockReviewRoute();
  const { MarkdownCodeMirrorEditor } = await import("../../src/components/libera/markdown-source/markdown-codemirror-editor");
  const adapter = new CodeMirrorTextareaAdapter(SOURCE);
  const h = await mount((draft, onChange) => createElement(MarkdownCodeMirrorEditor, {
    key: "editor", adapter, activeFilePath: "Notes/plan.md", files: [], formatting: false, fontFamily: "monospace", fontSizePx: 14,
    imageConverting: false, lineHeightPx: 24, openTabs: [], recentFiles: [], textareaRef: { current: null }, value: draft,
    onAiFormatSelection: async () => {}, onAiImageToMarkdown: async () => {}, onAiRewriteSelection: async () => {}, onAiWriteAt: async () => {},
    onChange, onInsertFileLink: () => {}, onInsertImageFile: async () => {},
  }));
  try {
    const view = adapter.editorView!;
    assert.deepEqual([...view.contentDOM.querySelectorAll(".review-source-highlight")].map((mark) => mark.textContent), ["40k"]);

    const card = () => h.host.querySelector<HTMLElement>('[aria-label^="Suggested edit 1"]')!;
    await act(async () => { button(card(), "Request revision")!.click(); });
    const textarea = card().querySelector<HTMLTextAreaElement>('textarea[aria-label="Revision for suggested edit 1"]')!;
    // React's input fallback in jsdom listens for IE's propertychange once the field has focus.
    await act(async () => { textarea.focus(); });
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Use the September figure.");
      const event = new dom.window.Event("propertychange", { bubbles: true });
      Object.defineProperty(event, "propertyName", { value: "value" });
      textarea.dispatchEvent(event);
    });
    await act(async () => { button(card(), "Send revision request")!.click(); });
    await settle(20);
    assert.deepEqual(route.actions.at(-1), { action: "agent-revision", suggestionId: "agent-1", text: "Use the September figure.", id: "review-id", revision: 0, snapshot: SOURCE });
    assert.equal(route.stored.threads.at(-1)!.messages[1].text, "Revision requested: Use the September figure.");
    assert.match(h.host.querySelector(".review-comments header")!.textContent!, /1 open · 1 suggested/);

    await act(async () => { button(card(), "Reject")!.click(); });
    await settle(20);
    assert.equal(route.stored.agentSuggestions![0].status, "rejected");
    assert.equal(view.state.doc.toString(), SOURCE, "rejecting leaves the text alone");
    assert.deepEqual([...view.contentDOM.querySelectorAll(".review-source-highlight")].map((mark) => mark.textContent), ["40k"], "the new comment's anchor stays highlighted");
    assert.equal(h.host.querySelector('[aria-label^="Suggested edit 1"]'), null);
  } finally { await h.dispose(); route.restore(); }
});
