import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { GET as listArchive, POST as archiveRoute } from "../../src/app/api/gallery/archive/route";
import { GET as rawArchive } from "../../src/app/api/gallery/archive/raw/[name]/route";
import { DELETE as lockRoute, POST as unlockRoute } from "../../src/app/api/gallery/archive/session/route";
import { GET as rawGallery } from "../../src/app/api/gallery/raw/[...path]/route";
import {
  ARCHIVE_COOKIE_NAME, archiveUnlockRetryAfterMs, createArchiveToken, createSessionToken, recordArchiveUnlockAttempt,
  SESSION_COOKIE_NAME, verifyArchiveToken, verifySessionToken,
} from "../../src/lib/auth";
import { parsePhotoEdits } from "../../src/lib/photo-edits";
import {
  archivePhotos, createAlbum, deleteAlbum, deleteArchivedPhotos, editPhoto, getArchive, getGallery, getGalleryRoot,
  readArchivedPhoto, readArchivedThumbnail, readGalleryPhoto, readGalleryThumbnail, restoreArchivedPhotos, setPhotosStarred, writeGalleryPhoto,
} from "../../src/lib/storage/gallery";

async function withDataDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-archive-"));
  const previous = process.env.LIBERA_DATA_DIR;
  process.env.LIBERA_DATA_DIR = directory;
  try { await run(directory); } finally {
    if (previous === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const tile = (color = "#4060a0") => sharp({ create: { width: 900, height: 600, channels: 3, background: color } }).png().toBuffer();
const list = async (...segments: string[]) => (await readdir(path.join(getGalleryRoot(), ...segments)).catch(() => [] as string[])).sort();

function request(url: string, { session = true, archive = false, body }: { session?: boolean; archive?: boolean; body?: unknown } = {}) {
  const cookies = [
    session ? `${SESSION_COOKIE_NAME}=${createSessionToken()}` : "",
    archive ? `${ARCHIVE_COOKIE_NAME}=${createArchiveToken()}` : "",
  ].filter(Boolean).join("; ");
  return new NextRequest(`http://localhost${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(cookies ? { cookie: cookies } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("archiving hides photos from the gallery and its albums; restoring puts them back where they were", () => withDataDirectory(async () => {
  const kept = await writeGalleryPhoto("", "kept.png", await tile(), {});
  const secret = await writeGalleryPhoto("", "secret.png", await tile("#aa0000"), { prompt: "private" });
  const album = (await createAlbum("Trip", [secret.id])).album;
  await setPhotosStarred([secret.id], true);
  await readGalleryThumbnail("Trip/secret.png");
  assert.equal((await list(".thumbnails")).length, 1);

  const { archived, gallery } = await archivePhotos([secret.id, "missing"]);
  assert.equal(archived, 1);
  assert.deepEqual(gallery.photos.map((photo) => photo.id), [kept.id]);
  assert.equal(gallery.albums[0].count, 0);
  assert.deepEqual(await list("Trip"), []);
  assert.deepEqual(await list(".protected").then((names) => names.filter((name) => !name.startsWith("."))), ["secret.png"]);
  // The gallery's thumbnail cache no longer holds a preview of it.
  assert.deepEqual(await list(".thumbnails"), []);
  // A rescan does not find it again, and hidden folders never become albums.
  const rescanned = await getGallery();
  assert.deepEqual(rescanned.photos.map((photo) => photo.id), [kept.id]);
  assert.deepEqual(rescanned.albums.map((entry) => entry.name), ["Trip"]);
  // The gallery's own routes cannot reach it.
  await assert.rejects(readGalleryPhoto(".protected/secret.png"), /reserved/);

  const archive = await getArchive();
  assert.equal(archive.photos.length, 1);
  assert.equal(archive.photos[0].prompt, "private");
  assert.equal(archive.photos[0].starred, true);
  assert.deepEqual(archive.photos[0].albumIds, [album.id]);
  assert.ok(archive.photos[0].archivedAt);
  assert.equal((await readArchivedThumbnail("secret.png")).contentType, "image/webp");
  assert.deepEqual(await list(".protected", ".thumbnails").then((names) => names.length), 1);

  const restored = await restoreArchivedPhotos([secret.id]);
  assert.equal(restored.restored, 1);
  assert.deepEqual(restored.archive.photos, []);
  const back = restored.gallery.photos.find((photo) => photo.id === secret.id);
  assert.equal(back?.path, "Trip/secret.png");
  assert.deepEqual(back?.albumIds, [album.id]);
  assert.equal(back?.starred, true);
  assert.deepEqual(await list(".protected", ".thumbnails"), []);
}));

test("a restored photo whose album and folder are gone returns to the top of the gallery", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "a.png", await tile(), {});
  const album = (await createAlbum("Gone", [photo.id])).album;
  await archivePhotos([photo.id]);
  await deleteAlbum(album.id);
  await rm(path.join(getGalleryRoot(), "Gone"), { recursive: true });
  // Another photo took its name meanwhile; nothing is overwritten.
  await writeGalleryPhoto("", "a.png", await tile("#00aa00"), {});
  const { gallery } = await restoreArchivedPhotos([photo.id]);
  const back = gallery.photos.find((entry) => entry.id === photo.id);
  assert.equal(back?.path, "a-1.png");
  assert.deepEqual(back?.albumIds, []);
}));

test("an edited photo's original goes into the archive with it, and deleting removes both", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "a.png", await tile(), {});
  await editPhoto(photo.id, parsePhotoEdits({ brightness: 30 }), "replace");
  assert.equal((await list(".originals")).length, 1);
  await archivePhotos([photo.id]);
  assert.deepEqual(await list(".originals"), []);
  assert.equal((await list(".protected", ".originals")).length, 1);
  assert.equal((await getArchive()).photos[0].edited, true);

  const { deleted, archive } = await deleteArchivedPhotos([photo.id]);
  assert.equal(deleted, 1);
  assert.deepEqual(archive.photos, []);
  assert.deepEqual(await list(".protected", ".originals"), []);
  assert.deepEqual((await list(".protected")).filter((name) => !name.startsWith(".")), []);
}));

test("archived photo names from requests cannot leave the archive folder", () => withDataDirectory(async () => {
  await assert.rejects(readArchivedPhoto("../kept.png"), /unsupported/);
  await assert.rejects(readArchivedPhoto(".libera-gallery.json"), /reserved/);
  await assert.rejects(readArchivedPhoto("notes.txt"), /Only images/);
}));

test("archive and session tokens are not interchangeable", () => {
  assert.equal(verifyArchiveToken(createSessionToken()), false);
  assert.equal(verifySessionToken(createArchiveToken()), false);
  assert.equal(verifyArchiveToken(createArchiveToken()), true);
});

test("the archive's routes need the password entered again", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "secret.png", await tile(), {});

  // Hiding a photo only needs a session; seeing the archive needs the unlock.
  assert.equal((await archiveRoute(request("/api/gallery/archive", { session: false, body: { ids: [photo.id] } }))).status, 401);
  assert.equal((await archiveRoute(request("/api/gallery/archive", { body: { ids: [photo.id] } }))).status, 200);
  const locked = await listArchive(request("/api/gallery/archive"));
  assert.equal(locked.status, 403);
  assert.equal((await locked.json()).locked, true);
  const context = { params: Promise.resolve({ name: "secret.png" }) };
  assert.equal((await rawArchive(request("/api/gallery/archive/raw/secret.png"), context)).status, 403);
  // An archive cookie without a session is not enough either.
  assert.equal((await listArchive(request("/api/gallery/archive", { session: false, archive: true }))).status, 401);
  // The gallery's raw route does not serve archived files.
  const galleryContext = { params: Promise.resolve({ path: [".protected", "secret.png"] }) };
  assert.notEqual((await rawGallery(request("/api/gallery/raw/.protected/secret.png"), galleryContext)).status, 200);

  assert.equal((await unlockRoute(request("/api/gallery/archive/session", { body: { password: "wrong" } }))).status, 401);
  const unlocked = await unlockRoute(request("/api/gallery/archive/session", { body: { password: process.env.LIBERA_DEV_PASSWORD ?? "libera" } }));
  assert.equal(unlocked.status, 200);
  const cookie = unlocked.cookies.get(ARCHIVE_COOKIE_NAME);
  assert.ok(cookie?.httpOnly && verifyArchiveToken(cookie.value));

  const listed = await listArchive(request("/api/gallery/archive", { archive: true }));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).photos.map((entry: { id: string }) => entry.id), [photo.id]);
  assert.ok(listed.cookies.get(ARCHIVE_COOKIE_NAME)?.value, "using the archive keeps it unlocked");
  const raw = await rawArchive(request("/api/gallery/archive/raw/secret.png", { archive: true }), context);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), await readFile(path.join(getGalleryRoot(), ".protected", "secret.png")));

  const lockedAgain = lockRoute();
  assert.equal(lockedAgain.cookies.get(ARCHIVE_COOKIE_NAME)?.value, "");
}));

test("wrong archive passwords slow down further tries", () => {
  const now = 1_000_000;
  recordArchiveUnlockAttempt(true, now);
  for (let attempt = 0; attempt < 4; attempt += 1) recordArchiveUnlockAttempt(false, now);
  assert.equal(archiveUnlockRetryAfterMs(now), 0);
  recordArchiveUnlockAttempt(false, now);
  assert.equal(archiveUnlockRetryAfterMs(now), 30_000);
  recordArchiveUnlockAttempt(false, now);
  assert.equal(archiveUnlockRetryAfterMs(now), 60_000);
  recordArchiveUnlockAttempt(true, now);
  assert.equal(archiveUnlockRetryAfterMs(now), 0);
});
