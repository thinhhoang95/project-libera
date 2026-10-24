/**
 * OpenRouter spending, as recorded by Libera itself.
 *
 * Every OpenRouter response carries its token counts and what it cost; the
 * server appends one `UsageEntry` per request to a local ledger
 * (storage/usage-ledger.ts) and serves it back rolled up into hourly
 * `UsageBucket`s per model. Everything below is pure and runs in the browser:
 * periods, the split of a cost into input, output and cache (estimated from
 * the model's prices, then scaled to what OpenRouter actually charged), and
 * the series behind the Spending page's charts.
 *
 * Buckets are hours in UTC, so they land on the right local day in every time
 * zone with a whole-hour offset (and within half an hour elsewhere).
 */

/** One OpenRouter request. Token counts follow OpenRouter: `cached` and `cacheWrite` are part of `input`. */
export type UsageEntry = {
  /** When the response arrived, in ms. */
  t: number;
  model: string;
  provider?: string;
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
  /** USD charged, when OpenRouter reported it. */
  cost?: number;
};

export type UsageBucket = {
  /** Start of the UTC hour, in ms. */
  hour: number;
  model: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
  /** USD charged by the requests that reported a cost. */
  cost: number;
  /** How many requests reported a cost. */
  costed: number;
};

/** USD per token. */
export type ModelPricing = { prompt: number; completion: number; cacheRead?: number; cacheWrite?: number };
export type ModelInfo = { name?: string; pricing?: ModelPricing };

/** The OpenRouter key's own counters, across every app that uses it. */
export type AccountUsage = {
  label?: string;
  usage: number;
  daily: number;
  weekly: number;
  monthly: number;
  limit: number | null;
  remaining: number | null;
  reset: string | null;
};

export type UsageReport = {
  buckets: UsageBucket[];
  models: Record<string, ModelInfo>;
  /** When the ledger's first request was recorded, or null when it is empty. */
  since: number | null;
};

const HOUR = 3_600_000;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Reads an OpenRouter `usage` object (chat, stream or image response) into a ledger entry. */
export function usageEntryFromOpenRouter(model: string, usage: unknown, t = Date.now(), provider?: string): UsageEntry | null {
  if (!model || !usage || typeof usage !== "object") return null;
  const raw = usage as {
    prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  };
  const count = (value: unknown) => isCount(value) ? Math.round(value) : 0;
  const entry: UsageEntry = {
    t, model,
    ...(provider ? { provider } : {}),
    input: count(raw.prompt_tokens),
    output: count(raw.completion_tokens),
    cached: count(raw.prompt_tokens_details?.cached_tokens),
    cacheWrite: count(raw.prompt_tokens_details?.cache_write_tokens),
    reasoning: count(raw.completion_tokens_details?.reasoning_tokens),
    ...(isCount(raw.cost) ? { cost: raw.cost } : {}),
  };
  return entry.input || entry.output || entry.cost ? entry : null;
}

export function isUsageEntry(value: unknown): value is UsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as UsageEntry;
  return Number.isFinite(entry.t) && typeof entry.model === "string" && entry.model.length > 0 &&
    isCount(entry.input) && isCount(entry.output) && isCount(entry.cached) && isCount(entry.cacheWrite) && isCount(entry.reasoning) &&
    (entry.cost === undefined || isCount(entry.cost)) && (entry.provider === undefined || typeof entry.provider === "string");
}

/** Rolls entries up into hourly buckets per model, oldest first. */
export function bucketUsage(entries: Iterable<UsageEntry>): UsageBucket[] {
  const buckets = new Map<string, UsageBucket>();
  for (const entry of entries) {
    const hour = Math.floor(entry.t / HOUR) * HOUR;
    const key = `${hour}\u0000${entry.model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hour, model: entry.model, requests: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0, cost: 0, costed: 0 };
      buckets.set(key, bucket);
    }
    bucket.requests++;
    bucket.input += entry.input;
    bucket.output += entry.output;
    bucket.cached += entry.cached;
    bucket.cacheWrite += entry.cacheWrite;
    bucket.reasoning += entry.reasoning;
    if (entry.cost !== undefined) {
      bucket.cost += entry.cost;
      bucket.costed++;
    }
  }
  return [...buckets.values()].sort((a, b) => a.hour - b.hour || a.model.localeCompare(b.model));
}

// ---------------------------------------------------------------------------
// Components: where the tokens and the money went.

export type Component = "input" | "cacheRead" | "cacheWrite" | "output" | "other";
/** In stacking order, which is also their color order (output between input and cache keeps neighbors distinct). */
export const COMPONENTS: { key: Component; label: string; detail: string }[] = [
  { key: "input", label: "Input", detail: "Prompt tokens read fresh: instructions, documents, conversation history." },
  { key: "output", label: "Output", detail: "Generated tokens, including reasoning." },
  { key: "cacheRead", label: "Cache read", detail: "Prompt tokens served from the provider’s prompt cache, usually at a steep discount." },
  { key: "cacheWrite", label: "Cache write", detail: "Prompt tokens written to the cache, which some providers charge extra for." },
  { key: "other", label: "Media & fees", detail: "Charges with no tokens behind them, such as generated images." },
];

export type ComponentValues = Record<Component, number>;
const zeroComponents = (): ComponentValues => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 });

/** Tokens by component. Fresh input excludes what was read from or written to the cache. */
export function tokenComponents(bucket: Pick<UsageBucket, "input" | "output" | "cached" | "cacheWrite">): ComponentValues {
  return {
    input: Math.max(0, bucket.input - bucket.cached - bucket.cacheWrite),
    cacheRead: bucket.cached,
    cacheWrite: bucket.cacheWrite,
    output: bucket.output,
    other: 0,
  };
}

/** Relative weights for splitting a reported cost when a model's prices are unknown. */
const FALLBACK_WEIGHTS: ModelPricing = { prompt: 1, completion: 4, cacheRead: 0.25, cacheWrite: 1.25 };

/**
 * Cost by component. The model's prices give each component's share; the
 * shares are then scaled to the cost OpenRouter reported, so the parts always
 * add up to what was charged (web search and other fees spread across them).
 * Without a reported cost the price estimate stands on its own.
 */
export function costComponents(bucket: UsageBucket, pricing?: ModelPricing): { values: ComponentValues; estimated: boolean } {
  const tokens = tokenComponents(bucket);
  const rates = pricing ?? FALLBACK_WEIGHTS;
  const raw = zeroComponents();
  raw.input = tokens.input * rates.prompt;
  raw.cacheRead = tokens.cacheRead * (rates.cacheRead ?? rates.prompt);
  raw.cacheWrite = tokens.cacheWrite * (rates.cacheWrite ?? rates.prompt);
  raw.output = tokens.output * rates.completion;
  const rawTotal = raw.input + raw.cacheRead + raw.cacheWrite + raw.output;

  if (bucket.costed > 0) {
    // Image generation and similar have a cost but no tokens.
    if (rawTotal <= 0) return { values: { ...zeroComponents(), other: bucket.cost }, estimated: false };
    const scale = bucket.cost / rawTotal;
    for (const key of Object.keys(raw) as Component[]) raw[key] *= scale;
    return { values: raw, estimated: false };
  }
  return pricing ? { values: raw, estimated: true } : { values: zeroComponents(), estimated: true };
}

/** Prompt-cache savings: what cached tokens would have cost at the full input price. */
export function cacheSavings(bucket: UsageBucket, pricing?: ModelPricing) {
  if (!pricing || pricing.cacheRead === undefined) return 0;
  return Math.max(0, bucket.cached * (pricing.prompt - pricing.cacheRead));
}

// ---------------------------------------------------------------------------
// Periods.

export type SpendingPeriod = "today" | "week" | "7d" | "month" | "30d" | "lastMonth" | "90d" | "year" | "all";
export type BinUnit = "hour" | "day" | "week" | "month";

export const PERIODS: { key: SpendingPeriod; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "7d", label: "Last 7 days" },
  { key: "month", label: "This month" },
  { key: "30d", label: "Last 30 days" },
  { key: "lastMonth", label: "Last month" },
  { key: "90d", label: "Last 90 days" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

export function isSpendingPeriod(value: unknown): value is SpendingPeriod {
  return PERIODS.some((period) => period.key === value);
}

export type PeriodRange = { start: number; end: number; unit: BinUnit };

function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(time: number, days: number) {
  const date = new Date(time);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function addMonths(time: number, months: number) {
  const date = new Date(time);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

/** Weeks start on Monday, as OpenRouter's weekly counter does. */
export function startOfWeek(time: number) {
  const day = startOfDay(time);
  const weekday = (new Date(day).getDay() + 6) % 7;
  return addDays(day, -weekday);
}

function startOfMonth(time: number) {
  const date = new Date(startOfDay(time));
  date.setDate(1);
  return date.getTime();
}

/** The period as [start, end) in local time, ending with today, and the bar width that suits it. */
export function resolvePeriod(period: SpendingPeriod, now = Date.now(), since: number | null = null): PeriodRange {
  const tomorrow = addDays(startOfDay(now), 1);
  switch (period) {
    case "today": return { start: startOfDay(now), end: tomorrow, unit: "hour" };
    case "week": return { start: startOfWeek(now), end: addDays(startOfWeek(now), 7), unit: "day" };
    case "7d": return { start: addDays(tomorrow, -7), end: tomorrow, unit: "day" };
    case "month": return { start: startOfMonth(now), end: addMonths(startOfMonth(now), 1), unit: "day" };
    case "30d": return { start: addDays(tomorrow, -30), end: tomorrow, unit: "day" };
    case "lastMonth": return { start: addMonths(startOfMonth(now), -1), end: startOfMonth(now), unit: "day" };
    case "90d": return { start: startOfWeek(addDays(tomorrow, -90)), end: addDays(startOfWeek(now), 7), unit: "week" };
    case "year": {
      const date = new Date(startOfMonth(now));
      date.setMonth(0);
      return { start: date.getTime(), end: addMonths(date.getTime(), 12), unit: "month" };
    }
    case "all": {
      const first = since === null ? addMonths(startOfMonth(now), -11) : Math.min(startOfMonth(since), startOfMonth(now));
      const days = (tomorrow - first) / 86_400_000;
      return days <= 62
        ? { start: startOfDay(Math.min(since ?? now, now)), end: tomorrow, unit: "day" }
        : { start: first, end: addMonths(startOfMonth(now), 1), unit: "month" };
    }
  }
}

/** The span just before, as long as the part of this one that has happened. */
export function previousRange(range: PeriodRange, now = Date.now()): { start: number; end: number } {
  const end = Math.min(range.end, Math.max(range.start, now));
  return { start: range.start - (end - range.start), end: range.start };
}

export function nextBinStart(time: number, unit: BinUnit) {
  if (unit === "hour") return time + HOUR;
  if (unit === "day") return addDays(time, 1);
  if (unit === "week") return addDays(time, 7);
  return addMonths(time, 1);
}

export function binStarts(range: PeriodRange) {
  const starts: number[] = [];
  for (let time = range.start; time < range.end && starts.length < 1000; time = nextBinStart(time, range.unit)) starts.push(time);
  return starts;
}

// ---------------------------------------------------------------------------
// Series.

export type Metric = "cost" | "tokens";
export type Breakdown = "component" | "model";

export const OTHER_MODELS = "\u0000other";
/** Categorical slots for models; the rest fold into "Other models". */
export const MODEL_SLOTS = 7;

/**
 * Models in color order: the costliest overall first, so a model keeps its
 * color whichever period is shown (color follows the model, not its rank in
 * the period). Ties and token-only models fall back to tokens.
 */
export function modelOrder(buckets: UsageBucket[]) {
  const totals = new Map<string, { cost: number; tokens: number }>();
  for (const bucket of buckets) {
    const total = totals.get(bucket.model) ?? { cost: 0, tokens: 0 };
    total.cost += bucket.cost;
    total.tokens += bucket.input + bucket.output;
    totals.set(bucket.model, total);
  }
  return [...totals.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens || a[0].localeCompare(b[0])).map(([model]) => model);
}

export type SeriesKey = { key: string; label: string; detail?: string };
export type ChartBin = { start: number; end: number; values: Record<string, number>; total: number };
export type ChartData = { keys: SeriesKey[]; bins: ChartBin[]; max: number; total: number };

export function bucketValues(bucket: UsageBucket, metric: Metric, models: Record<string, ModelInfo>): ComponentValues {
  return metric === "tokens" ? tokenComponents(bucket) : costComponents(bucket, models[bucket.model]?.pricing).values;
}

function sum(values: ComponentValues) {
  return values.input + values.cacheRead + values.cacheWrite + values.output + values.other;
}

function inRange(bucket: UsageBucket, range: { start: number; end: number }) {
  return bucket.hour >= range.start && bucket.hour < range.end;
}

export function modelLabel(model: string, models: Record<string, ModelInfo>) {
  if (model === OTHER_MODELS) return "Other models";
  const name = models[model]?.name;
  // "Anthropic: Claude Sonnet" reads as a model; its provider is in the id.
  return name ? name.replace(/^[^:]+:\s*/, "") : model.split("/").at(-1) ?? model;
}

/** Stacked bars for the period: one bin per hour, day, week or month, one segment per component or model. */
export function buildChart(report: UsageReport, range: PeriodRange, metric: Metric, breakdown: Breakdown): ChartData {
  const starts = binStarts(range);
  const bins: ChartBin[] = starts.map((start, index) => ({ start, end: starts[index + 1] ?? range.end, values: {}, total: 0 }));
  const order = modelOrder(report.buckets);
  const slotted = new Set(order.slice(0, MODEL_SLOTS));
  const seen = new Set<string>();

  let cursor = 0;
  for (const bucket of report.buckets) {
    if (!inRange(bucket, range)) continue;
    // Buckets are sorted, so the bin only ever moves forward.
    while (cursor < bins.length - 1 && bucket.hour >= bins[cursor].end) cursor++;
    while (cursor > 0 && bucket.hour < bins[cursor].start) cursor--;
    const bin = bins[cursor];
    const values = bucketValues(bucket, metric, report.models);
    if (breakdown === "component") {
      for (const component of COMPONENTS) {
        if (!values[component.key]) continue;
        bin.values[component.key] = (bin.values[component.key] ?? 0) + values[component.key];
        seen.add(component.key);
      }
    } else {
      const key = slotted.has(bucket.model) ? bucket.model : OTHER_MODELS;
      const value = sum(values);
      if (!value) continue;
      bin.values[key] = (bin.values[key] ?? 0) + value;
      seen.add(key);
    }
  }

  for (const bin of bins) bin.total = Object.values(bin.values).reduce((total, value) => total + value, 0);
  const keys: SeriesKey[] = breakdown === "component"
    ? COMPONENTS.filter((component) => seen.has(component.key)).map(({ key, label, detail }) => ({ key, label, detail }))
    : [...order.slice(0, MODEL_SLOTS), OTHER_MODELS].filter((model) => seen.has(model)).map((model) => ({ key: model, label: modelLabel(model, report.models) }));
  return {
    keys,
    bins,
    max: bins.reduce((max, bin) => Math.max(max, bin.total), 0),
    total: bins.reduce((total, bin) => total + bin.total, 0),
  };
}

export type PeriodSummary = {
  cost: number;
  /** True when some of the cost is an estimate from prices (no reported cost). */
  estimated: boolean;
  costs: ComponentValues;
  tokens: ComponentValues;
  totalTokens: number;
  reasoning: number;
  requests: number;
  /** Share of prompt tokens served from the cache. */
  cacheHitRate: number;
  cacheSavings: number;
  activeDays: number;
};

export function summarize(report: UsageReport, range: { start: number; end: number }): PeriodSummary {
  const summary: PeriodSummary = {
    cost: 0, estimated: false, costs: zeroComponents(), tokens: zeroComponents(), totalTokens: 0,
    reasoning: 0, requests: 0, cacheHitRate: 0, cacheSavings: 0, activeDays: 0,
  };
  let input = 0;
  const days = new Set<number>();
  for (const bucket of report.buckets) {
    if (!inRange(bucket, range)) continue;
    const pricing = report.models[bucket.model]?.pricing;
    const costs = costComponents(bucket, pricing);
    const tokens = tokenComponents(bucket);
    for (const component of COMPONENTS) {
      summary.costs[component.key] += costs.values[component.key];
      summary.tokens[component.key] += tokens[component.key];
    }
    summary.estimated ||= costs.estimated && sum(costs.values) > 0;
    summary.reasoning += bucket.reasoning;
    summary.requests += bucket.requests;
    summary.cacheSavings += cacheSavings(bucket, pricing);
    input += bucket.input;
    days.add(startOfDay(bucket.hour));
  }
  summary.cost = sum(summary.costs);
  summary.totalTokens = sum(summary.tokens);
  summary.cacheHitRate = input ? summary.tokens.cacheRead / input : 0;
  summary.activeDays = days.size;
  return summary;
}

export type ModelRow = {
  model: string;
  label: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  cost: number;
  costs: ComponentValues;
  share: number;
};

/** Per-model totals for the period, costliest first. */
export function modelRows(report: UsageReport, range: { start: number; end: number }, metric: Metric): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const bucket of report.buckets) {
    if (!inRange(bucket, range)) continue;
    let row = rows.get(bucket.model);
    if (!row) {
      row = { model: bucket.model, label: modelLabel(bucket.model, report.models), requests: 0, input: 0, output: 0, cached: 0, cost: 0, costs: zeroComponents(), share: 0 };
      rows.set(bucket.model, row);
    }
    const costs = costComponents(bucket, report.models[bucket.model]?.pricing).values;
    for (const component of COMPONENTS) row.costs[component.key] += costs[component.key];
    row.cost += sum(costs);
    row.requests += bucket.requests;
    row.input += bucket.input;
    row.output += bucket.output;
    row.cached += bucket.cached;
  }
  const list = [...rows.values()];
  const measure = (row: ModelRow) => metric === "cost" ? row.cost : row.input + row.output;
  const total = list.reduce((sumOf, row) => sumOf + measure(row), 0);
  for (const row of list) row.share = total ? measure(row) / total : 0;
  return list.sort((a, b) => measure(b) - measure(a) || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Calendar heatmap.

export type HeatmapDay = { day: number; value: number; requests: number; level: 0 | 1 | 2 | 3 | 4; future: boolean };
export type Heatmap = { weeks: HeatmapDay[][]; max: number; total: number; activeDays: number; thresholds: number[] };

/**
 * One cell per day for the last `weeks` weeks, a column per week (Monday on
 * top). Levels split the active days into quartiles, so a few heavy days do
 * not wash every other day out to the lightest step.
 */
export function buildHeatmap(report: UsageReport, metric: Metric, now = Date.now(), weeks = 53): Heatmap {
  const firstDay = addDays(startOfWeek(now), -(weeks - 1) * 7);
  const today = startOfDay(now);
  const byDay = new Map<number, { value: number; requests: number }>();
  for (const bucket of report.buckets) {
    if (bucket.hour < firstDay) continue;
    const day = startOfDay(bucket.hour);
    const cell = byDay.get(day) ?? { value: 0, requests: 0 };
    cell.value += sum(bucketValues(bucket, metric, report.models));
    cell.requests += bucket.requests;
    byDay.set(day, cell);
  }
  const active = [...byDay.values()].map((cell) => cell.value).filter((value) => value > 0).sort((a, b) => a - b);
  const quantile = (q: number) => active.length ? active[Math.min(active.length - 1, Math.floor(q * active.length))] : 0;
  const thresholds = [quantile(0.25), quantile(0.5), quantile(0.75)];
  const level = (value: number): HeatmapDay["level"] => value <= 0 ? 0 : value <= thresholds[0] ? 1 : value <= thresholds[1] ? 2 : value <= thresholds[2] ? 3 : 4;

  const columns: HeatmapDay[][] = [];
  let day = firstDay;
  for (let week = 0; week < weeks; week++) {
    const column: HeatmapDay[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const cell = byDay.get(day);
      column.push({ day, value: cell?.value ?? 0, requests: cell?.requests ?? 0, level: level(cell?.value ?? 0), future: day > today });
      day = addDays(day, 1);
    }
    columns.push(column);
  }
  return {
    weeks: columns,
    max: active.at(-1) ?? 0,
    total: active.reduce((total, value) => total + value, 0),
    activeDays: active.length,
    thresholds,
  };
}

// ---------------------------------------------------------------------------
// Formatting.

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exactNumber = new Intl.NumberFormat("en");

export function formatCost(value: number, { precise = false } = {}) {
  if (!value) return "$0";
  if (value >= 10_000) return `$${compactNumber.format(value)}`;
  if (value >= 100) return `$${value.toFixed(precise ? 2 : 0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(precise ? 4 : 3)}`;
  if (value >= 0.0001) return `$${value.toFixed(4)}`;
  return "<$0.0001";
}

export function formatTokens(value: number, { exact = false } = {}) {
  return exact ? exactNumber.format(Math.round(value)) : compactNumber.format(Math.round(value));
}

export function formatMetric(value: number, metric: Metric, options?: { precise?: boolean; exact?: boolean }) {
  return metric === "cost" ? formatCost(value, options) : formatTokens(value, options);
}
