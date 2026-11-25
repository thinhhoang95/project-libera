import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { emptyWorkspaceLibrary, emptyWorkspaceSession, remapWorkspacePathsMany, trackWorkspaceFileChange, type WorkspaceLibrary } from "../../src/lib/workspaces";
import { useMarkdownWindows } from "../../src/components/libera/use-markdown-windows";
import { FILE_MOVE_CHANNEL_NAME, noteFilesMoved, readFileMoveMessage, remapMovedPath, subscribeOtherWindowMoves } from "../../src/components/libera/file-move-channel";
import { remapChatPaths, movedNotePaths } from "../../src/components/libera/document-chat-moves";
import { localFileIdentity } from "../../src/lib/storage/file-identity";
import type { OpenTab } from "../../src/components/libera/types";
import type { DocumentChat } from "../../src/lib/document-chat";
import type { LiberaFileNode } from "../../src/lib/types";

const date = "2026-11-25T00:00:00Z";
const node = (path: string, extra: Partial<LiberaFileNode> = {}): LiberaFileNode => ({ kind: "file", name: path.split("/").at(-1)!, notebook: path.split("/")[0], path, fileType: "markdown", size: 10, createdAt: date, updatedAt: date, ...extra });
const tab = (path: string, text = "text", extra: Partial<OpenTab> = {}, file: Partial<LiberaFileNode> = {}): OpenTab => ({ id: path, file: node(path, file), draft: text, saved: text, status: "clean", ...extra });
function library(sessions: OpenTab[][]): WorkspaceLibrary {
  const base = emptyWorkspaceLibrary();
  return { ...base, librarySession: { ...emptyWorkspaceSession(), tabs: sessions[0] }, workspaces: sessions.slice(1).map((tabs, index) => ({
    id: `w${index}`, name: `W${index}`, color: "#112233", scope: { mode: "all" as const, paths: [] }, session: { ...emptyWorkspaceSession(), tabs } })) };
}

test("U-H8: tabs landing on one path are deduped, keeping unsaved work", () => {
  const next = remapWorkspacePathsMany(library([[tab("A/a.md", "moved"), tab("A/b.md", "typed", { draft: "typed more", status: "dirty" })]]), [{ from: "A/a.md", to: "A/b.md" }]);
  const tabs = next.librarySession!.tabs;
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, "A/b.md");
  assert.equal(tabs[0].draft, "typed more");
  const clean = remapWorkspacePathsMany(library([[tab("A/a.md", "moved"), tab("A/b.md", "other")]]), [{ from: "A/a.md", to: "A/b.md" }]);
  assert.deepEqual(clean.librarySession!.tabs.map((item) => item.id), ["A/b.md"]);
});

test("U-H8: a text rewrite updates size, local fileId and the disk conflict", () => {
  const identity = localFileIdentity({ createdAt: date, size: 10 });
  const rewrite = (_path: string, text: string) => text.replaceAll("old", "newer-name");
  const conflicted = tab("A/n.md", "see old", { draft: "see old", diskConflict: { text: "see old" } }, { fileId: identity });
  const plain = tab("A/m.md", "see old", {}, { fileId: identity });
  const next = remapWorkspacePathsMany(library([[conflicted, plain]]), [{ from: "A/m.md", to: "B/m.md" }], rewrite);
  const [stayed, moved] = next.librarySession!.tabs;
  const bytes = new TextEncoder().encode("see newer-name").length;
  assert.equal(stayed.saved, "see newer-name");
  assert.equal(stayed.file.size, bytes);
  assert.equal(stayed.file.fileId, localFileIdentity({ createdAt: date, size: bytes }));
  assert.equal(stayed.diskConflict, undefined, "a conflict equal to the new baseline is gone");
  assert.equal(moved.id, "B/m.md");
  assert.equal(moved.file.size, bytes);
  assert.equal(moved.file.fileId, localFileIdentity({ createdAt: date, size: bytes }));
  // A conflict that still differs keeps its (rewritten) text.
  const differs = tab("A/n.md", "see old", { diskConflict: { text: "disk old" } });
  const kept = remapWorkspacePathsMany(library([[differs]]), [], rewrite).librarySession!.tabs[0];
  assert.deepEqual(kept.diskConflict, { text: "disk newer-name" });
  // Shared ids and PDFs keep theirs.
  const shared = tab("S/x.md", "old", {}, { fileId: "shared-id" });
  assert.equal(remapWorkspacePathsMany(library([[shared]]), [], rewrite).librarySession!.tabs[0].file.fileId, "shared-id");
});

test("U-H8: a fileId mismatch is judged per saved workspace", () => {
  const mine = localFileIdentity({ createdAt: date, size: 10 });
  const other = localFileIdentity({ createdAt: "2020-01-01T00:00:00Z", size: 3 });
  const lib = library([[tab("A/a.md", "x", {}, { fileId: other })], [tab("A/a.md", "x", {}, { fileId: mine })]]);
  const next = remapWorkspacePathsMany(lib, [{ from: "A/a.md", to: "A/b.md", fileId: mine }]);
  assert.equal(next.librarySession!.tabs[0].file.path, "A/a.md", "the workspace holding another file keeps it");
  assert.equal(next.workspaces[0].session.tabs[0].file.path, "A/b.md", "the workspace holding the moved file follows");
  const tracked = trackWorkspaceFileChange(lib, null, { moved: [{ from: "A/a.md", to: "A/b.md", fileId: mine }] });
  assert.equal(tracked.workspaces[0].session.tabs[0].id, "A/b.md");
});

test("U-H1: move messages from other windows are read, our own are ignored, folders remap", () => {
  const data = { sender: "elsewhere", moves: [{ from: "A/dir", to: "A/renamed" }, { bad: 1 }], links: { rewritten: [], skipped: [], unchecked: [] } };
  assert.deepEqual(readFileMoveMessage(data, "me")?.moves, [{ from: "A/dir", to: "A/renamed" }]);
  assert.equal(readFileMoveMessage({ ...data, sender: "me" }, "me"), null);
  assert.equal(readFileMoveMessage({ sender: "x", moves: [] }, "me"), null);
  assert.equal(remapMovedPath("A/dir/p.pdf", [{ from: "A/dir", to: "A/renamed" }]), "A/renamed/p.pdf");
  assert.equal(remapMovedPath("A/dirt/p.pdf", [{ from: "A/dir", to: "A/renamed" }]), "A/dirt/p.pdf");
});

test("U-H1: a window without a workspace (detached PDF/image) hears moves of other windows on every channel", async () => {
  const heard: Array<Array<{ from: string; to: string }>> = [];
  const stop = subscribeOtherWindowMoves((moves) => heard.push(moves));
  const post = async (name: string, message: unknown) => {
    const channel = new BroadcastChannel(name);
    channel.postMessage(message);
    channel.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  try {
    await post(FILE_MOVE_CHANNEL_NAME, { sender: "other", moves: [{ from: "A/p.pdf", to: "A/q.pdf" }] });
    await post("libera-notebook-repair", { sender: "other", moves: [{ from: "A/q.pdf", to: "A/r.pdf" }] });
    await post("libera-notebook-migration", { id: "m", moved: [{ from: "A/r.pdf", to: "B/r.pdf" }], folders: [{ from: "A/d", to: "B/d" }] });
    assert.deepEqual(heard, [[{ from: "A/p.pdf", to: "A/q.pdf" }], [{ from: "A/q.pdf", to: "A/r.pdf" }], [{ from: "A/d", to: "B/d" }, { from: "A/r.pdf", to: "B/r.pdf" }]]);
  } finally { stop(); }
});

test("U-H1: a detached Markdown preview keeps finding its document after a move or rename", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const before = node("Book/note.md");
  const posts: Array<{ content?: string; error?: string; documentPath?: string }> = [];
  const child = { closed: false, postMessage: (data: { content?: string; error?: string; documentPath?: string }) => posts.push(data) };
  dom.window.open = () => child as unknown as Window;
  let tabs: OpenTab[] = [tab(before.path, "draft")];
  let open!: ReturnType<typeof useMarkdownWindows>;
  function Harness() { open = useMarkdownWindows(tabs, (item) => item.draft, () => undefined); return null; }
  const root = createRoot(document.getElementById("root")!);
  const oldFetch = globalThis.fetch;
  try {
    await act(async () => root.render(createElement(Harness)));
    open(before);
    // The tab follows the move (new id and path); the preview refreshes afterwards.
    tabs = [tab("Book/renamed/note2.md", "draft after")];
    await act(async () => { noteFilesMoved([{ from: "Book/note.md", to: "Book/renamed/note2.md" }]); await root.render(createElement(Harness)); });
    globalThis.fetch = async () => { throw new Error("must not fetch while the tab is open"); };
    await act(async () => { dom.window.dispatchEvent(new dom.window.MessageEvent("message", { origin: "http://localhost", source: child as unknown as Window, data: { type: "libera-markdown-refresh", requestId: 1 } })); });
    assert.equal(posts[0].error, undefined);
    assert.equal(posts[0].content, "draft after");
    assert.equal(posts[0].documentPath, "Book/renamed/note2.md");
  } finally {
    globalThis.fetch = oldFetch;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("U-M5: chat contexts follow moves and renames", () => {
  const chat: DocumentChat = {
    id: "c", title: "t", prompt: "", messages: [{ id: "m", role: "user", text: "hi", contexts: [{ kind: "document", path: "A/old.pdf", name: "old.pdf", text: "" }] }],
    selections: [
      { kind: "document", path: "A/old.pdf", name: "old.pdf", text: "" },
      { kind: "document", path: "A/dir/n.md", name: "n.md", text: "stale text" },
      { kind: "selection", path: "A/other.md", name: "other.md", text: "quote" },
    ],
    excludedDocumentPaths: ["A/dir/n.md"], excludedCommentPaths: ["A/old.pdf"], documentPages: { "A/old.pdf": 3 },
  };
  const moves = [{ from: "A/old.pdf", to: "A/new.pdf" }, { from: "A/dir", to: "B/dir" }];
  const next = remapChatPaths(chat, moves);
  assert.deepEqual(next.selections.map((item) => [item.path, item.name]), [["A/new.pdf", "new.pdf"], ["B/dir/n.md", "n.md"], ["A/other.md", "other.md"]]);
  assert.equal(next.messages[0].contexts![0].path, "A/new.pdf");
  assert.deepEqual(next.excludedDocumentPaths, ["B/dir/n.md"]);
  assert.deepEqual(next.excludedCommentPaths, ["A/new.pdf"]);
  assert.deepEqual(next.documentPages, { "A/new.pdf": 3 });
  assert.deepEqual(movedNotePaths(chat, moves), ["B/dir/n.md"], "only the note is read again; the PDF is fetched by path on send");
  assert.equal(remapChatPaths(chat, [{ from: "Z/x", to: "Z/y" }]), chat, "an unrelated move changes nothing");
});
