import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { archivePhotos, getGallery, getGalleryPhotoDetails, getGalleryRoot, readGalleryThumbnail, setPhotosStarred, streamGalleryPhoto, writeGalleryPhoto } from "../../src/lib/storage/gallery";
import { NextRequest } from "next/server";
import { ARCHIVE_COOKIE_NAME, SESSION_COOKIE_NAME, createArchiveToken, createSessionToken } from "../../src/lib/auth";
import { galleryCatalogPage } from "../../src/lib/storage/gallery-catalog";

async function temporaryGallery(run: () => Promise<void>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "libera-gallery-loading-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = temporary;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    await rm(temporary, { recursive: true, force: true });
  }
}

test("catalog pages omit large text, detect unchanged revisions, and restart after mutations", () => temporaryGallery(async () => {
  const root = getGalleryRoot(); await mkdir(root, { recursive: true });
  const source = path.join(root, "source.png");
  await writeFile(source, await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toBuffer());
  const photos: Record<string, unknown> = {};
  for (let offset = 0; offset < 1001; offset += 50) await Promise.all(Array.from({ length: Math.min(50, 1001 - offset) }, async (_, index) => {
    const id = `p${offset + index}`; const name = `${id}.png`;
    await copyFile(source, path.join(root, name));
    const stats = await stat(path.join(root, name));
    photos[id] = { path: name, createdAt: "2026-10-01T00:00:00Z", mtimeMs: stats.mtimeMs, size: stats.size, width: 4, height: 3, prompt: "large prompt ".repeat(100), model: "model" };
  }));
  await rm(source);
  await writeFile(path.join(root, ".libera-gallery.json"), JSON.stringify({ version: 2, photos, albums: [], folders: [], archive: {} }));
  const first = await galleryCatalogPage();
  assert.equal(first.photos.length, 500);
  assert.equal(first.cursor, 500);
  assert.ok(first.photos.every((photo) => !photo.prompt && !photo.model && photo.detailsDeferred));
  const second = await galleryCatalogPage(first.cursor!, first.revision);
  const third = await galleryCatalogPage(second.cursor!, second.revision);
  assert.equal(new Set([...first.photos, ...second.photos, ...third.photos].map((photo) => photo.id)).size, 1001);
  assert.equal(third.cursor, null);
  const same = await galleryCatalogPage(0, first.revision);
  assert.equal(same.revision, first.revision); assert.deepEqual(same.photos, []);
  const details = await getGalleryPhotoDetails("p0");
  assert.equal(details.photos[0].prompt, "large prompt ".repeat(100));
  await setPhotosStarred(["p0"], true);
  const reset = await galleryCatalogPage(500, first.revision);
  assert.equal(reset.reset, true); assert.equal(reset.cursor, 500);
  assert.notEqual(reset.revision, first.revision);
  assert.equal(reset.photos.find((photo) => photo.id === "p0")?.starred, true);
}));

test("thumbnail sizes are clamped, simultaneous work is shared, and stale variants are swept", () => temporaryGallery(async () => {
  const body = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "blue" } }).png().toBuffer();
  const photo = await writeGalleryPhoto("", "large.png", body, {});
  const controller = new AbortController();
  const canceled = readGalleryThumbnail(photo.path, 320, controller.signal);
  controller.abort();
  await assert.rejects(canceled, { name: "AbortError" });
  const small = await readGalleryThumbnail(photo.path, 160);
  assert.equal((await sharp(small.body).metadata()).width, 160);
  const [first, second] = await Promise.all([readGalleryThumbnail(photo.path, 999999), readGalleryThumbnail(photo.path, 999999)]);
  assert.equal((await sharp(first.body).metadata()).width, 2048);
  assert.strictEqual(first.body, second.body, "concurrent misses share one render");
  await getGallery();
  assert.equal((await readdir(path.join(getGalleryRoot(), ".thumbnails"))).length, 2);
  await writeFile(path.join(getGalleryRoot(), photo.path), await sharp(body).resize(2000, 1000).png().toBuffer());
  await getGallery();
  assert.deepEqual(await readdir(path.join(getGalleryRoot(), ".thumbnails")), []);
}));

test("archived metadata stays behind archive authorization and uses uncached responses", () => temporaryGallery(async () => {
  const body = await sharp({ create: { width: 4, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  const photo = await writeGalleryPhoto("", "secret.png", body, { prompt: "private prompt" });
  await archivePhotos([photo.id]);
  const { GET: archiveDetails } = await import("../../src/app/api/gallery/archive/details/route");
  const { GET: galleryDetails } = await import("../../src/app/api/gallery/photos/details/route");
  const { GET: archiveList } = await import("../../src/app/api/gallery/archive/route");
  const session = `${SESSION_COOKIE_NAME}=${createSessionToken()}`;
  const request = (unlock = false) => new NextRequest(`http://localhost/api/gallery/archive/details?id=${photo.id}`, { headers: { cookie: `${session}${unlock ? `; ${ARCHIVE_COOKIE_NAME}=${createArchiveToken()}` : ""}`, "X-Libera-Gallery": "catalog" } });
  assert.equal((await archiveDetails(request())).status, 403);
  assert.equal((await galleryDetails(request())).status, 404);
  const details = await archiveDetails(request(true));
  assert.equal(details.headers.get("Cache-Control"), "no-store");
  assert.equal((await details.json()).prompt, "private prompt");
  const catalog = await archiveList(request(true));
  assert.equal((await catalog.json()).photos[0].prompt, undefined);
}));

test("originals stream in bounded chunks and cancellation releases the file", () => temporaryGallery(async () => {
  await mkdir(getGalleryRoot(), { recursive: true });
  const file = path.join(getGalleryRoot(), "large.jpg");
  const handle = await open(file, "w"); await handle.truncate(16 * 1024 * 1024); await handle.close();
  const original = await streamGalleryPhoto("large.jpg");
  assert.equal(original.size, 16 * 1024 * 1024);
  const reader = original.body.getReader();
  const first = await reader.read();
  assert.ok(first.value && first.value.byteLength <= 64 * 1024);
  await reader.cancel();
  await rename(file, path.join(getGalleryRoot(), "released.jpg"));
  await assert.rejects(streamGalleryPhoto("missing.jpg"), { code: "ENOENT" });
  assert.throws(() => streamGalleryPhoto("../secret.jpg"), /unsupported|invalid/);
  assert.equal((await readFile(path.join(getGalleryRoot(), "released.jpg"))).byteLength, 16 * 1024 * 1024);
}));
