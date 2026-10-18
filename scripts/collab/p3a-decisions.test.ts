// Suggestion decisions end to end (plan M3.3, hard cases 3, 5 and 6): three
// real hosts behind their control APIs (Alice owner, Bob editor, Carol
// commenter) against the real collab server, each with a renderer replica,
// a registry and the window's suggestions controller talking to its own
// control API. Bob's host can be cut off the network to queue decisions.

import { restoreNodeEvent } from "./support/p3a-node-websocket";
import { dom } from "./support/wire-dom";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { startControlApp, type ControlApp } from "../../electron/collab/control";
import type { SecretCodec } from "../../electron/collab/control/account";
import type { NotebookService } from "../../electron/collab/control/types";
import type { FetchLike } from "../../electron/collab/core/api-client";
import { createMemoryPortPair } from "../../electron/collab/core/ports";
import { createSharedDocument } from "../../electron/collab/notebooks/documents";
import { defaultWebSocketFactory, type WebSocketFactory, type WebSocketLike } from "../../electron/collab/core/sync-client";
import { ControlRoutes, type HostEvent, type HostStatus, type ResolvedDoc } from "../../src/lib/collab/local-api";
import type { Invitation, UpdatesPage } from "../../src/lib/collab/protocol/api";
import type { Role } from "../../src/lib/collab/protocol/roles";
import { SharedDocRegistry, type SharedDocSession } from "../../src/lib/collab/client/registry";
import { suggestionsFor, type SuggestionsController } from "../../src/lib/collab/client/suggestions";
import { createSuggestionsApi } from "../../src/lib/collab/client/suggestions-api";
import { createCollabClient } from "../../src/lib/collab/ui/client";
import { getSuggestion, listSuggestions, resolveSuggestion } from "../../src/lib/collab/suggestions/model";
import { previewSuggestions } from "../../src/lib/collab/suggestions/codemirror";
import { mountCodeMirror } from "./support/p3a-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";
import { browserPort } from "./support/wire-harness";

restoreNodeEvent();
after(() => dom.window.close());

const quietLogger = { warn() {}, error() {} };
const fakeSecrets: SecretCodec = {
  encrypt: async (plaintext) => `enc:${Buffer.from(plaintext).toString("base64")}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.slice(4), "base64").toString(),
};

async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A host's network: off, every socket drops and every request fails as a network error. */
function networkSwitch() {
  let online = true;
  const sockets = new Set<WebSocketLike>();
  const factory: WebSocketFactory = (url) => {
    if (!online) {
      const refused: WebSocketLike = { binaryType: "arraybuffer", readyState: 3, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
      setTimeout(() => { refused.onerror?.({}); refused.onclose?.({ code: 1006, reason: "offline" }); }, 5);
      return refused;
    }
    const socket = defaultWebSocketFactory(url);
    sockets.add(socket);
    return socket;
  };
  const fetchImpl: FetchLike = (url, init) => (online ? fetch(url, init) : Promise.reject(new TypeError("fetch failed (offline)")));
  return {
    factory,
    fetch: fetchImpl,
    set(value: boolean) {
      online = value;
      if (value) return;
      for (const socket of sockets) {
        try { socket.close(4000, "offline"); } catch { /* already closed */ }
      }
      sockets.clear();
    },
  };
}

const noNotebooks = (): NotebookService => ({
  start: async () => {},
  stop: async () => {},
  resolvePath: () => null,
  accountChanged: async () => {},
  registerRoutes: () => {},
  localProjects: () => [],
});

interface Client {
  name: string;
  app: ControlApp;
  events: HostEvent[];
  listeners: Set<(event: HostEvent) => void>;
  userId: string;
  call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }>;
}

async function startClient(root: string, name: string, serverUrl: string, network?: ReturnType<typeof networkSwitch>, invitationToken?: string): Promise<Client> {
  const events: HostEvent[] = [];
  const listeners = new Set<(event: HostEvent) => void>();
  const app = await startControlApp({
    collabDir: path.join(root, name),
    libraryRoot: path.join(root, name, "library"),
    appVersion: "test",
    installationId: `inst_${name}_p3a`,
    secrets: fakeSecrets,
    emit: (event) => {
      events.push(event);
      for (const listener of [...listeners]) listener(event);
    },
    logger: quietLogger,
    createNotebookService: noNotebooks,
    ...(network ? { fetch: network.fetch } : {}),
    host: { compaction: false, hubIdleMs: 50, limits: { backoffBaseMs: 40, backoffMaxMs: 250 }, ...(network ? { webSocketFactory: network.factory } : {}) },
  });
  const call = async <T>(method: string, route: string, body?: unknown) => {
    const response = await fetch(`${app.address.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${app.address.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const registered = await call<HostStatus>("POST", ControlRoutes.register, {
    serverUrl,
    email: `${name}@example.test`,
    password: "correct horse battery",
    displayName: name[0].toUpperCase() + name.slice(1),
    ...(invitationToken ? { invitationToken } : {}),
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  await until(() => app.runtime.host.connectionState === "connected", `${name} to connect`);
  return { name, app, events, listeners, userId: registered.body.account!.id, call };
}

interface Window {
  client: Client;
  registry: SharedDocRegistry;
  session: SharedDocSession;
  controller: SuggestionsController;
  close(): void;
}

/** A renderer window on `client`'s host: replica, registry, controller on that host's control API. */
async function openWindow(client: Client, resolved: ResolvedDoc, role: Role): Promise<Window> {
  const host = client.app.runtime.host;
  const hub = host.acquire(resolved.docId, { projectId: resolved.projectId });
  const registry = new SharedDocRegistry({
    resolve: async () => resolved,
    attach: async () => {
      const pair = createMemoryPortPair();
      hub.attachReplica(pair.hub);
      return browserPort(pair.replica);
    },
    subscribeEvents: () => () => {},
    replicaOptions: { schedule: queueMicrotask },
    available: () => true,
  });
  registry.setLocalUser({ name: client.name, color: "#336699", userId: client.userId });
  await registry.bindTab("tab", resolved.path);
  const session = registry.sessionForTab("tab")!;
  await session.replica.whenAttached();
  await until(() => session.replica.getSnapshot().meta?.role === role && session.replica.text() !== "", `${client.name}'s replica to load as ${role}`);
  const api = createSuggestionsApi(createCollabClient({
    prefix: client.app.address.url,
    fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${client.app.address.token}` } }),
  }));
  const controller = suggestionsFor(session, {
    api,
    registry,
    subscribeEvents: (listener) => {
      client.listeners.add(listener);
      return () => { client.listeners.delete(listener); };
    },
    loadMembers: async () => [],
    pollMs: 150,
  });
  return {
    client,
    registry,
    session,
    controller,
    close() {
      controller.destroy();
      registry.destroy();
      host.release(resolved.docId);
    },
  };
}

const text = (window: Window) => window.session.replica.text();
const status = (window: Window, id: string) => getSuggestion(window.session.replica.annotations, id)?.status;
const seen = (window: Window, id: string) => getSuggestion(window.session.replica.annotations, id) !== null;

test("decisions, accept-all, author-only actions, revert, offline replay and AI on a commenter's tab", { timeout: 300_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "libera-p3a-"));
  const server = await startServerProcess();
  const network = networkSwitch();
  const clients: Client[] = [];
  const windows: Window[] = [];
  try {
    const alice = await startClient(root, "alice", server.url);
    clients.push(alice);
    const api = alice.app.runtime.host.api!;
    const project = await api.createProject({ name: "P3A" });
    const docId = "doc_p3a_decisions_0001";
    const initial = "The quick brown fox.\n\nIt jumps over the lazy dog.\n";
    await createSharedDocument(api, project.id, { docId, fileId: "file_p3a_0001" }, "markdown", initial);
    const invite = async (email: string, role: Role) => {
      const created = await alice.call<Invitation>("POST", ControlRoutes.invitations(project.id), { email, role });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return `${server.url}/invite/${created.body.token}`;
    };
    const bob = await startClient(root, "bob", server.url, network, await invite("bob@example.test", "editor"));
    const carol = await startClient(root, "carol", server.url, undefined, await invite("carol@example.test", "commenter"));
    clients.push(bob, carol);
    const resolved = (role: Role): ResolvedDoc => ({ docId, projectId: project.id, fileId: "file_p3a_0001", path: "P3A/note.md", kind: "markdown", role, readOnly: false });
    const aliceWin = await openWindow(alice, resolved("owner"), "owner");
    const bobWin = await openWindow(bob, resolved("editor"), "editor");
    const carolWin = await openWindow(carol, resolved("commenter"), "commenter");
    windows.push(aliceWin, bobWin, carolWin);
    const at = (window: Window, quote: string) => text(window).indexOf(quote);

    await t.test("an accept applies once on the server and reaches every editor as a remote update", async () => {
      const editor = mountCodeMirror(bobWin.session, bobWin.registry);
      try {
        const start = at(bobWin, "quick");
        const created = bobWin.controller.suggest(start, start + 5, "slow");
        assert.ok(created.ok);
        const id = created.ids[0];
        await until(() => seen(aliceWin, id), "Alice to see Bob's suggestion");
        await until(() => previewSuggestions(editor.view.state).length === 1, "the overlay in Bob's editor");
        const decision = aliceWin.controller.decide([id], "accept");
        assert.equal(aliceWin.controller.group(id)?.pending?.decision, "accept", "Accepting… shows at once");
        assert.deepEqual(await decision.sent, { queued: false });
        const outcomes = await decision.settled;
        assert.equal(outcomes.get(id)?.kind, "applied");
        assert.equal(outcomes.get(id)?.decidedBy?.id, alice.userId);
        const expected = initial.replace("quick", "slow");
        for (const window of [aliceWin, bobWin, carolWin]) await until(() => text(window) === expected && status(window, id) === "accepted", `${window.client.name} to get the accepted text`);
        await until(() => editor.view.state.doc.toString() === expected, "Bob's editor to show it");
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(text(bobWin), expected, "applied exactly once, however many replicas saw it");
        assert.equal(editor.view.state.doc.toString(), expected);
        assert.equal(previewSuggestions(editor.view.state).length, 0, "the preview is gone");
        const feed = await alice.app.runtime.host.api!.request<UpdatesPage>("GET", `/v1/documents/${docId}/updates`, { query: { fromSeq: 1, limit: 1000, subdoc: "content" } });
        assert.equal(feed.updates.filter((update) => (update.provenance as { suggestionId?: string } | null)?.suggestionId === id).length, 1, "one content update carries the suggestion");
        assert.equal(aliceWin.controller.group(id)?.canRevert, true, "Undo acceptance is offered to the decider");

        // A second reviewer deciding the same suggestion learns who won (hard case 3).
        const late = await bobWin.controller.decide([id], "reject").settled;
        assert.equal(late.get(id)?.kind, "already-decided");
        assert.match(late.get(id)?.message ?? "", /Alice/);
      } finally {
        editor.destroy();
      }
    });

    await t.test("a reject leaves the text alone", async () => {
      const start = at(bobWin, "lazy");
      const created = bobWin.controller.suggest(start, start + 4, "sleepy");
      assert.ok(created.ok);
      await until(() => seen(aliceWin, created.ids[0]), "Alice to see it");
      const before = text(aliceWin);
      const outcomes = await aliceWin.controller.decide(created.ids, "reject").settled;
      assert.equal(outcomes.get(created.ids[0])?.kind, "rejected");
      await until(() => status(bobWin, created.ids[0]) === "rejected", "Bob to see the rejection");
      assert.equal(text(bobWin), before);
    });

    await t.test("accept-all takes a checkpoint, applies in order and skips a stale suggestion (hard case 6)", async () => {
      const base = text(bobWin);
      const ids = ["The", "brown", "jumps"].map((quote) => {
        const start = base.indexOf(quote);
        const created = bobWin.controller.suggest(start, start + quote.length, quote.toUpperCase());
        assert.ok(created.ok);
        return created.ids[0];
      });
      await until(() => ids.every((id) => seen(aliceWin, id)), "Alice to see the three suggestions");
      // Alice edits inside the middle one: it can no longer apply.
      const brown = at(aliceWin, "brown");
      aliceWin.session.replica.ytext.delete(brown + 1, 3);
      aliceWin.session.replica.ytext.insert(brown + 1, "lac");
      await until(() => aliceWin.controller.group(ids[1])?.state === "stale", "the middle suggestion to resolve stale");
      // Decisions are checked against the server's text: let Alice's edit get there first.
      await until(() => text(bobWin).includes("blacn"), "Alice's edit to reach the server");
      const outcomes = await aliceWin.controller.acceptAll().settled;
      assert.deepEqual(ids.map((id) => outcomes.get(id)?.kind), ["applied", "stale", "applied"]);
      await until(() => text(bobWin).startsWith("THE slow blacn fox.") && text(bobWin).includes("JUMPS"), `Bob to get the batch (${JSON.stringify(text(bobWin))})`);
      await until(() => status(bobWin, ids[1]) === "stale", "the skipped one marked stale for everyone");
      const revisions = await alice.app.runtime.host.api!.request<Array<{ kind: string }>>("GET", `/v1/documents/${docId}/revisions`);
      assert.ok(revisions.some((revision) => revision.kind === "pre-accept-all"), "a checkpoint was taken first");
    });

    await t.test("only the author withdraws or edits a suggestion", async () => {
      const start = at(bobWin, "dog");
      const created = bobWin.controller.suggest(start, start + 3, "cat");
      assert.ok(created.ok);
      const id = created.ids[0];
      await until(() => seen(aliceWin, id), "Alice to see it");
      assert.deepEqual(aliceWin.controller.withdraw(id), [{ ok: false, reason: "not-owner" }]);
      assert.equal(aliceWin.controller.edit(id, "cow").ok, false);
      assert.equal(aliceWin.controller.group(id)?.canWithdraw, false);
      assert.equal(bobWin.controller.group(id)?.canWithdraw, true);
      assert.equal(bobWin.controller.edit(id, "fox").ok, true);
      await until(() => getSuggestion(aliceWin.session.replica.annotations, id)?.replacement === "fox", "the edit to reach Alice");
      assert.deepEqual(bobWin.controller.withdraw(id).map((result) => result.ok), [true]);
      await until(() => status(aliceWin, id) === "withdrawn", "the withdrawal to reach Alice");
      const hub = bob.app.runtime.host.registry.get(docId);
      assert.deepEqual(hub?.getRejected() ?? [], [], "the server accepted the author's own changes");
      await until(async () => (await aliceWin.controller.loadHistory())?.find((info) => info.id === id)?.status === "withdrawn", "the server mirror to record it");
    });

    await t.test("Undo acceptance reverts, or reports a conflict when the text changed", async () => {
      const start = at(bobWin, "over");
      const created = bobWin.controller.suggest(start, start + 4, "above");
      assert.ok(created.ok);
      const id = created.ids[0];
      await until(() => seen(aliceWin, id), "Alice to see it");
      const before = text(aliceWin);
      assert.equal((await aliceWin.controller.decide([id], "accept").settled).get(id)?.kind, "applied");
      await until(() => text(aliceWin).includes("above"), "the accepted text");
      const [reverted] = await aliceWin.controller.revert(id);
      assert.equal(reverted.kind, "reverted");
      await until(() => text(bobWin) === before, "the text to be restored everywhere");
      await until(() => status(bobWin, id) === "pending", "the suggestion to be pending again");

      const again = await aliceWin.controller.decide([id], "accept").settled;
      assert.equal(again.get(id)?.kind, "applied");
      await until(() => text(bobWin).includes("above"), "Bob to get it");
      const above = at(bobWin, "above");
      bobWin.session.replica.ytext.insert(above + 2, "XX");
      await until(() => text(aliceWin).includes("abXXove"), "Bob's edit to reach Alice");
      const [conflict] = await aliceWin.controller.revert(id);
      assert.equal(conflict.kind, "conflict");
      assert.match(conflict.message, /changed/);
      assert.ok(text(aliceWin).includes("abXXove"), "a conflicting revert changes nothing");
    });

    await t.test("an offline decision is queued, replayed on reconnect, and comes back stale if the text changed (hard case 5)", async () => {
      const startA = at(aliceWin, "lazy");
      const changing = aliceWin.controller.suggest(startA, startA + 4, "idle");
      const startB = at(aliceWin, "fox");
      const stable = aliceWin.controller.suggest(startB, startB + 3, "wolf");
      assert.ok(changing.ok && stable.ok);
      const [changingId, stableId] = [changing.ids[0], stable.ids[0]];
      await until(() => seen(bobWin, changingId) && seen(bobWin, stableId), "Bob to see Alice's suggestions");

      network.set(false);
      await until(() => bob.app.runtime.host.connectionState !== "connected", "Bob to go offline");
      const first = bobWin.controller.decide([changingId], "accept");
      const second = bobWin.controller.decide([stableId], "accept");
      assert.deepEqual(await first.sent, { queued: true });
      assert.deepEqual(await second.sent, { queued: true });
      assert.equal(bobWin.controller.group(changingId)?.pending?.phase, "queued", "shown as Accepting… (offline)");
      assert.equal(bob.app.runtime.host.commands.list().filter((row) => row.command.kind === "suggestions.decide").length, 2, "both wait in the host's queue");

      // Meanwhile Alice edits the passage the first suggestion replaces.
      const lazy = at(aliceWin, "lazy");
      aliceWin.session.replica.ytext.delete(lazy, 4);
      aliceWin.session.replica.ytext.insert(lazy, "LAZY");
      await new Promise((resolve) => setTimeout(resolve, 300));

      network.set(true);
      bob.app.runtime.nudge();
      const [changed, applied] = await Promise.all([first.settled, second.settled]);
      assert.equal(changed.get(changingId)?.kind, "stale", "the replay is checked against today's text");
      assert.equal(applied.get(stableId)?.kind, "applied");
      assert.equal(bobWin.controller.group(changingId)?.pending, undefined, "the optimistic accept is rolled back");
      assert.ok(bob.events.some((event) => event.t === "suggestions-settled" && event.docId === docId), "the outcome arrived as a host event");
      await until(() => text(bobWin).includes("wolf") && text(bobWin).includes("LAZY") && !text(bobWin).includes("idle"), "Bob to converge");
      await until(() => status(aliceWin, changingId) === "stale", "the stale state reaches Alice");
    });

    await t.test("AI on a commenter's tab makes a pending AI suggestion that only an editor can accept", async () => {
      assert.equal(carolWin.controller.canDecide(), false);
      assert.equal(carolWin.controller.canSuggest(), true);
      const snapshot = text(carolWin);
      const start = snapshot.indexOf("dog");
      assert.ok(start >= 0, snapshot);
      const result = carolWin.controller.suggestAi(snapshot, [{ start, end: start + 3, before: "dog", after: "hound" }], { feature: "rewrite" });
      assert.ok(result.ok && result.matched === 1, JSON.stringify(result));
      const id = result.ok ? result.ids[0] : "";
      await until(() => seen(aliceWin, id), "Alice to see Carol's AI suggestion");
      const record = getSuggestion(aliceWin.session.replica.annotations, id)!;
      assert.deepEqual([record.actor.kind, (record.actor as { onBehalfOf?: string }).onBehalfOf, record.createdBy, record.status], ["ai", carol.userId, carol.userId, "pending"]);
      assert.match(aliceWin.controller.group(id)?.label ?? "", /^AI · on behalf of /, "labelled as AI acting for its user");
      const refused = await carolWin.controller.decide([id], "accept").settled;
      assert.equal(refused.get(id)?.kind, "failed");
      const direct = await carol.call<{ error: { code: string } }>("POST", ControlRoutes.docSuggestionDecisions(docId), { decisions: [{ suggestionId: id, decision: "accept" }] });
      assert.equal(direct.status, 403, "the server refuses a commenter's decision");
      const aiDecision = await alice.call<{ error: { code: string } }>("POST", ControlRoutes.docSuggestionDecisions(docId), { decisions: [{ suggestionId: id, decision: "accept" }], ai: { feature: "agent" } });
      assert.deepEqual([aiDecision.status, aiDecision.body.error.code], [403, "ai-cannot-decide"]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(status(carolWin, id), "pending", "it stays pending for an editor");
      assert.equal(resolveSuggestion(carolWin.session.replica.ytext, getSuggestion(carolWin.session.replica.annotations, id)!).isStale, false);
      assert.equal((await aliceWin.controller.decide([id], "accept").settled).get(id)?.kind, "applied");
      await until(() => text(carolWin).includes("hound"), "Carol to get the accepted AI text");
      assert.equal(listSuggestions(carolWin.session.replica.annotations, { status: "pending" }).length, 0);
    });
  } finally {
    for (const window of windows) window.close();
    for (const client of clients) await client.app.close().catch(() => undefined);
    await server.stop().catch(() => undefined);
    removeDataDir(server.dataDir);
    // Windows may still hold a WAL handle for a moment; the temp dir is disposable.
    try { rmSync(root, { recursive: true, force: true }); } catch { /* left for the OS */ }
  }
});
