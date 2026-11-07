// Sidecars are imported under the room lock: nested Y.Maps must have one creator.
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { z } from "zod";

import { requireDocumentAction } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import { ApiRoutes, PdfKeys, PdfLimits, pdfAnnotationValues, pdfAnchorViolation, pdfMarkValuesViolation } from "../protocol.js";
import { pathId, requireAccount, route } from "./common.js";
import { addMessage, createThread, setThreadStatus } from "./threads.js";

const comment = z.object({
  id: z.string().min(1).max(200),
  anchor: z.record(z.string(), z.unknown()),
  status: z.enum(["open", "resolved"]),
  messages: z.array(z.object({ id: z.string().min(1).max(200), text: z.string().trim().min(1).max(20_000) })).min(1).max(500),
});
const bodySchema = z.object({
  marks: z.array(z.record(z.string(), z.unknown())).max(2000),
  comments: z.array(comment).max(2000).default([]),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
const stableId = (prefix: string, seed: string) => `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;

export function registerPdfRoutes(app: FastifyInstance, context: ServerContext): void {
  app.post(route(ApiRoutes.pdfImport, "docId"), async (request) => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = z.object({ docId: pathId }).parse(request.params);
    const body = bodySchema.parse(request.body);
    if (JSON.stringify(body).length > 2 * 1024 * 1024) throw new HttpError("too-large", "Import this sidecar in smaller batches.");
    const fields = body.marks.map((mark) => pdfAnnotationValues(mark, accountId, body.sourceHash));
    for (const value of fields) {
      const problem = pdfMarkValuesViolation(value);
      if (problem) throw new HttpError("bad-request", problem);
    }
    for (const local of body.comments) {
      const problem = pdfAnchorViolation(local.anchor);
      if (problem) throw new HttpError("bad-request", problem);
    }
    const access = await requireDocumentAction(context.db, docId, accountId, "comment");
    if (access.kind !== "pdf") throw new HttpError("bad-request", "Only PDFs have sidecars.");
    return context.rooms.batch(docId, async (batch) => {
      const current = await requireDocumentAction(context.db, docId, accountId, "comment");
      if (body.hash && batch.docs.annotations.getMap(PdfKeys.imports).has(body.hash)) return { serverSeq: batch.serverSeq() };
      const fence = { projectId: current.projectId, role: current.role };
      const actor = { kind: "system", reason: "import", onBehalfOf: accountId } as const;
      await batch.transact("annotations", actor, { source: "import" }, (doc) => {
        const marks = doc.getMap<Y.Map<unknown>>(PdfKeys.marks);
        if (new Set([...marks.keys(), ...fields.map((value) => String(value.id))]).size > PdfLimits.maxMarks) throw new HttpError("too-large", "This PDF holds too many marks.");
        for (const value of fields) {
          const id = String(value.id);
          if (marks.has(id)) continue;
          const mark = new Y.Map<unknown>();
          for (const [field, data] of Object.entries(value)) mark.set(field, field === "text" ? new Y.Text(String(data)) : data);
          marks.set(id, mark);
        }
        const anchors = doc.getMap(PdfKeys.anchors);
        for (const local of body.comments) {
          const id = stableId("anc", `${docId}:${local.id}`);
          if (!anchors.has(id)) anchors.set(id, { ...local.anchor, id, createdBy: accountId, createdAt: Date.now() });
        }
      }, fence);
      // Import ids belong to the sidecar, across accounts. Ordinary thread
      // commands retain their author-bound idempotency checks.
      for (const local of body.comments) {
        const threadId = stableId("thr", `${docId}:${local.id}`);
        const existing = await context.db.selectFrom("threads").select("deleted_at").where("id", "=", threadId).executeTakeFirst();
        if (existing?.deleted_at) continue;
        if (!existing) {
          await createThread(context, accountId, docId, { id: threadId, anchorId: stableId("anc", `${docId}:${local.id}`), quote: local.anchor.quote, body: local.messages[0].text });
        }
        for (const reply of local.messages.slice(1)) {
          const id = stableId("msg", `${threadId}:${reply.id}`);
          const seen = await context.db.selectFrom("messages").select("id").where("id", "=", id).executeTakeFirst();
          if (!seen) await addMessage(context, accountId, threadId, { id, body: reply.text });
        }
        if (!existing && local.status === "resolved") await setThreadStatus(context, accountId, threadId, { status: "resolved" });
      }
      if (body.hash) await batch.transact("annotations", actor, { source: "import" }, (doc) => {
        doc.getMap(PdfKeys.imports).set(body.hash!, { by: accountId, at: new Date().toISOString() });
      }, fence);
      return { serverSeq: batch.serverSeq() };
    });
  });
}
