import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { useLiberaWorkspace } from "../../src/components/libera/use-libera-workspace";
import { emptyTree } from "../../src/components/libera/api-client";
import { applyGallery } from "../../src/components/libera/gallery-store";
import { createGalleryTab, galleryTabId, isGalleryTab, reconcileGalleryTabs, restoreGalleryTab } from "../../src/components/libera/gallery-tabs";
import { ImageViewer } from "../../src/components/libera/image-viewer";
import { emptyWorkspaceLibrary, emptyWorkspaceSession, parseWorkspaceLibrary, remapWorkspacePaths } from "../../src/lib/workspaces";
import { listCanvasPanes, visibleCanvasTabIds } from "../../src/lib/canvas-layout";
import { galleryRawUrl, type GalleryContents, type GalleryPhoto } from "../../src/lib/image-generation";
import type { LiberaFileNode, LiberaTree } from "../../src/lib/types";

const date = "2026-10-01T10:00:00.000Z";
const photo = (id: string, path: string, overrides: Partial<GalleryPhoto> = {}): GalleryPhoto => ({
  id, path, name: path.split("/").at(-1)!, folder: path.includes("/") ? path.split("/")[0] : "", albumIds: [],
  createdAt: date, updatedAt: date, size: 1234, starred: false, edited: false, ...overrides,
});
const gallery = (...photos: GalleryPhoto[]): GalleryContents => ({ root: "/test/gallery", albums: [], photos });

test("a gallery photo becomes a read-only image tab outside every notebook", () => {
  const tab = createGalleryTab(photo("p1", "Covers/fox.png"));
  assert.equal(tab.id, galleryTabId("p1"));
  assert.equal(tab.id, "gallery:p1");
  assert.equal(tab.file.path, tab.id, "the path cannot collide with a notebook path a notebook action would touch");
  assert.equal(tab.file.notebook, "");
  assert.equal(tab.file.fileType, "image");
  assert.equal(tab.file.name, "fox.png");
  assert.equal(tab.rawUrl, galleryRawUrl(photo("p1", "Covers/fox.png")));
  assert.match(tab.rawUrl!, /^\/api\/gallery\/raw\/Covers\/fox\.png\?v=/);
  assert.equal(tab.draft, tab.saved, "a photo tab is never dirty");
  assert.equal(tab.status, "clean");
  assert.equal(isGalleryTab(tab), true);
  const notebookFile: LiberaFileNode = { kind: "file", name: "a.png", path: "Notes/a.png", notebook: "Notes", fileType: "image", createdAt: date, updatedAt: date, size: 1 };
  assert.equal(isGalleryTab({ id: "Notes/a.png", file: notebookFile, draft: "", saved: "", status: "clean" }), false);
  assert.equal(isGalleryTab(undefined), false);
});

test("gallery tabs follow moves, renames and edits, and close when their photo is deleted", () => {
  const notebookTab = { id: "Notes/a.md", file: { kind: "file" as const, name: "a.md", path: "Notes/a.md", notebook: "Notes", fileType: "markdown" as const, createdAt: date, updatedAt: date, size: 1 }, draft: "x", saved: "x", status: "clean" as const };
  const fox = createGalleryTab(photo("p1", "fox.png"), { image: { zoom: 2 } });
  const owl = createGalleryTab(photo("p2", "owl.png"));
  const tabs = [notebookTab, fox, owl];

  const unchanged = reconcileGalleryTabs(tabs, [photo("p1", "fox.png"), photo("p2", "owl.png")]);
  assert.equal(unchanged.tabs, tabs, "nothing changed keeps the same array, so no re-render");
  assert.deepEqual(unchanged.closedTabIds, []);

  const moved = reconcileGalleryTabs(tabs, [photo("p1", "Covers/fox-final.png", { updatedAt: "2026-10-02T00:00:00.000Z", size: 99 })]);
  assert.deepEqual(moved.closedTabIds, [owl.id]);
  const movedFox = moved.tabs.find((tab) => tab.id === fox.id)!;
  assert.equal(movedFox.file.name, "fox-final.png");
  assert.equal(movedFox.file.size, 99);
  assert.match(movedFox.rawUrl!, /^\/api\/gallery\/raw\/Covers\/fox-final\.png\?v=2026-10-02/);
  assert.deepEqual(movedFox.viewState, { image: { zoom: 2 } }, "zoom and pan survive a move");
  assert.equal(moved.tabs[0], notebookTab, "notebook tabs are untouched");
});

test("saved gallery tabs restore from the gallery, drop when deleted, and validate in workspace data", () => {
  const saved = createGalleryTab(photo("p1", "fox.png"), { image: { panX: 4 } });
  const restored = restoreGalleryTab(saved, gallery(photo("p1", "Album/fox.png")))!;
  assert.equal(restored.file.path, saved.file.path);
  assert.match(restored.rawUrl!, /Album\/fox\.png/);
  assert.deepEqual(restored.viewState, { image: { panX: 4 } });
  assert.equal(restoreGalleryTab(saved, gallery(photo("p2", "owl.png"))), null);
  assert.equal(restoreGalleryTab(saved, null)?.id, saved.id, "an unreadable gallery keeps the tab until the next refresh");

  const session = { ...emptyWorkspaceSession(), tabs: [saved], activeTabId: saved.id };
  const library = { ...emptyWorkspaceLibrary(), librarySession: session };
  assert.equal(parseWorkspaceLibrary(JSON.parse(JSON.stringify(library))).librarySession?.tabs[0].gallery?.photoId, "p1");
  assert.throws(() => parseWorkspaceLibrary({ ...library, librarySession: { ...session, tabs: [{ ...saved, gallery: { photoId: 3 } }] } }), /invalid/);
  const remapped = remapWorkspacePaths(library, "gallery:p1", "Notes/elsewhere");
  assert.equal(remapped.librarySession?.tabs[0], saved, "notebook renames never rewrite a gallery tab");
});

test("the image viewer shows gallery photos without annotation tools", () => {
  const readOnly = renderToStaticMarkup(createElement(ImageViewer, { alt: "fox.png", filePath: "fox.png", src: "/api/gallery/raw/fox.png", annotatable: false }));
  assert.match(readOnly, /View only/);
  assert.doesNotMatch(readOnly, /data-viewer-tool="text"/);
  const annotatable = renderToStaticMarkup(createElement(ImageViewer, { alt: "a.png", filePath: "Notes/a.png", src: "/api/files/raw/Notes/a.png" }));
  assert.match(annotatable, /data-viewer-tool="text"/);
});

test("gallery photos open in tabs, split right and down, follow gallery changes, and survive a restart", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const note: LiberaFileNode = { kind: "file", name: "a.md", path: "Notes/a.md", notebook: "Notes", fileType: "markdown", createdAt: date, updatedAt: date, size: 5 };
  const tree: LiberaTree = { ...emptyTree(), root: "/test/gallery-tabs", notebooks: [{ kind: "notebook", name: "Notes", path: "Notes", emoji: "", color: "#7c6fba", groupId: null, createdAt: date, updatedAt: date, children: [note] }] };
  let disk = emptyWorkspaceLibrary();
  let galleryOnDisk = gallery(photo("p1", "fox.png"), photo("p2", "owl.png"));
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    requests.push(href);
    if (href.startsWith("/api/workspaces")) {
      if (init?.method === "PUT") { disk = parseWorkspaceLibrary(JSON.parse(String(init.body))); return Response.json({ saved: true }); }
      return Response.json(disk);
    }
    if (href.startsWith("/api/gallery")) return Response.json(galleryOnDisk);
    if (href.startsWith("/api/files?")) return Response.json({ file: note, content: "saved content" });
    if (href.startsWith("/api/tree")) return Response.json(tree);
    return Response.json({});
  };
  let workspace!: ReturnType<typeof useLiberaWorkspace>["workspace"];
  function Harness() { workspace = useLiberaWorkspace(true).workspace; return null; }
  let root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(async () => { root.render(createElement(StrictMode, null, createElement(Harness))); }); };
  const fox = galleryOnDisk.photos[0], owl = galleryOnDisk.photos[1];
  try {
    await render();
    await act(async () => { applyGallery(galleryOnDisk); });
    await act(async () => { await workspace.openFile(note); });
    assert.equal(workspace.selectedNotebookName, "Notes");

    await act(async () => { workspace.openGalleryPhoto(fox, "right"); });
    assert.equal(workspace.activeTabId, "gallery:p1");
    assert.equal(workspace.canvas.paneCount, 2);
    assert.deepEqual(visibleCanvasTabIds(workspace.canvas.layout), [note.path, "gallery:p1"]);
    assert.equal(workspace.canvas.layout.root.type === "split" && workspace.canvas.layout.root.direction, "row");
    assert.equal(workspace.selectedNotebookName, "Notes", "a gallery photo leaves the selected notebook alone");
    assert.deepEqual(workspace.recentFiles.map((file) => file.path), [note.path], "and stays out of recent files");

    await act(async () => { workspace.openGalleryPhoto(owl, "bottom"); });
    assert.equal(workspace.canvas.paneCount, 3);
    assert.deepEqual(visibleCanvasTabIds(workspace.canvas.layout), [note.path, "gallery:p1", "gallery:p2"]);
    assert.equal(workspace.activeTabId, "gallery:p2");

    // Opening a photo that is already open reuses its tab.
    await act(async () => { workspace.openGalleryPhoto(fox, "tab"); });
    assert.equal(workspace.tabs.filter((tab) => tab.id === "gallery:p1").length, 1);
    assert.equal(workspace.activeTabId, "gallery:p1");

    // The tab strip's "Open Below" works on photo tabs like any other tab.
    await act(async () => { workspace.canvas.closeOtherPanes(workspace.canvas.layout.focusedPaneId); });
    assert.equal(workspace.canvas.paneCount, 1);
    await act(async () => { workspace.canvas.splitPane(workspace.canvas.layout.focusedPaneId, "bottom", "gallery:p2"); });
    assert.deepEqual(visibleCanvasTabIds(workspace.canvas.layout), ["gallery:p1", "gallery:p2"]);
    // ⌘\ splits the focused photo's panel into an empty one.
    await act(async () => { workspace.canvas.splitPane(workspace.canvas.layout.focusedPaneId, "right"); });
    assert.equal(listCanvasPanes(workspace.canvas.layout.root).length, 3);

    // Saving a photo tab is a no-op, and nothing asks the notebook file API about it.
    await act(async () => { workspace.setActiveTabId("gallery:p1"); });
    await act(async () => { await workspace.saveActiveTab(); });
    assert.equal(workspace.activeTab?.status, "clean");
    assert.equal(workspace.selectedNotebookName, "Notes");
    assert.ok(!requests.some((href) => href.includes("gallery%3A") || href.includes("gallery:")), "no notebook API is asked about a gallery tab");

    // Moving the photo into an album folder in the gallery updates its tab.
    const movedFox = { ...fox, path: "Covers/fox.png", folder: "Covers" };
    await act(async () => { applyGallery(gallery(movedFox, owl)); });
    assert.match(workspace.tabs.find((tab) => tab.id === "gallery:p1")!.rawUrl!, /\/api\/gallery\/raw\/Covers\/fox\.png/);

    // Deleting a photo in the gallery closes its tab and its panel.
    await act(async () => { applyGallery(gallery(movedFox)); });
    assert.equal(workspace.tabs.some((tab) => tab.id === "gallery:p2"), false);
    assert.ok(!visibleCanvasTabIds(workspace.canvas.layout).includes("gallery:p2"));

    // Restart: the photo tab and its panel come back.
    galleryOnDisk = gallery(movedFox, owl);
    await act(async () => { applyGallery(galleryOnDisk); workspace.openGalleryPhoto(owl, "right"); });
    let checkpoint = "";
    window.liberaWorkspaces = { checkpoint: (body) => { checkpoint = body; return { saved: true }; } };
    await act(async () => { window.dispatchEvent(new dom.window.Event("pagehide")); });
    await act(async () => { root.unmount(); });
    window.localStorage.clear();
    disk = parseWorkspaceLibrary(JSON.parse(checkpoint));
    await act(async () => { applyGallery(gallery()); });
    root = createRoot(document.getElementById("root")!);
    await render();
    assert.deepEqual(workspace.tabs.map((tab) => tab.id).sort(), [note.path, "gallery:p1", "gallery:p2"].sort());
    assert.equal(workspace.activeTabId, "gallery:p2");
    assert.ok(visibleCanvasTabIds(workspace.canvas.layout).includes("gallery:p2"));
    assert.match(workspace.tabs.find((tab) => tab.id === "gallery:p1")!.rawUrl!, /Covers\/fox\.png/);

    // Restart after the photo was deleted while Libera was closed: its tab is dropped.
    await act(async () => { root.unmount(); });
    galleryOnDisk = gallery(movedFox);
    root = createRoot(document.getElementById("root")!);
    await render();
    assert.deepEqual(workspace.tabs.map((tab) => tab.id).sort(), [note.path, "gallery:p1"].sort());
    assert.ok(workspace.tabs.some((tab) => tab.id === workspace.activeTabId));
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = originalFetch;
    delete window.liberaWorkspaces;
    dom.window.close();
  }
});
