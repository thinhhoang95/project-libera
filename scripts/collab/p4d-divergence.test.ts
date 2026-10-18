// The divergence check (electron/collab/core/divergence.ts) against the real
// collab server: a matching replica, an unacked edit (skipped), a replica
// that missed an insert (different state vectors: inconclusive, then a
// match after it catches up), a replica that missed a deletion (same state
// vector, different text: a real mismatch, recovered by re-opening with the
// server's full state), and a closed document checked from SQLite.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import * as Y from "yjs";

import { compareDigest, digestOf } from "../../electron/collab/core/divergence";
import type { CollabHost, CollabHostEvent } from "../../electron/collab/core/host";
import type { DocumentDigest } from "../../src/lib/collab/protocol/api";
import { MessageType } from "../../src/lib/collab/protocol/messages";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { api, createDocument, createTeam, filteringSockets, makeHost, until, type Team } from "./p4d-support";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

let server: ServerProcess;
let dir: string;
const hosts: CollabHost[] = [];

before(async () => {
  server = await startServerProcess();
  dir = mkdtempSync(path.join(tmpdir(), "libera-p4d-div-"));
});

after(async () => {
  for (const host of hosts) await host.stop().catch(() => {});
  await server?.stop();
  removeDataDir(server?.dataDir ?? "");
  rmSync(dir, { recursive: true, force: true });
});

const text = (doc: Y.Doc) => doc.getText(ContentKeys.source);

test("compareDigest: equal vectors compare hashes; different vectors are inconclusive", () => {
  const doc = new Y.Doc();
  text(doc).insert(0, "hello");
  const local = { subdoc: "content" as const, stateVector: Y.encodeStateVector(doc), contentSha256: digestOf("content", doc) };
  const digest: DocumentDigest = {
    docId: "doc_x",
    kind: "markdown",
    serverSeq: 1,
    contentSha256: local.contentSha256,
    stateVectors: { content: Buffer.from(local.stateVector).toString("base64") },
  };
  assert.equal(compareDigest(local, digest), "match");
  assert.equal(compareDigest(local, { ...digest, contentSha256: "0".repeat(64) }), "mismatch");
  const other = new Y.Doc();
  text(other).insert(0, "hello!");
  assert.equal(compareDigest(local, { ...digest, stateVectors: { content: Buffer.from(Y.encodeStateVector(other)).toString("base64") } }), "inconclusive");
  assert.equal(compareDigest(local, { ...digest, stateVectors: {} }), "inconclusive");
});

async function team(docId: string): Promise<{ team: Team; a: CollabHost; b: CollabHost; sockets: ReturnType<typeof filteringSockets>; events: CollabHostEvent[] }> {
  const t = await createTeam(server);
  await createDocument(server, t, docId);
  const sockets = filteringSockets();
  const a = makeHost(dir, `alice-${docId}`, server, t.alice, { webSocketFactory: sockets.factory });
  const b = makeHost(dir, `bob-${docId}`, server, t.bob);
  hosts.push(a, b);
  const events: CollabHostEvent[] = [];
  a.on((event) => events.push(event));
  return { team: t, a, b, sockets, events };
}

test("match, skipped while unacked, inconclusive while behind, then match after catching up", { timeout: 120_000 }, async () => {
  const docId = "doc_p4d_div_match";
  const { a, b, sockets } = await team(docId);
  const hubA = a.acquire(docId, { kind: "file" });
  const hubB = b.acquire(docId, { kind: "file" });
  hubA.applyLocalChange("content", (doc) => text(doc).insert(0, "hello world"), { source: "typing" });
  await until(() => hubB.getText() === "hello world", "Bob to receive Alice's text");
  await until(() => hubA.getStatus().state === "saved-remote" && hubB.getStatus().state === "saved-remote", "both saved");

  const matched = await a.divergence.checkDoc(docId);
  assert.equal(matched.outcome, "match");
  assert.equal((await b.divergence.checkDoc(docId)).outcome, "match");

  // An unacked local edit legitimately differs: not compared.
  hubA.applyLocalChange("content", (doc) => text(doc).insert(0, "> "), { source: "typing" });
  const skipped = await a.divergence.checkDoc(docId);
  assert.equal(skipped.outcome, "skipped");
  assert.equal(skipped.detail, "pending");
  await until(() => hubA.getStatus().state === "saved-remote" && hubB.getText() === hubA.getText(), "the edit to sync");

  // Alice misses Bob's insert: her state vector is behind the server's.
  sockets.state.drop = (message) => message.type === MessageType.Remote;
  hubB.applyLocalChange("content", (doc) => text(doc).insert(text(doc).length, " again"), { source: "typing" });
  await until(() => hubB.getStatus().state === "saved-remote", "Bob's insert to be acked");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!hubA.getText().includes("again"), "Alice really missed the update");
  const behind = await a.divergence.checkDoc(docId);
  assert.equal(behind.outcome, "inconclusive");
  assert.deepEqual(a.divergence.pendingRetries(), [docId], "an inconclusive check is retried later");

  // Reconnecting catches her up; the retry then matches.
  sockets.state.drop = () => false;
  sockets.dropConnection();
  await until(() => hubA.getText() === hubB.getText(), "Alice to catch up after reconnecting");
  await until(() => hubA.getStatus().state === "saved-remote", "Alice saved");
  assert.equal((await a.divergence.checkDoc(docId)).outcome, "match");
  assert.deepEqual(a.divergence.pendingRetries(), []);
  assert.equal(a.journal.counters().divergenceChecks, 2, "only conclusive checks (match, mismatch) are counted");
  assert.equal(a.journal.counters().divergenceFailures, 0);
});

test("a missed deletion is a mismatch; a full re-open recovers it without losing local text", { timeout: 120_000 }, async () => {
  const docId = "doc_p4d_div_mismatch";
  const { team: t, a, b, sockets, events } = await team(docId);
  const hubA = a.acquire(docId, { kind: "file" });
  const hubB = b.acquire(docId, { kind: "file" });
  hubA.applyLocalChange("content", (doc) => text(doc).insert(0, "keep this line\nremove this line\n"), { source: "typing" });
  await until(() => hubB.getText() === hubA.getText(), "Bob to receive the text");
  await until(() => hubA.getStatus().state === "saved-remote" && hubB.getStatus().state === "saved-remote", "both saved");

  // Bob deletes a line; Alice never hears of it. A deletion adds no
  // structs, so her state vector still equals the server's.
  sockets.state.drop = (message) => message.type === MessageType.Remote;
  hubB.applyLocalChange("content", (doc) => text(doc).delete("keep this line\n".length, "remove this line\n".length), { source: "typing" });
  await until(() => hubB.getStatus().state === "saved-remote", "Bob's deletion to be acked");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(hubA.getText(), "keep this line\nremove this line\n");
  const digest = await api<DocumentDigest>(server, `/v1/documents/${docId}/digest`, { token: t.alice.accessToken });
  assert.equal(digest.status, 200);
  assert.equal(
    Buffer.from(Y.encodeStateVector(hubA.getDoc("content"))).toString("base64"),
    digest.body.stateVectors.content,
    "same state vector as the server",
  );

  const record = await a.divergence.checkDoc(docId);
  assert.equal(record.outcome, "mismatch");
  assert.equal(record.recovered, true, record.detail);
  assert.equal(record.detail, "recovered-by-full-reopen");
  assert.equal(hubA.getText(), "keep this line\n", "the server's deletion merged in");
  assert.equal(hubA.getText(), hubB.getText());
  assert.ok(events.some((event) => event.source === "divergence" && event.docId === docId), "a divergence host event was emitted");
  const counters = a.journal.counters();
  assert.equal(counters.divergenceFailures, 1);
  assert.ok(a.journal.errors().some((entry) => entry.source === "divergence" && entry.docId === docId && entry.code === "recovered"));

  // The stand-in sync target keeps working: live edits still flow both ways.
  sockets.state.drop = () => false;
  hubA.applyLocalChange("content", (doc) => text(doc).insert(0, "after recovery\n"), { source: "typing" });
  await until(() => hubB.getText().startsWith("after recovery\n"), "Alice's edit to reach Bob after recovery");
  hubB.applyLocalChange("content", (doc) => text(doc).insert(text(doc).length, "bob tail\n"), { source: "typing" });
  await until(() => hubA.getText().endsWith("bob tail\n"), "Bob's edit to reach Alice after recovery");
  await until(() => hubA.getStatus().state === "saved-remote", "Alice saved");
  assert.equal((await a.divergence.checkDoc(docId)).outcome, "match");
});

test("a closed document is checked from SQLite and checkAll includes docs synced this run", { timeout: 120_000 }, async () => {
  const docId = "doc_p4d_div_closed";
  const { a } = await team(docId);
  const hubA = a.acquire(docId, { kind: "file" });
  hubA.applyLocalChange("content", (doc) => text(doc).insert(0, "closed doc text"), { source: "typing" });
  await until(() => hubA.getStatus().state === "saved-remote", "saved");
  a.release(docId);
  await until(() => a.registry.get(docId) === null, "the hub to close");
  const records = await a.divergence.checkAll();
  const record = records.find((entry) => entry.docId === docId);
  assert.ok(record, "the closed doc is a candidate");
  assert.equal(record.outcome, "match");
  assert.equal(a.registry.get(docId), null, "checking did not reopen the hub");
});

test("signed out: checks are skipped without a request", async () => {
  const docId = "doc_p4d_div_signed_out";
  const { a } = await team(docId);
  a.setAccount(null);
  const record = await a.divergence.checkDoc(docId);
  assert.equal(record.outcome, "skipped");
  assert.equal(record.detail, "signed-out");
});

