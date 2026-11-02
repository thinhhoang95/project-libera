// Shared by the Electron host and Next's synchronous storage guard. These
// records live in this installation's userData, outside the cloud library.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface NotebookMarker {
  projectId: string;
  serverUrl: string;
  accountId: string;
  manifestDocId: string;
  sharedAt: string;
  kind?: "notebook" | "album";
  writer?: string;
  folderId?: string;
  syncedElsewhere?: boolean;
  revoked?: boolean;
  revokedAt?: string;
}

export const MAX_MARKER_BYTES = 64 * 1024;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");

/** JSON is not a schema: validate every identity and control field we use. */
export function parseNotebookMarker(value: unknown): NotebookMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!id(record.projectId) || !id(record.accountId) || !id(record.manifestDocId) ||
      !text(record.serverUrl, 4096) || !text(record.sharedAt, 100)) return null;
  try {
    const url = new URL(record.serverUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  } catch { return null; }
  if (record.kind !== undefined && record.kind !== "notebook" && record.kind !== "album") return null;
  for (const key of ["writer", "folderId"]) if (record[key] !== undefined && !id(record[key])) return null;
  for (const key of ["revoked", "syncedElsewhere"]) if (record[key] !== undefined && typeof record[key] !== "boolean") return null;
  if (record.revokedAt !== undefined && !text(record.revokedAt, 100)) return null;
  return record as unknown as NotebookMarker;
}

function identity(marker: NotebookMarker): string {
  return JSON.stringify([marker.serverUrl.replace(/\/+$/, ""), marker.accountId, marker.projectId, marker.manifestDocId, marker.folderId ?? null]);
}

export function sameNotebookIdentity(left: NotebookMarker, right: NotebookMarker): boolean {
  return identity(left) === identity(right);
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const endedFile = (directory: string, marker: NotebookMarker) => path.join(directory, `ended-${hash(identity(marker))}.json`);
const bindingFile = (directory: string, root: string) => path.join(directory, `binding-${hash(path.resolve(root))}.json`);

function readRecord(file: string): Record<string, unknown> | null {
  try {
    const bytes = readFileSync(file);
    if (bytes.length > MAX_MARKER_BYTES) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** One record per identity avoids lost updates between account databases. */
function writeRecord(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, file);
    // Persist the rename where the filesystem supports directory fsync.
    let descriptor: number | undefined;
    try { descriptor = openSync(path.dirname(file), "r"); fsyncSync(descriptor); }
    catch { /* Windows does not support syncing directory handles. */ }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export type NotebookLifecycle = "local" | "revoked";

export function readNotebookLifecycle(directory: string | undefined, marker: NotebookMarker): NotebookLifecycle | null {
  if (!directory) return null;
  const record = readRecord(endedFile(directory, marker));
  const saved = parseNotebookMarker(record?.marker);
  if (record?.version !== 1 || !saved || !sameNotebookIdentity(saved, marker)) return null;
  return record.outcome === "local" || record.outcome === "revoked" ? record.outcome : null;
}

export function recordNotebookLifecycle(directory: string, marker: NotebookMarker, outcome: NotebookLifecycle): void {
  if (readNotebookLifecycle(directory, marker) === outcome) return;
  writeRecord(endedFile(directory, marker), { version: 1, marker, outcome, confirmedAt: new Date().toISOString() });
}

export function recordNotebookBinding(directory: string, root: string, marker: NotebookMarker): void {
  const saved = readNotebookBinding(directory, root);
  if (saved && sameNotebookIdentity(saved, marker)) return;
  writeRecord(bindingFile(directory, root), { version: 1, root: path.resolve(root), marker });
}

export function readNotebookBinding(directory: string | undefined, root: string): NotebookMarker | null {
  if (!directory) return null;
  const record = readRecord(bindingFile(directory, root));
  if (record?.version !== 1 || record.root !== path.resolve(root)) return null;
  return parseNotebookMarker(record.marker);
}
