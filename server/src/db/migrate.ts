// Applies migrations/*.sql in name order, once each, recording them in
// schema_migrations. Each file runs in its own transaction.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database } from "./database.js";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(database: Database, directory = MIGRATIONS_DIR): Promise<string[]> {
  await database.execScript(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const applied = new Set(
    (await database.db.selectFrom("schema_migrations").select("name").execute()).map((row) => row.name),
  );
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(directory, name), "utf8");
    const escaped = name.replaceAll("'", "''");
    await database.execScript(
      `begin;\n${sql}\ninsert into schema_migrations (name) values ('${escaped}');\ncommit;`,
    );
    ran.push(name);
  }
  return ran;
}
