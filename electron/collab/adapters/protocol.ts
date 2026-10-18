// Messages between Electron main (electron/collab-host.cjs) and the host
// utilityProcess over process.parentPort. Keep both sides in step: the main
// side is plain JavaScript and mirrors these shapes.

import type { HostEvent } from "../../../src/lib/collab/local-api";

/** Bumped when these messages change incompatibly. */
export const PARENT_PROTOCOL_VERSION = 1;

export interface StartMessage {
  t: "start";
  protocol: number;
  /** Electron app.getPath("userData"); the host keeps its files in <userData>/collab. */
  userData: string;
  /** LIBERA_DATA_DIR; shared notebooks live under <dataDir>/users/admin. */
  dataDir: string;
  appVersion: string;
  /** Port to listen on (0 = any). Main keeps it stable across restarts so Next's URL stays valid. */
  port: number;
  /** Per-launch bearer token chosen by main, reused across restarts. */
  token: string;
}

export type MainToHost =
  | StartMessage
  /** Resume from sleep, screen unlock, network back: reconnect now. */
  | { t: "nudge" }
  | { t: "suspend" }
  | { t: "resume" }
  /** Flush and stop; the host answers shutdown-done and exits. */
  | { t: "shutdown"; id: number }
  /** A renderer replica; the MessagePortMain arrives in the event's ports. */
  | { t: "attach"; docId: string }
  | { t: "secret-result"; id: number; ok: true; value: string }
  | { t: "secret-result"; id: number; ok: false; error: string };

export type HostToMain =
  | { t: "ready"; protocol: number; url: string; port: number; storeSchemaVersion: number }
  | { t: "fatal"; message: string }
  | { t: "event"; event: HostEvent }
  | { t: "secret"; id: number; op: "encrypt" | "decrypt"; value: string }
  | { t: "shutdown-done"; id: number; error?: string };
