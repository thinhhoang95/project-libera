// A real CollabHost in its own process, for the kill cases of the
// durability matrix. It signs in, opens one doc and types markers
// ("<tag:index>\n") at the end of the text through applyLocalChange, syncing
// through its proxy link like any host. After each applyLocalChange returns,
// the edit is committed to SQLite, and only then the child prints
// "c <marker>" with writeSync (never buffered past a kill). The parent kills
// the process at a random moment and checks that every printed marker
// survived the restart and reaches the server.
//
// Config: one JSON argument (ChildHostConfig).

import { writeSync } from "node:fs";

import { CollabHost } from "../../../electron/collab/core/host";
import type { AuthResponse } from "../../../src/lib/collab/protocol/api";
import { appendMarker } from "./typist";
import { TokenSession, harnessLogger } from "./cluster";
import { syncUrlOf } from "./server-reader";

export interface ChildHostConfig {
  dbPath: string;
  installationId: string;
  accountId: string;
  /** Proxy link origin (http://127.0.0.1:port). */
  linkUrl: string;
  auth: AuthResponse;
  docId: string;
  projectId: string;
  tag: string;
  /** Markers to type before printing "done" (it keeps running until killed). */
  count: number;
  /** Pause between edits, so the network and acks interleave with typing. */
  intervalMs: number;
  /** Index of the first marker (a restarted child continues the sequence). */
  startIndex?: number;
}

function line(text: string): void {
  writeSync(1, `${text}\n`);
}

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "") as ChildHostConfig;
  const session = new TokenSession(config.auth);
  const host = new CollabHost({
    dbPath: config.dbPath,
    appVersion: "harness-child",
    installationId: config.installationId,
    logger: harnessLogger(`child:${config.tag}`),
    compaction: false,
    hubIdleMs: 60_000,
  });
  host.start();
  host.setAccount({
    accountId: config.accountId,
    serverUrl: config.linkUrl,
    syncUrl: syncUrlOf(config.linkUrl),
    tokenProvider: session.provider(() => config.linkUrl),
  });
  const hub = host.acquire(config.docId, { kind: "file", projectId: config.projectId });
  hub.onStatus((status) => line(`s ${status.state} ${status.pending}`));
  line("ready");
  const start = config.startIndex ?? 0;
  for (let index = start; index < start + config.count; index += 1) {
    const marker = `<${config.tag}:${index}>`;
    appendMarker(hub, `${marker}\n`);
    line(`c ${marker}`);
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
  line("done");
  // Keep syncing until the parent stops us.
  setInterval(() => undefined, 1 << 30);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
