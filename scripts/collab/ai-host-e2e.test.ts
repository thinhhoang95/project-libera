// Libera's Next-side writers end to end (M1.11, M3.4): the agent's Edit/Write
// and undo, OCR "Convert PDF to Markdown", uploads, against the real collab
// host (control API + NotebookService) and the real collab server in a child
// process. The agent's changes to shared files are AI suggestions that leave
// the text alone and that undo withdraws; an older run's direct edits still
// undo as inverse edits through the host (and refuse after a collaborator's
// edit); OCR edits reach the server's update log as AI on behalf of the user;
// an upload becomes a manifest blob the server holds.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { POST as FILES_POST, PATCH as FILES_PATCH, DELETE as FILES_DELETE } from "../../src/app/api/files/route";
import { POST as FOLDERS_POST, PATCH as FOLDERS_PATCH, DELETE as FOLDERS_DELETE } from "../../src/app/api/folders/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { RunSnapshots, undoRun } from "../../src/lib/agent/snapshots";
import { ALL_TOOLS, type ToolContext } from "../../src/lib/agent/tools";
import type { AgentEvent } from "../../src/lib/agent/types";
import { ControlRoutes, type CreateThreadAtRangeResponse, type DocText, type HostStatus, type ResolvedDoc } from "../../src/lib/collab/local-api";
import { ApiRoutes, type AuthResponse, type SuggestionInfo, type UpdatesPage } from "../../src/lib/collab/protocol/api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { invalidateSharedNotebookCache, type SharedNotebookMarker } from "../../src/lib/collab/shared-notebook";
import { writeSharedBlob, writeSharedText } from "../../src/lib/collab/shared-writes";
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

    // User file operations must use the host, just like OCR and uploads.
    assert.equal((await FOLDERS_POST(authed("/api/folders", { json: { parentPath: "Shared", name: "created" } }))).status, 200);
    const userCreated = await FILES_POST(authed("/api/files", { json: { parentPath: "Shared/created", name: "paper.tex", content: "\\section{Created}\n" } }));
    assert.equal(userCreated.status, 200);
    const createdDoc = (await control<ResolvedDoc>("GET", `${ControlRoutes.resolve}?path=Shared/created/paper.tex`)).body;
    assert.ok(createdDoc.docId);
    assert.equal((await FILES_PATCH(authed("/api/files", { method: "PATCH", json: { path: "Shared/created/paper.tex", destinationName: "renamed.tex" } }))).status, 200);
    assert.equal((await FOLDERS_PATCH(authed("/api/folders", { method: "PATCH", json: { path: "Shared/created", name: "renamed-folder" } }))).status, 200);
    const renamedDoc = (await control<ResolvedDoc>("GET", `${ControlRoutes.resolve}?path=Shared/renamed-folder/renamed.tex`)).body;
    assert.equal(renamedDoc.docId, createdDoc.docId, "both renames preserve the CRDT document");
    const copied = await FILES_PATCH(authed("/api/files", { method: "PATCH", json: { path: "Shared/renamed-folder/renamed.tex", destinationDirectory: "Shared", copy: true } }));
    assert.equal(copied.status, 200);
    const copiedPath = (await copied.json()).file.path as string;
    assert.equal(readFileSync(path.join(library, ...copiedPath.split("/")), "utf8"), "\\section{Created}\n");
    assert.equal((await FILES_DELETE(authed(`/api/files?path=${encodeURIComponent(copiedPath)}`, { method: "DELETE" }))).status, 200);
    assert.equal((await FOLDERS_DELETE(authed("/api/folders?path=Shared/renamed-folder", { method: "DELETE" }))).status, 200);
    assert.equal(existsSync(path.join(library, "Shared", "renamed-folder")), false);
    assert.equal((await control<ResolvedDoc | null>("GET", `${ControlRoutes.resolve}?path=Shared/renamed-folder/renamed.tex`)).body, null);

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

    // --- the agent's Edit and Write become AI suggestions; the text stays until one is accepted
    const { context, events } = agentContext();
    await tool("Read").run({ file_path: "Shared/notes.md" }, context);
    const edited = await tool("Edit").run({ file_path: "Shared/notes.md", old_string: "world", new_string: "shared world" }, context);
    assert.match(edited.text, /suggested, pending review/);
    assert.match(edited.text, /AI on behalf of you/);
    const written = await tool("Write").run({ file_path: "Shared/notes.md", content: "# Notes\n\nHello world\n" }, context);
    assert.match(written.text, /suggested, pending review/);
    assert.equal((await docText(resolved.docId)).text, "Hello world\n", "content is untouched");
    assert.ok(events.every((event) => event.type !== "file_changed" || (event.shared === true && event.suggested === true)));
    const overlay = async () => (await control<SuggestionInfo[]>("GET", ControlRoutes.docSuggestions(resolved.docId))).body;
    await until(async () => (await overlay()).filter((info) => info.status === "pending").length === 2, "the server to mirror both suggestions");
    for (const info of await overlay()) {
      const actor = info.actor as { kind: string; feature?: string; runId?: string; model?: string; onBehalfOf?: string };
      assert.deepEqual([actor.kind, actor.feature, actor.runId, actor.model, actor.onBehalfOf], ["ai", "agent", context.snapshots.runId, "test/e2e-model", accountId]);
    }
    const afterAgent = await serverLog(resolved.docId);
    assert.equal(afterAgent.text, "Hello world\n");
    assert.ok(afterAgent.updates.every((update) => update.actor?.kind !== "ai"), "no AI write reached content");

    // --- undo withdraws the run's pending suggestions
    const [undone] = await undoRun(context.snapshots.runId);
    assert.deepEqual([undone.status, undone.shared, undone.withdrawn], ["restored", true, 2]);
    await until(async () => (await overlay()).every((info) => info.status === "withdrawn"), "the server to see them withdrawn");
    assert.equal((await docText(resolved.docId)).text, "Hello world\n");

    // --- ReadComments: threads and replies from the server, anchored by the host
    const commented = await control<CreateThreadAtRangeResponse>("POST", ControlRoutes.threadsAtRange(resolved.docId), { range: { start: 6, end: 11 }, body: "Which world?" });
    assert.equal(commented.status, 201, JSON.stringify(commented.body));
    const threadId = commented.body.queued ? commented.body.threadId : commented.body.thread.id;
    const replied = await control("POST", ControlRoutes.threadMessages(threadId), { id: "msg_e2e_reply_1", body: "This one, keep it." });
    assert.equal(replied.status, 201, JSON.stringify(replied.body));
    const comments = await tool("ReadComments").run({ file_path: "Shared/notes.md" }, context);
    assert.equal(comments.isError, false, comments.text);
    assert.match(comments.text, new RegExp(`Thread ${threadId} · open · line 1, on “world”\\n {2}- Ada \\(the user\\), comment, \\d{4}-\\d\\d-\\d\\d:\\n {4}Which world\\?\\n {2}- Ada \\(the user\\), reply, \\d{4}-\\d\\d-\\d\\d:\\n {4}This one, keep it\\.`));

    // --- an older run's direct edits (M1.11) still undo as inverse edits, and refuse after a collaborator's edit
    for (const collaboratorTypes of [false, true]) {
      const runId = `run-legacy-${collaboratorTypes ? "conflict" : "clean"}`;
      const legacy = new RunSnapshots(runId);
      const original = (await docText(resolved.docId)).text;
      await legacy.recordOriginal("Shared/notes.md", original, undefined, { docId: resolved.docId });
      const direct = await writeSharedText("Shared/notes.md", `${original}Legacy line.\n`, { source: "ai", feature: "agent", runId }, { expectedBefore: original });
      assert.equal(direct.applied, true);
      await legacy.recordWritten("Shared/notes.md", direct.text);
      if (collaboratorTypes) {
        const typed = await control<{ applied: boolean }>("POST", ControlRoutes.docEdits(resolved.docId), { edits: [{ start: 0, end: 0, text: "Typed: " }], provenance: { source: "typing" } });
        assert.equal(typed.body.applied, true);
      }
      const [result] = await undoRun(runId);
      if (collaboratorTypes) {
        assert.equal(result.status, "conflict");
        assert.equal((await docText(resolved.docId)).text, `Typed: ${original}Legacy line.\n`);
      } else {
        assert.deepEqual([result.status, result.shared], ["restored", true]);
        const afterUndo = await serverLog(resolved.docId);
        assert.equal(afterUndo.text, original);
        assert.equal((afterUndo.updates.at(-1)?.provenance as { source?: string } | null)?.source, "undo");
      }
    }

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
    await assert.rejects(writeSharedBlob("Shared/figure.png", new Uint8Array(Buffer.from("conflicting copy")), { createOnly: true }), /already exists/);
    assert.ok(readFileSync(path.join(library, "Shared", "figure.png")).equals(PNG), "copy creation never replaces an existing blob");

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
