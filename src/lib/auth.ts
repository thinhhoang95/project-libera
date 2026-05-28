import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "libera_session";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
const SESSION_SUBJECT = "admin";

type SessionPayload = {
  sub: typeof SESSION_SUBJECT;
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

export function createSessionToken() {
  const payload: SessionPayload = {
    sub: SESSION_SUBJECT,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token: string | undefined) {
  if (!token) {
    return false;
  }

  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return false;
  }

  const expectedSignature = createHmac("sha256", getSessionSecret())
    .update(encodedPayload)
    .digest("base64url");

  if (!safeEqual(signature, expectedSignature)) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;

    return payload.sub === SESSION_SUBJECT && typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
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
