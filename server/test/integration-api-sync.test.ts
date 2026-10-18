// End-to-end: accounts, projects, invitations and documents created through
// the REST API, edited over the sync socket, with membership changes reaching
// open sockets. Uses the real sync service (no stubs).

import assert from "node:assert/strict";
import test from "node:test";

import * as Y from "yjs";

import { MessageType, toBase64, type ClosedMessage, type EventMessage } from "../src/protocol.js";
import { json, startTestServer } from "./helpers.js";
import { register, request } from "./support/api-harness.js";
import { SyncTestClient } from "./support/sync-client.js";

function initialContent(text: string): string {
  const doc = new Y.Doc();
  doc.getText("source").insert(0, text);
  return toBase64(Y.encodeStateAsUpdate(doc));
}

test("REST-created documents sync between invited members, and removal closes them", async () => {
  const server = await startTestServer();
  const clients: SyncTestClient[] = [];
  try {
    const owner = await register(server, "owner");
    const project = await request(server, "POST", "/v1/projects", owner, { name: "Thesis" });
    assert.equal(project.status, 201);
    const projectId: string = project.body.id;

    // Invite by email, then accept as the new account.
    const invite = await request(server, "POST", `/v1/projects/${projectId}/invitations`, owner, {
      email: "bob@example.test",
      role: "editor",
    });
    assert.equal(invite.status, 201);
    const bob = await json<{ account: { id: string }; accessToken: string }>(server.url, "/v1/auth/register", {
      body: {
        email: "bob@example.test",
        password: "correct horse battery",
        displayName: "Bob",
        invitationToken: invite.body.token,
      },
    });
    assert.equal(bob.status, 201);
    const bobUser = { id: bob.body.account.id, email: "bob@example.test", token: bob.body.accessToken, auth: bob.body as never };
    const members = await request(server, "GET", `/v1/projects/${projectId}/members`, owner);
    assert.deepEqual(
      members.body.map((member: { role: string }) => member.role).sort(),
      ["editor", "owner"],
    );

    // One-time import of a document with initial text.
    const docId = "doc_integration_1";
    const created = await request(server, "POST", `/v1/projects/${projectId}/documents`, owner, {
      docId,
      fileId: "fil_integration_1",
      kind: "markdown",
      initial: { content: initialContent("# Title\n") },
    });
    assert.equal(created.status, 201);

    const alice = await SyncTestClient.connect(server.wsUrl, { token: owner.token });
    const bobClient = await SyncTestClient.connect(server.wsUrl, { token: bobUser.token });
    clients.push(alice, bobClient);
    const openedByAlice = await alice.open(docId);
    assert.equal(openedByAlice.role, "owner");
    assert.equal(alice.text(docId), "# Title\n");
    await bobClient.open(docId);
    assert.equal(bobClient.text(docId), "# Title\n");

    const sent = alice.edit(docId, "content", (doc) => doc.getText("source").insert(8, "Hello from Alice.\n"));
    const ack = await alice.acked(sent);
    assert.ok(ack.serverSeq > 1, "import occupies the first sequence numbers");
    await bobClient.waitFor((m) => m.type === MessageType.Remote && m.docId === docId);
    assert.equal(bobClient.text(docId), "# Title\nHello from Alice.\n");

    // The updates feed shows the edit, attributed to Alice.
    const feed = await request(server, "GET", `/v1/documents/${docId}/updates?fromSeq=1`, owner);
    assert.equal(feed.status, 200);
    const last = feed.body.updates.at(-1);
    assert.equal(last.userId, owner.id);
    assert.equal(last.serverSeq, ack.serverSeq);

    // Downgrade Bob to commenter: the socket learns the new role, and content writes are refused.
    const downgrade = await request(server, "PATCH", `/v1/projects/${projectId}/members/${bobUser.id}`, owner, {
      role: "commenter",
    });
    assert.equal(downgrade.status, 200);
    const roleEvent = await bobClient.waitFor<EventMessage>(
      (m) => m.type === MessageType.Event && m.kind === "member.role-changed",
    );
    assert.deepEqual(roleEvent.payload, { projectId, role: "commenter" });
    const refused = bobClient.edit(docId, "content", (doc) => doc.getText("source").insert(0, "x"));
    const rejection = await bobClient.rejected(refused);
    assert.equal(rejection.reason, "forbidden");

    // Remove Bob: the open document is closed for him.
    const removed = await request(server, "DELETE", `/v1/projects/${projectId}/members/${bobUser.id}`, owner);
    assert.equal(removed.status, 204);
    const closed = await bobClient.waitFor<ClosedMessage>((m) => m.type === MessageType.Closed && m.docId === docId);
    assert.equal(closed.reason, "access-revoked");

    // Deleting the document closes it for the owner too.
    const deleted = await request(server, "DELETE", `/v1/documents/${docId}`, owner);
    assert.equal(deleted.status, 204);
    const closedForAlice = await alice.waitFor<ClosedMessage>((m) => m.type === MessageType.Closed && m.docId === docId);
    assert.equal(closedForAlice.reason, "document-deleted");
  } finally {
    for (const client of clients) await client.close();
    await server.close();
  }
});

test("logout everywhere through refresh-token reuse closes the account's sockets", async () => {
  const server = await startTestServer();
  try {
    const user = await register(server, "carol");
    const socket = await SyncTestClient.connect(server.wsUrl, { token: user.token });
    const firstRefresh = await json<{ refreshToken: string }>(server.url, "/v1/auth/refresh", {
      body: { refreshToken: user.auth.refreshToken },
    });
    assert.equal(firstRefresh.status, 200);
    // Reusing the rotated token is treated as theft: the family is revoked.
    const reuse = await json(server.url, "/v1/auth/refresh", { body: { refreshToken: user.auth.refreshToken } });
    assert.equal(reuse.status, 401);
    const { code } = await socket.closed;
    assert.equal(code, 4002);
  } finally {
    await server.close();
  }
});
