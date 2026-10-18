// The hub's side of a replica connection. The Electron adapter wraps a
// MessagePortMain in this interface; tests and in-process users use the
// in-memory pair below.

import type { HubToReplica, ReplicaToHub } from "../../../src/lib/collab/protocol/local";

export interface ReplicaPort {
  postMessage(message: HubToReplica): void;
  /** Subscribes to messages from the replica; returns an unsubscribe function. */
  onMessage(listener: (message: ReplicaToHub) => void): () => void;
  /** Called when the other side goes away (window closed, renderer crashed). */
  onClose?(listener: () => void): () => void;
  close(): void;
}

/** The replica's end of an in-memory port pair. */
export interface ReplicaEnd {
  postMessage(message: ReplicaToHub): void;
  onMessage(listener: (message: HubToReplica) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

class MemoryEnd<Out, In> {
  peer: MemoryEnd<In, Out> | null = null;
  private listeners = new Set<(message: In) => void>();
  private closeListeners = new Set<() => void>();
  private closed = false;

  postMessage(message: Out): void {
    if (this.closed) return;
    const peer = this.peer;
    if (!peer) return;
    // MessagePort semantics: asynchronous, ordered, structured clone (so a
    // Uint8Array the hub keeps cannot be mutated by the replica).
    const copy = structuredClone(message);
    setImmediate(() => peer.deliver(copy));
  }

  private deliver(message: In): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) listener(message);
  }

  onMessage(listener: (message: In) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.peer;
    for (const listener of [...this.closeListeners]) listener();
    if (peer) setImmediate(() => peer.close());
  }
}

export function createMemoryPortPair(): { hub: ReplicaPort; replica: ReplicaEnd } {
  const hub = new MemoryEnd<HubToReplica, ReplicaToHub>();
  const replica = new MemoryEnd<ReplicaToHub, HubToReplica>();
  hub.peer = replica;
  replica.peer = hub;
  return { hub, replica };
}
