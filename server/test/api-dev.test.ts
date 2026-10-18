// Development conveniences: the seed CLI and logged email without SMTP.

import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/database.js";
import { migrate } from "../src/db/migrate.js";
import { seed } from "../src/db/seed-cli.js";
import { createMailer } from "../src/mail/index.js";
import type { AuthResponse } from "../src/protocol.js";
import { json, startTestServer } from "./helpers.js";

test("seed creates alice, bob and a shared project, and is idempotent", async () => {
  const database = await openDatabase("pglite://memory");
  try {
    await migrate(database);
    const first = await seed(database.db, "seed-password");
    const second = await seed(database.db, "seed-password");
    assert.deepEqual(second, first);
    const accounts = await database.db.selectFrom("accounts").select("email").orderBy("email").execute();
    assert.deepEqual(accounts.map((row) => row.email), ["alice@example.test", "bob@example.test"]);
    const members = await database.db
      .selectFrom("memberships")
      .select(["account_id", "role"])
      .where("project_id", "=", first.projectId)
      .orderBy("role", "desc")
      .execute();
    assert.deepEqual(members, [
      { account_id: first.aliceId, role: "owner" },
      { account_id: first.bobId, role: "editor" },
    ]);
  } finally {
    await database.close();
  }
});

test("seeded accounts can sign in", async () => {
  const server = await startTestServer();
  try {
    await seed(server.server.context.db, "libera-dev-password");
    const login = await json<AuthResponse>(server.url, "/v1/auth/login", {
      body: { email: "bob@example.test", password: "libera-dev-password" },
    });
    assert.equal(login.status, 200);
    const projects = await json<unknown[]>(server.url, "/v1/projects", { token: login.body.accessToken });
    assert.equal(projects.body.length, 1);
  } finally {
    await server.close();
  }
});

test("without SMTP_URL, email is written to the log", async () => {
  const logged: { object: unknown; message: string }[] = [];
  const log = { info: (object: unknown, message: string) => logged.push({ object, message }) };
  const mailer = createMailer({ config: loadConfig({ NODE_ENV: "test" }), log: log as never });
  await mailer.send({ to: "a@example.test", subject: "Hi", text: "Link: https://collab.test/invite/abc" });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].object, {
    mail: { to: "a@example.test", subject: "Hi", text: "Link: https://collab.test/invite/abc" },
  });
});
