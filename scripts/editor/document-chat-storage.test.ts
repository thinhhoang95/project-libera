import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readChatState, writeChatState } from "../../src/lib/storage/document-chat";

test("history and panel settings persist independently in workspace data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-chat-test-"));
  const previousRoot = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    assert.equal(await readChatState("history"), null);
    const history = { chats: [{ id: "chat-1", title: "Question", messages: [], selections: [], prompt: "Draft prompt" }], activeId: "chat-1" };
    await writeChatState("history", history);
    await writeChatState("font-size", 18);
    await writeChatState("panel", { width: 432, collapsed: true });
    assert.deepEqual(await readChatState("history"), history);
    assert.deepEqual(await readChatState("panel"), { width: 432, collapsed: true });
    await writeChatState("panel", { width: 320, collapsed: false });
    assert.deepEqual(await readChatState("history"), history);
    assert.equal(await readChatState("font-size"), 18);
  } finally {
    if (previousRoot === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});

test("unchanged sidecars keep their inode and timestamp; concurrent chat saves retain the newest value", async () => {
  const { stat } = await import("node:fs/promises");
  const { getAdminRoot } = await import("../../src/lib/storage/paths");
  const { readWorkspaces, writeWorkspaces } = await import("../../src/lib/storage/workspaces");
  const { emptyWorkspaceLibrary } = await import("../../src/lib/workspaces");
  const { writeWorkspaceRecovery } = await import("../../electron/workspace-recovery.cjs");
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-state-dedup-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try {
    const panel = { width: 432, collapsed: false };
    await writeChatState("panel", panel);
    const target = path.join(getAdminRoot(), ".libera", "document-chat-panel.json");
    const before = await stat(target);
    await Promise.all(Array.from({ length: 20 }, () => writeChatState("panel", panel)));
    const after = await stat(target);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    await Promise.all([writeChatState("panel", { ...panel, width: 300 }), writeChatState("panel", { ...panel, width: 500 })]);
    assert.deepEqual(await readChatState("panel"), { ...panel, width: 500 });
    const library = { ...emptyWorkspaceLibrary(), updatedAt: 1 };
    await writeWorkspaces(library);
    const workspaces = path.join(getAdminRoot(), ".libera-workspaces.json");
    const initial = await stat(workspaces);
    await writeWorkspaces(library);
    assert.equal((await stat(workspaces)).ino, initial.ino);
    writeWorkspaceRecovery(getAdminRoot(), JSON.stringify({ ...library, updatedAt: 2 }));
    const recovery = path.join(getAdminRoot(), ".libera-workspaces-recovery.json");
    const closed = await stat(recovery);
    writeWorkspaceRecovery(getAdminRoot(), JSON.stringify({ ...library, updatedAt: 3 }));
    assert.equal((await stat(recovery)).ino, closed.ino, "duplicate close events do not rewrite recovery");
    await writeWorkspaces({ ...library, updatedAt: 4, librarySession: { tabs: [], activeTabId: "", expandedPaths: [], selectedNotebookName: "Notes" } });
    writeWorkspaceRecovery(getAdminRoot(), JSON.stringify({ ...library, updatedAt: 5 }));
    assert.equal((await readWorkspaces()).updatedAt, 5, "returning to old contents supersedes a newer canonical snapshot");
    assert.equal((await readWorkspaces()).librarySession, null);
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
