import { dom } from "./edlib-dom";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { captureWorkspaceSession } from "../../src/lib/workspaces";
import { applyTextToShared, minimalEdits, rebasedEdits } from "../../src/lib/collab/client/apply-text";
import { dirtyDocumentCount, isShareableTab, isTabDirty, journalTab, mayTakeContentFromDisk, readTabDraft, sourceEditorKind } from "../../src/lib/collab/client/workspace";
import { SharedDocRegistry } from "../../src/lib/collab/client/registry";
import type { HostEvent, ResolvedDoc } from "../../src/lib/collab/local-api";
import type { OpenTab } from "../../src/components/libera/types";
import { createHarness } from "./support/wire-harness";
import { settle, waitFor } from "./support/host-helpers";

after(() => dom.window.close());

function tab(id: string, draft: string, saved = draft, notebook = "Shared"): OpenTab {
  return {
    id, draft, saved, status: draft === saved ? "clean" : "dirty",
    file: { kind: "file", name: id.split("/").at(-1)!, path: id, notebook, fileType: "markdown", createdAt: "", updatedAt: "", size: 0 },
  };
}

test("the registry keeps one replica per document across the tab and two panels", async () => {
  const harness = createHarness({ text: "shared text" });
  try {
    const { registry, resolved, ports } = harness.registry();
    const state = await registry.bindTab("Shared/note.md", "Shared/note.md");
    assert.equal(state.kind, "shared");
    const panelA = registry.acquire(resolved, "panel:a");
    const panelB = registry.acquire(resolved, "panel:b");
    await Promise.all([panelA.ready, panelB.ready]);
    assert.equal(ports.length, 1, "one attach for three holders");
    assert.deepEqual(registry.holders("d1").sort(), ["panel:a", "panel:b", "tab:Shared/note.md"]);
    const session = registry.sessionForTab("Shared/note.md")!;
    await session.replica.whenAttached();

    panelA.release();
    panelB.release();
    assert.equal(registry.session("d1"), session, "the tab still holds the replica after both panels close");
    registry.releaseTab("Shared/note.md");
    assert.equal(registry.session("d1"), null);
    assert.equal(session.replica.isDestroyed, true);
    assert.equal(ports[0].closed, true);
    await waitFor(() => harness.hub.replicaCount === 0, 3000, "hub detach");
  } finally {
    harness.close();
  }
});

test("resolution is cached, including 'not shared', until host events invalidate it", async () => {
  const harness = createHarness();
  try {
    const { registry, resolveCalls, emit } = harness.registry();
    assert.equal((await registry.bindTab("Other/plain.md", "Other/plain.md")).kind, "none");
    assert.equal(registry.isSharedTab("Other/plain.md"), false);
    await registry.bindTab("Other/plain.md", "Other/plain.md");
    await registry.resolvePath("Shared/note.md");
    await registry.resolvePath("Shared/note.md");
    assert.deepEqual(resolveCalls, ["Other/plain.md", "Shared/note.md"]);
    const version = registry.getVersion();
    emit({ t: "files-changed", projectId: "p1", paths: ["Shared/note.md"] });
    await registry.resolvePath("Shared/note.md");
    await settle();
    assert.deepEqual(resolveCalls, ["Other/plain.md", "Shared/note.md", "Shared/note.md"], "a working-copy write re-checks a shared path once, in the background");
    assert.equal(registry.getVersion(), version, "and tells no subscriber, so nothing re-renders");
    emit({ t: "files-changed", projectId: "p1", paths: ["Other/plain.md"] });
    await registry.resolvePath("Other/plain.md");
    await registry.resolvePath("Shared/note.md");
    assert.deepEqual(resolveCalls, ["Other/plain.md", "Shared/note.md", "Shared/note.md", "Other/plain.md"], "a changed path that was not shared is looked up again");
    emit({ t: "project-changed", projectId: "p1" });
    await registry.resolvePath("Other/plain.md");
    assert.equal(resolveCalls.at(-1), "Other/plain.md", "a project change can make an unshared path shared");
  } finally {
    harness.close();
  }
});

function revalidationRegistry(answer: (path: string, call: number) => ResolvedDoc | null | Promise<ResolvedDoc | null>) {
  let listener: ((event: HostEvent) => void) | null = null;
  let calls = 0;
  const registry = new SharedDocRegistry({
    resolve: async (path) => answer(path, (calls += 1)),
    attach: async () => { throw new Error("no attach in this test"); },
    subscribeEvents: (next) => { listener = next; return () => { listener = null; }; },
    available: () => true,
  });
  return { registry, calls: () => calls, emit: (event: HostEvent) => listener?.(event) };
}

const docA: ResolvedDoc = { docId: "dA", projectId: "p1", fileId: "f1", path: "Shared/note.md", kind: "markdown", role: "editor", readOnly: false };
const changed: HostEvent = { t: "files-changed", projectId: "p1", paths: ["Shared/note.md"] };

test("a working-copy write re-checks a shared path quietly and keeps an identical binding", async () => {
  const { registry, calls, emit } = revalidationRegistry(() => ({ ...docA }));
  try {
    await registry.resolvePath("Shared/note.md");
    const version = registry.getVersion();
    emit(changed);
    emit(changed);
    await settle();
    assert.equal(calls(), 2, "one lookup for the first resolve, one shared by both events");
    assert.equal(registry.getVersion(), version);
    assert.equal(registry.cachedResolution("Shared/note.md")?.docId, "dA");
  } finally { registry.destroy(); }
});

test("a path re-bound to another document is evicted and resolves to the new one", async () => {
  let current: ResolvedDoc | null = docA;
  const { registry, emit } = revalidationRegistry(() => current && { ...current });
  try {
    await registry.resolvePath("Shared/note.md");
    const version = registry.getVersion();
    current = { ...docA, docId: "dB" };
    emit(changed);
    await settle();
    assert.equal(registry.getVersion(), version + 1, "subscribers hear of it so tabs re-bind");
    assert.equal(registry.cachedResolution("Shared/note.md"), undefined);
    assert.equal((await registry.resolvePath("Shared/note.md"))?.docId, "dB");

    // A permission change counts too, and so does the path becoming unshared.
    current = { ...current, readOnly: true, revoked: true };
    emit(changed);
    await settle();
    assert.equal(registry.cachedResolution("Shared/note.md"), undefined);
    await registry.resolvePath("Shared/note.md");
    current = null;
    emit(changed);
    await settle();
    assert.equal(registry.cachedResolution("Shared/note.md"), undefined);
  } finally { registry.destroy(); }
});

test("a failed re-check keeps the cached entry, and a newer invalidation beats a slow one", async () => {
  let mode: "fail" | "slow" | "ok" = "ok";
  let release: (doc: ResolvedDoc) => void = () => {};
  const { registry, emit } = revalidationRegistry(() => {
    if (mode === "fail") throw new Error("host busy");
    if (mode === "slow") return new Promise<ResolvedDoc>((resolve) => { release = resolve; });
    return { ...docA };
  });
  try {
    await registry.resolvePath("Shared/note.md");
    const version = registry.getVersion();
    mode = "fail";
    emit(changed);
    await settle();
    assert.equal(registry.cachedResolution("Shared/note.md")?.docId, "dA");
    assert.equal(registry.getVersion(), version);

    mode = "slow";
    emit(changed);
    await settle();
    // The tree changed while the check was running: the fresh lookup wins.
    emit({ t: "project-changed", projectId: "p1" });
    mode = "ok";
    assert.equal((await registry.resolvePath("Shared/note.md"))?.docId, "dA");
    const after = registry.getVersion();
    release({ ...docA, docId: "dOld" });
    await settle();
    assert.equal(registry.cachedResolution("Shared/note.md")?.docId, "dA", "the late answer does not overwrite the newer entry");
    assert.equal(registry.getVersion(), after);
  } finally { registry.destroy(); }
});

test("deletion flushes the last editor batch and keeps a read-only recovery tab", async () => {
  const harness = createHarness({ text: "original" });
  try {
    const paths = ["Shared/note.md"];
    const { registry, emit } = harness.registry({ paths });
    await registry.bindTab(paths[0], paths[0]);
    const session = registry.sessionForTab(paths[0])!;
    await session.replica.whenAttached();
    session.replica.ytext.insert(0, "last frame ");
    paths.length = 0;
    emit({ t: "tree-changed", projectId: "p1", notebook: "Shared", added: [], moves: [], removed: ["Shared/note.md"] });
    assert.equal(session.replica.canEditContent(), false);
    assert.equal((await registry.bindTab("Shared/note.md", "Shared/note.md")).kind, "shared");
    await waitFor(() => harness.hub.getText() === "last frame original", 3000, "last batch persists locally");
    assert.equal(registry.readTabText("Shared/note.md"), "last frame original");
    paths.push("Shared/note.md");
    emit({ t: "files-changed", projectId: "p1", paths });
    await registry.bindTab(paths[0], paths[0]);
    assert.equal(registry.sessionForTab(paths[0]), session, "reusing a deleted path does not replace the recovery text");
  } finally { harness.close(); }
});

test("deletion while a tab is resolving cannot mount an editable local tab", async () => {
  const harness = createHarness({ text: "recover while opening" });
  try {
    const { registry, emit } = harness.registry();
    const opening = registry.bindTab("Shared/note.md", "Shared/note.md");
    emit({ t: "tree-changed", projectId: "p1", notebook: "Shared", added: [], moves: [], removed: ["Shared/note.md"] });
    assert.equal((await opening).kind, "shared");
    const session = registry.sessionForTab("Shared/note.md")!;
    await session.replica.whenAttached();
    assert.equal(session.replica.canEditContent(), false);
    assert.equal(session.replica.text(), "recover while opening");

    const missing = harness.registry({ paths: [] });
    const missingOpening = missing.registry.bindTab("Shared/gone.md", "Shared/gone.md");
    missing.emit({ t: "tree-changed", projectId: "p1", notebook: "Shared", added: [], moves: [], removed: ["Shared/gone.md"] });
    assert.equal((await missingOpening).kind, "error", "a removed path resolving to null cannot become an ordinary editor");
  } finally { harness.close(); }
});

test("getTabDraft reads the replica for shared tabs and the editor otherwise", async () => {
  const harness = createHarness({ text: "live shared text" });
  try {
    const { registry } = harness.registry();
    const shared = tab("Shared/note.md", "stale mirror");
    const plain = tab("Other/plain.md", "saved", "saved", "Other");
    const sources = { sharedText: (id: string) => registry.readTabText(id), editorDraft: (id: string) => (id === plain.id ? "typed" : undefined), latestDraft: () => undefined };
    assert.equal(readTabDraft(shared, sources), "stale mirror", "before the tab binds, the last draft");
    await registry.bindTab(shared.id, shared.file.path);
    await registry.sessionForTab(shared.id)!.replica.whenAttached();
    assert.equal(readTabDraft(shared, sources), "live shared text");
    harness.hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, ">> "));
    await waitFor(() => readTabDraft(shared, sources) === ">> live shared text", 3000, "remote edit visible to readers");
    assert.equal(readTabDraft(plain, sources), "typed");
  } finally {
    harness.close();
  }
});

test("minimal edits stay minimal and rebase over concurrent edits", () => {
  assert.deepEqual(minimalEdits("Hello world.\nSecond line.\n", "Hello world.\nThird line.\n"), [{ from: 13, to: 19, insert: "Third" }]);
  assert.deepEqual(minimalEdits("same", "same"), []);
  // The caller started from `base`; someone added a sentence at the start meanwhile.
  const base = "One. Two. Three.";
  const current = "Zero. One. Two. Three.";
  const next = "One. TWO. Three.";
  const edits = rebasedEdits(current, next, base);
  let text = current;
  for (const edit of [...edits].reverse()) text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  assert.equal(text, "Zero. One. TWO. Three.", "the concurrent sentence survives");
});

test("applyTextToShared produces minimal Y ops with the caller's provenance", async () => {
  const harness = createHarness({ text: "Hello world.\nSecond line.\n" });
  try {
    const { registry } = harness.registry();
    const shared = tab("Shared/note.md", "");
    await registry.bindTab(shared.id, shared.file.path);
    const session = registry.sessionForTab(shared.id)!;
    await session.replica.whenAttached();
    const deltas: unknown[] = [];
    session.replica.ytext.observe((event) => deltas.push(event.delta));
    const provenance: unknown[] = [];
    harness.hub.observe("content", (change) => { if (change.origin === "replica") provenance.push(change.provenance); });

    const result = applyTextToShared(shared, "Hello world.\nThird line.\n", { source: "paste" }, { registry });
    assert.equal(result.applied, true);
    assert.deepEqual(deltas, [[{ retain: 13 }, { delete: 6 }, { insert: "Third" }]], "one replacement, nothing else touched");
    await waitFor(() => provenance.length === 1);
    assert.deepEqual(provenance[0], { source: "paste" });
    assert.equal(harness.hub.getText(), "Hello world.\nThird line.\n");

    // An AI result computed from an older draft lands without undoing a collaborator's edit.
    const base = session.replica.text();
    harness.hub.applyLocalChange("content", (doc) => doc.getText("source").insert(0, "# Title\n"));
    await waitFor(() => session.replica.text().startsWith("# Title"));
    applyTextToShared(shared, base.replace("Third", "Fourth"), { source: "ai", feature: "rewrite" }, { registry, base });
    assert.equal(session.replica.text(), "# Title\nHello world.\nFourth line.\n");
    await waitFor(() => provenance.length === 2);
    assert.deepEqual(provenance[1], { source: "ai", feature: "rewrite" });

    assert.deepEqual(applyTextToShared(tab("Other/plain.md", ""), "x", { source: "typing" }, { registry }), { applied: false, reason: "not-shared" });
  } finally {
    harness.close();
  }
});

test("a programmatic write is one undo step on the tab's undo manager", async () => {
  const harness = createHarness({ text: "keep this. rewrite me." });
  try {
    const { registry } = harness.registry();
    const shared = tab("Shared/note.md", "");
    await registry.bindTab(shared.id, shared.file.path);
    const session = registry.sessionForTab(shared.id)!;
    await session.replica.whenAttached();
    applyTextToShared(shared, "keep this. REWRITTEN BY AI.", { source: "ai", feature: "rewrite" }, { registry });
    assert.equal(session.undoManager.undoStack.length, 1);
    session.undoManager.undo();
    assert.equal(session.replica.text(), "keep this. rewrite me.");
    await settle();
  } finally {
    harness.close();
  }
});

test("shared tabs: never dirty, zero for the updater, no text in the journals, no disk sync", () => {
  const shared = new Set(["Shared/a.md"]);
  const isShared = (id: string) => shared.has(id);
  const tabs = [tab("Shared/a.md", "edited", "old"), tab("Other/b.md", "edited", "old", "Other"), tab("Other/c.md", "same", "same", "Other")];
  assert.equal(isTabDirty(tabs[0], isShared), false);
  assert.equal(isTabDirty(tabs[1], isShared), true);
  assert.equal(dirtyDocumentCount(tabs, isShared), 1, "only the regular tab counts");
  assert.equal(dirtyDocumentCount([tabs[0]], isShared), 0);

  // The session journal and the workspaces:checkpoint file both store this capture.
  const journaled = captureWorkspaceSession(
    { tabs: tabs.map((item) => journalTab(item, isShared)), activeTabId: "Shared/a.md", selectedNotebookName: "", expandedPaths: [] } as never,
    (item) => (isShared(item.id) ? item.saved : item.draft),
  );
  const sharedEntry = journaled.tabs.find((item) => item.id === "Shared/a.md")!;
  assert.equal(sharedEntry.draft, "");
  assert.equal(sharedEntry.saved, "");
  assert.equal(sharedEntry.status, "clean");
  assert.ok(!JSON.stringify(journaled).includes("edited\",\"saved\":\"old\",\"status\":\"clean"), "no shared text in the journal");
  assert.equal(journaled.tabs.find((item) => item.id === "Other/b.md")!.draft, "edited");

  assert.equal(mayTakeContentFromDisk("Shared/a.md", isShared), false);
  assert.equal(mayTakeContentFromDisk("Other/b.md", isShared), true);
  assert.equal(sourceEditorKind("classic", true), "codemirror", "the textarea cannot bind");
  assert.equal(sourceEditorKind("classic", false), "classic");
  assert.equal(isShareableTab(tabs[0], new Set(["Shared"])), true);
  assert.equal(isShareableTab({ ...tabs[0], untitled: true }, new Set(["Shared"])), false);
});
