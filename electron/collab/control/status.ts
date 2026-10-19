// HostStatus (local-api.ts) from the host's connection state.

import type { HostConnection } from "../../../src/lib/collab/local-api";
import type { ConnectionState } from "../core/sync-client";

/** Bumped when HostStatus or the control routes change incompatibly. */
export const HOST_VERSION = 1;

/**
 * The sync client's state, seen from the UI.
 * - idle/connecting: about to connect.
 * - backoff and stopped: no connection; editing continues locally.
 * - signed-out (close 4002, the session was revoked everywhere): the account
 *   is still configured on this machine, so the user has to sign in again.
 */
export function hostConnection(input: { hasAccount: boolean; needsSignIn: boolean; state: ConnectionState }): HostConnection {
  if (!input.hasAccount) return "signed-out";
  if (input.needsSignIn) return "needs-sign-in";
  switch (input.state) {
    case "idle":
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "backoff":
    case "stopped":
      return "offline";
    case "needs-sign-in":
    case "signed-out":
      return "needs-sign-in";
    case "update-required":
      return "update-required";
  }
}

export function connectionDetail(connection: HostConnection): string | undefined {
  switch (connection) {
    case "offline":
      return "The collaboration server is unreachable. Changes are kept on this device.";
    case "needs-sign-in":
      return "Sign in again to keep syncing. Changes are kept on this device.";
    case "update-required":
      return "Update Libera to keep syncing.";
    default:
      return undefined;
  }
}
