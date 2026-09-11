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
