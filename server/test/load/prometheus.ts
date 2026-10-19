// Reads the server's /metrics text: plain samples, and quantiles of a
// histogram over the difference of two scrapes (Prometheus-style linear
// interpolation inside the bucket).

export type Samples = Map<string, number>;

/** Parses the exposition format into "name{labels}" -> value. */
export function parseMetrics(text: string): Samples {
  const samples: Samples = new Map();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const space = line.lastIndexOf(" ");
    const value = Number(line.slice(space + 1));
    if (Number.isFinite(value)) samples.set(line.slice(0, space), value);
  }
  return samples;
}

export function sample(samples: Samples, key: string): number {
  return samples.get(key) ?? 0;
}

/** Sum of every sample of `name` (any labels). */
export function total(samples: Samples, name: string): number {
  let sum = 0;
  for (const [key, value] of samples) if (key === name || key.startsWith(`${name}{`)) sum += value;
  return sum;
}

/** Per-label values of a counter, e.g. rejects by reason. */
export function byLabel(samples: Samples, name: string, label: string): Record<string, number> {
  const result: Record<string, number> = {};
  const pattern = new RegExp(`${label}="([^"]*)"`);
  for (const [key, value] of samples) {
    if (!key.startsWith(`${name}{`)) continue;
    const match = pattern.exec(key);
    if (match) result[match[1]] = (result[match[1]] ?? 0) + value;
  }
  return result;
}

/** Quantile (seconds) of histogram `name` between two scrapes. */
export function histogramQuantile(before: Samples, after: Samples, name: string, q: number): number | null {
  const buckets: Array<{ le: number; count: number }> = [];
  for (const [key, value] of after) {
    if (!key.startsWith(`${name}_bucket{`)) continue;
    const match = /le="([^"]+)"/.exec(key);
    if (!match) continue;
    const le = match[1] === "+Inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
    buckets.push({ le, count: value - (before.get(key) ?? 0) });
  }
  buckets.sort((a, b) => a.le - b.le);
  const totalCount = buckets.at(-1)?.count ?? 0;
  if (totalCount <= 0) return null;
  const rank = q * totalCount;
  let previousLe = 0;
  let previousCount = 0;
  for (const bucket of buckets) {
    if (bucket.count >= rank) {
      if (!Number.isFinite(bucket.le)) return previousLe;
      const inBucket = bucket.count - previousCount;
      return inBucket <= 0 ? bucket.le : previousLe + ((bucket.le - previousLe) * (rank - previousCount)) / inBucket;
    }
    previousLe = bucket.le;
    previousCount = bucket.count;
  }
  return previousLe;
}

export function histogramCount(before: Samples, after: Samples, name: string): number {
  return sample(after, `${name}_count`) - sample(before, `${name}_count`);
}
