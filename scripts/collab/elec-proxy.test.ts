// The /api/collab proxy route and the server-side host client, against a
// fake control server: session auth, method/path/query/body forwarding with
// the bearer token, 503 when collaboration is off or the host is down, and
// a host 401 that must not read as an expired app session.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { NextRequest } from "next/server";

import { DELETE, GET, PATCH, POST } from "../../src/app/api/collab/[...path]/route";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../src/lib/auth";
import { CollabHostError, applyEdits, collabHostConfig, createSuggestions, getDocText, resolveSharedPath } from "../../src/lib/collab/host-client";
import { ControlRoutes, LOCAL_API_PREFIX } from "../../src/lib/collab/local-api";

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

async function fakeControlServer(token: string) {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization, body });
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "unauthorized", message: "bad token" } }));
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url?.startsWith("/docs/resolve")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("null");
        return;
      }
      if (request.url?.includes("/missing")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "unknown-doc", message: "nope" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ echo: { method: request.method, url: request.url, body: body ? JSON.parse(body) : null } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { seen, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function nextRequest(route: string, init: { method?: string; body?: unknown; authenticated?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (init.authenticated !== false) headers.cookie = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${LOCAL_API_PREFIX}${route}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function context(route: string) {
  // Next passes decoded catch-all segments.
  const pathOnly = route.split("?")[0];
  return { params: Promise.resolve({ path: pathOnly.split("/").filter(Boolean).map(decodeURIComponent) }) };
}

function withEnv(values: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("proxy route: 401 without a session, 503 when collaboration is off", async () => {
  const restore = withEnv({ LIBERA_COLLAB_HOST_URL: undefined, LIBERA_COLLAB_HOST_TOKEN: undefined });
  try {
    assert.equal((await GET(nextRequest(ControlRoutes.status, { authenticated: false }), context(ControlRoutes.status))).status, 401);
    const disabled = await GET(nextRequest(ControlRoutes.status), context(ControlRoutes.status));
    assert.equal(disabled.status, 503);
    assert.deepEqual(await disabled.json(), { error: { code: "collab-disabled", message: "Collaboration is not enabled in this Libera." } });
    assert.equal(collabHostConfig(), null);
    assert.equal(await resolveSharedPath("Notebook/a.md"), null, "nothing is shared when collaboration is off");
    await assert.rejects(getDocText("doc"), (error: unknown) => error instanceof CollabHostError && error.status === 503 && error.code === "collab-disabled");
  } finally {
    restore();
  }
});

test("proxy route forwards method, path, query and body with the bearer token", async () => {
  const token = "control-token-for-tests";
  const fake = await fakeControlServer(token);
  const restore = withEnv({ LIBERA_COLLAB_HOST_URL: `${fake.url}/`, LIBERA_COLLAB_HOST_TOKEN: token });
  try {
    const status = await GET(nextRequest(ControlRoutes.status), context(ControlRoutes.status));
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { echo: { method: "GET", url: "/status", body: null } });
    assert.equal(fake.seen.at(-1)?.authorization, `Bearer ${token}`);

    // A renderer cannot choose a wrapping password or claim it was changed.
    const beforeUnlock = fake.seen.length;
    for (const unlock of [ControlRoutes.unlock, "/account/%75nlock", "/ACCOUNT/UNLOCK?changed=1"]) {
      const denied = await POST(nextRequest(unlock, { method: "POST", body: { password: "unverified", changed: true } }), context(unlock));
      assert.equal(denied.status, 404);
    }
    assert.equal(fake.seen.length, beforeUnlock, "unlock never reaches the control server");

    // Ids with reserved characters stay one segment; the query passes through.
    const route = `${ControlRoutes.docText("a/b c")}?x=1&y=two`;
    const text = await GET(nextRequest(route), context(route));
    assert.equal(text.status, 200);
    assert.equal(fake.seen.at(-1)?.url, "/docs/a%2Fb%20c/text?x=1&y=two");

    const edits = { edits: [{ start: 0, end: 0, text: "hi" }], provenance: { source: "typing" } };
    const posted = await POST(nextRequest(ControlRoutes.docEdits("d1"), { method: "POST", body: edits }), context(ControlRoutes.docEdits("d1")));
    assert.deepEqual(await posted.json(), { echo: { method: "POST", url: "/docs/d1/edits", body: edits } });

    const patched = await PATCH(nextRequest(ControlRoutes.account, { method: "PATCH", body: { color: "#000000" } }), context(ControlRoutes.account));
    assert.equal((await patched.json()).echo.method, "PATCH");

    const removed = await DELETE(nextRequest(ControlRoutes.member("p", "u"), { method: "DELETE" }), context(ControlRoutes.member("p", "u")));
    assert.equal(removed.status, 204);
    assert.equal(fake.seen.at(-1)?.method, "DELETE");

    const missing = await GET(nextRequest("/docs/missing/text"), context("/docs/missing/text"));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "unknown-doc");

    assert.equal((await GET(nextRequest("/docs/../status"), { params: Promise.resolve({ path: ["docs", "..", "status"] }) })).status, 404);

    // The typed helpers use the same configuration.
    assert.equal(await resolveSharedPath("Shared/a.md"), null);
    assert.equal(fake.seen.at(-1)?.url, "/docs/resolve?path=Shared%2Fa.md");
    const applied = await applyEdits("d2", { edits: [{ start: 0, end: 1, text: "x", before: "y" }], provenance: { source: "ai", feature: "agent" } });
    assert.deepEqual((applied as unknown as { echo: { url: string } }).echo.url, "/docs/d2/edits");
    await createSuggestions("d3", { edits: [{ start: 0, end: 0, text: "x" }], ai: { feature: "agentic-review" } });
    assert.equal(fake.seen.at(-1)?.url, "/docs/d3/suggestions");
    await assert.rejects(getDocText("missing"), (error: unknown) => error instanceof CollabHostError && error.status === 404 && error.code === "unknown-doc");

    // A host that refuses Next's token: 502, not the session-expired 401.
    process.env.LIBERA_COLLAB_HOST_TOKEN = "stale-token";
    const refused = await GET(nextRequest(ControlRoutes.status), context(ControlRoutes.status));
    assert.equal(refused.status, 502);
    assert.equal((await refused.json()).error.code, "collab-host-auth");
  } finally {
    restore();
    await fake.close();
  }

  // The host is configured but not running (crashed, restarting).
  const restoreDown = withEnv({ LIBERA_COLLAB_HOST_URL: fake.url, LIBERA_COLLAB_HOST_TOKEN: token });
  try {
    const down = await GET(nextRequest(ControlRoutes.status), context(ControlRoutes.status));
    assert.equal(down.status, 503);
    assert.equal((await down.json()).error.code, "collab-unavailable");
  } finally {
    restoreDown();
  }
});
