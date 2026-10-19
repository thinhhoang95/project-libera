// Shared helpers for the collab host tests: temp databases, a manual clock,
// token providers and a minimal renderer replica speaking protocol/local.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as Y from "yjs";

import type { HubToReplica } from "../../../src/lib/collab/protocol/local";
import type { Provenance } from "../../../src/lib/collab/protocol/actor";
import type { Subdoc } from "../../../src/lib/collab/protocol/roles";
import type { Clock, Logger } from "../../../electron/collab/core/clock";
import type { ReplicaEnd } from "../../../electron/collab/core/ports";
import type { TokenProvider } from "../../../electron/collab/core/sync-client";

export const quietLogger: Logger = { warn: () => {}, error: () => {} };

export function tempDir(prefix = "libera-host-"): { dir: string; file: (name: string) => string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    file: (name) => path.join(dir, name),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold the WAL for a moment; temp dirs are disposable.
      }
    },
  };
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lets in-memory sockets and ports deliver everything queued (several hops). */
export async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await tick();
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(2);
  }
}

/** A clock whose time only moves when the test says so. */
export class ManualClock implements Clock {
  private time = 1_000_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Delays (from now) of pending timers, sorted. */
  pending(): number[] {
    return [...this.timers.values()].map((timer) => timer.at - this.time).sort((a, b) => a - b);
  }

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId = -1;
      let next: { at: number; callback: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (!next || timer.at < next.at)) {
          next = timer;
          nextId = id;
        }
      }
      if (!next) break;
      this.timers.delete(nextId);
      this.time = next.at;
      next.callback();
    }
    this.time = target;
  }
}

/** A token provider the test controls. */
export class TestTokens implements TokenProvider {
  token: string | null;
  refreshResult: string | null | Error;
  refreshCalls = 0;
  expiresAt: number | null = null;

  constructor(token: string | null = "t1", refreshResult: string | null | Error = "t2") {
    this.token = token;
    this.refreshResult = refreshResult;
  }

  async getAccessToken(): Promise<string | null> {
    return this.token;
  }

  async refresh(): Promise<string | null> {
    this.refreshCalls += 1;
    if (this.refreshResult instanceof Error) throw this.refreshResult;
    this.token = this.refreshResult;
    return this.token;
  }

  accessTokenExpiresAt(): number | null {
    return this.expiresAt;
  }
}

const HUB = "test-replica:hub";

/** A renderer replica: one Y.Doc per sub-document, synced over a ReplicaEnd. */
export class TestReplica {
  readonly docs = new Map<Subdoc, Y.Doc>();
  readonly messages: HubToReplica[] = [];
  private provenance: Provenance | undefined;

  constructor(
    readonly port: ReplicaEnd,
    readonly docId: string,
    subdocs: readonly Subdoc[] = ["content", "annotations", "meta"],
  ) {
    for (const subdoc of subdocs) this.docs.set(subdoc, this.createDoc(subdoc));
    port.onMessage((message) => this.receive(message));
  }

  private createDoc(subdoc: Subdoc): Y.Doc {
    const doc = new Y.Doc();
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === HUB) return;
      this.port.postMessage({
        t: "update",
        docId: this.docId,
        subdoc,
        update,
        ...(this.provenance ? { provenance: this.provenance } : {}),
      });
    });
    return doc;
  }

  attach(withState = true): void {
    const stateVectors: Partial<Record<Subdoc, Uint8Array>> = {};
    if (withState) for (const [subdoc, doc] of this.docs) stateVectors[subdoc] = Y.encodeStateVector(doc);
    this.port.postMessage({ t: "attach", docId: this.docId, stateVectors });
  }

  private receive(message: HubToReplica): void {
    this.messages.push(message);
    switch (message.t) {
      case "state":
      case "update": {
        const doc = this.docs.get(message.subdoc);
        if (doc) Y.applyUpdate(doc, message.update, HUB);
        break;
      }
      case "rejected": {
        // Rebuild the sub-document; the hub's `state` follows.
        this.docs.get(message.subdoc)?.destroy();
        this.docs.set(message.subdoc, this.createDoc(message.subdoc));
        break;
      }
    }
  }

  text(subdoc: Subdoc = "content"): string {
    return (this.docs.get(subdoc) as Y.Doc).getText("source").toString();
  }

  edit(fn: (text: Y.Text) => void, provenance?: Provenance, subdoc: Subdoc = "content"): void {
    this.provenance = provenance;
    const doc = this.docs.get(subdoc) as Y.Doc;
    doc.transact(() => fn(doc.getText("source")));
    this.provenance = undefined;
  }

  statuses() {
    return this.messages.filter((message): message is Extract<HubToReplica, { t: "status" }> => message.t === "status");
  }

  of<T extends HubToReplica["t"]>(type: T): Extract<HubToReplica, { t: T }>[] {
    return this.messages.filter((message): message is Extract<HubToReplica, { t: T }> => message.t === type);
  }
}
