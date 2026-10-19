// Password hashing with Node's scrypt, so the server has no native
// dependencies. Hashes are self-describing ("scrypt$N$r$p$salt$hash") so the
// cost can be raised later without invalidating stored passwords.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// Stored parameters are ours, but a corrupted row must not make one login
// allocate gigabytes.
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function options(n: number, r: number, p: number): ScryptOptions {
  // Node's default maxmem (32 MiB) is exactly 128·N·r for N = 2^15, r = 8,
  // which it rejects; allow twice the requirement.
  return { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_LENGTH, options(N, R, P));
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n < 2 || n > MAX_N || (n & (n - 1)) !== 0) return false;
  if (r < 1 || r > MAX_R || p < 1 || p > MAX_P) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await scrypt(password, salt, expected.length, options(n, r, p));
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the same time as a real verification, so a login for an unknown
 * email cannot be told apart from a wrong password by its latency.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("libera-dummy-password");
  await verifyPassword(password, await dummyHash);
}
