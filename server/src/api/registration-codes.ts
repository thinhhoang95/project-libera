// Registration codes for invitation-only servers. Issued by the server admin
// (`admin signup-code create`); only the hash is stored.

import type { Kysely } from "kysely";

import type { DB } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { sha256Hex } from "../ids.js";

/** Drops whitespace a person may have picked up when copying the code. */
export function normalizeRegistrationCode(input: string): string {
  return input.replace(/\s+/g, "");
}

export function hashRegistrationCode(input: string): string {
  return sha256Hex(normalizeRegistrationCode(input));
}

/**
 * Uses one registration code. A single conditional update, so concurrent
 * sign-ups cannot exceed `max_uses`. Run it inside the sign-up transaction: a
 * later failure then gives the use back.
 */
export async function redeemRegistrationCode(db: Kysely<DB>, code: string): Promise<string> {
  const row = await db
    .updateTable("registration_codes")
    .set((eb) => ({ uses: eb("uses", "+", 1) }))
    .where("code_hash", "=", hashRegistrationCode(code))
    .where("revoked_at", "is", null)
    .where((eb) => eb("uses", "<", eb.ref("max_uses")))
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", new Date())]))
    .returning("id")
    .executeTakeFirst();
  if (!row) throw new HttpError("invalid-registration-code", "That registration code is not valid, has expired, or has been used up.");
  return row.id;
}
