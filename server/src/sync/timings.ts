// Connection timers of the sync service. A mutable object rather than config
// because they are protocol behaviour, not deployment settings; tests shorten
// them to exercise the timeouts without waiting.

import { SyncLimits } from "../protocol.js";

export const SyncTimings = {
  /** The first frame must be `hello` within this time (close 4000). */
  helloTimeoutMs: 10_000,
  /** A socket may keep syncing this long past its token's expiry while it refreshes. */
  tokenGraceMs: 60_000,
  /** Sockets that send nothing (not even a ping) for this long are dropped. */
  silentSocketMs: 3 * SyncLimits.pingIntervalMs + 30_000,
  sweepIntervalMs: 30_000,
};
