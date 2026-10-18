// DocHubRegistry: one hub per docId, reference counted.
//
// Replicas and in-process users acquire a hub and release it when done. A
// hub whose count reaches zero is closed after an idle delay (so switching
// tabs or reloading a window does not reload the document), and only after
// its queued snapshot work finished.

import type { Clock, Logger, TimerHandle } from "./clock";
import { systemClock } from "./clock";
import type { DocHub, HubKind } from "./doc-hub";

export interface AcquireOptions {
  kind?: HubKind;
  projectId?: string;
}

export interface DocHubRegistryOptions {
  create: (docId: string, options: AcquireOptions) => DocHub;
  /** Delay before an unreferenced hub closes. */
  idleMs?: number;
  clock?: Clock;
  logger?: Logger;
}

interface Entry {
  hub: DocHub;
  refs: number;
  idleTimer: TimerHandle | null;
  closing: Promise<void> | null;
}

export class DocHubRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly create: DocHubRegistryOptions["create"];
  private readonly idleMs: number;
  private readonly clock: Clock;
  private stopped = false;

  constructor(options: DocHubRegistryOptions) {
    this.create = options.create;
    this.idleMs = options.idleMs ?? 30_000;
    this.clock = options.clock ?? systemClock;
  }

  /** Returns the hub for `docId`, creating and loading it if needed, and takes a reference. */
  acquire(docId: string, options: AcquireOptions = {}): DocHub {
    if (this.stopped) throw new Error("The collab host is stopped");
    let entry = this.entries.get(docId);
    if (entry && entry.hub.isClosed) {
      this.entries.delete(docId);
      entry = undefined;
    }
    if (!entry) {
      const hub = this.create(docId, options);
      entry = { hub, refs: 0, idleTimer: null, closing: null };
      this.entries.set(docId, entry);
      const created = entry;
      hub.onClose(() => {
        if (this.entries.get(docId) === created) this.entries.delete(docId);
      });
    }
    entry.refs += 1;
    if (entry.idleTimer) {
      this.clock.clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    return entry.hub;
  }

  /** Drops a reference taken with acquire. */
  release(docId: string): void {
    const entry = this.entries.get(docId);
    if (!entry || entry.refs === 0) return;
    entry.refs -= 1;
    if (entry.refs > 0 || this.stopped) return;
    entry.idleTimer = this.clock.setTimeout(() => {
      entry.idleTimer = null;
      void this.closeIfIdle(docId, entry);
    }, this.idleMs);
  }

  private async closeIfIdle(docId: string, entry: Entry): Promise<void> {
    if (entry.refs > 0 || entry.closing) return;
    entry.closing = entry.hub.prepareClose();
    try {
      await entry.closing;
    } finally {
      entry.closing = null;
    }
    // Someone may have acquired the hub while snapshots were flushing.
    if (entry.refs > 0 || this.entries.get(docId) !== entry) return;
    this.entries.delete(docId);
    entry.hub.close();
  }

  get(docId: string): DocHub | null {
    const entry = this.entries.get(docId);
    return entry && !entry.hub.isClosed ? entry.hub : null;
  }

  refCount(docId: string): number {
    return this.entries.get(docId)?.refs ?? 0;
  }

  hubs(): DocHub[] {
    return [...this.entries.values()].map((entry) => entry.hub).filter((hub) => !hub.isClosed);
  }

  /** Closes every hub after flushing its snapshot work (host shutdown). */
  async closeAll(reason = "host-stopped"): Promise<void> {
    this.stopped = true;
    const entries = [...this.entries.values()];
    for (const entry of entries) if (entry.idleTimer) this.clock.clearTimeout(entry.idleTimer);
    await Promise.all(entries.map((entry) => entry.hub.prepareClose()));
    for (const entry of entries) entry.hub.close(reason);
    this.entries.clear();
  }
}
