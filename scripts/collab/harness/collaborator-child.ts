// One collaborator per process, for the "20 active collaborators" check.
// Twenty hosts in one Node process share one event loop and one SQLite
// writer thread, which measures the test process, not the product; separate
// processes behave like separate machines (they still share this CPU).
//
// The child opens the doc, types "<tag:index>\n" markers at random lines at
// `editsPerSecond` for `durationMs` once the parent writes "go" on stdin,
// and reports on stdout:
//   t <marker> <epochMs> <commitMs>   typed (after the SQLite commit)
//   r <marker> <epochMs>              a remote marker became visible here
//   h <sha256> <length> <pending>     the text after typing ended (on change)
// Timestamps are performance.timeOrigin + performance.now(), comparable
// across processes on one machine.
//
// Config: one JSON argument (CollaboratorConfig).

import { createHash } from "node:crypto";
import { writeSync } from "node:fs";

import { CollabHost } from "../../../electron/collab/core/host";
import type { AuthResponse } from "../../../src/lib/collab/protocol/api";
import { TokenSession, harnessLogger } from "./cluster";
import { markersInUpdate } from "./markers";
import { syncUrlOf } from "./server-reader";
import { MarkerTypist, seededRandom } from "./typist";

export interface CollaboratorConfig {
  dbPath: string;
  installationId: string;
  accountId: string;
  linkUrl: string;
  auth: AuthResponse;
  docId: string;
  projectId: string;
  tag: string;
  editsPerSecond: number;
  durationMs: number;
  seed: number;
}

const now = () => performance.timeOrigin + performance.now();

function line(text: string): void {
  writeSync(1, `${text}\n`);
}

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "") as CollaboratorConfig;
  const session = new TokenSession(config.auth);
  const host = new CollabHost({
    dbPath: config.dbPath,
    appVersion: "harness-collaborator",
    installationId: config.installationId,
    logger: harnessLogger(`collab:${config.tag}`),
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
  hub.observe("content", (change) => {
    if (change.origin !== "remote" && change.origin !== "server") return;
    const at = now();
    for (const marker of markersInUpdate(change.update)) line(`r ${marker} ${at.toFixed(3)}`);
  });
  await new Promise<void>((resolve) => {
    const check = () => (hub.getStatus().state === "saved-remote" ? resolve() : setTimeout(check, 10));
    check();
  });
  line("ready");
  // Every collaborator starts typing when the parent writes "go" (a common start).
  await new Promise<void>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (chunk.includes("go")) resolve();
    });
  });

  const random = seededRandom(config.seed);
  const typist = new MarkerTypist(() => hub, config.tag, "random", random);
  const deadline = Date.now() + config.durationMs;
  const meanGapMs = 1000 / config.editsPerSecond;
  while (Date.now() < deadline) {
    const started = now();
    const marker = typist.type();
    line(`t ${marker} ${started.toFixed(3)} ${(now() - started).toFixed(3)}`);
    // Exponential gaps: people type in bursts.
    await new Promise((resolve) => setTimeout(resolve, -Math.log(1 - random()) * meanGapMs));
  }
  line("typed");
  let last = "";
  const report = () => {
    const text = hub.getText();
    const digest = `${createHash("sha256").update(text).digest("hex")} ${text.length} ${hub.pendingCount}`;
    if (digest !== last) {
      last = digest;
      line(`h ${digest}`);
    }
  };
  setInterval(report, 100);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
