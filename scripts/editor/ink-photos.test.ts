import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { insidePolygon } from "../../src/components/libera/ink/ink-surface";
import { inkCanvasRatio } from "../../src/components/libera/ink/ink-renderer";
import { encodeInkSamples, sampleBounds, strokeSamples } from "../../src/lib/ink/codec";
import { originalToView } from "../../src/lib/ink/frame";
import type { InkSample, InkStroke } from "../../src/lib/ink/types";
import { NO_EDITS, type PhotoEdits } from "../../src/lib/photo-edits";
import { saveEditedImageCopy } from "../../src/lib/storage/files";
import {
  archivePhotos,
  deletePhotos,
  editPhoto,
  exportGalleryPhotoWithInk,
  flattenGalleryPhotoInk,
  getGalleryRoot,
  readGalleryPhotoInk,
  resolveGalleryPhotoInk,
  restoreArchivedPhotos,
  revertPhoto,
  writeGalleryPhoto,
  writeGalleryPhotoInk,
} from "../../src/lib/storage/gallery";
import { readInk, resetInkStorageForTests, withInkLock, writeInk } from "../../src/lib/storage/ink";
import { createNotebook } from "../../src/lib/storage/notebooks";
import { filePathFromParts } from "../../src/lib/storage/paths";

async function withLibrary(run: () => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "libera-ink-photos-"));
  const previous = { data: process.env.LIBERA_DATA_DIR, config: process.env.LIBERA_CONFIG_PATH };
  process.env.LIBERA_DATA_DIR = path.join(directory, "master");
  process.env.LIBERA_CONFIG_PATH = path.join(directory, "user-data", "config.json");
  resetInkStorageForTests();
  try { await run(); }
  finally {
    for (const [key, value] of [["LIBERA_DATA_DIR", previous.data], ["LIBERA_CONFIG_PATH", previous.config]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetInkStorageForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

/** A plain white photo, `width` × `height`. */
const photo = (width = 400, height = 300) => sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).png().toBuffer();

let counter = 0;
function stroke(samples: InkSample[], overrides: Partial<InkStroke> = {}): InkStroke {
  counter += 1;
  return {
    id: `p${counter}x`,
    brush: "marker",
    color: "#1f2328",
    opacity: 1,
    width: 12,
    lineStyle: "solid",
    points: encodeInkSamples(samples),
    bounds: sampleBounds(samples),
    createdAt: new Date(1_700_000_000_000 + counter).toISOString(),
    ...overrides,
  };
}

/** A short horizontal line around (x, y) on the original photo. */
const dash = (x: number, y: number) => stroke([{ x: x - 10, y, pressure: 0.5 }, { x: x + 10, y, pressure: 0.5 }]);

const edits = (patch: Partial<PhotoEdits>): PhotoEdits => ({ ...NO_EDITS, ...patch });

async function pixel(body: Buffer, x: number, y: number) {
  const { data, info } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.round(y) * info.width + Math.round(x)) * info.channels;
  return data[offset];
}

// ---- Gallery photos -----------------------------------------------------------------

test("gallery ink follows a photo through edits in place and a revert", () => withLibrary(async () => {
  const { id } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  const mark = dash(100, 60);
  const first = await writeGalleryPhotoInk(id, { add: [mark] });
  assert.deepEqual(first.photo.original, { width: 400, height: 300 });
  assert.deepEqual(first.photo.viewSize, { width: 400, height: 300 });
  assert.equal(first.photo.changed, false);

  // A quarter turn and a crop are baked into the file; the strokes stay put on the original.
  const turn = edits({ rotate: 90, crop: { x: 0, y: 0.1, width: 1, height: 0.8 } });
  await editPhoto(id, turn, "replace");
  const edited = await readGalleryPhotoInk(id);
  assert.deepEqual(edited.chunks[0].strokes.map((item) => item.stroke.id), [mark.id]);
  assert.equal(edited.chunks[0].strokes[0].stroke.points, mark.points, "the strokes are not rewritten");
  assert.deepEqual(edited.photo.viewSize, { width: 300, height: 320 });
  assert.equal(edited.photo.view.rotate, 90);
  assert.equal(edited.photo.changed, false);

  // A new stroke on the edited photo lands back on the original's coordinates (the client maps it).
  const back = await revertPhoto(id);
  assert.ok(back);
  const reverted = await readGalleryPhotoInk(id);
  assert.equal(reverted.photo.view.rotate, 0);
  assert.equal(reverted.photo.view.crop, null);
  assert.deepEqual(reverted.photo.viewSize, { width: 400, height: 300 });
}));

test("an edited copy takes the photo's ink with the edit composed into its view", () => withLibrary(async () => {
  const { id } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  await writeGalleryPhotoInk(id, { add: [dash(100, 60)] });
  const copy = await editPhoto(id, edits({ flipH: true }), "copy");
  assert.notEqual(copy.id, id);
  const ink = await readGalleryPhotoInk(copy.id);
  assert.equal(ink.chunks[0].strokes.length, 1);
  assert.equal(ink.photo.view.flipH, true);
  const original = await readGalleryPhotoInk(id);
  assert.equal(original.photo.view.flipH, false, "the original keeps its own view");
}));

test("reverting a photo first inked after an edit requires keeping or discarding its ink", () => withLibrary(async () => {
  const { id } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  await editPhoto(id, edits({ rotate: 90 }), "replace");
  await writeGalleryPhotoInk(id, { add: [dash(100, 60)] });
  await revertPhoto(id);
  assert.equal((await readGalleryPhotoInk(id)).photo.changed, true);
  assert.equal((await resolveGalleryPhotoInk(id, "keep")).photo.changed, false);
}));

test("an edited copy keeps its own original ink view after another edit and revert", () => withLibrary(async () => {
  const { id } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  await writeGalleryPhotoInk(id, { add: [dash(100, 60)] });
  const copy = await editPhoto(id, edits({ rotate: 90 }), "copy");
  await editPhoto(copy.id, edits({ flipH: true }), "replace");
  await revertPhoto(copy.id);
  const exported = await exportGalleryPhotoWithInk(copy.id);
  assert.ok(await pixel(exported.body, 240, 100) < 80, "ink stays aligned with the copy's original quarter turn");
  assert.equal((await readGalleryPhotoInk(copy.id)).photo.view.rotate, 90);
}));

test("Save with ink draws the ink where it was drawn, over the edited photo", () => withLibrary(async () => {
  const { id } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  await writeGalleryPhotoInk(id, { add: [dash(100, 60)] });
  await editPhoto(id, edits({ rotate: 90 }), "replace");
  const exported = await exportGalleryPhotoWithInk(id);
  assert.match(exported.name, /beach \(with ink\)\.png$/);
  const metadata = await sharp(exported.body).metadata();
  assert.deepEqual([metadata.width, metadata.height], [300, 400]);
  // (100, 60) on the original is at (300 − 60, 100) after a clockwise quarter turn.
  const at = originalToView({ x: 100, y: 60 }, { width: 400, height: 300 }, { rotate: 90, flipH: false, flipV: false, crop: null });
  assert.deepEqual([Math.round(at.x), Math.round(at.y)], [240, 100]);
  assert.ok(await pixel(exported.body, at.x, at.y) < 80, "ink under the mark");
  assert.ok(await pixel(exported.body, 20, 380) > 240, "paper elsewhere");
}));

test("Flatten draws the ink into the photo as a revertable edit and clears the layer", () => withLibrary(async () => {
  const { id, path: photoPath } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  await writeGalleryPhotoInk(id, { add: [dash(100, 60)] });
  await flattenGalleryPhotoInk(id);
  const file = await readFile(path.join(getGalleryRoot(), photoPath));
  assert.ok(await pixel(file, 100, 60) < 80);
  assert.equal((await readGalleryPhotoInk(id)).chunks[0].strokes.length, 0);
  await revertPhoto(id);
  assert.ok(await pixel(await readFile(path.join(getGalleryRoot(), photoPath)), 100, 60) > 240, "Revert brings back the photo without ink");
}));

test("a photo changed outside Libera dims its ink until it is kept or discarded", () => withLibrary(async () => {
  const { id, path: photoPath } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  await writeGalleryPhotoInk(id, { add: [dash(100, 60)] });
  await writeFile(path.join(getGalleryRoot(), photoPath), await sharp({ create: { width: 400, height: 300, channels: 3, background: "#eeeeee" } }).png().toBuffer());
  assert.equal((await readGalleryPhotoInk(id)).photo.changed, true);
  assert.equal((await resolveGalleryPhotoInk(id, "keep")).photo.changed, false);

  await writeFile(path.join(getGalleryRoot(), photoPath), await photo());
  const discarded = await resolveGalleryPhotoInk(id, "discard");
  assert.equal(discarded.chunks[0].strokes.length, 0);
}));

test("gallery ink goes to the Protected Archive and back with its photo, and is deleted with it", () => withLibrary(async () => {
  const { id } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  await writeGalleryPhotoInk(id, { add: [dash(100, 60)] });
  const inkFolder = path.join(getGalleryRoot(), ".libera-ink", id);
  assert.ok(existsSync(inkFolder));
  await archivePhotos([id]);
  assert.ok(!existsSync(inkFolder));
  await assert.rejects(readGalleryPhotoInk(id), /not found/, "archived ink stays behind the archive's lock");
  await restoreArchivedPhotos([id]);
  assert.equal((await readGalleryPhotoInk(id)).chunks[0].strokes.length, 1);
  await deletePhotos([id]);
  assert.ok(!existsSync(inkFolder));
}));

test("an ink save in flight cannot recreate gallery ink after its photo is archived", () => withLibrary(async () => {
  const { id } = await writeGalleryPhoto("", "beach.png", await photo(), {});
  const initial = await writeGalleryPhotoInk(id, { add: [dash(100, 60)] });
  const folder = path.join(getGalleryRoot(), ".libera-ink", id);
  const target = path.join(folder, `photo.${initial.author}.ink`);
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => { acquired = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const lock = withInkLock(target, async () => { acquired(); await hold; });
  await ready;
  let started!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const mark = dash(200, 80);
  const saving = writeGalleryPhotoInk(id, { get add() { started(); return [mark]; } });
  await starting;
  const archiving = archivePhotos([id]);
  try {
    // Before the fix archive completes while the save is waiting on its author file.
    await Promise.race([archiving, new Promise((resolve) => setTimeout(resolve, 100))]);
  } finally {
    release();
  }
  await Promise.all([lock, saving, archiving]);
  assert.equal(existsSync(folder), false, "all ink is behind the archive's lock");
  await restoreArchivedPhotos([id]);
  assert.equal((await readGalleryPhotoInk(id)).chunks[0].strokes.length, 2);
}));

// ---- Notebook images --------------------------------------------------------------------

test("an edited copy of a notebook image keeps its ink, moved with the edit", () => withLibrary(async () => {
  await createNotebook("Notes");
  const target = filePathFromParts("Notes", ["map.png"]);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await photo());
  const mark = dash(100, 60);
  await writeInk("Notes/map.png", "image", { add: [mark] }, { unit: "px", width: 400, height: 300 });
  const result = await saveEditedImageCopy("Notes/map.png", edits({ rotate: 90, crop: { x: 0, y: 0.1, width: 1, height: 0.8 } }));
  const copy = await readInk(result.file.path, ["image"]);
  const [moved] = copy.chunks[0].strokes;
  assert.ok(moved);
  assert.deepEqual(copy.chunks[0].frame, { unit: "px", width: 300, height: 320 });
  const expected = originalToView({ x: 90, y: 60 }, { width: 400, height: 300 }, { rotate: 90, flipH: false, flipV: false, crop: { x: 0, y: 0.1, width: 1, height: 0.8 } });
  const first = strokeSamples(moved.stroke)[0];
  assert.ok(Math.hypot(first.x - expected.x, first.y - expected.y) < 0.1, JSON.stringify({ first, expected }));
  assert.equal((await readInk("Notes/map.png", ["image"])).chunks[0].strokes[0].stroke.id, mark.id, "the original keeps its ink");
}));

// ---- Lasso and rendering ------------------------------------------------------------------

test("the lasso's polygon test and the canvas resolution rules", () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(insidePolygon({ x: 5, y: 5 }, square), true);
  assert.equal(insidePolygon({ x: 15, y: 5 }, square), false);
  const concave = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 4 }, { x: 0, y: 10 }];
  assert.equal(insidePolygon({ x: 5, y: 8 }, concave), false);

  assert.equal(inkCanvasRatio(800, 600, 3), 2, "capped at 2 device pixels");
  assert.equal(inkCanvasRatio(800, 600, 3, 1, true), 1.5, "1.5 on battery");
  assert.equal(inkCanvasRatio(400, 300, 2, 3), 6, "a zoomed photo's ink stays sharp");
  assert.ok(inkCanvasRatio(4000, 4000, 2, 4) <= 1, "within the 16-megapixel budget");
});
