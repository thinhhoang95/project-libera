// Runs the collab suite (npm run test:collab) in two phases.
//
// Most files run in parallel, on half the cores: each file starts its own
// collab server and hosts, and at node's default (cores - 1) the notebook sync
// tests' waits time out. Files that assert timing budgets (p95 latency,
// main-thread steps, reconnect windows) then run one at a time: measured next
// to ~80 other files and their child processes, a 300 ms budget reads as
// seconds. Arguments, when given, are passed to a single `node --test` run.
//
// --test-force-exit is only a guard: a file whose tests are done must not keep
// the run waiting on a handle that never closes.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const TIMED = new Set([
  "harness-durability.test.ts",
  "harness-perf.test.ts",
  "host-compaction.test.ts",
  "host-kill.test.ts",
  "host-store.test.ts",
  "review-latency.test.ts",
  "tiptap-bridge-perf.test.ts",
]);

function run(files, extra = []) {
  const args = ["--require", "./scripts/editor/setup.cjs", "--import", "tsx", "--test", "--test-force-exit", ...extra, ...files];
  return spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" }).status ?? 1;
}

const passed = process.argv.slice(2);
if (passed.length) process.exit(run(passed));

const all = readdirSync(here).filter((file) => file.endsWith(".test.ts")).sort();
const rel = (file) => path.posix.join("scripts/collab", file);
const parallel = all.filter((file) => !TIMED.has(file)).map(rel);
const timed = all.filter((file) => TIMED.has(file)).map(rel);

const first = run(parallel, [`--test-concurrency=${Math.max(2, Math.floor(availableParallelism() / 2))}`]);
const second = run(timed, ["--test-concurrency=1"]);
process.exit(first || second);
