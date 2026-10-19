// Invitations by email. The token is a random secret shown to the inviter
// once and emailed to the invitee; only its sha256 is stored.

import type { FastifyInstance } from "fastify";
import type { Kysely, Selectable, Transaction } from "kysely";
import { z } from "zod";

import { requireProjectAction, writeAudit } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import type { DB, InvitationsTable } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { newId, newSecret, sha256Hex } from "../ids.js";
import { invitationEmail } from "../mail/templates.js";
import { sendMailSafely } from "../mail/index.js";
import {
  ApiRoutes,
  bindActor,
  roleAtLeast,
  type Invitation,
  type InvitationPreview,
  type ProjectSummary,
  type Role,
} from "../protocol.js";
import { aiHintSchema, emailSchema, iso, isoOrNull, pathId, requireAccount, route, userOrUnknown, loadUsers } from "./common.js";
import { notify } from "./notifications.js";
import { announceMembership, projectSummary } from "./projects.js";

const createBody = z.object({
  email: emailSchema,
  role: z.enum(["editor", "commenter", "viewer"]),
  ai: aiHintSchema,
});
const projectParams = z.object({ projectId: pathId });
const invitationParams = z.object({ invitationId: pathId });
const tokenParams = z.object({ token: z.string().min(1).max(200) });

type InvitationRow = Selectable<InvitationsTable>;

function invitationInfo(row: InvitationRow): Invitation {
  return {
    id: row.id,
    projectId: row.project_id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    acceptedAt: isoOrNull(row.accepted_at),
  };
}

export function invitationUrl(context: ServerContext, token: string): string {
  return `${context.config.PUBLIC_URL.replace(/\/+$/, "")}/invite/${encodeURIComponent(token)}`;
}

/**
 * The invitation for a token, usable by `accountId` (or by a new account when
 * it is undefined). Accepted invitations are only returned to the account that
 * accepted them, so accepting twice is harmless.
 */
export async function findInvitation(db: Kysely<DB>, token: string, accountId?: string): Promise<InvitationRow & { project_name: string }> {
  const row = await db
    .selectFrom("invitations")
    .innerJoin("projects", "projects.id", "invitations.project_id")
    .selectAll("invitations")
    .select("projects.name as project_name")
    .where("invitations.token_hash", "=", sha256Hex(token))
    .where("projects.deleted_at", "is", null)
    .executeTakeFirst();
  const invalid = new HttpError("invalid-invitation", "This invitation link is invalid or has expired.");
  if (!row || row.revoked_at) throw invalid;
  if (row.accepted_at) {
    if (accountId && row.accepted_by === accountId) return row;
    throw invalid;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) throw invalid;
  return row;
}

export function assertInvitedEmail(invitation: InvitationRow, email: string): void {
  if (invitation.email.toLowerCase() !== email.toLowerCase()) {
    throw new HttpError("forbidden", "This invitation was sent to a different email address.");
  }
}

/** Adds the membership for an accepted invitation. Returns the member's role, or null when nothing changed. */
export async function acceptInvitationRecord(
  trx: Transaction<DB>,
  invitation: InvitationRow,
  accountId: string,
): Promise<Role | null> {
  if (invitation.accepted_at) return null;
  const existing = await trx
    .selectFrom("memberships")
    .select("role")
    .where("project_id", "=", invitation.project_id)
    .where("account_id", "=", accountId)
    .executeTakeFirst();
  let role: Role | null = invitation.role;
  if (!existing) {
    await trx
      .insertInto("memberships")
      .values({ project_id: invitation.project_id, account_id: accountId, role: invitation.role })
      .execute();
  } else if (roleAtLeast(existing.role, invitation.role)) {
    // Never downgrade someone who already has a higher role.
    role = null;
  } else {
    await trx
      .updateTable("memberships")
      .set({ role: invitation.role })
      .where("project_id", "=", invitation.project_id)
      .where("account_id", "=", accountId)
      .execute();
  }
  // The accepted_at guard makes a concurrent second acceptance a no-op.
  await trx
    .updateTable("invitations")
    .set({ accepted_at: new Date(), accepted_by: accountId })
    .where("id", "=", invitation.id)
    .where("accepted_at", "is", null)
    .execute();
  await writeAudit(trx, {
    projectId: invitation.project_id,
    actor: bindActor(accountId, undefined),
    accountId,
    action: "invitation.accept",
    target: invitation.id,
    details: { role: invitation.role, joined: role !== null },
  });
  return role;
}

export function registerInvitationRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db, config } = context;

  app.post(route(ApiRoutes.projectInvitations, "projectId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    const body = createBody.parse(request.body);
    const actor = bindActor(accountId, undefined, body.ai);
    await requireProjectAction(db, projectId, accountId, "invite", actor);

    const existingMember = await db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("accounts.id")
      .where("memberships.project_id", "=", projectId)
      .where((eb) => eb(eb.fn("lower", ["accounts.email"]), "=", body.email))
      .executeTakeFirst();
    if (existingMember) throw new HttpError("conflict", "That person is already a member of this notebook.");

    const token = newSecret();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + config.INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const row = await db
      .insertInto("invitations")
      .values({
        id: newId("inv"),
        project_id: projectId,
        email: body.email,
        role: body.role,
        token_hash: sha256Hex(token),
        invited_by: accountId,
        created_at: now,
        expires_at: expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await writeAudit(db, {
      projectId,
      actor,
      accountId,
      action: "invitation.create",
      target: row.id,
      details: { email: body.email, role: body.role },
    });

    const url = invitationUrl(context, token);
    const project = await db.selectFrom("projects").select("name").where("id", "=", projectId).executeTakeFirstOrThrow();
    const inviter = userOrUnknown(await loadUsers(db, [accountId]), accountId);
    await sendMailSafely(
      context,
      invitationEmail({ to: body.email, inviterName: inviter.displayName, projectName: project.name, role: body.role, url, expiresAt }),
    );
    const invitee = await db
      .selectFrom("accounts")
      .select("id")
      .where((eb) => eb(eb.fn("lower", ["email"]), "=", body.email))
      .executeTakeFirst();
    if (invitee) {
      await notify(context, [
        {
          accountId: invitee.id,
          kind: "invited",
          projectId,
          docId: null,
          // The invitee needs the token to accept from the app; the
          // notification is only ever shown to them.
          payload: { invitationId: row.id, projectName: project.name, role: body.role, inviter, token, url, expiresAt: iso(expiresAt) },
        },
      ]);
    }
    return reply.status(201).send({ ...invitationInfo(row), token, url } satisfies Invitation);
  });

  app.get(route(ApiRoutes.projectInvitations, "projectId"), async (request): Promise<Invitation[]> => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    await requireProjectAction(db, projectId, accountId, "invite");
    const rows = await db
      .selectFrom("invitations")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(invitationInfo);
  });

  app.delete(route(ApiRoutes.invitation, "invitationId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { invitationId } = invitationParams.parse(request.params);
    const row = await db.selectFrom("invitations").selectAll().where("id", "=", invitationId).executeTakeFirst();
    if (!row) throw new HttpError("not-found", "Invitation not found.");
    const actor = bindActor(accountId, undefined);
    await requireProjectAction(db, row.project_id, accountId, "invite", actor);
    if (!row.revoked_at) {
      await db.updateTable("invitations").set({ revoked_at: new Date() }).where("id", "=", invitationId).execute();
      await writeAudit(db, {
        projectId: row.project_id,
        actor,
        accountId,
        action: "invitation.revoke",
        target: invitationId,
        details: { email: row.email },
      });
    }
    return reply.status(204).send();
  });

  app.get(route(ApiRoutes.invitationByToken, "token"), async (request): Promise<InvitationPreview> => {
    const { token } = tokenParams.parse(request.params);
    const row = await findInvitation(db, token);
    const inviter = userOrUnknown(await loadUsers(db, [row.invited_by]), row.invited_by);
    return { projectName: row.project_name, inviter, email: row.email, role: row.role, expiresAt: iso(row.expires_at) };
  });

  app.post(route(ApiRoutes.acceptInvitation, "token"), async (request): Promise<ProjectSummary> => {
    const { accountId } = await requireAccount(context, request);
    const { token } = tokenParams.parse(request.params);
    const invitation = await findInvitation(db, token, accountId);
    const account = await db.selectFrom("accounts").select("email").where("id", "=", accountId).executeTakeFirstOrThrow();
    assertInvitedEmail(invitation, account.email);
    const role = await db.transaction().execute((trx) => acceptInvitationRecord(trx, invitation, accountId));
    if (role) announceMembership(context, invitation.project_id, accountId, role);
    return projectSummary(db, invitation.project_id, accountId);
  });
}
