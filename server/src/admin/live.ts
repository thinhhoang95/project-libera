// Talking to the running collab server from the admin CLI. Rewriting a
// document's storage (rebuild, quarantine) is only safe while no room holds
// the document in memory, because a loaded room keeps serving its own state;
// only the running server knows which rooms are loaded.

import type { Config } from "../config.js";
import { CliError } from "./history.js";
import { InternalRoutes, type RoomStatus } from "./routes.js";

export interface LiveServer {
  /** Base URL of the running server, e.g. http://127.0.0.1:4400. */
  url: string;
  token: string | undefined;
}

export function liveServer(config: Config, override: string | undefined): LiveServer {
  return { url: (override ?? `http://127.0.0.1:${config.PORT || 4400}`).replace(/\/$/, ""), token: config.METRICS_TOKEN };
}

function headers(server: LiveServer): Record<string, string> {
  return server.token ? { authorization: `Bearer ${server.token}` } : {};
}

function unreachable(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENOTFOUND";
}

/** The room status, or null when no server answers at the URL. */
export async function roomStatus(server: LiveServer, docId: string): Promise<RoomStatus | null> {
  let response: Response;
  try {
    response = await fetch(`${server.url}${InternalRoutes.room(docId)}`, { headers: headers(server), signal: AbortSignal.timeout(5000) });
  } catch (error) {
    if (unreachable(error)) return null;
    throw new CliError(`The server at ${server.url} did not answer: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new CliError(
      `The server at ${server.url} refused the room check (HTTP ${response.status}). Run the CLI inside the collab ` +
        "container (docker compose exec collab ...) so it connects over loopback, with the same METRICS_TOKEN.",
    );
  }
  return (await response.json()) as RoomStatus;
}

/**
 * Throws unless the document is not loaded on the running server, or the
 * operator states the server is stopped (--server-stopped).
 */
export async function requireRoomUnloaded(server: LiveServer, docId: string, serverStopped: boolean): Promise<"unloaded" | "stopped"> {
  const status = await roomStatus(server, docId);
  if (status === null) {
    if (serverStopped) return "stopped";
    throw new CliError(
      `No collab server answered at ${server.url}. If it is stopped, pass --server-stopped; if it runs elsewhere, ` +
        "pass --server <url>.",
    );
  }
  if (status.loaded) {
    throw new CliError(
      `Document ${docId} is loaded on the running server. Ask its collaborators to close it, then wait for the room ` +
        "to unload (ROOM_IDLE_MS after the last client leaves), or stop the server and pass --server-stopped.",
    );
  }
  return "unloaded";
}

/** Asks the running server to close an account's sockets. Returns false when no server answered. */
export async function revokeLiveSessions(server: LiveServer, accountId: string): Promise<boolean> {
  try {
    const response = await fetch(`${server.url}${InternalRoutes.revokeAccount(accountId)}`, {
      method: "POST",
      headers: headers(server),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch (error) {
    if (unreachable(error)) return false;
    throw error;
  }
}
