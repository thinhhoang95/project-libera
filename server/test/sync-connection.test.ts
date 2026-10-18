import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { signAccessToken } from "../src/auth/tokens.js";
import { CloseCode, MessageType, PROTOCOL_VERSION } from "../src/protocol.js";
import { SyncTimings } from "../src/sync/index.js";
import { SyncTestClient } from "./support/sync-client.js";
import { createAccount, startSyncEnv, type SyncEnv } from "./support/sync-fixtures.js";

describe("sync connection", () => {
  let env: SyncEnv;
  before(async () => {
    env = await startSyncEnv({ MIN_PROTOCOL_VERSION: PROTOCOL_VERSION });
  });
  after(() => env.close());

  test("hello is answered with welcome", async () => {
    const client = await env.connect();
    assert.ok(client.welcome);
    assert.equal(client.welcome.userId, env.owner.id);
    assert.equal(client.welcome.protocolVersion, PROTOCOL_VERSION);
    assert.equal(client.welcome.minProtocolVersion, PROTOCOL_VERSION);
    assert.ok(Math.abs(client.welcome.serverTime - Date.now()) < 5000);
    client.send({ type: MessageType.Ping, nonce: 42 });
    const pong = await client.waitFor((m) => m.type === MessageType.Pong);
    assert.deepEqual(pong, { type: MessageType.Pong, nonce: 42 });
    assert.equal(env.server.server.sync.connectionCount(), 1);
    await client.close();
  });

  test("a client below the minimum protocol is closed with 4026", async () => {
    const client = await env.connect(env.owner, { protocolVersion: PROTOCOL_VERSION - 1 });
    assert.equal((await client.closed).code, CloseCode.ClientTooOld);
    assert.equal(client.welcome, undefined);
  });

  test("bad and expired tokens are closed with 4001, disabled accounts with 4002", async () => {
    const bad = await env.connect(env.owner, { token: "not-a-token" });
    assert.equal((await bad.closed).code, CloseCode.AuthExpired);

    const { token: expired } = await signAccessToken(
      env.config,
      env.owner.id,
      env.owner.familyId,
      new Date(Date.now() - 2 * env.config.ACCESS_TOKEN_TTL_SECONDS * 1000),
    );
    const late = await env.connect(env.owner, { token: expired });
    assert.equal((await late.closed).code, CloseCode.AuthExpired);

    const disabled = await createAccount(env.db, env.config, { disabled: true });
    const off = await env.connect(disabled);
    assert.equal((await off.closed).code, CloseCode.AuthRevoked);
  });

  test("the first frame must be hello", async () => {
    const client = await env.connect(env.owner, { skipHello: true });
    client.send({ type: MessageType.Ping, nonce: 1 });
    assert.equal((await client.closed).code, CloseCode.ProtocolError);
  });

  test("a socket that never says hello is closed with 4000", async () => {
    const saved = SyncTimings.helloTimeoutMs;
    SyncTimings.helloTimeoutMs = 100;
    try {
      const client = await env.connect(env.owner, { skipHello: true });
      assert.equal((await client.closed).code, CloseCode.ProtocolError);
    } finally {
      SyncTimings.helloTimeoutMs = saved;
    }
  });

  test("malformed frames get bad-message errors, and repeated abuse closes the socket", async () => {
    const client = await env.connect();
    client.sendRaw(new Uint8Array([MessageType.Open, 0xff]));
    const error = await client.waitFor((m) => m.type === MessageType.Error);
    assert.equal(error.type === MessageType.Error && error.code, "bad-message");
    client.sendRaw("text frame");
    await client.waitFor((m) => m.type === MessageType.Error);
    for (let index = 0; index < 10; index += 1) client.sendRaw(new Uint8Array([200]));
    assert.equal((await client.closed).code, CloseCode.ProtocolError);
  });

  test("refresh-token swaps the token; another account's token closes the socket", async () => {
    const saved = SyncTimings.tokenGraceMs;
    SyncTimings.tokenGraceMs = 0;
    try {
      // A token that expires in about a second; without a refresh the socket would close then.
      const { token: shortLived } = await signAccessToken(
        env.config,
        env.owner.id,
        env.owner.familyId,
        new Date(Date.now() - (env.config.ACCESS_TOKEN_TTL_SECONDS - 1) * 1000),
      );
      const client = await env.connect(env.owner, { token: shortLived });
      assert.ok(client.welcome);
      const { token: fresh } = await signAccessToken(env.config, env.owner.id, env.owner.familyId);
      client.send({ type: MessageType.RefreshToken, token: fresh });
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.equal(client.closeCode, undefined, "refreshed socket stays open");

      const stranger = await createAccount(env.db, env.config);
      client.send({ type: MessageType.RefreshToken, token: stranger.token });
      assert.equal((await client.closed).code, CloseCode.AuthExpired);

      const unrefreshed = await env.connect(env.owner, {
        token: (
          await signAccessToken(
            env.config,
            env.owner.id,
            env.owner.familyId,
            new Date(Date.now() - (env.config.ACCESS_TOKEN_TTL_SECONDS - 1) * 1000),
          )
        ).token,
      });
      assert.ok(unrefreshed.welcome);
      assert.equal((await unrefreshed.closed).code, CloseCode.AuthExpired);
    } finally {
      SyncTimings.tokenGraceMs = saved;
    }
  });

  test("accountRevoked closes the account's sockets with 4002", async () => {
    const client = await env.connect();
    const other = await createAccount(env.db, env.config);
    const bystander = await env.connect(other);
    env.server.server.context.rooms.accountRevoked(env.owner.id, "some-other-family");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(client.closeCode, undefined, "other refresh families are untouched");
    env.server.server.context.rooms.accountRevoked(env.owner.id, env.owner.familyId);
    assert.equal((await client.closed).code, CloseCode.AuthRevoked);
    assert.equal(bystander.closeCode, undefined);
    await bystander.close();
  });
});

describe("sync admission control", () => {
  test("too many connections from one IP are closed with 4029", async () => {
    const env = await startSyncEnv({ SYNC_CONNECTIONS_PER_MINUTE: 3 });
    try {
      const clients = [await env.connect(), await env.connect(), await env.connect()];
      for (const client of clients) assert.ok(client.welcome);
      const fourth = await env.connect();
      assert.equal((await fourth.closed).code, CloseCode.RateLimited);
    } finally {
      await env.close();
    }
  });

  test("too many sockets for one account are closed with 4029", async () => {
    const env = await startSyncEnv({ SYNC_MAX_SOCKETS_PER_ACCOUNT: 2 });
    try {
      const first = await env.connect();
      const second = await env.connect();
      assert.ok(first.welcome && second.welcome);
      const third = await env.connect();
      assert.equal((await third.closed).code, CloseCode.RateLimited);
      await first.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const again = await env.connect();
      assert.ok(again.welcome, "a slot frees up when a socket closes");
    } finally {
      await env.close();
    }
  });

  test("closing the server closes every socket with 4050", async () => {
    const env = await startSyncEnv();
    const client = await env.connect();
    await client.open(env.docId);
    const silent = await SyncTestClient.connect(env.server.wsUrl, { token: env.owner.token, skipHello: true });
    await env.server.close();
    assert.equal((await client.closed).code, CloseCode.ServerRestart);
    assert.ok((await silent.closed).code !== undefined);
  });
});

test("sync metrics are exported", async () => {
  const env = await startSyncEnv();
  try {
    const client = await env.connect();
    await client.open(env.docId);
    const response = await fetch(`${env.server.url}/metrics`);
    const text = await response.text();
    assert.match(text, /libera_sync_rooms 1/);
    assert.match(text, /libera_sync_sockets 1/);
    for (const name of ["libera_sync_persist_seconds", "libera_sync_fanout_seconds", "libera_sync_updates_total", "libera_sync_rejects_total"]) {
      assert.ok(text.includes(name), name);
    }
  } finally {
    await env.close();
  }
});
