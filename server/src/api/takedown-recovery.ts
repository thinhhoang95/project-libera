// Terminal recovery after a takedown. Deleting a project removes its members'
// access, so a device that had not yet received the last version of a binary
// could never get it. In the deleting transaction the server records which
// blobs the project held and who its members were; for RECOVERY_RETENTION_MS
// those members may still download exactly those blobs here. One bounded
// window: the rows expire, and blob-gc keeps the objects only while a row names them.

import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";

import { getBlobStore, isBlobHash } from "../blobs/index.js";
import type { ServerContext } from "../context.js";
import type { DB } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { ApiRoutes } from "../protocol.js";
import { pathId, requireAccount, route } from "./common.js";

/** How long a taken-down project's binaries stay downloadable by its former members. */
export const RECOVERY_RETENTION_MS = 14 * 24 * 60 * 60_000;

/** Inside the deleting transaction, before the project's rows go. */
export async function retainTakedownRecovery(trx: Kysely<DB>, projectId: string, name: string): Promise<void> {
  const blobs = await trx.selectFrom("blobs").select(["hash", "size", "mime"]).where("project_id", "=", projectId).execute();
  if (!blobs.length) return;
  const members = await trx.selectFrom("memberships").select("account_id").where("project_id", "=", projectId).execute();
  const expires = new Date(Date.now() + RECOVERY_RETENTION_MS);
  await trx.insertInto("takedown_recoveries").values({ project_id: projectId, name, expires_at: expires })
    .onConflict((conflict) => conflict.column("project_id").doUpdateSet({ expires_at: expires })).execute();
  for (let start = 0; start < members.length; start += 500) {
    await trx.insertInto("takedown_recovery_members").values(members.slice(start, start + 500).map((member) => ({ project_id: projectId, account_id: member.account_id })))
      .onConflict((conflict) => conflict.columns(["project_id", "account_id"]).doNothing()).execute();
  }
  for (let start = 0; start < blobs.length; start += 500) {
    await trx.insertInto("takedown_recovery_blobs").values(blobs.slice(start, start + 500).map((blob) => ({ project_id: projectId, hash: blob.hash, size: blob.size, mime: blob.mime })))
      .onConflict((conflict) => conflict.columns(["project_id", "hash"]).doNothing()).execute();
  }
}

const params = z.object({ projectId: pathId, hash: z.string().refine(isBlobHash, "Expected a lower-case hex sha256.") });

export function registerTakedownRecoveryRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db } = context;
  app.get(route(ApiRoutes.takedownRecoveryBlob, "projectId", "hash"), { exposeHeadRoute: false }, async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const { projectId, hash } = params.parse(request.params);
    const row = await db.selectFrom("takedown_recovery_blobs as b")
      .innerJoin("takedown_recoveries as r", "r.project_id", "b.project_id")
      .innerJoin("takedown_recovery_members as m", "m.project_id", "b.project_id")
      .select(["b.hash", "b.size", "b.mime"])
      .where("b.project_id", "=", projectId).where("b.hash", "=", hash).where("m.account_id", "=", accountId)
      .where("r.expires_at", ">", new Date()).executeTakeFirst();
    if (!row) throw new HttpError("not-found", "Nothing to recover here.");
    const stream = await getBlobStore(context).get(hash);
    if (!stream) throw new HttpError("not-found", "Blob content is missing.");
    reply
      .header("content-type", row.mime)
      .header("content-length", String(row.size))
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "attachment");
    return reply.send(stream);
  });
}
