import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_VERSION } from "../src/protocol.js";
import { json, startTestServer } from "./helpers.js";

test("server boots on PGlite, migrates, and reports its version", async () => {
  const server = await startTestServer();
  try {
    const health = await json<{ ok: boolean }>(server.url, "/healthz");
    assert.equal(health.status, 200);
    const version = await json<{ protocolVersion: number }>(server.url, "/v1/version");
    assert.equal(version.body.protocolVersion, PROTOCOL_VERSION);
    const tables = await server.server.context.db
      .selectFrom("schema_migrations")
      .select("name")
      .execute();
    assert.deepEqual(tables.map((row) => row.name), ["001_initial.sql"]);
    const missing = await json(server.url, "/v1/nope");
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});
