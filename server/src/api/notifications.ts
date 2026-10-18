// In-app notifications (mentions, replies, resolutions, invitations). Each one
// is stored, then pushed to the account's open sockets as a user-scoped
// event; the digest job emails the ones left unread.

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ServerContext } from "../context.js";
import type { NotificationsTable } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { newId } from "../ids.js";
import { ApiRoutes, EventKind, type NotificationInfo, type NotificationKind } from "../protocol.js";
import type { Selectable } from "kysely";
import { iso, isoOrNull, pathId, publish, requireAccount } from "./common.js";

const listQuery = z.object({
  unread: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((value) => value === "1" || value === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const markReadBody = z.object({
  ids: z.array(pathId).max(500).optional(),
  all: z.boolean().optional(),
});

export function notificationInfo(row: Selectable<NotificationsTable>): NotificationInfo {
  return {
    id: row.id,
    kind: row.kind as NotificationKind,
    projectId: row.project_id,
    docId: row.doc_id,
    payload: row.payload,
    createdAt: iso(row.created_at),
    readAt: isoOrNull(row.read_at),
  };
}

export interface NewNotification {
  accountId: string;
  kind: NotificationKind;
  projectId: string | null;
  docId: string | null;
  payload: Record<string, unknown>;
}

export async function notify(context: ServerContext, notifications: NewNotification[]): Promise<void> {
  if (notifications.length === 0) return;
  const rows = await context.db
    .insertInto("notifications")
    .values(
      notifications.map((entry) => ({
        id: newId("ntf"),
        account_id: entry.accountId,
        project_id: entry.projectId,
        doc_id: entry.docId,
        kind: entry.kind,
        payload: JSON.stringify(entry.payload),
      })),
    )
    .returningAll()
    .execute();
  for (const row of rows) publish(context, "user", row.account_id, EventKind.Notification, notificationInfo(row));
}

export function registerNotificationRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db } = context;

  app.get(ApiRoutes.notifications, async (request): Promise<NotificationInfo[]> => {
    const { accountId } = await requireAccount(context, request);
    const query = listQuery.parse(request.query);
    let select = db
      .selectFrom("notifications")
      .selectAll()
      .where("account_id", "=", accountId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(query.limit);
    if (query.unread) select = select.where("read_at", "is", null);
    return (await select.execute()).map(notificationInfo);
  });

  app.post(ApiRoutes.notificationsRead, async (request) => {
    const { accountId } = await requireAccount(context, request);
    const body = markReadBody.parse(request.body ?? {});
    if (!body.all && !body.ids?.length) throw new HttpError("bad-request", "Pass ids or all: true.");
    let update = db
      .updateTable("notifications")
      .set({ read_at: new Date() })
      .where("account_id", "=", accountId)
      .where("read_at", "is", null);
    if (!body.all) update = update.where("id", "in", body.ids!);
    const result = await update.executeTakeFirst();
    return { updated: Number(result.numUpdatedRows) };
  });
}
