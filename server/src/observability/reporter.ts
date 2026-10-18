// Pluggable error reporting to a Sentry-compatible server (Sentry, or
// self-hosted GlitchTip as the plan prefers), configured by ERROR_REPORT_DSN.
// No SDK: events go to the envelope endpoint with fetch.
//
// Reports never carry document content, comment bodies, emails or tokens.
// What is sent is built from an allowlist, not by stripping a full event:
//   - the error type, and its message with quoted text, emails, long tokens
//     and Postgres key details removed, cut to 300 characters;
//   - stack frames (function, file relative to the app, line, column);
//   - tags whose keys are known id fields and whose values look like ids;
//   - numeric extras (sizes, counts, durations).
// The same rules apply to every `cause` in the chain.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { SERVER_VERSION } from "../api/system.js";
import type { ServerContext } from "../context.js";

export type ReportValue = string | number | boolean | null | undefined;
export type ReportContext = Record<string, ReportValue>;

export interface ErrorReporter {
  readonly enabled: boolean;
  /** Queues a report. Returns the event id, or null when nothing is sent. Never throws. */
  capture(error: unknown, context?: ReportContext): string | null;
  /** Waits for queued reports (bounded by `timeoutMs`). */
  flush(timeoutMs?: number): Promise<void>;
}

export interface ParsedDsn {
  /** The envelope URL events are posted to. */
  envelopeUrl: string;
  publicKey: string;
  projectId: string;
}

/** Parses https://<publicKey>[:secret]@<host>[/<path>]/<projectId>. Throws on anything else. */
export function parseDsn(dsn: string): ParsedDsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error("ERROR_REPORT_DSN is not a URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("ERROR_REPORT_DSN must be http(s).");
  if (!url.username) throw new Error("ERROR_REPORT_DSN has no public key.");
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("ERROR_REPORT_DSN has no project id.");
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  return {
    envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
    publicKey: decodeURIComponent(url.username),
    projectId,
  };
}

// ------------------------------------------------------------------ scrubbing

const MAX_MESSAGE = 300;

/**
 * Removes anything from an error message that could be user data. Messages
 * written by this server name ids and counts; messages from libraries (pg,
 * yjs, zod) can quote values, which this drops.
 */
export function scrubMessage(message: string): string {
  let text = message.replace(/\s+/g, " ");
  // Postgres details: Key (email)=(someone@example.com) already exists.
  text = text.replace(/\(([^()]*)\)=\([^()]*\)/g, "($1)=([redacted])");
  // Quoted text in any style.
  text = text.replace(/"(?:[^"\\]|\\.)*"/g, '"[redacted]"');
  text = text.replace(/'(?:[^'\\]|\\.)*'/g, "'[redacted]'");
  text = text.replace(/`[^`]*`/g, "`[redacted]`");
  text = text.replace(/[“‘][^”’]*[”’]/g, "“[redacted]”");
  // Emails, bearer tokens, JWTs and long base64/hex runs.
  text = text.replace(/[^\s@()<>,;:"']+@[^\s@()<>,;:"']+\.[A-Za-z]{2,}/g, "[email]");
  text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]");
  text = text.replace(/[A-Za-z0-9+/=_-]{48,}/g, "[blob]");
  if (text.length > MAX_MESSAGE) text = `${text.slice(0, MAX_MESSAGE)}…`;
  return text;
}

/** Tag keys that may be sent. Values must also look like ids (idValue). */
const TAG_KEYS = new Set([
  "area",
  "route",
  "method",
  "statusCode",
  "code",
  "docId",
  "projectId",
  "accountId",
  "clientId",
  "subdoc",
  "job",
  "kind",
  "threadId",
  "messageId",
  "suggestionId",
  "reviewId",
  "requestId",
  "messageType",
  "signal",
  "reason",
]);

const ID_VALUE = /^[A-Za-z0-9_.:/-]{1,200}$/;

export interface ScrubbedContext {
  tags: Record<string, string>;
  extra: Record<string, number | boolean>;
}

/** Keeps known id tags with id-shaped values and numeric or boolean extras; drops the rest. */
export function scrubContext(context: ReportContext = {}): ScrubbedContext {
  const tags: Record<string, string> = {};
  const extra: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === null || value === undefined) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) extra[key] = value;
    } else if (typeof value === "boolean") {
      extra[key] = value;
    } else if (TAG_KEYS.has(key) && ID_VALUE.test(value)) {
      tags[key] = value;
    }
  }
  return { tags, extra };
}

export interface StackFrame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const FRAME_WITH_FUNCTION = /^\s*at (?:async )?(.+?) \((.+?):(\d+):(\d+)\)\s*$/;
const FRAME_BARE = /^\s*at (?:async )?(.+?):(\d+):(\d+)\s*$/;

function relativeFile(file: string): string {
  let path = file.replace(/^file:\/\//, "").replace(/\\/g, "/");
  for (const marker of ["/server/dist/", "/server/src/", "/app/dist/", "/node_modules/"]) {
    const index = path.lastIndexOf(marker);
    if (index >= 0) {
      path = (marker === "/node_modules/" ? "node_modules/" : marker.slice(1)) + path.slice(index + marker.length);
      break;
    }
  }
  return path;
}

/** Parses a V8 stack into Sentry frames (oldest first). Lines that are not frames are dropped. */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n").slice(1, 60)) {
    let fn: string | undefined;
    let file: string;
    let lineno: string;
    let colno: string;
    const named = FRAME_WITH_FUNCTION.exec(line);
    if (named) {
      [, fn, file, lineno, colno] = named;
    } else {
      const bare = FRAME_BARE.exec(line);
      if (!bare) continue;
      [, file, lineno, colno] = bare;
    }
    const filename = relativeFile(file);
    frames.push({
      function: fn && /^[\w$.<>\[\] -]{1,200}$/.test(fn) ? fn : undefined,
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: !filename.startsWith("node_modules/") && !filename.startsWith("node:"),
    });
  }
  return frames.reverse();
}

export interface ExceptionValue {
  type: string;
  value: string;
  stacktrace?: { frames: StackFrame[] };
}

function errorType(error: unknown): string {
  if (error instanceof Error) return /^[A-Za-z0-9_$]{1,80}$/.test(error.name) ? error.name : "Error";
  return typeof error === "object" && error !== null ? "NonErrorObject" : `Non-Error ${typeof error}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const prefix = typeof code === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(code) ? `[${code}] ` : "";
    return prefix + scrubMessage(error.message);
  }
  // A thrown string or object may be anything; only its kind is reported.
  return "";
}

/** The exception chain (outermost last, as Sentry expects), at most four deep. */
export function exceptionValues(error: unknown): ExceptionValue[] {
  const values: ExceptionValue[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const frames = current instanceof Error ? parseStack(current.stack) : [];
    values.push({
      type: errorType(current),
      value: errorMessage(current),
      ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
    });
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return values.reverse();
}

export interface ReportMeta {
  release: string;
  environment: string;
  serverName?: string;
}

export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node";
  level: "error" | "fatal";
  logger: string;
  release: string;
  environment: string;
  server_name?: string;
  tags: Record<string, string>;
  extra: Record<string, number | boolean>;
  exception: { values: ExceptionValue[] };
}

/** Builds the event that would be sent for `error`. Pure, so the scrubbing is testable. */
export function buildEvent(error: unknown, context: ReportContext | undefined, meta: ReportMeta, level: "error" | "fatal" = "error"): SentryEvent {
  const { tags, extra } = scrubContext(context);
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level,
    logger: "libera-collab",
    release: meta.release,
    environment: meta.environment,
    ...(meta.serverName ? { server_name: meta.serverName } : {}),
    tags,
    extra,
    exception: { values: exceptionValues(error) },
  };
}

/** The envelope body for one event. */
export function envelope(event: SentryEvent, dsn: string): string {
  const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn });
  const payload = JSON.stringify(event);
  const item = JSON.stringify({ type: "event", content_type: "application/json", length: Buffer.byteLength(payload) });
  return `${header}\n${item}\n${payload}\n`;
}

// ------------------------------------------------------------------ transport

export interface ReporterOptions {
  dsn?: string;
  release: string;
  environment: string;
  /** Replaced in tests. */
  fetch?: typeof fetch;
  /** Reports above this per minute are dropped (an error loop must not flood the server). */
  maxPerMinute?: number;
  onTransportError?: (error: unknown) => void;
}

const disabled: ErrorReporter = {
  enabled: false,
  capture: () => null,
  flush: async () => undefined,
};

export function createErrorReporter(options: ReporterOptions): ErrorReporter {
  if (!options.dsn) return disabled;
  const parsed = parseDsn(options.dsn);
  const dsn = options.dsn;
  const send = options.fetch ?? fetch;
  const maxPerMinute = options.maxPerMinute ?? 30;
  const meta: ReportMeta = { release: options.release, environment: options.environment, serverName: hostname() };
  const auth = `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=libera-collab/${options.release}`;
  const pending = new Set<Promise<void>>();
  let windowStart = Date.now();
  let sentInWindow = 0;

  return {
    enabled: true,
    capture(error, context) {
      try {
        const now = Date.now();
        if (now - windowStart >= 60_000) {
          windowStart = now;
          sentInWindow = 0;
        }
        if (sentInWindow >= maxPerMinute) return null;
        sentInWindow += 1;
        const level = context?.fatal === true ? "fatal" : "error";
        const event = buildEvent(error, context, meta, level);
        const request = send(parsed.envelopeUrl, {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": auth },
          body: envelope(event, dsn),
          signal: AbortSignal.timeout(5000),
        })
          .then(async (response) => {
            // Drain the body so the connection is reused.
            await response.arrayBuffer().catch(() => undefined);
            if (!response.ok) throw new Error(`Error report rejected with HTTP ${response.status}`);
          })
          .catch((transportError: unknown) => options.onTransportError?.(transportError))
          .finally(() => pending.delete(request));
        pending.add(request);
        return event.event_id;
      } catch (buildError) {
        options.onTransportError?.(buildError);
        return null;
      }
    },
    async flush(timeoutMs = 2000) {
      if (pending.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

// ------------------------------------------------------------------ per server

// Like the mailer and the blob store, the reporter hangs off the context
// without a field on it.
const reporters = new WeakMap<object, ErrorReporter>();

export function getErrorReporter(context: ServerContext): ErrorReporter {
  let reporter = reporters.get(context);
  if (!reporter) {
    try {
      reporter = createErrorReporter({
        dsn: context.config.ERROR_REPORT_DSN,
        release: RELEASE,
        environment: context.config.ERROR_REPORT_ENVIRONMENT ?? context.config.NODE_ENV,
        onTransportError: (error) => context.log.warn({ err: error }, "Error report could not be sent"),
      });
    } catch (error) {
      context.log.error({ err: error }, "Error reporting is disabled: invalid ERROR_REPORT_DSN");
      reporter = disabled;
    }
    reporters.set(context, reporter);
  }
  return reporter;
}

export function setErrorReporter(context: ServerContext, reporter: ErrorReporter): void {
  reporters.set(context, reporter);
}

/** Reports an error for this server. Never throws. */
export function reportError(context: ServerContext, error: unknown, details?: ReportContext): void {
  try {
    getErrorReporter(context).capture(error, details);
  } catch {
    // Reporting must never turn into a second failure.
  }
}

export const RELEASE = `libera-collab@${SERVER_VERSION}`;
