import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLAB_DISABLED,
  CollabClientError,
  NETWORK_ERROR,
  createCollabClient,
  describeError,
  isCollabDisabledError,
} from "../../src/lib/collab/ui/client";

type Call = { url: string; method: string; body: unknown };

function fakeFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return reply(call);
  };
  return { calls, fetch };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("every control route goes through /api/collab with the expected method and body", async () => {
  const { calls, fetch } = fakeFetch(() => json(200, {}));
  const client = createCollabClient({ fetch });
  await client.status();
  await client.signIn({ serverUrl: "https://s", email: "a@b.c", password: "pw" });
  await client.register({ serverUrl: "https://s", email: "a@b.c", password: "pw", displayName: "A", invitationToken: "tok" });
  await client.signOut();
  await client.account();
  await client.updateAccount({ color: "#123456" });
  await client.projects();
  await client.share({ notebook: "Thesis", name: "Our thesis" });
  await client.join({ invitation: "https://s/invite/abc" });
  await client.members("p 1");
  await client.changeRole("p 1", "u/2", "viewer");
  await client.removeMember("p 1", "u/2");
  await client.invitations("p 1");
  await client.invite("p 1", { email: "x@y.z", role: "commenter" });
  await client.revokeInvitation("p 1", "i1");
  await client.leave("p 1");
  await client.fileOp("p 1", { op: "create-folder", path: "Thesis/new" });
  await client.resolve("Thesis/a b.md");
  await client.doc("d1");
  await client.docText("d1");
  await client.applyEdits("d1", { edits: [{ start: 0, end: 0, text: "x" }], provenance: { kind: "user" } as never });
  await client.createSuggestions("d1", { edits: [] });
  await client.reconciliations();
  await client.resolveReconciliation("r1", { text: "merged" });
  await client.notifications({ unread: true, limit: 20 });
  await client.markNotificationsRead({ all: true });

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      "GET /api/collab/status",
      "POST /api/collab/account/sign-in",
      "POST /api/collab/account/register",
      "POST /api/collab/account/sign-out",
      "GET /api/collab/account",
      "PATCH /api/collab/account",
      "GET /api/collab/projects",
      "POST /api/collab/projects/share",
      "POST /api/collab/projects/join",
      "GET /api/collab/projects/p%201/members",
      "PATCH /api/collab/projects/p%201/members/u%2F2",
      "DELETE /api/collab/projects/p%201/members/u%2F2",
      "GET /api/collab/projects/p%201/invitations",
      "POST /api/collab/projects/p%201/invitations",
      "DELETE /api/collab/projects/p%201/invitations/i1",
      "POST /api/collab/projects/p%201/leave",
      "POST /api/collab/projects/p%201/files",
      "GET /api/collab/docs/resolve?path=Thesis%2Fa+b.md",
      "GET /api/collab/docs/d1",
      "GET /api/collab/docs/d1/text",
      "POST /api/collab/docs/d1/edits",
      "POST /api/collab/docs/d1/suggestions",
      "GET /api/collab/reconciliations",
      "POST /api/collab/reconciliations/r1",
      "GET /api/collab/notifications?unread=true&limit=20",
      "POST /api/collab/notifications/read",
    ],
  );
  assert.deepEqual(calls[2].body, { serverUrl: "https://s", email: "a@b.c", password: "pw", displayName: "A", invitationToken: "tok" });
  assert.deepEqual(calls[10].body, { role: "viewer" });
  assert.deepEqual(calls[13].body, { email: "x@y.z", role: "commenter" });
  assert.equal(calls[0].body, undefined, "GET sends no body");
});

test("204 resolves to undefined and JSON bodies are returned as-is", async () => {
  const { fetch } = fakeFetch((call) => (call.url.endsWith("/leave") ? new Response(null, { status: 204 }) : json(200, [{ id: "m1" }])));
  const client = createCollabClient({ fetch });
  assert.equal(await client.leave("p"), undefined);
  assert.deepEqual(await client.members("p"), [{ id: "m1" }]);
});

test("error codes become UI wording, keeping the server message", async () => {
  const { fetch } = fakeFetch(() => json(401, { error: { code: "unauthorized", message: "bad credentials" } }));
  const error = await createCollabClient({ fetch }).signIn({ serverUrl: "s", email: "e", password: "p" }).catch((caught) => caught);
  assert.ok(error instanceof CollabClientError);
  assert.equal(error.status, 401);
  assert.equal(error.code, "unauthorized");
  assert.equal(error.message, "The email or password is not correct.");
  assert.equal(error.serverMessage, "bad credentials");
  assert.equal(describeError(error), error.message);

  const unknown = fakeFetch(() => json(422, { error: { code: "weird", message: "Server said no." } }));
  assert.equal((await createCollabClient({ fetch: unknown.fetch }).projects().catch((caught) => caught)).message, "Server said no.");

  const invitation = fakeFetch(() => json(400, { error: { code: "invalid-invitation", message: "x" } }));
  assert.match((await createCollabClient({ fetch: invitation.fetch }).join({ invitation: "t" }).catch((caught) => caught)).message, /not valid/);

  const libera = fakeFetch(() => json(401, { error: "Unauthorized" }));
  const plain = await createCollabClient({ fetch: libera.fetch }).status().catch((caught) => caught);
  assert.equal(plain.code, "http-401");
  assert.equal(plain.message, "Unauthorized", "Libera's own { error: string } bodies keep their message");
});

test("collab-disabled, missing routes and a missing host are told apart", async () => {
  const disabled = fakeFetch(() => json(503, { error: { code: COLLAB_DISABLED, message: "off" } }));
  const off = await createCollabClient({ fetch: disabled.fetch }).status().catch((caught) => caught);
  assert.ok(isCollabDisabledError(off));
  assert.equal(off.message, "Collaboration is not enabled on this device.");

  const missing = fakeFetch(() => new Response("<html>Not found</html>", { status: 404 }));
  const gone = await createCollabClient({ fetch: missing.fetch }).status().catch((caught) => caught);
  assert.equal(gone.code, "route-missing");
  assert.ok(isCollabDisabledError(gone), "a web build without the routes hides collaboration");

  const down = fakeFetch(() => new Response("", { status: 503 }));
  const host = await createCollabClient({ fetch: down.fetch }).status().catch((caught) => caught);
  assert.equal(host.code, "host-unavailable");
  assert.equal(isCollabDisabledError(host), false, "a crashed host is an error, not a hidden feature");

  const notFound = fakeFetch(() => json(404, { error: { code: "not-found", message: "no project" } }));
  assert.equal(isCollabDisabledError(await createCollabClient({ fetch: notFound.fetch }).members("p").catch((caught) => caught)), false);
});

test("network failures are reported as such", async () => {
  const client = createCollabClient({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const error = await client.status().catch((caught) => caught);
  assert.equal(error.code, NETWORK_ERROR);
  assert.equal(error.status, 0);
  assert.match(error.message, /could not reach/);
});
