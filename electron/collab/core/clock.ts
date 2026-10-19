// Injectable time source and timers, so reconnect, batching and status
// debouncing can be tested deterministically.

/** Opaque handle returned by Clock.setTimeout. */
export type TimerHandle = unknown;

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
}

/**
 * Real timers. They are unref'd: the host process is kept alive by its
 * parent port, and tests should not hang on a pending reconnect timer.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, Math.max(0, ms));
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    if (handle) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Yields to the event loop so I/O and timers can run between work chunks. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface Logger {
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export const consoleLogger: Logger = {
  warn: (message, detail) => console.warn(`[collab-host] ${message}`, detail ?? ""),
  error: (message, detail) => console.error(`[collab-host] ${message}`, detail ?? ""),
};

export const silentLogger: Logger = { warn: () => {}, error: () => {} };

/** A tiny typed event emitter; listeners that throw do not break the others. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  on(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        consoleLogger.error("listener failed", error);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}
