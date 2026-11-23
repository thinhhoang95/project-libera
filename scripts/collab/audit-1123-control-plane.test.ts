// Audit 2026-11-23, control plane (package CT): C2 (leases across system
// sleep), H1 (the account reaches the host before notebooks start), H16
// (an unprovable legacy database is not pinned to nobody), H19 (a failed
// sign-in/out leaves a consistent runtime), H28 (a fenced process does no
// resume work), M1 (an abandoned renewal takes no lease) and M13 (session.bin
// writes are serialized and never outlive the session).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { AccountManager, type SecretCodec } from "../../electron/collab/control/account";
import { databaseKey, databasePath } from "../../electron/collab/control/databases";
import { CollabRuntime } from "../../electron/collab/control/runtime";
import type { NotebookService } from "../../electron/collab/control/types";
import type { FetchLike } from "../../electron/collab/core";
import { HostStore } from "../../electron/collab/core/store";
import { ControlRoutes } from "../../src/lib/collab/local-api";
import type { AuthResponse } from "../../src/lib/collab/protocol/api";
import { closePeer, makePeer, register, sleep, tempRoot, until, writeTree, type Peer } from "./support/notebooks-harness";
import { removeDataDir, startServerProcess } from "./support/server-process";

const quiet = { warn() {}, error() {} };

/** Reversible stand-in for safeStorage. `gate` holds encrypt() of one plaintext until released. */
function makeSecrets() {
  const gates = new Map<string, Promise<void>>();
  const secrets: SecretCodec = {
    encrypt: async (plaintext) => {
      await gates.get(plaintext);
      return `enc:${Buffer.from(plaintext).toString("base64")}`;
    },
    decrypt: async (ciphertext) => Buffer.from(ciphertext.slice(4), "base64").toString(),
  };
  const hold = (plaintext: string) => {
    let release!: () => void;
    gates.set(plaintext, new Promise<void>((resolve) => { release = resolve; }));
    return release;
  };
  return { secrets, hold };
}

function authFor(id: string, refreshToken: string): AuthResponse {
  return {
    account: { id, email: `${id}@example.test`, displayName: id, color: "#123456" },
    accessToken: `access-${refreshToken}`,
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshToken,
  } as AuthResponse;
}

const SERVER = "http://127.0.0.1:9";

function sessionToken(dir: string): string | null {
  const file = path.join(dir, "session.bin");
  if (!existsSync(file)) return null;
  const stored = JSON.parse(readFileSync(file, "utf8")) as { refreshToken: string };
  return Buffer.from(stored.refreshToken.slice(4), "base64").toString();
}

test("M13: session.bin writes are serialized and never outlive the session", async (t) => {
  const temp = tempRoot("libera-audit-1123-account-");
  try {
    const refreshFetch = (next: AuthResponse): FetchLike => async () =>
      new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });

    await t.test("concurrent persists do not share a temp file", async () => {
      const dir = path.join(temp.dir, "a");
      const { secrets } = makeSecrets();
      const manager = new AccountManager({ dir, secrets, logger: quiet });
      await manager.signIn(SERVER, authFor("acct1", "rt-1"));
      await Promise.all([manager.persistSession("acct1", "rt-2"), manager.persistSession("acct1", "rt-3")]);
      assert.ok(["rt-2", "rt-3"].includes(sessionToken(dir) ?? ""));
    });

    await t.test("a refresh that finishes after sign-out does not recreate session.bin", async () => {
      const dir = path.join(temp.dir, "b");
      const { secrets, hold } = makeSecrets();
      const manager = new AccountManager({ dir, secrets, logger: quiet, fetch: refreshFetch(authFor("acct1", "rt-rotated")) });
      await manager.signIn(SERVER, authFor("acct1", "rt-1"));
      const release = hold("rt-rotated");
      const refreshing = manager.session!.refresh();
      await sleep(50);
      await manager.signOut();
      release();
      await refreshing.catch(() => undefined);
      await sleep(50);
      assert.equal(sessionToken(dir), null, "session.bin stays gone after sign-out");
    });

    await t.test("a stale refresh does not overwrite a newer sign-in's session", async () => {
      const dir = path.join(temp.dir, "c");
      const { secrets, hold } = makeSecrets();
      const manager = new AccountManager({ dir, secrets, logger: quiet, fetch: refreshFetch(authFor("acct1", "rt-rotated")) });
      await manager.signIn(SERVER, authFor("acct1", "rt-1"));
      const release = hold("rt-rotated");
      const refreshing = manager.session!.refresh();
      await sleep(50);
      await manager.signIn(SERVER, authFor("acct2", "rt-new"));
      release();
      await refreshing.catch(() => undefined);
      await sleep(50);
      assert.equal(sessionToken(dir), "rt-new");
      assert.equal(JSON.parse(readFileSync(path.join(dir, "session.bin"), "utf8")).accountId, "acct2");
    });
  } finally {
    temp.cleanup();
  }
});

test("H16: unprovable legacy database ownership is not recorded as 'nobody'", async () => {
  const temp = tempRoot("libera-audit-1123-dbpath-");
  try {
    const authority = { accountId: "acct_legacy1", serverUrl: "https://one.example.test" };
    const legacy = path.join(temp.dir, `${databaseKey(authority.accountId)}.sqlite`);
    new HostStore({ path: legacy }).close();
    const scoped = path.join(temp.dir, `${databaseKey(authority.accountId, authority.serverUrl)}.sqlite`);

    // No evidence and no remembered account (the drive holding the markers is not mounted).
    assert.equal(await databasePath(temp.dir, authority, null, quiet), scoped);
    const store = new HostStore({ path: legacy });
    try {
      assert.equal(store.databaseAuthority(), undefined, "the legacy database was not pinned to nobody");
    } finally {
      store.close();
    }
    // The real owner signs in later with its remembered account: it gets its data back.
    const other = { accountId: authority.accountId, serverUrl: "https://two.example.test" };
    assert.equal(await databasePath(temp.dir, other, null, quiet), path.join(temp.dir, `${databaseKey(other.accountId, other.serverUrl)}.sqlite`));
    assert.equal(await databasePath(temp.dir, authority, null, quiet), scoped, "the scoped file now exists and is kept for that sign-in");
    const owner = { accountId: "acct_legacy2", serverUrl: "https://one.example.test" };
    new HostStore({ path: path.join(temp.dir, `${databaseKey(owner.accountId)}.sqlite`) }).close();
    await databasePath(temp.dir, owner, null, quiet);
    assert.equal(await databasePath(temp.dir, owner, owner, quiet), path.join(temp.dir, `${databaseKey(owner.accountId)}.sqlite`), "a later sign-in with the remembered account still finds its legacy database");
  } finally {
    temp.cleanup();
  }
});

interface StubService extends NotebookService {
  releasing: boolean;
  apiAtStart: unknown;
  calls: string[];
}

function runtimeFixture(dir: string, accountId: string | null) {
  const { secrets } = makeSecrets();
  const collabDir = path.join(dir, "collab");
  mkdirSync(collabDir, { recursive: true });
  if (accountId) {
    writeFileSync(path.join(collabDir, "account.json"), JSON.stringify({ version: 1, serverUrl: SERVER, account: { id: accountId, email: "a@example.test", displayName: "A", color: "#123456" } }));
    writeFileSync(path.join(collabDir, "session.bin"), JSON.stringify({ version: 1, accountId, refreshToken: `enc:${Buffer.from("rt-start").toString("base64")}` }));
  }
  const services: StubService[] = [];
  const runtime = new CollabRuntime({
    collabDir,
    libraryRoot: path.join(dir, "library"),
    appVersion: "test",
    installationId: "inst_ct_test",
    secrets,
    emit: () => undefined,
    logger: quiet,
    fetch: (async () => { throw new TypeError("offline"); }) as FetchLike,
    createNotebookService: (deps) => {
      const service: StubService = {
        releasing: false,
        apiAtStart: undefined,
        calls: [],
        async start() { service.apiAtStart = deps.host.api; },
        async stop() {},
        resolvePath: () => null,
        async beforeAccountChange() { service.releasing = true; },
        async accountChanged() { service.releasing = false; service.calls.push("accountChanged"); },
        registerRoutes() {},
        resumed() { service.calls.push("resumed"); },
      };
      services.push(service);
      return service;
    },
  });
  return { runtime, services, collabDir };
}

test("H1: the account is applied to the host before notebooks start", async () => {
  const temp = tempRoot("libera-audit-1123-h1-");
  const { runtime, services } = runtimeFixture(temp.dir, "acct_h1");
  try {
    await runtime.start();
    assert.ok(services[0].apiAtStart, "host.api existed when NotebookService.start() ran");
  } finally {
    await runtime.stop();
    temp.cleanup();
  }
});

test("H28: a fenced process does no resume work", async () => {
  const temp = tempRoot("libera-audit-1123-h28-");
  const { runtime, services } = runtimeFixture(temp.dir, null);
  try {
    await runtime.start();
    let nudged = 0;
    const host = runtime.host;
    host.nudge = () => { nudged += 1; };
    runtime.nudge();
    runtime.resumed();
    assert.equal(nudged, 1, "an owning host is nudged");
    assert.deepEqual(services[0].calls, ["resumed"]);
    host.store.ownsDatabase = () => false;
    runtime.nudge();
    runtime.resumed();
    assert.equal(nudged, 1, "a fenced host is not nudged");
    assert.deepEqual(services[0].calls, ["resumed"], "and its notebooks do not resume");
  } finally {
    await runtime.stop();
    temp.cleanup();
  }
});

test("H19: a failed or abandoned sign-in leaves the runtime consistent", async (t) => {
  const temp = tempRoot("libera-audit-1123-h19-");
  const { runtime, services, collabDir } = runtimeFixture(temp.dir, "acct_h19");
  try {
    await runtime.start();
    const original = databaseKey("acct_h19", SERVER);

    await t.test("open() failing does not leave the runtime without a database", async () => {
      // The other account's scoped file is pinned to a third account.
      const other = databaseKey("acct_other", SERVER);
      const foreign = new HostStore({ path: path.join(collabDir, `${other}.sqlite`) });
      foreign.setDatabaseAuthority({ accountId: "acct_third", serverUrl: SERVER });
      foreign.close();
      await assert.rejects(runtime.signedIn(SERVER, authFor("acct_other", "rt-o")), /another account/);
      assert.doesNotThrow(() => runtime.notebooks, "the runtime still has notebooks");
      assert.equal(path.basename(runtime.host.dbPath), `${original}.sqlite`, "and the database of the account that is still signed in");
      await runtime.signOut();
      assert.equal(runtime.accounts.account, null);
    });

    await t.test("an abandoned sign-in restores the database of the current account", async () => {
      await runtime.signedIn(SERVER, authFor("acct_h19", "rt-again"));
      let checks = 0;
      await runtime.signedIn(SERVER, authFor("acct_new", "rt-n"), () => ++checks < 2);
      assert.equal(runtime.accounts.account?.id, "acct_h19");
      assert.equal(path.basename(runtime.host.dbPath), `${original}.sqlite`);
      assert.equal(services[services.length - 1].releasing, false, "the notebooks are not left releasing");
    });
  } finally {
    await runtime.stop();
    temp.cleanup();
  }
});

interface Handle {
  projectId: string;
  writer: boolean;
  leaseDeadline?: number;
  runtime: { resumed(): void } | null;
}
interface Internals {
  projects: Map<string, Handle>;
  releasing: boolean;
  clock: { mono(): number; wall(): number };
  lease(handle: Handle, live?: () => boolean): Promise<{ outcome: string }>;
  context(): { canWriteDisk(projectId: string): boolean };
  tick(): Promise<void>;
  resumed(): void;
}

test("service leases: sleep (C2) and abandoned renewals (M1)", { timeout: 240_000 }, async (t) => {
  const temp = tempRoot("libera-audit-1123-leases-");
  const server = await startServerProcess();
  const peers: Peer[] = [];
  try {
    const auth = await register(server, "Alice");
    let acquires = 0;
    const fetchLike: FetchLike = async (url, init) => {
      if (url.includes("/folder-lease") && init?.method === "POST") acquires += 1;
      return fetch(url, init);
    };
    const alice = await makePeer(temp.dir, "alice", server, auth, { leaseTtlMs: 60_000, fetch: fetchLike });
    peers.push(alice);
    writeTree(path.join(alice.library, "One"), { "note.md": "one\n" });
    const shared = await alice.router.call("POST", ControlRoutes.share, { notebook: "One" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const { projectId } = shared.body as { projectId: string };
    await alice.service.project(projectId)?.whenIdle();
    const service = alice.service as unknown as Internals;
    const handle = service.projects.get(projectId)!;
    await until(() => handle.writer && (handle.leaseDeadline ?? 0) > performance.now(), "a live writer lease");

    await t.test("C2: a lease is lapsed when the wall clock ran ahead of the monotonic one", async () => {
      assert.equal(service.context().canWriteDisk(projectId), true, "writing while the lease is live");
      const realClock = service.clock;
      let slept = 0;
      service.clock = { mono: () => performance.now(), wall: () => Date.now() + slept };
      // Re-read the grant under the injected clock (it records the clock pair).
      await service.lease(handle);
      assert.equal(service.context().canWriteDisk(projectId), true);
      slept = 10 * 60_000; // wall time passed while the monotonic clock stood still
      assert.equal(service.context().canWriteDisk(projectId), false, "no disk writes after an undetected sleep");
      service.clock = realClock;
    });

    await t.test("C2: resumed() zeroes every lease before the runtimes and the renewal run", async () => {
      await service.lease(handle);
      assert.ok((handle.leaseDeadline ?? 0) > performance.now());
      const realTick = service.tick;
      service.tick = async () => undefined;
      const seen: Array<number | undefined> = [];
      const runtime = handle.runtime!;
      const realResumed = runtime.resumed.bind(runtime);
      runtime.resumed = () => { seen.push(handle.leaseDeadline); };
      try {
        service.resumed();
        assert.deepEqual(seen, [0], "the runtime resumed with no lease");
        assert.equal(handle.leaseDeadline, 0);
      } finally {
        service.tick = realTick;
        runtime.resumed = realResumed;
      }
      await service.lease(handle);
    });

    await t.test("M1: an abandoned renewal does not acquire a lease", async () => {
      let before = acquires;
      await service.lease(handle, () => false);
      assert.equal(acquires, before, "a renewal the tick gave up on asks the server for nothing");
      service.releasing = true;
      try {
        before = acquires;
        const outcome = await service.lease(handle);
        assert.equal(acquires, before, "no lease while the account changes");
        assert.equal(outcome.outcome, "unavailable");
      } finally {
        service.releasing = false;
      }
      const projects = service.projects;
      projects.delete(projectId);
      try {
        before = acquires;
        await service.lease(handle);
        assert.equal(acquires, before, "no lease for a handle that is no longer registered");
      } finally {
        projects.set(projectId, handle);
      }
    });
  } finally {
    for (const peer of peers) await closePeer(peer).catch(() => undefined);
    await server.stop();
    removeDataDir(server.dataDir);
    temp.cleanup();
  }
});
