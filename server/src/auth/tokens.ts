// Short-lived access tokens (HS256 JWT). Refresh tokens are opaque secrets
// stored hashed in refresh_tokens; see api/auth.ts.

import { errors, jwtVerify, SignJWT } from "jose";

import type { Config } from "../config.js";

export interface AccessTokenClaims {
  accountId: string;
  /** Refresh-token family the token was issued from (lets logout revoke sockets). */
  familyId: string;
  expiresAt: Date;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly expired: boolean,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

const ISSUER = "libera-collab";
const AUDIENCE = "libera-desktop";

function key(config: Config): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

export async function signAccessToken(
  config: Config,
  accountId: string,
  familyId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(now.getTime() + config.ACCESS_TOKEN_TTL_SECONDS * 1000);
  const token = await new SignJWT({ fam: familyId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(accountId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key(config));
  return { token, expiresAt };
}

export async function verifyAccessToken(config: Config, token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key(config), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    if (typeof payload.sub !== "string" || typeof payload.fam !== "string" || typeof payload.exp !== "number") {
      throw new TokenError("Malformed token.", false);
    }
    return { accountId: payload.sub, familyId: payload.fam, expiresAt: new Date(payload.exp * 1000) };
  } catch (error) {
    if (error instanceof TokenError) throw error;
    if (error instanceof errors.JWTExpired) throw new TokenError("Token expired.", true);
    throw new TokenError("Invalid token.", false);
  }
}
