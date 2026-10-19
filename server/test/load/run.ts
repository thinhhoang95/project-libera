// Load generator for the collab server (implementation plan §7, source plan
// §10). Run from server/:
//
//   npm run load -- [options]
//   node --import tsx test/load/run.ts [options]
//
// It spawns a server (production settings, PGlite in a temp directory unless
// --database-url says otherwise) or targets --url, creates accounts, projects
// and documents through the REST API, then opens --clients simulated
// collaborators on each of --docs documents over the sync protocol, spread
// over worker threads. --typists of each document's clients type in bursts;
// all of them keep awareness alive. After --warmup seconds it measures for
// --duration seconds and prints:
//   - ack latency (send to ack: queue + persist + network), client side
//   - persist and fan-out latency from the server's histograms
//   - remote-visible latency (one client's send to another's receive)
//   - rejects, errors, unexpected closes
//   - server memory, CPU, event-loop lag, rooms and sockets
//
// Targeting a deployed server (--url) needs ALLOW_OPEN_SIGNUP=1 and higher
// SYNC_MAX_SOCKETS_PER_ACCOUNT and SYNC_CONNECTIONS_PER_MINUTE there; never
// point it at production.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import * as Y from "yjs";

import type { AuthResponse, Invitation, ProjectSummary } from "../../src/protocol.js";
import { Histogram } from "./histogram.js";
import { byLabel, histogramCount, histogramQuantile, parseMetrics, sample, total, type Samples } from "./prometheus.js";
import type { WorkerDoc, WorkerInput, WorkerStats } from "./worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..", "..");
const WORKER_BOOTSTRAP = `
  Promise.all([import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}), import(${JSON.stringify(import.meta.resolve("tsx/cjs/api"))})])
    .then(([esm, cjs]) => {
      esm.register();
      cjs.register();
      return import(${JSON.stringify(new URL("./worker.ts", import.meta.url).href)});
    });
`;

// ------------------------------------------------------------------ options

interface Options {
  url?: string;
  databaseUrl?: string;
  docs: number;
  clients: number;
  typists: number;
  cps: number;
  duration: number;
  warmup: number;
  workers: number;
  connectRate: number;
  docsPerProject: number;
  applyAllRemotes: boolean;
  metricsToken?: string;
  out?: string;
  password: string;
}

const HELP = `Usage: npm run load -- [options]
  --docs n            active documents (default 200)
  --clients n         collaborators per document (default 20)
  --typists n         of those, typing in bursts (default 3)
  --cps n             characters per second while typing (default 5)
  --duration s        measured seconds (default 60)
  --warmup s          seconds after ramp-up before measuring (default 10)
  --workers n         worker threads (default: half the CPUs, max 8)
  --connect-rate n    new sockets per second, total (default 200)
  --docs-per-project n  (default 10)
  --apply typists|all which clients apply remote updates (default all)
  --url <http url>    target a running server instead of spawning one
  --database-url <u>  database for the spawned server (default: PGlite in a temp dir)
  --metrics-token <t> bearer token for /metrics on --url
  --out <file.json>   write the full results
`;

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}\n${HELP}`);
    const [key, inline] = arg.slice(2).split("=", 2);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    values.set(key, value);
  }
  const int = (key: string, fallback: number) => {
    const value = values.get(key);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${key} must be a number`);
    return parsed;
  };
  const clients = int("clients", 20);
  return {
    url: values.get("url")?.replace(/\/$/, ""),
    databaseUrl: values.get("database-url"),
    docs: int("docs", 200),
    clients,
    typists: Math.min(int("typists", 3), clients),
    cps: int("cps", 5),
    duration: int("duration", 60),
    warmup: int("warmup", 10),
    workers: Math.max(1, int("workers", Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2))))),
    connectRate: Math.max(1, int("connect-rate", 200)),
    docsPerProject: Math.max(1, int("docs-per-project", 10)),
    applyAllRemotes: (values.get("apply") ?? "all") === "all",
    metricsToken: values.get("metrics-token"),
    out: values.get("out"),
    password: "load-test-password-not-secret",
  };
}

// ------------------------------------------------------------------ server

interface Target {
  url: string;
  database: string;
  stop(): Promise<void>;
}

async function spawnServer(options: Options): Promise<Target> {
  const dataDir = options.databaseUrl ? null : mkdtempSync(join(tmpdir(), "libera-load-"));
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", join(here, "server.ts")], {
    cwd: serverDir,
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl ?? `pglite://${join(dataDir as string, "pglite")}`,
      BLOB_DIR: join(dataDir ?? tmpdir(), "blobs"),
      JWT_SECRET: randomBytes(32).toString("base64url"),
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout! });
  const started = await new Promise<{ url: string; database: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The server did not start within 60 s")), 60_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(JSON.parse(line) as { url: string; database: string });
    });
    child.once("exit", (code) => reject(new Error(`The server exited with ${code}`)));
  });
  let stopping = false;
  child.on("exit", (code, signal) => {
    if (!stopping) process.stderr.write(`[load] the server exited unexpectedly (code ${code}, signal ${signal})\n`);
  });
  return {
    ...started,
    async stop() {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) {
        if (dataDir) rmSync(dataDir, { recursive: true, force: true });
        return;
      }
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin?.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await exited;
      clearTimeout(timer);
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// ------------------------------------------------------------------ setup

async function api<T>(base: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function account(base: string, index: number, password: string): Promise<{ id: string; token: string; email: string }> {
  const email = `load-${index}@load.libera.test`;
  const registered = await api<AuthResponse>(base, "POST", "/v1/auth/register", { email, password, displayName: `Load ${index}` });
  if (registered.status === 201) return { id: registered.body.account.id, token: registered.body.accessToken, email };
  const login = await api<AuthResponse>(base, "POST", "/v1/auth/login", { email, password });
  if (login.status !== 200) throw new Error(`Cannot register or sign in ${email}: ${registered.status} / ${login.status}`);
  return { id: login.body.account.id, token: login.body.accessToken, email };
}

function initialContent(index: number): string {
  const paragraph =
    "Collaborative editing keeps every replica convergent while people type at the same time. " +
    "This paragraph is filler text so the document has a realistic size for the load test.\n\n";
  return `# Load document ${index}\n\n${paragraph.repeat(20)}`;
}

function encodeInitial(text: string): string {
  const doc = new Y.Doc();
  doc.getText("source").insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

async function setup(base: string, options: Options): Promise<WorkerDoc[]> {
  const accounts = [];
  for (let index = 0; index < options.clients; index += 1) accounts.push(await account(base, index, options.password));
  const [owner, ...others] = accounts;
  const docs: WorkerDoc[] = [];
  const runId = randomBytes(4).toString("hex");
  for (let start = 0; start < options.docs; start += options.docsPerProject) {
    const project = await api<ProjectSummary>(base, "POST", "/v1/projects", { name: `Load ${runId} ${start}` }, owner.token);
    if (project.status !== 201) throw new Error(`Create project failed: ${project.status}`);
    for (const member of others) {
      const invitation = await api<Invitation>(base, "POST", `/v1/projects/${project.body.id}/invitations`, { email: member.email, role: "editor" }, owner.token);
      if (invitation.status !== 201 || !invitation.body.token) throw new Error(`Invite failed: ${invitation.status}`);
      const accepted = await api(base, "POST", `/v1/invitations/token/${encodeURIComponent(invitation.body.token)}/accept`, {}, member.token);
      if (accepted.status !== 200) throw new Error(`Accept failed: ${accepted.status}`);
    }
    for (let index = start; index < Math.min(options.docs, start + options.docsPerProject); index += 1) {
      const docId = `doc_load_${runId}_${index}`;
      const created = await api(base, "POST", `/v1/projects/${project.body.id}/documents`, {
        docId,
        fileId: `fil_load_${runId}_${index}`,
        kind: "markdown",
        initial: { content: encodeInitial(initialContent(index)) },
      }, owner.token);
      if (created.status !== 201) throw new Error(`Create document failed: ${created.status} ${JSON.stringify(created.body)}`);
      docs.push({
        docId,
        clients: accounts.map((entry, position) => ({ token: entry.token, name: `Load ${position}`, typist: position < options.typists })),
      });
    }
  }
  return docs;
}

// ------------------------------------------------------------------ metrics

async function scrape(base: string, token?: string): Promise<Samples> {
  // An overloaded server may answer slowly; retry before giving up.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${base}/metrics`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`GET /metrics returned ${response.status}`);
      return parseMetrics(await response.text());
    } catch (error) {
      lastError = error;
      const cause = String((error as { cause?: unknown }).cause ?? "");
      process.stderr.write(`[load] /metrics failed (${(error as Error).message} ${cause}), retrying\n`);
      await sleep(2000);
    }
  }
  throw lastError;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ms = (seconds: number | null) => (seconds === null ? null : Math.round(seconds * 100_000) / 100);

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const log = (line: string) => process.stderr.write(`[load] ${line}\n`);
  const target: Target = options.url
    ? { url: options.url, database: "remote", stop: async () => undefined }
    : await spawnServer(options);
  log(`server ${target.url} (${target.database})`);
  try {
    const started = Date.now();
    const docs = await setup(target.url, options);
    log(`created ${options.clients} accounts and ${docs.length} documents in ${((Date.now() - started) / 1000).toFixed(1)} s`);

    const shares: WorkerDoc[][] = Array.from({ length: options.workers }, () => []);
    docs.forEach((doc, index) => shares[index % options.workers].push(doc));
    const wsUrl = `${target.url.replace(/^http/, "ws")}/sync`;
    const workers = shares
      .filter((share) => share.length > 0)
      .map(
        (share) =>
          // Workers do not inherit tsx's loader from --import, so each one
          // registers it (ESM and CommonJS: the shared protocol loads as
          // CommonJS) before loading the TypeScript worker module.
          new Worker(WORKER_BOOTSTRAP, {
            eval: true,
            workerData: {
              wsUrl,
              docs: share,
              cps: options.cps,
              burstSeconds: [3, 12],
              pauseSeconds: [2, 8],
              connectRate: options.connectRate / options.workers,
              applyAllRemotes: options.applyAllRemotes,
            } satisfies WorkerInput,
          }),
      );
    const finals: Promise<WorkerStats>[] = [];
    const ready: Promise<WorkerStats>[] = [];
    const progress = new Map<Worker, number>();
    for (const worker of workers) {
      ready.push(
        new Promise((resolve, reject) => {
          worker.on("message", (message: { type: string; stats?: WorkerStats; opened?: number }) => {
            if (message.type === "ready" && message.stats) resolve(message.stats);
            if (message.type === "progress") progress.set(worker, message.opened ?? 0);
          });
          worker.once("error", reject);
        }),
      );
      finals.push(
        new Promise((resolve, reject) => {
          worker.on("message", (message: { type: string; stats?: WorkerStats }) => {
            if (message.type === "stats" && message.stats) resolve(message.stats);
          });
          worker.once("error", reject);
        }),
      );
    }
    const totalClients = docs.length * options.clients;
    const ticker = setInterval(() => log(`opened ${[...progress.values()].reduce((a, b) => a + b, 0)} / ${totalClients} clients`), 5000);
    const rampStart = Date.now();
    const readyStats = await Promise.all(ready);
    clearInterval(ticker);
    const opened = readyStats.reduce((sum, stats) => sum + stats.opened, 0);
    log(`ramp-up: ${opened} / ${totalClients} clients open in ${((Date.now() - rampStart) / 1000).toFixed(1)} s; warming up ${options.warmup} s`);
    await sleep(options.warmup * 1000);

    const before = await scrape(target.url, options.metricsToken);
    for (const worker of workers) worker.postMessage({ type: "measure" });
    const measureStart = Date.now();
    let peakRss = sample(before, "process_resident_memory_bytes");
    let peakHeap = sample(before, "nodejs_heap_size_used_bytes");
    let peakLag = 0;
    let rooms = 0;
    let sockets = 0;
    while (Date.now() - measureStart < options.duration * 1000) {
      await sleep(Math.min(5000, options.duration * 1000 - (Date.now() - measureStart)));
      const now = await scrape(target.url, options.metricsToken);
      peakRss = Math.max(peakRss, sample(now, "process_resident_memory_bytes"));
      peakHeap = Math.max(peakHeap, sample(now, "nodejs_heap_size_used_bytes"));
      peakLag = Math.max(peakLag, sample(now, "nodejs_eventloop_lag_p99_seconds"));
      rooms = sample(now, "libera_sync_rooms");
      sockets = sample(now, "libera_sync_sockets");
      log(`t+${Math.round((Date.now() - measureStart) / 1000)} s: ${sockets} sockets, ${rooms} rooms, rss ${(sample(now, "process_resident_memory_bytes") / 2 ** 20).toFixed(0)} MiB`);
    }
    const after = await scrape(target.url, options.metricsToken);
    const seconds = (Date.now() - measureStart) / 1000;
    for (const worker of workers) worker.postMessage({ type: "stop" });
    const stats = await Promise.all(finals);
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => undefined)));

    // Merge worker stats.
    const ack = new Histogram();
    const fanout = new Histogram();
    const open = new Histogram();
    const rejected: Record<string, number> = {};
    const errors: Record<string, number> = {};
    const closes: Record<string, number> = {};
    let sent = 0;
    let acked = 0;
    let remotes = 0;
    let awarenessSent = 0;
    let awarenessReceived = 0;
    let unacked = 0;
    let connectFailures = 0;
    let generatorLag = 0;
    for (const worker of stats) {
      ack.merge(worker.ack);
      fanout.merge(worker.fanout);
      mergeCounts(rejected, worker.rejected);
      mergeCounts(errors, worker.errors);
      mergeCounts(closes, worker.unexpectedCloses);
      sent += worker.sent;
      acked += worker.acked;
      remotes += worker.remotes;
      awarenessSent += worker.awarenessSent;
      awarenessReceived += worker.awarenessReceived;
      unacked += worker.unacked;
      connectFailures += worker.connectFailures;
      generatorLag = Math.max(generatorLag, worker.loopDelayP99Ms);
    }
    // Opens all happen during the ramp-up.
    for (const worker of readyStats) open.merge(worker.open);

    const persist = "libera_sync_persist_seconds";
    const fan = "libera_sync_fanout_seconds";
    const cpu = sample(after, "process_cpu_seconds_total") - sample(before, "process_cpu_seconds_total");
    const result = {
      at: new Date().toISOString(),
      target: { url: options.url ? options.url : "spawned", database: target.database },
      scenario: {
        docs: docs.length,
        clientsPerDoc: options.clients,
        typistsPerDoc: options.typists,
        cps: options.cps,
        burstSeconds: [3, 12],
        pauseSeconds: [2, 8],
        durationSeconds: Math.round(seconds),
        workers: workers.length,
        clients: totalClients,
      },
      throughput: {
        updatesPerSecond: Math.round(sent / seconds),
        ackedPerSecond: Math.round(acked / seconds),
        serverUpdatesPerSecond: Math.round((total(after, "libera_sync_updates_total") - total(before, "libera_sync_updates_total")) / seconds),
        remoteFramesPerSecond: Math.round(remotes / seconds),
        awarenessSentPerSecond: Math.round(awarenessSent / seconds),
        awarenessReceivedPerSecond: Math.round(awarenessReceived / seconds),
      },
      latencyMs: {
        ack: ack.summary(),
        remoteVisible: fanout.summary(),
        open: open.summary(),
        serverPersist: {
          count: histogramCount(before, after, persist),
          p50: ms(histogramQuantile(before, after, persist, 0.5)),
          p95: ms(histogramQuantile(before, after, persist, 0.95)),
          p99: ms(histogramQuantile(before, after, persist, 0.99)),
        },
        serverFanout: {
          count: histogramCount(before, after, fan),
          p50: ms(histogramQuantile(before, after, fan, 0.5)),
          p95: ms(histogramQuantile(before, after, fan, 0.95)),
          p99: ms(histogramQuantile(before, after, fan, 0.99)),
        },
      },
      problems: {
        rejected,
        serverRejects: Object.fromEntries(
          Object.entries(byLabel(after, "libera_sync_rejects_total", "reason")).map(([reason, value]) => [
            reason,
            value - (byLabel(before, "libera_sync_rejects_total", "reason")[reason] ?? 0),
          ]),
        ),
        errors,
        unexpectedCloses: closes,
        connectFailures,
        unackedAtEnd: unacked,
        serverSyncErrors: total(after, "libera_sync_errors_total") - total(before, "libera_sync_errors_total"),
      },
      server: {
        rooms,
        sockets,
        peakRssMiB: Math.round(peakRss / 2 ** 20),
        peakHeapUsedMiB: Math.round(peakHeap / 2 ** 20),
        cpuPercentOfOneCore: Math.round((cpu / seconds) * 100),
        eventLoopLagP99Ms: Math.round(peakLag * 1000 * 100) / 100,
      },
      generator: { eventLoopDelayP99Ms: Math.round(generatorLag * 100) / 100 },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (options.out) writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await target.stop();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
