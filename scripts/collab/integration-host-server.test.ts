// The real collab host core against the real collab server (child process):
// two hosts edit one document live, keep editing while the server is down,
// and converge after it restarts on the same database. Catches contract
// drift between electron/collab/core and server/ that unit tests with fakes
// cannot see.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CollabHost } from "../../electron/collab/core/host";
import type { AuthResponse, ProjectSummary } from "../../src/lib/collab/protocol/api";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

async function api<T>(server: ServerProcess, route: string, body?: unknown, token?: string, method?: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${route}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function until(condition: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function makeHost(dir: string, name: string, server: ServerProcess, auth: AuthResponse): CollabHost {
  const host = new CollabHost({
    dbPath: path.join(dir, `${name}.sqlite`),
    appVersion: "test",
    installationId: `inst_${name}_integration`,
    logger: (process.env.LIBERA_IT_DEBUG
      ? { debug: (...a: unknown[]) => console.log(name, "debug", ...a), info: (...a: unknown[]) => console.log(name, "info", ...a), warn: (...a: unknown[]) => console.log(name, "warn", ...a), error: (...a: unknown[]) => console.log(name, "error", ...a) }
      : { debug() {}, info() {}, warn() {}, error() {} }) as never,
    compaction: false,
    hubIdleMs: 60_000,
  });
  host.start();
  if (process.env.LIBERA_IT_DEBUG) host.on((event) => console.log(name, "event", JSON.stringify(event).slice(0, 300)));
  let token = auth.accessToken;
  let refreshToken = auth.refreshToken;
  host.setAccount({
    accountId: auth.account.id,
    serverUrl: server.url,
    tokenProvider: {
      getAccessToken: async () => token,
      refresh: async () => {
        const refreshed = await api<AuthResponse>(server, "/v1/auth/refresh", { refreshToken });
        if (refreshed.status !== 200) return null;
        token = refreshed.body.accessToken;
        refreshToken = refreshed.body.refreshToken;
        return token;
      },
    },
  });
  return host;
}

test("two hosts share a document through the real server, offline edits included", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "libera-host-it-"));
  let server = await startServerProcess();
  const hosts: CollabHost[] = [];
  try {
    const alice = await api<AuthResponse>(server, "/v1/auth/register", {
      email: "alice@example.test",
      password: "correct horse battery",
      displayName: "Alice",
    });
    assert.equal(alice.status, 201);
    const project = await api<ProjectSummary>(server, "/v1/projects", { name: "Shared" }, alice.body.accessToken);
    assert.equal(project.status, 201);
    const invite = await api<{ token: string }>(
      server,
      `/v1/projects/${project.body.id}/invitations`,
      { email: "bob@example.test", role: "editor" },
      alice.body.accessToken,
    );
    assert.equal(invite.status, 201);
    const bob = await api<AuthResponse>(server, "/v1/auth/register", {
      email: "bob@example.test",
      password: "correct horse battery",
      displayName: "Bob",
      invitationToken: invite.body.token,
    });
    assert.equal(bob.status, 201);

    const docId = "doc_host_integration";
    const created = await api(
      server,
      `/v1/projects/${project.body.id}/documents`,
      { docId, fileId: "fil_host_integration", kind: "markdown" },
      alice.body.accessToken,
    );
    assert.equal(created.status, 201);

    const hostA = makeHost(dir, "alice", server, alice.body);
    const hostB = makeHost(dir, "bob", server, bob.body);
    hosts.push(hostA, hostB);
    const hubA = hostA.acquire(docId, { kind: "file", projectId: project.body.id });
    const hubB = hostB.acquire(docId, { kind: "file", projectId: project.body.id });

    // Live: Alice types, Bob sees it, and Alice reaches "saved-remote".
    hubA.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "# Notes\n"), { source: "typing" });
    await until(() => hubB.getText() === "# Notes\n", "Bob to receive Alice's edit");
    await until(() => hubA.getStatus().state === "saved-remote", "Alice to be saved to the workspace");

    // Concurrent edits from both sides converge.
    hubA.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(8, "Alice line\n"), { source: "typing" });
    hubB.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "Bob intro\n"), { source: "typing" });
    await until(() => hubA.getText() === hubB.getText() && hubA.getText().includes("Alice line") && hubA.getText().includes("Bob intro"), "concurrent edits to converge");

    // Server goes away abruptly. Both keep editing; edits stay pending locally.
    const { port, dataDir } = server;
    await server.kill();
    await until(() => hubA.getStatus().state === "offline", "Alice to show offline");
    hubA.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(doc.getText(ContentKeys.source).length, "offline A\n"), { source: "typing" });
    hubB.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, "offline B\n"), { source: "typing" });
    assert.ok(hubA.getStatus().pending > 0, "Alice has pending edits while offline");

    // Restart on the same database and port; hosts reconnect on their own (nudge speeds it up).
    server = await startServerProcess({ port, dataDir });
    hostA.nudge();
    hostB.nudge();
    await until(
      () => hubA.getText() === hubB.getText() && hubA.getText().includes("offline A") && hubA.getText().includes("offline B"),
      "offline edits to converge after restart",
      30_000,
    );
    await until(() => hubA.getStatus().state === "saved-remote" && hubB.getStatus().state === "saved-remote", "both to be saved");

    // The server's update log attributes edits to each account.
    const feed = await api<{ updates: { userId: string | null }[] }>(server, `/v1/documents/${docId}/updates?fromSeq=1&limit=1000`, undefined, alice.body.accessToken);
    assert.equal(feed.status, 200);
    const authors = new Set(feed.body.updates.map((update) => update.userId));
    assert.ok(authors.has(alice.body.account.id) && authors.has(bob.body.account.id), "both authors recorded");

    // A third, fresh host (Alice on a new machine) loads the same text from the server.
    const hostC = makeHost(dir, "alice-laptop", server, alice.body);
    hosts.push(hostC);
    const hubC = hostC.acquire(docId, { kind: "file", projectId: project.body.id });
    await until(() => hubC.getText() === hubA.getText(), "a fresh host to load the document");
  } finally {
    for (const host of hosts) await host.stop();
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
