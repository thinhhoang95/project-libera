import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { hasEdits, NO_EDITS, parsePhotoEdits } from "../../src/lib/photo-edits";
import { renderEditedPhoto } from "../../src/lib/photo-edits-server";
import { FILM_LOOKS } from "../../src/lib/photo-film-looks";
import {
  applyPhotoFilter, cssFill, cssFilterSteps, findPhotoFilter, INSTAGRAM_FILTERS, loadPhotoFilters, mixFilteredPixels, type PhotoFilter,
} from "../../src/lib/photo-filters";

function filterPixel(filter: PhotoFilter, rgb: number[]) {
  const output = new Uint8Array(3);
  applyPhotoFilter(rgb, output, 1, 1, 3, filter);
  return [...output];
}

const cssFilter = (css: string): PhotoFilter => ({ id: "test", label: "Test", group: "Test", steps: cssFilterSteps(css) });

test("CSS filter functions follow the Filter Effects definitions, clamped after each one", () => {
  assert.deepEqual(filterPixel(cssFilter("brightness(1.5)"), [100, 0, 255]), [150, 0, 255]);
  assert.deepEqual(filterPixel(cssFilter("contrast(1.5)"), [51, 128, 204]), [13, 128, 242]);
  assert.deepEqual(filterPixel(cssFilter("sepia(1)"), [255, 255, 255]), [255, 255, 239]);
  assert.deepEqual(filterPixel(cssFilter("grayscale(1)"), [255, 0, 0]), [54, 54, 54]);
  assert.deepEqual(filterPixel(cssFilter("hue-rotate(0deg) saturate(1)"), [12, 34, 56]), [12, 34, 56]);
  // Brightening first clips the highlight, so contrast cannot bring it back.
  assert.deepEqual(filterPixel(cssFilter("brightness(2) contrast(.5)"), [200, 200, 200]), [191, 191, 191]);
});

test("instagram.css overlays blend before the filter chain, and gradients reach the corners", () => {
  assert.equal(INSTAGRAM_FILTERS.length, 41);
  assert.equal(new Set(INSTAGRAM_FILTERS.map((filter) => filter.id)).size, 41);
  assert.deepEqual(cssFill("rgba(125, 105, 24, .1)"), { type: "solid", color: [125 / 255, 105 / 255, 24 / 255, 0.1] });
  const hudson = cssFill("radial-gradient(circle closest-corner, transparent 25%, rgba(25, 62, 167, .25) 100%)");
  assert.equal(hudson.type, "radial");
  assert.deepEqual(hudson.type === "radial" && hudson.stops.map((stop) => stop.offset), [0.25, 1]);

  const multiply: PhotoFilter = { id: "m", label: "M", group: "T", steps: [{ type: "blend", mode: "multiply", fill: cssFill("rgba(0, 0, 0, .5)") }] };
  assert.deepEqual(filterPixel(multiply, [200, 100, 50]), [100, 50, 25]);

  // Hefe darkens toward the corners: compare the center and a corner of a flat photo.
  const hefe = INSTAGRAM_FILTERS.find((filter) => filter.id === "ig-hefe")!;
  const size = 41;
  const flat = new Uint8Array(size * size * 3).fill(128);
  const output = new Uint8Array(flat.length);
  applyPhotoFilter(flat, output, size, size, 3, hefe);
  const center = (20 * size + 20) * 3;
  assert.ok(output[center] > output[0] + 10, `center ${output[center]} vs corner ${output[0]}`);
});

test("film looks are 1D LUTs with unique ids, loaded with the rest", async () => {
  assert.equal(FILM_LOOKS.length, 294);
  const all = await loadPhotoFilters();
  assert.equal(new Set(all.map((filter) => filter.id)).size, all.length);
  for (const look of FILM_LOOKS) {
    const [step] = look.steps;
    assert.equal(step.type, "lut");
    assert.ok(step.type === "lut" && step.curves.every((curve) => curve.length === 33) && step.mix?.length === 9 && step.outputCurves?.length === 3);
  }
  const mono = await findPhotoFilter("film-bw-ilford-hp5-plus-400");
  assert.ok(mono);
  const [r, g, b] = filterPixel(mono, [200, 60, 30]);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, `black and white gives grays, got ${[r, g, b]}`);
  assert.equal(await findPhotoFilter("film-nope"), null);
});

test("filter choices are parsed with the other edits", () => {
  assert.deepEqual(parsePhotoEdits({}), NO_EDITS);
  const edits = parsePhotoEdits({ filter: "ig-clarendon", filterStrength: 140.4 });
  assert.equal(edits.filter, "ig-clarendon");
  assert.equal(edits.filterStrength, 100);
  assert.equal(parsePhotoEdits({ filter: "../etc", filterStrength: -5 }).filter, null);
  assert.equal(parsePhotoEdits({ filter: "ig-lark", filterStrength: -5 }).filterStrength, 0);
  assert.equal(hasEdits(parsePhotoEdits({ filter: "ig-lark" })), true);
  assert.equal(hasEdits(parsePhotoEdits({ filter: "ig-lark", filterStrength: 0 })), false);
});

test("saved photos run the same filter code as the editor", async () => {
  const width = 24;
  const height = 16;
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 37) % 256;
  const photo = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();

  for (const id of ["ig-xpro-ii", "film-kodak-portra-400-2"]) {
    const filter = (await findPhotoFilter(id))!;
    const expected = Buffer.alloc(pixels.length);
    applyPhotoFilter(pixels, expected, width, height, 3, filter);
    mixFilteredPixels(pixels, Buffer.from(expected), expected, 3, 0.6);
    const saved = await renderEditedPhoto(photo, parsePhotoEdits({ filter: id, filterStrength: 60 }), "png");
    const { data } = await sharp(saved).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data], [...expected], id);
  }

  await assert.rejects(renderEditedPhoto(photo, parsePhotoEdits({ filter: "film-missing" }), "png"), /not available/);
});
