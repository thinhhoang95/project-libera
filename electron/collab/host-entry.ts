// Collab host entry point: electron/collab/dist/host.cjs, run by
// electron/collab-host.cjs with utilityProcess.fork.
//
// In the utilityProcess it serves the control API and replica ports
// (adapters/utility.ts). The compaction worker thread loads this same bundle
// (see core/compaction-worker.ts), so the host starts only on the main thread
// and only when there is a parent port.

import { isMainThread } from "node:worker_threads";

import { UtilityHost, type ParentPortLike } from "./adapters/utility";

export * from "./core";

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (isMainThread && parentPort) {
  new UtilityHost(parentPort, {
    // Give the last messages (shutdown-done, fatal) a moment to leave the port.
    onExit: (code) => setTimeout(() => process.exit(code), 50),
  });
}
