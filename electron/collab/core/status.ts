// Per-document SyncStatus (protocol/local.ts, collaboration map §6).
//
// Status is derived from a few facts the hub owns, and pushed to replicas and
// in-process subscribers. Counter changes (pending, acks) are debounced to
// about 100 ms so typing does not flood the UI with status messages, but a
// change of `state` (most importantly the first commit after "Saved to
// workspace") is emitted immediately: "Saved on this device" must appear
// promptly after the SQLite commit, never before it.

import type { SyncState, SyncStatus } from "../../../src/lib/collab/protocol/local";
import type { Clock, TimerHandle } from "./clock";
import { Emitter } from "./clock";
import type { ReadOnlyReason } from "./store";

export interface StatusInputs {
  /** The sync socket completed hello/welcome. */
  connected: boolean;
  /** The server answered `open` for this doc on the current connection. */
  opened: boolean;
  /** The doc has any state at all (local log, snapshot, or a server diff). */
  hasData: boolean;
  /** Local updates not yet acknowledged by the server. */
  pending: number;
  oldestPendingAt: number | null;
  lastAckAt: number | null;
  readOnlyReason: ReadOnlyReason | null;
  /** Why the connection is down, when the reason is not just the network. */
  connectionDetail?: string;
  /** Last local persistence failure, shown until the next successful commit. */
  persistError?: string;
}

export function computeStatus(inputs: StatusInputs, now: number): SyncStatus {
  const base = {
    pending: inputs.pending,
    oldestPendingAgeMs: inputs.oldestPendingAt === null ? 0 : Math.max(0, now - inputs.oldestPendingAt),
    lastAckAt: inputs.lastAckAt,
    connected: inputs.connected,
  };
  let state: SyncState;
  let detail: string | undefined;
  if (inputs.readOnlyReason === "access-revoked") {
    state = "access-changed";
    detail = inputs.pending > 0 ? `Access changed. ${inputs.pending} changes kept on this device.` : "Access changed.";
  } else if (inputs.readOnlyReason === "schema-newer") {
    state = "read-only";
    detail = "Read-only — update required.";
  } else if (!inputs.connected) {
    state = "offline";
    detail = inputs.pending > 0 ? `Offline — ${inputs.pending} changes on this device.` : "Offline.";
    if (inputs.connectionDetail) detail = `${detail} ${inputs.connectionDetail}`;
  } else if (!inputs.opened) {
    state = inputs.pending > 0 ? "saved-local" : inputs.hasData ? "saved-local" : "loading";
  } else if (inputs.pending > 0) {
    state = "syncing";
    detail = `Syncing ${inputs.pending} changes…`;
  } else {
    state = "saved-remote";
  }
  if (inputs.persistError) detail = `Could not save on this device: ${inputs.persistError}`;
  return detail ? { state, ...base, detail } : { state, ...base };
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return (
    a.state === b.state &&
    a.pending === b.pending &&
    a.lastAckAt === b.lastAckAt &&
    a.connected === b.connected &&
    a.detail === b.detail
  );
}

export class StatusTracker {
  private last: SyncStatus | null = null;
  private timer: TimerHandle | null = null;
  private readonly emitter = new Emitter<SyncStatus>();
  private disposed = false;

  constructor(
    private readonly clock: Clock,
    private readonly inputs: () => StatusInputs,
    private readonly debounceMs = 100,
  ) {}

  current(): SyncStatus {
    return computeStatus(this.inputs(), this.clock.now());
  }

  /** The last status emitted to subscribers (null before the first emit). */
  lastEmitted(): SyncStatus | null {
    return this.last;
  }

  onChange(listener: (status: SyncStatus) => void): () => void {
    return this.emitter.on(listener);
  }

  /**
   * Inputs changed. `prompt` forces an immediate emit (used right after a
   * local commit); a change of `state` is always immediate.
   */
  changed(prompt = false): void {
    if (this.disposed) return;
    const next = this.current();
    if (this.last && sameStatus(this.last, next)) return;
    if (prompt || !this.last || this.last.state !== next.state) {
      this.emitNow(next);
      return;
    }
    if (this.timer) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;
      const latest = this.current();
      if (!this.last || !sameStatus(this.last, latest)) this.emitNow(latest);
    }, this.debounceMs);
  }

  private emitNow(status: SyncStatus): void {
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    this.last = status;
    this.emitter.emit(status);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.emitter.clear();
  }
}
