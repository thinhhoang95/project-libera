// WebSocket sync service (implementation plan M1.1, source plan §4).
//
// One socket per client carries many documents. Each document is a room that
// serializes its writes; an update is acknowledged only after its row in
// doc_updates has committed, then applied to the room and sent to the other
// sockets. See server.ts for the pipeline and room.ts for a room.

import type { Server } from "node:http";

import type { RoomService, ServerContext } from "../context.js";
import { SyncServer } from "./server.js";

export { SyncTimings } from "./timings.js";
export { loadSubdocState, subdocsForKind } from "./store.js";

export interface SyncService {
  rooms: RoomService;
  /** Handles HTTP upgrades on /sync for this server. */
  attach(server: Server): void;
  /** Number of open sockets (metrics, tests). */
  connectionCount(): number;
  /** Number of documents loaded in memory (metrics, tests). */
  roomCount(): number;
  close(): Promise<void>;
}

export function createSyncService(context: ServerContext): SyncService {
  return new SyncServer(context);
}
