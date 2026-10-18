// `node:sqlite` loader and the subset of its API the host uses.
//
// The module is newer than this project's Node typings, so the types are
// declared here (as in src/lib/search/database.ts). It is loaded through a
// runtime `require` so bundlers leave it alone: it comes from the Node or
// Electron runtime, never from node_modules.

export type SqlValue = null | number | bigint | string | Uint8Array;

export interface StatementSync {
  run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...values: SqlValue[]): Record<string, unknown> | undefined;
  all(...values: SqlValue[]): Record<string, unknown>[];
}

export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync };

const nodeRequire = eval("require") as NodeRequire;

export function openDatabase(path: string): DatabaseSync {
  // Node prints an experimental warning once; the module is stable for this use.
  const sqlite = nodeRequire("node:sqlite") as SqliteModule;
  return new sqlite.DatabaseSync(path);
}

/** SQLite returns BLOBs as Uint8Array (a Buffer subclass in some versions); normalize. */
export function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value.constructor === Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Expected a BLOB column");
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError("Expected an INTEGER column");
}

export function asNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

export function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
