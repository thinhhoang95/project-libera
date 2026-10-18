import assert from "node:assert/strict";
import test from "node:test";

import {
  bindActor,
  can,
  canWriteSubdoc,
  CodecError,
  decodeMessage,
  docKindForPath,
  encodeMessage,
  fromBase64,
  manifestPathError,
  MessageType,
  Reader,
  toBase64,
  Writer,
  type SyncMessage,
} from "../../src/lib/collab/protocol";

const bytes = (...values: number[]) => new Uint8Array(values);

const samples: SyncMessage[] = [
  { type: MessageType.Hello, protocolVersion: 1, appVersion: "6.5.0", token: "tok", clientId: "c1" },
  { type: MessageType.Welcome, protocolVersion: 1, minProtocolVersion: 1, userId: "u1", serverTime: Date.now() },
  {
    type: MessageType.Open,
    docId: "d1",
    subdocs: [
      { subdoc: "content", stateVector: bytes(0) },
      { subdoc: "annotations", stateVector: bytes(1, 2, 3) },
    ],
  },
  {
    type: MessageType.Opened,
    docId: "d1",
    projectId: "p1",
    role: "commenter",
    schemaVersion: 1,
    serverSeq: 2 ** 40,
    subdocs: [{ subdoc: "meta", diff: bytes(9, 9), stateVector: bytes() }],
  },
  {
    type: MessageType.Update,
    docId: "d1",
    subdoc: "content",
    clientSeq: 7,
    update: bytes(1, 2),
    provenance: { source: "ai", feature: "rewrite", model: "m" },
  },
  { type: MessageType.Update, docId: "d1", subdoc: "content", clientSeq: 8, update: bytes(3) },
  { type: MessageType.Ack, docId: "d1", subdoc: "content", clientSeq: 7, serverSeq: 12 },
  {
    type: MessageType.Reject,
    docId: "d1",
    subdoc: "content",
    clientSeq: 7,
    reason: "forbidden",
    message: "Commenters cannot edit text",
  },
  {
    type: MessageType.Remote,
    docId: "d1",
    subdoc: "annotations",
    serverSeq: 13,
    update: bytes(4, 5),
    userId: "u2",
    clientId: "c2",
  },
  { type: MessageType.Awareness, docId: "d1", update: bytes(1) },
  { type: MessageType.Close, docId: "d1" },
  { type: MessageType.Closed, docId: "d1", reason: "access-revoked" },
  { type: MessageType.Event, scope: "doc", id: "d1", kind: "thread.changed", payload: { a: [1, "ü"] } },
  { type: MessageType.RefreshToken, token: "new" },
  { type: MessageType.Ping, nonce: 3 },
  { type: MessageType.Pong, nonce: 3 },
  { type: MessageType.Error, code: "bad-message", message: "x", docId: "" },
];

test("every message round-trips through the binary codec", () => {
  for (const message of samples) {
    assert.deepEqual(decodeMessage(encodeMessage(message)), message);
  }
});

test("decoder rejects malformed frames", () => {
  assert.throws(() => decodeMessage(bytes(200)), CodecError);
  assert.throws(() => decodeMessage(bytes(MessageType.Close)), CodecError);
  const valid = encodeMessage({ type: MessageType.Close, docId: "d" });
  assert.throws(() => decodeMessage(new Uint8Array([...valid, 0])), CodecError);
  const badSubdoc = new Writer().uint8(MessageType.Ack).string("d").string("nope").varUint(1).varUint(1).finish();
  assert.throws(() => decodeMessage(badSubdoc), CodecError);
});

test("varUint handles large safe integers", () => {
  for (const value of [0, 127, 128, 16_383, 16_384, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(new Reader(new Writer().varUint(value).finish()).varUint(), value);
  }
  assert.throws(() => new Writer().varUint(-1), CodecError);
});

test("base64 helpers round-trip large buffers", () => {
  const data = new Uint8Array(200_000).map((_, index) => index % 251);
  assert.deepEqual(fromBase64(toBase64(data)), data);
});

test("permission matrix", () => {
  assert.equal(canWriteSubdoc("commenter", "annotations"), true);
  assert.equal(canWriteSubdoc("commenter", "content"), false);
  assert.equal(canWriteSubdoc("viewer", "annotations"), false);
  assert.equal(canWriteSubdoc("editor", "manifest"), true);
  assert.equal(can("editor", "decide"), true);
  assert.equal(can("commenter", "suggest"), true);
  const ai = bindActor("u1", "c1", { feature: "rewrite" });
  assert.equal(can("owner", "decide", ai), false);
  assert.equal(can("owner", "suggest", ai), true);
  assert.deepEqual(bindActor("u1", "c1"), { kind: "user", userId: "u1", clientId: "c1" });
});

test("manifest path validation", () => {
  assert.equal(manifestPathError("notes/a.md"), null);
  for (const bad of ["", "/abs", "C:/x", "a/../b", "a//b", "con.txt", "a/b:", "x/.libera/y", "dir./a", "a\\b"]) {
    assert.notEqual(manifestPathError(bad), null, bad);
  }
  assert.equal(docKindForPath("Paper/main.TEX"), "latex");
  assert.equal(docKindForPath("img.png"), null);
});
