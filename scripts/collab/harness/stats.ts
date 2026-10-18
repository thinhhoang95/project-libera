// Small numeric helpers for harness measurements and the numbers reported
// in docs/collaboration/testing.md.

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function summarize(values: readonly number[]): { n: number; p50: number; p95: number; max: number } {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? Number.NaN : Math.max(...values),
  };
}

export function ms(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 0)} ms`;
}

/**
 * Multiplier for timing bounds. Budgets from source-plan §10 are asserted
 * with this slack so a loaded CI machine does not flake; the measured
 * numbers are always printed so a regression is visible anyway.
 */
export const PERF_SLACK = Number(process.env.LIBERA_COLLAB_PERF_SLACK ?? 3);

export const HEAVY = process.env.LIBERA_COLLAB_HEAVY === "1";

/** One line per measurement, easy to grep out of the test log ("[collab-perf]"). */
export function report(name: string, value: string): void {
  console.log(`[collab-perf] ${name}: ${value}`);
}
