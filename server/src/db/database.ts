// Database connection: Postgres in production, PGlite for development and
// tests. Both speak the same SQL, so the rest of the server only sees Kysely.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { Kysely, PGliteDialect, PostgresDialect } from "kysely";
import pg from "pg";

import type { DB } from "./types.js";

const INT8_OID = 20;

export interface Database {
  db: Kysely<DB>;
  /** Runs a multi-statement SQL script (used by migrations). */
  execScript(sql: string): Promise<void>;
  kind: "postgres" | "pglite";
  close(): Promise<void>;
}

function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`int8 value out of safe range: ${value}`);
  return parsed;
}

export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith("pglite://")) {
    const location = url.slice("pglite://".length);
    const dataDir = location === "memory" || location === "" ? undefined : resolve(location);
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    const pglite = await PGlite.create({
      dataDir,
      parsers: { [INT8_OID]: (value: string) => parseInt8(value) },
    });
    const db = new Kysely<DB>({ dialect: new PGliteDialect({ pglite }) });
    return {
      db,
      kind: "pglite",
      execScript: async (sql) => {
        await pglite.exec(sql);
      },
      close: async () => {
        await db.destroy();
        if (!pglite.closed) await pglite.close();
      },
    };
  }

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 20,
      types: {
        getTypeParser: ((oid: number, format?: "text" | "binary") =>
          oid === INT8_OID ? parseInt8 : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
      },
    });
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    return {
      db,
      kind: "postgres",
      execScript: async (sql) => {
        await pool.query(sql);
      },
      close: async () => {
        await db.destroy();
      },
    };
  }

  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split(":")[0]}`);
}
