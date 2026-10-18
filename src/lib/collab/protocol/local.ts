// Messages between a renderer replica and the collab host's DocHub, sent over
// a MessagePort (structured clone, so Uint8Arrays transfer as-is).
//
// attach → the hub replies with `state` for each sub-document (everything the
// replica lacks), then `meta` and `status`. After that both sides send
// `update`s; the hub persists replica updates to SQLite before it echoes
// `status` with state "saved-local".

import type { Provenance } from "./actor";
import type { Role, Subdoc } from "./roles";

export type SyncState =
  /** The hub is loading the document from SQLite or the server. */
  | "loading"
  /** Every local edit is in SQLite; the server has not acknowledged all of them. */
  | "saved-local"
  /** Connected, N updates awaiting server ack. */
  | "syncing"
  /** Everything acknowledged by the server. */
  | "saved-remote"
  /** Not connected; edits are safe locally. */
  | "offline"
  /** The document's schema is newer than this client. */
  | "read-only"
  /** Access was revoked or reduced; local work is preserved. */
  | "access-changed";

export interface SyncStatus {
  state: SyncState;
  /** Local updates not yet acknowledged by the server. */
  pending: number;
  /** Age of the oldest unacknowledged update, in milliseconds (0 when none). */
  oldestPendingAgeMs: number;
  lastAckAt: number | null;
  connected: boolean;
  /** Human-readable detail for the status tooltip. */
  detail?: string;
}

export interface DocMetaState {
  docId: string;
  projectId: string;
  role: Role;
  schemaVersion: number;
  readOnly: boolean;
  readOnlyReason?: "schema-newer" | "role" | "access-revoked";
}

export type ReplicaToHub =
  | { t: "attach"; docId: string; stateVectors: Partial<Record<Subdoc, Uint8Array>> }
  | { t: "update"; docId: string; subdoc: Subdoc; update: Uint8Array; provenance?: Provenance }
  | { t: "awareness"; docId: string; update: Uint8Array }
  | { t: "detach"; docId: string };

export type HubToReplica =
  | { t: "state"; docId: string; subdoc: Subdoc; update: Uint8Array }
  | { t: "update"; docId: string; subdoc: Subdoc; update: Uint8Array; origin: "remote" | "local" | "server" }
  | { t: "awareness"; docId: string; update: Uint8Array }
  | { t: "meta"; docId: string; meta: DocMetaState }
  | { t: "status"; docId: string; status: SyncStatus }
  | { t: "rejected"; docId: string; subdoc: Subdoc; reason: string; rejectedText?: string }
  | { t: "closed"; docId: string; reason: string }
  | { t: "error"; docId: string; message: string };

/** Origins used for Yjs transactions so bindings can tell edits apart. */
export const ReplicaOrigin = {
  /** Applied from the hub; never sent back. */
  hub: "libera-collab:hub",
} as const;
