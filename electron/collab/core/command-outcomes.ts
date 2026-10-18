// What happened to offline commands after they left the queue (plan M2.6).
//
// PendingCommands deletes a command once the server answers it for good, so
// a refusal (a 403 on a comment made offline after a role change, say) would
// be gone before a window that was closed at the time could show it. This
// keeps the refused ones until a window discards them, so the comment card
// can offer Retry or Discard after a reload. Successes need no record: the
// server's thread events carry their result to every window.
//
// Kept in memory on purpose: after a host restart the server's thread list is
// the truth, and a refusal is not worth a schema change.

import type { Command } from "../../../src/lib/collab/protocol/api";
import type { PendingCommandEvent, PendingCommands } from "./pending-commands";

export interface FailedCommandRecord {
  command: Command;
  status: number;
  error: { code: string; message: string };
  failedAt: number;
}

const MAX_FAILURES = 200;

export class CommandOutcomes {
  private readonly failures = new Map<string, FailedCommandRecord>();
  /** Commands seen while queued, so a refusal can be reported with its body. */
  private readonly queued = new Map<string, Command>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly commands: PendingCommands,
    private readonly now: () => number = Date.now,
  ) {
    for (const row of commands.list()) this.queued.set(row.id, row.command);
    this.unsubscribe = commands.on((event) => this.observe(event));
  }

  private observe(event: PendingCommandEvent): void {
    if (event.type === "pending") {
      this.queued.set(event.command.id, event.command);
      return;
    }
    if (event.type !== "settled") return;
    const command = this.queued.get(event.id);
    this.queued.delete(event.id);
    if (event.ok || !command) return;
    this.failures.set(event.id, {
      command,
      status: event.status,
      error: event.error ?? { code: "rejected", message: `HTTP ${event.status}` },
      failedAt: this.now(),
    });
    while (this.failures.size > MAX_FAILURES) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  failed(): FailedCommandRecord[] {
    return [...this.failures.values()];
  }

  /** Forgets a refused command; returns false when there was none with this id. */
  discard(id: string): boolean {
    return this.failures.delete(id);
  }

  stop(): void {
    this.unsubscribe();
    this.queued.clear();
  }
}
