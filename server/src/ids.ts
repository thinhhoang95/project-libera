import { createHash, randomBytes } from "node:crypto";

/** Random url-safe id with a readable prefix, e.g. "prj_3kq…". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(15).toString("base64url")}`;
}

/** A long random secret (refresh tokens, invitation tokens). */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Client-supplied ids (threads, messages, commands) must look like ids. */
export function isClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}
