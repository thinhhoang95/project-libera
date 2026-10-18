import { dom } from "./support/wire-dom";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Editor } from "@tiptap/core";
import { createMarkdownExtensions } from "../../src/lib/tiptap-markdown";
import { TiptapCollabHistory } from "../../src/lib/collab/bindings/tiptap-history";
import { sharedVisualSource } from "../../src/lib/collab/bindings/react-visual";
import { applyTextToShared } from "../../src/lib/collab/client/apply-text";
import { createHarness } from "./support/wire-harness";
import { waitFor } from "./support/host-helpers";

after(() => dom.window.close());

test("the Visual editor builds from the Y.Text and undoes an AI rewrite in one step", async () => {
  const source = "# Notes\n\nKeep this paragraph.\n\nRewrite this paragraph.\n";
  const harness = createHarness({ text: source });
  const { registry } = harness.registry();
  await registry.bindTab("Shared/note.md", "Shared/note.md");
  const session = registry.sessionForTab("Shared/note.md")!;
  await session.replica.whenAttached();
  // Created empty, as tiptap-markdown-editor.tsx does on a shared tab.
  const editor = new Editor({ extensions: [...createMarkdownExtensions("Shared/note.md"), TiptapCollabHistory], content: "", contentType: "markdown" });
  const handle = sharedVisualSource(session).attach(editor);
  try {
    assert.match(editor.state.doc.textContent, /Keep this paragraph\.Rewrite this paragraph\./, "the bridge built the document");

    const seen: unknown[] = [];
    harness.hub.observe("content", (change) => { if (change.origin === "replica") seen.push(change.provenance); });
    const rewritten = source.replace("Rewrite this paragraph.", "An AI wrote this instead.");
    const result = applyTextToShared({ id: "Shared/note.md" }, rewritten, { source: "ai", feature: "rewrite" }, { registry });
    assert.equal(result.applied, true);
    await waitFor(() => editor.state.doc.textContent.includes("An AI wrote this instead."), 3000, "the AI result in Visual");
    await waitFor(() => seen.length > 0, 3000, "the AI edit at the hub");
    assert.deepEqual(seen[0], { source: "ai", feature: "rewrite" });

    assert.equal(session.undoManager.undoStack.length, 0, "only the Visual editor's history records it, so it cannot be undone twice");
    assert.equal(editor.commands.undo(), true, "Undo in Visual (toolbar and Mod-z route here)");
    assert.equal(session.replica.text(), source, "one step restores the text before the rewrite");
    await waitFor(() => editor.state.doc.textContent.includes("Rewrite this paragraph."), 3000, "Visual shows the undone text");
    await waitFor(() => harness.hub.getText() === source, 3000, "the undo reached the hub");
  } finally {
    handle.destroy();
    editor.destroy();
    harness.close();
  }
});

test("without a Visual editor, programmatic edits use the tab's shared undo manager", async () => {
  const harness = createHarness({ text: "one two" });
  try {
    const { registry } = harness.registry();
    await registry.bindTab("Shared/note.md", "Shared/note.md");
    const session = registry.sessionForTab("Shared/note.md")!;
    await session.replica.whenAttached();
    const editor = new Editor({ extensions: [...createMarkdownExtensions("Shared/note.md"), TiptapCollabHistory], content: "", contentType: "markdown" });
    const handle = sharedVisualSource(session).attach(editor);
    handle.destroy();
    editor.destroy();
    applyTextToShared({ id: "Shared/note.md" }, "one three", { source: "ai", feature: "format" }, { registry });
    assert.equal(session.undoManager.undoStack.length, 1);
  } finally {
    harness.close();
  }
});
