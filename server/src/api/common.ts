// Helpers shared by the API modules: authentication, input schemas, row
// mapping, and calls into the sync service that must not fail a request.

import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";

import { authenticate, type AuthenticatedAccount } from "../auth/access.js";
import type { RoomService, ServerContext } from "../context.js";
import type { DB } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { isClientId } from "../ids.js";
import { AI_FEATURES, type AiFeature, type EventScope, type UserSummary } from "../protocol.js";

export function requireAccount(context: ServerContext, request: FastifyRequest): Promise<AuthenticatedAccount> {
  return authenticate(context.config, context.db, request);
}

export const clientIdSchema = z
  .string()
  .refine(isClientId, "Expected an id of 8 to 80 letters, digits, '_' or '-'.");

/** Server ids in paths are only looked up, never stored, so a loose check is enough. */
export const pathId = z.string().min(1).max(200);

export const aiHintSchema = z
  .object({
    feature: z.enum(AI_FEATURES as unknown as [AiFeature, ...AiFeature[]]),
    model: z.string().max(200).optional(),
    runId: z.string().max(200).optional(),
  })
  .nullish();

export const emailSchema = z
  .string()
  .trim()
  .max(320)
  .pipe(z.email())
  .transform((value) => value.toLowerCase());

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a colour like #2563eb.");

export function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value);
}

const UNKNOWN_COLOR = "#64748b";

export async function loadUsers(db: Kysely<DB>, ids: Iterable<string | null | undefined>): Promise<Map<string, UserSummary>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === "string"))];
  const users = new Map<string, UserSummary>();
  if (unique.length === 0) return users;
  const rows = await db
    .selectFrom("accounts")
    .select(["id", "display_name", "color"])
    .where("id", "in", unique)
    .execute();
  for (const row of rows) users.set(row.id, { id: row.id, displayName: row.display_name, color: row.color });
  return users;
}

/** A user who may have been deleted since; history still has to render. */
export function userOrUnknown(users: Map<string, UserSummary>, id: string): UserSummary {
  return users.get(id) ?? { id, displayName: "Unknown user", color: UNKNOWN_COLOR };
}

/**
 * Calls into the sync service. Its effects (closing sockets, re-scoping
 * sessions) are best effort: the database change already happened, and a
 * failing room must not turn a successful request into a 500.
 */
export function notifyRooms(context: ServerContext, what: string, call: (rooms: RoomService) => void): void {
  try {
    call(context.rooms);
  } catch (error) {
    context.log.error({ err: error, call: what }, "Sync service call failed");
  }
}

export function publish(context: ServerContext, scope: EventScope, id: string, kind: string, payload: unknown): void {
  try {
    context.events.publish({ scope, id, kind, payload });
  } catch (error) {
    context.log.error({ err: error, kind }, "Event listener failed");
  }
}

/** Strict base64: Buffer.from silently skips bad characters, which would hide corrupt imports. */
export function decodeBase64(text: string, field: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new HttpError("bad-request", `${field} is not valid base64.`);
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Postgres unique_violation, from pg or PGlite. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

/**
 * A Fastify path pattern from an ApiRoutes builder, e.g.
 * route(ApiRoutes.member, "projectId", "userId"). The builders URI-encode
 * their arguments, which would turn ":projectId" into "%3AprojectId".
 */
export function route(build: (...args: string[]) => string, ...params: string[]): string {
  const placeholders = params.map((_, index) => `__param${index}__`);
  let path = build(...placeholders);
  params.forEach((name, index) => {
    path = path.replace(placeholders[index], `:${name}`);
  });
  return path;
}
