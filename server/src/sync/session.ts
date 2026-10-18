// One authenticated WebSocket. Frames are handled in arrival order: a client
// may send `open` and then updates for that doc without waiting for `opened`.
// Updates are only queued on their room here, so a slow write never holds up
// pings or other documents on the same socket.

import type { RawData, WebSocket } from "ws";
import * as Y from "yjs";

import { minProtocolVersion } from "../api/system.js";
import { documentAccess } from "../auth/access.js";
import { TokenError, verifyAccessToken } from "../auth/tokens.js";
import { isClientId } from "../ids.js";
import {
  CloseCode,
  decodeMessage,
  encodeMessage,
  MessageType,
  PROTOCOL_VERSION,
  type AwarenessMessage,
  type ClosedReason,
  type ErrorCode,
  type HelloMessage,
  type OpenMessage,
  type RefreshTokenMessage,
  type RejectReason,
  type Role,
  type ServerMessage,
  type UpdateMessage,
} from "../protocol.js";
import { DocumentMissingError, type Room, type RoomMember } from "./room.js";
import type { SyncServer } from "./server.js";
import { SyncTimings } from "./timings.js";

/** A document open on this socket. `role` is updated in place by membershipChanged. */
export interface OpenDoc {
  room: Room;
  projectId: string;
  role: Role;
}

const MAX_BAD_FRAMES = 10;
const MAX_TIMER_MS = 2 ** 31 - 1;

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export class Session implements RoomMember {
  authenticated = false;
  closed = false;
  accountId = "";
  familyId = "";
  clientId = "";
  tokenExpiresAt = 0;
  lastFrameAt = Date.now();
  readonly docs = new Map<string, OpenDoc>();
  /** Open documents per project, for project-scoped events. */
  readonly projectDocs = new Map<string, number>();

  private badFrames = 0;
  private chain: Promise<void> = Promise.resolve();
  private helloTimer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly server: SyncServer,
    readonly ws: WebSocket,
    readonly ip: string,
  ) {
    this.helloTimer = setTimeout(() => this.close(CloseCode.ProtocolError, "Expected hello"), SyncTimings.helloTimeoutMs);
    ws.on("message", (data, isBinary) => {
      this.lastFrameAt = Date.now();
      this.chain = this.chain
        .then(() => this.handle(data, isBinary))
        .catch((error: unknown) => {
          this.server.context.log.error({ err: error }, "Sync frame handling failed");
          this.sendError("internal", "Internal error.");
        });
    });
    ws.on("close", () => this.cleanup());
    ws.on("error", (error) => {
      this.server.context.log.debug({ err: error }, "Sync socket error");
    });
  }

  send(message: ServerMessage): void {
    this.sendFrame(encodeMessage(message));
  }

  sendFrame(frame: Uint8Array): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(frame);
  }

  sendError(code: ErrorCode, message: string, docId = ""): void {
    this.send({ type: MessageType.Error, code, message, docId });
  }

  sendReject(update: UpdateMessage, reason: RejectReason, message: string): void {
    this.server.metrics.rejects.inc({ reason });
    this.send({
      type: MessageType.Reject,
      docId: update.docId,
      subdoc: update.subdoc,
      clientSeq: update.clientSeq,
      reason,
      message,
    });
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.cleanup();
    this.ws.close(code, reason);
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.expiryTimer);
    for (const docId of [...this.docs.keys()]) this.closeDoc(docId, null);
    this.server.forgetSession(this);
  }

  private badFrame(message: string): void {
    this.badFrames += 1;
    this.sendError("bad-message", message);
    if (this.badFrames >= MAX_BAD_FRAMES) this.close(CloseCode.ProtocolError, "Too many malformed frames");
  }

  private async handle(data: RawData, isBinary: boolean): Promise<void> {
    if (this.closed) return;
    if (!isBinary) {
      if (!this.authenticated) return this.close(CloseCode.ProtocolError, "Expected hello");
      return this.badFrame("Frames must be binary.");
    }
    let message;
    try {
      message = decodeMessage(toBytes(data));
    } catch (error) {
      if (!this.authenticated) return this.close(CloseCode.ProtocolError, "Expected hello");
      return this.badFrame((error as Error).message);
    }
    if (!this.authenticated) {
      if (message.type !== MessageType.Hello) return this.close(CloseCode.ProtocolError, "Expected hello");
      return this.hello(message);
    }
    switch (message.type) {
      case MessageType.Open:
        return this.open(message);
      case MessageType.Update:
        return this.update(message);
      case MessageType.Awareness:
        return this.awareness(message);
      case MessageType.Close:
        this.closeDoc(message.docId, "client-closed");
        return;
      case MessageType.RefreshToken:
        return this.refresh(message);
      case MessageType.Ping:
        this.send({ type: MessageType.Pong, nonce: message.nonce });
        return;
      default:
        return this.badFrame(`Unexpected message type ${message.type}.`);
    }
  }

  /** Verifies a token for this socket; closes the socket and returns null when it is not acceptable. */
  private async verify(token: string): Promise<{ accountId: string; familyId: string; expiresAt: Date } | null> {
    const { context } = this.server;
    let claims;
    try {
      claims = await verifyAccessToken(context.config, token);
    } catch (error) {
      const expired = error instanceof TokenError && error.expired;
      this.close(CloseCode.AuthExpired, expired ? "Access token expired" : "Invalid access token");
      return null;
    }
    const account = await context.db
      .selectFrom("accounts")
      .select(["id", "disabled_at"])
      .where("id", "=", claims.accountId)
      .executeTakeFirst();
    if (!account) {
      this.close(CloseCode.AuthExpired, "Unknown account");
      return null;
    }
    if (account.disabled_at) {
      this.close(CloseCode.AuthRevoked, "Account disabled");
      return null;
    }
    return claims;
  }

  private async hello(message: HelloMessage): Promise<void> {
    const minimum = minProtocolVersion(this.server.context);
    if (message.protocolVersion < minimum) {
      return this.close(CloseCode.ClientTooOld, `Protocol ${message.protocolVersion} is below ${minimum}`);
    }
    // "server" and other short ids are reserved for server-applied updates.
    if (!isClientId(message.clientId)) return this.close(CloseCode.ProtocolError, "Invalid clientId");
    const claims = await this.verify(message.token);
    if (!claims || this.closed) return;
    if (!this.server.admitAccount(claims.accountId)) {
      return this.close(CloseCode.RateLimited, "Too many open connections for this account");
    }
    clearTimeout(this.helloTimer);
    this.authenticated = true;
    this.accountId = claims.accountId;
    this.familyId = claims.familyId;
    this.clientId = message.clientId;
    this.setExpiry(claims.expiresAt);
    this.server.registerSession(this);
    this.send({
      type: MessageType.Welcome,
      protocolVersion: PROTOCOL_VERSION,
      minProtocolVersion: minimum,
      userId: this.accountId,
      serverTime: Date.now(),
    });
  }

  private setExpiry(expiresAt: Date): void {
    clearTimeout(this.expiryTimer);
    this.tokenExpiresAt = expiresAt.getTime();
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, this.tokenExpiresAt + SyncTimings.tokenGraceMs - Date.now()));
    this.expiryTimer = setTimeout(() => this.onExpiry(), delay);
  }

  private onExpiry(): void {
    if (Date.now() < this.tokenExpiresAt + SyncTimings.tokenGraceMs) return this.setExpiry(new Date(this.tokenExpiresAt));
    this.close(CloseCode.AuthExpired, "Access token expired");
  }

  private async refresh(message: RefreshTokenMessage): Promise<void> {
    const claims = await this.verify(message.token);
    if (!claims || this.closed) return;
    if (claims.accountId !== this.accountId) {
      this.sendError("not-authenticated", "A refreshed token must be for the same account.");
      return this.close(CloseCode.AuthExpired, "Token is for another account");
    }
    this.familyId = claims.familyId;
    this.setExpiry(claims.expiresAt);
  }

  private async open(message: OpenMessage): Promise<void> {
    const { docId } = message;
    const access = await documentAccess(this.server.context.db, docId, this.accountId);
    if (this.closed) return;
    if (!access) {
      this.send({ type: MessageType.Closed, docId, reason: "not-found" });
      return;
    }
    const existing = this.docs.get(docId);
    const room = existing?.room ?? this.server.acquireRoom(docId);
    try {
      await room.ready;
    } catch (error) {
      if (!existing) this.server.releaseRoom(room);
      if (error instanceof DocumentMissingError) {
        this.send({ type: MessageType.Closed, docId, reason: "not-found" });
        return;
      }
      throw error;
    }
    // Joining and computing the diff inside the room queue means the socket
    // receives `remote` for exactly the updates after the diff: none are
    // missed and none are sent twice.
    const opened = await room.queue.run(() => {
      if (this.closed || room.disposed) return false;
      if (existing && this.docs.get(docId) !== existing) return false;
      if (existing) {
        existing.role = access.role;
      } else {
        this.docs.set(docId, { room, projectId: access.projectId, role: access.role });
        this.projectDocs.set(access.projectId, (this.projectDocs.get(access.projectId) ?? 0) + 1);
        room.join(this);
      }
      const subdocs = [];
      for (const [subdoc, doc] of room.docs) {
        const stateVector = message.subdocs.find((entry) => entry.subdoc === subdoc)?.stateVector;
        let diff: Uint8Array;
        try {
          diff = stateVector && stateVector.length > 0 ? Y.encodeStateAsUpdate(doc, stateVector) : Y.encodeStateAsUpdate(doc);
        } catch {
          // An unreadable state vector costs a full resend, not the open.
          diff = Y.encodeStateAsUpdate(doc);
        }
        subdocs.push({ subdoc, diff, stateVector: Y.encodeStateVector(doc) });
      }
      this.send({
        type: MessageType.Opened,
        docId,
        projectId: room.projectId,
        role: access.role,
        schemaVersion: room.schemaVersion,
        serverSeq: room.serverSeq,
        subdocs,
      });
      const awareness = room.awarenessSnapshot();
      if (awareness) this.send({ type: MessageType.Awareness, docId, update: awareness });
      return true;
    });
    if (opened || existing) return;
    this.server.releaseRoom(room);
    // documentDeleted ran while this open waited for the room.
    if (room.disposed && !this.closed) this.send({ type: MessageType.Closed, docId, reason: "not-found" });
  }

  private update(message: UpdateMessage): void {
    const open = this.docs.get(message.docId);
    if (!open) return this.sendReject(message, "not-open", "Open the document first.");
    // Not awaited: frames after this one are handled while it waits its turn.
    open.room.queue
      .run(() => this.server.applyClientUpdate(this, open, message))
      .catch((error: unknown) => {
        this.server.context.log.error({ err: error, docId: message.docId }, "Sync update failed");
        // No ack: the client keeps the update queued and resends it after reconnecting.
        this.sendError("internal", "The update could not be saved.", message.docId);
      });
  }

  private awareness(message: AwarenessMessage): void {
    const open = this.docs.get(message.docId);
    if (!open) return this.sendError("bad-message", "Document is not open.", message.docId);
    if (message.update.length > 64 * 1024) return this.badFrame("Awareness update is too large.");
    try {
      open.room.applyAwareness(this, message.update);
    } catch {
      this.badFrame("Awareness update does not decode.");
    }
  }

  /** Stops sending this document to the socket. `reason` null closes silently (socket gone). */
  closeDoc(docId: string, reason: ClosedReason | null): void {
    const open = this.docs.get(docId);
    if (!open) return;
    this.docs.delete(docId);
    const count = (this.projectDocs.get(open.projectId) ?? 1) - 1;
    if (count > 0) this.projectDocs.set(open.projectId, count);
    else this.projectDocs.delete(open.projectId);
    open.room.leave(this);
    this.server.releaseRoom(open.room);
    if (reason) this.send({ type: MessageType.Closed, docId, reason });
  }

  /** Whether the document is still open on this socket with this exact entry. */
  isOpen(docId: string, open: OpenDoc): boolean {
    return !this.closed && this.docs.get(docId) === open;
  }
}
