// npm run seed: two development accounts and a notebook they share. Safe to
// run repeatedly; existing accounts keep their passwords.

import type { Kysely } from "kysely";

import { insertAccount } from "../api/auth.js";
import { createProjectRecord } from "../api/projects.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "./database.js";
import { migrate } from "./migrate.js";
import type { DB } from "./types.js";

const PROJECT_NAME = "Shared notebook (dev)";

export async function seed(db: Kysely<DB>, password: string): Promise<{ aliceId: string; bobId: string; projectId: string }> {
  async function ensureAccount(email: string, displayName: string): Promise<string> {
    const existing = await db.selectFrom("accounts").select("id").where("email", "=", email).executeTakeFirst();
    if (existing) return existing.id;
    return (await insertAccount(db, { email, password, displayName })).id;
  }

  const aliceId = await ensureAccount("alice@example.test", "Alice");
  const bobId = await ensureAccount("bob@example.test", "Bob");

  const existing = await db
    .selectFrom("projects")
    .select("id")
    .where("owner_id", "=", aliceId)
    .where("name", "=", PROJECT_NAME)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  const projectId = existing?.id ?? (await createProjectRecord(db, aliceId, PROJECT_NAME)).id;
  await db
    .insertInto("memberships")
    .values({ project_id: projectId, account_id: bobId, role: "editor" })
    .onConflict((conflict) => conflict.columns(["project_id", "account_id"]).doNothing())
    .execute();
  return { aliceId, bobId, projectId };
}

// Only when run as the CLI, so tests can import seed().
if (process.argv[1] && /seed-cli\.[cm]?[jt]s$/.test(process.argv[1])) {
  const config = loadConfig();
  const database = await openDatabase(config.DATABASE_URL);
  try {
    await migrate(database);
    const result = await seed(database.db, process.env.SEED_PASSWORD || "libera-dev-password");
    console.log(
      [
        "Seeded development data:",
        "  alice@example.test (owner)",
        "  bob@example.test (editor)",
        `  project "${PROJECT_NAME}" (${result.projectId})`,
        "Password: $SEED_PASSWORD, or libera-dev-password when unset.",
      ].join("\n"),
    );
  } finally {
    await database.close();
  }
}
