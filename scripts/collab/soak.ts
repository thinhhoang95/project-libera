// Collaboration soak (plan M1.12): 10 simulated clients typing into one
// document through the chaos proxy, with periodic chaos (partitions, black
// holes, latency, resets, duplication and reordering, host restarts, server
// crashes and deploys), and a full convergence check every minute: typing
// pauses, every fault heals, and every host plus a fresh reader of the
// server must agree on text and state vector. Exits 1 on divergence.
//
// Usage:
//   node --import tsx scripts/collab/soak.ts [--minutes 5] [--typists 10] [--seed 1]
//        [--check-minutes 1] [--server-restart-minutes 4] [--convergence-timeout-s 120]
//
// The nightly CI job runs it with --minutes 1440. Hosts use the product's
// default timeouts and backoff; compaction runs as in the app.

import { Cluster, sleep, type HarnessHost } from "./harness/cluster";
import { RandomTypist, seededRandom } from "./harness/typist";

interface Options {
  minutes: number;
  typists: number;
  seed: number;
  checkMinutes: number;
  serverRestartMinutes: number;
  convergenceTimeoutS: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { minutes: 5, typists: 10, seed: Date.now() & 0x7fffffff, checkMinutes: 1, serverRestartMinutes: 4, convergenceTimeoutS: 120 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = Number(argv[index + 1]);
    const key = (
      {
        "--minutes": "minutes",
        "--typists": "typists",
        "--seed": "seed",
        "--check-minutes": "checkMinutes",
        "--server-restart-minutes": "serverRestartMinutes",
        "--convergence-timeout-s": "convergenceTimeoutS",
      } as const
    )[flag];
    if (!key) throw new Error(`Unknown flag ${flag}`);
    if (!Number.isFinite(value)) throw new Error(`${flag} needs a number`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

/** Keeps the doc from growing without bound over a long soak: past this, edits lean to deletes. */
const MAX_DOC_CHARS = 150_000;

class Typing {
  private readonly typists: Map<HarnessHost, RandomTypist>;
  /** Delete-heavy typists used once the doc passes MAX_DOC_CHARS. */
  private readonly trimmers: Map<HarnessHost, RandomTypist>;
  private timers = new Map<HarnessHost, NodeJS.Timeout>();
  edits = 0;
  errors = 0;
  private paused = true;

  constructor(
    private readonly hosts: HarnessHost[],
    private readonly docId: string,
    private readonly projectId: string,
    private readonly random: () => number,
    seed: number,
  ) {
    this.typists = new Map(hosts.map((host, index) => [host, new RandomTypist({ seed: seed + index, tag: `${index}`, maxPaste: 1500 })]));
    this.trimmers = new Map(
      hosts.map((host, index) => [host, new RandomTypist({ seed: seed + 1000 + index, weights: { insert: 5, delete: 80, replace: 10, paste: 0, newline: 5 } })]),
    );
  }

  resume(): void {
    this.paused = false;
    for (const host of this.hosts) this.schedule(host);
  }

  pause(): void {
    this.paused = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(host: HarnessHost): void {
    if (this.paused) return;
    // Bursty typing: mostly fast keystrokes, sometimes a pause to think.
    const delay = this.random() < 0.9 ? 40 + this.random() * 200 : 1000 + this.random() * 4000;
    this.timers.set(
      host,
      setTimeout(() => {
        try {
          const hub = host.open(this.docId, this.projectId);
          const typist = hub.getText().length > MAX_DOC_CHARS ? this.trimmers.get(host) : this.typists.get(host);
          typist?.step(hub);
          this.edits += 1;
        } catch {
          // A host restarting right now; it types again on the next tick.
          this.errors += 1;
        }
        this.schedule(host);
      }, delay),
    );
  }
}

class Chaos {
  private timer: NodeJS.Timeout | null = null;
  private readonly cleanups = new Set<NodeJS.Timeout>();
  readonly counts: Record<string, number> = {};
  private stopped = true;
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private readonly hosts: HarnessHost[],
    private readonly random: () => number,
  ) {}

  start(): void {
    this.stopped = false;
    this.next();
  }

  /** Stops new chaos and waits for a host or server restart in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const timer of this.cleanups) clearTimeout(timer);
    this.cleanups.clear();
    await this.busy;
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.cleanups.delete(timer);
      fn();
    }, ms);
    this.cleanups.add(timer);
  }

  private pickHosts(max: number): HarnessHost[] {
    const count = 1 + Math.floor(this.random() * max);
    return [...this.hosts].sort(() => this.random() - 0.5).slice(0, count);
  }

  private next(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.busy = this.fire().catch((error: unknown) => log("chaos-error", { error: String(error) }));
      void this.busy.then(() => this.next());
    }, 5000 + this.random() * 15_000);
  }

  private count(kind: string): void {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
  }

  private async fire(): Promise<void> {
    const roll = this.random();
    if (roll < 0.25) {
      const hosts = this.pickHosts(3);
      for (const host of hosts) host.link.partition();
      this.count("partition");
      this.later(3000 + this.random() * 15_000, () => hosts.forEach((host) => (host.link.heal(), host.nudge())));
    } else if (roll < 0.4) {
      const hosts = this.pickHosts(5);
      for (const host of hosts) host.link.set({ latencyMs: 50 + this.random() * 400, jitterMs: this.random() * 150 });
      this.count("latency");
      this.later(20_000, () => hosts.forEach((host) => host.link.set({ latencyMs: 0, jitterMs: 0 })));
    } else if (roll < 0.55) {
      const hosts = this.pickHosts(4);
      for (const host of hosts) host.link.startRandomResets(2000 + this.random() * 5000);
      this.count("random-resets");
      this.later(20_000, () => hosts.forEach((host) => host.link.stopRandomResets()));
    } else if (roll < 0.68) {
      const hosts = this.pickHosts(5);
      for (const host of hosts) host.link.set({ duplicateRate: this.random() * 0.6, reorderRate: this.random() * 0.4 });
      this.count("duplicate-reorder");
      this.later(20_000, () => hosts.forEach((host) => host.link.set({ duplicateRate: 0, reorderRate: 0 })));
    } else if (roll < 0.76) {
      const [host] = this.pickHosts(1);
      host.link.blackhole();
      this.count("blackhole");
      this.later(5000 + this.random() * 10_000, () => (host.link.heal(), host.nudge()));
    } else if (roll < 0.84) {
      const [host] = this.pickHosts(1);
      host.link.stall(500 + this.random() * 3000);
      this.count("stall");
    } else if (roll < 0.92) {
      const hosts = this.pickHosts(3);
      for (const host of hosts) host.link.killSilently();
      this.count("network-switch");
      for (const host of hosts) host.nudge();
    } else {
      const [host] = this.pickHosts(1);
      await host.restart();
      this.count("host-restart");
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const random = seededRandom(options.seed);
  log("start", { ...options });
  const cluster = await Cluster.start({ random });
  let exitCode = 0;
  let typing: Typing | null = null;
  let chaos: Chaos | null = null;
  const stopSignal = { requested: false };
  process.once("SIGINT", () => (stopSignal.requested = true));
  try {
    const { users, projectId, docId } = await cluster.team(Array.from({ length: options.typists }, (_, index) => `Soak${index}`));
    const hosts: HarnessHost[] = [];
    for (const user of users) {
      const host = await cluster.addHost(user, { compaction: {} });
      host.open(docId, projectId);
      hosts.push(host);
    }
    typing = new Typing(hosts, docId, projectId, random, options.seed);
    chaos = new Chaos(hosts, random);
    const started = Date.now();
    const endAt = started + options.minutes * 60_000;
    let nextServerRestart = started + options.serverRestartMinutes * 60_000;
    let serverRestarts = 0;
    let checks = 0;
    let worstConvergenceMs = 0;
    while (Date.now() < endAt && !stopSignal.requested) {
      typing.resume();
      chaos.start();
      const phaseEnd = Math.min(endAt, Date.now() + options.checkMinutes * 60_000);
      while (Date.now() < phaseEnd && !stopSignal.requested) {
        if (options.serverRestartMinutes > 0 && Date.now() >= nextServerRestart) {
          const mode = random() < 0.5 ? "kill" : "graceful";
          log("server-restart", { mode });
          await cluster.restartServer({ mode, downMs: Math.floor(random() * 3000) });
          serverRestarts += 1;
          nextServerRestart = Date.now() + options.serverRestartMinutes * 60_000;
        }
        await sleep(250);
      }
      // Convergence check: quiesce, heal everything, compare all replicas and the server.
      typing.pause();
      await chaos.stop();
      cluster.healAll();
      checks += 1;
      try {
        const result = await cluster.awaitConvergence(docId, hosts, { timeoutMs: options.convergenceTimeoutS * 1000 });
        worstConvergenceMs = Math.max(worstConvergenceMs, result.elapsedMs);
        log("converged", {
          check: checks,
          minute: Math.round((Date.now() - started) / 60_000),
          edits: typing.edits,
          docChars: result.text.length,
          serverSeq: result.server.serverSeq,
          convergenceMs: Math.round(result.elapsedMs),
          serverRestarts,
          chaos: chaos.counts,
          resets: hosts.reduce((sum, host) => sum + host.link.stats.resets, 0),
          duplicatedFrames: hosts.reduce((sum, host) => sum + host.link.stats.duplicatedFrames, 0),
          reorderedFrames: hosts.reduce((sum, host) => sum + host.link.stats.reorderedFrames, 0),
          rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        });
      } catch (error) {
        log("DIVERGENCE", { check: checks, error: String(error) });
        exitCode = 1;
        break;
      }
    }
    log("done", { exitCode, checks, edits: typing.edits, typingErrors: typing.errors, serverRestarts, worstConvergenceMs: Math.round(worstConvergenceMs), seed: options.seed });
  } catch (error) {
    log("crashed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    exitCode = 2;
  } finally {
    typing?.pause();
    await chaos?.stop();
    await cluster.stop();
  }
  process.exit(exitCode);
}

void main();
