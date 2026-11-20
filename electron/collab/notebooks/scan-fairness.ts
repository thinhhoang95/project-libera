// Which files a scan reads first. A scan reads a bounded amount, and a read
// can fail or stall: without a memory of what was left out, the same early
// files take the budget (or the read slots) at every scan and later files and
// new files never get a turn. A file left out goes first at the next scan; one
// whose read failed also sits out a number of scans, doubling per failure up
// to a cap. Everything is counted in scan passes: no timer, no clock, and the
// scan cadence (battery-scaled by the service) is untouched.

/** Most scans a failing path sits out. */
export const MAX_SKIPPED_PASSES = 16;

interface Deferral {
  /** The pass in which the file was first left out (the oldest goes first). */
  since: number;
  /** Reads of it that failed in a row. */
  failures: number;
  /** It is not read before this pass. */
  skipUntil: number;
}

export class ScanFairness {
  private readonly deferred = new Map<string, Deferral>();
  private pass = 0;

  /** Starts a scan pass. */
  beginPass(): void {
    this.pass += 1;
  }

  /** `items` with the files left out by earlier scans first, oldest first; the others keep their order. */
  order<T>(items: T[], keyOf: (item: T) => string): T[] {
    if (this.deferred.size === 0) return items;
    const waiting: Array<{ item: T; since: number }> = [];
    const rest: T[] = [];
    for (const item of items) {
      const entry = this.deferred.get(keyOf(item));
      if (entry) waiting.push({ item, since: entry.since });
      else rest.push(item);
    }
    waiting.sort((a, b) => a.since - b.since);
    return [...waiting.map((entry) => entry.item), ...rest];
  }

  /** Whether `key` sits this pass out after failed reads. */
  skipped(key: string): boolean {
    const entry = this.deferred.get(key);
    return entry !== undefined && entry.skipUntil > this.pass;
  }

  /** The file was left out for lack of budget: it goes first next time. */
  leftOut(key: string): void {
    if (!this.deferred.has(key)) this.deferred.set(key, { since: this.pass, failures: 0, skipUntil: 0 });
  }

  /** A read of the file failed or stalled: it also sits out 1, 2, 4... scans, up to MAX_SKIPPED_PASSES. */
  failed(key: string): void {
    const entry = this.deferred.get(key) ?? { since: this.pass, failures: 0, skipUntil: 0 };
    entry.failures += 1;
    entry.skipUntil = this.pass + Math.min(MAX_SKIPPED_PASSES, 2 ** Math.min(10, entry.failures - 1)) + 1;
    this.deferred.set(key, entry);
  }

  /** The file was read (or no longer needs reading). */
  served(key: string): void {
    this.deferred.delete(key);
  }

  /** Drops entries for files that are gone. */
  keepOnly(live: Set<string>): void {
    for (const key of this.deferred.keys()) if (!live.has(key)) this.deferred.delete(key);
  }
}
