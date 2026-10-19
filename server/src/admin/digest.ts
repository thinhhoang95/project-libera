// GET /v1/documents/:docId/digest: the server side of the hourly divergence
// check (source plan §11). The contract is DocumentDigest in api.ts.

import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { z } from "zod";

import { encodeBase64, pathId, requireAccount, route } from "../api/common.js";
import { requireDocumentAction } from "../auth/access.js";
import type { ServerContext } from "../context.js";
import { HttpError } from "../http/errors.js";
import { sha256Hex } from "../ids.js";
import {
  ApiRoutes,
  canonicalJson,
  ContentKeys,
  ManifestKeys,
  type DocumentDigest,
  type Subdoc,
} from "../protocol.js";
import { loadDocument, type DocumentKind } from "../sync/store.js";

/** The hashed content of a document (see DocumentDigest.contentSha256). */
export function digestContent(kind: DocumentKind, docs: ReadonlyMap<Subdoc, Y.Doc> | Record<string, Y.Doc>): string {
  const get = (subdoc: Subdoc): Y.Doc | undefined =>
    docs instanceof Map ? docs.get(subdoc) : (docs as Record<string, Y.Doc>)[subdoc];
  if (kind === "manifest") {
    const manifest = get("manifest");
    return sha256Hex(canonicalJson(manifest ? manifest.getMap(ManifestKeys.files).toJSON() : {}));
  }
  const content = get("content");
  return sha256Hex(content ? content.getText(ContentKeys.source).toString() : "");
}

export function computeDigest(
  docId: string,
  kind: DocumentKind,
  serverSeq: number,
  docs: ReadonlyMap<Subdoc, Y.Doc> | Record<string, Y.Doc>,
): DocumentDigest {
  const stateVectors: Partial<Record<Subdoc, string>> = {};
  const entries = docs instanceof Map ? [...docs.entries()] : Object.entries(docs);
  for (const [subdoc, doc] of entries) stateVectors[subdoc as Subdoc] = encodeBase64(Y.encodeStateVector(doc));
  return { docId, kind, serverSeq, contentSha256: digestContent(kind, docs), stateVectors };
}

/**
 * The digest of what clients sync against: the live room when the document
 * is loaded (it is the same state as the log, plus nothing unpersisted), the
 * database otherwise. Reading the database does not load a room.
 */
export async function documentDigest(context: ServerContext, docId: string, kind: DocumentKind): Promise<DocumentDigest> {
  if (context.rooms.isLoaded(docId)) {
    return context.rooms.withDocs(docId, (docs, serverSeq) => computeDigest(docId, kind, serverSeq, docs));
  }
  const loaded = await loadDocument(context.db, docId);
  if (!loaded) throw new HttpError("not-found", "Document not found.");
  try {
    return computeDigest(docId, loaded.kind, loaded.serverSeq, loaded.docs);
  } finally {
    for (const doc of loaded.docs.values()) doc.destroy();
  }
}

const params = z.object({ docId: pathId });

export function registerDigestRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get(route(ApiRoutes.documentDigest, "docId"), async (request): Promise<DocumentDigest> => {
    const { accountId } = await requireAccount(context, request);
    const { docId } = params.parse(request.params);
    const access = await requireDocumentAction(context.db, docId, accountId, "read");
    return documentDigest(context, docId, access.kind);
  });
}
