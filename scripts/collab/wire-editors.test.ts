import { dom } from "./support/wire-dom";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { act, createElement, createRef, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { undo as historyUndo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { sharedCodeMirrorSource } from "../../src/lib/collab/bindings/react-codemirror";
import { SharedMarkdownSourceEditor } from "../../src/lib/collab/bindings/react-markdown-source";
import { applyTextToShared } from "../../src/lib/collab/client/apply-text";
import type { LatexEditorHandle } from "../../src/components/libera/latex/latex-editor";
import { createHarness } from "./support/wire-harness";
import { waitFor } from "./support/host-helpers";

after(() => dom.window.close());

async function settle(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function sharedSession(text: string, kind: "latex" | "markdown", path: string) {
  const harness = createHarness({ text });
  const { registry } = harness.registry({ paths: [path], kind });
  await registry.bindTab(path, path);
  const session = registry.sessionForTab(path)!;
  await session.replica.whenAttached();
  return { harness, registry, session };
}

/** Records every change a view receives, to tell minimal changes from whole-document replacements. */
function recordChanges(view: EditorView) {
  const changes: Array<{ from: number; to: number; insert: string; docLength: number }> = [];
  const dispatch = view.dispatch.bind(view);
  (view as { dispatch: (...args: never[]) => void }).dispatch = (...args: never[]) => {
    const docLength = view.state.doc.length;
    dispatch(...(args as Parameters<EditorView["dispatch"]>));
    const spec = args[0] as { changes?: unknown };
    const list = Array.isArray(spec?.changes) ? spec.changes : spec?.changes ? [spec.changes] : [];
    for (const change of list as Array<{ from: number; to?: number; insert?: string }>) changes.push({ from: change.from, to: change.to ?? change.from, insert: String(change.insert ?? ""), docLength });
  };
  return changes;
}

test("the LaTeX editor in collab mode edits the Y.Text and takes remote edits as minimal changes, keeping the caret", async () => {
  const source = "\\section{Intro}\nHello world.\n\\section{Next}\nMore text.\n";
  const { harness, session } = await sharedSession(source, "latex", "Thesis/main.tex");
  const { LatexEditor } = await import("../../src/components/libera/latex/latex-editor");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const editorRef = { current: null as LatexEditorHandle | null };
  const registered: unknown[] = [];
  const analysed: string[] = [];
  try {
    await act(async () => root.render(createElement(StrictMode, null, createElement(LatexEditor, {
      documentPath: "Thesis/main.tex", fileName: "main.tex", value: "a stale draft that must be ignored",
      fontFamily: "monospace", fontSizePx: 14, lineHeight: 1.6, diagnostics: [], project: { labels: [], bibEntries: [], files: [] }, editorRef,
      onChange: (text) => analysed.push(text), onEdit: () => {}, onCompile: () => {}, onForwardSync: () => {}, onAiError: () => {}, onAddSnippet: () => {},
      onViewStateChange: () => {}, onRegisterDraft: (read) => { registered.push(read); return () => {}; },
      collab: sharedCodeMirrorSource(session),
    }))));
    await settle(20);
    const view = editorRef.current!.view;
    assert.equal(view.state.doc.toString(), source, "the editor starts from the Y.Text, not the draft");
    assert.equal(registered.length, 0, "no draft reader: getTabDraft reads the replica");
    assert.equal(historyUndo(view), false, "no CodeMirror history on shared tabs");

    const caret = source.indexOf("world");
    await act(async () => view.dispatch({ selection: { anchor: caret } }));
    const changes = recordChanges(view);
    const remote = harness.replica();
    await remote.whenAttached();
    remote.ytext.insert(0, "% remote comment\n");
    await waitFor(() => view.state.doc.toString().startsWith("% remote comment\n"), 3000, "remote edit in the editor");
    assert.deepEqual(changes.map(({ from, to, insert }) => ({ from, to, insert })), [{ from: 0, to: 0, insert: "% remote comment\n" }], "one minimal change, no whole-document replacement");
    assert.equal(view.state.selection.main.head, caret + "% remote comment\n".length, "the caret moved with its text");

    await act(async () => view.dispatch({ changes: { from: view.state.doc.length, insert: "Typed." }, userEvent: "input.type" }));
    await waitFor(() => harness.hub.getText().endsWith("Typed."), 3000, "local edit at the hub");
    await waitFor(() => remote.text() === view.state.doc.toString(), 3000, "the other replica converged");
    session.undoManager.stopCapturing();
    session.undoManager.undo();
    assert.ok(!view.state.doc.toString().includes("Typed."), "Undo removes the local edit");
    assert.ok(view.state.doc.toString().startsWith("% remote comment"), "and never the collaborator's");
    await settle(300);
    assert.ok(analysed.length > 0, "the text still reaches the outline and compile analysis");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    harness.close();
  }
});

test("the Markdown Source editor of a shared tab binds the Y.Text (CodeMirror, whatever the Classic preference)", async () => {
  const { harness, session, registry } = await sharedSession("# Notes\n\nFirst line.\n", "markdown", "Shared/note.md");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let view: EditorView | null = null;
  try {
    await act(async () => root.render(createElement(SharedMarkdownSourceEditor, {
      collab: sharedCodeMirrorSource(session, registry),
      activeFilePath: "Shared/note.md", files: [], formatting: false, fontFamily: "monospace", fontSizePx: 14, imageConverting: false, lineHeightPx: 24,
      recentFiles: [], textareaRef: createRef<HTMLTextAreaElement>(),
      onAiFormatSelection: async () => {}, onAiImageToMarkdown: async () => {}, onAiRewriteSelection: async () => {}, onAiWriteAt: async () => {},
      onInsertFileLink: () => {}, onInsertImageFile: async () => {},
      onViewChange: (next) => { view = next; },
    })));
    await waitFor(() => view !== null, 5000, "the lazily loaded editor");
    await settle(20);
    const live = view as unknown as EditorView;
    assert.equal(live.state.doc.toString(), "# Notes\n\nFirst line.\n");
    await act(async () => live.dispatch({ changes: { from: live.state.doc.length, insert: "Second line.\n" }, userEvent: "input.type" }));
    assert.equal(session.replica.text(), "# Notes\n\nFirst line.\nSecond line.\n", "typing goes to the Y.Text");
    harness.hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "<!-- remote -->\n"));
    await waitFor(() => live.state.doc.toString().startsWith("<!-- remote -->"), 3000, "remote edit in the Source editor");

    // AI Rewrite in Source mode: the workspace computed the result from the
    // draft it read before the request, then applies it to the shared tab.
    const before = session.replica.text();
    await act(async () => live.dispatch({ changes: { from: live.state.doc.length, insert: "draft " }, userEvent: "input.type" }));
    const base = session.replica.text();
    const rewritten = base.replace("First line.", "The first line, rewritten.");
    const seen: unknown[] = [];
    harness.hub.observe("content", (change) => { if (change.origin === "replica") seen.push(change.provenance); });
    await act(async () => { applyTextToShared({ id: "Shared/note.md" }, rewritten, { source: "ai", feature: "rewrite" }, { registry, base }); });
    assert.equal(live.state.doc.toString(), rewritten, "the editor shows the AI result");
    await waitFor(() => seen.some((provenance) => (provenance as { source?: string })?.source === "ai"), 3000, "ai provenance at the hub");
    assert.deepEqual(seen.find((provenance) => (provenance as { source?: string })?.source === "ai"), { source: "ai", feature: "rewrite" });

    // Mod-z in the editor: one step removes exactly the AI result.
    await act(async () => {
      live.contentDOM.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", code: "KeyZ", keyCode: 90, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(live.state.doc.toString(), base, "one undo step: the AI rewrite only, the typing stays");
    assert.ok(base.endsWith("draft ") && base.startsWith(before.slice(0, 10)));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    harness.close();
  }
});

test("useSharedTabs binds shared notebook tabs, mirrors their text and releases closed tabs", async () => {
  const { useSharedTabs } = await import("../../src/lib/collab/bindings/react-shared-tabs");
  const { setSharedDocRegistry } = await import("../../src/lib/collab/client/registry");
  const { setCollabStatusStore } = await import("../../src/lib/collab/ui/status-store");
  const harness = createHarness({ text: "shared body" });
  const { registry, resolveCalls } = harness.registry();
  setSharedDocRegistry(registry);
  const snapshot = { phase: "ready" as const, status: { hostVersion: 1, connection: "connected" as const, account: { id: "u1", email: "ada@example.test", displayName: "Ada", color: "#ff8800", serverUrl: "" }, projects: [{ projectId: "p1", name: "Shared", role: "editor" as const, notebook: "Shared", revoked: false, reconcilePending: 0 }], pendingCommands: 0 } };
  setCollabStatusStore({ subscribe: () => () => {}, getSnapshot: () => snapshot, refresh: async () => {}, refreshProjects: async () => {}, setStatus: () => {} });
  const file = (path: string, notebook: string) => ({ kind: "file" as const, name: path, path, notebook, fileType: "markdown" as const, createdAt: "", updatedAt: "", size: 0 });
  const sharedTab = { id: "Shared/note.md", draft: "disk copy", saved: "disk copy", status: "clean" as const, file: file("Shared/note.md", "Shared") };
  const plainTab = { id: "Other/plain.md", draft: "x", saved: "x", status: "clean" as const, file: file("Other/plain.md", "Other") };
  const texts: Array<[string, string]> = [];
  let shared: ReadonlySet<string> = new Set();
  function Probe({ tabs }: { tabs: typeof plainTab[] }) {
    shared = useSharedTabs(tabs, { onText: (tabId, text) => texts.push([tabId, text]) });
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Probe, { tabs: [sharedTab, plainTab] })));
    await waitFor(() => texts.length > 0, 3000, "first mirror");
    await settle(10);
    assert.deepEqual(texts[0], ["Shared/note.md", "shared body"]);
    assert.deepEqual([...shared], ["Shared/note.md"]);
    assert.deepEqual(resolveCalls, ["Shared/note.md"], "tabs outside shared notebooks are never resolved");
    assert.equal(registry.localUser.name, "Ada", "presence uses the collaboration account");
    harness.hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "edited: "));
    await waitFor(() => texts.at(-1)?.[1] === "edited: shared body", 3000, "debounced mirror of a remote edit");
    const session = registry.sessionForTab("Shared/note.md")!;
    await act(async () => root.render(createElement(Probe, { tabs: [plainTab] })));
    await settle(10);
    assert.equal(registry.isSharedTab("Shared/note.md"), false);
    assert.equal(session.replica.isDestroyed, true, "closing the tab releases its replica");
  } finally {
    await act(async () => root.unmount());
    setCollabStatusStore(null);
    setSharedDocRegistry(null);
    harness.close();
  }
});
