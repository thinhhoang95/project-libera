// Automatic sign-in through the synced data folder (electron/collab/control/shared-sign-in.ts):
// two "computers" share one library folder and have their own userData.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import type { AccountManager } from "../../electron/collab/control/account";
import { deriveKey, encryptPayload, decryptPayload, SHARED_SIGN_IN_FILE, SharedSignIn, type SharedSignInOptions } from "../../electron/collab/control/shared-sign-in";
import type { Clock } from "../../electron/collab/core/clock";
import { ApiClientError, type ApiClient } from "../../electron/collab/core/api-client";
import type { AuthResponse } from "../../src/lib/collab/protocol/api";
import type { LocalAccount } from "../../src/lib/collab/local-api";

const SERVER = "https://collab.example.test";
const quietLogger = { warn: () => undefined, error: () => undefined };

class PollClock implements Clock {
  time = Date.now();
  callback: (() => void) | null = null;
  now() { return this.time; }
  setTimeout(callback: () => void) { this.callback = callback; return callback; }
  clearTimeout() { this.callback = null; }
  async tick(ms = 60_000) {
    this.time += ms;
    const callback = this.callback;
    assert.ok(callback, "poll is scheduled");
    this.callback = null;
    callback();
    const deadline = Date.now() + 5000;
    while (!this.callback) {
      assert.ok(Date.now() < deadline, "poll completes and reschedules");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The server side: which grants exist and which were revoked. */
class FakeServer {
  grants = new Map<string, { accountId: string; revoked: boolean }>();
  minted = 0;
  revokeCalls = 0;
  exchanges: string[] = [];
  mintFailures = 0;
  exchangeFailures = 0;
  beforeMint?: () => Promise<void>;
  beforeExchange?: () => Promise<void>;

  mint(accountId: string) {
    if (this.mintFailures-- > 0) throw new ApiClientError("network", 0, "offline");
    this.minted += 1;
    const grant = `grant-${this.minted}-${"x".repeat(24)}`;
    this.grants.set(grant, { accountId, revoked: false });
    return { grant, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() };
  }

  revokeAll(accountId: string) {
    this.revokeCalls += 1;
    for (const entry of this.grants.values()) if (entry.accountId === accountId) entry.revoked = true;
  }

  exchange(grant: string): AuthResponse {
    this.exchanges.push(grant);
    if (this.exchangeFailures-- > 0) throw new ApiClientError("network", 0, "offline");
    const entry = this.grants.get(grant);
    if (!entry || entry.revoked) throw new ApiClientError("unauthorized", 401, "invalid grant");
    return {
      account: { id: entry.accountId, email: `${entry.accountId}@example.test`, displayName: "P", color: "#2563eb", createdAt: new Date().toISOString() },
      accessToken: "access",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshToken: `refresh-${this.exchanges.length}`,
      refreshTokenExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    };
  }
}

/** One computer: its own userData, the shared library, a stub account. */
class Computer {
  readonly state: { account: LocalAccount | null; signedIn: boolean } = { account: null, signedIn: false };
  shared: SharedSignIn;

  get account() {
    return this.state.account;
  }
  set account(value: LocalAccount | null) {
    this.state.account = value;
  }
  get signedInFlag() {
    return this.state.signedIn;
  }
  set signedInFlag(value: boolean) {
    this.state.signedIn = value;
  }

  constructor(server: FakeServer, libraryRoot: string, readonly collabDir: string, options: Partial<SharedSignInOptions> = {}) {
    const self = this.state;
    const session = { getAccessToken: async () => "a", refresh: async () => "a", currentRefreshToken: "r" };
    const accounts = {
      get account() {
        return self.account;
      },
      get session() {
        return self.signedIn ? session : null;
      },
      exchangeDeviceGrant: async (_serverUrl: string, grant: string) => { await server.beforeExchange?.(); return server.exchange(grant); },
    } as unknown as AccountManager;
    const api = {
      createDeviceGrant: async () => { const id = self.account!.id; await server.beforeMint?.(); return server.mint(id); },
      revokeDeviceGrants: async () => server.revokeAll(self.account!.id),
    } as unknown as ApiClient;
    this.shared = new SharedSignIn({
      libraryRoot,
      collabDir,
      accounts,
      api: () => (self.signedIn ? api : null),
      signedIn: async (serverUrl, auth, canAdopt) => {
        if (!canAdopt()) return;
        self.account = { id: auth.account.id, email: auth.account.email, displayName: auth.account.displayName, color: auth.account.color, serverUrl };
        self.signedIn = true;
      },
      logger: quietLogger,
      pollMs: 3_600_000,
      kdf: { N: 2 ** 14, r: 8, p: 1 },
      ...options,
    });
  }

  signInByHand(accountId: string) {
    this.account = { id: accountId, email: `${accountId}@example.test`, displayName: "P", color: "#2563eb", serverUrl: SERVER };
    this.signedInFlag = true;
    return this.shared.signedInByHand();
  }

  signOut(everywhere = false) {
    return this.shared.beforeSignOut(everywhere).then(() => {
      this.account = null;
      this.signedInFlag = false;
    });
  }
}

describe("shared collaboration sign-in", () => {
  let root: string;
  let n = 0;
  const computers: Computer[] = [];

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "libera-shared-sign-in-"));
  });
  after(async () => {
    for (const computer of computers) computer.shared.stop();
    await rm(root, { recursive: true, force: true });
  });

  function setup() {
    n += 1;
    const server = new FakeServer();
    const library = path.join(root, `library-${n}`);
    const make = (name: string, options: Partial<SharedSignInOptions> = {}) => {
      const computer = new Computer(server, library, path.join(root, `userData-${n}-${name}`, "collab"), options);
      computers.push(computer);
      return computer;
    };
    return { server, library, file: path.join(library, SHARED_SIGN_IN_FILE), make };
  }

  test("a signed-in computer shares a grant; another computer with the same master password signs in with it", async () => {
    const { server, file, make } = setup();
    const a = make("a");
    const b = make("b");
    await a.signInByHand("acc_1");
    assert.equal(server.minted, 0, "nothing is written before the master password is known");

    await a.shared.unlock("master password");
    assert.equal(server.minted, 1);
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes("grant-1"), "the grant is not in plaintext");
    assert.ok(!text.includes("acc_1"), "neither is the account");

    await b.shared.unlock("master password");
    assert.equal(b.account?.id, "acc_1");
    assert.equal(b.signedInFlag, true);
    assert.equal(server.exchanges.length, 1);

    // Unlocking again on either computer changes nothing.
    await a.shared.unlock("master password");
    await b.shared.unlock("master password");
    assert.equal(server.minted, 1);
    assert.equal(server.exchanges.length, 1);
  });

  test("a different master password cannot open the file and does not replace it", async () => {
    const { server, file, make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("master password");
    const before = await readFile(file, "utf8");

    const b = make("b");
    await b.shared.unlock("another password");
    assert.equal(b.signedInFlag, false);
    assert.equal(server.exchanges.length, 0);

    // Signed in by hand with a different master password, but not by hand on this unlock: leave it.
    const c = make("c");
    c.account = { id: "acc_1", email: "e", displayName: "P", color: "#000000", serverUrl: SERVER };
    c.signedInFlag = true;
    await c.shared.unlock("another password");
    assert.equal(await readFile(file, "utf8"), before);

    // Signing in by hand makes this computer's choice the newest.
    await c.shared.signedInByHand();
    assert.notEqual(await readFile(file, "utf8"), before);
    const d = make("d");
    await d.shared.unlock("another password");
    assert.equal(d.signedInFlag, true);
  });

  test("signing out by hand turns automatic sign-in off on that computer only", async () => {
    const { make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("pw-12345678");
    const b = make("b");
    await b.shared.unlock("pw-12345678");
    assert.equal(b.signedInFlag, true);

    await b.signOut();
    await b.shared.unlock("pw-12345678");
    assert.equal(b.signedInFlag, false, "stays signed out after an explicit sign-out");

    const c = make("c");
    await c.shared.unlock("pw-12345678");
    assert.equal(c.signedInFlag, true, "other computers still sign in");

    await b.signInByHand("acc_1");
    await b.signOut();
    await b.shared.signedInByHand().catch(() => undefined);
  });

  test("stop on all computers revokes the grants and signed-in computers do not mint a new one", async () => {
    const { server, file, make } = setup();
    const a = make("a");
    const b = make("b");
    await a.signInByHand("acc_1");
    await a.shared.unlock("pw-12345678");
    await b.shared.unlock("pw-12345678");
    assert.equal(b.signedInFlag, true);

    await a.signOut(true);
    assert.equal(server.revokeCalls, 1);
    assert.match(await readFile(file, "utf8"), /disabledAt/);

    await b.shared.unlock("pw-12345678");
    assert.equal(server.minted, 1, "b is signed in but leaves the tombstone alone");
    const c = make("c");
    await c.shared.unlock("pw-12345678");
    assert.equal(c.signedInFlag, false);

    await a.signInByHand("acc_1");
    await a.shared.unlock("pw-12345678");
    assert.equal(server.minted, 2, "a sign-in by hand offers the account again");
    await c.shared.unlock("pw-12345678");
    assert.equal(c.signedInFlag, true);
  });

  test("a grant the server refuses is not retried, and a signed-in computer replaces it", async () => {
    const { server, make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("pw-12345678");
    server.revokeAll("acc_1");
    server.revokeCalls = 0;

    const b = make("b");
    await b.shared.unlock("pw-12345678");
    await b.shared.unlock("pw-12345678");
    assert.equal(server.exchanges.length, 1, "refused once, not hammered");
    assert.equal(b.signedInFlag, false);

    await b.signInByHand("acc_1");
    assert.equal(server.minted, 2);
    const c = make("c");
    await c.shared.unlock("pw-12345678");
    assert.equal(c.signedInFlag, true);
  });

  test("never switches a remembered account silently", async () => {
    const { server, make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("pw-12345678");
    const b = make("b");
    b.account = { id: "acc_2", email: "other", displayName: "O", color: "#000000", serverUrl: SERVER };
    await b.shared.unlock("pw-12345678");
    assert.equal(server.exchanges.length, 0);
    assert.equal(b.account.id, "acc_2");

    // Same account that needs sign-in again: recovered.
    const c = make("c");
    c.account = { id: "acc_1", email: "e", displayName: "P", color: "#000000", serverUrl: SERVER };
    await c.shared.unlock("pw-12345678");
    assert.equal(c.signedInFlag, true);
  });

  test("a damaged or half-synced file is left alone", async () => {
    const { server, file, make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await writeFile(file.replace("collab-sign-in.json", ".keep"), "").catch(() => undefined);
    await a.shared.unlock("pw-12345678");
    await writeFile(file, "{\"format\":\"libera-collab-sign-in\",\"vers");
    await a.shared.unlock("pw-12345678");
    assert.equal(await readFile(file, "utf8"), "{\"format\":\"libera-collab-sign-in\",\"vers");
    const b = make("b");
    await b.shared.unlock("pw-12345678");
    assert.equal(b.signedInFlag, false);
    assert.equal(server.minted, 1);
  });

  test("changing the master password re-encrypts the file for the new one", async () => {
    const { server, make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("old password");
    await a.shared.masterPasswordChanged("new password");
    assert.equal(server.minted, 1, "the grant is kept");

    const old = make("old");
    await old.shared.unlock("old password");
    assert.equal(old.signedInFlag, false);
    const fresh = make("new");
    await fresh.shared.unlock("new password");
    assert.equal(fresh.signedInFlag, true);
  });

  test("poll retries transient exchange and mint failures without a file change", async () => {
    const { server, make } = setup();
    const clockA = new PollClock();
    const a = make("a", { clock: clockA });
    await a.signInByHand("acc_1");
    server.mintFailures = 1;
    await a.shared.unlock("password");
    assert.equal(server.minted, 0);
    await clockA.tick();
    assert.equal(server.minted, 1);

    const clockB = new PollClock();
    const b = make("b", { clock: clockB });
    server.exchangeFailures = 1;
    await b.shared.unlock("password");
    assert.equal(b.signedInFlag, false);
    await clockB.tick();
    assert.equal(b.signedInFlag, true);
    assert.equal(server.exchanges.length, 2);
  });

  test("poll renews an unchanged file as its grant approaches expiry", async () => {
    const { server, make } = setup();
    const clock = new PollClock();
    const a = make("a", { clock });
    await a.signInByHand("acc_1");
    await a.shared.unlock("password");
    await clock.tick(61 * 86_400_000);
    assert.equal(server.minted, 2);
  });

  test("master passwords use the same exact Unicode characters as local authentication", async () => {
    const { make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("Ａ password");
    const b = make("b");
    await b.shared.unlock("A password");
    assert.equal(b.signedInFlag, false);
    await b.shared.unlock("Ａ password");
    assert.equal(b.signedInFlag, true);
  });

  test("bounds total KDF memory and work before deriving, and authenticates the ciphertext", async () => {
    await assert.rejects(deriveKey("pw", undefined, { N: 2 ** 20, r: 16, p: 1 }), /Unsafe/);
    await assert.rejects(deriveKey("pw", undefined, { N: 2 ** 17, r: 8, p: 4 }), /Unsafe/);
    const key = await deriveKey("pw", undefined, { N: 2 ** 14, r: 8, p: 1 });
    const payload = { serverUrl: SERVER, accountId: "acc_1", email: "e", grant: "grant", expiresAt: new Date(Date.now() + 1000).toISOString() };
    const file = encryptPayload(key, payload);
    assert.deepEqual(decryptPayload(key, file), payload);
    const bytes = Buffer.from(file.data!, "base64");
    bytes[0] ^= 1;
    assert.equal(decryptPayload(key, { ...file, data: bytes.toString("base64") }), null);
    assert.equal(decryptPayload(key, encryptPayload(key, { ...payload, expiresAt: "invalid" })), null);
  });

  test("a cold host can rewrap a file using the verified previous password", async () => {
    const { make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("old password");
    const cold = make("cold");
    await cold.shared.masterPasswordChanged("new password", "old password");
    const b = make("b");
    await b.shared.unlock("new password");
    assert.equal(b.signedInFlag, true);
  });

  test("shutdown and explicit sign-out cancel an in-flight automatic sign-in", async () => {
    const { server, make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("password");
    for (const action of ["stop", "signOut"] as const) {
      const started = deferred();
      const release = deferred();
      server.beforeExchange = async () => { started.resolve(); await release.promise; };
      const b = make(action);
      const unlocking = b.shared.unlock("password");
      await started.promise;
      const done = action === "stop" ? Promise.resolve(b.shared.stop()) : b.signOut();
      release.resolve();
      await Promise.all([unlocking, done]);
      assert.equal(b.signedInFlag, false);
      assert.equal(b.shared.unlocked, action !== "stop");
    }
  });

  test("minting preserves a newer synced tombstone and shutdown prevents a write", async () => {
    for (const action of ["tombstone", "stop"] as const) {
      const { server, file, make } = setup();
      const clock = new PollClock();
      const a = make("a", { clock });
      await a.signInByHand("acc_1");
      const started = deferred();
      const release = deferred();
      server.beforeMint = async () => { started.resolve(); await release.promise; };
      const unlocking = a.shared.unlock("password");
      await started.promise;
      if (action === "stop") a.shared.stop();
      // Simulates sync delivering a newer user's decision while mint is pending.
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "newer synced decision");
      release.resolve();
      await unlocking;
      assert.equal(await readFile(file, "utf8"), "newer synced decision");
      if (action === "tombstone") {
        await clock.tick();
        assert.equal(await readFile(file, "utf8"), "newer synced decision", "later polls also honor the newer choice");
      }
    }
  });

  test("an existing corrupt opt-out fails closed even for a remembered session", async () => {
    const { server, file, make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("password");
    await a.shared.beforeSignOut(false);
    await rm(file);
    for (const corrupt of ["{", "{}", "null"]) {
      await writeFile(path.join(a.collabDir, "auto-sign-in.json"), corrupt);
      await a.shared.unlock("password");
    }
    assert.equal(server.minted, 1, "opt-out also blocks re-sharing before runtime sign-out finishes");
    await assert.rejects(readFile(file), { code: "ENOENT" });
  });

  test("oversized synced input is left alone", async () => {
    const { server, file, make } = setup();
    const a = make("a");
    await a.signInByHand("acc_1");
    await a.shared.unlock("password");
    const oversized = " ".repeat(16 * 1024 + 1);
    await writeFile(file, oversized);
    await a.signInByHand("acc_1");
    assert.equal(await readFile(file, "utf8"), oversized);
    assert.equal(server.minted, 1);
  });

  test("password rewrapping retries after a temporary file write failure", async () => {
    const { file, make } = setup();
    const clock = new PollClock();
    const a = make("a", { clock });
    await a.signInByHand("acc_1");
    await a.shared.unlock("old password");
    const previous = await readFile(file, "utf8");
    // A directory at the temporary file path makes writeFile fail reliably on
    // both Windows and Unix without changing the actual synced file.
    const blockedTemp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    await mkdir(blockedTemp);
    await a.shared.masterPasswordChanged("new password");
    assert.equal(await readFile(file, "utf8"), previous);
    await rm(blockedTemp, { recursive: true });
    await clock.tick();
    const b = make("b");
    await b.shared.unlock("new password");
    assert.equal(b.signedInFlag, true);
  });
});
