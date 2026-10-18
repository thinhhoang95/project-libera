// Host telemetry (electron/collab/core/telemetry.ts) against the real collab
// server: increments since the last accepted report, the server's metrics
// counting them, failed and rate-limited reports folding into the next one,
// nothing sent while signed out, no content in the payload, and host
// restarts detected from the run marker.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { FetchLike } from "../../electron/collab/core/api-client";
import { CollabHost } from "../../electron/collab/core/host";
import { HostJournal, scrubText, TELEMETRY_REJECT_REASONS } from "../../electron/collab/core/telemetry";
import { ContentKeys } from "../../src/lib/collab/protocol/schema";
import { createDocument, createTeam, filteringSockets, makeHost, quietLogger, until } from "./p4d-support";
import { removeDataDir, startServerProcess, type ServerProcess } from "./support/server-process";

let server: ServerProcess;
let dir: string;
const hosts: CollabHost[] = [];

before(async () => {
  server = await startServerProcess();
  dir = mkdtempSync(path.join(tmpdir(), "libera-p4d-tel-"));
});

after(async () => {
  for (const host of hosts) await host.stop().catch(() => {});
  await server?.stop();
  removeDataDir(server?.dataDir ?? "");
  rmSync(dir, { recursive: true, force: true });
});

/** A fetch that records telemetry posts and can be told to fail. */
function recordingFetch() {
  const state = { fail: 0 as number, posts: [] as unknown[] };
  const fetchImpl: FetchLike = async (url, init) => {
    if (url.endsWith("/v1/telemetry")) {
      state.posts.push(JSON.parse(String(init.body)));
      if (state.fail) return new Response(JSON.stringify({ error: { code: "internal", message: "down" } }), { status: state.fail });
    }
    return fetch(url, init);
  };
  return { state, fetch: fetchImpl };
}

async function metric(name: string, labels = ""): Promise<number> {
  const response = await fetch(`${server.url}/metrics`);
  const body = await response.text();
  const line = body.split("\n").find((entry) => entry.startsWith(`${name}${labels} `) || (labels === "" && entry.startsWith(`${name} `)));
  return line ? Number(line.split(" ").at(-1)) : 0;
}

const ALLOWED_KEYS = [
  "appVersion",
  "clientId",
  "divergenceChecks",
  "divergenceFailures",
  "hostRestarts",
  "oldestUnackedSeconds",
  "openDocuments",
  "pendingCommands",
  "pendingUpdates",
  "protocolVersion",
  "reconnectSeconds",
  "reconnects",
  "rejects",
].sort();

test("reports increments since the last accepted report; the server counts them", { timeout: 120_000 }, async () => {
  const team = await createTeam(server);
  const docId = "doc_p4d_tel_main";
  await createDocument(server, team, docId);
  const sockets = filteringSockets();
  const recorder = recordingFetch();
  const host = makeHost(dir, "tel-main", server, team.alice, {
    webSocketFactory: sockets.factory,
    fetch: recorder.fetch,
    telemetry: { initialDelayMs: 3_600_000, minIntervalMs: 0 },
  });
  hosts.push(host);
  const hub = host.acquire(docId, { kind: "file" });
  const secret = "TOP-SECRET-DOCUMENT-TEXT 4242";
  hub.applyLocalChange("content", (doc) => doc.getText(ContentKeys.source).insert(0, secret), { source: "typing" });
  await until(() => hub.getStatus().state === "saved-remote", "saved");

  // A dropped connection that comes back is one reconnect.
  sockets.dropConnection();
  await until(() => host.journal.counters().reconnects === 1 && host.connectionState === "connected", "the reconnect");
  host.journal.noteReject("too-large");
  host.journal.noteReject("too-large");
  host.journal.noteReject("not-a-server-reason");

  const before = {
    reconnects: await metric("libera_client_reconnects_total"),
    tooLarge: await metric("libera_client_rejects_total", '{reason="too-large"}'),
    reports: await metric("libera_client_reports_total"),
  };
  const report = host.telemetry.buildReport();
  assert.ok(report);
  assert.deepEqual(Object.keys(report).sort(), ALLOWED_KEYS, "only the contract's fields (plus two counters)");
  assert.equal(report.reconnects, 1);
  assert.deepEqual(report.rejects, { "too-large": 2 }, "unknown reasons are not sent");
  assert.equal(report.openDocuments, 1);
  assert.equal(report.pendingUpdates, 0);
  assert.equal(report.appVersion, "0.0.0-test");
  assert.ok(report.reconnectSeconds >= 0);

  assert.equal(await host.telemetry.reportNow(), "sent");
  const sent = JSON.stringify(recorder.state.posts.at(-1));
  for (const forbidden of [secret, "TOP-SECRET", docId, team.projectId, team.alice.account.email, team.alice.accessToken]) {
    assert.ok(!sent.includes(forbidden), `the payload must not contain ${forbidden.slice(0, 20)}`);
  }
  assert.equal(await metric("libera_client_reconnects_total"), before.reconnects + 1, "the server counted the reconnect");
  assert.equal(await metric("libera_client_rejects_total", '{reason="too-large"}'), before.tooLarge + 2);
  assert.equal(await metric("libera_client_reports_total"), before.reports + 1);

  // Accepted counts are not sent again.
  const next = host.telemetry.buildReport();
  assert.equal(next?.reconnects, 0);
  assert.deepEqual(next?.rejects, {});
  host.journal.noteReject("too-large");
  assert.deepEqual(host.telemetry.buildReport()?.rejects, { "too-large": 1 });

  // A failed report keeps its counts for the next one.
  recorder.state.fail = 503;
  assert.equal(await host.telemetry.reportNow(), "failed");
  host.journal.noteReject("too-large");
  recorder.state.fail = 0;
  assert.equal(await host.telemetry.reportNow(), "sent");
  assert.deepEqual((recorder.state.posts.at(-1) as { rejects: unknown }).rejects, { "too-large": 2 }, "the failed report's count was folded in");
  assert.equal(host.journal.counters().telemetryReportsSent, 2);
});

test("respects the server's rate limit and stops asking until retry-after", { timeout: 120_000 }, async () => {
  const team = await createTeam(server);
  const recorder = recordingFetch();
  const host = makeHost(dir, "tel-limit", server, team.alice, {
    fetch: recorder.fetch,
    telemetry: { initialDelayMs: 3_600_000, minIntervalMs: 0 },
  });
  hosts.push(host);
  await until(() => host.connectionState === "connected", "connected");
  const outcomes: string[] = [];
  for (let index = 0; index < 7; index++) outcomes.push(await host.telemetry.reportNow());
  assert.deepEqual(outcomes, ["sent", "sent", "sent", "sent", "sent", "sent", "rate-limited"], "6 per minute per account");
  const posts = recorder.state.posts.length;
  assert.equal(await host.telemetry.reportNow(), "rate-limited");
  assert.equal(recorder.state.posts.length, posts, "no request while the server said to wait");
});

test("the schedule sends reports on its own, never closer than minIntervalMs", { timeout: 60_000 }, async () => {
  const team = await createTeam(server);
  const recorder = recordingFetch();
  const host = makeHost(dir, "tel-schedule", server, team.alice, {
    fetch: recorder.fetch,
    telemetry: { initialDelayMs: 50, intervalMs: 60_000, minIntervalMs: 10_000 },
  });
  hosts.push(host);
  await until(() => recorder.state.posts.length === 1, "the first scheduled report");
  assert.equal(await host.telemetry.reportNow(), "too-soon");
  assert.equal(recorder.state.posts.length, 1);
});

test("off while signed out: no request at all", async () => {
  const recorder = recordingFetch();
  const host = new CollabHost({
    dbPath: path.join(dir, "tel-signed-out.sqlite"),
    appVersion: "test",
    installationId: "inst_tel_signed_out",
    logger: quietLogger,
    compaction: false,
    fetch: recorder.fetch,
    telemetry: { initialDelayMs: 10, minIntervalMs: 0 },
    divergence: false,
  });
  hosts.push(host);
  host.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await host.telemetry.reportNow(), "signed-out");
  assert.equal(host.telemetry.buildReport(), null);
  assert.equal(recorder.state.posts.length, 0);
});

test("host restarts: a leftover run marker counts one unclean exit", async () => {
  const dbPath = path.join(dir, "tel-restarts.sqlite");
  const options = { dbPath, appVersion: "test", installationId: "inst_tel_restarts", logger: quietLogger, compaction: false as const, telemetry: false as const, divergence: false as const };
  const first = new CollabHost(options);
  first.start();
  assert.equal(first.journal.counters().hostRestarts, 0);
  assert.ok(existsSync(`${dbPath}.running`), "a running host leaves a marker");
  await first.stop();
  assert.ok(!existsSync(`${dbPath}.running`), "a clean stop removes it");

  // As if the host had been killed: the marker is still there at the next start.
  writeFileSync(`${dbPath}.running`, JSON.stringify({ pid: 1, startedAt: 0 }));
  const second = new CollabHost(options);
  second.start();
  assert.equal(second.journal.counters().hostRestarts, 1);
  assert.deepEqual(JSON.parse(readFileSync(`${dbPath}.runs.json`, "utf8")), { unclean: 1 });
  await second.stop();

  const third = new CollabHost(options);
  third.start();
  assert.equal(third.journal.counters().hostRestarts, 0, "after a clean stop nothing is counted");
  await third.stop();
});

test("journal: reconnect durations, history limit and scrubbed errors", () => {
  let now = 1_000;
  const journal = new HostJournal({ now: () => now, setTimeout: () => null, clearTimeout: () => {} });
  journal.noteConnection("connecting");
  journal.noteConnection("connected");
  now += 4_000;
  journal.noteConnection("backoff");
  now += 6_000;
  journal.noteConnection("connecting");
  journal.noteConnection("connected");
  assert.equal(journal.counters().reconnects, 1);
  assert.equal(journal.counters().reconnectSeconds, 6);
  journal.noteConnection("stopped");
  journal.noteConnection("connected");
  assert.equal(journal.counters().reconnects, 1, "connecting again after a sign-out is not a reconnect");
  for (let index = 0; index < 60; index++) journal.noteConnection(index % 2 ? "connected" : "backoff");
  assert.equal(journal.history().length, 50);

  journal.noteError({ source: "sync", code: "x", message: "Bearer abc.def token=sekrit for ada@example.com at C:\\Users\\ada\\notes\\a.md eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl" });
  const [entry] = journal.errors();
  assert.ok(!/abc\.def|sekrit|ada@example|Users\\ada|eyJhbGci/.test(entry.message), entry.message);
  assert.ok(scrubText("x".repeat(1000)).length <= 300);
  assert.ok(TELEMETRY_REJECT_REASONS.includes("too-large"));
});
