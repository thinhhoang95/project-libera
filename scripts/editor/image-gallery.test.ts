import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { parseImageGenerationSettings, validParameterValues } from "../../src/lib/image-generation";
import { generatedImageName, parseReferenceImages, readImageGenerationSettings, writeImageGenerationSettings } from "../../src/lib/image-generation-server";
import { justifiedRows, photoRatio } from "../../src/lib/gallery-layout";
import { colorMatrix, flipCrop, NO_EDITS, parsePhotoEdits, rotateCropClockwise, rotateCropCounterClockwise, toneCurve } from "../../src/lib/photo-edits";
import { renderEditedPhoto } from "../../src/lib/photo-edits-server";
import {
  createAlbum, deleteAlbum, deletePhotos, editPhoto, getGallery, getGalleryRoot, readGalleryThumbnail, renameAlbum, revertPhoto,
  setPhotosStarred, updateAlbumPhotos, writeGalleryPhoto,
} from "../../src/lib/storage/gallery";

async function withDataDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-gallery-"));
  const previous = { data: process.env.LIBERA_DATA_DIR, config: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = directory;
  delete process.env.LIBERA_CONFIG_PATH;
  try { await run(directory); } finally {
    if (previous.data === undefined) delete process.env.LIBERA_DATA_DIR; else process.env.LIBERA_DATA_DIR = previous.data;
    if (previous.config !== undefined) process.env.LIBERA_CONFIG_PATH = previous.config;
    await rm(directory, { recursive: true, force: true });
  }
}


const tile = (color = "#4060a0", width = 900, height = 600) => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
const files = async (folder = "") => (await readdir(path.join(getGalleryRoot(), folder), { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();

test("creating an album moves its photos into a new folder; deleting it keeps them", () => withDataDirectory(async () => {
  const first = await writeGalleryPhoto("", "a.png", await tile(), { prompt: "red panda", model: "m", createdAt: "2026-10-01T10:00:00.000Z" });
  const second = await writeGalleryPhoto("", "b.png", await tile(), {});
  const { album } = await createAlbum("Covers", [first.id]);
  assert.equal(album.folder, "Covers");
  assert.deepEqual(await files("Covers"), ["a.png"]);
  assert.deepEqual(await files(), ["b.png"]);
  await assert.rejects(createAlbum("covers"), /already exists/);
  await assert.rejects(createAlbum("../escape"), /unsupported/);

  // Adding to an existing album only records membership.
  let gallery = await updateAlbumPhotos(album.id, { add: [second.id] });
  assert.deepEqual(await files(), ["b.png"]);
  assert.equal(gallery.albums[0].count, 2);

  gallery = await deleteAlbum(album.id);
  assert.deepEqual(gallery.albums, []);
  assert.deepEqual(await files("Covers"), ["a.png"]);
  assert.deepEqual(gallery.photos.map((photo) => photo.path).sort(), ["Covers/a.png", "b.png"]);
  assert.equal(gallery.photos.find((photo) => photo.id === first.id)?.prompt, "red panda");
  // The leftover folder is not turned back into an album on the next scan.
  assert.deepEqual((await getGallery()).albums, []);

  // A new album with the same name gets its own folder.
  const again = await createAlbum("Covers", [second.id]);
  assert.equal(again.album.folder, "Covers 2");
  assert.deepEqual(await files("Covers 2"), ["b.png"]);
}));

test("a photo can be in several albums, and removing it from one moves nothing", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "a.png", await tile(), {});
  const trip = (await createAlbum("Trip", [photo.id])).album;
  const best = (await createAlbum("Best")).album;
  let gallery = await updateAlbumPhotos(best.id, { add: [photo.id] });
  assert.deepEqual(gallery.photos[0].albumIds.sort(), [best.id, trip.id].sort());
  gallery = await updateAlbumPhotos(trip.id, { remove: [photo.id] });
  assert.deepEqual(gallery.photos[0].albumIds, [best.id]);
  assert.equal(gallery.photos[0].path, "Trip/a.png");

  // Renaming an album renames its folder when the name is free.
  gallery = await renameAlbum(trip.id, "Summer trip");
  assert.equal(gallery.photos[0].path, "Summer trip/a.png");
  assert.equal(gallery.albums.find((album) => album.id === trip.id)?.folder, "Summer trip");

  gallery = (await deletePhotos([photo.id])).gallery;
  assert.deepEqual(gallery.photos, []);
  assert.ok(gallery.albums.every((album) => album.count === 0));
}));

test("stars, and changes made on disk are picked up", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "a.png", await tile(), {});
  let gallery = await setPhotosStarred([photo.id], true);
  assert.equal(gallery.photos[0].starred, true);

  // A folder made in Finder becomes an album; files dropped into it join.
  await mkdir(path.join(getGalleryRoot(), "Imported"));
  await writeFile(path.join(getGalleryRoot(), "Imported", "c.png"), await tile("#00aa00"));
  // A photo moved by hand keeps its id and star.
  await rename(path.join(getGalleryRoot(), "a.png"), path.join(getGalleryRoot(), "Imported", "a.png"));
  gallery = await getGallery();
  assert.deepEqual(gallery.albums.map((album) => [album.name, album.count]), [["Imported", 1]]);
  const moved = gallery.photos.find((entry) => entry.id === photo.id);
  assert.equal(moved?.path, "Imported/a.png");
  assert.equal(moved?.starred, true);
  assert.equal(moved?.width, 900);
}));

test("the first index format is migrated: folders become albums and prompts are kept", () => withDataDirectory(async () => {
  await mkdir(path.join(getGalleryRoot(), "Old album"), { recursive: true });
  await writeFile(path.join(getGalleryRoot(), "Old album", "x.png"), await tile());
  await writeFile(path.join(getGalleryRoot(), ".libera-gallery.json"), JSON.stringify({ photos: { "Old album/x.png": { prompt: "kept" } } }));
  const gallery = await getGallery();
  assert.deepEqual(gallery.albums.map((album) => [album.name, album.count]), [["Old album", 1]]);
  assert.equal(gallery.photos[0].prompt, "kept");
}));

test("edits save over the photo with a revertible original, or as a copy", () => withDataDirectory(async () => {
  const photo = await writeGalleryPhoto("", "a.png", await tile("#808080", 400, 200), {});
  const original = await readFile(path.join(getGalleryRoot(), "a.png"));
  const album = (await createAlbum("Kept", [photo.id])).album;

  const edits = parsePhotoEdits({ rotate: 90, crop: { x: 0, y: 0, width: 1, height: 0.5 }, brightness: 40 });
  let result = await editPhoto(photo.id, edits, "replace");
  let edited = result.gallery.photos.find((entry) => entry.id === photo.id)!;
  assert.equal(edited.edited, true);
  assert.deepEqual([edited.width, edited.height], [200, 200]);

  const copy = await editPhoto(photo.id, parsePhotoEdits({ flipH: true }), "copy");
  const copied = copy.gallery.photos.find((entry) => entry.id === copy.id)!;
  assert.equal(copied.path, "Kept/a (edited).png");
  assert.deepEqual(copied.albumIds, [album.id]);

  result = { id: photo.id, gallery: await revertPhoto(photo.id) };
  edited = result.gallery.photos.find((entry) => entry.id === photo.id)!;
  assert.equal(edited.edited, false);
  assert.deepEqual(await readFile(path.join(getGalleryRoot(), "Kept", "a.png")), original);
  await assert.rejects(editPhoto(photo.id, NO_EDITS, "replace"), /no changes/);
}));

test("saved adjustments match the editor preview's math", async () => {
  const adjustments = parsePhotoEdits({ brightness: 30, contrast: -20, saturation: 55, warmth: 40, tint: -25 });
  const color = [180, 90, 40];
  const input = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } }).png().toBuffer();
  const output = await renderEditedPhoto(input, adjustments, "png");
  const { data } = await sharp(output).raw().toBuffer({ resolveWithObject: true });

  // What the SVG filter computes: tone curve, clamp, color matrix, clamp.
  const { slope, intercept } = toneCurve(adjustments);
  const toned = color.map((value) => Math.min(1, Math.max(0, (value / 255) * slope + intercept)));
  const expected = colorMatrix(adjustments).map((row) => Math.round(Math.min(1, Math.max(0, row[0] * toned[0] + row[1] * toned[1] + row[2] * toned[2])) * 255));
  [...data.subarray(0, 3)].forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) <= 2, `channel ${channel}: ${value} vs ${expected[channel]}`));
});

test("crops follow the photo when it is turned or flipped", () => {
  const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  const round = (rect: typeof crop | null) => rect && Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * 1e6) / 1e6]));
  assert.deepEqual(round(rotateCropCounterClockwise(rotateCropClockwise(crop))), crop);
  const turned = rotateCropClockwise(crop)!;
  assert.deepEqual([turned.x, turned.y, turned.width, turned.height].map((value) => Math.round(value * 100) / 100), [0.4, 0.1, 0.4, 0.3]);
  assert.deepEqual(round(flipCrop(flipCrop(crop, "horizontal"), "horizontal")), crop);
});

test("justified rows fill the width and keep the last row at its natural height", () => {
  const rows = justifiedRows([1.5, 1.5, 1, 1, 0.5], 600, 200, 4);
  assert.deepEqual(rows.map((row) => [row.start, row.end]), [[0, 2], [2, 5]]);
  assert.ok(Math.abs(rows[0].height * 3 + 4 - 600) < 0.001);
  assert.equal(rows[1].height, 200);
  assert.equal(photoRatio(100, 1), 3.2);
});

test("thumbnails are small and cached beside the gallery", () => withDataDirectory(async () => {
  await writeGalleryPhoto("", "big.png", await tile(), {});
  const thumbnail = await readGalleryThumbnail("big.png");
  assert.equal(thumbnail.contentType, "image/webp");
  const { width } = await sharp(thumbnail.body).metadata();
  assert.equal(width, 640);
  // Hidden cache folders are never listed as albums.
  assert.deepEqual((await getGallery()).albums, []);
}));

test("settings persist and stale parameters are filtered per model", () => withDataDirectory(async (directory) => {
  const saved = await writeImageGenerationSettings({
    model: "openai/gpt-image-2",
    paramsByModel: { "openai/gpt-image-2": { aspect_ratio: "16:9", quality: "high", bogus: "x" } },
    destination: { kind: "folder", path: "Research/figures/" },
  });
  assert.deepEqual(saved.destination, { kind: "folder", path: "Research/figures" });
  assert.deepEqual(await readImageGenerationSettings(), saved);
  assert.match(await readFile(path.join(directory, ".libera", "image-generation.json"), "utf8"), /gpt-image-2/);

  await writeFile(path.join(directory, ".libera", "image-generation.json"), "{ not json");
  assert.equal((await readImageGenerationSettings()).destination.kind, "gallery");

  const model = { id: "m", name: "M", parameters: { aspect_ratio: { type: "enum" as const, values: ["1:1"] }, n: { type: "range" as const, min: 1, max: 4 } } };
  assert.deepEqual(validParameterValues(model, { aspect_ratio: "16:9", n: 3, quality: "high" }), { n: 3 });
  assert.equal(parseImageGenerationSettings(null).model.length > 0, true);
}));

test("generated file names start with the date and a few prompt words", () => {
  const name = generatedImageName("A red/panda: astronaut floating in deep space, studio lighting", "image/jpeg", 1, new Date(2026, 9, 13, 14, 5, 2));
  assert.equal(name, "2026-10-13 14.05.02 A red panda astronaut floating in (2).jpg");
});

test("reference photos must be image data URLs", () => {
  const photo = "data:image/png;base64,iVBORw0KGgo=";
  assert.deepEqual(parseReferenceImages(undefined), []);
  assert.deepEqual(parseReferenceImages([photo]), [photo]);
  assert.throws(() => parseReferenceImages(["https://example.com/a.png"]), /PNG, JPEG/);
  assert.throws(() => parseReferenceImages(["data:image/svg+xml;base64,PHN2Zz4="]), /PNG, JPEG/);
  assert.throws(() => parseReferenceImages("nope"), /Too many/);
});

test("photos from the computer are added to the gallery or an album, and non-images are refused", () => withDataDirectory(async () => {
  const { importGalleryPhoto } = await import("../../src/lib/storage/gallery");
  const { POST } = await import("../../src/app/api/gallery/photos/upload/route");
  const { NextRequest } = await import("next/server");
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("../../src/lib/auth");

  const loose = await importGalleryPhoto("", "holiday.png", await tile());
  assert.equal(loose.path, "holiday.png");
  const { album } = await createAlbum("Trips");
  const inAlbum = await importGalleryPhoto(album.id, "C:\\Users\\me\\holiday.png", await tile("#20a060"));
  assert.equal(inAlbum.path, "Trips/holiday.png", "a Windows path keeps only the file name");
  const clash = await importGalleryPhoto("", "holiday.png", await tile());
  assert.equal(clash.path, "holiday-1.png", "a name clash never overwrites a photo");
  assert.deepEqual((await getGallery()).albums[0].count, 1);
  await assert.rejects(importGalleryPhoto("", "notes.txt", Buffer.from("hello")), /Only PNG/);
  await assert.rejects(importGalleryPhoto("", "fake.png", Buffer.from("not really a png")), /not a valid image/);
  await assert.rejects(importGalleryPhoto("", "renamed.jpg", await tile()), /not a valid image/, "the extension must match the content");
  await assert.rejects(importGalleryPhoto("missing", "x.png", await tile()), /no longer exists/);
  await importGalleryPhoto("", "logo.svg", Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'));

  const body = new FormData();
  body.set("albumId", album.id);
  body.append("files", new File([new Uint8Array(await tile("#a02060"))], "beach.png", { type: "image/png" }));
  body.append("files", new File(["oops"], "broken.png", { type: "image/png" }));
  const post = (authenticated: boolean) => POST(new NextRequest("http://localhost/api/gallery/photos/upload", {
    method: "POST", body, headers: authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken()}` } : {},
  }));
  assert.equal((await post(false)).status, 401);
  const response = await post(true);
  assert.equal(response.status, 200);
  const result = await response.json() as { added: string[]; failed: Array<{ name: string; error: string }>; gallery: { photos: Array<{ id: string; path: string; albumIds: string[] }> } };
  assert.equal(result.added.length, 1, "one bad file does not stop the others");
  assert.deepEqual(result.failed.map((item) => item.name), ["broken.png"]);
  const beach = result.gallery.photos.find((photo) => photo.id === result.added[0])!;
  assert.equal(beach.path, "Trips/beach.png");
  assert.deepEqual(beach.albumIds, [album.id]);
  assert.deepEqual(await files("Trips"), ["beach.png", "holiday.png"]);
}));
