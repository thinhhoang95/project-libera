// Membership and document access lookups shared by the API and sync.

import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";

import type { Config } from "../config.js";
import type { DB } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { can, type Action, type Actor, type DocKind, type Role } from "../protocol.js";
import { TokenError, verifyAccessToken } from "./tokens.js";

export interface AuthenticatedAccount {
  accountId: string;
  familyId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    account?: AuthenticatedAccount;
  }
}

/** Rotation consumes individual tokens; the session lives while its family has a live token. */
export async function hasActiveSession(db: Kysely<DB>, accountId: string, familyId: string): Promise<boolean> {
  const session = await db
    .selectFrom("refresh_tokens")
    .select("id")
    .where("account_id", "=", accountId)
    .where("family_id", "=", familyId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  return session !== undefined;
}

/** Reads and verifies the bearer token. Throws HttpError 401. */
export async function authenticate(config: Config, db: Kysely<DB>, request: FastifyRequest): Promise<AuthenticatedAccount> {
  if (request.account) return request.account;
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new HttpError("unauthorized", "Sign in required.");
  let claims;
  try {
    claims = await verifyAccessToken(config, header.slice("Bearer ".length).trim());
  } catch (error) {
    if (error instanceof TokenError && error.expired) throw new HttpError("token-expired", "Access token expired.");
    throw new HttpError("unauthorized", "Invalid access token.");
  }
  const account = await db
    .selectFrom("accounts")
    .select(["id", "disabled_at"])
    .where("id", "=", claims.accountId)
    .executeTakeFirst();
  if (!account || account.disabled_at) throw new HttpError("unauthorized", "Account is not active.");
  if (!(await hasActiveSession(db, claims.accountId, claims.familyId))) throw new HttpError("unauthorized", "Session ended. Sign in again.");
  request.account = { accountId: claims.accountId, familyId: claims.familyId };
  return request.account;
}

export async function projectRole(db: Kysely<DB>, projectId: string, accountId: string): Promise<Role | null> {
  const row = await db
    .selectFrom("memberships")
    .innerJoin("projects", "projects.id", "memberships.project_id")
    .select("memberships.role")
    .where("memberships.project_id", "=", projectId)
    .where("memberships.account_id", "=", accountId)
    .where("projects.deleted_at", "is", null)
    .executeTakeFirst();
  return row?.role ?? null;
}

export interface DocAccess {
  docId: string;
  projectId: string;
  kind: DocKind | "manifest";
  schemaVersion: number;
  role: Role;
}

/** The caller's access to a document, or null when it does not exist or they are not a member. */
export async function documentAccess(db: Kysely<DB>, docId: string, accountId: string): Promise<DocAccess | null> {
  const row = await db
    .selectFrom("documents")
    .innerJoin("projects", "projects.id", "documents.project_id")
    .innerJoin("memberships", (join) =>
      join.onRef("memberships.project_id", "=", "documents.project_id").on("memberships.account_id", "=", accountId),
    )
    .select([
      "documents.id",
      "documents.project_id",
      "documents.kind",
      "documents.schema_version",
      "memberships.role",
    ])
    .where("documents.id", "=", docId)
    .where("documents.deleted_at", "is", null)
    .where("projects.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  return {
    docId: row.id,
    projectId: row.project_id,
    kind: row.kind,
    schemaVersion: row.schema_version,
    role: row.role,
  };
}

/** Throws 404 when the caller cannot see the project and 403 when the role is too low. */
export async function requireProjectAction(
  db: Kysely<DB>,
  projectId: string,
  accountId: string,
  action: Action,
  actor?: Actor,
): Promise<Role> {
  const role = await projectRole(db, projectId, accountId);
  if (!role) throw new HttpError("not-found", "Project not found.");
  if (!can(role, action, actor)) {
    if (actor?.kind === "ai" && can(role, action)) {
      throw new HttpError("ai-cannot-decide", "AI actions cannot take this step.");
    }
    throw new HttpError("forbidden", `Your role (${role}) cannot ${action}.`);
  }
  return role;
}

export async function requireDocumentAction(
  db: Kysely<DB>,
  docId: string,
  accountId: string,
  action: Action,
  actor?: Actor,
): Promise<DocAccess> {
  const access = await documentAccess(db, docId, accountId);
  if (!access) throw new HttpError("not-found", "Document not found.");
  if (!can(access.role, action, actor)) {
    if (actor?.kind === "ai" && can(access.role, action)) {
      throw new HttpError("ai-cannot-decide", "AI actions cannot take this step.");
    }
    throw new HttpError("forbidden", `Your role (${access.role}) cannot ${action}.`);
  }
  return access;
}

export async function writeAudit(
  db: Kysely<DB>,
  entry: { projectId: string | null; actor: Actor | null; accountId: string | null; action: string; target: string; details?: Record<string, unknown> },
): Promise<void> {
  await db
    .insertInto("audit_log")
    .values({
      project_id: entry.projectId,
      actor: JSON.stringify(entry.actor),
      account_id: entry.accountId,
      action: entry.action,
      target: entry.target,
      details: JSON.stringify(entry.details ?? {}),
    })
    .execute();
}
