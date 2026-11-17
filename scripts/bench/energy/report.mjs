#!/usr/bin/env node
// Merges energy-bench result files into one summary (for runs made in several
// sittings, such as a scenario re-run after a fix):
//
//   node scripts/bench/energy/report.mjs <result.json>... [--out summary.md]
//
// Runs that failed are left out; the summary takes medians over every
// successful run of each version and scenario.

import { readFile, writeFile } from "node:fs/promises";
import { markdown, summarize } from "./run.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : null;
const files = await Promise.all(args.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
if (!files.length) {
  console.error("Usage: node scripts/bench/energy/report.mjs <result.json>... [--out summary.md]");
  process.exit(1);
}
const runs = files.flatMap((file) => file.runs.filter((run) => !run.error));
const reps = Math.max(...["before", "after"].map((version) => Math.min(...[...new Set(runs.map((run) => run.scenario))].map((scenario) => runs.filter((run) => run.version === version && run.scenario === scenario).length))));
const report = markdown(summarize(runs), { ...files[0].options, reps }, files[0].meta);
if (out) await writeFile(out, `${report}\n`);
process.stdout.write(`${report}\n`);
