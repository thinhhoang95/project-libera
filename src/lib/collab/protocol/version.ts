// Version numbers shared by the desktop app and the collab server.
//
// PROTOCOL_VERSION changes when the wire format changes. The server rejects
// clients below its minimum (close code 4026), and the app offers an update.
// DOC_SCHEMA_VERSION changes when the shape of the Yjs documents changes. A
// client that sees a newer schemaVersion in a document's meta opens it
// read-only.

export const PROTOCOL_VERSION = 1;
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;
export const DOC_SCHEMA_VERSION = 1;

/** WebSocket close codes used by the sync service. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  /** Generic protocol violation. */
  ProtocolError: 4000,
  /** The access token expired or is invalid; refresh and reconnect. */
  AuthExpired: 4001,
  /** The account was disabled or signed out everywhere. */
  AuthRevoked: 4002,
  /** Access to the project was revoked (sent per doc as `closed`, or for the socket). */
  AccessRevoked: 4003,
  /** The client's protocol version is below the server minimum. */
  ClientTooOld: 4026,
  /** Admission control: too many connections; retry with backoff. */
  RateLimited: 4029,
  /** Server is shutting down or restarting; reconnect with backoff. */
  ServerRestart: 4050,
} as const;

export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Client-side batching and protection limits (§4 of the source plan). */
export const SyncLimits = {
  batchWindowMs: 30,
  /** Clients stop merging queued updates into one batch past this size. */
  batchMaxBytes: 256 * 1024,
  /**
   * Largest single update the server accepts. A Yjs update cannot be split
   * after the fact, so editors split very large pastes into several
   * transactions; this limit only stops runaway clients.
   */
  maxUpdateBytes: 4 * 1024 * 1024,
  /** Largest WebSocket frame either side sends. */
  maxFrameBytes: 8 * 1024 * 1024,
  awarenessTimeoutMs: 30_000,
  awarenessHeartbeatMs: 15_000,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  pingIntervalMs: 20_000,
} as const;
