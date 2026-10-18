// Self-test of the chaos proxy: each fault does what the durability matrix
// and the fuzzer rely on. Uses a plain WebSocket echo server (ws), no
// collab server, so it runs in about a second.

import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import test, { after, before } from "node:test";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { encodeMessage, MessageType } from "../../src/lib/collab/protocol/messages";
import { ChaosProxy, type ProxyLink } from "./harness/chaos-proxy";
import { sleep, waitUntil } from "./harness/cluster";

let wss: WebSocketServer;
let port = 0;
let proxy: ChaosProxy;
const serverSockets = new Set<ServerSocket>();

before(async () => {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  port = (wss.address() as AddressInfo).port;
  // Echoes every binary message back.
  wss.on("connection", (socket) => {
    serverSockets.add(socket);
    socket.on("close", () => serverSockets.delete(socket));
    socket.on("message", (data: Buffer) => socket.send(data));
  });
  proxy = new ChaosProxy({ port });
});

after(async () => {
  await proxy.close();
  for (const socket of serverSockets) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

interface Client {
  socket: WebSocket;
  received: Uint8Array[];
  closed: boolean;
  errored: boolean;
}

function connect(link: ProxyLink): Client {
  const socket = new WebSocket(`ws://127.0.0.1:${link.port}/`);
  socket.binaryType = "arraybuffer";
  const client: Client = { socket, received: [], closed: false, errored: false };
  socket.onmessage = (event) => client.received.push(new Uint8Array(event.data as ArrayBuffer));
  socket.onclose = () => (client.closed = true);
  socket.onerror = () => (client.errored = true);
  return client;
}

async function open(link: ProxyLink): Promise<Client> {
  const client = connect(link);
  await waitUntil(() => client.socket.readyState === WebSocket.OPEN, "the socket to open", 5000);
  return client;
}

function updateFrame(seq: number): Uint8Array {
  return encodeMessage({ type: MessageType.Update, docId: "doc_proxytest", subdoc: "content", clientSeq: seq, update: new Uint8Array([seq]) });
}

test("an ideal link forwards WebSocket traffic unchanged", async () => {
  const link = await proxy.addLink("ideal");
  const client = await open(link);
  client.socket.send(new Uint8Array([1, 2, 3]));
  await waitUntil(() => client.received.length === 1, "the echo");
  assert.deepEqual([...client.received[0]], [1, 2, 3]);
  client.socket.close();
});

test("latency delays each direction, in order", async () => {
  const link = await proxy.addLink("latency");
  const client = await open(link);
  link.set({ latencyMs: 100, jitterMs: 30 });
  const started = Date.now();
  for (let index = 0; index < 5; index += 1) client.socket.send(new Uint8Array([index]));
  await waitUntil(() => client.received.length === 5, "the echoes", 5000);
  assert.ok(Date.now() - started >= 200, "a round trip costs twice the one-way latency");
  assert.deepEqual(
    client.received.map((bytes) => bytes[0]),
    [0, 1, 2, 3, 4],
    "jitter never reorders a stream",
  );
  client.socket.close();
});

test("bandwidth caps throughput", async () => {
  const link = await proxy.addLink("bandwidth");
  const client = await open(link);
  link.set({ bandwidthBytesPerSec: 200_000 });
  const started = Date.now();
  client.socket.send(new Uint8Array(100_000));
  await waitUntil(() => client.received.length === 1, "the echo", 10_000);
  // 100 kB up and 100 kB down at 200 kB/s each: at least ~0.5 s.
  assert.ok(Date.now() - started >= 450, `took ${Date.now() - started} ms`);
  client.socket.close();
});

test("partition resets open connections and refuses new ones until healed", async () => {
  const link = await proxy.addLink("partition");
  const client = await open(link);
  link.partition();
  await waitUntil(() => client.closed || client.errored, "the open socket to fail");
  const refused = connect(link);
  await sleep(300);
  assert.notEqual(refused.socket.readyState, WebSocket.OPEN, "no new connection while partitioned");
  link.heal();
  const healed = await open(link);
  healed.socket.send(new Uint8Array([9]));
  await waitUntil(() => healed.received.length === 1, "traffic after heal");
  healed.socket.close();
});

test("blackhole keeps sockets open but forwards nothing; killSilently only affects existing sockets", async () => {
  const link = await proxy.addLink("blackhole");
  const client = await open(link);
  link.blackhole();
  client.socket.send(new Uint8Array([1]));
  await sleep(300);
  assert.equal(client.received.length, 0);
  assert.equal(client.socket.readyState, WebSocket.OPEN, "the socket still looks alive");
  link.heal();
  await waitUntil(() => client.closed || client.errored, "healing resets the black-holed socket");

  const old = await open(link);
  link.killSilently();
  const fresh = await open(link);
  old.socket.send(new Uint8Array([1]));
  fresh.socket.send(new Uint8Array([2]));
  await waitUntil(() => fresh.received.length === 1, "the new socket works");
  await sleep(200);
  assert.equal(old.received.length, 0, "the old socket is dead");
  fresh.socket.close();
  link.reset();
});

test("stall holds bytes per direction until resume", async () => {
  const link = await proxy.addLink("stall");
  const client = await open(link);
  link.stall(undefined, "down");
  client.socket.send(new Uint8Array([7]));
  await sleep(200);
  assert.equal(client.received.length, 0, "the echo is held");
  assert.equal(serverSockets.size > 0, true);
  link.resume();
  await waitUntil(() => client.received.length === 1, "the held echo after resume");
  client.socket.close();
});

test("duplication repeats whole sync frames; reordering swaps server frames", async () => {
  const link = await proxy.addLink("duplicate");
  const client = await open(link);
  link.set({ duplicateRate: 1 });
  client.socket.send(updateFrame(1));
  // Duplicated up (the server echoes twice); echoes are update frames, which
  // are not duplicable downstream, so exactly two come back.
  await waitUntil(() => client.received.length === 2, "the duplicated update to be echoed twice");
  await sleep(100);
  assert.equal(client.received.length, 2);
  assert.ok(link.stats.duplicatedFrames >= 1);

  // Non-sync payloads are never touched.
  client.received.length = 0;
  client.socket.send(new Uint8Array([200, 1]));
  await waitUntil(() => client.received.length === 1, "a plain echo");
  await sleep(100);
  assert.equal(client.received.length, 1);
  client.socket.close();

  const reorder = await proxy.addLink("reorder");
  const other = await open(reorder);
  reorder.set({ reorderRate: 1 });
  // The echo server sends back whatever we send: make it send Remote frames.
  const remote = (seq: number) =>
    encodeMessage({
      type: MessageType.Remote,
      docId: "doc_proxytest",
      subdoc: "content",
      serverSeq: seq,
      update: new Uint8Array([seq]),
      userId: "acc_proxytest",
      clientId: "cli_proxytest",
    });
  other.socket.send(remote(1));
  other.socket.send(remote(2));
  await waitUntil(() => other.received.length === 2, "both remote frames");
  assert.ok(reorder.stats.reorderedFrames >= 1);
  assert.deepEqual([...other.received[0]], [...remote(2)], "the second frame overtook the first");
  assert.deepEqual([...other.received[1]], [...remote(1)]);
  other.socket.close();
});

test("a link to a dead upstream resets the client", async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const deadPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const dead = new ChaosProxy({ port: deadPort });
  const link = await dead.addLink("dead");
  const client = connect(link);
  await sleep(500);
  assert.notEqual(client.socket.readyState, WebSocket.OPEN);
  assert.ok(link.stats.resets >= 1, "the proxy reset the client side");
  await dead.close();
});
