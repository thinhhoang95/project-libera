// In-memory fixed-window rate limits for the auth routes. The server is one
// process in v1 (see events.ts), so memory is enough; limits reset on restart,
// which only ever loosens them.

import type { FastifyReply } from "fastify";

import type { ServerContext } from "../context.js";
import { HttpError } from "../http/errors.js";

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Counts one attempt. Returns the seconds to wait when over the limit, else 0. */
  hit(key: string, now = Date.now()): number {
    if (this.windows.size > 10_000) this.prune(now);
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window.count > this.limit ? Math.ceil((window.resetAt - now) / 1000) : 0;
  }

  private prune(now: number) {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

export interface AuthLimits {
  loginPerIp: RateLimiter;
  loginPerEmail: RateLimiter;
  registerPerIp: RateLimiter;
  registerPerEmail: RateLimiter;
  refreshPerIp: RateLimiter;
  deviceGrantPerIp: RateLimiter;
}

function defaults(): AuthLimits {
  const minute = 60_000;
  return {
    loginPerIp: new RateLimiter(30, 5 * minute),
    // Per email, so one address cannot be brute-forced from many IPs.
    loginPerEmail: new RateLimiter(10, 15 * minute),
    registerPerIp: new RateLimiter(30, 60 * minute),
    registerPerEmail: new RateLimiter(5, 60 * minute),
    refreshPerIp: new RateLimiter(120, minute),
    // Grants are long random secrets; this only stops a runaway client.
    deviceGrantPerIp: new RateLimiter(30, 5 * minute),
  };
}

const limits = new WeakMap<object, AuthLimits>();

export function authLimits(context: ServerContext): AuthLimits {
  let value = limits.get(context);
  if (!value) {
    value = defaults();
    limits.set(context, value);
  }
  return value;
}

/** Counts the attempt against every limiter and throws 429 if any is exceeded. */
export function enforce(reply: FastifyReply, checks: [RateLimiter, string][]): void {
  let wait = 0;
  for (const [limiter, key] of checks) wait = Math.max(wait, limiter.hit(key));
  if (wait > 0) {
    reply.header("retry-after", String(wait));
    throw new HttpError("rate-limited", "Too many attempts. Try again later.", { retryAfterSeconds: wait });
  }
}
