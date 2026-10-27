import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getAdminRoot } from "./paths";
import { bucketUsage, isUsageEntry, usageEntryFromOpenRouter, type UsageBucket, type UsageEntry } from "@/lib/spending";

// The Spending page's ledger: one JSON line per OpenRouter request, in a file
// per UTC month (`.libera/usage/openrouter-2026-10.jsonl`). Lines are only
// ever appended, so a crash costs at most the line being written, and a line
// that does not parse is skipped on read.

const SHARD = /^openrouter-(\d{4})-(\d{2})\.jsonl$/;

function ledgerDirectory() {
  return path.join(getAdminRoot(), ".libera", "usage");
}

function shardName(time: number) {
  const date = new Date(time);
  return `openrouter-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

let appending: Promise<void> = Promise.resolve();

export function appendUsageEntry(entry: UsageEntry) {
  const task = appending.catch(() => undefined).then(async () => {
    const directory = ledgerDirectory();
    await mkdir(directory, { recursive: true });
    await appendFile(path.join(directory, shardName(entry.t)), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  });
  appending = task;
  return task;
}

/**
 * Records an OpenRouter response's usage. Never throws and never delays the
 * response: losing a line of spending history is better than failing a request.
 */
export function recordOpenRouterUsage(model: string, usage: unknown, provider?: string) {
  // Off in tests, whose OpenRouter responses are stubs.
  if (process.env.LIBERA_USAGE_LEDGER === "off") return;
  try {
    const entry = usageEntryFromOpenRouter(model, usage, Date.now(), provider);
    if (entry) void appendUsageEntry(entry).catch(() => undefined);
  } catch { /* Spending history is best effort. */ }
}

// Past months never change, so their buckets are kept until the file does.
const shardCache = new Map<string, { size: number; mtimeMs: number; buckets: UsageBucket[]; since: number | null }>();

async function readShard(file: string) {
  const info = await stat(file);
  const cached = shardCache.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;
  const entries: UsageEntry[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (isUsageEntry(value)) entries.push(value);
    } catch { /* A torn last line from a crash. */ }
  }
  const shard = {
    size: info.size,
    mtimeMs: info.mtimeMs,
    buckets: bucketUsage(entries),
    since: entries.reduce<number | null>((first, entry) => first === null || entry.t < first ? entry.t : first, null),
  };
  shardCache.set(file, shard);
  return shard;
}

/** Every recorded request, as hourly buckets per model, oldest first. */
export async function readUsageBuckets(): Promise<{ buckets: UsageBucket[]; since: number | null }> {
  await appending.catch(() => undefined);
  const directory = ledgerDirectory();
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => SHARD.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { buckets: [], since: null };
    throw error;
  }
  const shards = await Promise.all(names.map((name) => readShard(path.join(directory, name)).catch(() => null)));
  let since: number | null = null;
  const buckets: UsageBucket[] = [];
  for (const shard of shards) {
    if (!shard) continue;
    buckets.push(...shard.buckets);
    if (shard.since !== null && (since === null || shard.since < since)) since = shard.since;
  }
  return { buckets, since };
}
