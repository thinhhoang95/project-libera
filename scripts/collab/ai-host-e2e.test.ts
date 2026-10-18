// M1.11 end to end: Libera's Next-side writers (the agent's Edit/Write and
// undo, OCR "Convert PDF to Markdown", uploads) against the real collab host
// (control API + NotebookService) and the real collab server in a child
// process. Checks that agent and OCR edits reach the server's update log as
// AI on behalf of the user with their feature and run, that undo goes back
// through the host and refuses after a collaborator's edit, and that an
// upload becomes a manifest blob the server holds.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NextRequest } from "next/server";
import * as Y from "yjs";

import { startControlApp, type ControlApp } from "../../electron/collab/control";
import type { SecretCodec } from "../../electron/collab/control/account";
import { readManifest } from "../../electron/collab/notebooks/layout";
import { PATCH as OCR_PATCH, POST as OCR_POST } from "../../src/app/api/document-ocr/output/route";
import { POST as UPLOADS_POST } from "../../src/app/api/uploads/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { ALL_TOOLS, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent } from "../../src/lib/agent/types";
import { ControlRoutes, type DocText, type HostStatus, type ResolvedDoc } from "../../src/lib/collab/local-api";
import { ApiRoutes, type AuthResponse, type UpdatesPage } from "../../src/lib/collab/protocol/api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { invalidateSharedNotebookCache, type SharedNotebookMarker } from "../../src/lib/collab/shared-notebook";
import { writeSharedBlob } from "../../src/lib/collab/shared-writes";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fakeSecrets: SecretCodec = { encrypt: async (plaintext) => `enc:${Buffer.from(plaintext).toString("base64")}`, decrypt: async (ciphertext) => Buffer.from(ciphertext.slice(4), "base64").toString() };
const ENV_KEYS = ["LIBERA_DATA_DIR", "LIBERA_COLLAB_HOST_URL", "LIBERA_COLLAB_HOST_TOKEN"] as const;

async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function authed(url: string, init: { method?: string; json?: unknown; body?: BodyInit } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "POST",
    headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
}

function tool(name: string) {
  const found = ALL_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(found, name);
  return found;
}

function agentContext(): { context: ToolContext; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  return {
    events,
    context: {
      permission: "open-files",
      skills: [],
      loadedSkills: new Set(),
      skillState: new Map(),
      notebook: "Shared",
      notebooks: ["Shared"],
      openFiles: new Set(["Shared/notes.md"]),
      drafts: new Map(),
      fileState: new Map(),
      tasks: [],
      snapshots: new RunSnapshots(`run-${Math.random().toString(36).slice(2, 12)}`),
      changed: new Map(),
      maxResultChars: 40_000,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      model: "test/e2e-model",
    },
  };
}

test("agent, undo, OCR and uploads on a shared notebook through the real host and server", { timeout: 180_000 }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "libera-ai-e2e-"));
  const library = path.join(dataDir, "users", "admin");
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const server: ServerProcess = await startServerProcess();
  let app: ControlApp | null = null;
  try {
    mkdirSync(path.join(library, "Shared"), { recursive: true });
    writeFileSync(path.join(library, "Shared", "notes.md"), "Hello world\n");
    writeFileSync(path.join(library, "Shared", "paper.pdf"), "%PDF-1.4\n%%EOF\n");
    process.env.LIBERA_DATA_DIR = dataDir;
    invalidateSharedNotebookCache();

    // The host shares the same library folder Next's storage uses.
    app = await startControlApp({
      collabDir: path.join(dataDir, "collab"),
      libraryRoot: library,
      appVersion: "test",
      installationId: "inst_ai_e2e",
      secrets: fakeSecrets,
      emit: () => {},
      logger: { warn() {}, error() {} },
      host: { compaction: false, hubIdleMs: 50 },
    });
    const control = async <T>(method: string, route: string, body?: unknown) => {
      const response = await fetch(`${app!.address.url}${route}`, {
        method,
        headers: { authorization: `Bearer ${app!.address.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
    };
    const registered = await control<HostStatus>("POST", ControlRoutes.register, { serverUrl: server.url, email: "ai-e2e@example.test", password: "correct horse battery", displayName: "Ada" });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const accountId = registered.body.account?.id ?? "";
    await until(async () => (await control<HostStatus>("GET", ControlRoutes.status)).body.connection === "connected", "the host to connect");
    const shared = await control<{ projectId: string }>("POST", ControlRoutes.share, { notebook: "Shared" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const projectId = shared.body.projectId;
    invalidateSharedNotebookCache();
    const marker = JSON.parse(readFileSync(path.join(library, "Shared", ".libera-shared.json"), "utf8")) as SharedNotebookMarker;

    process.env.LIBERA_COLLAB_HOST_URL = app.address.url;
    process.env.LIBERA_COLLAB_HOST_TOKEN = app.address.token;
    const login = await fetch(`${server.url}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ai-e2e@example.test", password: "correct horse battery" }) });
    const token = ((await login.json()) as AuthResponse).accessToken;

    const resolved = (await control<ResolvedDoc>("GET", `${ControlRoutes.resolve}?path=${encodeURIComponent("Shared/notes.md")}`)).body;
    const docText = async (docId: string) => (await control<DocText>("GET", ControlRoutes.docText(docId))).body;
    const serverLog = async (docId: string) => {
      await until(async () => (await docText(docId)).status.state === "saved-remote", "edits to reach the server");
      const feed = await fetch(`${server.url}/v1/documents/${docId}/updates?fromSeq=1&limit=1000&subdoc=content`, { headers: { authorization: `Bearer ${token}` } });
      const page = (await feed.json()) as UpdatesPage;
      const doc = new Y.Doc();
      for (const update of page.updates) Y.applyUpdate(doc, Buffer.from(update.update, "base64"));
      return { updates: page.updates, text: doc.getText(ContentKeys.source).toString() };
    };

    // --- the agent's Edit and Write land in the shared document as AI on behalf of the user
    const { context, events } = agentContext();
    await tool("Read").run({ file_path: "Shared/notes.md" }, context);
    const edited = await tool("Edit").run({ file_path: "Shared/notes.md", old_string: "world", new_string: "shared world" }, context);
    assert.match(edited.text, /AI on behalf of you/);
    await tool("Write").run({ file_path: "Shared/notes.md", content: "# Notes\n\nHello shared world\n" }, context);
    assert.equal((await docText(resolved.docId)).text, "# Notes\n\nHello shared world\n");
    assert.ok(events.every((event) => event.type !== "file_changed" || event.shared === true));
    const afterAgent = await serverLog(resolved.docId);
    assert.equal(afterAgent.text, "# Notes\n\nHello shared world\n");
    const aiUpdates = afterAgent.updates.filter((update) => update.actor?.kind === "ai");
    // The host may batch consecutive updates with the same provenance into one.
    assert.ok(aiUpdates.length >= 1, JSON.stringify(afterAgent.updates.map((update) => update.actor)));
    assert.ok(afterAgent.updates.slice(1).every((update) => update.actor?.kind === "ai"), "every edit after the import is the agent's");
    for (const update of aiUpdates) {
      const actor = update.actor as { feature?: string; runId?: string; model?: string; onBehalfOf?: string };
      assert.deepEqual([actor.feature, actor.runId, actor.model, actor.onBehalfOf], ["agent", context.snapshots.runId, "test/e2e-model", accountId]);
    }
    // The host materializes the working copy; the agent never wrote it.
    await until(() => readFileSync(path.join(library, "Shared", "notes.md"), "utf8") === "# Notes\n\nHello shared world\n", "the working copy to follow");

    // --- undo through the host
    const [undone] = await undoRun(context.snapshots.runId);
    assert.deepEqual([undone.status, undone.shared], ["restored", true]);
    const afterUndo = await serverLog(resolved.docId);
    assert.equal(afterUndo.text, "Hello world\n");
    const undoUpdate = afterUndo.updates.at(-1);
    assert.equal(undoUpdate?.actor?.kind, "user", "undo is the user's action");
    assert.equal((undoUpdate?.provenance as { source?: string } | null)?.source, "undo");

    // --- undo after a collaborator's edit is a conflict
    const second = agentContext().context;
    await tool("Read").run({ file_path: "Shared/notes.md" }, second);
    await tool("Edit").run({ file_path: "Shared/notes.md", old_string: "Hello", new_string: "Hi" }, second);
    const typed = await control<{ applied: boolean }>("POST", ControlRoutes.docEdits(resolved.docId), { edits: [{ start: 0, end: 0, text: "Typed: " }], provenance: { source: "typing" } });
    assert.equal(typed.body.applied, true);
    const [conflict] = await undoRun(second.snapshots.runId);
    assert.equal(conflict.status, "conflict");
    assert.equal((await docText(resolved.docId)).text, "Typed: Hi world\n");

    // --- OCR "Convert PDF to Markdown" into the shared notebook
    const created = await OCR_POST(authed("/api/document-ocr/output", { json: { pdfPath: "Shared/paper.pdf" } }));
    assert.equal(created.status, 200, JSON.stringify(await created.clone().json()));
    const { file } = (await created.json()) as { file: { path: string } };
    assert.equal(file.path, "Shared/paper.md");
    const page1 = "# Paper\n\nFirst page.\n";
    const page2 = `${page1}\nSecond page.\n`;
    for (const [content, previous] of [[page1, ""], [page2, page1]]) {
      const written = await OCR_PATCH(authed("/api/document-ocr/output", { method: "PATCH", json: { path: file.path, content, previous } }));
      assert.equal(written.status, 200, JSON.stringify(await written.clone().json()));
    }
    const paperDoc = (await control<ResolvedDoc>("GET", `${ControlRoutes.resolve}?path=${encodeURIComponent("Shared/paper.md")}`)).body;
    const paperLog = await serverLog(paperDoc.docId);
    assert.equal(paperLog.text, page2);
    const ocrUpdates = paperLog.updates.filter((update) => update.actor?.kind === "ai");
    assert.ok(ocrUpdates.length >= 1);
    assert.ok(ocrUpdates.every((update) => (update.actor as { feature?: string }).feature === "image-to-markdown"));

    // --- an upload becomes a manifest blob the server holds
    const form = new FormData();
    form.set("notebook", "Shared");
    form.append("files", new File([new Uint8Array(PNG)], "figure.png", { type: "image/png" }));
    const uploaded = await UPLOADS_POST(authed("/api/uploads", { body: form }));
    assert.equal(uploaded.status, 200, JSON.stringify(await uploaded.clone().json()));
    assert.ok(readFileSync(path.join(library, "Shared", "figure.png")).equals(PNG));
    const manifestEntry = (name: string) => {
      const hub = app!.runtime.host.acquire(marker.manifestDocId, { projectId });
      try {
        return [...readManifest(hub.getDoc("manifest")).values()].find((entry) => entry.path === name);
      } finally {
        app!.runtime.host.release(marker.manifestDocId);
      }
    };
    const entry = manifestEntry("figure.png");
    assert.equal(entry?.kind, "blob");
    assert.ok(entry?.blobHash);
    const blob = await fetch(`${server.url}${ApiRoutes.blob(projectId, entry.blobHash)}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(blob.status, 200);
    assert.ok(Buffer.from(await blob.arrayBuffer()).equals(PNG));

    // Replacing the bytes of an existing blob (an image save) updates its entry.
    const replacement = Buffer.concat([PNG, Buffer.from("edited")]);
    await writeSharedBlob("Shared/figure.png", new Uint8Array(replacement));
    const replaced = manifestEntry("figure.png");
    assert.equal(replaced?.fileId, entry.fileId);
    assert.notEqual(replaced?.blobHash, entry.blobHash);
    assert.ok(readFileSync(path.join(library, "Shared", "figure.png")).equals(replacement));
    const replacedBlob = await fetch(`${server.url}${ApiRoutes.blob(projectId, replaced!.blobHash!)}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(replacedBlob.status, 200);
    await assert.rejects(writeSharedBlob("Shared/notes.md", new Uint8Array(PNG)), /shared document; change its text with edits/);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await app?.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    invalidateSharedNotebookCache();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may still hold a WAL handle for a moment. */ }
  }
});
