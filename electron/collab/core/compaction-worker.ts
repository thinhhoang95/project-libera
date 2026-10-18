// Snapshot merging, run in a worker thread so that rebuilding and encoding a
// large document never blocks the host's event loop.
//
// The host bundle is a single file, so the worker loads that same file: the
// check at the bottom turns this module into the worker's main when it is
// loaded with the marker in workerData. Under tsx (tests) the worker loads
// this .ts file through a tsx bootstrap (see compaction.ts).

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import * as Y from "yjs";

export const COMPACTION_WORKER_FILE: string = __filename;
export const COMPACTION_WORKER_MARK = "libera-collab-compaction";

export interface MergeRequest {
  id: number;
  base: Uint8Array | null;
  updates: Uint8Array[];
}

export type MergeResponse =
  | { id: number; ok: true; state: Uint8Array; stateVector: Uint8Array; ms: number }
  | { id: number; ok: false; error: string };

/** Rebuilds a sub-document from a snapshot plus updates and encodes its state (garbage-collected). */
export function mergeState(base: Uint8Array | null, updates: readonly Uint8Array[]): { state: Uint8Array; stateVector: Uint8Array } {
  const doc = new Y.Doc();
  try {
    if (base) Y.applyUpdate(doc, base);
    for (const update of updates) Y.applyUpdate(doc, update);
    return { state: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  } finally {
    doc.destroy();
  }
}

function runWorker(): void {
  const port = parentPort;
  if (!port) return;
  port.on("message", (request: MergeRequest) => {
    const started = performance.now();
    try {
      const { state, stateVector } = mergeState(request.base, request.updates);
      const response: MergeResponse = { id: request.id, ok: true, state, stateVector, ms: performance.now() - started };
      port.postMessage(response, [state.buffer as ArrayBuffer, stateVector.buffer as ArrayBuffer]);
    } catch (error) {
      const response: MergeResponse = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
      port.postMessage(response);
    }
  });
}

if (!isMainThread && (workerData as { mark?: unknown } | null)?.mark === COMPACTION_WORKER_MARK) runWorker();
