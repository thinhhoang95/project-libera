// The sync service: WebSocket admission, the room registry, the
// persist-before-ack update pipeline, event forwarding, and RoomService.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";

import type { PersistedUpdate, RoomBatch, RoomService, ServerContext } from "../context.js";
import type { BusEvent } from "../events.js";
import {
  actorAccountId,
  canWriteSubdoc,
  CloseCode,
  encodeMessage,
  EventKind,
  MessageType,
  ManifestKeys,
  SyncLimits,
  type Actor,
  type Provenance,
  type Role,
  type Subdoc,
  type UpdateMessage,
} from "../protocol.js";
import { reportError } from "../observability/reporter.js";
import { createSyncMetrics, type SyncMetrics } from "./metrics.js";
import { InvalidUpdateError, Room, SERVER_ORIGIN } from "./room.js";
import { Session, type OpenDoc } from "./session.js";
import { findPersisted, loadDocument, persistUpdate } from "./store.js";
import { SyncTimings } from "./timings.js";
import { actorForUpdate, annotationViolation, manifestViolation, sanitizeProvenance } from "./validate.js";

const SYNC_PATH = "/sync";
const CLOSE_WAIT_MS = 1000;

function manifestDocIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  for (const value of doc.getMap<unknown>(ManifestKeys.files).values()) {
    if (value && typeof value === "object" && "kind" in value && value.kind === "doc" && "docId" in value && typeof value.docId === "string") ids.add(value.docId);
  }
  return ids;
}

export class SyncServer {
  readonly metrics: SyncMetrics;
  readonly rooms: RoomService;

  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: SyncLimits.maxFrameBytes,
    perMessageDeflate: false,
  });
  private readonly loaded = new Map<string, Room>();
  private readonly sessions = new Set<Session>();
  private readonly byAccount = new Map<string, Set<Session>>();
  private readonly connectionsByIp = new Map<string, number[]>();
  private readonly persistedListeners = new Set<(update: PersistedUpdate) => void>();
  private readonly unsubscribe: () => void;
  private readonly sweepTimer: NodeJS.Timeout;
  private detach: (() => void) | undefined;
  private closing = false;

  constructor(readonly context: ServerContext) {
    this.metrics = createSyncMetrics(context.metrics, {
      rooms: () => this.loaded.size,
      sockets: () => this.sessions.size,
    });
    this.unsubscribe = context.events.subscribe((event) => this.forwardEvent(event));
    this.sweepTimer = setInterval(() => this.sweep(), SyncTimings.sweepIntervalMs);
    this.sweepTimer.unref();
    this.rooms = {
      transact: (docId, subdoc, actor, provenance, change) => this.transact(docId, subdoc, actor, provenance, change),
      withDocs: (docId, read) => this.withDocs(docId, read),
      batch: (docId, task) => this.batch(docId, task),
      onPersisted: (listener) => {
        this.persistedListeners.add(listener);
        return () => this.persistedListeners.delete(listener);
      },
      isLoaded: (docId) => {
        const room = this.loaded.get(docId);
        return room !== undefined && !room.disposed;
      },
      currentServerSeq: (docId) => this.currentServerSeq(docId),
      membershipChanged: (projectId, accountId, role) => this.membershipChanged(projectId, accountId, role),
      documentDeleted: (docId) => this.documentDeleted(docId),
      accountRevoked: (accountId, familyId) => this.accountRevoked(accountId, familyId),
    };
  }

  attach(server: Server): void {
    const listener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path !== SYNC_PATH) {
        // Leave other upgrade paths to other listeners, if there are any.
        if (server.listenerCount("upgrade") === 1) socket.destroy();
        return;
      }
      if (this.closing) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, request));
    };
    server.on("upgrade", listener);
    this.detach = () => server.off("upgrade", listener);
  }

  connectionCount(): number {
    return this.sessions.size;
  }

  roomCount(): number {
    return this.loaded.size;
  }

  private clientIp(request: IncomingMessage): string {
    if (this.context.config.TRUST_PROXY) {
      const forwarded = request.headers["x-forwarded-for"];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return request.socket.remoteAddress ?? "unknown";
  }

  private accept(ws: WebSocket, request: IncomingMessage): void {
    const ip = this.clientIp(request);
    if (!this.admitConnection(ip)) {
      this.metrics.connections.inc({ outcome: "rate-limited" });
      ws.on("error", () => undefined);
      ws.close(CloseCode.RateLimited, "Too many connections");
      return;
    }
    this.metrics.connections.inc({ outcome: "accepted" });
    this.sessions.add(new Session(this, ws, ip));
  }

  /** Sliding one-minute window of new connections per IP (reconnect storms). */
  private admitConnection(ip: string): boolean {
    const now = Date.now();
    const recent = (this.connectionsByIp.get(ip) ?? []).filter((at) => at > now - 60_000);
    const admitted = recent.length < this.context.config.SYNC_CONNECTIONS_PER_MINUTE;
    if (admitted) recent.push(now);
    this.connectionsByIp.set(ip, recent);
    return admitted;
  }

  admitAccount(accountId: string): boolean {
    return (this.byAccount.get(accountId)?.size ?? 0) < this.context.config.SYNC_MAX_SOCKETS_PER_ACCOUNT;
  }

  registerSession(session: Session): void {
    let set = this.byAccount.get(session.accountId);
    if (!set) {
      set = new Set();
      this.byAccount.set(session.accountId, set);
    }
    set.add(session);
  }

  forgetSession(session: Session): void {
    this.sessions.delete(session);
    const set = this.byAccount.get(session.accountId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) this.byAccount.delete(session.accountId);
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessions) {
      if (now - session.lastFrameAt > SyncTimings.silentSocketMs) {
        session.close(CloseCode.GoingAway, "No frames received");
        session.ws.terminate();
      }
    }
    for (const [ip, times] of this.connectionsByIp) {
      if (times.every((at) => at <= now - 60_000)) this.connectionsByIp.delete(ip);
    }
  }

  // Rooms -------------------------------------------------------------------

  /** Returns the document's room, loading it if needed. Pair with releaseRoom. */
  acquireRoom(docId: string): Room {
    let room = this.loaded.get(docId);
    if (!room || room.disposed) {
      const created = new Room(docId, () => loadDocument(this.context.db, docId));
      created.ready.catch(() => this.unloadRoom(created));
      this.loaded.set(docId, created);
      room = created;
    }
    room.refs += 1;
    clearTimeout(room.idleTimer);
    room.idleTimer = undefined;
    return room;
  }

  releaseRoom(room: Room): void {
    if (room.refs > 0) room.refs -= 1;
    if (room.refs > 0 || room.disposed || this.closing) return;
    clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => {
      void room.queue.run(() => {
        if (room.refs === 0) this.unloadRoom(room);
      });
    }, this.context.config.ROOM_IDLE_MS);
    room.idleTimer.unref();
  }

  private unloadRoom(room: Room): void {
    if (this.loaded.get(room.docId) === room) this.loaded.delete(room.docId);
    room.dispose();
  }

  /** Runs `task` on a loaded room, holding a reference so it is not unloaded meanwhile. */
  private async withRoom<T>(docId: string, task: (room: Room) => Promise<T>): Promise<T> {
    const room = this.acquireRoom(docId);
    try {
      await room.ready;
      return await task(room);
    } finally {
      this.releaseRoom(room);
    }
  }

  // Updates -----------------------------------------------------------------

  /** Runs inside the room queue. Persist, then apply, then ack, then fan out. */
  async applyClientUpdate(session: Session, open: OpenDoc, message: UpdateMessage): Promise<void> {
    const { room } = open;
    const { docId, subdoc, clientSeq, update } = message;
    if (!session.isOpen(docId, open) || room.disposed) {
      return session.sendReject(message, "not-open", "The document is not open.");
    }
    if (!room.hasSubdoc(subdoc)) {
      return session.sendReject(message, "invalid-update", `A ${room.kind} document has no ${subdoc} sub-document.`);
    }
    if (update.length > SyncLimits.maxUpdateBytes) {
      return session.sendReject(message, "too-large", `Updates are limited to ${SyncLimits.maxUpdateBytes} bytes.`);
    }
    if (!canWriteSubdoc(open.role, subdoc)) {
      return session.sendReject(message, "forbidden", `Your role (${open.role}) cannot change ${subdoc}.`);
    }

    const existing = await findPersisted(this.context.db, docId, session.clientId, clientSeq);
    if (existing) {
      if (existing.accountId !== session.accountId || existing.subdoc !== subdoc) {
        return session.sendReject(message, "invalid-update", "This clientSeq was already used for another update.");
      }
      // A resend after a lost ack: the update is already applied and was fanned out then.
      this.metrics.updates.inc({ subdoc, source: "duplicate" });
      session.send({ type: MessageType.Ack, docId, subdoc, clientSeq, serverSeq: existing.serverSeq });
      return;
    }

    let changed;
    try {
      changed = room.probe(subdoc, update);
    } catch (error) {
      if (error instanceof InvalidUpdateError) return session.sendReject(message, "invalid-update", error.message);
      throw error;
    }
    if (subdoc === "annotations") {
      const violation = annotationViolation(room.live(subdoc), room.shadow(subdoc), changed, open.role, session.accountId);
      if (violation) {
        room.discardShadow(subdoc);
        return session.sendReject(message, "annotation-ownership", violation);
      }
    } else if (subdoc === "manifest") {
      const violation = manifestViolation(room.shadow(subdoc), changed);
      if (violation) {
        room.discardShadow(subdoc);
        return session.sendReject(message, "invalid-update", violation);
      }
      // A stale offline rename must not resurrect a document already deleted by another member.
      const previous = manifestDocIds(room.live(subdoc));
      const added = [...manifestDocIds(room.shadow(subdoc))].filter((id) => !previous.has(id));
      if (added.length) {
        const deleted = await this.context.db.selectFrom("documents").select("id")
          .where("project_id", "=", room.projectId).where("id", "in", added)
          .where("deleted_at", "is not", null).executeTakeFirst().catch((error: unknown) => {
            room.discardShadow(subdoc);
            throw error;
          });
        if (deleted) {
          room.discardShadow(subdoc);
          return session.sendReject(message, "invalid-update", "A deleted document cannot be added back. Create a new file to restore its text.");
        }
      }
    }

    const provenance = sanitizeProvenance(message.provenance);
    const serverSeq = await this.persist(room, subdoc, {
      accountId: session.accountId,
      clientId: session.clientId,
      clientSeq,
      actor: actorForUpdate(session.accountId, session.clientId, provenance),
      provenance,
      update,
    });
    if (serverSeq === null) return session.sendReject(message, "not-open", "The document was deleted.");
    this.metrics.updates.inc({ subdoc, source: "client" });
    session.send({ type: MessageType.Ack, docId, subdoc, clientSeq, serverSeq });

    const stopFanout = this.metrics.fanoutSeconds.startTimer();
    room.broadcast(
      encodeMessage({
        type: MessageType.Remote,
        docId,
        subdoc,
        serverSeq,
        update,
        userId: session.accountId,
        clientId: session.clientId,
        provenance,
      }),
      session,
    );
    stopFanout();
  }

  /**
   * Persists an update that is already applied to the room's probe, then
   * applies it to the live document. Drops the probe if the write fails, so
   * the live document and the probe never hold anything the log does not.
   */
  private async persist(
    room: Room,
    subdoc: Subdoc,
    input: {
      accountId: string | null;
      clientId: string;
      clientSeq?: number;
      actor: Actor;
      provenance: Provenance | undefined;
      update: Uint8Array;
    },
  ): Promise<number | null> {
    const stop = this.metrics.persistSeconds.startTimer();
    let serverSeq: number | null;
    let removedDocIds: string[] = [];
    try {
      const remaining = subdoc === "manifest" ? manifestDocIds(room.shadow(subdoc)) : null;
      const removed = remaining ? [...manifestDocIds(room.live(subdoc))].filter((id) => !remaining.has(id)) : [];
      // Manifest values are client supplied: only close documents belonging to this project.
      removedDocIds = removed.length ? (await this.context.db.selectFrom("documents").select("id")
        .where("project_id", "=", room.projectId).where("kind", "!=", "manifest")
        .where("id", "in", removed).execute()).map((row) => row.id) : [];
      serverSeq = await persistUpdate(this.context.db, { docId: room.docId, subdoc, ...input, removedDocIds });
    } catch (error) {
      room.discardShadow(subdoc);
      throw error;
    } finally {
      stop();
    }
    if (serverSeq === null) {
      room.discardShadow(subdoc);
      return null;
    }
    if (!room.disposed) room.commit(subdoc, input.update, serverSeq);
    for (const docId of removedDocIds) this.documentDeleted(docId);
    this.firePersisted({ docId: room.docId, subdoc, serverSeq, actor: input.actor, provenance: input.provenance });
    return serverSeq;
  }

  /** Counts and reports an internal sync error (ids and sizes only, see observability/reporter.ts). */
  reportError(error: unknown, area: "frame" | "update" | "listener", details: Record<string, string | number | undefined> = {}): void {
    this.metrics.errors.inc({ area });
    reportError(this.context, error, { area: `sync.${area}`, ...details });
  }

  private firePersisted(update: PersistedUpdate): void {
    for (const listener of this.persistedListeners) {
      try {
        listener(update);
      } catch (error) {
        this.context.log.error({ err: error, docId: update.docId }, "Persisted-update listener failed");
        this.reportError(error, "listener", { docId: update.docId, subdoc: update.subdoc, serverSeq: update.serverSeq });
      }
    }
  }

  // RoomService -------------------------------------------------------------

  private transact<T>(
    docId: string,
    subdoc: Subdoc,
    actor: Actor,
    provenance: Provenance,
    change: (doc: Y.Doc) => T | Promise<T>,
  ): Promise<{ serverSeq: number; result: T }> {
    return this.withRoom(docId, (room) => room.queue.run(() => this.transactInRoom(room, subdoc, actor, provenance, change)));
  }

  /** The body of transact; the caller holds the room's queue. */
  private async transactInRoom<T>(
    room: Room,
    subdoc: Subdoc,
    actor: Actor,
    provenance: Provenance,
    change: (doc: Y.Doc) => T | Promise<T>,
  ): Promise<{ serverSeq: number; result: T }> {
    const { docId } = room;
    if (room.disposed) throw new Error(`Document ${docId} was deleted.`);
    if (!room.hasSubdoc(subdoc)) throw new Error(`A ${room.kind} document has no ${subdoc} sub-document.`);
    // The change runs on the probe copy rather than the live document,
    // so a change that throws halfway leaves nothing behind: the probe is
    // dropped and the live document never saw it.
    const shadow = room.shadow(subdoc);
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(update);
    shadow.on("update", collect);
    let result: T;
    try {
      result = await shadow.transact(() => change(shadow), SERVER_ORIGIN);
    } catch (error) {
      room.discardShadow(subdoc);
      throw error;
    } finally {
      shadow.off("update", collect);
    }
    if (updates.length === 0) return { serverSeq: room.serverSeq, result };

    const update = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    const serverSeq = await this.persist(room, subdoc, {
      accountId: actorAccountId(actor),
      clientId: "server",
      actor,
      provenance,
      update,
    });
    if (serverSeq === null) throw new Error(`Document ${docId} was deleted.`);
    this.metrics.updates.inc({ subdoc, source: "server" });
    const stopFanout = this.metrics.fanoutSeconds.startTimer();
    room.broadcast(
      encodeMessage({ type: MessageType.Remote, docId, subdoc, serverSeq, update, userId: "", clientId: "", provenance }),
    );
    stopFanout();
    return { serverSeq, result };
  }

  private batch<T>(docId: string, task: (batch: RoomBatch) => T | Promise<T>): Promise<T> {
    return this.withRoom(docId, (room) =>
      room.queue.run(() => {
        if (room.disposed) throw new Error(`Document ${docId} was deleted.`);
        const batch: RoomBatch = {
          docs: Object.fromEntries(room.docs) as Record<Subdoc, Y.Doc>,
          serverSeq: () => room.serverSeq,
          transact: (subdoc, actor, provenance, change) => this.transactInRoom(room, subdoc, actor, provenance, change),
        };
        return task(batch);
      }),
    );
  }

  private withDocs<T>(docId: string, read: (docs: Record<Subdoc, Y.Doc>, serverSeq: number) => T | Promise<T>): Promise<T> {
    return this.withRoom(docId, (room) =>
      room.queue.run(() => {
        if (room.disposed) throw new Error(`Document ${docId} was deleted.`);
        return read(Object.fromEntries(room.docs) as Record<Subdoc, Y.Doc>, room.serverSeq);
      }),
    );
  }

  private async currentServerSeq(docId: string): Promise<number> {
    const room = this.loaded.get(docId);
    if (room && !room.disposed) {
      try {
        await room.ready;
        if (!room.disposed) return room.serverSeq;
      } catch {
        // Fall through to the database.
      }
    }
    const row = await this.context.db
      .selectFrom("documents")
      .select("last_server_seq")
      .where("id", "=", docId)
      .executeTakeFirst();
    return row?.last_server_seq ?? 0;
  }

  private membershipChanged(projectId: string, accountId: string, role: Role | null): void {
    for (const session of this.byAccount.get(accountId) ?? []) {
      for (const [docId, open] of [...session.docs]) {
        if (open.projectId !== projectId) continue;
        if (role === null) session.closeDoc(docId, "access-revoked");
        else open.role = role;
      }
    }
    if (role !== null) {
      this.context.events.publish({ scope: "user", id: accountId, kind: EventKind.RoleChanged, payload: { projectId, role } });
    }
  }

  private documentDeleted(docId: string): void {
    const room = this.loaded.get(docId);
    if (!room) return;
    for (const member of [...room.members.keys()]) (member as Session).closeDoc(docId, "document-deleted");
    this.unloadRoom(room);
  }

  private accountRevoked(accountId: string, familyId?: string): void {
    for (const session of [...(this.byAccount.get(accountId) ?? [])]) {
      if (familyId === undefined || session.familyId === familyId) session.close(CloseCode.AuthRevoked, "Signed out");
    }
  }

  // Events ------------------------------------------------------------------

  private forwardEvent(event: BusEvent): void {
    let frame: Uint8Array;
    try {
      frame = encodeMessage({ type: MessageType.Event, ...event });
    } catch (error) {
      this.context.log.error({ err: error, kind: event.kind }, "Event could not be encoded");
      return;
    }
    switch (event.scope) {
      case "doc":
        this.loaded.get(event.id)?.broadcast(frame);
        break;
      case "project":
        // A socket only has a project's documents open while its account is
        // a member: revocation closes them (membershipChanged).
        for (const session of this.sessions) if (session.projectDocs.has(event.id)) session.sendFrame(frame);
        break;
      case "user":
        for (const session of this.byAccount.get(event.id) ?? []) session.sendFrame(frame);
        break;
    }
  }

  // Shutdown ----------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.detach?.();
    clearInterval(this.sweepTimer);
    this.unsubscribe();
    const sockets = [...this.sessions].map((session) => session.ws);
    for (const session of [...this.sessions]) session.close(CloseCode.ServerRestart, "Server restarting");
    for (const ws of this.wss.clients) if (!sockets.includes(ws)) sockets.push(ws);
    const allClosed = Promise.all(
      sockets.map((ws) =>
        ws.readyState === ws.CLOSED ? undefined : new Promise<void>((resolve) => ws.once("close", () => resolve())),
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([allClosed, new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_WAIT_MS)))]);
    clearTimeout(timer);
    for (const ws of sockets) if (ws.readyState !== ws.CLOSED) ws.terminate();
    // Let in-flight writes commit before the database closes.
    await Promise.all([...this.loaded.values()].map((room) => room.queue.whenIdle()));
    for (const room of [...this.loaded.values()]) this.unloadRoom(room);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
