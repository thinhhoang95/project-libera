// The host's control API (electron/collab/control) with a real CollabHost
// against the real collab server in a child process: auth on the control
// token, account sign-in and persistence, status events, project, member and
// invitation proxying, docText/docEdits with `before` conflicts and
// provenance in the server's update log, and docSuggestions creating
// overlay records the server accepts.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as Y from "yjs";

import { startControlApp, type ControlApp } from "../../electron/collab/control";
import type { SecretCodec } from "../../electron/collab/control/account";
import { SHARED_SIGN_IN_FILE } from "../../electron/collab/control/shared-sign-in";
import { Router } from "../../electron/collab/control/router";
import {
  ControlRoutes,
  type ApplyEditsResponse,
  type CreateSuggestionsResponse,
  type DocText,
  type HostEvent,
  type HostStatus,
  type LocalProject,
  type NotificationInfo,
  type ResolvedDoc,
} from "../../src/lib/collab/local-api";
import type { AuthResponse, Invitation, Member, UpdatesPage } from "../../src/lib/collab/protocol/api";
import { AnnotationKeys, ContentKeys, type SuggestionRecord } from "../../src/lib/collab/protocol/schema";
import { isSuggestionRecord, resolveSuggestion } from "../../src/lib/collab/suggestions/model";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

const quietLogger = { warn() {}, error() {} };

/** Reversible stand-in for safeStorage; the marker proves files hold ciphertext. */
const fakeSecrets: SecretCodec = {
  encrypt: async (plaintext) => `enc:${Buffer.from(plaintext).toString("base64").split("").reverse().join("")}`,
  decrypt: async (ciphertext) => {
    if (!ciphertext.startsWith("enc:")) throw new Error("not ours");
    return Buffer.from(ciphertext.slice(4).split("").reverse().join(""), "base64").toString();
  },
};

async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function serverApi<T>(server: ServerProcess, route: string, options: { body?: unknown; token?: string; method?: string } = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.url}${route}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

interface Client {
  app: ControlApp;
  dir: string;
  events: HostEvent[];
  call<T>(method: string, route: string, body?: unknown, token?: string | null): Promise<{ status: number; body: T }>;
}

async function startClient(dir: string, libraryRoot = path.join(dir, "library")): Promise<Client> {
  const events: HostEvent[] = [];
  const app = await startControlApp({
    collabDir: dir,
    libraryRoot,
    sharedSignIn: { kdf: { N: 2 ** 14, r: 8, p: 1 }, pollMs: 3_600_000 },
    appVersion: "test",
    installationId: `inst_${path.basename(dir).replace(/[^A-Za-z0-9_-]/g, "")}`,
    secrets: fakeSecrets,
    emit: (event) => events.push(event),
    logger: quietLogger,
    host: { compaction: false, hubIdleMs: 50 },
  });
  const call = async <T>(method: string, route: string, body?: unknown, token: string | null = app.address.token) => {
    const response = await fetch(`${app.address.url}${route}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  return { app, dir, events, call };
}

function lastStatus(client: Client): HostStatus | null {
  for (let index = client.events.length - 1; index >= 0; index--) {
    const event = client.events[index];
    if (event.t === "status") return event.status;
  }
  return null;
}

function rawRequest(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${url}${ControlRoutes.status}`, { headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.once("error", reject);
    req.end();
  });
}

test("router: literal segments win, parameters decode, other methods are 405", () => {
  const router = new Router();
  router.add("GET", "/projects/:projectId", () => ({ body: "param" }));
  router.add("POST", "/projects/share", () => ({ body: "literal" }));
  router.add("GET", "/docs/:docId/text", (request) => ({ body: request.params.docId }));
  const literal = router.match("POST", "/projects/share");
  assert.ok(literal && literal !== "method-not-allowed");
  const param = router.match("GET", "/docs/a%2Fb/text");
  assert.ok(param && param !== "method-not-allowed");
  assert.equal(param.params.docId, "a/b");
  assert.equal(router.match("DELETE", "/projects/p1"), "method-not-allowed");
  assert.equal(router.match("GET", "/nothing/here"), null);
  assert.throws(() => router.add("GET", "/projects/:other", () => ({})), /already registered/);
  router.add("GET", ControlRoutes.members(":projectId"), (request) => ({ body: request.params.projectId }));
  const built = router.match("GET", ControlRoutes.members("p 1"));
  assert.ok(built && built !== "method-not-allowed");
  assert.equal(built.params.projectId, "p 1");
});

test("control API against the real collab server", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-elec-control-"));
  const server = await startServerProcess();
  const clients: Client[] = [];
  try {
    // The real NotebookService: Alice shares a notebook from her library.
    const alice = await startClient(path.join(root, "alice"));
    clients.push(alice);

    // --- auth on the control token and the Host header
    assert.equal((await alice.call("GET", ControlRoutes.status, undefined, null)).status, 401);
    assert.equal((await alice.call("GET", ControlRoutes.status, undefined, "wrong-token")).status, 401);
    assert.equal(await rawRequest(alice.app.address.url, { authorization: `Bearer ${alice.app.address.token}`, host: "evil.example:80" }), 403);
    const unknown = await alice.call<{ error: { code: string } }>("GET", "/no/such/route");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "not-found");

    // --- signed out
    const initial = await alice.call<HostStatus>("GET", ControlRoutes.status);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.connection, "signed-out");
    assert.equal(initial.body.account, null);
    assert.ok(existsSync(path.join(alice.dir, "default.sqlite")), "signed-out host uses default.sqlite");
    assert.equal((await alice.call("GET", ControlRoutes.members("p"))).status, 409);

    // --- register through the control API, then connect
    const badUrl = await alice.call<{ error: { code: string } }>("POST", ControlRoutes.register, { serverUrl: "ftp://x", email: "a@x.test", password: "p", displayName: "A" });
    assert.equal(badUrl.status, 400);
    const registered = await alice.call<HostStatus>("POST", ControlRoutes.register, {
      serverUrl: server.url,
      email: "alice@example.test",
      password: "correct horse battery",
      displayName: "Alice",
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const aliceId = registered.body.account?.id ?? "";
    assert.ok(aliceId);
    assert.equal(registered.body.account?.serverUrl, server.url);
    await until(() => lastStatus(alice)?.connection === "connected", "alice to connect");
    const connectionsSeen = alice.events.filter((event) => event.t === "status").map((event) => (event as { status: HostStatus }).status.connection);
    assert.ok(connectionsSeen.includes("signed-out") && connectionsSeen.includes("connected"), connectionsSeen.join(","));
    assert.ok(existsSync(path.join(alice.dir, `${aliceId}.sqlite`)), "the account's own database is open");

    // Account file: public fields only. Session file: ciphertext only.
    const accountFile = readFileSync(path.join(alice.dir, "account.json"), "utf8");
    assert.ok(accountFile.includes("alice@example.test") && !/token/i.test(accountFile));
    const session = JSON.parse(readFileSync(path.join(alice.dir, "session.bin"), "utf8")) as { refreshToken: string };
    assert.ok(session.refreshToken.startsWith("enc:"));
    const plainRefresh = await fakeSecrets.decrypt(session.refreshToken);
    assert.ok(!readFileSync(path.join(alice.dir, "session.bin"), "utf8").includes(plainRefresh));

    // PATCH /account goes through the server's /v1/me.
    const patched = await alice.call<{ displayName: string; color: string }>("PATCH", ControlRoutes.account, { displayName: "Alice A.", color: "#123456" });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.displayName, "Alice A.");
    assert.equal(patched.body.color, "#123456");
    await until(() => lastStatus(alice)?.account?.displayName === "Alice A.", "status to carry the new name");
    assert.equal((await alice.call("PATCH", ControlRoutes.account, { color: "blue" })).status, 400);

    // --- share a notebook (the real NotebookService's route, mounted after the core routes)
    const aliceDirect = await serverApi<AuthResponse>(server, "/v1/auth/login", { body: { email: "alice@example.test", password: "correct horse battery" } });
    assert.equal(aliceDirect.status, 200);
    const token = aliceDirect.body.accessToken;
    mkdirSync(path.join(alice.dir, "library", "Shared"), { recursive: true });
    writeFileSync(path.join(alice.dir, "library", "Shared", "notes.md"), "Hello world\n");
    const shared = await alice.call<{ projectId: string; notebook: string; documents: number }>("POST", ControlRoutes.share, { notebook: "Shared" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.notebook, "Shared");
    const projectId = shared.body.projectId;
    assert.ok(projectId);
    await until(() => (lastStatus(alice)?.projects ?? []).some((item) => item.projectId === projectId), "the shared notebook in HostStatus");

    const listing = await alice.call<LocalProject[]>("GET", ControlRoutes.projects);
    assert.equal(listing.status, 200);
    assert.deepEqual(
      listing.body.map((item) => [item.projectId, item.name, item.role, item.notebook, item.revoked]),
      [[projectId, "Shared", "owner", "Shared", false]],
    );

    const invite = await alice.call<Invitation>("POST", ControlRoutes.invitations(projectId), { email: "bob@example.test", role: "editor" });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    assert.ok(invite.body.token);
    assert.equal((await alice.call("POST", ControlRoutes.invitations(projectId), { email: "x@example.test", role: "owner" })).status, 400);
    const extra = await alice.call<Invitation>("POST", ControlRoutes.invitations(projectId), { email: "carol@example.test", role: "viewer" });
    assert.equal(extra.status, 201);
    assert.equal((await alice.call<Invitation[]>("GET", ControlRoutes.invitations(projectId))).body.length, 2);
    assert.equal((await alice.call("DELETE", ControlRoutes.invitation(projectId, extra.body.id))).status, 204);
    const invitations = await alice.call<Invitation[]>("GET", ControlRoutes.invitations(projectId));
    assert.deepEqual(invitations.body.map((item) => item.email), ["bob@example.test"]);

    // Bob registers with the invitation link through his own host.
    const bob = await startClient(path.join(root, "bob"));
    clients.push(bob);
    const bobRegistered = await bob.call<HostStatus>("POST", ControlRoutes.register, {
      serverUrl: server.url,
      email: "bob@example.test",
      password: "correct horse battery",
      displayName: "Bob",
      invitationToken: `${server.url}/invite/${invite.body.token}`,
    });
    assert.equal(bobRegistered.status, 201, JSON.stringify(bobRegistered.body));
    const bobId = bobRegistered.body.account?.id ?? "";

    // Notifications for the signed-in account.
    const notifications = await bob.call<NotificationInfo[]>("GET", `${ControlRoutes.notifications}?unread=true&limit=50`);
    assert.equal(notifications.status, 200, JSON.stringify(notifications.body));
    assert.ok(Array.isArray(notifications.body));
    assert.equal((await bob.call("POST", ControlRoutes.notificationsRead, { all: true })).status, 204);
    assert.equal((await bob.call("POST", ControlRoutes.notificationsRead, {})).status, 400);
    assert.equal((await bob.call("GET", `${ControlRoutes.notifications}?limit=0`)).status, 400);

    const members = await alice.call<Member[]>("GET", ControlRoutes.members(projectId));
    assert.deepEqual(members.body.map((member) => member.role).sort(), ["editor", "owner"]);
    const demoted = await alice.call<Member>("PATCH", ControlRoutes.member(projectId, bobId), { role: "commenter" });
    assert.equal(demoted.status, 200, JSON.stringify(demoted.body));
    assert.equal(demoted.body.role, "commenter");
    assert.ok(alice.events.some((event) => event.t === "project-changed" && event.projectId === projectId));
    // Bob cannot change roles: the server's 403 comes through as 403 with its code.
    const refused = await bob.call<{ error: { code: string } }>("PATCH", ControlRoutes.member(projectId, aliceId), { role: "viewer" });
    assert.equal(refused.status, 403);

    // --- documents: the shared file resolves through the NotebookService
    const resolvedDoc = await alice.call<ResolvedDoc | null>("GET", `${ControlRoutes.resolve}?path=${encodeURIComponent("Shared/notes.md")}`);
    assert.equal(resolvedDoc.status, 200);
    const docId = resolvedDoc.body?.docId ?? "";
    assert.ok(docId, "notes.md is a shared document");
    assert.equal((await alice.call<ResolvedDoc | null>("GET", `${ControlRoutes.resolve}?path=Other.md`)).body, null);
    assert.equal((await alice.call<ResolvedDoc>("GET", ControlRoutes.doc(docId))).body.path, "Shared/notes.md");
    assert.equal((await alice.call("GET", ControlRoutes.doc("doc_unknown"))).status, 404);
    assert.equal((await alice.call("GET", ControlRoutes.docText("doc_unknown"))).status, 404, "unknown docs are not opened");

    const baseRefs = alice.app.runtime.host.registry.refCount(docId);
    const imported = await alice.call<DocText>("GET", ControlRoutes.docText(docId));
    assert.equal(imported.status, 200);
    assert.equal(imported.body.text, "Hello world\n");

    const first = await alice.call<ApplyEditsResponse>("POST", ControlRoutes.docEdits(docId), {
      edits: [{ start: 12, end: 12, text: "Second line\n", before: "" }],
      provenance: { source: "ai", feature: "agent", model: "test/model", runId: "run_elec_1", suggestionId: "spoofed" },
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { applied: true, text: "Hello world\nSecond line\n" });

    // A stale `before` refuses the whole batch.
    const conflict = await alice.call<ApplyEditsResponse>("POST", ControlRoutes.docEdits(docId), {
      edits: [
        { start: 0, end: 5, text: "Howdy", before: "Hello" },
        { start: 6, end: 11, text: "there", before: "WORLD" },
      ],
      provenance: { source: "typing" },
    });
    assert.deepEqual(conflict.body, { applied: false, text: "Hello world\nSecond line\n", conflictAt: 1 });

    // Several edits in one batch, given ascending against the current text.
    const multi = await alice.call<ApplyEditsResponse>("POST", ControlRoutes.docEdits(docId), {
      edits: [
        { start: 0, end: 5, text: "Hi", before: "Hello" },
        { start: 6, end: 11, text: "there", before: "world" },
        { start: 24, end: 24, text: "Third line\n" },
      ],
      provenance: { source: "typing" },
    });
    assert.deepEqual(multi.body, { applied: true, text: "Hi there\nSecond line\nThird line\n" });
    assert.equal((await alice.call("POST", ControlRoutes.docEdits(docId), { edits: [{ start: 5, end: 9, text: "" }, { start: 0, end: 1, text: "" }], provenance: { source: "typing" } })).status, 400);
    assert.equal((await alice.call("POST", ControlRoutes.docEdits(docId), { edits: [{ start: 0, end: 0, text: "x" }], provenance: { source: "ai" } })).status, 400);

    await until(async () => (await alice.call<DocText>("GET", ControlRoutes.docText(docId))).body.status.state === "saved-remote", "edits to reach the server");
    const feed = await serverApi<UpdatesPage>(server, `/v1/documents/${docId}/updates?fromSeq=1&limit=1000&subdoc=content`, { token });
    assert.equal(feed.status, 200);
    const aiUpdate = feed.body.updates.find((update) => update.actor?.kind === "ai");
    assert.ok(aiUpdate, JSON.stringify(feed.body.updates.map((update) => update.actor)));
    assert.deepEqual(
      { kind: aiUpdate.actor?.kind, feature: (aiUpdate.actor as { feature?: string }).feature, runId: (aiUpdate.actor as { runId?: string }).runId, onBehalfOf: (aiUpdate.actor as { onBehalfOf?: string }).onBehalfOf },
      { kind: "ai", feature: "agent", runId: "run_elec_1", onBehalfOf: aliceId },
    );
    assert.equal((aiUpdate.provenance as { suggestionId?: string } | null)?.suggestionId, undefined, "suggestionId never reaches the server");
    assert.ok(feed.body.updates.some((update) => update.actor?.kind === "user" && update.userId === aliceId), "typing edits are the user's");
    const serverDoc = new Y.Doc();
    for (const update of feed.body.updates) Y.applyUpdate(serverDoc, Buffer.from(update.update, "base64"));
    assert.equal(serverDoc.getText(ContentKeys.source).toString(), "Hi there\nSecond line\nThird line\n");

    // --- overlay suggestions on the annotations sub-document
    const suggested = await alice.call<CreateSuggestionsResponse>("POST", ControlRoutes.docSuggestions(docId), {
      edits: [
        { start: 0, end: 2, text: "Hey", before: "Hi" },
        { start: 9, end: 15, text: "2nd", before: "First " },
        { start: 32, end: 32, text: "Fourth line\n" },
      ],
      ai: { feature: "agentic-review", model: "test/reviewer", runId: "run_elec_2" },
      groupId: "grp_elec",
      reason: "Tighter wording",
    });
    assert.equal(suggested.status, 201, JSON.stringify(suggested.body));
    assert.equal(suggested.body.suggestionIds.length, 3);
    assert.deepEqual(suggested.body.staleIndexes, [1]);

    const hub = alice.app.runtime.host.acquire(docId, { projectId });
    try {
      const records = hub.getDoc("annotations").getMap<SuggestionRecord>(AnnotationKeys.suggestions);
      const ytext = hub.getDoc("content").getText(ContentKeys.source);
      const stored = suggested.body.suggestionIds.map((id) => records.get(id));
      assert.ok(stored.every((record) => isSuggestionRecord(record)));
      assert.deepEqual(stored.map((record) => record?.status), ["pending", "pending", "pending"]);
      assert.deepEqual(stored[0]?.actor, { kind: "ai", onBehalfOf: aliceId, clientId: alice.app.runtime.clientId, feature: "agentic-review", model: "test/reviewer", runId: "run_elec_2" });
      assert.equal(stored[0]?.createdBy, aliceId);
      assert.equal(stored[0]?.groupId, "grp_elec");
      assert.deepEqual(stored.map((record) => resolveSuggestion(ytext, record as SuggestionRecord).isStale), [false, true, false]);
      assert.equal(stored[1]?.baseQuote, "First ");
      await until(() => hub.getStatus().state === "saved-remote", "suggestions to reach the server");
      assert.deepEqual(hub.getRejected(), [], "the server accepted the overlay records");
    } finally {
      alice.app.runtime.host.release(docId);
    }
    const annotations = await serverApi<UpdatesPage>(server, `/v1/documents/${docId}/updates?fromSeq=1&limit=1000&subdoc=annotations`, { token });
    const annotationDoc = new Y.Doc();
    for (const update of annotations.body.updates) Y.applyUpdate(annotationDoc, Buffer.from(update.update, "base64"));
    const onServer = annotationDoc.getMap<SuggestionRecord>(AnnotationKeys.suggestions);
    assert.deepEqual([...onServer.keys()].sort(), [...suggested.body.suggestionIds].sort());
    assert.ok(annotations.body.updates.some((update) => update.actor?.kind === "ai" && (update.actor as { feature?: string }).feature === "agentic-review"));

    // The hub is released after each request.
    // Requests hold the hub only while they run (the materializer keeps its own reference).
    assert.equal(alice.app.runtime.host.registry.refCount(docId), baseRefs);

    // The materializer writes the shared text back to the working copy.
    await until(
      () => readFileSync(path.join(alice.dir, "library", "Shared", "notes.md"), "utf8") === "Hi there\nSecond line\nThird line\n",
      "the working copy to follow the edits",
    );

    // --- persistence: Bob's host restarts and signs in from the stored session
    await bob.app.close();
    const bobAgain = await startClient(bob.dir);
    clients.push(bobAgain);
    await until(() => lastStatus(bobAgain)?.connection === "connected", "bob to reconnect from the stored session");
    assert.equal(lastStatus(bobAgain)?.account?.id, bobId);

    // Bob leaves the project.
    const left = await bobAgain.call("POST", ControlRoutes.leave(projectId));
    assert.equal(left.status, 204);
    const after = await alice.call<Member[]>("GET", ControlRoutes.members(projectId));
    assert.deepEqual(after.body.map((member) => member.id), [aliceId]);

    // --- sign out: account files removed, status signed-out
    const signedOut = await alice.call<HostStatus>("POST", ControlRoutes.signOut);
    assert.equal(signedOut.body.connection, "signed-out");
    assert.ok(!existsSync(path.join(alice.dir, "account.json")));
    assert.ok(!existsSync(path.join(alice.dir, "session.bin")));
    assert.equal((await alice.call("POST", ControlRoutes.docSuggestions(docId), { edits: [{ start: 0, end: 0, text: "x" }] })).status, 409);

    // Sign in again (the sign-in route this time): the same account database.
    const signedIn = await alice.call<HostStatus>("POST", ControlRoutes.signIn, { serverUrl: server.url, email: "alice@example.test", password: "correct horse battery" });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const wrong = await alice.call<{ error: { code: string } }>("POST", ControlRoutes.signIn, { serverUrl: server.url, email: "alice@example.test", password: "wrong password!" });
    assert.equal(wrong.status, 403, "a refused login is not a control-token 401");
    assert.equal((await alice.call<DocText>("GET", ControlRoutes.docText(docId))).body.text, "Hi there\nSecond line\nThird line\n");
  } finally {
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("two hosts share an encrypted grant and keep independent sessions against the real server", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-elec-shared-sign-in-"));
  const server = await startServerProcess();
  const clients: Client[] = [];
  try {
    const library = path.join(root, "library");
    const a = await startClient(path.join(root, "a"), library);
    const b = await startClient(path.join(root, "b"), library);
    clients.push(a, b);
    const registered = await a.call<HostStatus>("POST", ControlRoutes.register, { serverUrl: server.url, email: "shared@example.test", password: "correct horse battery", displayName: "Shared" });
    assert.equal(registered.status, 201);
    const file = path.join(library, SHARED_SIGN_IN_FILE);
    assert.equal(existsSync(file), false, "no sharing before master unlock");
    assert.equal((await a.call("POST", ControlRoutes.unlock, { password: "master password" })).status, 202);
    await until(() => existsSync(file), "encrypted grant file");
    assert.ok(!readFileSync(file, "utf8").includes("shared@example.test"));
    assert.equal((await b.call("POST", ControlRoutes.unlock, { password: "master password" })).status, 202);
    await until(() => b.app.runtime.accounts.session !== null, "second host to adopt grant");
    assert.equal(b.app.runtime.accounts.account?.id, registered.body.account?.id);
    const sessionA = a.app.runtime.accounts.session!;
    const sessionB = b.app.runtime.accounts.session!;
    assert.notEqual(sessionA.currentRefreshToken, sessionB.currentRefreshToken);
    assert.ok(await sessionA.refresh());
    assert.ok(await sessionB.refresh(), "refreshing A does not revoke B");
    assert.equal((await b.call("POST", ControlRoutes.signOut)).status, 200);
    await b.app.runtime.sharedSignIn.unlock("master password");
    assert.equal(b.app.runtime.accounts.session, null, "explicit sign-out suppresses adoption");
    // ... but the person can choose the other computer's account again.
    const offer = await b.call<{ state: string; accountId: string; serverUrl: string; email?: string }>("GET", ControlRoutes.sharedSignIn);
    assert.deepEqual([offer.status, offer.body.state, offer.body.email], [200, "available", "shared@example.test"]);
    assert.equal((await b.call("POST", ControlRoutes.sharedSignIn)).status, 400, "the displayed identity is required");
    const changed = await b.call<{ error: { code: string } }>("POST", ControlRoutes.sharedSignIn, { ...offer.body, accountId: "another-account" });
    assert.deepEqual([changed.status, changed.body.error.code], [409, "offer-changed"]);
    const continued = await b.call<HostStatus>("POST", ControlRoutes.sharedSignIn, offer.body);
    assert.equal(continued.status, 200, JSON.stringify(continued.body));
    assert.equal(continued.body.account?.id, registered.body.account?.id);
    assert.notEqual(b.app.runtime.accounts.session, null, "continued with a session of its own");
    assert.equal((await b.call<{ state: string }>("GET", ControlRoutes.sharedSignIn)).body.state, "none", "nothing to offer once signed in");
    assert.equal((await b.call("POST", ControlRoutes.signOut)).status, 200);
    assert.equal((await a.call("POST", ControlRoutes.signOut, { everywhere: true })).status, 200);
    const refused = await b.call<{ error: { code: string } }>("POST", ControlRoutes.sharedSignIn, offer.body);
    assert.deepEqual([refused.status, refused.body.error.code], [404, "nothing-shared"], "a tombstone offers nothing to continue with");
    assert.match(readFileSync(file, "utf8"), /disabledAt/);
    const c = await startClient(path.join(root, "c"), library);
    clients.push(c);
    await c.app.runtime.sharedSignIn.unlock("master password");
    assert.equal(c.app.runtime.accounts.session, null, "new host honors global disable");
  } finally {
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a revoked refresh token asks for sign-in and keeps the account", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-elec-refresh-"));
  const server = await startServerProcess();
  const clients: Client[] = [];
  try {
    const carol = await startClient(path.join(root, "carol"));
    clients.push(carol);
    const registered = await carol.call<HostStatus>("POST", ControlRoutes.register, {
      serverUrl: server.url,
      email: "carol@example.test",
      password: "correct horse battery",
      displayName: "Carol",
    });
    assert.equal(registered.status, 201);
    await until(() => lastStatus(carol)?.connection === "connected", "carol to connect");
    await carol.app.close();

    // Revoke the stored session on the server, then restart: refresh fails.
    const stored = JSON.parse(readFileSync(path.join(carol.dir, "session.bin"), "utf8")) as { refreshToken: string };
    const refreshToken = await fakeSecrets.decrypt(stored.refreshToken);
    assert.equal((await serverApi(server, "/v1/auth/logout", { body: { refreshToken } })).status, 204);
    const again = await startClient(carol.dir);
    clients.push(again);
    await until(() => lastStatus(again)?.connection === "needs-sign-in", "needs-sign-in after a refused refresh");
    assert.equal(lastStatus(again)?.account?.email, "carol@example.test");
    assert.ok(!existsSync(path.join(carol.dir, "session.bin")), "the dead session is forgotten");
    assert.equal((await again.call("GET", ControlRoutes.projects)).status, 200, "projects still list locally");
  } finally {
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    rmSync(root, { recursive: true, force: true });
  }
});
