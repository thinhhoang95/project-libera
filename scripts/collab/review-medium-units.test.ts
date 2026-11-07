// Regressions for the November 2026 collaboration review's Medium findings
// that need no server: PDF imports (R28), cold PDF snapshots (R29), refused
// offline comments (R31), large-blob staging (R34), naming a PDF version
// (R38), online-only files (R39) and LaTeX build products (R41).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ApiClient } from "../../electron/collab/core/api-client";
import { CommandOutcomes } from "../../electron/collab/core/command-outcomes";
import type { PendingCommands } from "../../electron/collab/core/pending-commands";
import { HostStore, MAX_REFUSED_COMMANDS } from "../../electron/collab/core/store";
import { whenPdfStateLoaded } from "../../electron/collab/control/routes-pdf";
import type { DocHub } from "../../electron/collab/core/doc-hub";
import { SLOW_READ, isDataless, isGeneratedPath, readWithin } from "../../electron/collab/notebooks/fs-ops";
import { withRefusedCommands } from "../../electron/collab/notebooks/pdf-comments";
import { CollabReplica, type ReplicaMessagePort } from "../../src/lib/collab/client/replica";
import type { Command } from "../../src/lib/collab/protocol/api";
import type { PdfCommentAnchor } from "../../src/lib/types";

function tempDir(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("R28: a long comment thread is imported in parts the server accepts", async () => {
  const bodies: Array<{ comments?: Array<{ messages: unknown[] }> }> = [];
  const client = new ApiClient({
    baseUrl: "https://collab.example",
    tokenProvider: { getAccessToken: async () => "token", refresh: async () => null },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ serverSeq: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const messages = Array.from({ length: 1_201 }, (_, index) => ({ id: `m${index}`, text: `reply ${index}` }));
  await client.importPdf("doc_pdf", { marks: [], comments: [{ id: "local-thread", anchor: {}, status: "open", messages }] });
  const parts = bodies.flatMap((body) => body.comments ?? []);
  assert.ok(parts.length >= 3, "split into parts");
  assert.ok(parts.every((part) => part.messages.length <= 500), "no part exceeds the server's 500 messages");
  const ids = new Set(parts.flatMap((part) => part.messages.map((message) => (message as { id: string }).id)));
  assert.equal(ids.size, messages.length, "every message is sent");
});

function fakeHub(state: { opened: boolean; hasState: boolean }) {
  const listeners = new Set<() => void>();
  const hub = {
    get hasOpened() { return state.opened; },
    get hasState() { return state.hasState; },
    isClosed: false,
    onStatus(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { hub: hub as unknown as DocHub, open() { state.opened = true; state.hasState = true; for (const listener of listeners) listener(); } };
}

test("R29: a PDF snapshot waits for the server's state, and refuses an empty never-loaded document", async () => {
  const cold = fakeHub({ opened: false, hasState: false });
  let done = false;
  const waiting = whenPdfStateLoaded(cold.hub, { known: 50, unknown: 2_000 }).then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(done, false, "does not snapshot before the server's state arrives");
  cold.open();
  await waiting;

  const offline = fakeHub({ opened: false, hasState: false });
  await assert.rejects(whenPdfStateLoaded(offline.hub, { known: 10, unknown: 30 }), { status: 503 });

  // Offline with state on this device: the best there is, after a short wait.
  const known = fakeHub({ opened: false, hasState: true });
  await whenPdfStateLoaded(known.hub, { known: 10, unknown: 2_000 });
});

const threadCommand = (id: string): Command => ({ id, kind: "thread.create", docId: "doc_pdf", body: { id: `thr_${id}`, anchorId: "anc_1", quote: "q", body: `text of ${id}` } });

test("R31: a refused offline comment survives a host restart with what was written", () => {
  const temp = tempDir("libera-refused-");
  try {
    const file = path.join(temp.dir, "host.sqlite");
    let store = new HostStore({ path: file });
    store.insertCommand(threadCommand("cmd_a"));
    store.refuseCommand("cmd_a", 403, { code: "forbidden", message: "Your role cannot comment." }, 1_000);
    assert.deepEqual(store.listCommands(), [], "it left the queue");
    store.close();

    store = new HostStore({ path: file });
    const commands = { list: () => store.listCommands(), on: () => () => undefined } as unknown as PendingCommands;
    const outcomes = new CommandOutcomes(commands, () => 0, store);
    const [failed] = outcomes.failed();
    assert.equal(failed.command.id, "cmd_a");
    assert.equal((failed.command as Extract<Command, { kind: "thread.create" }>).body.body, "text of cmd_a");
    assert.equal(failed.error.message, "Your role cannot comment.");

    // The PDF panel shows it as not sent, instead of dropping it.
    const anchor = { quote: "q", segments: [] } as unknown as PdfCommentAnchor;
    const [thread] = withRefusedCommands([], outcomes.failed(), "doc_pdf", (id) => (id === "anc_1" ? anchor : undefined));
    assert.equal(thread.notSent, "Your role cannot comment.");
    assert.equal(thread.messages[0].text, "text of cmd_a");

    assert.equal(outcomes.discard("cmd_a"), true);
    assert.deepEqual(outcomes.failed(), []);

    for (let index = 0; index < MAX_REFUSED_COMMANDS + 5; index += 1) {
      store.insertCommand(threadCommand(`cmd_${index}`));
      store.refuseCommand(`cmd_${index}`, 403, { code: "forbidden", message: "no" }, index);
    }
    assert.equal(store.listRefusedCommands().length, MAX_REFUSED_COMMANDS, "bounded, oldest first to go");
    assert.equal(store.listRefusedCommands()[0].id, "cmd_5");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("R34: staging a large blob never recreates a notebook removed meanwhile", async () => {
  const temp = tempDir("libera-staging-");
  const saved = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = temp.dir;
  try {
    const { ensureSharedIncomingDirectory } = await import("../../src/lib/collab/shared-writes");
    const library = path.join(temp.dir, "users", "admin");
    mkdirSync(path.join(library, "Present"), { recursive: true });
    assert.equal(await ensureSharedIncomingDirectory("Present"), path.join(library, "Present", ".libera", "collab", "incoming"));
    await assert.rejects(ensureSharedIncomingDirectory("Gone"), { status: 503 });
    assert.equal(existsSync(path.join(library, "Gone")), false);
  } finally {
    if (saved === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = saved;
    temp.cleanup();
  }
});

function fakePort() {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const port: ReplicaMessagePort = {
    postMessage() {},
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    close() {},
  };
  return { port, status(pending: number, lastAckAt: number | null) {
    for (const listener of listeners) listener({ data: { t: "status", docId: "doc_pdf", status: { state: "saved-remote", pending, oldestPendingAgeMs: 0, lastAckAt, connected: true } } });
  } };
}

test("R38: an old 'nothing pending' status does not count for an update sent after it", () => {
  const { port, status } = fakePort();
  const replica = new CollabReplica("doc_pdf", port, { schedule: () => undefined });
  status(0, 1);
  assert.equal(replica.syncedSinceLastSend(), true, "nothing sent yet");
  replica.annotations.getMap("marks").set("m1", "a mark");
  replica.flush();
  const sentAt = replica.lastSentAt;
  assert.ok(sentAt > 0);
  status(0, sentAt - 1);
  assert.equal(replica.syncedSinceLastSend(), false, "a status from before the hub got the update");
  status(1, sentAt - 1);
  assert.equal(replica.syncedSinceLastSend(), false);
  status(0, sentAt);
  assert.equal(replica.syncedSinceLastSend(), true, "acknowledged after the update was sent");
  replica.destroy();
});

test("R39: online-only placeholders are recognized, and a read that does not finish is given up on", { skip: process.platform === "win32" }, async () => {
  assert.equal(isDataless({ size: 4096, blocks: 0 }), true);
  assert.equal(isDataless({ size: 4096, blocks: 8 }), false);
  assert.equal(isDataless({ size: 0, blocks: 0 }), false, "an empty file is not a placeholder");

  const temp = tempDir("libera-slow-read-");
  const fifo = path.join(temp.dir, "stalled");
  try {
    execFileSync("mkfifo", [fifo]);
    // A FIFO with no writer blocks its reader, like a stalled download.
    const started = Date.now();
    assert.equal(await readWithin(fifo, 100), SLOW_READ);
    assert.ok(Date.now() - started < 2_000);
    const plain = path.join(temp.dir, "plain.md");
    writeFileSync(plain, "here");
    assert.equal(String(await readWithin(plain, 1_000)), "here");
    assert.equal(await readWithin(path.join(temp.dir, "missing.md"), 1_000), null);
  } finally {
    // Release the abandoned reader.
    const writer = await open(fifo, "w").catch(() => null);
    await writer?.close();
    temp.cleanup();
  }
});

test("R41: an external LaTeX build's products are not new shared files", () => {
  for (const generated of ["paper.aux", "paper.log", "paper.synctex.gz", "paper.fdb_latexmk", "paper.run.xml", "sub/paper.bbl", "_minted-paper/x.pygtex"]) {
    assert.equal(isGeneratedPath(generated), true, generated);
  }
  for (const kept of ["paper.tex", "refs.bib", "paper.pdf", "notes.log.md", "figure.png", "minted.md"]) {
    assert.equal(isGeneratedPath(kept), false, kept);
  }
});
