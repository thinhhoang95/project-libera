// In-process event bus. API handlers publish thread, suggestion, review and
// membership events; the sync service forwards them to connected clients as
// EventMessage frames. The server is a single process in v1; a multi-node
// deployment would replace this with Postgres LISTEN/NOTIFY.

import { EventEmitter } from "node:events";

import type { EventScope } from "./protocol.js";

export interface BusEvent {
  scope: EventScope;
  /** docId, projectId or userId depending on scope. */
  id: string;
  kind: string;
  payload: unknown;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: BusEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
