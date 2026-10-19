// Phase 4 server routes and metrics: the document digest (divergence check),
// client telemetry, the CLI's internal routes, HTTP and storage metrics.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";

import * as Y from "yjs";

import { TelemetryStore } from "../src/admin/telemetry.js";
import { newId } from "../src/ids.js";
import { canonicalJson, ManifestKeys, type DocumentDigest, type TelemetryReport } from "../src/protocol.js";
import { Registry } from "prom-client";
import { edit, startCollab, waitUntil, type CollabEnv } from "./support/decisions-env.js";

let env: CollabEnv;

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function metrics(): Promise<string> {
  const response = await fetch(`${env.server.url}/metrics`);
  assert.equal(response.status, 200);
  return response.text();
}

function metric(text: string, name: string): number | undefined {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${name} `) || candidate.startsWith(`${name}{`));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(" ") + 1));
}

function report(overrides: Partial<TelemetryReport> = {}): TelemetryReport {
  return {
    clientId: "cli_telemetry_test_1",
    appVersion: "6.5.0",
    protocolVersion: 1,
    pendingUpdates: 0,
    oldestUnackedSeconds: 0,
    pendingCommands: 0,
    openDocuments: 1,
    reconnects: 0,
    rejects: {},
    divergenceChecks: 0,
    divergenceFailures: 0,
    ...overrides,
  };
}

before(async () => {
  env = await startCollab({ ROOM_IDLE_MS: 50 });
});
after(() => env.close());

describe("document digest", () => {
  test("matches the client's text hash and state vectors, live and unloaded", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "Hello digest");
    await edit(client, docId, 0, 0, "¡");
    const live = await env.api("GET", `/v1/documents/${docId}/digest`, env.viewer);
    assert.equal(live.status, 200);
    const digest = live.body as DocumentDigest;
    assert.equal(digest.kind, "markdown");
    assert.equal(digest.contentSha256, sha("¡Hello digest"));
    assert.equal(digest.serverSeq, 2);
    assert.equal(digest.stateVectors.content, b64(Y.encodeStateVector(client.doc(docId, "content"))));
    assert.deepEqual(Object.keys(digest.stateVectors).sort(), ["annotations", "content", "meta"]);

    await client.close();
    await waitUntil(() => !env.server.server.context.rooms.isLoaded(docId), "room did not unload", 5000);
    const cold = await env.api("GET", `/v1/documents/${docId}/digest`, env.editor);
    assert.deepEqual(cold.body, digest);
    assert.equal(env.server.server.context.rooms.isLoaded(docId), false, "a digest does not load the room");

    const outsider = await env.api("GET", `/v1/documents/${docId}/digest`, null);
    assert.equal(outsider.status, 401);
    const stranger = await env.member("viewer");
    await env.db.deleteFrom("memberships").where("account_id", "=", stranger.id).execute();
    assert.equal((await env.api("GET", `/v1/documents/${docId}/digest`, stranger)).status, 404);
  });

  test("hashes the manifest's files map as canonical JSON", async () => {
    const entry = { fileId: newId("fil"), path: "a.md", kind: "doc", docId: "doc_x", createdBy: env.owner.id, createdAt: 1, updatedAt: 2 };
    await env.server.server.context.rooms.transact(env.project.manifestDocId, "manifest", { kind: "system", reason: "import" }, { source: "import" }, (doc) =>
      doc.getMap(ManifestKeys.files).set(entry.fileId, entry),
    );
    const response = await env.api("GET", `/v1/documents/${env.project.manifestDocId}/digest`, env.viewer);
    assert.equal(response.status, 200);
    assert.equal(response.body.kind, "manifest");
    assert.equal(response.body.contentSha256, sha(canonicalJson({ [entry.fileId]: entry })));
    assert.deepEqual(Object.keys(response.body.stateVectors), ["manifest"]);
  });
});

describe("telemetry", () => {
  test("accepts counts, exports aggregate gauges and counters, and validates", async () => {
    const post = (account: typeof env.editor | null, body: unknown) => env.api("POST", "/v1/telemetry", account, body);
    assert.equal((await post(null, report())).status, 401);
    assert.equal((await post(env.editor, { ...report(), pendingUpdates: "lots" })).status, 400);
    assert.equal((await post(env.editor, { ...report(), clientId: "x" })).status, 400);
    assert.equal((await post(env.editor, { ...report(), rejects: { nonsense: 1 } })).status, 400);

    const ok = await post(env.editor, report({ pendingUpdates: 3, oldestUnackedSeconds: 400, reconnects: 2, rejects: { forbidden: 1 }, divergenceChecks: 4, divergenceFailures: 1, reconnectSeconds: 12.5, hostRestarts: 1 }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.nextReportSeconds, 60);
    await post(env.editor2, report({ clientId: "cli_telemetry_test_2", pendingUpdates: 1, oldestUnackedSeconds: 10 }));

    const text = await metrics();
    assert.equal(metric(text, "libera_client_reporting"), 2);
    assert.equal(metric(text, "libera_client_pending_updates"), 4);
    assert.equal(metric(text, "libera_client_oldest_unacked_seconds"), 400);
    assert.equal(metric(text, "libera_client_stale_unacked_clients"), 1);
    assert.equal(metric(text, "libera_client_reconnects_total"), 2);
    assert.equal(metric(text, "libera_client_divergence_checks_total"), 4);
    assert.equal(metric(text, "libera_client_divergence_failures_total"), 1);
    assert.equal(metric(text, "libera_client_disconnected_seconds_total"), 12.5);
    assert.equal(metric(text, "libera_client_host_restarts_total"), 1);
    assert.match(text, /libera_client_rejects_total\{reason="forbidden"\} 1/);
    assert.doesNotMatch(text, new RegExp(env.editor.id), "no account ids in labels");

    // A later report from the same installation replaces its gauges.
    await post(env.editor, report({ pendingUpdates: 0, oldestUnackedSeconds: 0 }));
    assert.equal(metric(await metrics(), "libera_client_stale_unacked_clients"), 0);
  });

  test("is rate limited per account", async () => {
    const account = await env.member("editor");
    const statuses: number[] = [];
    for (let index = 0; index < 8; index += 1) statuses.push((await env.api("POST", "/v1/telemetry", account, report({ clientId: "cli_rate_limited_1" }))).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429, 429]);
  });

  test("installations that stop reporting drop out of the gauges", () => {
    let now = 1_000_000;
    const store = new TelemetryStore(new Registry(), () => now);
    store.record("acc_1", { ...report(), oldestUnackedSeconds: 900 });
    assert.equal(store.live().length, 1);
    now += 16 * 60_000;
    assert.equal(store.live().length, 0);
  });
});

describe("internal routes and metrics", () => {
  test("internal admin routes answer loopback only, without proxy headers, and with METRICS_TOKEN when set", async () => {
    const docId = env.docId;
    const ok = await fetch(`${env.server.url}/internal/admin/rooms/${docId}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { docId, loaded: false });
    const proxied = await fetch(`${env.server.url}/internal/admin/rooms/${docId}`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    assert.equal(proxied.status, 403);

    env.server.server.context.config.METRICS_TOKEN = "metrics-secret";
    try {
      assert.equal((await fetch(`${env.server.url}/internal/admin/rooms/${docId}`)).status, 403);
      const authorized = await fetch(`${env.server.url}/internal/admin/rooms/${docId}`, { headers: { authorization: "Bearer metrics-secret" } });
      assert.equal(authorized.status, 200);
    } finally {
      env.server.server.context.config.METRICS_TOKEN = undefined;
    }
  });

  test("HTTP latency per route pattern, sync connections, storage and job gauges are exported", async () => {
    const client = await env.connect(env.editor);
    const docId = await env.document(client, "metrics");
    await env.api("GET", `/v1/documents/${docId}`, env.editor);
    await env.server.server.jobs.runNow("storage-metrics");
    const text = await metrics();
    assert.match(text, /libera_http_request_duration_seconds_count\{method="GET",route="\/v1\/documents\/:docId",status="2xx"\} \d+/);
    assert.doesNotMatch(text, new RegExp(`route="[^"]*${docId}`), "ids never become labels");
    assert.ok((metric(text, 'libera_sync_connections_total{outcome="accepted"}') ?? 0) >= 1);
    assert.ok((metric(text, "libera_storage_log_updates") ?? 0) >= 1);
    assert.ok(metric(text, "libera_storage_snapshots") !== undefined);
    assert.ok(metric(text, "libera_storage_compaction_lag_updates") !== undefined);
    assert.match(text, /libera_storage_doc_log_bytes\{doc_id="[^"]+"\} \d+/);
    assert.ok(metric(text, "libera_storage_quarantined_updates") !== undefined);
    // The job gauge is labelled "name": a "job" label would be renamed to
    // exported_job by Prometheus, which owns "job" for the scrape target.
    assert.match(text, /libera_job_last_success_timestamp_seconds\{name="storage-metrics"\} \d/);
    assert.doesNotMatch(text, /libera_job_last_success_timestamp_seconds\{job=/);
  });
});
