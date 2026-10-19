// Divergence check (source plan §11, implementation plan §7): hourly, and on
// demand, compare each open or recently synced document with the server's
// GET /v1/documents/:docId/digest.
//
// A comparison is conclusive only when the host's state vector for the
// compared sub-document (`content`, or `manifest` for a manifest) equals the
// server's: Yjs state vectors cover inserts only, so equal vectors with
// different text mean the two sides disagree about deletions, which no amount
// of waiting fixes. Different vectors just mean edits are in flight; the
// check is retried a few minutes later.
//
// Only documents whose local work is fully acknowledged are compared: an
// unacked local edit legitimately makes the replica differ.
//
// On a mismatch the host re-opens the document with empty state vectors, so
// the server answers with its whole state and that merges in (Yjs merges
// never drop local data), and the hub's normal reconnect path pushes
// anything the server lacks. Then the check runs again. Nothing local is
// ever wiped here; an unresolved mismatch stays in diagnostics and telemetry
// for an operator (the admin CLI can inspect and rebuild the server side).

import { createHash } from "node:crypto";

import * as Y from "yjs";

import { ApiRoutes, canonicalJson, type DocumentDigest } from "../../../src/lib/collab/protocol/api";
import type { Subdoc } from "../../../src/lib/collab/protocol/roles";
import { ContentKeys, ManifestKeys } from "../../../src/lib/collab/protocol/schema";
import type { DivergenceRecord } from "../../../src/lib/collab/ui/diagnostics-types";
import type { ApiClient } from "./api-client";
import type { Clock, Logger, TimerHandle } from "./clock";
import { consoleLogger, systemClock } from "./clock";
import type { DocHub } from "./doc-hub";
import type { HostStore } from "./store";

export const DIVERGENCE_INTERVAL_MS = 60 * 60_000;
/** An inconclusive check is retried after this long. */
export const DIVERGENCE_RETRY_MS = 5 * 60_000;
/** Closed documents opened within this window are still checked. */
export const DIVERGENCE_RECENT_MS = 24 * 60 * 60_000;
const MAX_RETRIES = 6;
const MAX_RECORDS = 200;

/** What the checker needs from the host; CollabHost implements it. */
export interface DivergenceHost {
  api(): ApiClient | null;
  store(): HostStore;
  /** The open hub for a doc, or null. */
  openHub(docId: string): DocHub | null;
  /** Doc ids of open hubs. */
  openDocIds(): string[];
  acquire(docId: string): DocHub;
  release(docId: string): void;
  /**
   * Sends `open` for the doc again with empty state vectors; resolves true
   * once the server answered with its full state, false when that is not
   * possible now (offline, signed out, timed out).
   */
  reopenFull(hub: DocHub, timeoutMs: number): Promise<boolean>;
}

export interface DivergenceCheckerOptions {
  host: DivergenceHost;
  clock?: Clock;
  logger?: Logger;
  intervalMs?: number;
  retryMs?: number;
  recentMs?: number;
  /** How long recovery waits for the full state and for acks. */
  recoveryTimeoutMs?: number;
  /** Every record, as it is made (telemetry, diagnostics, host events). */
  onRecord?: (record: DivergenceRecord) => void;
}

interface LocalState {
  subdoc: Subdoc;
  stateVector: Uint8Array;
  contentSha256: string;
}

type LocalRead = { ok: true; state: LocalState } | { ok: false; detail: string };

export function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The hashed content of a sub-document, as the server computes it (DocumentDigest). */
export function digestOf(subdoc: Subdoc, doc: Y.Doc): string {
  return subdoc === "manifest"
    ? sha256Utf8(canonicalJson(doc.getMap(ManifestKeys.files).toJSON()))
    : sha256Utf8(doc.getText(ContentKeys.source).toString());
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Compares a local replica with a server digest. Pure, so the decision rule
 * is unit-testable on its own.
 */
export function compareDigest(local: LocalState, digest: DocumentDigest): "match" | "mismatch" | "inconclusive" {
  const serverVector = digest.stateVectors[local.subdoc];
  if (!serverVector) return "inconclusive";
  if (!sameBytes(local.stateVector, new Uint8Array(Buffer.from(serverVector, "base64")))) return "inconclusive";
  return local.contentSha256 === digest.contentSha256 ? "match" : "mismatch";
}

export class DivergenceChecker {
  private readonly host: DivergenceHost;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly retryMs: number;
  private readonly recentMs: number;
  private readonly recoveryTimeoutMs: number;
  private readonly onRecord?: (record: DivergenceRecord) => void;
  private readonly records: DivergenceRecord[] = [];
  private readonly latest = new Map<string, DivergenceRecord>();
  /** Docs synced during this run, so they are checked after their hub closed. */
  private readonly seen = new Set<string>();
  private readonly retries = new Map<string, number>();
  private timer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private running: Promise<DivergenceRecord[]> | null = null;
  /** The hourly schedule is off (before start, after stop). */
  private stopped = true;
  /** stop() was called: a run in progress ends after its current doc. */
  private halted = false;

  constructor(options: DivergenceCheckerOptions) {
    this.host = options.host;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? consoleLogger;
    this.intervalMs = options.intervalMs ?? DIVERGENCE_INTERVAL_MS;
    this.retryMs = options.retryMs ?? DIVERGENCE_RETRY_MS;
    this.recentMs = options.recentMs ?? DIVERGENCE_RECENT_MS;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 30_000;
    this.onRecord = options.onRecord;
  }

  /** Starts the hourly schedule. The first run is an interval away: startup is busy enough. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.halted = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    if (this.retryTimer) this.clock.clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  /** A hub synced with the server this run (called by the host when a hub is created). */
  noteDoc(docId: string): void {
    this.seen.add(docId);
  }

  /** Recent records, oldest first. */
  history(): DivergenceRecord[] {
    return [...this.records];
  }

  lastRecord(docId: string): DivergenceRecord | undefined {
    return this.latest.get(docId);
  }

  /** Docs whose last check was inconclusive and that will be checked again soon. */
  pendingRetries(): string[] {
    return [...this.retries.keys()];
  }

  /** Checks every candidate doc now. Concurrent calls share one run. */
  checkAll(): Promise<DivergenceRecord[]> {
    if (!this.running) {
      this.running = this.runAll(this.candidates()).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /** Checks one doc now (and recovers it on a mismatch). */
  async checkDoc(docId: string): Promise<DivergenceRecord> {
    const record = await this.checkOnce(docId, true);
    this.remember(record);
    return record;
  }

  // ------------------------------------------------------------ scheduling

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.checkAll()
        .catch((error) => this.logger.warn("Divergence check failed", error))
        .finally(() => this.schedule());
    }, this.intervalMs);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || this.retries.size === 0) return;
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      const docIds = [...this.retries.keys()];
      void this.runAll(docIds)
        .catch((error) => this.logger.warn("Divergence retry failed", error))
        .finally(() => this.scheduleRetry());
    }, this.retryMs);
  }

  /** Open hubs, docs synced this run, and docs opened in the last day. */
  private candidates(): string[] {
    const ids = new Set<string>([...this.host.openDocIds(), ...this.seen]);
    const cutoff = this.clock.now() - this.recentMs;
    try {
      const store = this.host.store();
      for (const project of store.listProjects()) {
        for (const doc of store.listDocs(project.projectId)) {
          const opened = store.getDocMeta(doc.docId)?.lastOpenedAt ?? null;
          if (opened !== null && opened >= cutoff) ids.add(doc.docId);
        }
      }
    } catch (error) {
      this.logger.warn("Could not list documents for the divergence check", error);
    }
    return [...ids].sort();
  }

  private async runAll(docIds: string[]): Promise<DivergenceRecord[]> {
    const results: DivergenceRecord[] = [];
    // One at a time: the check is background work and must not compete with typing.
    for (const docId of docIds) {
      if (this.halted) break;
      const record = await this.checkOnce(docId, true);
      this.remember(record);
      results.push(record);
    }
    return results;
  }

  private remember(record: DivergenceRecord): void {
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    this.latest.set(record.docId, record);
    if (record.outcome === "inconclusive") {
      const attempts = (this.retries.get(record.docId) ?? 0) + 1;
      if (attempts <= MAX_RETRIES) this.retries.set(record.docId, attempts);
      else this.retries.delete(record.docId);
      this.scheduleRetry();
    } else {
      this.retries.delete(record.docId);
    }
    try {
      this.onRecord?.(record);
    } catch (error) {
      this.logger.warn("Divergence listener failed", error);
    }
  }

  // ------------------------------------------------------------ one check

  private record(docId: string, outcome: DivergenceRecord["outcome"], extra: Partial<DivergenceRecord> = {}): DivergenceRecord {
    return { docId, at: this.clock.now(), outcome, ...extra };
  }

  private async checkOnce(docId: string, recover: boolean): Promise<DivergenceRecord> {
    const api = this.host.api();
    if (!api) return this.record(docId, "skipped", { detail: "signed-out" });
    const before = this.readLocal(docId);
    if (!before.ok) return this.record(docId, "skipped", { detail: before.detail });
    let digest: DocumentDigest;
    try {
      digest = await api.request<DocumentDigest>("GET", ApiRoutes.documentDigest(docId));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return this.record(docId, "skipped", { detail: `request-failed${typeof code === "string" ? `:${code}` : ""}` });
    }
    // Read again after the response: remote updates that arrived meanwhile
    // are in both states or show up as a different vector, never as a false
    // mismatch.
    const local = this.readLocal(docId);
    if (!local.ok) return this.record(docId, "skipped", { detail: local.detail });
    const outcome = compareDigest(local.state, digest);
    if (outcome !== "mismatch") return this.record(docId, outcome);

    this.logger.error(
      `Divergence: ${docId} (${local.state.subdoc}) differs from the server at the same state vector (server seq ${digest.serverSeq}).`,
    );
    if (!recover) return this.record(docId, "mismatch", { detail: "still-differs", recovered: false });
    const recovered = await this.recover(docId);
    return this.record(docId, "mismatch", { detail: recovered.detail, recovered: recovered.ok });
  }

  /** Re-open with empty state vectors, wait for acks, compare again. */
  private async recover(docId: string): Promise<{ ok: boolean; detail: string }> {
    let hub = this.host.openHub(docId);
    let acquired = false;
    if (!hub) {
      hub = this.host.acquire(docId);
      acquired = true;
    }
    try {
      // A freshly acquired hub sends its own `open` first; wait for that
      // answer so it is not mistaken for the full-state one.
      await this.until(hub, () => hub!.getStatus().state !== "loading" && hub!.getStatus().connected);
      const reopened = await this.host.reopenFull(hub, this.recoveryTimeoutMs);
      if (!reopened) return { ok: false, detail: "reopen-unavailable" };
      if (!(await this.until(hub, () => hub!.getStatus().pending === 0))) return { ok: false, detail: "acks-timed-out" };
      const again = await this.checkOnce(docId, false);
      if (again.outcome === "match") {
        this.logger.warn(`Divergence: ${docId} matches the server again after a full re-open.`);
        return { ok: true, detail: "recovered-by-full-reopen" };
      }
      return { ok: false, detail: again.outcome === "mismatch" ? "still-differs" : `recheck-${again.outcome}` };
    } finally {
      if (acquired) this.host.release(docId);
    }
  }

  private until(hub: DocHub, condition: () => boolean): Promise<boolean> {
    if (hub.isClosed) return Promise.resolve(false);
    if (condition()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        off();
        this.clock.clearTimeout(timer);
        resolve(value);
      };
      const off = hub.onStatus(() => {
        if (hub.isClosed) finish(false);
        else if (condition()) finish(true);
      });
      const timer = this.clock.setTimeout(() => finish(condition()), this.recoveryTimeoutMs);
      if (condition()) finish(true);
    });
  }

  /** The local state to compare, from the open hub or from SQLite. */
  private readLocal(docId: string): LocalRead {
    const hub = this.host.openHub(docId);
    if (hub) {
      if (hub.readOnlyReason) return { ok: false, detail: `read-only:${hub.readOnlyReason}` };
      if (hub.getStatus().pending > 0) return { ok: false, detail: "pending" };
      const subdoc: Subdoc = hub.kind === "manifest" ? "manifest" : "content";
      const doc = hub.getDoc(subdoc);
      return { ok: true, state: { subdoc, stateVector: Y.encodeStateVector(doc), contentSha256: digestOf(subdoc, doc) } };
    }
    const store = this.host.store();
    const meta = store.getDocMeta(docId);
    if (!meta) return { ok: false, detail: "unknown-doc" };
    if (meta.readOnlyReason) return { ok: false, detail: `read-only:${meta.readOnlyReason}` };
    if (store.unackedSummary(docId).length > 0) return { ok: false, detail: "pending" };
    const subdoc: Subdoc = meta.kind === "manifest" ? "manifest" : "content";
    const doc = new Y.Doc();
    try {
      const { snapshot, tail } = store.loadSubdoc(docId, subdoc);
      if (snapshot) Y.applyUpdate(doc, snapshot.state);
      if (tail.length > 0) Y.applyUpdate(doc, Y.mergeUpdates(tail.map((row) => row.update)));
      return { ok: true, state: { subdoc, stateVector: Y.encodeStateVector(doc), contentSha256: digestOf(subdoc, doc) } };
    } finally {
      doc.destroy();
    }
  }
}
