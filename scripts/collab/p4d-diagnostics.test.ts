// "Report sync problem" diagnostics: scrubDiagnostics on hostile input, and
// GET /diagnostics on the real control API (signed in to the real server)
// carrying states, counts and codes but no document text, rejected text,
// emails or tokens. Also the on-demand divergence check route.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { startControlApp, type ControlApp } from "../../electron/collab/control";
import { scrubDiagnostics } from "../../electron/collab/control/routes-diagnostics";
import { ControlRoutes, type HostEvent } from "../../src/lib/collab/local-api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import type { DivergenceRecord, HostDiagnostics } from "../../src/lib/collab/ui/diagnostics-types";
import { createDocument, createTeam, fakeSecrets, quietLogger, until } from "./p4d-support";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

let server: ServerProcess;
let dir: string;
let app: ControlApp | null = null;

before(async () => {
  server = await startServerProcess();
  dir = mkdtempSync(path.join(tmpdir(), "libera-p4d-diag-"));
});

after(async () => {
  await app?.close();
  await server?.stop();
  removeDataDir(server?.dataDir ?? "");
  rmSync(dir, { recursive: true, force: true });
});

test("scrubDiagnostics drops content and credential keys, scrubs strings and binary", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NfMSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  const hostile = {
    docId: "doc_1",
    state: "saved-remote",
    text: "document text",
    content: "document text",
    rejectedText: "the user's unsynced paragraph",
    nested: {
      Token: "abc",
      refreshToken: "rt_secret",
      authorization: `Bearer ${jwt}`,
      email: "ada@example.com",
      path: "Notebook/Secret plans.md",
      name: "Secret plans",
      list: [{ body: "comment body", code: "too-large" }, new Uint8Array([1, 2, 3])],
    },
    message: `refresh failed with Bearer ${jwt} for ada@example.com in C:\\Users\\ada\\Libera\\Notebook\\Secret.md and /home/ada/notes/x.md`,
    update: new Uint8Array([9, 9]),
    many: Array.from({ length: 2000 }, (_, index) => index),
    count: 3,
    ok: true,
    fn: () => "x",
  };
  const scrubbed = scrubDiagnostics(hostile) as Record<string, unknown>;
  const json = JSON.stringify(scrubbed);
  for (const leaked of ["document text", "unsynced paragraph", "rt_secret", jwt, "ada@example.com", "Secret plans", "comment body", "Users\\\\ada", "/home/ada"]) {
    assert.ok(!json.includes(leaked), `leaked ${leaked}: ${json.slice(0, 400)}`);
  }
  assert.equal(scrubbed.docId, "doc_1");
  assert.equal(scrubbed.state, "saved-remote");
  assert.equal(scrubbed.count, 3);
  assert.equal(scrubbed.ok, true);
  assert.equal("fn" in scrubbed, false);
  assert.equal("update" in scrubbed, false);
  assert.deepEqual((scrubbed.nested as { list: unknown[] }).list, [{ code: "too-large" }], "binary entries vanish");
  assert.equal((scrubbed.many as unknown[]).length, 500, "arrays are capped");
  assert.match(String(scrubbed.message), /Bearer \[token\] for \[email\] in \[path\] and \[path\]/);
});

test("GET /diagnostics carries sync state but no content, names, emails or tokens", { timeout: 120_000 }, async () => {
  const team = await createTeam(server);
  const docId = "doc_p4d_diag";
  await createDocument(server, team, docId);
  const events: HostEvent[] = [];
  app = await startControlApp({
    collabDir: path.join(dir, "collab"),
    libraryRoot: path.join(dir, "library"),
    appVersion: "1.2.3-test",
    installationId: "inst_p4d_diag",
    secrets: fakeSecrets,
    emit: (event) => events.push(event),
    logger: quietLogger,
    host: { compaction: false, hubIdleMs: 50, telemetry: false, divergence: false },
  });
  const control = app;
  const call = async <T>(method: string, route: string, body?: unknown, token: string | null = control.address.token) => {
    const response = await fetch(`${control.address.url}${route}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T, text };
  };

  assert.equal((await call("GET", ControlRoutes.diagnostics, undefined, null)).status, 401, "the control token is required");
  const signedOut = await call<HostDiagnostics>("GET", ControlRoutes.diagnostics);
  assert.equal(signedOut.status, 200);
  assert.equal(signedOut.body.account.signedIn, false);

  const email = team.alice.account.email;
  const signIn = await call("POST", ControlRoutes.signIn, { serverUrl: server.url, email, password: "correct horse battery" });
  assert.equal(signIn.status, 200, signIn.text);
  const host = control.runtime.host;
  await until(() => host.connectionState === "connected", "connected");

  const secret = "CONFIDENTIAL-PARAGRAPH-9137";
  const hub = host.acquire(docId, { kind: "file" });
  hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, `${secret}\n`), { source: "typing" });
  await until(() => hub.getStatus().state === "saved-remote", "saved");
  // A rejected edit keeps the user's text for "Copy my unsynced text"; only its reason may appear.
  host.store.putRejected({ docId, subdoc: "content", reason: "too-large", message: "Update too large", rejectedText: `${secret} rejected`, at: Date.now() });
  host.journal.noteError({ source: "sync", code: "internal", message: `failed for ${email} with ${team.alice.accessToken}` });

  const response = await call<HostDiagnostics>("GET", ControlRoutes.diagnostics);
  assert.equal(response.status, 200);
  const bundle = response.body;
  for (const leaked of [secret, email, team.alice.accessToken, team.alice.refreshToken, "Shared ", "Alice"]) {
    assert.ok(!response.text.includes(leaked), `diagnostics leaked ${leaked.slice(0, 24)}`);
  }
  assert.equal(bundle.format, 1);
  assert.equal(bundle.appVersion, "1.2.3-test");
  assert.equal(bundle.account.signedIn, true);
  assert.equal(bundle.account.accountId, team.alice.account.id);
  assert.equal(bundle.connection.current, "connected");
  assert.ok(bundle.connection.history.some((entry) => entry.state === "connected"));
  assert.ok(bundle.connection.history.length <= 50);
  assert.ok(["win32", "darwin", "linux"].includes(bundle.os.platform));
  assert.ok(bundle.store.databaseBytes > 0);
  const doc = bundle.docs.find((entry) => entry.docId === docId);
  assert.ok(doc, "the open doc is listed");
  assert.equal(doc.open, true);
  assert.equal(doc.state, "saved-remote");
  assert.equal(doc.pending, 0);
  assert.deepEqual(doc.rejected, ["content:too-large"]);
  assert.ok(bundle.errors.some((entry) => entry.source === "sync" && entry.code === "internal" && entry.message.includes("[email]")));
  assert.equal(bundle.pending.unackedUpdates, 0);

  // On-demand divergence check through the control API.
  const checked = await call<DivergenceRecord[]>("POST", ControlRoutes.divergenceCheck);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.find((record) => record.docId === docId)?.outcome, "match");
  const after = await call<HostDiagnostics>("GET", ControlRoutes.diagnostics);
  assert.equal(after.body.docs.find((entry) => entry.docId === docId)?.lastDivergence?.outcome, "match");
  assert.equal(after.body.counters.divergenceChecks, 1);
});
