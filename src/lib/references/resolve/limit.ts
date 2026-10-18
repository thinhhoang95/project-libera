// Small concurrency helpers shared by the resolve route and the jobs runner.

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Runs at most `concurrency` tasks at once; the rest wait in order. */
export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>) => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export const unlimited: Limiter = (task) => task();

/** `mapper` over `items` with at most `concurrency` in flight; results keep the input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
