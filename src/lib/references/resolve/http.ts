// HTTP for the metadata sources (docs/references/plan.md §4.4 step 2): one
// rate limiter per host, a timeout per attempt, retries with exponential
// backoff on 429 and 5xx (honouring Retry-After), a response cache keyed by
// URL, and a User-Agent that names Libera. `fetch` is injectable so tests
// replay recorded responses instead of calling live services.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HostLimit = {
  /** Minimum time between the starts of two requests to the host. */
  intervalMs: number;
  /** Requests to the host in flight at once. */
  concurrency: number;
};

/**
 * Per-host limits, from each service's published guidance where it has one:
 * arXiv asks for one request every three seconds; NCBI allows three per
 * second without an API key; Crossref's public pool allows a few per second
 * with little concurrency; OpenAlex and DataCite allow more. Unknown hosts
 * (web pages) get one request per second.
 */
export const DEFAULT_HOST_LIMITS: Record<string, HostLimit> = {
  "api.crossref.org": { intervalMs: 250, concurrency: 1 },
  "api.datacite.org": { intervalMs: 200, concurrency: 2 },
  "export.arxiv.org": { intervalMs: 3_000, concurrency: 1 },
  "api.openalex.org": { intervalMs: 150, concurrency: 2 },
  "eutils.ncbi.nlm.nih.gov": { intervalMs: 350, concurrency: 1 },
  "openlibrary.org": { intervalMs: 500, concurrency: 1 },
};
const DEFAULT_LIMIT: HostLimit = { intervalMs: 1_000, concurrency: 1 };

export const LIBERA_USER_AGENT = "Libera/1.0 (desktop notes and reference manager; metadata lookup)";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** A response the caller cannot use: an HTTP error after retries, or a body over the size limit. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly url: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function abortError(signal?: AbortSignal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("The lookup was cancelled.");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

/** Waits `ms`, or rejects with an AbortError when `signal` aborts first. */
export function abortableDelay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Spacing and concurrency for one host. Waiters are served in order. */
class HostLimiter {
  private active = 0;
  private nextStart = 0;
  private waiting: { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort: () => void }[] = [];

  constructor(private limit: HostLimit, private now: () => number, private sleep: (ms: number, signal?: AbortSignal) => Promise<void>) {}

  async acquire(signal?: AbortSignal) {
    if (signal?.aborted) throw abortError(signal);
    if (this.active >= this.limit.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve, reject, signal,
          onAbort: () => {
            this.waiting = this.waiting.filter((item) => item !== waiter);
            reject(abortError(signal));
          },
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        this.waiting.push(waiter);
      });
    }
    this.active += 1;
    const now = this.now();
    const start = Math.max(now, this.nextStart);
    this.nextStart = start + this.limit.intervalMs;
    try {
      await this.sleep(start - now, signal);
    } catch (error) {
      this.release();
      throw error;
    }
  }

  release() {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) {
      next.signal?.removeEventListener("abort", next.onAbort);
      next.resolve();
    }
  }

  /** After a 429 the whole host waits, not only the request that got it. */
  pause(ms: number) {
    this.nextStart = Math.max(this.nextStart, this.now() + ms);
  }
}

export type HttpClientOptions = {
  fetch?: FetchLike;
  userAgent?: string;
  hostLimits?: Record<string, HostLimit>;
  timeoutMs?: number;
  retries?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  cacheTtlMs?: number;
};

export type HttpRequestOptions = {
  signal?: AbortSignal;
  accept?: string;
  /** Bodies larger than this fail with HttpError 413. */
  maxBytes?: number;
  /** false skips the response cache (for pages that change). */
  cache?: boolean;
};

export type HttpTextResponse = { status: number; url: string; contentType: string; text: string };

type CacheEntry = { expires: number; response: HttpTextResponse };

function parseRetryAfter(value: string | null, now: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

async function readLimited(response: Response, maxBytes: number, url: string) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError("The response is too large.", 413, url);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError("The response is too large.", 413, url);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * GET with politeness built in. 200 responses are returned; 404 and 410
 * resolve to null (the record does not exist); other statuses throw
 * HttpError once retries are exhausted. Successful and not-found responses
 * are cached for a day.
 */
export class HttpClient {
  private limiters = new Map<string, HostLimiter>();
  private cache = new Map<string, CacheEntry>();
  private fetchImpl: FetchLike;
  private now: () => number;
  private sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private options: HttpClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableDelay;
  }

  private limiter(host: string) {
    let limiter = this.limiters.get(host);
    if (!limiter) {
      const limit = this.options.hostLimits?.[host] ?? DEFAULT_HOST_LIMITS[host] ?? DEFAULT_LIMIT;
      limiter = new HostLimiter(limit, this.now, this.sleep);
      this.limiters.set(host, limiter);
    }
    return limiter;
  }

  private cached(key: string) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    // Refresh the entry's position so the least recently used goes first.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.response;
  }

  private remember(key: string, response: HttpTextResponse) {
    this.cache.set(key, { expires: this.now() + (this.options.cacheTtlMs ?? CACHE_TTL_MS), response });
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }

  clearCache() {
    this.cache.clear();
  }

  /** The response, or null for 404/410. */
  async getText(url: string, options: HttpRequestOptions = {}): Promise<HttpTextResponse | null> {
    const key = `${options.accept ?? ""} ${url}`;
    if (options.cache !== false) {
      const hit = this.cached(key);
      if (hit) return hit.status === 200 ? hit : null;
    }
    const host = new URL(url).host;
    const limiter = this.limiter(host);
    const retries = this.options.retries ?? DEFAULT_RETRIES;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (options.signal?.aborted) throw abortError(options.signal);
      await limiter.acquire(options.signal);
      let retryAfter: number | undefined;
      try {
        const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await this.fetchImpl(url, {
          headers: { "User-Agent": this.options.userAgent ?? LIBERA_USER_AGENT, Accept: options.accept ?? "application/json" },
          redirect: "follow",
          signal,
        });
        if (response.status === 404 || response.status === 410) {
          await response.body?.cancel().catch(() => undefined);
          if (options.cache !== false) this.remember(key, { status: 404, url: response.url || url, contentType: "", text: "" });
          return null;
        }
        if (response.ok) {
          const text = await readLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES, url);
          const result = { status: 200, url: response.url || url, contentType: response.headers.get("content-type") ?? "", text };
          if (options.cache !== false) this.remember(key, result);
          return result;
        }
        await response.body?.cancel().catch(() => undefined);
        lastError = new HttpError(`${host} answered ${response.status}.`, response.status, url);
        if (!RETRY_STATUSES.has(response.status)) throw lastError;
        retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.now());
        if (response.status === 429) limiter.pause(Math.min(retryAfter ?? BASE_BACKOFF_MS * 2 ** attempt, MAX_RETRY_AFTER_MS));
      } catch (error) {
        if (options.signal?.aborted) throw abortError(options.signal);
        if (error instanceof HttpError && !RETRY_STATUSES.has(error.status)) throw error;
        // Network failures and timeouts are retried like 5xx.
        lastError = error instanceof HttpError ? error : new HttpError(`${host} could not be reached.`, 0, url);
      } finally {
        limiter.release();
      }
      if (attempt < retries) {
        const backoff = Math.min(retryAfter ?? BASE_BACKOFF_MS * 2 ** attempt, MAX_RETRY_AFTER_MS);
        await this.sleep(backoff, options.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new HttpError(`${host} could not be reached.`, 0, url);
  }

  /** Parsed JSON, or null for 404/410. */
  async getJson<T>(url: string, options: HttpRequestOptions = {}): Promise<T | null> {
    const response = await this.getText(url, { accept: "application/json", ...options });
    if (!response) return null;
    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new HttpError(`${new URL(url).host} returned invalid JSON.`, 502, url);
    }
  }
}

const CLIENT_KEY = Symbol.for("libera.referenceHttpClient");

/** The process-wide client, so rate limits and the cache are shared by every request and job. */
export function getReferenceHttpClient() {
  const store = globalThis as { [CLIENT_KEY]?: HttpClient };
  store[CLIENT_KEY] ??= new HttpClient();
  return store[CLIENT_KEY];
}
