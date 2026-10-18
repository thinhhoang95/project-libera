// accounts list, account disable|enable <email>, account reset-password <email>,
// audit tail [--project <id>] [--limit n] [--follow]

import { randomBytes } from "node:crypto";

import { sql, type Kysely } from "kysely";

import { writeAudit } from "../auth/access.js";
import { hashPassword } from "../auth/passwords.js";
import type { AccountRow, DB } from "../db/types.js";
import type { Actor } from "../protocol.js";
import { isoTime, table, type AdminContext, type CommandResult } from "./context.js";
import { CliError } from "./history.js";
import { liveServer, revokeLiveSessions } from "./live.js";

const ADMIN_ACTOR: Actor = { kind: "system", reason: "migration" };

async function findAccount(db: Kysely<DB>, email: string): Promise<AccountRow> {
  const account = await db
    .selectFrom("accounts")
    .selectAll()
    .where(sql<string>`lower(email)`, "=", email.trim().toLowerCase())
    .executeTakeFirst();
  if (!account) throw new CliError(`No account with email ${email}.`);
  return account;
}

async function revokeRefreshTokens(db: Kysely<DB>, accountId: string): Promise<number> {
  const result = await db
    .updateTable("refresh_tokens")
    .set({ revoked_at: new Date() })
    .where("account_id", "=", accountId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function accountsList(ctx: AdminContext): Promise<CommandResult> {
  const rows = await ctx.db
    .selectFrom("accounts as a")
    .select([
      "a.id",
      "a.email",
      "a.display_name",
      "a.created_at",
      "a.disabled_at",
      (eb) =>
        eb
          .selectFrom("memberships")
          .select((inner) => inner.fn.countAll<number>().as("n"))
          .whereRef("memberships.account_id", "=", "a.id")
          .as("projects"),
      (eb) =>
        eb
          .selectFrom("refresh_tokens")
          .select((inner) => inner.fn.countAll<number>().as("n"))
          .whereRef("refresh_tokens.account_id", "=", "a.id")
          .where("refresh_tokens.revoked_at", "is", null)
          .where("refresh_tokens.expires_at", ">", new Date())
          .as("sessions"),
    ])
    .orderBy("a.created_at")
    .execute();
  const accounts = rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: isoTime(row.created_at),
    disabledAt: isoTime(row.disabled_at),
    projects: Number(row.projects ?? 0),
    activeSessions: Number(row.sessions ?? 0),
  }));
  return {
    data: { accounts },
    text: table(
      ["ACCOUNT", "EMAIL", "NAME", "PROJECTS", "SESSIONS", "CREATED", "DISABLED"],
      accounts.map((a) => [a.id, a.email, a.displayName, a.projects, a.activeSessions, a.createdAt, a.disabledAt]),
    ),
  };
}

/** Disables sign-in, revokes every refresh token and closes the account's open sockets. */
export async function accountDisable(ctx: AdminContext): Promise<CommandResult> {
  const email = ctx.args.positional(2, "email");
  const account = await findAccount(ctx.db, email);
  await ctx.db.updateTable("accounts").set({ disabled_at: account.disabled_at ?? new Date() }).where("id", "=", account.id).execute();
  const revoked = await revokeRefreshTokens(ctx.db, account.id);
  await writeAudit(ctx.db, { projectId: null, actor: ADMIN_ACTOR, accountId: null, action: "admin.account.disable", target: account.id, details: { revokedSessions: revoked } });
  const closed = await revokeLiveSessions(liveServer(ctx.config, ctx.args.string("server")), account.id);
  const text = [`Disabled ${account.email} (${account.id}); revoked ${revoked} sessions.`];
  text.push(
    closed
      ? "The running server closed the account's open sockets."
      : "No running server answered: open sockets end when their access token expires (ACCESS_TOKEN_TTL_SECONDS).",
  );
  return { data: { accountId: account.id, email: account.email, revokedSessions: revoked, socketsClosed: closed }, text };
}

export async function accountEnable(ctx: AdminContext): Promise<CommandResult> {
  const email = ctx.args.positional(2, "email");
  const account = await findAccount(ctx.db, email);
  await ctx.db.updateTable("accounts").set({ disabled_at: null }).where("id", "=", account.id).execute();
  await writeAudit(ctx.db, { projectId: null, actor: ADMIN_ACTOR, accountId: null, action: "admin.account.enable", target: account.id });
  return { data: { accountId: account.id, email: account.email }, text: [`Enabled ${account.email} (${account.id}).`] };
}

/** A temporary password: 20 characters from an unambiguous alphabet (about 115 bits). */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(40);
  let password = "";
  for (const byte of bytes) {
    // Rejection sampling keeps every character equally likely.
    if (byte >= alphabet.length * Math.floor(256 / alphabet.length)) continue;
    password += alphabet[byte % alphabet.length];
    if (password.length === 20) break;
  }
  if (password.length < 20) return temporaryPassword();
  return password;
}

/**
 * Sets a new random password and revokes every session. The password is
 * printed once (never stored or logged in clear); give it to the user over a
 * trusted channel and ask them to change it in Preferences → Collaboration.
 */
export async function accountResetPassword(ctx: AdminContext): Promise<CommandResult> {
  const email = ctx.args.positional(2, "email");
  const account = await findAccount(ctx.db, email);
  const password = temporaryPassword();
  await ctx.db.updateTable("accounts").set({ password_hash: await hashPassword(password) }).where("id", "=", account.id).execute();
  const revoked = await revokeRefreshTokens(ctx.db, account.id);
  await writeAudit(ctx.db, { projectId: null, actor: ADMIN_ACTOR, accountId: null, action: "admin.account.reset-password", target: account.id, details: { revokedSessions: revoked } });
  await revokeLiveSessions(liveServer(ctx.config, ctx.args.string("server")), account.id);
  return {
    data: { accountId: account.id, email: account.email, temporaryPassword: password, revokedSessions: revoked },
    text: [
      `New temporary password for ${account.email}: ${password}`,
      `Revoked ${revoked} sessions. Share it over a trusted channel and ask the user to change it after signing in.`,
    ],
  };
}

// ------------------------------------------------------------------ audit tail

interface AuditLine {
  id: number;
  at: string | null;
  projectId: string | null;
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
}

function actorText(actor: Actor | null, accountId: string | null): string {
  if (!actor) return accountId ?? "-";
  if (actor.kind === "user") return actor.userId;
  if (actor.kind === "ai") return `ai:${actor.feature}@${actor.onBehalfOf}`;
  return `system:${actor.reason}${actor.onBehalfOf ? `@${actor.onBehalfOf}` : ""}`;
}

async function auditPage(db: Kysely<DB>, projectId: string | undefined, afterId: number | null, limit: number): Promise<AuditLine[]> {
  let query = db.selectFrom("audit_log").selectAll();
  if (projectId) query = query.where("project_id", "=", projectId);
  if (afterId !== null) query = query.where("id", ">", afterId).orderBy("id", "asc").limit(limit);
  else query = query.orderBy("id", "desc").limit(limit);
  const rows = await query.execute();
  if (afterId === null) rows.reverse();
  return rows.map((row) => ({
    id: Number(row.id),
    at: isoTime(row.at),
    projectId: row.project_id,
    actor: actorText(row.actor, row.account_id),
    action: row.action,
    target: row.target,
    details: row.details,
  }));
}

function auditText(lines: AuditLine[]): string[] {
  return lines.map((line) => `${line.at}  #${line.id}  ${line.projectId ?? "-"}  ${line.actor}  ${line.action}  ${line.target}  ${JSON.stringify(line.details)}`);
}

export async function auditTail(ctx: AdminContext, print: (result: CommandResult) => void): Promise<CommandResult> {
  const projectId = ctx.args.string("project");
  const limit = ctx.args.int("limit", 50);
  const lines = await auditPage(ctx.db, projectId, null, limit);
  const result = { data: { entries: lines }, text: auditText(lines) };
  if (!ctx.args.has("follow")) return result;
  print(result);
  let last = lines.length > 0 ? lines[lines.length - 1].id : 0;
  // Polls until interrupted (Ctrl-C).
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const next = await auditPage(ctx.db, projectId, last, 500);
    if (next.length === 0) continue;
    last = next[next.length - 1].id;
    print({ data: { entries: next }, text: auditText(next) });
  }
}
