// Convergence fuzzer (source plan §11, plan M1.12): 3–5 real hosts against
// the real server through the chaos proxy. fast-check generates schedules
// that interleave random edits with partitions, heals, resets, black holes,
// stalls, latency, frame duplication and reordering, host restarts and
// server restarts. After healing, every host and a fresh reader of the
// server must hold the same text and the same content state vector.
//
// Runs: LIBERA_COLLAB_FUZZ_RUNS (default 20, 200 with LIBERA_COLLAB_HEAVY=1).
// Replay: LIBERA_COLLAB_FUZZ_SEED=<seed> [LIBERA_COLLAB_FUZZ_PATH=<path>],
// both printed on failure. Shrinking is off by default (each run costs
// seconds); LIBERA_COLLAB_FUZZ_SHRINK=1 turns it on for a replay.
//
// Hosts use connectTimeoutMs 2 s and a 3 s backoff cap so a schedule's
// faults heal in seconds; the defaults (15 s, 30 s) are exercised by the
// durability matrix.

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import fc from "fast-check";

import { Cluster, sleep, type HarnessHost, type HarnessUser } from "./harness/cluster";
import { HEAVY } from "./harness/stats";
import { RandomTypist } from "./harness/typist";

const RUNS = Number(process.env.LIBERA_COLLAB_FUZZ_RUNS ?? (HEAVY ? 200 : 20));
const SEED = process.env.LIBERA_COLLAB_FUZZ_SEED ? Number(process.env.LIBERA_COLLAB_FUZZ_SEED) : (Date.now() ^ (process.pid << 8)) >>> 0;
const PATH = process.env.LIBERA_COLLAB_FUZZ_PATH;
const SHRINK = process.env.LIBERA_COLLAB_FUZZ_SHRINK === "1";
const MAX_HOSTS = 5;

type Action =
  | { kind: "edit"; host: number; count: number }
  | { kind: "partition"; host: number }
  | { kind: "heal"; host: number }
  | { kind: "reset"; host: number }
  | { kind: "blackhole"; host: number }
  | { kind: "stall"; host: number; ms: number }
  | { kind: "delay"; host: number; latencyMs: number; jitterMs: number }
  | { kind: "duplicate"; host: number; duplicateRate: number; reorderRate: number }
  | { kind: "wait"; ms: number }
  | { kind: "restartHost"; host: number }
  | { kind: "restartServer"; mode: "kill" | "graceful" };

interface Scenario {
  hosts: number;
  seed: number;
  actions: Action[];
}

const hostIndex = fc.nat(MAX_HOSTS - 1);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 10, arbitrary: fc.record({ kind: fc.constant("edit" as const), host: hostIndex, count: fc.integer({ min: 1, max: 25 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("partition" as const), host: hostIndex }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("heal" as const), host: hostIndex }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reset" as const), host: hostIndex }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("blackhole" as const), host: hostIndex }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("stall" as const), host: hostIndex, ms: fc.integer({ min: 50, max: 600 }) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("delay" as const),
      host: hostIndex,
      latencyMs: fc.integer({ min: 0, max: 300 }),
      jitterMs: fc.integer({ min: 0, max: 100 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("duplicate" as const),
      host: hostIndex,
      duplicateRate: fc.double({ min: 0, max: 0.8, noNaN: true }),
      reorderRate: fc.double({ min: 0, max: 0.5, noNaN: true }),
    }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 400 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("restartHost" as const), host: hostIndex }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("restartServer" as const), mode: fc.constantFrom("kill" as const, "graceful" as const) }) },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  hosts: fc.integer({ min: 3, max: MAX_HOSTS }),
  seed: fc.nat(),
  actions: fc.array(actionArb, { minLength: 4, maxLength: HEAVY ? 30 : 14 }),
});

let cluster: Cluster;
let users: HarnessUser[];
let projectId: string;
let runIndex = 0;

before(async () => {
  cluster = await Cluster.start();
  users = [];
  for (let index = 0; index < MAX_HOSTS; index += 1) users.push(await cluster.registerUser(`Fuzz${index}`));
  projectId = await cluster.createProject(users[0], "Fuzz");
  for (const user of users.slice(1)) await cluster.addMember(projectId, users[0], user);
});

after(async () => {
  await cluster?.stop();
});

async function apply(action: Action, hosts: HarnessHost[], typists: RandomTypist[], docId: string): Promise<void> {
  const pick = (index: number) => index % hosts.length;
  switch (action.kind) {
    case "edit": {
      const index = pick(action.host);
      const hub = hosts[index].open(docId, projectId);
      for (let count = 0; count < action.count; count += 1) {
        typists[index].step(hub);
        // Typing has gaps: let the network and timers run now and then.
        if (count % 5 === 4) await sleep(1);
      }
      return;
    }
    case "partition":
      hosts[pick(action.host)].link.partition();
      return;
    case "heal":
      hosts[pick(action.host)].link.heal();
      hosts[pick(action.host)].nudge();
      return;
    case "reset":
      hosts[pick(action.host)].link.reset();
      return;
    case "blackhole":
      hosts[pick(action.host)].link.blackhole();
      return;
    case "stall":
      hosts[pick(action.host)].link.stall(action.ms);
      return;
    case "delay":
      hosts[pick(action.host)].link.set({ latencyMs: action.latencyMs, jitterMs: action.jitterMs });
      return;
    case "duplicate":
      hosts[pick(action.host)].link.set({ duplicateRate: action.duplicateRate, reorderRate: action.reorderRate });
      return;
    case "wait":
      await sleep(action.ms);
      return;
    case "restartHost":
      // Quit and relaunch: the replica comes back from SQLite.
      await hosts[pick(action.host)].restart();
      return;
    case "restartServer":
      await cluster.restartServer({ mode: action.mode });
      return;
  }
}

async function runScenario(scenario: Scenario): Promise<void> {
  runIndex += 1;
  const docId = await cluster.createDoc(projectId, users[0]);
  const hosts: HarnessHost[] = [];
  try {
    for (let index = 0; index < scenario.hosts; index += 1) {
      const host = await cluster.addHost(users[index], { connectTimeoutMs: 2000, limits: { backoffMaxMs: 3000 } }, `fuzz${runIndex}-${index}`);
      host.open(docId, projectId);
      hosts.push(host);
    }
    const typists = hosts.map((_, index) => new RandomTypist({ seed: scenario.seed + index, tag: `${index}`, maxPaste: 600 }));
    for (const action of scenario.actions) await apply(action, hosts, typists, docId);
    cluster.healAll();
    const result = await cluster.awaitConvergence(docId, hosts, { timeoutMs: 45_000 });
    assert.ok(result.text.length >= 0);
  } finally {
    for (const host of hosts) await cluster.removeHost(host);
  }
}

test(`convergence fuzzer: ${RUNS} random schedules of edits and faults converge (seed ${SEED})`, { timeout: Math.max(600_000, RUNS * 90_000) }, async () => {
  console.log(`[collab-fuzz] seed ${SEED}, ${RUNS} runs${PATH ? `, path ${PATH}` : ""}`);
  const started = performance.now();
  try {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        await runScenario(scenario);
      }),
      {
        numRuns: RUNS,
        seed: SEED,
        ...(PATH ? { path: PATH } : {}),
        endOnFailure: !SHRINK,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const path = /path: "([^"]*)"/.exec(message)?.[1];
    console.error(
      `[collab-fuzz] FAILED. Replay with LIBERA_COLLAB_FUZZ_SEED=${SEED}${path ? ` LIBERA_COLLAB_FUZZ_PATH=${path}` : ""} LIBERA_COLLAB_FUZZ_RUNS=${RUNS}`,
    );
    throw error;
  }
  console.log(`[collab-fuzz] ${RUNS} runs passed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
});
