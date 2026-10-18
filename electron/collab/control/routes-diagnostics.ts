// Control routes: diagnostics for "Report sync problem" (implementation plan
// §7 private beta) and an on-demand divergence check.
//
// The bundle is assembled from structured state (counts, ids, states, error
// codes), then passed through scrubDiagnostics as a second line of defence:
// it drops any key that could carry content or credentials and scrubs every
// string, so a field added later cannot leak document text by accident.

import { readFileSync, statSync } from "node:fs";
import os from "node:os";

import { ControlRoutes } from "../../../src/lib/collab/local-api";
import { PROTOCOL_VERSION } from "../../../src/lib/collab/protocol/version";
import { DIAGNOSTICS_FORMAT, type DiagnosticsDoc, type HostDiagnostics } from "../../../src/lib/collab/ui/diagnostics-types";
import type { CollabHost } from "../core/host";
import { scrubText } from "../core/telemetry";
import type { Router } from "./router";
import type { CollabRuntime } from "./runtime";
import { HOST_VERSION } from "./status";
import { ControlError } from "./types";

/** At most this many documents are listed (the newest-opened first). */
const MAX_DOCS = 500;
const MAX_ARRAY = 500;

/**
 * Keys that never belong in a diagnostics bundle: document and comment
 * text, file names and titles, personal data, and credentials. Compared
 * case-insensitively.
 */
const FORBIDDEN_KEYS = new Set(
  [
    "text",
    "content",
    "body",
    "bodies",
    "markdown",
    "html",
    "rejectedText",
    "shared",
    "disk",
    "base",
    "update",
    "updates",
    "diff",
    "snapshot",
    "payload",
    "path",
    "paths",
    "localRoot",
    "notebook",
    "name",
    "title",
    "fileName",
    "displayName",
    "email",
    "password",
    "token",
    "accessToken",
    "refreshToken",
    "secret",
    "authorization",
    "cookie",
    "invitationToken",
  ].map((key) => key.toLowerCase()),
);

/** Deep copy of `value` with forbidden keys removed, strings scrubbed and arrays capped. */
export function scrubDiagnostics<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return scrubText(input);
    if (input === null || typeof input !== "object") return typeof input === "function" || typeof input === "symbol" ? undefined : input;
    // Binary is Yjs state or file bytes: never diagnostics.
    if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) return undefined;
    if (seen.has(input)) return undefined;
    seen.add(input);
    if (Array.isArray(input)) return input.slice(-MAX_ARRAY).map(walk).filter((item) => item !== undefined);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
      const scrubbed = walk(item);
      if (scrubbed !== undefined) output[key] = scrubbed;
    }
    return output;
  };
  return walk(value) as T;
}

function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function docDiagnostics(host: CollabHost, docId: string): DiagnosticsDoc | null {
  const store = host.store;
  const meta = store.getDocMeta(docId);
  const hub = host.registry.get(docId);
  if (!meta && !hub) return null;
  const status = hub?.getStatus();
  const unacked = hub ? null : store.unackedSummary(docId);
  const now = Date.now();
  const lastDivergence = host.divergence.lastRecord(docId);
  return {
    docId,
    kind: hub?.kind ?? meta?.kind ?? "file",
    projectId: meta?.projectId ?? null,
    open: Boolean(hub),
    ...(status ? { state: status.state } : {}),
    pending: status ? status.pending : (unacked?.length ?? 0),
    oldestPendingAgeMs: status
      ? status.oldestPendingAgeMs
      : unacked && unacked.length > 0
        ? Math.max(0, now - Math.min(...unacked.map((row) => row.createdAt)))
        : 0,
    lastAckAt: status?.lastAckAt ?? null,
    readOnlyReason: meta?.readOnlyReason ?? null,
    lastSeenServerSeq: meta?.lastSeenServerSeq ?? 0,
    rejected: store.listRejected(docId).map((edit) => `${edit.subdoc}:${edit.reason}`),
    ...(lastDivergence ? { lastDivergence } : {}),
  };
}

/** Builds the bundle (unscrubbed; the route scrubs it). Exported for tests. */
export function buildDiagnostics(runtime: CollabRuntime, now = Date.now()): HostDiagnostics {
  const status = runtime.status();
  const host = runtime.host;
  const store = host.store;
  const projects = status.projects.map((project) => {
    let docs = 0;
    try {
      docs = store.listDocs(project.projectId).length;
    } catch {
      docs = 0;
    }
    return { projectId: project.projectId, role: project.role, revoked: project.revoked, reconcilePending: project.reconcilePending, docs };
  });

  // Open hubs first, then every known doc of every project, newest-opened first.
  const docIds = new Set(host.registry.hubs().map((hub) => hub.docId));
  const known: Array<{ docId: string; openedAt: number }> = [];
  let documents = 0;
  for (const project of store.listProjects()) {
    for (const doc of store.listDocs(project.projectId)) {
      documents += 1;
      known.push({ docId: doc.docId, openedAt: store.getDocMeta(doc.docId)?.lastOpenedAt ?? 0 });
    }
  }
  for (const docId of store.docsWithUnacked()) known.push({ docId, openedAt: Number.MAX_SAFE_INTEGER });
  known.sort((a, b) => b.openedAt - a.openedAt);
  for (const entry of known) {
    if (docIds.size >= MAX_DOCS) break;
    docIds.add(entry.docId);
  }
  const docs = [...docIds].map((docId) => docDiagnostics(host, docId)).filter((doc): doc is DiagnosticsDoc => doc !== null);

  const gauges = host.telemetryGauges();
  const counters = host.journal.counters();
  return {
    format: DIAGNOSTICS_FORMAT,
    generatedAt: now,
    hostVersion: HOST_VERSION,
    appVersion: host.appVersion,
    protocolVersion: PROTOCOL_VERSION,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    runtime: {
      node: process.versions.node,
      ...(process.versions.electron ? { electron: process.versions.electron } : {}),
    },
    connection: { current: status.connection, history: host.journal.history() },
    account: {
      signedIn: status.account !== null && status.connection !== "signed-out",
      accountId: status.account?.id ?? null,
      serverUrl: status.account?.serverUrl ?? null,
    },
    pending: {
      unackedUpdates: gauges.pendingUpdates,
      oldestUnackedSeconds: Math.round(gauges.oldestUnackedSeconds),
      commands: gauges.pendingCommands,
      docsWithUnacked: store.docsWithUnacked().length,
    },
    projects,
    docs,
    counters: { ...counters, hostRestarts: Math.max(counters.hostRestarts, readRestartTotal(host.dbPath)) },
    divergence: host.divergence.history().slice(-50),
    errors: host.journal.errors().slice(-50),
    store: {
      databaseBytes: fileSize(host.dbPath),
      walBytes: fileSize(`${host.dbPath}-wal`),
      documents,
      projects: store.listProjects().length,
    },
  };
}

/** Unclean exits recorded on this database over all runs (telemetry.ts openRunLedger). */
function readRestartTotal(dbPath: string): number {
  try {
    const parsed = JSON.parse(readFileSync(`${dbPath}.runs.json`, "utf8")) as { unclean?: unknown };
    return typeof parsed.unclean === "number" ? parsed.unclean : 0;
  } catch {
    return 0;
  }
}

function hostOf(runtime: CollabRuntime): CollabHost {
  try {
    return runtime.host;
  } catch {
    throw new ControlError(503, "host-unavailable", "The collaboration service is starting. Try again in a moment.");
  }
}

export function registerDiagnosticsRoutes(router: Router, runtime: CollabRuntime): void {
  router.add("GET", ControlRoutes.diagnostics, () => {
    hostOf(runtime);
    return { body: scrubDiagnostics(buildDiagnostics(runtime)) };
  });

  router.add("POST", ControlRoutes.divergenceCheck, async () => {
    const host = hostOf(runtime);
    if (!host.api) throw new ControlError(409, "needs-sign-in", "Sign in to the collaboration server first.");
    const records = await host.divergence.checkAll();
    return { body: scrubDiagnostics(records) };
  });
}
