import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "libera_session";
/** Proof that the password was entered again to open the Protected Archive. */
export const ARCHIVE_COOKIE_NAME = "libera_archive";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
/** The archive relocks after this long without a request that renews it. */
export const ARCHIVE_MAX_AGE_SECONDS = 60 * 10;
const SESSION_SUBJECT = "admin";
const ARCHIVE_SUBJECT = "archive";

type TokenSubject = typeof SESSION_SUBJECT | typeof ARCHIVE_SUBJECT;

type SessionPayload = {
  sub: TokenSubject;
  exp: number;
};

type PasswordVerification =
  | { ok: true }
  | { ok: false; reason: "invalid" | "missing-config" };

function getSessionSecret() {
  if (process.env.LIBERA_SESSION_SECRET) {
    return process.env.LIBERA_SESSION_SECRET;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("LIBERA_SESSION_SECRET is required in production.");
  }

  return "libera-development-session-secret";
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function hashWithScrypt(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("hex");
}

export function createPasswordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${hashWithScrypt(password, salt)}`;
}

export function verifyPassword(password: string): PasswordVerification {
  const configuredHash = process.env.LIBERA_PASSWORD_HASH;

  if (!configuredHash) {
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "missing-config" };
    }

    const developmentPassword = process.env.LIBERA_DEV_PASSWORD ?? "libera";
    return safeEqual(password, developmentPassword)
      ? { ok: true }
      : { ok: false, reason: "invalid" };
  }

  if (configuredHash.startsWith("scrypt:")) {
    const [, salt, expectedHash] = configuredHash.split(":");

    if (!salt || !expectedHash) {
      return { ok: false, reason: "missing-config" };
    }

    return safeEqual(hashWithScrypt(password, salt), expectedHash)
      ? { ok: true }
      : { ok: false, reason: "invalid" };
  }

  if (configuredHash.startsWith("sha256:")) {
    const expectedHash = configuredHash.slice("sha256:".length);
    const actualHash = createHash("sha256").update(password).digest("hex");

    return safeEqual(actualHash, expectedHash)
      ? { ok: true }
      : { ok: false, reason: "invalid" };
  }

  return { ok: false, reason: "missing-config" };
}

function createToken(subject: TokenSubject, maxAgeSeconds: number) {
  const payload: SessionPayload = {
    sub: subject,
    exp: Date.now() + maxAgeSeconds * 1000,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function verifyToken(token: string | undefined, subject: TokenSubject) {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createHmac("sha256", getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");

  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;

    return payload.sub === subject && typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > Date.now()
      ? payload as SessionPayload
      : null;
  } catch {
    return null;
  }
}

export function createSessionToken() {
  return createToken(SESSION_SUBJECT, SESSION_MAX_AGE_SECONDS);
}

export function verifySessionToken(token: string | undefined) {
  return getSessionExpiresAt(token) !== null;
}

export function getSessionExpiresAt(token: string | undefined) {
  return verifyToken(token, SESSION_SUBJECT)?.exp ?? null;
}

export function createArchiveToken() {
  return createToken(ARCHIVE_SUBJECT, ARCHIVE_MAX_AGE_SECONDS);
}

export function verifyArchiveToken(token: string | undefined) {
  return verifyToken(token, ARCHIVE_SUBJECT) !== null;
}

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production" && process.env.LIBERA_ELECTRON !== "1",
  };
}

export function getArchiveCookieOptions() {
  return { ...getSessionCookieOptions(), maxAge: ARCHIVE_MAX_AGE_SECONDS, sameSite: "strict" as const };
}

/** Cookie options that remove a cookie at once. */
export function getExpiredCookieOptions() {
  return { ...getSessionCookieOptions(), maxAge: 0 };
}

/**
 * Wrong archive passwords slow down further tries, so someone at an unlocked
 * computer cannot guess their way in. The count lives in memory: Libera has one user.
 */
const ARCHIVE_FREE_ATTEMPTS = 5;
const archiveAttempts = { failures: 0, lockedUntil: 0 };

export function archiveUnlockRetryAfterMs(now = Date.now()) {
  return Math.max(0, archiveAttempts.lockedUntil - now);
}

export function recordArchiveUnlockAttempt(ok: boolean, now = Date.now()) {
  if (ok) {
    archiveAttempts.failures = 0;
    archiveAttempts.lockedUntil = 0;
    return;
  }
  archiveAttempts.failures += 1;
  const extra = archiveAttempts.failures - ARCHIVE_FREE_ATTEMPTS;
  // 30 s after the fifth wrong try, doubling each time, up to 15 minutes.
  if (extra >= 0) archiveAttempts.lockedUntil = now + Math.min(15 * 60_000, 30_000 * 2 ** extra);
}
