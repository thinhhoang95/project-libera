// A small log-bucketed latency histogram (2 % resolution, 10 µs to 10 min)
// that can be merged across worker threads and sent as a plain array.

const GROWTH = 1.02;
const MIN_MS = 0.01;
const BUCKETS = Math.ceil(Math.log(600_000 / MIN_MS) / Math.log(GROWTH)) + 2;

export class Histogram {
  readonly counts = new Array<number>(BUCKETS).fill(0);
  count = 0;
  sum = 0;
  max = 0;

  record(ms: number): void {
    const value = Math.max(ms, 0);
    const index = value <= MIN_MS ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(value / MIN_MS) / Math.log(GROWTH)));
    this.counts[index] += 1;
    this.count += 1;
    this.sum += value;
    if (value > this.max) this.max = value;
  }

  merge(other: SerializedHistogram): void {
    for (let index = 0; index < BUCKETS; index += 1) this.counts[index] += other.counts[index] ?? 0;
    this.count += other.count;
    this.sum += other.sum;
    this.max = Math.max(this.max, other.max);
  }

  /** The value at quantile q (0..1), as the upper edge of its bucket. */
  quantile(q: number): number {
    if (this.count === 0) return 0;
    const rank = Math.ceil(q * this.count);
    let seen = 0;
    for (let index = 0; index < BUCKETS; index += 1) {
      seen += this.counts[index];
      if (seen >= rank) return Math.min(this.max, MIN_MS * GROWTH ** index);
    }
    return this.max;
  }

  summary(): LatencySummary {
    return {
      count: this.count,
      mean: this.count === 0 ? 0 : round(this.sum / this.count),
      p50: round(this.quantile(0.5)),
      p95: round(this.quantile(0.95)),
      p99: round(this.quantile(0.99)),
      max: round(this.max),
    };
  }

  serialize(): SerializedHistogram {
    return { counts: [...this.counts], count: this.count, sum: this.sum, max: this.max };
  }

  reset(): void {
    this.counts.fill(0);
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }
}

export interface SerializedHistogram {
  counts: number[];
  count: number;
  sum: number;
  max: number;
}

/** Milliseconds. */
export interface LatencySummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
