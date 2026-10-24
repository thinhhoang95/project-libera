// Shared albums: activity notifications. Everything else about an album
// (its photos, captions, edits) is in its manifest document, and comments
// on photos are ordinary threads on that document.

import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";

import { requireProjectAction } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import { ApiRoutes, EventKind, bindActor } from "../protocol.js";
import { notificationInfo, notify } from "./notifications.js";
import { loadUsers, pathId, publish, requireAccount, route, userOrUnknown } from "./common.js";

const activityParams = z.object({ projectId: pathId });
const activityBody = z.object({
  added: z.number().int().min(1).max(10_000),
  fileIds: z.array(z.string().min(1).max(200)).max(50).optional(),
});

/** Unread "photos added" notifications from the same member within this window are merged into one. */
const COLLAPSE_MS = 6 * 60 * 60_000;
const MAX_PREVIEW_IDS = 12;

export function registerAlbumRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db } = context;

  app.post(route(ApiRoutes.albumActivity, "projectId"), async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId } = activityParams.parse(request.params);
    const body = activityBody.parse(request.body);
    await requireProjectAction(db, projectId, accountId, "manage-files", bindActor(accountId, undefined));
    const project = await db.selectFrom("projects").select(["name", "kind", "manifest_doc_id"]).where("id", "=", projectId).executeTakeFirstOrThrow();
    if (project.kind !== "album") throw new HttpError("bad-request", "Only shared albums report photo activity.");

    const actor = userOrUnknown(await loadUsers(db, [accountId]), accountId);
    const members = await db.selectFrom("memberships").select("account_id").where("project_id", "=", projectId).where("account_id", "!=", accountId).execute();
    const since = new Date(Date.now() - COLLAPSE_MS);
    const fresh: Parameters<typeof notify>[1] = [];
    for (const member of members) {
      const existing = await db
        .selectFrom("notifications")
        .selectAll()
        .where("account_id", "=", member.account_id)
        .where("project_id", "=", projectId)
        .where("kind", "=", "album-photos-added")
        .where("read_at", "is", null)
        .where("created_at", ">", since)
        .where(sql<boolean>`payload->'actor'->>'id' = ${accountId}`)
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      if (existing) {
        const previous = existing.payload as { count?: unknown; fileIds?: unknown };
        const count = (typeof previous.count === "number" ? previous.count : 0) + body.added;
        const fileIds = [...new Set([...(body.fileIds ?? []), ...(Array.isArray(previous.fileIds) ? previous.fileIds.filter((id): id is string => typeof id === "string") : [])])].slice(0, MAX_PREVIEW_IDS);
        const row = await db
          .updateTable("notifications")
          .set({ payload: JSON.stringify({ ...previous, actor, albumName: project.name, count, fileIds }), created_at: new Date() })
          .where("id", "=", existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        publish(context, "user", member.account_id, EventKind.Notification, notificationInfo(row));
        continue;
      }
      fresh.push({
        accountId: member.account_id,
        kind: "album-photos-added",
        projectId,
        docId: project.manifest_doc_id,
        payload: { actor, albumName: project.name, count: body.added, fileIds: (body.fileIds ?? []).slice(0, MAX_PREVIEW_IDS) },
      });
    }
    await notify(context, fresh);
    return reply.status(204).send();
  });
}
