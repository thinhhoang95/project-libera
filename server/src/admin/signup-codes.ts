// signup-code create [--note text] [--uses n] [--expires-days n],
// signup-code list, signup-code revoke <id>
//
// Registration codes let new people create accounts while the server is
// invitation-only (ALLOW_OPEN_SIGNUP off, the default). Only a hash is stored,
// so the code is shown once, when it is created.

import { randomInt } from "node:crypto";

import { hashRegistrationCode } from "../api/registration-codes.js";
import { writeAudit } from "../auth/access.js";
import { newId } from "../ids.js";
import type { Actor } from "../protocol.js";
import { isoTime, table, type AdminContext, type CommandResult } from "./context.js";
import { CliError } from "./history.js";

const ADMIN_ACTOR: Actor = { kind: "system", reason: "migration" };

/** "LBR-" plus 20 characters from an unambiguous alphabet, in groups of five (about 99 bits). */
export function newRegistrationCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let body = "";
  for (let index = 0; index < 20; index += 1) body += alphabet[randomInt(alphabet.length)];
  return `LBR-${body.match(/.{5}/g)!.join("-")}`;
}

export async function signupCodeCreate(ctx: AdminContext): Promise<CommandResult> {
  const maxUses = ctx.args.int("uses", 1);
  if (maxUses < 1) throw new CliError("--uses must be at least 1.");
  const days = ctx.args.string("expires-days") === undefined ? null : ctx.args.int("expires-days", 0);
  if (days !== null && days < 1) throw new CliError("--expires-days must be at least 1.");
  const note = ctx.args.string("note")?.trim().slice(0, 200) || null;
  const code = newRegistrationCode();
  const id = newId("reg");
  const expiresAt = days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  await ctx.db
    .insertInto("registration_codes")
    .values({ id, code_hash: hashRegistrationCode(code), note, max_uses: maxUses, expires_at: expiresAt })
    .execute();
  await writeAudit(ctx.db, { projectId: null, actor: ADMIN_ACTOR, accountId: null, action: "admin.signup-code.create", target: id, details: { maxUses, note } });
  return {
    data: { id, code, maxUses, note, expiresAt: isoTime(expiresAt) },
    text: [
      `Registration code ${id}: ${code}`,
      `${maxUses === 1 ? "Single use" : `Up to ${maxUses} uses`}${expiresAt ? `, expires ${isoTime(expiresAt)}` : ", no expiry"}.`,
      "It is shown only now. Send it to the person over a trusted channel; they enter it when creating their account.",
    ],
  };
}

export async function signupCodeList(ctx: AdminContext): Promise<CommandResult> {
  const rows = await ctx.db.selectFrom("registration_codes").selectAll().orderBy("created_at").execute();
  const now = Date.now();
  const codes = rows.map((row) => {
    const expired = row.expires_at !== null && new Date(row.expires_at).getTime() <= now;
    const status = row.revoked_at ? "revoked" : expired ? "expired" : row.uses >= row.max_uses ? "used up" : "active";
    return { id: row.id, note: row.note, uses: row.uses, maxUses: row.max_uses, status, createdAt: isoTime(row.created_at), expiresAt: isoTime(row.expires_at) };
  });
  return {
    data: { codes },
    text: table(
      ["CODE", "STATUS", "USES", "NOTE", "CREATED", "EXPIRES"],
      codes.map((c) => [c.id, c.status, `${c.uses}/${c.maxUses}`, c.note, c.createdAt, c.expiresAt]),
    ),
  };
}

export async function signupCodeRevoke(ctx: AdminContext): Promise<CommandResult> {
  const id = ctx.args.positional(2, "code id");
  const result = await ctx.db
    .updateTable("registration_codes")
    .set({ revoked_at: new Date() })
    .where("id", "=", id)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows) === 0) throw new CliError(`No active registration code ${id}.`);
  await writeAudit(ctx.db, { projectId: null, actor: ADMIN_ACTOR, accountId: null, action: "admin.signup-code.revoke", target: id });
  return { data: { id }, text: [`Revoked ${id}.`] };
}
