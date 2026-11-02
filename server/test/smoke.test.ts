import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db/database.js";
import { migrate, MIGRATIONS_DIR } from "../src/db/migrate.js";
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
    assert.deepEqual(
      tables.map((row) => row.name).sort(),
      readdirSync(MIGRATIONS_DIR).filter((name) => !name.startsWith(".") && name.endsWith(".sql")).sort(),
    );
    assert.ok(tables.some((row) => row.name === "001_initial.sql"));
    const missing = await json(server.url, "/v1/nope");
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});


test("migration discovery ignores cloud/OS metadata files", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "libera-migration-discovery-"));
  const database = await openDatabase("pglite://memory");
  try {
    writeFileSync(path.join(directory, "001_probe.sql"), "select 1;");
    writeFileSync(path.join(directory, "._001_probe.sql"), Buffer.from([0, 5, 22, 7, 0, 0]));
    assert.deepEqual(await migrate(database, directory), ["001_probe.sql"]);
    assert.deepEqual(await migrate(database, directory), []);
  } finally {
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
