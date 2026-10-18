import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { DEFAULT_COLORS } from "../src/api/auth.js";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { signAccessToken } from "../src/auth/tokens.js";
import type { Account, AuthResponse } from "../src/protocol.js";
import { json } from "./helpers.js";
import { errorCode, register, request, startApi, type ApiHarness } from "./support/api-harness.js";

describe("passwords", () => {
  test("scrypt hashes verify, reject wrong passwords, and use the stored format", async () => {
    const hash = await hashPassword("s3cret-password");
    assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await verifyPassword("s3cret-password", hash), true);
    assert.equal(await verifyPassword("s3cret-passwore", hash), false);
    assert.equal(await verifyPassword("s3cret-password", "bcrypt$whatever"), false);
    assert.notEqual(await hashPassword("s3cret-password"), hash, "salted");
  });
});

describe("auth routes", () => {
  let h: ApiHarness;
  before(async () => {
    h = await startApi();
  });
  after(() => h.close());

  test("register, login, /me and profile changes", async () => {
    const user = await register(h, "ann");
    assert.equal(user.auth.account.email, user.email);
    assert.ok((DEFAULT_COLORS as readonly string[]).includes(user.auth.account.color), "default palette colour");
    assert.ok(user.auth.refreshToken.length > 20);
    assert.ok(Date.parse(user.auth.accessTokenExpiresAt) > Date.now());

    const taken = await request(h, "POST", "/v1/auth/register", null, {
      email: user.email.toUpperCase(),
      password: "another password",
      displayName: "Ann again",
    });
    assert.equal(taken.status, 409);
    assert.equal(errorCode(taken), "email-taken");

    const login = await json<AuthResponse>(h.url, "/v1/auth/login", {
      body: { email: user.email.toUpperCase(), password: "correct horse battery" },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.account.id, user.id);

    const wrong = await json(h.url, "/v1/auth/login", { body: { email: user.email, password: "wrong password" } });
    assert.equal(wrong.status, 401);
    const unknown = await json(h.url, "/v1/auth/login", { body: { email: "nobody@example.test", password: "whatever1" } });
    assert.equal(unknown.status, 401);

    const me = await request(h, "GET", "/v1/me", user);
    assert.equal(me.status, 200);
    assert.equal(me.body.id, user.id);

    const patched = await request(h, "PATCH", "/v1/me", user, { displayName: "Ann B", color: "#ABCDEF" });
    assert.equal(patched.status, 200);
    assert.equal((patched.body as Account).displayName, "Ann B");
    assert.equal((patched.body as Account).color, "#abcdef");
    const badColor = await request(h, "PATCH", "/v1/me", user, { color: "blue" });
    assert.equal(badColor.status, 400);
  });

  test("401 without a token and token-expired with an expired one", async () => {
    const user = await register(h, "exp");
    const missing = await request(h, "GET", "/v1/me");
    assert.equal(missing.status, 401);
    assert.equal(errorCode(missing), "unauthorized");

    const garbage = await json(h.url, "/v1/me", { token: "not-a-jwt" });
    assert.equal(garbage.status, 401);
    assert.equal(errorCode(garbage), "unauthorized");

    const old = await signAccessToken(h.context.config, user.id, "fam_x", new Date(Date.now() - 2 * 3600_000));
    const expired = await json(h.url, "/v1/me", { token: old.token });
    assert.equal(expired.status, 401);
    assert.equal(errorCode(expired), "token-expired");
  });

  test("refresh rotates tokens and reuse revokes the whole family", async () => {
    const user = await register(h, "rot");
    const first = user.auth.refreshToken;
    const rotated = await json<AuthResponse>(h.url, "/v1/auth/refresh", { body: { refreshToken: first } });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.refreshToken, first);
    assert.equal(rotated.body.account.id, user.id);
    const me = await json(h.url, "/v1/me", { token: rotated.body.accessToken });
    assert.equal(me.status, 200);

    const oldRow = await h.context.db
      .selectFrom("refresh_tokens")
      .selectAll()
      .where("account_id", "=", user.id)
      .where("replaced_by", "is not", null)
      .executeTakeFirstOrThrow();
    assert.ok(oldRow.revoked_at);

    const second = await json<AuthResponse>(h.url, "/v1/auth/refresh", { body: { refreshToken: rotated.body.refreshToken } });
    assert.equal(second.status, 200);

    h.rooms.calls.length = 0;
    // The first token was rotated away; presenting it again is reuse.
    const reuse = await json(h.url, "/v1/auth/refresh", { body: { refreshToken: first } });
    assert.equal(reuse.status, 401);
    const revoked = h.rooms.calls.find((call) => call.method === "accountRevoked");
    assert.deepEqual(revoked?.args, [user.id, oldRow.family_id]);

    // The newest token of the family is dead too.
    const after = await json(h.url, "/v1/auth/refresh", { body: { refreshToken: second.body.refreshToken } });
    assert.equal(after.status, 401);
    const live = await h.context.db
      .selectFrom("refresh_tokens")
      .select("id")
      .where("family_id", "=", oldRow.family_id)
      .where("revoked_at", "is", null)
      .execute();
    assert.equal(live.length, 0);

    // Other sessions of the same account are unaffected.
    const login = await json<AuthResponse>(h.url, "/v1/auth/login", { body: { email: user.email, password: "correct horse battery" } });
    const fresh = await json(h.url, "/v1/auth/refresh", { body: { refreshToken: login.body.refreshToken } });
    assert.equal(fresh.status, 200);
  });

  test("logout revokes the session's family", async () => {
    const user = await register(h, "out");
    h.rooms.calls.length = 0;
    const out = await json(h.url, "/v1/auth/logout", { body: { refreshToken: user.auth.refreshToken } });
    assert.equal(out.status, 204);
    assert.equal(h.rooms.calls[0]?.method, "accountRevoked");
    assert.equal(h.rooms.calls[0]?.args[0], user.id);
    const refresh = await json(h.url, "/v1/auth/refresh", { body: { refreshToken: user.auth.refreshToken } });
    assert.equal(refresh.status, 401);
    const again = await json(h.url, "/v1/auth/logout", { body: { refreshToken: user.auth.refreshToken } });
    assert.equal(again.status, 204);
  });

  test("changing the password checks the old one and ends other sessions", async () => {
    const user = await register(h, "pw");
    const other = await json<AuthResponse>(h.url, "/v1/auth/login", { body: { email: user.email, password: "correct horse battery" } });

    const wrong = await request(h, "POST", "/v1/me/password", user, { currentPassword: "nope nope", newPassword: "new password 1" });
    assert.equal(wrong.status, 403);
    const short = await request(h, "POST", "/v1/me/password", user, { currentPassword: "correct horse battery", newPassword: "short" });
    assert.equal(short.status, 400);

    const changed = await request(h, "POST", "/v1/me/password", user, {
      currentPassword: "correct horse battery",
      newPassword: "new password 1",
    });
    assert.equal(changed.status, 204);
    const otherRefresh = await json(h.url, "/v1/auth/refresh", { body: { refreshToken: other.body.refreshToken } });
    assert.equal(otherRefresh.status, 401, "other session ended");
    const ownRefresh = await json(h.url, "/v1/auth/refresh", { body: { refreshToken: user.auth.refreshToken } });
    assert.equal(ownRefresh.status, 200, "current session kept");
    const login = await json(h.url, "/v1/auth/login", { body: { email: user.email, password: "new password 1" } });
    assert.equal(login.status, 200);
  });

  test("login is rate limited per email", async () => {
    const user = await register(h, "rl");
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      last = (await json(h.url, "/v1/auth/login", { body: { email: user.email, password: "wrong password" } })).status;
    }
    assert.equal(last, 429);
    const response = await fetch(`${h.url}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password: "correct horse battery" }),
    });
    assert.equal(response.status, 429, "even the right password waits");
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "rate-limited");
  });

  test("invalid bodies are 400", async () => {
    const response = await json(h.url, "/v1/auth/register", { body: { email: "not-an-email", password: "x", displayName: "" } });
    assert.equal(response.status, 400);
    assert.equal(errorCode(response), "bad-request");
  });
});

describe("closed sign-up", () => {
  test("needs an invitation unless ALLOW_OPEN_SIGNUP", async () => {
    const h = await startApi({ ALLOW_OPEN_SIGNUP: false });
    try {
      const response = await json(h.url, "/v1/auth/register", {
        body: { email: "closed@example.test", password: "long enough", displayName: "C" },
      });
      assert.equal(response.status, 403);
      assert.equal(errorCode(response), "signup-disabled");
      const badToken = await json(h.url, "/v1/auth/register", {
        body: { email: "closed@example.test", password: "long enough", displayName: "C", invitationToken: "nope" },
      });
      assert.equal(badToken.status, 404);
      assert.equal(errorCode(badToken), "invalid-invitation");
    } finally {
      await h.close();
    }
  });
});
