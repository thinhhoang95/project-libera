// Services shared by the HTTP API and the sync service.

import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import type { Registry } from "prom-client";
import type * as Y from "yjs";

import type { Config } from "./config.js";
import type { Database } from "./db/database.js";
import type { DB } from "./db/types.js";
import type { EventBus } from "./events.js";
import type { Actor, Provenance, Role, Subdoc } from "./protocol.js";

/**
 * Server-side access to live documents. Implemented by the sync service
 * (src/sync/). Every change made through it is persisted to doc_updates with
 * its actor before it is broadcast, exactly like a client update.
 */
export interface RoomService {
  /**
   * Runs `change` against the live sub-document inside the room's write lock,
   * persists the resulting update (if any) with `actor`, then broadcasts it.
   * Returns the new serverSeq, or the current one when nothing changed.
   * `change` may throw to abort; nothing is persisted then. It runs on an
   * exact copy of the live sub-document, so an aborted change also leaves
   * the live state untouched. The update is broadcast as `remote` to every
   * socket with the document open, with empty userId and clientId.
   */
  transact<T>(
    docId: string,
    subdoc: Subdoc,
    actor: Actor,
    provenance: Provenance,
    change: (doc: Y.Doc) => T | Promise<T>,
  ): Promise<{ serverSeq: number; result: T }>;

  /**
   * Runs `read` against the current state of several sub-documents of one
   * document inside the room's write lock, so no update interleaves. Used by
   * decisions, which read annotations and content together. `docs` holds
   * only the sub-documents of the document's kind (just `manifest` for a
   * manifest). The documents are live: read them, do not change them (use
   * transact to change).
   */
  withDocs<T>(docId: string, read: (docs: Record<Subdoc, Y.Doc>, serverSeq: number) => T | Promise<T>): Promise<T>;

  /** Highest persisted serverSeq for a document (from the room if loaded). */
  currentServerSeq(docId: string): Promise<number>;

  /** A membership changed (role is null when removed). Closes or re-scopes open sessions. */
  membershipChanged(projectId: string, accountId: string, role: Role | null): void;

  /** The document was deleted. Closes it for every client and unloads the room. */
  documentDeleted(docId: string): void;

  /** The account's sessions must end (logout everywhere, disabled account). */
  accountRevoked(accountId: string, familyId?: string): void;
}

export interface ServerContext {
  config: Config;
  database: Database;
  db: Kysely<DB>;
  log: FastifyBaseLogger;
  events: EventBus;
  metrics: Registry;
  /** Set by the sync service when it starts. */
  rooms: RoomService;
}
