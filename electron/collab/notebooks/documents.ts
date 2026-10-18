// Creating shared documents and blobs on the server from local files.

import * as Y from "yjs";

import type { CreateDocumentRequest } from "../../../src/lib/collab/protocol/api";
import { ContentKeys, MetaKeys, docKindForPath, type DocKind } from "../../../src/lib/collab/protocol/schema";
import { DOC_SCHEMA_VERSION, SyncLimits } from "../../../src/lib/collab/protocol/version";
import type { ApiClient } from "../core/api-client";
import { decodeText } from "./fs-ops";

/**
 * Text files larger than this are shared as blobs: the import sends a
 * document's whole text as one update, and the server caps updates (base64
 * adds a third on the wire).
 */
export const MAX_DOC_TEXT_BYTES = Math.floor(SyncLimits.maxUpdateBytes * 0.7);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export function mimeForPath(relative: string): string {
  const match = /\.[^./]+$/.exec(relative.toLowerCase());
  return (match && MIME_TYPES[match[0]]) || "application/octet-stream";
}

/** How a file is shared: as a document with its exact text, or as a blob. */
export function classifyFile(relative: string, bytes: Uint8Array): { kind: "doc"; docKind: DocKind; text: string } | { kind: "blob" } {
  const docKind = docKindForPath(relative);
  if (!docKind || bytes.byteLength > MAX_DOC_TEXT_BYTES) return { kind: "blob" };
  const text = decodeText(bytes);
  return text === null ? { kind: "blob" } : { kind: "doc", docKind, text };
}

function encode(doc: Y.Doc): string {
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

/** The import's initial state: exact text, empty annotations, and DocMeta. */
export function initialUpdates(text: string, fileId: string, docKind: DocKind): NonNullable<CreateDocumentRequest["initial"]> {
  const content = new Y.Doc();
  if (text) content.getText(ContentKeys.source).insert(0, text);
  const annotations = new Y.Doc();
  const meta = new Y.Doc();
  const map = meta.getMap<unknown>(MetaKeys.meta);
  meta.transact(() => {
    map.set("schemaVersion", DOC_SCHEMA_VERSION);
    map.set("kind", docKind);
    map.set("fileId", fileId);
  });
  const result = { content: encode(content), annotations: encode(annotations), meta: encode(meta) };
  content.destroy();
  annotations.destroy();
  meta.destroy();
  return result;
}

/**
 * Creates the document with client-chosen ids. The server answers a replay of
 * the same create with the original, so a retried share or create is safe.
 */
export async function createSharedDocument(
  api: ApiClient,
  projectId: string,
  ids: { docId: string; fileId: string },
  docKind: DocKind,
  text: string,
): Promise<void> {
  await api.createDocument(projectId, {
    docId: ids.docId,
    fileId: ids.fileId,
    kind: docKind,
    initial: initialUpdates(text, ids.fileId, docKind),
  });
}
