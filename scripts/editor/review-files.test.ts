import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { newReview, type ReviewDocument } from "../../src/lib/markdown-review";
import { findReviewDocument, isSafeReviewId, legacyReviewDatabasePath, readReviewDocument, readReviewDocuments, readReviewKeys, reviewsDirectory, withReviewTransaction } from "../../src/lib/storage/review-files";
import { updateReviewDatabase } from "../../electron/collab/control/review-migration";

async function library(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "libera-review-files-"));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const put = (root: string, doc: ReviewDocument) => withReviewTransaction<ReviewDocument, void>(root, (tx) => tx.put(doc));

test("migration preserves reviews with reserved, unsafe, duplicate and case-colliding ids", async () => {
  await library(async (root) => {
    const ids = ["index", "INDEX", "CON", "nul", "../outside", "Review-a", "review-A", "duplicate", "duplicate", "__proto__"];
    const documents = ids.map((id, i) => newReview(`Notes/${i}.md`, `text ${i}`, id));
    await fs.mkdir(path.dirname(legacyReviewDatabasePath(root)), { recursive: true });
    await fs.writeFile(legacyReviewDatabasePath(root), JSON.stringify({ schemaVersion: 1, documents }));
    const migrated = await readReviewDocuments<ReviewDocument>(root);
    assert.equal(migrated.length, documents.length);
    assert.equal(new Set(migrated.map((doc) => doc.id.toLowerCase())).size, documents.length);
    for (const [i, doc] of migrated.entries()) {
      assert.ok(isSafeReviewId(doc.id));
      assert.equal(doc.key, documents[i].key);
      assert.equal(doc.snapshot, documents[i].snapshot);
    }
    assert.equal((await fs.readdir(reviewsDirectory(root))).length, documents.length + 1);
    await fs.stat(`${legacyReviewDatabasePath(root)}.migrated`);
    assert.equal(await readReviewDocument(root, "../outside"), null);
    await assert.rejects(put(root, newReview("bad", "", "index")), /Invalid review/);
    await assert.rejects(put(root, newReview("bad", "", "REVIEW-A")), /Duplicate review/);
  });
});

test("a missing synced document never removes its authoritative index entry or creates a replacement", async () => {
  await library(async (root) => {
    const doc = newReview("Notes/a.md", "important", "review-a");
    await put(root, doc);
    const target = path.join(reviewsDirectory(root), `${doc.id}.json`);
    const contents = await fs.readFile(target, "utf8");
    const index = await fs.readFile(path.join(reviewsDirectory(root), "index.json"), "utf8");
    await fs.unlink(target);
    await assert.rejects(withReviewTransaction<ReviewDocument, void>(root, async (tx) => {
      const found = await tx.find(doc.key);
      if (!found) tx.put(newReview(doc.key, "replacement", "replacement"));
    }), /missing/);
    assert.equal(await fs.readFile(path.join(reviewsDirectory(root), "index.json"), "utf8"), index);
    // Listings skip it until it arrives, and a move of its file still re-keys it.
    assert.deepEqual(await readReviewDocuments(root), []);
    await withReviewTransaction<ReviewDocument, void>(root, async (tx) => {
      assert.equal(await tx.getIfPresent(doc.id), undefined);
      tx.rekey(doc.id, "Notes/moved.md");
    });
    await fs.writeFile(target, contents);
    assert.deepEqual(await findReviewDocument(root, "Notes/moved.md"), { ...doc, key: "Notes/moved.md" });
    assert.equal(await findReviewDocument(root, doc.key), null);
  });
});

test("a late legacy database is imported without overwriting newer reviews", async () => {
  await library(async (root) => {
    const current = newReview("Notes/a.md", "newer", "review-a");
    await put(root, current);
    const documents = [newReview(current.key, "old", current.id), newReview("Notes/b.md", "legacy", "review-b")];
    await fs.writeFile(legacyReviewDatabasePath(root), JSON.stringify({ schemaVersion: 1, documents }));
    assert.deepEqual(await readReviewDocument(root, current.id), current);
    assert.equal((await readReviewKeys(root)).size, 2);
    assert.equal((await readReviewDocument<ReviewDocument>(root, "review-b"))?.snapshot, "legacy");
    await fs.stat(`${legacyReviewDatabasePath(root)}.migrated`);
  });
});

test("cross-volume writes fall back beside the target and retry transient Windows rename errors", async (t) => {
  await library(async (root) => {
    const rename = fs.rename;
    let crossVolume = 0, busy = 0;
    const mock = t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (String(to).endsWith(".json")) {
        if (path.dirname(String(from)) !== path.dirname(String(to))) { crossVolume++; throw Object.assign(new Error("volume"), { code: "EXDEV" }); }
        if (busy++ < 3) throw Object.assign(new Error("held"), { code: ["EPERM", "EBUSY", "EACCES"][busy - 1] });
      }
      return rename(from, to);
    });
    try {
      const doc = newReview("Notes/a.md", "saved", "review-a");
      await put(root, doc);
      assert.deepEqual(await readReviewDocument(root, doc.id), doc);
      assert.equal(crossVolume, 1);
      assert.ok(busy >= 4);
      assert.deepEqual((await fs.readdir(reviewsDirectory(root))).sort(), ["index.json", "review-a.json"]);
    } finally { mock.mock.restore(); }
  });
});

test("an interrupted index publish keeps the previous authoritative key and all review data", async (t) => {
  await library(async (root) => {
    const doc = newReview("Notes/a.md", "saved", "review-a");
    await put(root, doc);
    const rename = fs.rename;
    const mock = t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (String(to) === path.join(reviewsDirectory(root), "index.json")) throw Object.assign(new Error("interrupted"), { code: "EIO" });
      return rename(from, to);
    });
    try {
      await assert.rejects(withReviewTransaction<ReviewDocument, void>(root, async (tx) => { (await tx.get(doc.id))!.key = "Notes/moved.md"; }), /interrupted/);
      assert.deepEqual(await readReviewDocument(root, doc.id), doc);
    } finally { mock.mock.restore(); }
    await withReviewTransaction<ReviewDocument, void>(root, async (tx) => { (await tx.get(doc.id))!.key = "Notes/moved.md"; });
    assert.equal((await readReviewDocument(root, doc.id))?.key, "Notes/moved.md");
  });
});

test("the Electron host and Next transactions retain concurrent updates without no-op rewrites", async () => {
  await library(async (root) => {
    const doc = newReview("Notes/a.md", "saved", "review-a");
    await put(root, doc);
    await Promise.all([
      updateReviewDatabase(root, (db) => { db.documents[0].enabled = true; db.documents[0].revision++; }),
      withReviewTransaction<ReviewDocument, void>(root, async (tx) => { const next = (await tx.get(doc.id))!; next.snapshot = "new snapshot"; next.revision++; }),
    ]);
    const next = await readReviewDocument<ReviewDocument>(root, doc.id);
    assert.equal(next?.enabled, true); assert.equal(next?.snapshot, "new snapshot"); assert.equal(next?.revision, 2);
    const target = path.join(reviewsDirectory(root), `${doc.id}.json`);
    const before = await fs.stat(target);
    await updateReviewDatabase(root, () => {});
    const after = await fs.stat(target);
    assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
  });
});

test("a library opened through a directory alias shares the same transaction lock", async () => {
  await library(async (root) => {
    const actual = path.join(root, "actual"), alias = path.join(root, "alias");
    await fs.mkdir(actual);
    await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    await put(actual, newReview("Notes/a.md", "saved", "review-a"));
    await Promise.all([
      withReviewTransaction<ReviewDocument, void>(actual, async (tx) => {
        const doc = (await tx.get("review-a"))!;
        await new Promise((resolve) => setTimeout(resolve, 50));
        doc.snapshot = "new snapshot"; doc.revision++;
      }),
      updateReviewDatabase(alias, (db) => { db.documents[0].enabled = true; db.documents[0].revision++; }),
    ]);
    const doc = await readReviewDocument<ReviewDocument>(actual, "review-a");
    assert.equal(doc?.snapshot, "new snapshot"); assert.equal(doc?.enabled, true); assert.equal(doc?.revision, 2);
  });
});

test("competing processes recover a dead lock without stealing the next live lock", async () => {
  await library(async (root) => {
    await put(root, newReview("Notes/a.md", "", "review-a"));
    const digest = createHash("sha256").update(path.join(await fs.realpath(root), ".libera", "reviews").toLowerCase()).digest("hex").slice(0, 32);
    const lock = path.join(os.tmpdir(), "libera-locks", `reviews-${digest}.lock`);
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, "2147483647-dead"), "");
    const script = `const {withReviewTransaction}=require('./src/lib/storage/review-files.ts'); (async()=>{for(let i=0;i<8;i++) await withReviewTransaction(process.argv[1],async tx=>{const d=await tx.get('review-a');await new Promise(r=>setTimeout(r,3));d.revision++;});})().catch(e=>{console.error(e);process.exitCode=1;});`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--require", "./scripts/editor/setup.cjs", "--import", pathToFileURL(path.resolve("server/node_modules/tsx/dist/loader.mjs")).href, "--eval", script, root], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { output += data; });
      child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output)));
    })));
    assert.equal((await readReviewDocument<ReviewDocument>(root, "review-a"))?.revision, 32);
  });
});
