// Projects (shared notebooks), their members, and the audit log.

import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";

import { requireProjectAction, writeAudit } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import type { DB } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { newId } from "../ids.js";
import {
  ApiRoutes,
  bindActor,
  EventKind,
  isProjectKind,
  isRole,
  type AuditEntry,
  type FolderLease,
  type Member,
  type ProjectKind,
  type ProjectSummary,
  type Role,
} from "../protocol.js";
import { aiHintSchema, iso, notifyRooms, pathId, publish, requireAccount, route } from "./common.js";

const projectName = z.string().trim().min(1).max(200);

const createProjectBody = z.object({
  name: projectName,
  kind: z.string().refine(isProjectKind, "Unknown project kind.").optional(),
});
const renameProjectBody = z.object({ name: projectName, ai: aiHintSchema });
const changeRoleBody = z.object({
  role: z.string().refine(isRole, "Unknown role."),
  ai: aiHintSchema,
});
const projectParams = z.object({ projectId: pathId });
const memberParams = z.object({ projectId: pathId, userId: pathId });
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Audit entry id to page backwards from (exclusive). */
  before: z.coerce.number().int().positive().optional(),
});

const leaseId = z.string().min(1).max(200);
const folderLeaseBody = z.object({ folderId: leaseId, holder: leaseId, ttlMs: z.number().int().positive() });
const folderLeaseQuery = z.object({ folderId: leaseId, holder: leaseId });
const MIN_LEASE_MS = 500;
const MAX_LEASE_MS = 10 * 60_000;

/** Creates a project, its owner membership and its empty manifest document. */
export async function createProjectRecord(db: Kysely<DB>, ownerId: string, name: string, kind: ProjectKind = "notebook"): Promise<ProjectSummary> {
  const projectId = newId("prj");
  const manifestDocId = newId("doc");
  const createdAt = new Date();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("projects")
      .values({ id: projectId, name, owner_id: ownerId, manifest_doc_id: manifestDocId, kind, created_at: createdAt })
      .execute();
    await trx
      .insertInto("memberships")
      .values({ project_id: projectId, account_id: ownerId, role: "owner", created_at: createdAt })
      .execute();
    await trx
      .insertInto("documents")
      .values({ id: manifestDocId, project_id: projectId, kind: "manifest", file_id: null, created_by: ownerId, created_at: createdAt })
      .execute();
  });
  return { id: projectId, name, role: "owner", ownerId, manifestDocId, createdAt: createdAt.toISOString(), kind };
}

export async function projectSummary(db: Kysely<DB>, projectId: string, accountId: string): Promise<ProjectSummary> {
  const row = await db
    .selectFrom("projects")
    .innerJoin("memberships", "memberships.project_id", "projects.id")
    .select(["projects.id", "projects.name", "projects.owner_id", "projects.manifest_doc_id", "projects.created_at", "projects.kind", "memberships.role"])
    .where("projects.id", "=", projectId)
    .where("memberships.account_id", "=", accountId)
    .where("projects.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new HttpError("not-found", "Project not found.");
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    ownerId: row.owner_id,
    manifestDocId: row.manifest_doc_id,
    createdAt: iso(row.created_at),
    kind: row.kind,
  };
}

async function listMembers(db: Kysely<DB>, projectId: string): Promise<Member[]> {
  const rows = await db
    .selectFrom("memberships")
    .innerJoin("accounts", "accounts.id", "memberships.account_id")
    .select(["accounts.id", "accounts.display_name", "accounts.color", "accounts.email", "memberships.role", "memberships.created_at"])
    .where("memberships.project_id", "=", projectId)
    .orderBy("memberships.created_at")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    color: row.color,
    email: row.email,
    role: row.role,
    joinedAt: iso(row.created_at),
  }));
}

/** Tells live sessions and other members about a membership change. */
export function announceMembership(context: ServerContext, projectId: string, accountId: string, role: Role | null): void {
  notifyRooms(context, "membershipChanged", (rooms) => rooms.membershipChanged(projectId, accountId, role));
  if (role) {
    publish(context, "project", projectId, EventKind.RoleChanged, { projectId, accountId, role });
    publish(context, "user", accountId, EventKind.RoleChanged, { projectId, accountId, role });
  } else {
    publish(context, "project", projectId, EventKind.MemberRemoved, { projectId, accountId });
    publish(context, "user", accountId, EventKind.MemberRemoved, { projectId, accountId });
  }
}

export function registerProjectRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db } = context;

  app.post(ApiRoutes.projects, async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const body = createProjectBody.parse(request.body);
    const project = await createProjectRecord(db, accountId, body.name, body.kind as ProjectKind | undefined);
    await writeAudit(db, {
      projectId: project.id,
      actor: bindActor(accountId, undefined),
      accountId,
      action: "project.create",
      target: project.id,
      details: { name: project.name, kind: project.kind },
    });
    return reply.status(201).send(project);
  });

  app.get(ApiRoutes.projects, async (request): Promise<ProjectSummary[]> => {
    const { accountId } = await requireAccount(context, request);
    const rows = await db
      .selectFrom("projects")
      .innerJoin("memberships", "memberships.project_id", "projects.id")
      .select(["projects.id", "projects.name", "projects.owner_id", "projects.manifest_doc_id", "projects.created_at", "projects.kind", "memberships.role"])
      .where("memberships.account_id", "=", accountId)
      .where("projects.deleted_at", "is", null)
      .orderBy("projects.created_at")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      ownerId: row.owner_id,
      manifestDocId: row.manifest_doc_id,
      createdAt: iso(row.created_at),
      kind: row.kind,
    }));
  });

  app.get(route(ApiRoutes.project, "projectId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    return projectSummary(db, projectId, accountId);
  });

  app.patch(route(ApiRoutes.project, "projectId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    const body = renameProjectBody.parse(request.body);
    const actor = bindActor(accountId, undefined, body.ai);
    await requireProjectAction(db, projectId, accountId, "rename-project", actor);
    const before = await db.selectFrom("projects").select("name").where("id", "=", projectId).executeTakeFirstOrThrow();
    await db.updateTable("projects").set({ name: body.name }).where("id", "=", projectId).execute();
    await writeAudit(db, {
      projectId,
      actor,
      accountId,
      action: "project.rename",
      target: projectId,
      details: { from: before.name, to: body.name },
    });
    return projectSummary(db, projectId, accountId);
  });

  app.delete(route(ApiRoutes.project, "projectId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    const actor = bindActor(accountId, undefined);
    await requireProjectAction(db, projectId, accountId, "delete-project", actor);
    const { docs, members } = await db.transaction().execute(async (trx) => {
      const docs = await trx.selectFrom("documents").select("id").where("project_id", "=", projectId).execute();
      const members = await trx.selectFrom("memberships").select("account_id").where("project_id", "=", projectId).execute();
      // Reviews reference revisions without ON DELETE CASCADE. Remove them
      // first, then let the project's foreign keys erase all dependent rows.
      await trx.deleteFrom("reviews").where("project_id", "=", projectId).execute();
      await trx.deleteFrom("projects").where("id", "=", projectId).execute();
      return { docs, members };
    });
    // Project subscriptions disappear when the last document is closed.
    // User events also reach members who do not currently have a document open.
    for (const member of members) publish(context, "user", member.account_id, EventKind.ProjectDeleted, { projectId });
    publish(context, "project", projectId, EventKind.ProjectDeleted, { projectId });
    for (const doc of docs) notifyRooms(context, "documentDeleted", (rooms) => rooms.documentDeleted(doc.id));
    return reply.status(204).send();
  });

  app.get(route(ApiRoutes.members, "projectId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    await requireProjectAction(db, projectId, accountId, "read");
    return listMembers(db, projectId);
  });

  app.patch(route(ApiRoutes.member, "projectId", "userId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId, userId } = memberParams.parse(request.params);
    const body = changeRoleBody.parse(request.body);
    const role = body.role as Role;
    const actor = bindActor(accountId, undefined, body.ai);
    await requireProjectAction(db, projectId, accountId, "change-roles", actor);
    if (role === "owner") throw new HttpError("bad-request", "Ownership cannot be transferred by changing a role.");
    const target = await db
      .selectFrom("memberships")
      .select("role")
      .where("project_id", "=", projectId)
      .where("account_id", "=", userId)
      .executeTakeFirst();
    if (!target) throw new HttpError("not-found", "Member not found.");
    // Also stops the owner demoting themselves: a project always has its owner.
    if (target.role === "owner") throw new HttpError("forbidden", "The owner's role cannot be changed.");
    if (target.role !== role) {
      await db
        .updateTable("memberships")
        .set({ role })
        .where("project_id", "=", projectId)
        .where("account_id", "=", userId)
        .execute();
      await writeAudit(db, {
        projectId,
        actor,
        accountId,
        action: "member.role",
        target: userId,
        details: { from: target.role, to: role },
      });
      announceMembership(context, projectId, userId, role);
    }
    const member = (await listMembers(db, projectId)).find((entry) => entry.id === userId);
    if (!member) throw new HttpError("not-found", "Member not found.");
    return member;
  });

  app.delete(route(ApiRoutes.member, "projectId", "userId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId, userId } = memberParams.parse(request.params);
    const actor = bindActor(accountId, undefined);
    const leaving = userId === accountId;
    // Leaving needs only membership; removing someone else is an owner action.
    await requireProjectAction(db, projectId, accountId, leaving ? "read" : "change-roles", actor);
    const target = await db
      .selectFrom("memberships")
      .select("role")
      .where("project_id", "=", projectId)
      .where("account_id", "=", userId)
      .executeTakeFirst();
    if (!target) throw new HttpError("not-found", "Member not found.");
    if (target.role === "owner") throw new HttpError("forbidden", "The owner cannot leave or be removed.");
    await db.deleteFrom("memberships").where("project_id", "=", projectId).where("account_id", "=", userId).execute();
    await writeAudit(db, {
      projectId,
      actor,
      accountId,
      action: leaving ? "member.leave" : "member.remove",
      target: userId,
      details: { role: target.role },
    });
    announceMembership(context, projectId, userId, null);
    return reply.status(204).send();
  });

  // Writer leases for synced folders (004_folder_leases.sql). Leases are per
  // account: one member cannot take or release another's.
  app.post(route(ApiRoutes.folderLease, "projectId"), async (request): Promise<FolderLease> => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    const body = folderLeaseBody.parse(request.body);
    await requireProjectAction(db, projectId, accountId, "read");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, body.ttlMs)));
    const taken = await db
      .insertInto("folder_leases")
      .values({ project_id: projectId, account_id: accountId, folder_id: body.folderId, holder: body.holder, expires_at: expiresAt, updated_at: now })
      .onConflict((conflict) =>
        conflict
          .columns(["project_id", "account_id", "folder_id"])
          .doUpdateSet({ holder: body.holder, expires_at: expiresAt, updated_at: now })
          .where((eb) => eb.or([eb("folder_leases.holder", "=", body.holder), eb("folder_leases.expires_at", "<=", now)])),
      )
      .returning(["holder", "expires_at", "contended_at"])
      .executeTakeFirst();
    if (taken) {
      return { folderId: body.folderId, holder: taken.holder, granted: true, expiresAt: iso(taken.expires_at), contended: taken.contended_at !== null };
    }
    // Held by another installation: remember that the folder has contenders,
    // so its holder learns it at the next renewal.
    const current = await db
      .updateTable("folder_leases")
      .set({ contended_at: now })
      .where("project_id", "=", projectId)
      .where("account_id", "=", accountId)
      .where("folder_id", "=", body.folderId)
      .returning(["holder", "expires_at"])
      .executeTakeFirst();
    return { folderId: body.folderId, holder: current?.holder ?? null, granted: false, expiresAt: current ? iso(current.expires_at) : null, contended: true };
  });

  app.delete(route(ApiRoutes.folderLease, "projectId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    const query = folderLeaseQuery.parse(request.query);
    await requireProjectAction(db, projectId, accountId, "read");
    await db
      .deleteFrom("folder_leases")
      .where("project_id", "=", projectId)
      .where("account_id", "=", accountId)
      .where("folder_id", "=", query.folderId)
      .where("holder", "=", query.holder)
      .execute();
    return reply.status(204).send();
  });

  app.get(route(ApiRoutes.audit, "projectId"), async (request): Promise<AuditEntry[]> => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = projectParams.parse(request.params);
    const query = auditQuery.parse(request.query);
    await requireProjectAction(db, projectId, accountId, "view-audit");
    let select = db
      .selectFrom("audit_log")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("id", "desc")
      .limit(query.limit);
    if (query.before !== undefined) select = select.where("id", "<", query.before);
    const rows = await select.execute();
    return rows.map((row) => ({
      id: String(row.id),
      projectId: projectId,
      actor: row.actor,
      action: row.action,
      target: row.target,
      details: row.details,
      at: iso(row.at),
    }));
  });
}
