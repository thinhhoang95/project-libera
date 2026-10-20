import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { DEFAULT_COLORS } from "../src/api/auth.js";
import { hashRegistrationCode } from "../src/api/registration-codes.js";
import { newRegistrationCode } from "../src/admin/signup-codes.js";
import { buildServer } from "../src/app.js";
import { openDatabase } from "../src/db/database.js";
import { loadConfig } from "../src/config.js";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { signAccessToken } from "../src/auth/tokens.js";
import type { Account, AuthResponse } from "../src/protocol.js";
import { json, type TestServer } from "./helpers.js";
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
    assert.equal((await request(h, "GET", "/v1/me", user)).status, 200, "rotation keeps earlier access tokens in the active family valid");

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
    assert.equal((await json(h.url, "/v1/me", { token: second.body.accessToken })).status, 401, "reuse revokes access tokens too");
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
    const other = await json<AuthResponse>(h.url, "/v1/auth/login", { body: { email: user.email, password: "correct horse battery" } });
    h.rooms.calls.length = 0;
    const out = await json(h.url, "/v1/auth/logout", { body: { refreshToken: user.auth.refreshToken } });
    assert.equal(out.status, 204);
    assert.equal(h.rooms.calls[0]?.method, "accountRevoked");
    assert.equal(h.rooms.calls[0]?.args[0], user.id);
    const refresh = await json(h.url, "/v1/auth/refresh", { body: { refreshToken: user.auth.refreshToken } });
    assert.equal(refresh.status, 401);
    assert.equal((await request(h, "GET", "/v1/me", user)).status, 401, "a logged-out access token cannot authenticate");
    assert.equal((await request(h, "POST", "/v1/projects", user, { name: "After logout" })).status, 401);
    assert.equal((await json(h.url, "/v1/me", { token: other.body.accessToken })).status, 200, "another session is still active");
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
    assert.equal((await json(h.url, "/v1/me", { token: other.body.accessToken })).status, 401, "password change revokes the other access token");
    const ownRefresh = await json(h.url, "/v1/auth/refresh", { body: { refreshToken: user.auth.refreshToken } });
    assert.equal(ownRefresh.status, 200, "current session kept");
    const login = await json(h.url, "/v1/auth/login", { body: { email: user.email, password: "new password 1" } });
    assert.equal(login.status, 200);
  });

  test("device grants start independent sessions and are revoked by sign-out-everywhere and password changes", async () => {
    const user = await register(h, "grant");
    const anonymous = await request(h, "POST", "/v1/auth/device-grants", null, {});
    assert.equal(anonymous.status, 401);

    const created = await request(h, "POST", "/v1/auth/device-grants", user, { deviceName: "Laptop" });
    assert.equal(created.status, 200);
    const grant = created.body.grant as string;
    assert.ok(grant.length > 20);
    assert.ok(Date.parse(created.body.expiresAt) > Date.now());
    assert.equal((await request(h, "POST", "/v1/auth/device-grants", user, { automatic: true, previousGrant: grant })).status, 200);

    // Two computers use the same copy: each gets its own refresh family, so
    // rotating one never trips reuse detection on the other.
    const first = await json<AuthResponse>(h.url, "/v1/auth/device-grants/sign-in", { body: { grant, deviceName: "A" } });
    const second = await json<AuthResponse>(h.url, "/v1/auth/device-grants/sign-in", { body: { grant, deviceName: "B" } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.account.id, user.id);
    assert.equal((await json(h.url, "/v1/auth/refresh", { body: { refreshToken: first.body.refreshToken } })).status, 200);
    assert.equal((await json(h.url, "/v1/auth/refresh", { body: { refreshToken: second.body.refreshToken } })).status, 200);

    const bogus = await json(h.url, "/v1/auth/device-grants/sign-in", { body: { grant: "not-a-grant" } });
    assert.equal(bogus.status, 401);

    // Logging one computer out leaves the grant usable.
    assert.equal((await json(h.url, "/v1/auth/logout", { body: { refreshToken: first.body.refreshToken } })).status, 204);
    assert.equal((await json(h.url, "/v1/auth/device-grants/sign-in", { body: { grant } })).status, 200);

    const revoked = await request(h, "DELETE", "/v1/auth/device-grants", user);
    assert.equal(revoked.status, 204);
    assert.equal((await json(h.url, "/v1/auth/device-grants/sign-in", { body: { grant } })).status, 401);
    assert.equal((await json(h.url, "/v1/me", { token: second.body.accessToken })).status, 200, "existing sessions stay");
    assert.equal((await request(h, "POST", "/v1/auth/device-grants", user, { automatic: true, previousGrant: grant })).status, 403, "a stale file cannot renew a revoked grant");
    assert.equal((await request(h, "POST", "/v1/auth/device-grants", user, { automatic: true })).status, 403, "a missing file cannot undo global revocation");

    const again = await request(h, "POST", "/v1/auth/device-grants", user, {});
    assert.equal(again.status, 200);
    const changed = await request(h, "POST", "/v1/me/password", user, { currentPassword: "correct horse battery", newPassword: "new password 2" });
    assert.equal(changed.status, 204);
    assert.equal((await json(h.url, "/v1/auth/device-grants/sign-in", { body: { grant: again.body.grant } })).status, 401, "password change revokes grants");
  });

  test("device grants store hashes, reject expiry and disabled accounts, and cap concurrent creation", async () => {
    const user = await register(h, "grant-cap");
    const created = await Promise.all(Array.from({ length: 14 }, () => request(h, "POST", "/v1/auth/device-grants", user, {})));
    assert.ok(created.every((result) => result.status === 200));
    const rows = await h.context.db.selectFrom("device_grants").selectAll().where("account_id", "=", user.id).execute();
    const active = rows.filter((row) => !row.revoked_at);
    assert.equal(active.length, 10);
    assert.ok(rows.every((row) => !created.some((result) => result.body.grant === row.token_hash)), "only hashes are persisted");
    const live = created.at(-1)!.body.grant;
    await h.context.db.updateTable("device_grants").set({ expires_at: new Date(0) }).where("account_id", "=", user.id).execute();
    assert.equal((await json(h.url, "/v1/auth/device-grants/sign-in", { body: { grant: live } })).status, 401);
    const next = await request(h, "POST", "/v1/auth/device-grants", user, {});
    await h.context.db.updateTable("accounts").set({ disabled_at: new Date() }).where("id", "=", user.id).execute();
    assert.equal((await json(h.url, "/v1/auth/device-grants/sign-in", { body: { grant: next.body.grant } })).status, 401);
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

test("revocation wins over a grant exchange paused after its initial lookup", { timeout: 20_000 }, async () => {
  const database = await openDatabase("pglite://memory");
  let pause: { started(): void; release: Promise<void> } | undefined;
  // Pause after the nontransactional lookup has released its connection,
  // allowing DELETE or a password change to commit before exchange resumes.
  database.db = database.db.withPlugin({
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      if (pause && result.rows.some((row) => typeof row.id === "string" && row.id.startsWith("dgr_") && "token_hash" in row)) {
        const gate = pause;
        pause = undefined;
        gate.started();
        await gate.release;
      }
      return result;
    },
  });
  const server = await buildServer({ database, config: loadConfig({ NODE_ENV: "test", DATABASE_URL: "pglite://memory", PORT: "0", ALLOW_OPEN_SIGNUP: "1" }), jobs: false });
  const url = await server.listen();
  const harness: TestServer = { server, url, wsUrl: `${url.replace(/^http/, "ws")}/sync`, close: () => server.close() };
  let release = () => {};
  try {
    const user = await register(harness, "grant-race");
    for (const action of ["revoke", "password"] as const) {
      const created = await request(harness, "POST", "/v1/auth/device-grants", user, {});
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      pause = { started, release: gate };
      const exchanging = json<AuthResponse>(url, "/v1/auth/device-grants/sign-in", { body: { grant: created.body.grant } });
      await waiting;
      try {
        const revoked = action === "revoke"
          ? await request(harness, "DELETE", "/v1/auth/device-grants", user)
          : await request(harness, "POST", "/v1/me/password", user, { currentPassword: "correct horse battery", newPassword: "replacement password" });
        assert.equal(revoked.status, 204);
      } finally {
        release();
      }
      assert.equal((await exchanging).status, 401, "a stale lookup cannot create a session after revocation");
      const sessions = await database.db.selectFrom("refresh_tokens").selectAll().where("account_id", "=", user.id).execute();
      assert.equal(sessions.length, 1, "only the original session exists");
    }
  } finally {
    release();
    await server.close();
  }
});

describe("invitation-only sign-up", () => {
  const body = (email: string, extra: Record<string, unknown> = {}) => ({ email, password: "long enough", displayName: "C", ...extra });

  async function issueCode(h: ApiHarness, options: { maxUses?: number; expiresAt?: Date; revoked?: boolean } = {}): Promise<string> {
    const code = newRegistrationCode();
    await h.server.context.db
      .insertInto("registration_codes")
      .values({
        id: `reg_${code}`,
        code_hash: hashRegistrationCode(code),
        note: null,
        max_uses: options.maxUses ?? 1,
        expires_at: options.expiresAt ?? null,
        revoked_at: options.revoked ? new Date() : null,
      })
      .execute();
    return code;
  }

  test("is the default: no registration code, no account", async () => {
    assert.equal(loadConfig({ NODE_ENV: "test", DATABASE_URL: "pglite://memory" }).ALLOW_OPEN_SIGNUP, false);
    const h = await startApi({ ALLOW_OPEN_SIGNUP: false });
    try {
      const response = await json(h.url, "/v1/auth/register", { body: body("closed@example.test") });
      assert.equal(response.status, 403);
      assert.equal(errorCode(response), "signup-disabled");
      const wrong = await json(h.url, "/v1/auth/register", { body: body("closed@example.test", { registrationCode: "LBR-nope" }) });
      assert.equal(wrong.status, 403);
      assert.equal(errorCode(wrong), "invalid-registration-code");
    } finally {
      await h.close();
    }
  });

  test("a notebook invitation does not replace a registration code", async () => {
    const h = await startApi({ ALLOW_OPEN_SIGNUP: false });
    try {
      const response = await json(h.url, "/v1/auth/register", { body: body("closed@example.test", { invitationToken: "nope" }) });
      assert.equal(response.status, 403);
      assert.equal(errorCode(response), "signup-disabled");
      const code = await issueCode(h);
      const badToken = await json(h.url, "/v1/auth/register", { body: body("closed@example.test", { registrationCode: code, invitationToken: "nope" }) });
      assert.equal(badToken.status, 404);
      assert.equal(errorCode(badToken), "invalid-invitation");
      const still = await h.server.context.db.selectFrom("registration_codes").select("uses").executeTakeFirstOrThrow();
      assert.equal(Number(still.uses), 0, "a rejected sign-up does not use the code");
    } finally {
      await h.close();
    }
  });

  test("a code creates one account, then is used up", async () => {
    const h = await startApi({ ALLOW_OPEN_SIGNUP: false });
    try {
      const code = await issueCode(h);
      const ok = await json<AuthResponse>(h.url, "/v1/auth/register", { body: body("first@example.test", { registrationCode: ` ${code.toLowerCase().replace("lbr", "LBR")} ` }) });
      assert.equal(ok.status, 201);
      const again = await json(h.url, "/v1/auth/register", { body: body("second@example.test", { registrationCode: code }) });
      assert.equal(again.status, 403);
      assert.equal(errorCode(again), "invalid-registration-code");
      const reuse = await json(h.url, "/v1/auth/register", { body: body("first@example.test", { registrationCode: await issueCode(h) }) });
      assert.equal(reuse.status, 409, "email already taken");
      const rows = await h.server.context.db.selectFrom("registration_codes").select("uses").orderBy("created_at").execute();
      assert.deepEqual(rows.map((r) => Number(r.uses)), [1, 0], "the failed sign-up gave its use back");
    } finally {
      await h.close();
    }
  });

  test("honors max uses, expiry and revocation", async () => {
    const h = await startApi({ ALLOW_OPEN_SIGNUP: false });
    try {
      const multi = await issueCode(h, { maxUses: 2 });
      for (const n of [1, 2]) {
        assert.equal((await json(h.url, "/v1/auth/register", { body: body(`m${n}@example.test`, { registrationCode: multi }) })).status, 201);
      }
      assert.equal((await json(h.url, "/v1/auth/register", { body: body("m3@example.test", { registrationCode: multi }) })).status, 403);
      const expired = await issueCode(h, { expiresAt: new Date(Date.now() - 1000) });
      assert.equal((await json(h.url, "/v1/auth/register", { body: body("e@example.test", { registrationCode: expired }) })).status, 403);
      const revoked = await issueCode(h, { revoked: true });
      assert.equal((await json(h.url, "/v1/auth/register", { body: body("r@example.test", { registrationCode: revoked }) })).status, 403);
    } finally {
      await h.close();
    }
  });
});
