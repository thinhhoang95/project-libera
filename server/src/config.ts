// Server configuration from environment variables. Every variable is listed in
// server/.env.example and documented in SETUP.md.

import { z } from "zod";

const boolean = z
  .string()
  .optional()
  .transform((value) => value === "1" || value === "true" || value === "yes");

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(4400),
  /** Public base URL used in invitation links, e.g. https://libera-collab.intuelle.com */
  PUBLIC_URL: z.string().default("http://127.0.0.1:4400"),
  /**
   * postgres://user:pass@host/db for Postgres, pglite://<directory> for an
   * embedded PGlite database (development), or pglite://memory (tests).
   */
  DATABASE_URL: z.string().default("pglite://./data/pglite"),
  /** Secret for signing access tokens. At least 32 characters in production. */
  JWT_SECRET: z.string().min(16).default("development-only-secret-change-me"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  /**
   * Refresh tokens rotate on every use and each rotation starts a new
   * lifetime, so this is how long a device may stay unused before its user
   * has to sign in again.
   */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(90),
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(14),
  /**
   * Sign-up without a registration code. Off by default: the server is
   * invitation-only and new accounts need a code from `admin signup-code create`.
   */
  ALLOW_OPEN_SIGNUP: boolean,
  /** "disk" (BLOB_DIR) or "s3" (BLOB_S3_*). */
  BLOB_DRIVER: z.enum(["disk", "s3"]).default("disk"),
  BLOB_DIR: z.string().default("./data/blobs"),
  BLOB_S3_ENDPOINT: z.string().optional(),
  BLOB_S3_REGION: z.string().default("us-east-1"),
  BLOB_S3_BUCKET: z.string().optional(),
  BLOB_S3_ACCESS_KEY: z.string().optional(),
  BLOB_S3_SECRET_KEY: z.string().optional(),
  MAX_BLOB_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  /** SMTP connection URL, e.g. smtp://user:pass@host:587. Unset: emails are logged. */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default("Libera <no-reply@libera.local>"),
  MIN_PROTOCOL_VERSION: z.coerce.number().int().positive().optional(),
  MIN_APP_VERSION: z.string().default("0.0.0"),
  /** Bearer token for GET /metrics. Unset: metrics are only served to 127.0.0.1. */
  METRICS_TOKEN: z.string().optional(),
  /** Max new WebSocket connections per IP per minute (admission control). */
  SYNC_CONNECTIONS_PER_MINUTE: z.coerce.number().int().positive().default(60),
  /** Max concurrently open sockets per account. */
  SYNC_MAX_SOCKETS_PER_ACCOUNT: z.coerce.number().int().positive().default(8),
  /** Server snapshots a sub-document after this many updates. */
  SNAPSHOT_EVERY_UPDATES: z.coerce.number().int().positive().default(2000),
  /** Updates older than this (and covered by a snapshot and revision) may be pruned. */
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  /** Unloaded rooms are evicted after this long without connections. */
  ROOM_IDLE_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.string().default("info"),
  /**
   * Sentry-compatible DSN (Sentry, self-hosted GlitchTip) for crash and error
   * reports, e.g. https://<key>@glitchtip.example.com/<project>. Unset: errors
   * are only logged. Reports carry ids, sizes, codes and stacks, never content.
   */
  ERROR_REPORT_DSN: z.string().optional(),
  /** Environment tag on error reports. Defaults to NODE_ENV. */
  ERROR_REPORT_ENVIRONMENT: z.string().optional(),
  TRUST_PROXY: boolean,
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid server configuration:\n${problems.join("\n")}`);
  }
  const config = { ...parsed.data, ...overrides };
  if (config.NODE_ENV === "production") {
    if (config.JWT_SECRET.length < 32 || config.JWT_SECRET.startsWith("development-only")) {
      throw new Error("JWT_SECRET must be set to a random value of at least 32 characters in production.");
    }
    if (config.BLOB_DRIVER === "s3" && (!config.BLOB_S3_BUCKET || !config.BLOB_S3_ENDPOINT)) {
      throw new Error("BLOB_S3_ENDPOINT and BLOB_S3_BUCKET are required when BLOB_DRIVER=s3.");
    }
  }
  return config;
}
