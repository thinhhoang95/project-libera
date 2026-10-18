// WebSocket sync service. PLACEHOLDER: replaced by the sync implementation
// (M1.1). It exists so the server builds before sync lands.

import type { Server } from "node:http";

import type { RoomService, ServerContext } from "../context.js";

export interface SyncService {
  rooms: RoomService;
  /** Handles HTTP upgrades on /sync for this server. */
  attach(server: Server): void;
  /** Number of open sockets (metrics, tests). */
  connectionCount(): number;
  close(): Promise<void>;
}

function notImplemented(): never {
  throw new Error("Sync service is not implemented yet.");
}

export function createSyncService(_context: ServerContext): SyncService {
  return {
    rooms: {
      transact: notImplemented,
      withDocs: notImplemented,
      currentServerSeq: notImplemented,
      membershipChanged: () => {},
      documentDeleted: () => {},
      accountRevoked: () => {},
    },
    attach: () => {},
    connectionCount: () => 0,
    close: async () => {},
  };
}
