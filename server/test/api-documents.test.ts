import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import * as Y from "yjs";

import { createDiskBlobStore } from "../src/blobs/disk.js";
import { createS3BlobStore } from "../src/blobs/s3.js";
import { EMPTY_SHA256, signRequest } from "../src/blobs/sigv4.js";
import type { DocumentInfo, UpdatesPage } from "../src/protocol.js";
import { errorCode, request, startApi, team, type ApiHarness } from "./support/api-harness.js";

let h: ApiHarness;
before(async () => {
  h = await startApi();
});
after(() => h.close());

function textUpdate(text: string): string {
  const doc = new Y.Doc();
  doc.getText("source").insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

describe("documents", () => {
  test("create imports initial updates as system actor on behalf of the caller", async () => {
    const { project, editor, viewer } = await team(h);
    const meta = new Y.Doc();
    meta.getMap("meta").set("kind", "markdown");
    const body = {
      docId: "doc_import_0001",
      fileId: "file_import_01",
      kind: "markdown",
      initial: { content: textUpdate("# Hello"), meta: Buffer.from(Y.encodeStateAsUpdate(meta)).toString("base64") },
    };
    const byViewer = await request(h, "POST", `/v1/projects/${project.id}/documents`, viewer, body);
    assert.equal(byViewer.status, 403);

    const created = await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, body);
    assert.equal(created.status, 201);
    const info = created.body as DocumentInfo;
    assert.equal(info.lastServerSeq, 2);
    assert.equal(info.fileId, "file_import_01");
    assert.equal(info.createdBy, editor.id);

    const replay = await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, body);
    assert.equal(replay.status, 200, "same create from the same caller is idempotent");
    assert.equal(replay.body.id, info.id);
    const rows = await h.context.db.selectFrom("doc_updates").select("server_seq").where("doc_id", "=", info.id).execute();
    assert.equal(rows.length, 2, "replay stores nothing new");

    const { owner } = await team(h);
    const other = await request(h, "POST", `/v1/projects/${project.id}/documents`, owner, body);
    assert.equal(other.status, 404, "outsiders cannot even see the project");
    const sameIdOtherFile = await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, { ...body, fileId: "file_other_001" });
    assert.equal(sameIdOtherFile.status, 409);

    const feed = await request(h, "GET", `/v1/documents/${info.id}/updates`, viewer);
    assert.equal(feed.status, 200);
    const page = feed.body as UpdatesPage;
    assert.deepEqual(page.updates.map((update) => [update.serverSeq, update.subdoc]), [[1, "content"], [2, "meta"]]);
    assert.deepEqual(page.updates[0].actor, { kind: "system", reason: "import", onBehalfOf: editor.id });
    assert.equal(page.updates[0].userId, editor.id);
    assert.equal(page.nextFromSeq, null);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(page.updates[0].update, "base64"));
    assert.equal(doc.getText("source").toString(), "# Hello");
  });

  test("rejects bad initial updates", async () => {
    const { project, editor } = await team(h);
    const badBase64 = await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, {
      docId: "doc_bad_b64_01",
      fileId: "file_bad_b64",
      kind: "text",
      initial: { content: "not base64!" },
    });
    assert.equal(badBase64.status, 400);
    const notYjs = await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, {
      docId: "doc_bad_yjs_01",
      fileId: "file_bad_yjs",
      kind: "text",
      initial: { content: Buffer.from([0xff, 0xff, 0xff, 0x01, 0x02]).toString("base64") },
    });
    assert.equal(notYjs.status, 400);
    const badId = await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, { docId: "x", fileId: "file_ok_0001", kind: "text" });
    assert.equal(badId.status, 400);
    const exists = await h.context.db.selectFrom("documents").select("id").where("id", "in", ["doc_bad_b64_01", "doc_bad_yjs_01"]).execute();
    assert.equal(exists.length, 0);
  });

  test("get and delete", async () => {
    const { project, editor, commenter, outsider } = await team(h);
    await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, { docId: "doc_del_00001", fileId: "file_del_0001", kind: "latex" });
    const info = await request(h, "GET", "/v1/documents/doc_del_00001", commenter);
    assert.equal(info.status, 200);
    assert.equal(info.body.kind, "latex");
    assert.equal((await request(h, "GET", "/v1/documents/doc_del_00001", outsider)).status, 404);
    assert.equal((await request(h, "DELETE", "/v1/documents/doc_del_00001", commenter)).status, 403);
    assert.equal((await request(h, "DELETE", `/v1/documents/${project.manifestDocId}`, editor)).status, 400);

    h.rooms.calls.length = 0;
    assert.equal((await request(h, "DELETE", "/v1/documents/doc_del_00001", editor)).status, 204);
    assert.deepEqual(h.rooms.calls, [{ method: "documentDeleted", args: ["doc_del_00001"] }]);
    assert.equal((await request(h, "GET", "/v1/documents/doc_del_00001", editor)).status, 404);
  });

  test("members list a project's live documents, without the manifest", async () => {
    const { project, editor, viewer, outsider } = await team(h);
    for (const id of ["doc_list_00001", "doc_list_00002"]) {
      await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, { docId: id, fileId: `file_${id}`, kind: "markdown" });
    }
    await request(h, "DELETE", "/v1/documents/doc_list_00002", editor);
    const listed = await request(h, "GET", `/v1/projects/${project.id}/documents`, viewer);
    assert.equal(listed.status, 200);
    assert.deepEqual(
      (listed.body as DocumentInfo[]).map((doc) => doc.id),
      ["doc_list_00001"],
    );
    assert.equal((await request(h, "GET", `/v1/projects/${project.id}/documents`, outsider)).status, 404);
  });

  test("the updates feed paginates and starts from a snapshot when the log was compacted", async () => {
    const { project, editor, viewer } = await team(h);
    const docId = "doc_feed_00001";
    await request(h, "POST", `/v1/projects/${project.id}/documents`, editor, { docId, fileId: "file_feed_001", kind: "markdown" });

    // Seven updates, as the sync service would have stored them.
    const doc = new Y.Doc();
    const text = doc.getText("source");
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    for (let index = 0; index < 7; index += 1) text.insert(text.length, String(index));
    await h.context.db
      .insertInto("doc_updates")
      .values(
        updates.map((update, index) => ({
          doc_id: docId,
          subdoc: index === 3 ? ("annotations" as const) : ("content" as const),
          server_seq: index + 1,
          account_id: editor.id,
          client_id: "client-a",
          client_seq: index + 1,
          actor: JSON.stringify({ kind: "user", userId: editor.id }),
          provenance: JSON.stringify({ source: "typing" }),
          update,
          size: update.byteLength,
        })),
      )
      .execute();
    await h.context.db.updateTable("documents").set({ last_server_seq: 7 }).where("id", "=", docId).execute();

    const first = (await request(h, "GET", `/v1/documents/${docId}/updates?fromSeq=1&limit=3`, viewer)).body as UpdatesPage;
    assert.deepEqual(first.updates.map((update) => update.serverSeq), [1, 2, 3]);
    assert.equal(first.nextFromSeq, 4);
    assert.equal(first.baseSnapshot, null);
    const second = (await request(h, "GET", `/v1/documents/${docId}/updates?fromSeq=4&limit=3`, viewer)).body as UpdatesPage;
    assert.deepEqual(second.updates.map((update) => update.serverSeq), [4, 5, 6]);
    assert.equal(second.nextFromSeq, 7);
    const last = (await request(h, "GET", `/v1/documents/${docId}/updates?fromSeq=7&limit=3`, viewer)).body as UpdatesPage;
    assert.deepEqual(last.updates.map((update) => update.serverSeq), [7]);
    assert.equal(last.nextFromSeq, null);
    const bounded = (await request(h, "GET", `/v1/documents/${docId}/updates?fromSeq=2&toSeq=4`, viewer)).body as UpdatesPage;
    assert.deepEqual(bounded.updates.map((update) => update.serverSeq), [2, 3, 4]);
    const contentOnly = (await request(h, "GET", `/v1/documents/${docId}/updates?subdoc=content&limit=10`, viewer)).body as UpdatesPage;
    assert.ok(contentOnly.updates.every((update) => update.subdoc === "content"));
    assert.equal(contentOnly.updates.length, 6);
    assert.equal((await request(h, "GET", `/v1/documents/${docId}/updates?subdoc=nope`, viewer)).status, 400);

    // Compaction: snapshot up to 4, then drop 1..4.
    const upto = new Y.Doc();
    for (const update of updates.slice(0, 4)) Y.applyUpdate(upto, update);
    await h.context.db
      .insertInto("doc_snapshots")
      .values({
        doc_id: docId,
        subdoc: "content",
        upto_server_seq: 4,
        state: Y.encodeStateAsUpdate(upto),
        state_vector: Y.encodeStateVector(upto),
      })
      .execute();
    await h.context.db.deleteFrom("doc_updates").where("doc_id", "=", docId).where("server_seq", "<=", 4).execute();

    const compacted = (await request(h, "GET", `/v1/documents/${docId}/updates?fromSeq=1`, viewer)).body as UpdatesPage;
    assert.equal(compacted.baseSnapshot?.uptoServerSeq, 4);
    assert.equal(compacted.baseSnapshot?.subdoc, "content");
    assert.deepEqual(compacted.updates.map((update) => update.serverSeq), [5, 6, 7]);
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, Buffer.from(compacted.baseSnapshot!.state, "base64"));
    for (const update of compacted.updates) Y.applyUpdate(rebuilt, Buffer.from(update.update, "base64"));
    assert.equal(rebuilt.getText("source").toString(), "0123456");

    const retained = (await request(h, "GET", `/v1/documents/${docId}/updates?fromSeq=5`, viewer)).body as UpdatesPage;
    assert.equal(retained.baseSnapshot, null, "no snapshot when the range is still in the log");
  });
});

describe("blobs", () => {
  const bytes = Buffer.from("\x89PNG fake image bytes");
  const hash = createHash("sha256").update(bytes).digest("hex");

  async function put(projectId: string, token: string | undefined, body: Buffer, urlHash = hash, type = "image/png") {
    return fetch(`${h.url}/v1/projects/${projectId}/blobs/${urlHash}`, {
      method: "PUT",
      headers: { "content-type": type, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: new Uint8Array(body),
    });
  }

  test("upload checks the hash, is idempotent, and serves the bytes back", async () => {
    const { project, editor, viewer, outsider } = await team(h);
    assert.equal((await put(project.id, undefined, bytes)).status, 401);
    assert.equal((await put(project.id, viewer.token, bytes)).status, 403);

    const mismatch = await put(project.id, editor.token, Buffer.from("other bytes"));
    assert.equal(mismatch.status, 400);
    assert.equal(((await mismatch.json()) as any).error.code, "bad-request");
    assert.equal((await put(project.id, editor.token, bytes, "ABC")).status, 400);

    const created = await put(project.id, editor.token, bytes);
    assert.equal(created.status, 201);
    const info = (await created.json()) as any;
    assert.deepEqual([info.hash, info.size, info.mime], [hash, bytes.length, "image/png"]);
    const again = await put(project.id, editor.token, bytes, hash, "application/octet-stream");
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as any).mime, "image/png", "first upload wins");

    const shard = await readdir(join(h.blobDir, hash.slice(0, 2), hash.slice(2, 4)));
    assert.deepEqual(shard, [hash], "stored sharded, with no temp files left");

    const get = await fetch(`${h.url}/v1/projects/${project.id}/blobs/${hash}`, { headers: { authorization: `Bearer ${viewer.token}` } });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);

    const head = await fetch(`${h.url}/v1/projects/${project.id}/blobs/${hash}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    const missing = await fetch(`${h.url}/v1/projects/${project.id}/blobs/${"0".repeat(64)}`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${viewer.token}` },
    });
    assert.equal(missing.status, 404);

    const foreign = await fetch(`${h.url}/v1/projects/${project.id}/blobs/${hash}`, { headers: { authorization: `Bearer ${outsider.token}` } });
    assert.equal(foreign.status, 404);

    // Another project cannot read the bytes until it uploads them itself.
    const other = await team(h);
    const notShared = await request(h, "HEAD", `/v1/projects/${other.project.id}/blobs/${hash}`, other.owner);
    assert.equal(notShared.status, 404);
  });

  test("JSON routes still parse JSON", async () => {
    const { project, editor } = await team(h);
    const response = await request(h, "PATCH", `/v1/projects/${project.id}`, editor, { name: "x" });
    assert.equal(errorCode(response), "forbidden");
  });

  test("rejects bodies over MAX_BLOB_BYTES", async () => {
    const small = await startApi({ MAX_BLOB_BYTES: 16 });
    try {
      const { project, editor } = await team(small);
      const big = Buffer.alloc(64, 1);
      const response = await fetch(`${small.url}/v1/projects/${project.id}/blobs/${createHash("sha256").update(big).digest("hex")}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${editor.token}` },
        body: new Uint8Array(big),
      });
      assert.equal(response.status, 413);
    } finally {
      await small.close();
    }
  });
});

describe("blob drivers", () => {
  test("SigV4 matches the AWS test suite vector (get-vanilla)", () => {
    const signed = signRequest({
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      headers: {},
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      date: new Date("2015-08-30T12:36:00Z"),
    });
    assert.equal(
      signed.headers.authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("SigV4 matches the S3 documentation's GET Object example", () => {
    const signed = signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256 },
      payloadHash: EMPTY_SHA256,
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      date: new Date("2013-05-24T00:00:00Z"),
    });
    assert.match(signed.headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, /);
    assert.match(signed.headers.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });

  test("the S3 driver sends signed path-style requests", async () => {
    const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
    const objects = new Map<string, Uint8Array>();
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      seen.push({ method: init?.method ?? "GET", url, headers });
      if (init?.method === "PUT") {
        objects.set(url, init.body as Uint8Array);
        return new Response(null, { status: 200 });
      }
      const object = objects.get(url);
      if (!object) return new Response(null, { status: 404 });
      return new Response(init?.method === "HEAD" ? null : new Uint8Array(object), { status: 200 });
    }) as typeof fetch;
    const store = createS3BlobStore({
      endpoint: "http://127.0.0.1:9000/",
      bucket: "libera-blobs",
      region: "us-east-1",
      accessKeyId: "minio",
      secretAccessKey: "minio-secret",
      fetch: fakeFetch,
    });
    const data = Buffer.from("hello s3");
    const key = createHash("sha256").update(data).digest("hex");
    assert.equal(await store.has(key), false);
    await store.put(key, data, "text/plain");
    assert.equal(await store.has(key), true);
    const stream = await store.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "hello s3");

    const putRequest = seen.find((entry) => entry.method === "PUT")!;
    assert.equal(putRequest.url, `http://127.0.0.1:9000/libera-blobs/${key.slice(0, 2)}/${key}`);
    assert.equal(putRequest.headers["x-amz-content-sha256"], key);
    assert.match(putRequest.headers.authorization, /^AWS4-HMAC-SHA256 Credential=minio\/\d{8}\/us-east-1\/s3\/aws4_request, /);
    assert.equal(putRequest.headers.host, undefined, "fetch sets Host itself");
    await assert.rejects(store.get("../etc/passwd"));
  });

  test("the disk driver refuses non-hash keys", async () => {
    const store = createDiskBlobStore(h.blobDir);
    await assert.rejects(store.put("../../evil", Buffer.from("x"), "text/plain"));
  });
});
