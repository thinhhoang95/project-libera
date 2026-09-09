import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownRenderer } from "../../src/components/markdown-renderer";
import { createRoot } from "react-dom/client";
import { useLiberaWorkspace } from "../../src/components/libera/use-libera-workspace";
import { emptyTree } from "../../src/components/libera/api-client";

test("untitled files edit, export, cancel, and save to a folder without losing in-flight edits", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  let posted: Record<string, string> | undefined;
  let finishSave: (() => void) | undefined;
  globalThis.fetch = async (url, init) => {
    if (url === "/api/files" && init?.method === "POST") {
      posted = JSON.parse(String(init.body));
      await new Promise<void>((resolve) => { finishSave = resolve; });
      return Response.json({ file: { kind: "file", fileType: "markdown", path: "Notes/Folder/My note.md", notebook: "Notes", name: "My note.md", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), size: 5 }, content: posted!.content });
    }
    return Response.json(emptyTree());
  };
  let workspace: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(false).workspace; return null; }
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { workspace.createUntitledFile(); });
    assert.equal(workspace!.activeTab!.draft, "");
    assert.equal(workspace!.activeTab!.untitled, true);
    assert.equal(posted, undefined);
    await act(async () => { await workspace.saveActiveTab(); });
    assert.equal(workspace!.saveDraftTab!.id, workspace!.activeTab!.id);
    await act(async () => { workspace.closeSaveDraftDialog(); workspace.setActiveDraft("hello"); });
    let exported = "";
    window.liberaExport = {
      exportMarkdownPdf: async (input) => { exported = input.content; return { canceled: true }; },
      saveMarkdownFile: async () => ({ canceled: true }),
    };
    await act(async () => { await workspace.downloadMarkdownPdf(workspace.activeTab!); });
    assert.equal(exported, "hello");
    await act(async () => { await workspace.saveActiveTab(); });
    await act(async () => { await workspace.submitSaveDraft("My note", ""); });
    assert.ok(workspace!.saveDraftTab);
    assert.equal(workspace!.activeTab!.saved, "");
    let savedInput: { content: string; saveId?: string } | undefined;
    window.liberaExport.saveMarkdownFile = async (input) => {
      savedInput = input;
      return { canceled: false, saveId: "chosen-file", fileName: "My note.md" };
    };
    await act(async () => { await workspace.submitSaveDraft("My note", ""); });
    assert.equal(workspace!.activeTab!.standaloneSaveId, "chosen-file");
    await act(async () => { workspace.setActiveDraft("updated standalone"); });
    await act(async () => { await workspace.saveActiveTab(); });
    assert.equal(savedInput!.saveId, "chosen-file");
    assert.equal(savedInput!.content, "updated standalone");
    assert.equal(workspace!.activeTab!.status, "clean");
    await act(async () => { workspace.setActiveDraft("hello"); await workspace.moveFileFromPrompt(workspace.activeTab!); });
    let save: Promise<void>;
    await act(async () => { save = workspace.submitSaveDraft("My note", "Notes/Folder"); });
    assert.equal(posted!.content, "hello");
    assert.equal(posted!.parentPath, "Notes/Folder");
    await act(async () => { workspace.setActiveDraft("hello while saving"); });
    await act(async () => { finishSave!(); await save; });
    assert.equal(workspace!.activeTab!.file.path, "Notes/Folder/My note.md");
    assert.equal(workspace!.activeTab!.untitled, false);
    assert.equal(workspace!.activeTab!.draft, "hello while saving");
    assert.equal(workspace!.activeTab!.saved, "hello");
    assert.equal(workspace!.activeTab!.status, "dirty");
    await act(async () => { workspace.closeTab(workspace.activeTab!.id); });
    assert.equal(workspace!.workspaceConfirmDialog!.mode, "close-tab");
  } finally {
    await act(async () => { root.unmount(); });
    dom.window.close();
    globalThis.fetch = originalFetch;
  }
});


test("embedded draft images render in preview and PDF markup without allowing unsafe links", () => {
  const source = "data:image/png;base64,aGVsbG8=";
  const html = renderToStaticMarkup(createElement(MarkdownRenderer, {
    content: `![Photo](${source})\n\n[Unsafe](javascript:alert%281%29)`,
    documentPath: "untitled.md",
  }));
  assert.ok(html.includes(`src="${source}"`));
  assert.ok(!html.includes('href="javascript:'));
});
