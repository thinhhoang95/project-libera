import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { ReferenceMoveResult } from "../../src/lib/references/moves";
import { REFERENCES_UPDATED_EVENT, type ReferencesUpdatedDetail } from "../../src/lib/references/types";
import type { LiberaFileNode } from "../../src/lib/types";

// The workspace side of moves-ui: a Markdown file moved to another notebook
// whose citations the server renamed (src/lib/references/moves.ts) updates its
// open tab (the saved copy, and the draft through the same key map), tells the
// destination's References panel to reload, and shows a notice. The citation
// rewrite dialog uses the same tab helpers (apply and revert). Fetch is mocked.

const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "CustomEvent", "Node", "Element"] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
after(() => dom.window.close());

let m: {
  useLiberaWorkspace: typeof import("../../src/components/libera/use-libera-workspace").useLiberaWorkspace;
  createRoot: typeof import("react-dom/client").createRoot;
  emptyTree: typeof import("../../src/components/libera/api-client").emptyTree;
  emptyWorkspaceLibrary: typeof import("../../src/lib/workspaces").emptyWorkspaceLibrary;
  referenceMoveSummary: typeof import("../../src/components/libera/references/reference-move-notice").referenceMoveSummary;
};
before(async () => {
  const [workspace, client, api, workspaces, notice] = await Promise.all([
    import("../../src/components/libera/use-libera-workspace"),
    import("react-dom/client"),
    import("../../src/components/libera/api-client"),
    import("../../src/lib/workspaces"),
    import("../../src/components/libera/references/reference-move-notice"),
  ]);
  m = { useLiberaWorkspace: workspace.useLiberaWorkspace, createRoot: client.createRoot, emptyTree: api.emptyTree, emptyWorkspaceLibrary: workspaces.emptyWorkspaceLibrary, referenceMoveSummary: notice.referenceMoveSummary };
});

const NOW = "2026-10-18T00:00:00.000Z";

function fileNode(path: string): LiberaFileNode {
  return { kind: "file", fileType: "markdown", path, notebook: path.split("/")[0], name: path.split("/").at(-1)!, createdAt: NOW, updatedAt: NOW, size: 10 };
}

function moveResult(patch: Partial<ReferenceMoveResult> = {}): ReferenceMoveResult {
  return { copied: [], reused: [], renamed: [], drafts: [], destinationRevision: null, ...patch };
}

type Workspace = ReturnType<typeof m.useLiberaWorkspace>["workspace"];

async function mountWorkspace(files: Record<string, string>, onPatch: (body: Record<string, unknown>) => unknown) {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    requests.push({ url, method, body });
    if (url.startsWith("/api/files?path=")) {
      const path = new URL(url, "http://localhost").searchParams.get("path")!;
      return Response.json({ file: fileNode(path), content: files[path] ?? "" });
    }
    if (url === "/api/files" && method === "PATCH") return Response.json(onPatch(body));
    if (url.startsWith("/api/workspaces")) return Response.json(method === "PUT" ? { saved: true } : m.emptyWorkspaceLibrary());
    return Response.json({ ...m.emptyTree(), root: "/test/moves-ui" });
  }) as typeof fetch;
  let workspace!: Workspace;
  function Harness() { workspace = m.useLiberaWorkspace(true).workspace; return null; }
  const root = m.createRoot(document.getElementById("root")!);
  await act(async () => { root.render(createElement(Harness)); });
  return {
    get workspace() { return workspace; },
    requests,
    async cleanup() {
      await act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
    },
  };
}

function tab(workspace: Workspace, path: string) {
  return workspace.tabs.find((item) => item.id === path);
}

test("a move with renamed keys rewrites the open dirty tab's draft, takes the server's content as saved, reloads the destination and shows a notice", async () => {
  const saved = "Intro [@smith2020].\n";
  const moved = "Intro [@smith2020a].\n";
  const harness = await mountWorkspace({ "Alpha/note.md": saved }, (body) => ({
    file: fileNode(`${body.destinationDirectory}/note.md`),
    content: moved,
    references: moveResult({
      copied: [{ key: "smith2020a", entryId: "ref_new" }, { key: "lee2021", entryId: "ref_lee" }, { key: "doe2019", entryId: "ref_doe" }],
      renamed: [{ from: "smith2020", to: "smith2020a", files: ["Beta/note.md"] }],
      drafts: [{ path: "Beta/note.md", map: { smith2020: "smith2020a" } }],
      destinationRevision: 7,
    }),
  }));
  const announced: ReferencesUpdatedDetail[] = [];
  const listener = (event: Event) => announced.push((event as CustomEvent<ReferencesUpdatedDetail>).detail);
  window.addEventListener(REFERENCES_UPDATED_EVENT, listener);
  try {
    await act(async () => { await harness.workspace.openFile(fileNode("Alpha/note.md")); });
    await act(async () => { harness.workspace.setActiveDraft(`${saved}More on [@smith2020, p. 3] and [-@smith2020].\n`); });
    assert.equal(tab(harness.workspace, "Alpha/note.md")?.status, "dirty");

    // A dirty tab asks first; the move then goes ahead with the unsaved text.
    await act(async () => { await harness.workspace.moveFileToFolder(fileNode("Alpha/note.md"), "Beta"); });
    assert.equal(harness.workspace.workspaceConfirmDialog?.mode, "move-file-folder");
    await act(async () => { await harness.workspace.submitWorkspaceConfirmDialog(); });
    const movedTab = tab(harness.workspace, "Beta/note.md");
    assert.ok(movedTab, "the tab follows the file");
    assert.equal(movedTab.saved, moved, "the saved copy is the server's rewritten content");
    assert.equal(movedTab.draft, `${moved}More on [@smith2020a, p. 3] and [-@smith2020a].\n`, "unsaved text gets the same key map");
    assert.equal(movedTab.status, "dirty");
    assert.equal(harness.workspace.readOpenTabDraft("Beta/note.md"), movedTab.draft);
    assert.deepEqual(announced, [{ notebook: "Beta", revision: 7 }]);
    assert.equal(harness.workspace.referenceMoveNotice?.tone, "info");
    assert.equal(harness.workspace.referenceMoveNotice?.text, "Copied 3 references to Beta · 1 key renamed (smith2020 → smith2020a)");
    await act(async () => { harness.workspace.dismissReferenceMoveNotice(); });
    assert.equal(harness.workspace.referenceMoveNotice, null);
  } finally {
    window.removeEventListener(REFERENCES_UPDATED_EVENT, listener);
    await harness.cleanup();
  }
});

test("a clean tab simply shows the new content; a failed copy is a warning and the move still happens", async () => {
  const harness = await mountWorkspace({ "Alpha/a.md": "See [@x].\n", "Alpha/b.md": "See [@y].\n" }, (body) => body.path === "Alpha/a.md"
    ? { file: fileNode("Beta/a.md"), content: "See [@x2].\n", references: moveResult({ copied: [{ key: "x2", entryId: "e" }], renamed: [{ from: "x", to: "x2", files: ["Beta/a.md"] }], drafts: [{ path: "Beta/a.md", map: { x: "x2" } }], destinationRevision: 2 }) }
    : { file: fileNode("Beta/sub/b.md"), content: "See [@y].\n", references: moveResult({ error: "The destination library could not be written." }) });
  try {
    await act(async () => { await harness.workspace.openFile(fileNode("Alpha/a.md")); });
    await act(async () => { await harness.workspace.moveFileToFolder(fileNode("Alpha/a.md"), "Beta"); });
    const a = tab(harness.workspace, "Beta/a.md")!;
    assert.equal(a.draft, "See [@x2].\n");
    assert.equal(a.saved, "See [@x2].\n");
    assert.equal(a.status, "clean");

    await act(async () => { await harness.workspace.openFile(fileNode("Alpha/b.md")); });
    await act(async () => { await harness.workspace.moveFileToFolder(fileNode("Alpha/b.md"), "Beta/sub"); });
    const b = tab(harness.workspace, "Beta/sub/b.md")!;
    assert.equal(b.draft, "See [@y].\n", "no map: the tab is unchanged");
    assert.equal(b.status, "clean");
    assert.equal(harness.workspace.referenceMoveNotice?.tone, "warning");
    assert.match(harness.workspace.referenceMoveNotice?.text ?? "", /^Moved, but the references it cites could not be copied to Beta: The destination library could not be written\.$/);
  } finally {
    await harness.cleanup();
  }
});

test("a citation rewrite reaches an open tab and its undo restores the draft and reloads the saved copy", async () => {
  const files: Record<string, string> = { "Notes/draft.md": "Saved [@old].\n" };
  const harness = await mountWorkspace(files, () => ({}));
  try {
    await act(async () => { await harness.workspace.openFile(fileNode("Notes/draft.md")); });
    await act(async () => { harness.workspace.setActiveDraft("Saved [@old].\nTyped [@old].\n"); });
    let change: { before: string; after: string } | null = null;
    await act(async () => { change = harness.workspace.applyCitationRewriteToTab("Notes/draft.md", { old: "new" }, { savedRewritten: true }); });
    assert.deepEqual(change, { before: "Saved [@old].\nTyped [@old].\n", after: "Saved [@new].\nTyped [@new].\n" });
    let current = tab(harness.workspace, "Notes/draft.md")!;
    assert.equal(current.saved, "Saved [@new].\n");
    assert.equal(current.draft, "Saved [@new].\nTyped [@new].\n");
    assert.equal(current.status, "dirty");
    assert.equal(harness.workspace.applyCitationRewriteToTab("Notes/closed.md", { old: "new" }, { savedRewritten: true }), null, "files not open are left to the server");

    await act(async () => { await harness.workspace.revertCitationRewriteInTab("Notes/draft.md", change!, { refreshSaved: true }); });
    current = tab(harness.workspace, "Notes/draft.md")!;
    assert.equal(current.saved, "Saved [@old].\n", "the restored file is read back");
    assert.equal(current.draft, "Saved [@old].\nTyped [@old].\n");

    // A draft edited after the rewrite keeps the edit.
    await act(async () => { change = harness.workspace.applyCitationRewriteToTab("Notes/draft.md", { old: "new" }, { savedRewritten: false }); });
    await act(async () => { harness.workspace.setActiveDraft("Edited since."); });
    await act(async () => { await harness.workspace.revertCitationRewriteInTab("Notes/draft.md", change!, { refreshSaved: false }); });
    assert.equal(tab(harness.workspace, "Notes/draft.md")!.draft, "Edited since.");
  } finally {
    await harness.cleanup();
  }
});

test("move notice texts", () => {
  assert.equal(m.referenceMoveSummary(moveResult(), "Beta"), null);
  assert.equal(m.referenceMoveSummary(moveResult({ copied: [{ key: "a", entryId: "1" }] }), "Beta")?.text, "Copied 1 reference to Beta");
  assert.equal(m.referenceMoveSummary(moveResult({ reused: [{ key: "a", destinationKey: "a" }, { key: "b", destinationKey: "b" }] }), "Beta")?.text, "Beta already had the 2 references it cites");
  const renamed = [1, 2, 3, 4].map((index) => ({ from: `k${index}`, to: `k${index}a`, files: [] }));
  assert.equal(m.referenceMoveSummary(moveResult({ renamed }), "Beta")?.text, "4 keys renamed (k1 → k1a, k2 → k2a, k3 → k3a, +1 more)");
});
