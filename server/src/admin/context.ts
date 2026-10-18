// What every admin command receives, and what it returns.

import type { Kysely } from "kysely";

import type { Config } from "../config.js";
import type { Database } from "../db/database.js";
import type { DB } from "../db/types.js";
import type { Args } from "./args.js";

export interface AdminContext {
  config: Config;
  database: Database;
  db: Kysely<DB>;
  args: Args;
  /** Progress and warnings (stderr), so --json output on stdout stays parseable. */
  note(line: string): void;
}

export interface CommandResult {
  /** Printed with --json. */
  data: unknown;
  /** Printed otherwise. */
  text: string[];
  /** Non-zero when the command ran but found problems (verify). */
  exitCode?: number;
}

/** Formats rows as aligned columns. */
export function table(headers: string[], rows: Array<Array<string | number | null | undefined>>): string[] {
  const cells = [headers, ...rows.map((row) => row.map((cell) => (cell === null || cell === undefined ? "-" : String(cell))))];
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => row[column]?.length ?? 0)));
  return cells.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
}

export function isoTime(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function bytes(count: number): string {
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KiB`;
  return `${(count / 1024 / 1024).toFixed(1)} MiB`;
}
