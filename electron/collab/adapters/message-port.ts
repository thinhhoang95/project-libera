// Adapts a MessagePort to the hub's ReplicaPort.
//
// In the host this is Electron's MessagePortMain, whose "message" event is a
// MessageEvent `{ data, ports }`. Tests stand in node:worker_threads ports,
// whose "message" event is the value itself. Both are EventEmitters with a
// "close" event when the other side goes away (window closed, renderer
// crashed), which detaches the replica and releases the hub.
//
// Messages come from a renderer, so their shape is checked before the hub
// sees them: a malformed message is dropped, never thrown into the hub.

import type { HubToReplica, ReplicaToHub } from "../../../src/lib/collab/protocol/local";
import { isSubdoc } from "../../../src/lib/collab/protocol/roles";
import type { Logger } from "../core/clock";
import { consoleLogger } from "../core/clock";
import type { ReplicaPort } from "../core/ports";

export interface MessagePortLike {
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  postMessage(message: unknown): void;
  start?(): void;
  close(): void;
}

function isMessageEvent(value: unknown): value is { data: unknown; ports: unknown[] } {
  return typeof value === "object" && value !== null && "data" in value && Array.isArray((value as { ports?: unknown }).ports);
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** Returns the message if it is a well-formed ReplicaToHub, else null. */
export function parseReplicaMessage(value: unknown): ReplicaToHub | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (typeof message.docId !== "string" || !message.docId) return null;
  switch (message.t) {
    case "attach": {
      const vectors = message.stateVectors;
      if (!vectors || typeof vectors !== "object") return null;
      for (const [subdoc, vector] of Object.entries(vectors as Record<string, unknown>)) {
        if (!isSubdoc(subdoc) || !isBytes(vector)) return null;
      }
      return message as unknown as ReplicaToHub;
    }
    case "update":
      if (!isSubdoc(message.subdoc) || !isBytes(message.update)) return null;
      if (message.provenance !== undefined && (typeof message.provenance !== "object" || message.provenance === null)) return null;
      return message as unknown as ReplicaToHub;
    case "awareness":
      return isBytes(message.update) ? (message as unknown as ReplicaToHub) : null;
    case "detach":
      return message as unknown as ReplicaToHub;
    default:
      return null;
  }
}

export function adaptMessagePort(port: MessagePortLike, logger: Logger = consoleLogger): ReplicaPort {
  const messageListeners = new Set<(message: ReplicaToHub) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;

  const onMessage = (raw: unknown) => {
    if (closed) return;
    const value = isMessageEvent(raw) ? raw.data : raw;
    const message = parseReplicaMessage(value);
    if (!message) {
      logger.warn("Dropped a malformed replica message");
      return;
    }
    for (const listener of [...messageListeners]) listener(message);
  };
  const onClose = () => {
    if (closed) return;
    closed = true;
    for (const listener of [...closeListeners]) listener();
    detach();
  };
  const detach = () => {
    const remove = (port.off ?? port.removeListener)?.bind(port);
    remove?.("message", onMessage as (...args: unknown[]) => void);
    remove?.("close", onClose);
  };

  port.on("message", onMessage);
  port.on("close", onClose);
  // MessagePortMain queues messages until start(); worker ports start on "message" listeners.
  port.start?.();

  return {
    postMessage(message: HubToReplica) {
      if (closed) return;
      try {
        port.postMessage(message);
      } catch (error) {
        logger.warn("Could not post to a replica port", error);
      }
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      detach();
      try {
        port.close();
      } catch {
        // Already closed.
      }
      for (const listener of [...closeListeners]) listener();
    },
  };
}
