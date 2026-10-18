// Phase 3 part A in the editors (jsdom, a real DocHub, no server): overlay
// suggestions from another replica render in CodeMirror and Visual with
// author colours, AI labels and decide buttons by role; a commenter's editor
// is forced into suggest mode; suggest mode holds IME composition until it
// ends; AI Rewrite on a shared tab writes AI-actor suggestions in LaTeX,
// Visual and Source while non-shared tabs keep today's behaviour.

import { dom } from "./support/wire-dom";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Editor } from "@tiptap/core";
import { setLocalUser } from "../../src/lib/collab/awareness";
import { bypassSuggestMode } from "../../src/lib/collab/suggestions/suggest-mode";
import { createSuggestion, listSuggestions, resolveSuggestion } from "../../src/lib/collab/suggestions/model";
import { previewSuggestions } from "../../src/lib/collab/suggestions/codemirror";
import { editorControllerFor, sharedCodeMirrorSource } from "../../src/lib/collab/bindings/react-codemirror";
import { sharedVisualSource } from "../../src/lib/collab/bindings/react-visual";
import { applyTextToShared } from "../../src/lib/collab/client/apply-text";
import { suggestionsFor } from "../../src/lib/collab/client/suggestions";
import { suggestAiOnSharedTab } from "../../src/lib/collab/client/suggestions-ai";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapCollabHistory } from "../../src/lib/collab/bindings/tiptap-history";
import { SUGGESTIONS_CHANNEL, TiptapChanges, tiptapChangesKey } from "../../src/lib/tiptap-changes";
import { latexReviewExtension, reviewHunksField } from "../../src/lib/latex/codemirror/review";
import { runLatexAi } from "../../src/components/libera/latex/latex-ai";
import { TiptapEditorActions } from "../../src/components/libera/tiptap-editor-actions";
import type { LatexEditorHandle } from "../../src/components/libera/latex/latex-editor";
import type { SuggestionRecord } from "../../src/lib/collab/protocol/schema";
import { waitFor } from "./support/host-helpers";
import { ADA, BOB, flush, mountCodeMirror, recordingApi, sharedTab } from "./support/p3a-harness";

after(() => dom.window.close());

const bobUser = { kind: "user" as const, userId: "bob" };
const bobAi = { kind: "ai" as const, onBehalfOf: "bob", feature: "rewrite" as const };

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

function stubFetch(answer: (url: string, body: Record<string, unknown>) => unknown) {
  const original = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    return Response.json(answer(url, body));
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test("overlays from another replica render in CodeMirror with author colours, AI labels, decide buttons and stale styling", async () => {
  const text = "Hello brave world.\n\nSecond line here.\n";
  const api = recordingApi();
  const tab = await sharedTab({ text, api });
  const remote = tab.harness.replica();
  const mounted = mountCodeMirror(tab.session, tab.registry);
  try {
    await remote.whenAttached();
    setLocalUser(remote.awareness, BOB);
    const brave = text.indexOf("brave");
    createSuggestion(remote.annotations, { ytext: remote.ytext, start: brave, end: brave + 5, replacement: "bold", actor: bobUser, id: "sg-bob-user-1" });
    const second = text.indexOf("Second");
    createSuggestion(remote.annotations, { ytext: remote.ytext, start: second, end: second + 6, replacement: "Next", actor: bobAi, id: "sg-bob-ai-001", groupId: "run-bob-1" });
    createSuggestion(remote.annotations, { ytext: remote.ytext, start: text.length - 1, end: text.length - 1, replacement: " Done.", actor: bobAi, id: "sg-bob-ai-002", groupId: "run-bob-1" });
    const view = mounted.view;
    await waitFor(() => previewSuggestions(view.state).length === 3, 3000, "the collaborator's suggestions in the editor");
    await waitFor(() => [...view.contentDOM.querySelectorAll(".cm-collab-suggestion-label")].some((label) => label.textContent?.startsWith("Bob")), 3000, "Bob's name from presence");
    const labels = [...view.contentDOM.querySelectorAll(".cm-collab-suggestion-label")].map((label) => label.textContent);
    assert.deepEqual(labels, ["Bob", "AI · on behalf of Bob · 2 changes"], "one label per group; AI says on whose behalf");
    const mark = view.contentDOM.querySelector<HTMLElement>('.cm-collab-suggestion-deleted[data-suggestion-id="sg-bob-user-1"]')!;
    assert.match(mark.getAttribute("style") ?? "", /--collab-author: #22aa66/, "the author's colour from presence");
    assert.equal(view.contentDOM.querySelectorAll('button[data-action="accept"]').length, 2, "an editor sees Accept on each group");
    assert.equal(view.state.doc.toString(), text, "previews never change the text");

    // Accept goes to the server decision with the whole group.
    await act(async () => { view.contentDOM.querySelectorAll<HTMLButtonElement>('button[data-action="accept"]')[1].click(); });
    await waitFor(() => api.decisions.length === 1, 2000, "the decision request");
    assert.deepEqual(api.decisions[0].decisions.map((decision) => decision.suggestionId).sort(), ["sg-bob-ai-001", "sg-bob-ai-002"]);

    // A collaborator edits inside the first suggestion: it turns stale, with old and new text.
    remote.ytext.delete(brave + 1, 3);
    remote.ytext.insert(brave + 1, "lu");
    await waitFor(() => view.contentDOM.querySelector('.cm-collab-suggestion-stale[data-suggestion-id="sg-bob-user-1"]') !== null, 3000, "stale styling");
    const stale = view.contentDOM.querySelector<HTMLElement>('.cm-collab-suggestion-stale[data-suggestion-id="sg-bob-user-1"]')!;
    assert.match(stale.title, /Was: "brave"/);
    assert.match(stale.title, /Now: "blue"/);
  } finally {
    mounted.destroy();
    tab.close();
  }
});

test("a commenter sees no decide buttons and is forced into suggest mode: typing makes overlays, content stays untouched", async () => {
  const text = "Shared text here.\n";
  const tab = await sharedTab({ text, role: "commenter" });
  const remote = tab.harness.replica();
  const mounted = mountCodeMirror(tab.session, tab.registry);
  try {
    await remote.whenAttached();
    createSuggestion(remote.annotations, { ytext: remote.ytext, start: 0, end: 6, replacement: "Common", actor: bobUser, id: "sg-bob-user-2" });
    const view = mounted.view;
    await waitFor(() => previewSuggestions(view.state).length === 1, 3000, "the overlay");
    assert.equal(view.contentDOM.querySelectorAll('button[data-action="accept"]').length, 0, "commenters cannot decide");
    assert.equal(view.contentDOM.querySelectorAll('button[data-action="reply"]').length, 1, "but can reply");
    const controls = editorControllerFor(tab.session.replica).getSnapshot();
    assert.deepEqual([controls.suggesting, controls.suggestForced, controls.canSuggest], [true, true, true]);
    assert.equal(view.state.readOnly, false, "input reaches suggest mode");

    await act(async () => {
      view.dispatch({ changes: { from: 12, insert: " and more" }, selection: { anchor: 21 }, userEvent: "input.type" });
    });
    // Toggling off does nothing for a commenter.
    editorControllerFor(tab.session.replica).setSuggesting(false);
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: 6, insert: "" }, userEvent: "delete.backward" });
      // Even an explicit bypass cannot reach content on a commenter's tab.
      view.dispatch({ changes: { from: 0, insert: "X" }, annotations: bypassSuggestMode.of(true) });
    });
    await flush(20);
    assert.equal(tab.session.replica.text(), text, "content is untouched");
    assert.equal(tab.harness.hub.getText(), text, "nothing reached the hub's content");
    assert.equal(view.state.doc.toString(), text);
    const mine = listSuggestions(tab.session.replica.annotations, { createdBy: "ada" });
    assert.deepEqual(mine.map((record) => [record.baseQuote, record.replacement, record.actor.kind]).sort(), [["", " and more", "user"], ["Shared", "", "user"], ["", "X", "user"]].sort());
    assert.equal(applyTextToShared({ id: "Shared/note.md" }, "Overwritten", { source: "ai", feature: "rewrite" }, { registry: tab.registry }).applied, false, "programmatic writes are refused");
  } finally {
    mounted.destroy();
    tab.close();
  }
});

test("the Suggesting toggle turns an editor's typing into suggestions and back", async () => {
  const tab = await sharedTab({ text: "One two.\n" });
  const mounted = mountCodeMirror(tab.session, tab.registry);
  try {
    const view = mounted.view;
    const controller = editorControllerFor(tab.session.replica);
    assert.deepEqual([controller.getSnapshot().suggesting, controller.getSnapshot().suggestForced, controller.getSnapshot().canSuggest], [false, false, true]);
    controller.setSuggesting(true);
    view.dispatch({ changes: { from: 3, insert: " and a half" }, userEvent: "input.type" });
    await flush(10);
    assert.equal(tab.session.replica.text(), "One two.\n");
    assert.deepEqual(listSuggestions(tab.session.replica.annotations).map((record) => record.replacement), [" and a half"]);
    controller.setSuggesting(false);
    view.dispatch({ changes: { from: 0, insert: "> " }, userEvent: "input.type" });
    assert.equal(tab.session.replica.text(), "> One two.\n", "typing edits content again");
  } finally {
    mounted.destroy();
    tab.close();
  }
});

test("suggest mode holds an IME composition until it ends, moves remote edits over it, then converts it", async () => {
  const text = "Hello world.\n";
  const tab = await sharedTab({ text });
  const remote = tab.harness.replica();
  const mounted = mountCodeMirror(tab.session, tab.registry);
  try {
    await remote.whenAttached();
    const view = mounted.view;
    editorControllerFor(tab.session.replica).setSuggesting(true);
    // The browser composes "日本" at offset 5 in two steps.
    view.dispatch({ changes: { from: 5, insert: "に" }, selection: { anchor: 6 }, userEvent: "input.type.compose.start" });
    view.dispatch({ changes: { from: 5, to: 6, insert: "日本" }, selection: { anchor: 7 }, userEvent: "input.type.compose" });
    await flush(10);
    assert.equal(view.state.doc.toString(), "Hello日本 world.\n", "the composition shows in the editor");
    assert.equal(tab.session.replica.text(), text, "but never reaches the Y.Text");
    assert.equal(listSuggestions(tab.session.replica.annotations).length, 0, "nor a suggestion, while composing");

    // A collaborator types before and after the composition meanwhile.
    remote.ytext.insert(0, "> ");
    remote.ytext.insert(remote.ytext.length - 1, " Bye");
    await waitFor(() => view.state.doc.toString() === "> Hello日本 world. Bye\n", 3000, "remote edits around the held composition");

    view.contentDOM.dispatchEvent(new dom.window.Event("compositionend", { bubbles: true }));
    await waitFor(() => listSuggestions(tab.session.replica.annotations).length === 1, 2000, "the composition converted");
    const record = listSuggestions(tab.session.replica.annotations)[0];
    const resolved = resolveSuggestion(tab.session.replica.ytext, record);
    assert.deepEqual([record.baseQuote, record.replacement, resolved.start], ["", "日本", "> Hello".length]);
    assert.equal(tab.session.replica.text(), "> Hello world. Bye\n", "content holds only the remote edits");
    assert.equal(view.state.doc.toString(), tab.session.replica.text(), "the editor is back in step with the Y.Text");
    await waitFor(() => tab.harness.hub.getText() === "> Hello world. Bye\n", 2000, "the hub agrees");
    assert.equal(view.contentDOM.querySelector(".cm-collab-suggestion-inserted")?.textContent, "日本", "and shows it as a suggestion");

    // Typing after a composition while it is still held converts both together.
    view.dispatch({ changes: { from: 2, insert: "が" }, selection: { anchor: 3 }, userEvent: "input.type.compose.start" });
    view.dispatch({ changes: { from: 3, insert: "!" }, selection: { anchor: 4 }, userEvent: "input.type" });
    await flush(10);
    assert.equal(view.state.doc.toString(), tab.session.replica.text());
    assert.ok(listSuggestions(tab.session.replica.annotations).some((item) => item.replacement === "が!"), JSON.stringify(listSuggestions(tab.session.replica.annotations).map((item) => item.replacement)));
  } finally {
    mounted.destroy();
    tab.close();
  }
});

test("overlays render in Visual on their own preview channel, with author labels and buttons by role", async () => {
  const text = "# Notes\n\nThe quick brown fox.\n\nAnother paragraph.\n";
  for (const role of ["editor", "commenter"] as const) {
    const api = recordingApi();
    const tab = await sharedTab({ text, role, api });
    const remote = tab.harness.replica();
    const editor = new Editor({ extensions: [...createMarkdownExtensions("Shared/note.md"), TiptapCollabHistory, TiptapChanges.configure({ documentPath: "Shared/note.md" })], content: "", contentType: "markdown" });
    const handle = sharedVisualSource(tab.session).attach(editor);
    try {
      await remote.whenAttached();
      setLocalUser(remote.awareness, BOB);
      const quick = text.indexOf("quick");
      createSuggestion(remote.annotations, { ytext: remote.ytext, start: quick, end: quick + 5, replacement: "slow", actor: bobUser, id: "sg-visual-user" });
      const another = text.indexOf("Another");
      createSuggestion(remote.annotations, { ytext: remote.ytext, start: another, end: another + 7, replacement: "One more", actor: bobAi, id: "sg-visual-ai01" });
      // An agentic-review preview on the default channel must survive the overlay's redraws.
      editor.view.dispatch(editor.state.tr.setMeta(tiptapChangesKey, { type: "preview", changes: [] }));
      await waitFor(() => (tiptapChangesKey.getState(editor.state)?.changes ?? []).filter((change) => change.channel === SUGGESTIONS_CHANNEL).length >= 2, 3000, "suggestion previews in Visual");
      await waitFor(() => [...editor.view.dom.querySelectorAll(".libera-change-author")].map((element) => element.textContent).join("|") === "Bob|AI · on behalf of Bob", 3000, "author labels");
      assert.equal(editor.getMarkdown().includes("slow"), false, "previews do not change the document");
      const buttons = editor.view.dom.querySelectorAll('.libera-change-actions button[data-decision="accept"]').length;
      if (role === "editor") {
        assert.equal(buttons, 2);
        await act(async () => { editor.view.dom.querySelector<HTMLButtonElement>('.libera-change-actions button[data-decision="accept"]')!.click(); });
        await waitFor(() => api.decisions.length === 1, 2000, "the decision request from Visual");
        assert.deepEqual(api.decisions[0].decisions, [{ suggestionId: "sg-visual-user", decision: "accept" }]);
      } else {
        assert.equal(buttons, 0, "a commenter sees the label without Accept and Reject");
      }
    } finally {
      handle.destroy();
      editor.destroy();
      tab.close();
    }
  }
});

const latexProps = {
  documentPath: "Thesis/main.tex", fileName: "main.tex", value: "",
  fontFamily: "monospace", fontSizePx: 14, lineHeight: 1.6, diagnostics: [], project: { labels: [], bibEntries: [], files: [] },
  onChange: () => {}, onEdit: () => {}, onCompile: () => {}, onForwardSync: () => {}, onAiError: () => {}, onAddSnippet: () => {},
  onViewStateChange: () => {}, onRegisterDraft: () => () => {},
};

test("AI Rewrite in LaTeX on a shared tab creates an AI suggestion, and on a regular tab still applies its hunks", async () => {
  const source = "\\section{Intro}\nThis sentence is rather long-winded.\n";
  const fetchStub = stubFetch(() => ({ rewrittenText: "This is short." }));
  const tab = await sharedTab({ text: source, kind: "latex", path: "Thesis/main.tex" });
  const { LatexEditor } = await import("../../src/components/libera/latex/latex-editor");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const editorRef = { current: null as LatexEditorHandle | null };
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(LatexEditor, { ...latexProps, editorRef, collab: sharedCodeMirrorSource(tab.session, tab.registry) }))));
    await settle(20);
    const view = editorRef.current!.view;
    const from = source.indexOf("This"), to = source.indexOf(".\n") + 1;
    const errors: string[] = [];
    await act(async () => { await runLatexAi(view, "rewrite", { from, to }, "Shorter", (message) => { if (message) errors.push(message); }); });
    assert.deepEqual(errors, []);
    assert.equal(fetchStub.requests[0].url, "/api/ai-rewrite");
    assert.equal(view.state.doc.toString(), source, "the text is unchanged until someone accepts");
    assert.equal(tab.session.replica.text(), source);
    assert.equal(view.state.field(reviewHunksField).length, 0, "no applied hunks");
    const [record] = listSuggestions(tab.session.replica.annotations);
    assert.deepEqual([record.actor.kind, (record.actor as { onBehalfOf?: string }).onBehalfOf, (record.actor as { feature?: string }).feature, record.baseQuote, record.replacement, record.status],
      ["ai", "ada", "rewrite", "This sentence is rather long-winded.", "This is short.", "pending"]);
    await waitFor(() => view.contentDOM.querySelector(".cm-collab-suggestion-label")?.textContent === "AI · on behalf of Ada", 3000, "the AI suggestion inline");
    assert.ok(view.contentDOM.querySelector('button[data-action="accept"]'), "with Accept for an editor");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    tab.close();
  }

  // The same action on a regular (non-shared) tab: applied hunks, as before.
  const plain = new EditorView({ state: EditorState.create({ doc: source, extensions: [latexReviewExtension()] }), parent: document.body });
  try {
    await runLatexAi(plain, "rewrite", { from: source.indexOf("This"), to: source.indexOf(".\n") + 1 }, "Shorter", () => {});
    assert.equal(plain.state.doc.toString(), "\\section{Intro}\nThis is short.\n", "the result is applied");
    assert.ok(plain.state.field(reviewHunksField).length > 0, "as tracked hunks to accept or reject");
  } finally {
    plain.destroy();
    fetchStub.restore();
  }
});

async function typeInto(input: HTMLTextAreaElement, value: string) {
  await act(async () => { input.blur(); input.focus(); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.setSelectionRange(value.length, value.length);
    const event = new dom.window.Event("propertychange", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: "value" });
    input.dispatchEvent(event);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function openContextMenu(editor: Editor, from: number, to: number) {
  await act(async () => {
    editor.commands.setTextSelection({ from, to });
    editor.view.dom.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

test("AI Rewrite and Suggest edit in Visual on a shared tab create overlay suggestions; a regular tab keeps the tracked rewrite", async () => {
  const text = "First paragraph.\n\nRewrite this part please.\n";
  const fetchStub = stubFetch(() => ({ rewrittenText: "Rewritten **nicely**." }));
  const tab = await sharedTab({ text });
  const editor = new Editor({ extensions: [...createMarkdownExtensions("Shared/note.md"), TiptapCollabHistory, TiptapChanges.configure({ documentPath: "Shared/note.md" })], content: "", contentType: "markdown" });
  document.body.append(editor.view.dom);
  const handle = sharedVisualSource(tab.session).attach(editor);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const errors: string[] = [];
  try {
    await act(async () => root.render(createElement(TiptapEditorActions, { editor, documentPath: "Shared/note.md", onError: (message: string) => { if (message) errors.push(message); }, shared: () => handle.suggestions })));
    // Select "Rewrite this part please." (the second paragraph).
    let start = 0, end = 0;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text?.startsWith("Rewrite")) { start = pos; end = pos + node.text.length; } });
    await openContextMenu(editor, start, end);
    await typeInto(document.querySelector<HTMLTextAreaElement>("#visual-ai-rewrite")!, "Nicer");
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Rewrite selected text"]')!.click(); });
    await waitFor(() => listSuggestions(tab.session.replica.annotations).length === 1, 3000, "the AI suggestion");
    assert.deepEqual(errors, []);
    assert.equal(fetchStub.requests[0].body.text, "Rewrite this part please.", "the AI sees the source text it will replace");
    const [ai] = listSuggestions(tab.session.replica.annotations);
    assert.deepEqual([ai.actor.kind, (ai.actor as { feature?: string }).feature, ai.baseQuote, ai.replacement], ["ai", "rewrite", "Rewrite this part please.", "Rewritten **nicely**."]);
    assert.equal(tab.session.replica.text(), text, "the document is unchanged until accepted");
    await waitFor(() => (tiptapChangesKey.getState(editor.state)?.changes ?? []).some((change) => change.channel === SUGGESTIONS_CHANNEL && change.author?.kind === "ai"), 3000, "the tracked-change preview, backed by the overlay");
    assert.ok(!editor.getMarkdown().includes("nicely"));

    // Suggest edit: a replacement for the selection, by the user.
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text?.startsWith("First")) { start = pos; end = pos + 5; } });
    await openContextMenu(editor, start, end);
    const prompt = document.querySelector<HTMLTextAreaElement>("#visual-suggest-edit")!;
    assert.equal(prompt.value, "First", "starts from the selected source text");
    await typeInto(prompt, "Opening");
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Suggest this replacement"]')!.click(); });
    const user = listSuggestions(tab.session.replica.annotations).find((record) => record.actor.kind === "user");
    assert.deepEqual([user?.baseQuote, user?.replacement, user?.createdBy], ["First", "Opening", "ada"]);
    assert.equal(tab.session.replica.text(), text);
  } finally {
    await act(async () => root.unmount());
    handle.destroy();
    editor.destroy();
    host.remove();
    tab.close();
  }

  // A regular tab: the rewrite is applied as tracked changes, as before.
  const plain = new Editor({ extensions: [...createMarkdownExtensions("Notes/a.md"), TiptapChanges.configure({ documentPath: "Notes/a.md" })], content: text, contentType: "markdown" });
  document.body.append(plain.view.dom);
  const plainHost = document.createElement("div");
  document.body.append(plainHost);
  const plainRoot = createRoot(plainHost);
  try {
    await act(async () => plainRoot.render(createElement(TiptapEditorActions, { editor: plain, documentPath: "Notes/a.md", onError: () => {} })));
    let start = 0, end = 0;
    plain.state.doc.descendants((node, pos) => { if (node.isText && node.text?.startsWith("Rewrite")) { start = pos; end = pos + node.text.length; } });
    await openContextMenu(plain, start, end);
    assert.equal(document.querySelector("#visual-suggest-edit"), null, "no Suggest edit outside shared notes");
    await typeInto(document.querySelector<HTMLTextAreaElement>("#visual-ai-rewrite")!, "Nicer");
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Rewrite selected text"]')!.click(); });
    await waitFor(() => plain.getMarkdown().includes("nicely"), 3000, "the applied rewrite");
    assert.ok((tiptapChangesKey.getState(plain.state)?.changes ?? []).some((change) => change.mode === "applied" && change.source === "rewrite"), "as an applied tracked change");
  } finally {
    await act(async () => plainRoot.unmount());
    plain.destroy();
    plainHost.remove();
    fetchStub.restore();
  }
});

test("Source-mode AI on a shared tab maps the result from the text the AI saw (hard case 7); regular tabs are left alone", async () => {
  const text = "Alpha beta gamma.\n\nDelta epsilon.\n";
  const tab = await sharedTab({ text });
  const mounted = mountCodeMirror(tab.session, tab.registry);
  try {
    const base = tab.session.replica.text();
    // While the AI was thinking, a collaborator edited before the passage and inside another one.
    tab.session.replica.ytext.insert(0, "Intro. ");
    const result = suggestAiOnSharedTab(tab.registry, "Shared/note.md", base, { start: 6, end: 10, before: "beta", after: "BETA" }, "rewrite");
    assert.ok(result?.ok && result.matched === 1 && result.conflicted === 0, JSON.stringify(result));
    const record = listSuggestions(tab.session.replica.annotations)[0] as SuggestionRecord;
    const resolved = resolveSuggestion(tab.session.replica.ytext, record);
    assert.deepEqual([resolved.start, resolved.currentText, record.replacement, record.actor.kind], ["Intro. Alpha ".length, "beta", "BETA", "ai"]);
    assert.equal(tab.session.replica.text(), "Intro. Alpha beta gamma.\n\nDelta epsilon.\n", "the text keeps only the human edit");

    const baseTwo = tab.session.replica.text();
    tab.session.replica.ytext.delete(baseTwo.indexOf("epsilon"), 7);
    tab.session.replica.ytext.insert(baseTwo.indexOf("epsilon"), "zeta");
    const conflicted = suggestAiOnSharedTab(tab.registry, "Shared/note.md", baseTwo, { start: baseTwo.indexOf("epsilon"), end: baseTwo.indexOf("epsilon") + 7, before: "epsilon", after: "EPSILON" }, "format");
    assert.ok(conflicted?.ok && conflicted.conflicted === 1, "a passage that changed meanwhile becomes a conflicted (stale) suggestion");
    await waitFor(() => previewSuggestions(mounted.view.state).length === 2, 3000, "both in the editor");
    assert.equal(suggestionsFor(tab.session).getSnapshot().groups.filter((group) => group.state === "stale").length, 1);

    assert.equal(suggestAiOnSharedTab(tab.registry, "Other/plain.md", "x", { start: 0, end: 1, before: "x", after: "y" }, "rewrite"), null, "a regular tab takes its own path");
  } finally {
    mounted.destroy();
    tab.close();
  }
});

test("the Suggestions panel lists, filters, groups, steps with the keyboard and offers author-only actions", async () => {
  const text = "One. Two. Three. Four.\n";
  const api = recordingApi();
  const tab = await sharedTab({ text, api });
  const remote = tab.harness.replica();
  const { SuggestionsPanel } = await import("../../src/components/libera/collab/suggestions");
  const mounted = mountCodeMirror(tab.session, tab.registry);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await remote.whenAttached();
    setLocalUser(remote.awareness, BOB);
    const controller = suggestionsFor(tab.session);
    // Mine (Ada), Bob's, and a linked pair from AI acting for Bob.
    controller.suggest(0, 4, "Uno.");
    createSuggestion(remote.annotations, { ytext: remote.ytext, start: 5, end: 9, replacement: "Dos.", actor: bobUser, id: "sg-panel-bob-1" });
    createSuggestion(remote.annotations, { ytext: remote.ytext, start: 10, end: 16, replacement: "Tres.", actor: bobAi, id: "sg-panel-ai-01", groupId: "run-panel" });
    createSuggestion(remote.annotations, { ytext: remote.ytext, start: 17, end: 22, replacement: "Cuatro.", actor: bobAi, id: "sg-panel-ai-02", groupId: "run-panel" });
    await waitFor(() => listSuggestions(tab.session.replica.annotations).length === 4, 3000, "the overlay");
    await act(async () => root.render(createElement(SuggestionsPanel, { session: tab.session })));
    await settle(30);
    const cards = () => [...host.querySelectorAll<HTMLElement>("[data-suggestion-group]")];
    await waitFor(() => cards().length === 3, 3000, "three groups");
    assert.deepEqual(cards().map((card) => card.querySelector('[data-testid="suggestion-author"]')?.textContent), ["Ada", "Bob", "AI · on behalf of Bob"]);
    assert.match(cards()[2].textContent ?? "", /2 linked changes/);

    // Author-only actions: Withdraw and Edit on Ada's own suggestion only.
    assert.ok(cards()[0].querySelector('[data-action="withdraw"]') && cards()[0].querySelector('[data-action="edit"]'));
    assert.equal(cards()[1].querySelector('[data-action="withdraw"]'), null);
    assert.equal(cards()[1].querySelector('[data-action="edit"]'), null);
    assert.deepEqual(controller.withdraw("sg-panel-bob-1"), [{ ok: false, reason: "not-owner" }], "the model refuses others' suggestions too");
    assert.equal(controller.edit("sg-panel-bob-1", "Hacked.").ok, false);

    // Filters: AI only, then Bob (his own and his AI's).
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Filter suggestions by author"]')!;
    await act(async () => { select.value = "ai"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.deepEqual(cards().map((card) => card.dataset.suggestionGroup), ["run-panel"]);
    await act(async () => { select.value = "user:bob"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.deepEqual(cards().map((card) => card.dataset.suggestionGroup), ["sg-panel-bob-1", "run-panel"]);
    await act(async () => { select.value = "all"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });

    // Keyboard stepping selects and reveals in the editor.
    const list = host.querySelector<HTMLElement>('[role="listbox"]')!;
    const key = async (name: string) => act(async () => { list.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true })); });
    await key("ArrowDown");
    await key("ArrowDown");
    assert.equal(host.querySelector('[aria-selected="true"]')?.getAttribute("data-suggestion-group"), "sg-panel-bob-1");
    assert.deepEqual([mounted.view.state.selection.main.from, mounted.view.state.selection.main.to], [5, 9], "the editor shows it");
    await key("k");
    assert.equal(host.querySelector('[aria-selected="true"]')?.getAttribute("data-suggestion-group"), cards()[0].dataset.suggestionGroup);
    await key("ArrowUp");
    assert.equal(host.querySelector('[aria-selected="true"]')?.getAttribute("data-suggestion-group"), "run-panel", "wraps around");

    // Edit my suggestion, then withdraw it.
    await act(async () => { cards()[0].querySelector<HTMLButtonElement>('[data-action="edit"]')!.click(); });
    const box = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit your suggestion"]')!;
    await typeInto(box, "Una.");
    await act(async () => { box.form!.requestSubmit(); });
    await settle(10);
    assert.equal(listSuggestions(tab.session.replica.annotations, { createdBy: "ada" })[0].replacement, "Una.");
    await act(async () => { cards()[0].querySelector<HTMLButtonElement>('[data-action="withdraw"]')!.click(); });
    await settle(10);
    assert.equal(listSuggestions(tab.session.replica.annotations, { createdBy: "ada" })[0].status, "withdrawn");

    // Accept all goes out with a checkpoint and every pending suggestion; Reject on one card.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-action="accept-all"]')!.click(); });
    await waitFor(() => api.decisions.length === 1, 2000, "accept-all");
    assert.equal(api.decisions[0].checkpoint, true);
    assert.deepEqual(api.decisions[0].decisions.map((decision) => decision.suggestionId).sort(), ["sg-panel-ai-01", "sg-panel-ai-02", "sg-panel-bob-1"]);
    await settle(10);
    assert.ok([...host.querySelectorAll("[data-outcome]")].some((element) => element.getAttribute("data-outcome") === "applied"), "outcomes show per suggestion");
    assert.ok(ADA.name);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    mounted.destroy();
    tab.close();
  }
});
