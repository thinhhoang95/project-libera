// Blob upload and download. Bytes are addressed by sha256: the server checks
// the hash on upload, so a blob's name is proof of its content and uploads
// are naturally idempotent.

import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireProjectAction } from "../auth/access.js";
import { getBlobStore, isBlobHash } from "../blobs/index.js";
import type { ServerContext } from "../context.js";
import type { BlobsTable } from "../db/types.js";
import { HttpError } from "../http/errors.js";
import { ApiRoutes, type BlobInfo } from "../protocol.js";
import type { Selectable } from "kysely";
import { iso, pathId, requireAccount, route } from "./common.js";

const blobParams = z.object({
  projectId: pathId,
  hash: z.string().refine(isBlobHash, "Expected a lower-case hex sha256."),
});

function blobInfo(row: Selectable<BlobsTable>): BlobInfo {
  return { hash: row.hash, size: Number(row.size), mime: row.mime, createdAt: iso(row.created_at) };
}

/** The media type from Content-Type without parameters, or octet-stream when absent or odd. */
function mimeOf(header: string | undefined): string {
  const type = header?.split(";")[0].trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(type) ? type : "application/octet-stream";
}

export function registerBlobRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db, config } = context;
  const path = route(ApiRoutes.blob, "projectId", "hash");

  async function readableBlob(request: { params: unknown }, accountId: string) {
    const { projectId, hash } = blobParams.parse(request.params);
    await requireProjectAction(db, projectId, accountId, "read");
    const row = await db
      .selectFrom("blobs")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("hash", "=", hash)
      .executeTakeFirst();
    if (!row) throw new HttpError("not-found", "Blob not found.");
    return row;
  }

  // Raw bodies only in this scope: the JSON parser elsewhere stays untouched,
  // and any Content-Type (the file's own) is accepted here.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: config.MAX_BLOB_BYTES }, (_request, body, done) => {
      done(null, body);
    });

    // Checked in onRequest, before the body is read, so nobody can make the
    // server buffer an upload they are not allowed to make.
    const onRequest = async (request: FastifyRequest) => {
      const { accountId } = await requireAccount(context, request);
      const { projectId } = blobParams.parse(request.params);
      await requireProjectAction(db, projectId, accountId, "manage-files");
    };

    scope.put(path, { bodyLimit: config.MAX_BLOB_BYTES, onRequest }, async (request, reply) => {
      const { accountId } = await requireAccount(context, request);
      const { projectId, hash } = blobParams.parse(request.params);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== hash) {
        throw new HttpError("bad-request", "The body does not match the hash in the URL.", { expected: hash, actual });
      }

      const existing = await db
        .selectFrom("blobs")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("hash", "=", hash)
        .executeTakeFirst();
      const store = getBlobStore(context);
      // Re-put even when the row exists, in case the bytes were lost from the store.
      if (!existing || !(await store.has(hash))) await store.put(hash, body, mimeOf(request.headers["content-type"]));
      if (existing) return reply.status(200).send(blobInfo(existing));

      const row = await db
        .insertInto("blobs")
        .values({ project_id: projectId, hash, size: body.byteLength, mime: mimeOf(request.headers["content-type"]), created_by: accountId })
        .onConflict((conflict) => conflict.columns(["project_id", "hash"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (row) return reply.status(201).send(blobInfo(row));
      const raced = await db
        .selectFrom("blobs")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("hash", "=", hash)
        .executeTakeFirstOrThrow();
      return reply.status(200).send(blobInfo(raced));
    });
  });

  app.head(path, async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const row = await readableBlob(request, accountId);
    reply.header("content-type", row.mime).header("content-length", String(row.size));
    return reply.status(200).send();
  });

  app.get(path, { exposeHeadRoute: false }, async (request, reply) => {
    const { accountId } = await requireAccount(context, request);
    const row = await readableBlob(request, accountId);
    const stream = await getBlobStore(context).get(row.hash);
    if (!stream) {
      context.log.error({ hash: row.hash, projectId: row.project_id }, "Blob row exists but the store has no bytes");
      throw new HttpError("not-found", "Blob content is missing.");
    }
    reply
      .header("content-type", row.mime)
      .header("content-length", String(row.size))
      // Content-addressed: the bytes behind a hash never change.
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "attachment");
    return reply.send(stream);
  });
}
