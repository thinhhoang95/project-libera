// Notification email digest (M2.3). Emails each account its unread
// notifications that nobody has emailed yet, once they are 15 minutes old
// (time to read them in the app first), and at most once a day per account.

import { sql } from "kysely";

import type { ServerContext } from "../context.js";
import { sendMailSafely } from "../mail/index.js";
import { digestEmail, type DigestItem } from "../mail/templates.js";
import type { Job } from "./index.js";

const SETTLE_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 24 * 60 * 60_000;
/** Lines per email; the rest are summarized in the count and sent next time. */
const MAX_ITEMS = 50;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function name(value: unknown): string {
  return value && typeof value === "object" ? str((value as { displayName?: unknown }).displayName) || "Someone" : "Someone";
}

function describe(kind: string, payload: Record<string, unknown>, projectName: string | null): string {
  const where = projectName ? ` in "${projectName}"` : "";
  switch (kind) {
    case "mention":
      return `${name(payload.author)} mentioned you${where}: ${str(payload.excerpt)}`;
    case "reply":
      return `${name(payload.author)} replied${where}: ${str(payload.excerpt)}`;
    case "thread-resolved":
      return `${name(payload.resolvedBy)} resolved your comment${where}: "${str(payload.quote)}"`;
    case "invited":
      return `${name(payload.inviter)} invited you to "${str(payload.projectName)}": ${str(payload.url)}`;
    case "review-requested":
      return `You were asked to review a document${where}`;
    case "review-decided":
      return `A review you requested was decided${where}`;
    default:
      return `New activity${where}`;
  }
}

export async function runDigest(context: ServerContext, now = new Date()): Promise<number> {
  const { db } = context;
  const settled = new Date(now.getTime() - SETTLE_MS);
  const recent = new Date(now.getTime() - MIN_INTERVAL_MS);

  const due = await db
    .selectFrom("notifications")
    .innerJoin("accounts", "accounts.id", "notifications.account_id")
    .select(["accounts.id", "accounts.email", "accounts.display_name"])
    .distinct()
    .where("notifications.read_at", "is", null)
    .where("notifications.emailed_at", "is", null)
    .where("notifications.created_at", "<=", settled)
    .where("accounts.disabled_at", "is", null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("notifications as sent")
            .select(sql<number>`1`.as("one"))
            .whereRef("sent.account_id", "=", "accounts.id")
            .where("sent.emailed_at", ">", recent),
        ),
      ),
    )
    .execute();

  let sent = 0;
  for (const account of due) {
    const rows = await db
      .selectFrom("notifications")
      .leftJoin("projects", "projects.id", "notifications.project_id")
      .select(["notifications.id", "notifications.kind", "notifications.payload", "projects.name as project_name"])
      .where("notifications.account_id", "=", account.id)
      .where("notifications.read_at", "is", null)
      .where("notifications.emailed_at", "is", null)
      .where("notifications.created_at", "<=", settled)
      .orderBy("notifications.created_at")
      .limit(MAX_ITEMS)
      .execute();
    if (rows.length === 0) continue;
    const items: DigestItem[] = rows.map((row) => ({ line: describe(row.kind, row.payload, row.project_name) }));
    const delivered = await sendMailSafely(
      context,
      digestEmail({ to: account.email, displayName: account.display_name, items, publicUrl: context.config.PUBLIC_URL }),
    );
    if (!delivered) continue;
    await db
      .updateTable("notifications")
      .set({ emailed_at: now })
      .where("id", "in", rows.map((row) => row.id))
      .execute();
    sent += 1;
  }
  return sent;
}

export const digestJob: Job = {
  name: "digest",
  intervalMs: 15 * 60_000,
  async run(context) {
    await runDigest(context);
  },
};
