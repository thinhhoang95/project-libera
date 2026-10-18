// Collab host entry point (Electron utilityProcess). For now it only exports
// the host core for bundling and reports that it started; the Electron
// adapter (parent-port protocol, MessagePortMain bridge, control API) wires
// CollabHost up in a later milestone.
//
// The compaction worker thread loads this same bundle, so the start-up
// message is sent only from the main thread.

import { isMainThread } from "node:worker_threads";

import { STORE_SCHEMA_VERSION } from "./core/store";

export * from "./core";

type ParentPort = { postMessage(message: unknown): void };

if (isMainThread) {
  (process as unknown as { parentPort?: ParentPort }).parentPort?.postMessage({
    t: "host-ready",
    version: 0,
    storeSchemaVersion: STORE_SCHEMA_VERSION,
  });
}
