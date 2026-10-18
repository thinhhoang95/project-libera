// Sync protocol messages (source plan §4, collaboration map §7.1).
//
// One WebSocket per client and server carries many documents. Every frame is
// binary: a message-type byte followed by fields in the order listed in
// encodeMessage. Yjs updates and state vectors travel as raw bytes.
//
// Connection:  client → hello · server → welcome (or close 4001/4026)
// Per doc:     client → open{stateVectors} · server → opened{diffs, role}
//              client → update{clientSeq} · server → ack | reject
//              server → remote (other clients' updates, already persisted)
//              either → awareness (ephemeral, never persisted)
//              client → close · server → closed (also sent on revocation)
// Out of band: server → event (thread, manifest, role and decision events)

import type { Provenance } from "./actor";
import { CodecError, Reader, Writer } from "./codec";
import type { Role, Subdoc } from "./roles";
import { isRole, isSubdoc } from "./roles";

export const MessageType = {
  Hello: 1,
  Welcome: 2,
  Open: 3,
  Opened: 4,
  Update: 5,
  Ack: 6,
  Reject: 7,
  Remote: 8,
  Awareness: 9,
  Close: 10,
  Closed: 11,
  Event: 12,
  RefreshToken: 13,
  Ping: 14,
  Pong: 15,
  Error: 16,
} as const;

export type RejectReason =
  | "forbidden"
  | "invalid-update"
  | "too-large"
  | "schema-newer"
  | "not-open"
  | "rate-limited"
  | "annotation-ownership";

export type ClosedReason = "client-closed" | "access-revoked" | "document-deleted" | "not-found" | "forbidden";

export type ErrorCode = "bad-message" | "unknown-type" | "internal" | "not-authenticated";

export interface HelloMessage {
  type: typeof MessageType.Hello;
  protocolVersion: number;
  appVersion: string;
  token: string;
  /** Stable id of this installation + account (not the Yjs clientID). */
  clientId: string;
}

export interface WelcomeMessage {
  type: typeof MessageType.Welcome;
  protocolVersion: number;
  minProtocolVersion: number;
  userId: string;
  serverTime: number;
}

export interface SubdocStateVector {
  subdoc: Subdoc;
  stateVector: Uint8Array;
}

export interface OpenMessage {
  type: typeof MessageType.Open;
  docId: string;
  subdocs: SubdocStateVector[];
}

export interface OpenedSubdoc {
  subdoc: Subdoc;
  /** Everything the client is missing, computed from its state vector. */
  diff: Uint8Array;
  /** The server's state vector, so the client can send what the server lacks. */
  stateVector: Uint8Array;
}

export interface OpenedMessage {
  type: typeof MessageType.Opened;
  docId: string;
  projectId: string;
  role: Role;
  schemaVersion: number;
  /** Highest serverSeq persisted for this document. */
  serverSeq: number;
  subdocs: OpenedSubdoc[];
}

export interface UpdateMessage {
  type: typeof MessageType.Update;
  docId: string;
  subdoc: Subdoc;
  /** Per (docId, clientId), strictly increasing; the server dedupes on it. */
  clientSeq: number;
  update: Uint8Array;
  provenance?: Provenance;
}

export interface AckMessage {
  type: typeof MessageType.Ack;
  docId: string;
  subdoc: Subdoc;
  clientSeq: number;
  serverSeq: number;
}

export interface RejectMessage {
  type: typeof MessageType.Reject;
  docId: string;
  subdoc: Subdoc;
  clientSeq: number;
  reason: RejectReason;
  message: string;
}

export interface RemoteMessage {
  type: typeof MessageType.Remote;
  docId: string;
  subdoc: Subdoc;
  serverSeq: number;
  update: Uint8Array;
  /** Account and client that produced the update ("" for server-applied updates). */
  userId: string;
  clientId: string;
  provenance?: Provenance;
}

export interface AwarenessMessage {
  type: typeof MessageType.Awareness;
  docId: string;
  /** y-protocols awareness update bytes. */
  update: Uint8Array;
}

export interface CloseMessage {
  type: typeof MessageType.Close;
  docId: string;
}

export interface ClosedMessage {
  type: typeof MessageType.Closed;
  docId: string;
  reason: ClosedReason;
}

export type EventScope = "doc" | "project" | "user";

export interface EventMessage {
  type: typeof MessageType.Event;
  scope: EventScope;
  /** docId, projectId or userId depending on scope. */
  id: string;
  kind: string;
  payload: unknown;
}

export interface RefreshTokenMessage {
  type: typeof MessageType.RefreshToken;
  token: string;
}

export interface PingMessage {
  type: typeof MessageType.Ping;
  nonce: number;
}

export interface PongMessage {
  type: typeof MessageType.Pong;
  nonce: number;
}

export interface ErrorMessage {
  type: typeof MessageType.Error;
  code: ErrorCode;
  message: string;
  docId: string;
}

export type ClientMessage =
  | HelloMessage
  | OpenMessage
  | UpdateMessage
  | AwarenessMessage
  | CloseMessage
  | RefreshTokenMessage
  | PingMessage;

export type ServerMessage =
  | WelcomeMessage
  | OpenedMessage
  | AckMessage
  | RejectMessage
  | RemoteMessage
  | AwarenessMessage
  | ClosedMessage
  | EventMessage
  | PongMessage
  | ErrorMessage;

export type SyncMessage = ClientMessage | ServerMessage;

const REJECT_REASONS: readonly RejectReason[] = [
  "forbidden",
  "invalid-update",
  "too-large",
  "schema-newer",
  "not-open",
  "rate-limited",
  "annotation-ownership",
];
const CLOSED_REASONS: readonly ClosedReason[] = [
  "client-closed",
  "access-revoked",
  "document-deleted",
  "not-found",
  "forbidden",
];
const ERROR_CODES: readonly ErrorCode[] = ["bad-message", "unknown-type", "internal", "not-authenticated"];
const EVENT_SCOPES: readonly EventScope[] = ["doc", "project", "user"];

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new CodecError(`Invalid ${label}: ${value}`);
  return value as T;
}

function readSubdoc(reader: Reader): Subdoc {
  const value = reader.string();
  if (!isSubdoc(value)) throw new CodecError(`Invalid subdoc: ${value}`);
  return value;
}

export function encodeMessage(message: SyncMessage): Uint8Array {
  const writer = new Writer().uint8(message.type);
  switch (message.type) {
    case MessageType.Hello:
      writer.varUint(message.protocolVersion).string(message.appVersion).string(message.token).string(message.clientId);
      break;
    case MessageType.Welcome:
      writer
        .varUint(message.protocolVersion)
        .varUint(message.minProtocolVersion)
        .string(message.userId)
        .varUint(message.serverTime);
      break;
    case MessageType.Open:
      writer.string(message.docId).varUint(message.subdocs.length);
      for (const entry of message.subdocs) writer.string(entry.subdoc).bytes(entry.stateVector);
      break;
    case MessageType.Opened:
      writer
        .string(message.docId)
        .string(message.projectId)
        .string(message.role)
        .varUint(message.schemaVersion)
        .varUint(message.serverSeq)
        .varUint(message.subdocs.length);
      for (const entry of message.subdocs) writer.string(entry.subdoc).bytes(entry.diff).bytes(entry.stateVector);
      break;
    case MessageType.Update:
      writer
        .string(message.docId)
        .string(message.subdoc)
        .varUint(message.clientSeq)
        .bytes(message.update)
        .json(message.provenance);
      break;
    case MessageType.Ack:
      writer.string(message.docId).string(message.subdoc).varUint(message.clientSeq).varUint(message.serverSeq);
      break;
    case MessageType.Reject:
      writer
        .string(message.docId)
        .string(message.subdoc)
        .varUint(message.clientSeq)
        .string(message.reason)
        .string(message.message);
      break;
    case MessageType.Remote:
      writer
        .string(message.docId)
        .string(message.subdoc)
        .varUint(message.serverSeq)
        .bytes(message.update)
        .string(message.userId)
        .string(message.clientId)
        .json(message.provenance);
      break;
    case MessageType.Awareness:
      writer.string(message.docId).bytes(message.update);
      break;
    case MessageType.Close:
      writer.string(message.docId);
      break;
    case MessageType.Closed:
      writer.string(message.docId).string(message.reason);
      break;
    case MessageType.Event:
      writer.string(message.scope).string(message.id).string(message.kind).json(message.payload);
      break;
    case MessageType.RefreshToken:
      writer.string(message.token);
      break;
    case MessageType.Ping:
    case MessageType.Pong:
      writer.varUint(message.nonce);
      break;
    case MessageType.Error:
      writer.string(message.code).string(message.message).string(message.docId);
      break;
    default: {
      const unknown: never = message;
      throw new CodecError(`Unknown message ${(unknown as { type: number }).type}`);
    }
  }
  return writer.finish();
}

export function decodeMessage(data: Uint8Array): SyncMessage {
  const reader = new Reader(data);
  const type = reader.uint8();
  let message: SyncMessage;
  switch (type) {
    case MessageType.Hello:
      message = {
        type,
        protocolVersion: reader.varUint(),
        appVersion: reader.string(),
        token: reader.string(),
        clientId: reader.string(),
      };
      break;
    case MessageType.Welcome:
      message = {
        type,
        protocolVersion: reader.varUint(),
        minProtocolVersion: reader.varUint(),
        userId: reader.string(),
        serverTime: reader.varUint(),
      };
      break;
    case MessageType.Open: {
      const docId = reader.string();
      const count = reader.varUint();
      const subdocs: SubdocStateVector[] = [];
      for (let index = 0; index < count; index += 1) {
        subdocs.push({ subdoc: readSubdoc(reader), stateVector: reader.bytes() });
      }
      message = { type, docId, subdocs };
      break;
    }
    case MessageType.Opened: {
      const docId = reader.string();
      const projectId = reader.string();
      const role = reader.string();
      if (!isRole(role)) throw new CodecError(`Invalid role: ${role}`);
      const schemaVersion = reader.varUint();
      const serverSeq = reader.varUint();
      const count = reader.varUint();
      const subdocs: OpenedSubdoc[] = [];
      for (let index = 0; index < count; index += 1) {
        subdocs.push({ subdoc: readSubdoc(reader), diff: reader.bytes(), stateVector: reader.bytes() });
      }
      message = { type, docId, projectId, role, schemaVersion, serverSeq, subdocs };
      break;
    }
    case MessageType.Update:
      message = {
        type,
        docId: reader.string(),
        subdoc: readSubdoc(reader),
        clientSeq: reader.varUint(),
        update: reader.bytes(),
        provenance: reader.json<Provenance>(),
      };
      break;
    case MessageType.Ack:
      message = {
        type,
        docId: reader.string(),
        subdoc: readSubdoc(reader),
        clientSeq: reader.varUint(),
        serverSeq: reader.varUint(),
      };
      break;
    case MessageType.Reject:
      message = {
        type,
        docId: reader.string(),
        subdoc: readSubdoc(reader),
        clientSeq: reader.varUint(),
        reason: oneOf(reader.string(), REJECT_REASONS, "reject reason"),
        message: reader.string(),
      };
      break;
    case MessageType.Remote:
      message = {
        type,
        docId: reader.string(),
        subdoc: readSubdoc(reader),
        serverSeq: reader.varUint(),
        update: reader.bytes(),
        userId: reader.string(),
        clientId: reader.string(),
        provenance: reader.json<Provenance>(),
      };
      break;
    case MessageType.Awareness:
      message = { type, docId: reader.string(), update: reader.bytes() };
      break;
    case MessageType.Close:
      message = { type, docId: reader.string() };
      break;
    case MessageType.Closed:
      message = { type, docId: reader.string(), reason: oneOf(reader.string(), CLOSED_REASONS, "closed reason") };
      break;
    case MessageType.Event:
      message = {
        type,
        scope: oneOf(reader.string(), EVENT_SCOPES, "event scope"),
        id: reader.string(),
        kind: reader.string(),
        payload: reader.json<unknown>(),
      };
      break;
    case MessageType.RefreshToken:
      message = { type, token: reader.string() };
      break;
    case MessageType.Ping:
    case MessageType.Pong:
      message = { type, nonce: reader.varUint() };
      break;
    case MessageType.Error:
      message = {
        type,
        code: oneOf(reader.string(), ERROR_CODES, "error code"),
        message: reader.string(),
        docId: reader.string(),
      };
      break;
    default:
      throw new CodecError(`Unknown message type ${type}`);
  }
  if (!reader.done) throw new CodecError("Trailing bytes after message");
  if ("provenance" in message && message.provenance === undefined) delete message.provenance;
  return message;
}

/** Event kinds sent in EventMessage.kind. Payload shapes are in api.ts. */
export const EventKind = {
  ThreadChanged: "thread.changed",
  ThreadDeleted: "thread.deleted",
  SuggestionDecided: "suggestion.decided",
  ReviewChanged: "review.changed",
  RevisionCreated: "revision.created",
  RoleChanged: "member.role-changed",
  MemberRemoved: "member.removed",
  ProjectDeleted: "project.deleted",
  Notification: "notification.created",
} as const;
