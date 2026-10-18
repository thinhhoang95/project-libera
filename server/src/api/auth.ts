// Accounts and sessions: register, login, refresh rotation, logout, /me.
//
// A session is a refresh-token family. Every refresh replaces the token with
// a new one in the same family; presenting a replaced token again means it
// was copied, so the whole family is revoked and its sockets are closed.

import type { FastifyInstance } from "fastify";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";

import { burnPasswordCheck, hashPassword, verifyPassword } from "../auth/passwords.js";
import { signAccessToken } from "../auth/tokens.js";
import type { ServerContext } from "../context.js";
import type { AccountsTable, DB } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { newId, newSecret, sha256Hex } from "../ids.js";
import { ApiRoutes, type Account, type AuthResponse } from "../protocol.js";
import { emailSchema, hexColorSchema, iso, isUniqueViolation, notifyRooms, requireAccount } from "./common.js";
import { acceptInvitationRecord, assertInvitedEmail, findInvitation } from "./invitations.js";
import { announceMembership } from "./projects.js";
import { authLimits, enforce } from "./rate-limit.js";

const password = z.string().min(8, "Use at least 8 characters.").max(200);
const displayName = z.string().trim().min(1).max(80);
const deviceName = z.string().trim().max(100).optional();

const registerBody = z.object({
  email: emailSchema,
  password,
  displayName,
  invitationToken: z.string().min(1).max(200).optional(),
  deviceName,
});
const loginBody = z.object({ email: emailSchema, password: z.string().max(200), deviceName });
const refreshBody = z.object({ refreshToken: z.string().min(1).max(200) });
const updateMeBody = z.object({ displayName: displayName.optional(), color: hexColorSchema.optional() });
const changePasswordBody = z.object({ currentPassword: z.string().max(200), newPassword: password });

/** Readable on light and dark backgrounds, and distinct from each other. */
export const DEFAULT_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#7c3aed",
  "#0d9488",
  "#c2410c",
  "#4f46e5",
] as const;

export function defaultColor(seed: string): string {
  const index = parseInt(sha256Hex(seed).slice(0, 8), 16) % DEFAULT_COLORS.length;
  return DEFAULT_COLORS[index];
}

type AccountRow = Selectable<AccountsTable>;

export function accountInfo(row: AccountRow): Account {
  return { id: row.id, email: row.email, displayName: row.display_name, color: row.color, createdAt: iso(row.created_at) };
}

export async function insertAccount(
  db: Kysely<DB>,
  input: { email: string; password: string; displayName: string; color?: string },
): Promise<AccountRow> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  try {
    return await db
      .insertInto("accounts")
      .values({
        id: newId("acc"),
        email,
        display_name: input.displayName,
        color: input.color ?? defaultColor(email),
        password_hash: passwordHash,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError("email-taken", "An account with this email already exists.");
    throw error;
  }
}

async function issueRefreshToken(
  context: ServerContext,
  db: Kysely<DB>,
  accountId: string,
  familyId: string,
  device: string | null,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = newSecret();
  const id = newId("rft");
  const expiresAt = new Date(Date.now() + context.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db
    .insertInto("refresh_tokens")
    .values({ id, account_id: accountId, token_hash: sha256Hex(token), family_id: familyId, device_name: device, expires_at: expiresAt })
    .execute();
  return { id, token, expiresAt };
}

async function authResponse(
  context: ServerContext,
  account: AccountRow,
  refresh: { token: string; expiresAt: Date },
  familyId: string,
): Promise<AuthResponse> {
  const access = await signAccessToken(context.config, account.id, familyId);
  return {
    account: accountInfo(account),
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt.toISOString(),
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
  };
}

/** Starts a new session (refresh family) for an account. */
export async function startSession(context: ServerContext, account: AccountRow, device?: string): Promise<AuthResponse> {
  const familyId = newId("fam");
  const refresh = await issueRefreshToken(context, context.db, account.id, familyId, device ?? null);
  return authResponse(context, account, refresh, familyId);
}

async function revokeFamily(context: ServerContext, accountId: string, familyId: string): Promise<void> {
  await context.db
    .updateTable("refresh_tokens")
    .set({ revoked_at: new Date() })
    .where("family_id", "=", familyId)
    .where("account_id", "=", accountId)
    .where("revoked_at", "is", null)
    .execute();
  notifyRooms(context, "accountRevoked", (rooms) => rooms.accountRevoked(accountId, familyId));
}

export function registerAuthRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db, config } = context;

  app.post(ApiRoutes.register, async (request, reply) => {
    const body = registerBody.parse(request.body);
    const limits = authLimits(context);
    enforce(reply, [
      [limits.registerPerIp, request.ip],
      [limits.registerPerEmail, body.email],
    ]);

    let invitation: Awaited<ReturnType<typeof findInvitation>> | undefined;
    if (body.invitationToken) {
      invitation = await findInvitation(db, body.invitationToken);
      assertInvitedEmail(invitation, body.email);
    } else if (!config.ALLOW_OPEN_SIGNUP) {
      throw new HttpError("signup-disabled", "Sign-up needs an invitation.");
    }

    // One transaction, so a failed acceptance does not leave an account behind.
    const { account, role } = await db.transaction().execute(async (trx) => {
      const created = await insertAccount(trx, body);
      const joined = invitation ? await acceptInvitationRecord(trx, invitation, created.id) : null;
      return { account: created, role: joined };
    });
    if (invitation && role) announceMembership(context, invitation.project_id, account.id, role);
    return reply.status(201).send(await startSession(context, account, body.deviceName));
  });

  app.post(ApiRoutes.login, async (request, reply) => {
    const body = loginBody.parse(request.body);
    const limits = authLimits(context);
    enforce(reply, [
      [limits.loginPerIp, request.ip],
      [limits.loginPerEmail, body.email],
    ]);
    const account = await db
      .selectFrom("accounts")
      .selectAll()
      .where((eb) => eb(eb.fn("lower", ["email"]), "=", body.email))
      .executeTakeFirst();
    if (!account) {
      await burnPasswordCheck(body.password);
      throw new HttpError("unauthorized", "Email or password is incorrect.");
    }
    if (!(await verifyPassword(body.password, account.password_hash))) {
      throw new HttpError("unauthorized", "Email or password is incorrect.");
    }
    if (account.disabled_at) throw new HttpError("unauthorized", "This account is disabled.");
    return startSession(context, account, body.deviceName);
  });

  app.post(ApiRoutes.refresh, async (request, reply): Promise<AuthResponse> => {
    const body = refreshBody.parse(request.body);
    enforce(reply, [[authLimits(context).refreshPerIp, request.ip]]);
    const invalid = new HttpError("unauthorized", "Refresh token is invalid. Sign in again.");
    const row = await db.selectFrom("refresh_tokens").selectAll().where("token_hash", "=", sha256Hex(body.refreshToken)).executeTakeFirst();
    if (!row) throw invalid;
    if (row.revoked_at) {
      // A rotated token coming back means someone else holds a copy.
      if (row.replaced_by) {
        context.log.warn({ accountId: row.account_id, familyId: row.family_id }, "Refresh token reuse; revoking the session");
        await revokeFamily(context, row.account_id, row.family_id);
      }
      throw invalid;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) throw invalid;
    const account = await db.selectFrom("accounts").selectAll().where("id", "=", row.account_id).executeTakeFirst();
    if (!account || account.disabled_at) throw invalid;

    const rotated = await db.transaction().execute(async (trx) => {
      const next = await issueRefreshToken(context, trx, row.account_id, row.family_id, row.device_name);
      // Conditional on revoked_at so two concurrent refreshes cannot both win.
      const result = await trx
        .updateTable("refresh_tokens")
        .set({ revoked_at: new Date(), replaced_by: next.id })
        .where("id", "=", row.id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) !== 1) throw invalid;
      return next;
    });
    return authResponse(context, account, rotated, row.family_id);
  });

  app.post(ApiRoutes.logout, async (request, reply) => {
    const body = refreshBody.parse(request.body);
    const row = await db
      .selectFrom("refresh_tokens")
      .select(["account_id", "family_id"])
      .where("token_hash", "=", sha256Hex(body.refreshToken))
      .executeTakeFirst();
    // Unknown tokens succeed too: logging out is idempotent.
    if (row) await revokeFamily(context, row.account_id, row.family_id);
    return reply.status(204).send();
  });

  app.get(ApiRoutes.me, async (request): Promise<Account> => {
    const { accountId } = await requireAccount(context, request);
    const account = await db.selectFrom("accounts").selectAll().where("id", "=", accountId).executeTakeFirstOrThrow();
    return accountInfo(account);
  });

  app.patch(ApiRoutes.me, async (request): Promise<Account> => {
    const { accountId } = await requireAccount(context, request);
    const body = updateMeBody.parse(request.body);
    const changes: { display_name?: string; color?: string } = {};
    if (body.displayName !== undefined) changes.display_name = body.displayName;
    if (body.color !== undefined) changes.color = body.color.toLowerCase();
    if (Object.keys(changes).length > 0) await db.updateTable("accounts").set(changes).where("id", "=", accountId).execute();
    const account = await db.selectFrom("accounts").selectAll().where("id", "=", accountId).executeTakeFirstOrThrow();
    return accountInfo(account);
  });

  app.post(ApiRoutes.password, async (request, reply) => {
    const { accountId, familyId } = await requireAccount(context, request);
    const body = changePasswordBody.parse(request.body);
    const account = await db.selectFrom("accounts").select("password_hash").where("id", "=", accountId).executeTakeFirstOrThrow();
    if (!(await verifyPassword(body.currentPassword, account.password_hash))) {
      throw new HttpError("forbidden", "The current password is incorrect.");
    }
    await db.updateTable("accounts").set({ password_hash: await hashPassword(body.newPassword) }).where("id", "=", accountId).execute();
    // Other sessions may belong to whoever learned the old password.
    const others = await db
      .selectFrom("refresh_tokens")
      .select("family_id")
      .distinct()
      .where("account_id", "=", accountId)
      .where("family_id", "!=", familyId)
      .where("revoked_at", "is", null)
      .execute();
    for (const other of others) await revokeFamily(context, accountId, other.family_id);
    return reply.status(204).send();
  });
}
