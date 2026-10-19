// The "Report sync problem" bundle: ControlRoutes.diagnostics on the collab host's
// control API (electron/collab/control/routes-diagnostics.ts), shown and
// saved by the Collaboration dialog. Shared by the host and the renderer, so
// this file imports nothing at runtime.
//
// The bundle describes the sync machinery, never what is synced: ids,
// counts, states, sizes, versions and error codes. No document text, file
// names, comment bodies, emails or tokens (see scrubDiagnostics in the host).

/** Bumped when the bundle's shape changes, so support tooling can tell versions apart. */
export const DIAGNOSTICS_FORMAT = 1;

export interface DiagnosticsTransition {
  /** Epoch ms. */
  at: number;
  /** The sync client's ConnectionState (idle, connecting, connected, backoff, …). */
  state: string;
}

export interface DiagnosticsError {
  at: number;
  /** Where it came from: "host", "sync", "reject", "command", "divergence". */
  source: string;
  /** A short machine code when there is one (server error code, reject reason). */
  code?: string;
  /** The message, scrubbed and truncated. */
  message: string;
  docId?: string;
}

export type DivergenceOutcome =
  /** Same state vector and same content hash as the server. */
  | "match"
  /** Same state vector, different content: a real divergence. */
  | "mismatch"
  /** The state vectors differ (edits in flight); checked again later. */
  | "inconclusive"
  /** Not checked: local edits are waiting for an ack, the doc is read-only, or the request failed. */
  | "skipped";

export interface DivergenceRecord {
  docId: string;
  at: number;
  outcome: DivergenceOutcome;
  /** Why a check was skipped, or how a mismatch was handled. */
  detail?: string;
  /** For a mismatch: whether the full re-open made the replica match again. */
  recovered?: boolean;
}

export interface DiagnosticsDoc {
  docId: string;
  kind: string;
  projectId: string | null;
  /** The hub is open in this process now. */
  open: boolean;
  /** SyncState when open. */
  state?: string;
  pending: number;
  oldestPendingAgeMs: number;
  lastAckAt: number | null;
  readOnlyReason: string | null;
  lastSeenServerSeq: number;
  /** Reasons of rejected edits waiting for the user ("Copy my unsynced text"). */
  rejected: string[];
  lastDivergence?: DivergenceRecord;
}

export interface DiagnosticsCounters {
  reconnects: number;
  /** Total seconds spent between losing and regaining the connection. */
  reconnectSeconds: number;
  rejects: Record<string, number>;
  divergenceChecks: number;
  divergenceFailures: number;
  /** Times the host started after an unclean exit (crash or kill) on this database. */
  hostRestarts: number;
  telemetryReportsSent: number;
}

export interface HostDiagnostics {
  format: number;
  generatedAt: number;
  hostVersion: number;
  appVersion: string;
  protocolVersion: number;
  os: { platform: string; release: string; arch: string };
  runtime: { node: string; electron?: string };
  connection: {
    /** HostConnection as the UI shows it. */
    current: string;
    /** The sync client's last 50 state changes, oldest first. */
    history: DiagnosticsTransition[];
  };
  account: { signedIn: boolean; accountId: string | null; serverUrl: string | null };
  pending: {
    /** Unacked local updates over every document. */
    unackedUpdates: number;
    oldestUnackedSeconds: number;
    /** Offline comment and decision commands waiting to be sent. */
    commands: number;
    docsWithUnacked: number;
  };
  projects: Array<{ projectId: string; role: string; revoked: boolean; reconcilePending: number; docs: number }>;
  docs: DiagnosticsDoc[];
  counters: DiagnosticsCounters;
  divergence: DivergenceRecord[];
  errors: DiagnosticsError[];
  store: { databaseBytes: number; walBytes: number; documents: number; projects: number };
}
