import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  binStarts, bucketUsage, buildChart, buildHeatmap, costComponents, formatCost, modelOrder, modelRows, OTHER_MODELS,
  previousRange, resolvePeriod, startOfWeek, summarize, tokenComponents, usageEntryFromOpenRouter,
  type UsageBucket, type UsageEntry, type UsageReport,
} from "../../src/lib/spending";

const HOUR = 3_600_000;
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const entry = (t: number, model: string, overrides: Partial<UsageEntry> = {}): UsageEntry =>
  ({ t, model, input: 1000, output: 100, cached: 0, cacheWrite: 0, reasoning: 0, cost: 0.01, ...overrides });

test("OpenRouter usage becomes a ledger entry with cache, reasoning and cost", () => {
  const usage = {
    prompt_tokens: 1200, completion_tokens: 300, cost: 0.0042,
    prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 120 },
  };
  assert.deepEqual(usageEntryFromOpenRouter("a/b", usage, 5, "Anthropic"), {
    t: 5, model: "a/b", provider: "Anthropic", input: 1200, output: 300, cached: 800, cacheWrite: 100, reasoning: 120, cost: 0.0042,
  });
  // Image generation reports a cost without tokens.
  assert.deepEqual(usageEntryFromOpenRouter("img/x", { cost: 0.04 }, 5), { t: 5, model: "img/x", input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, cost: 0.04 });
  assert.equal(usageEntryFromOpenRouter("a/b", null), null);
  assert.equal(usageEntryFromOpenRouter("a/b", { prompt_tokens: 0, completion_tokens: 0 }), null);
  assert.equal(usageEntryFromOpenRouter("", { prompt_tokens: 3, completion_tokens: 1 }), null);
});

test("entries roll up into sorted hourly buckets per model", () => {
  const base = Math.floor(at(2026, 10, 20, 9) / HOUR) * HOUR;
  const buckets = bucketUsage([
    entry(base + 10, "m/a"), entry(base + 20, "m/a", { cost: undefined }), entry(base + 30, "m/b"), entry(base - 1, "m/a"),
  ]);
  assert.deepEqual(buckets.map((bucket) => [bucket.hour - base, bucket.model, bucket.requests, bucket.costed]), [
    [-HOUR, "m/a", 1, 1], [0, "m/a", 2, 1], [0, "m/b", 1, 1],
  ]);
  assert.equal(buckets[1].input, 2000);
  assert.equal(buckets[1].cost, 0.01);
});

test("cost splits by model prices and scales to the reported charge", () => {
  const bucket: UsageBucket = { hour: 0, model: "m", requests: 1, input: 1000, output: 100, cached: 600, cacheWrite: 0, reasoning: 0, cost: 0.02, costed: 1 };
  assert.deepEqual(tokenComponents(bucket), { input: 400, cacheRead: 600, cacheWrite: 0, output: 100, other: 0 });
  const pricing = { prompt: 1e-5, completion: 4e-5, cacheRead: 1e-6 };
  // Raw: input 0.004, cache 0.0006, output 0.004 → 0.0086, scaled to 0.02.
  const { values, estimated } = costComponents(bucket, pricing);
  assert.equal(estimated, false);
  const total = values.input + values.cacheRead + values.cacheWrite + values.output + values.other;
  assert.ok(Math.abs(total - 0.02) < 1e-12);
  assert.ok(Math.abs(values.input - values.output) < 1e-12);
  assert.ok(values.cacheRead < values.input / 6);
  // No reported cost: the price estimate stands.
  const unreported = costComponents({ ...bucket, cost: 0, costed: 0 }, pricing);
  assert.equal(unreported.estimated, true);
  assert.ok(Math.abs(unreported.values.output - 0.004) < 1e-12);
  // No prices: fallback weights still split a reported cost; no tokens → media & fees.
  assert.ok(Math.abs(Object.values(costComponents(bucket).values).reduce((a, b) => a + b, 0) - 0.02) < 1e-12);
  assert.deepEqual(costComponents({ ...bucket, input: 0, output: 0, cached: 0 }).values, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0.02 });
});

test("periods resolve to local calendar ranges with a fitting bar width", () => {
  const now = at(2026, 10, 22, 15); // A Thursday.
  assert.equal(new Date(startOfWeek(now)).getDay(), 1);
  const today = resolvePeriod("today", now);
  assert.equal(today.unit, "hour");
  assert.equal(binStarts(today).length, 24);
  const week = resolvePeriod("week", now);
  assert.equal(new Date(week.start).getDate(), 19);
  assert.equal(binStarts(week).length, 7);
  assert.equal(binStarts(resolvePeriod("30d", now)).length, 30);
  assert.equal(binStarts(resolvePeriod("month", now)).length, 31);
  const lastMonth = resolvePeriod("lastMonth", now);
  assert.equal(new Date(lastMonth.start).getMonth(), 8);
  assert.equal(binStarts(lastMonth).length, 30);
  assert.equal(resolvePeriod("90d", now).unit, "week");
  assert.equal(binStarts(resolvePeriod("year", now)).length, 12);
  assert.equal(resolvePeriod("all", now, at(2026, 10, 1)).unit, "day");
  assert.equal(resolvePeriod("all", now, at(2025, 3, 1)).unit, "month");
  // The comparison span is as long as the elapsed part of this one.
  const previous = previousRange(week, now);
  assert.equal(week.start - previous.start, now - week.start);
});

function report(entries: UsageEntry[]): UsageReport {
  return { buckets: bucketUsage(entries), models: { "x/big": { name: "X: Big", pricing: { prompt: 1e-5, completion: 3e-5 } } }, since: entries[0]?.t ?? null };
}

test("charts stack by component or model, and models keep their color slot across periods", () => {
  const now = at(2026, 10, 22, 15);
  const models = ["x/big", "m/1", "m/2", "m/3", "m/4", "m/5", "m/6", "m/7"];
  const entries = models.map((model, index) => entry(at(2026, 10, 1), model, { cost: 10 - index }));
  entries.push(entry(at(2026, 10, 21), "m/7", { cost: 0.5 }), entry(at(2026, 10, 22), "x/big", { cost: 1, cached: 500 }));
  const data = report(entries);
  assert.equal(modelOrder(data.buckets)[0], "x/big");

  const week = resolvePeriod("week", now);
  const byModel = buildChart(data, week, "cost", "model");
  // m/7 is eighth overall, so it folds into Other.
  assert.deepEqual(byModel.keys.map((key) => key.key), ["x/big", OTHER_MODELS]);
  assert.equal(byModel.keys[0].label, "Big");
  assert.equal(byModel.bins.length, 7);
  assert.ok(Math.abs(byModel.total - 1.5) < 1e-9);

  const byComponent = buildChart(data, week, "tokens", "component");
  assert.deepEqual(byComponent.keys.map((key) => key.key), ["input", "output", "cacheRead"]);
  assert.equal(byComponent.total, 2200);
  assert.equal(byComponent.max, 1100);

  const summary = summarize(data, week);
  assert.equal(summary.requests, 2);
  assert.ok(Math.abs(summary.cost - 1.5) < 1e-9);
  assert.equal(summary.cacheHitRate, 0.25);
  assert.equal(summary.activeDays, 2);

  const rows = modelRows(data, week, "cost");
  assert.deepEqual(rows.map((row) => row.model), ["x/big", "m/7"]);
  assert.ok(Math.abs(rows[0].share - 2 / 3) < 1e-9);
});

test("the heatmap has a column per week, Monday first, with quartile levels", () => {
  const now = at(2026, 10, 22, 15);
  const values = [1, 2, 3, 4, 100];
  const data = report(values.map((cost, index) => entry(at(2026, 10, 10 + index), "x/big", { cost })));
  const heatmap = buildHeatmap(data, "cost", now, 53);
  assert.equal(heatmap.weeks.length, 53);
  assert.ok(heatmap.weeks.every((week) => week.length === 7 && new Date(week[0].day).getDay() === 1));
  assert.equal(heatmap.activeDays, 5);
  const cells = heatmap.weeks.flat();
  const levelOf = (day: number) => cells.find((cell) => cell.day === new Date(2026, 9, day).getTime())?.level;
  assert.equal(levelOf(9), 0);
  assert.equal(levelOf(10), 1);
  assert.equal(levelOf(14), 4);
  assert.ok(cells.at(-1)!.future);
});

test("costs format with precision that suits their size", () => {
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.00001), "<$0.0001");
  assert.equal(formatCost(0.0042), "$0.0042");
  assert.equal(formatCost(0.123), "$0.123");
  assert.equal(formatCost(12.345), "$12.35");
  assert.equal(formatCost(1234), "$1234");
});

test("the ledger appends entries per month and reads them back as buckets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "libera-usage-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = root;
  try {
    const { appendUsageEntry, readUsageBuckets } = await import("../../src/lib/storage/usage-ledger");
    assert.deepEqual(await readUsageBuckets(), { buckets: [], since: null });
    await appendUsageEntry(entry(Date.UTC(2026, 8, 30, 23, 30), "m/a"));
    await appendUsageEntry(entry(Date.UTC(2026, 9, 1, 0, 30), "m/a"));
    await appendUsageEntry(entry(Date.UTC(2026, 9, 1, 0, 45), "m/a"));
    const directory = path.join(root, "users");
    const shard = (await import("node:fs/promises")).readdir;
    const [user] = await shard(directory);
    const usageDirectory = path.join(directory, user, ".libera", "usage");
    assert.deepEqual((await shard(usageDirectory)).sort(), ["openrouter-2026-09.jsonl", "openrouter-2026-10.jsonl"]);
    // A torn line from a crash is skipped.
    const october = path.join(usageDirectory, "openrouter-2026-10.jsonl");
    await writeFile(october, `${await readFile(october, "utf8")}{"t":1,"mod`);
    const { buckets, since } = await readUsageBuckets();
    assert.deepEqual(buckets.map((bucket) => bucket.requests), [1, 2]);
    assert.equal(since, Date.UTC(2026, 8, 30, 23, 30));
  } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR;
    else process.env.LIBERA_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
