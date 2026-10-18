// Offline command queue (plan M2.6). Comments, replies, status changes and
// decisions made offline are persisted in `pending_commands` before anything
// else happens, then replayed in order through POST /v1/commands while online.
//
// command.id is the idempotency key: the server stores the first result per
// id, so a resend after a lost response returns that result instead of
// applying the command twice. A command leaves the queue on a 2xx or a
// permanent 4xx; network errors, 5xx, 408 and 429 keep it and back off.

import type { Command } from "../../../src/lib/collab/protocol/api";
import { SyncLimits } from "../../../src/lib/collab/protocol/version";
import { ApiClientError, type ApiClient } from "./api-client";
import type { Clock, Logger, TimerHandle } from "./clock";
import { Emitter, consoleLogger, systemClock } from "./clock";
import type { HostStore, PendingCommandRow } from "./store";

export type PendingCommandEvent =
  | { type: "pending"; command: Command }
  | {
      type: "settled";
      id: string;
      kind: Command["kind"];
      ok: boolean;
      status: number;
      body: unknown;
      error?: { code: string; message: string };
    }
  | { type: "retrying"; id: string; attempts: number; error: string; delayMs: number };

export interface PendingCommandsOptions {
  store: HostStore;
  clock?: Clock;
  random?: () => number;
  logger?: Logger;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

function transientStatus(status: number): boolean {
  return status === 0 || status === 401 || status === 408 || status === 429 || status >= 500;
}

export class PendingCommands {
  private readonly store: HostStore;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly logger: Logger;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly events = new Emitter<PendingCommandEvent>();
  private api: ApiClient | null = null;
  private online = false;
  private running: Promise<void> | null = null;
  private retryTimer: TimerHandle | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(options: PendingCommandsOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? consoleLogger;
    this.backoffBaseMs = options.backoffBaseMs ?? SyncLimits.backoffBaseMs;
    this.backoffMaxMs = options.backoffMaxMs ?? SyncLimits.backoffMaxMs;
  }

  on(listener: (event: PendingCommandEvent) => void): () => void {
    return this.events.on(listener);
  }

  /** Commands not yet settled, oldest first. */
  list(): PendingCommandRow[] {
    return this.store.listCommands();
  }

  /**
   * Persists a command (before anything else) and starts a replay if online.
   * Enqueueing an id that is already queued is a no-op and returns false.
   */
  enqueue(command: Command): boolean {
    const inserted = this.store.insertCommand(command);
    if (inserted) this.events.emit({ type: "pending", command });
    this.kick();
    return inserted;
  }

  setApi(api: ApiClient | null): void {
    this.api = api;
    this.kick();
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (online) {
      // Coming online is a reason to retry now rather than at the next tick.
      this.attempt = 0;
      if (this.retryTimer) this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.kick();
    }
  }

  /** Starts the replay loop unless it is running or waiting for a retry. */
  kick(): void {
    if (this.stopped || this.running || this.retryTimer || !this.online || !this.api) return;
    this.running = this.replay().finally(() => {
      this.running = null;
    });
  }

  /** Resolves when the current replay pass (if any) finishes. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async replay(): Promise<void> {
    while (!this.stopped && this.online && this.api) {
      const [next] = this.store.listCommands();
      if (!next) return;
      const api = this.api;
      let status: number;
      let body: unknown;
      let error: { code: string; message: string } | undefined;
      try {
        const result = await api.postCommand(next.command);
        status = result.status;
        body = result.body;
      } catch (caught) {
        if (caught instanceof ApiClientError) {
          status = caught.status;
          body = caught.details ?? null;
          error = { code: caught.code, message: caught.message };
          if (caught.code === "needs-sign-in") status = 401;
        } else {
          status = 0;
          body = null;
          error = { code: "network", message: caught instanceof Error ? caught.message : String(caught) };
        }
      }
      if (this.stopped || this.store.isClosed) return;
      if (transientStatus(status)) {
        const message = error?.message ?? `HTTP ${status}`;
        this.store.recordCommandAttempt(next.id, message);
        this.scheduleRetry(next.id, next.attempts + 1, message);
        return;
      }
      this.attempt = 0;
      this.store.deleteCommand(next.id);
      const ok = status >= 200 && status < 300;
      if (!ok && !error) {
        const detail = (body as { error?: { code?: string; message?: string } } | null)?.error;
        error = { code: detail?.code ?? "rejected", message: detail?.message ?? `HTTP ${status}` };
      }
      if (!ok) this.logger.warn(`Command ${next.kind} ${next.id} was refused (${status})`, error);
      this.events.emit({ type: "settled", id: next.id, kind: next.command.kind, ok, status, body, ...(error ? { error } : {}) });
    }
  }

  private scheduleRetry(id: string, attempts: number, message: string): void {
    const ceiling = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt);
    const delayMs = Math.floor(this.random() * ceiling);
    this.attempt += 1;
    this.events.emit({ type: "retrying", id, attempts, error: message, delayMs });
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delayMs);
  }
}
