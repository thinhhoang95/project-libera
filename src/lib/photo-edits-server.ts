import sharp, { type Sharp } from "sharp";
import {
  colorMatrix,
  cropPixels,
  toneCurve,
  VIGNETTE_START,
  vignetteOpacity,
  type PhotoEdits,
} from "./photo-edits";

export type EditedPhotoFormat = "png" | "jpeg" | "webp";

type RawImage = { data: Buffer; info: { width: number; height: number; channels: 1 | 2 | 3 | 4 } };

/**
 * Render edits in the editor's order. Each step is its own sharp pass: within
 * one pipeline sharp reorders operations (it recombines before `linear`), and
 * clamping between steps matches the browser's SVG filter.
 */
export async function renderEditedPhoto(input: string | Buffer, edits: PhotoEdits, format: EditedPhotoFormat) {
  let image: RawImage = await sharp(input, { animated: false })
    .rotate()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true }) as RawImage;

  async function pass(build: (pipeline: Sharp) => Sharp) {
    image = await build(sharp(image.data, { raw: image.info })).raw().toBuffer({ resolveWithObject: true }) as RawImage;
  }

  if (image.info.channels < 3) await pass((pipeline) => pipeline.toColourspace("srgb"));
  const channels = image.info.channels;
  const hasAlpha = channels === 4;

  if (edits.rotate) await pass((pipeline) => pipeline.rotate(edits.rotate));
  if (edits.flipH || edits.flipV) await pass((pipeline) => pipeline.flip(edits.flipV).flop(edits.flipH));
  if (edits.crop) {
    const region = cropPixels(edits.crop, image.info.width, image.info.height);
    await pass((pipeline) => pipeline.extract(region));
  }

  const { slope, intercept } = toneCurve(edits);
  if (slope !== 1 || intercept !== 0) {
    const multipliers = Array.from({ length: channels }, (_, index) => (hasAlpha && index === 3 ? 1 : slope));
    const offsets = Array.from({ length: channels }, (_, index) => (hasAlpha && index === 3 ? 0 : intercept * 255));
    await pass((pipeline) => pipeline.linear(multipliers, offsets));
  }

  if (edits.saturation || edits.warmth || edits.tint) {
    const matrix = colorMatrix(edits);
    const recomb = hasAlpha
      ? [...matrix.map((row) => [...row, 0]), [0, 0, 0, 1]] as [[number, number, number, number], [number, number, number, number], [number, number, number, number], [number, number, number, number]]
      : matrix as [[number, number, number], [number, number, number], [number, number, number]];
    await pass((pipeline) => pipeline.recomb(recomb));
  }

  const opacity = vignetteOpacity(edits);
  if (opacity > 0) {
    const { width, height } = image.info;
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs><radialGradient id="v" cx="0.5" cy="0.5" r="0.7071" gradientUnits="objectBoundingBox">
        <stop offset="${VIGNETTE_START}" stop-color="#000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000" stop-opacity="${opacity.toFixed(3)}"/>
      </radialGradient></defs>
      <rect width="100%" height="100%" fill="url(#v)"/>
    </svg>`);
    // "atop" keeps transparent areas transparent.
    await pass((pipeline) => pipeline.composite([{ input: overlay, blend: hasAlpha ? "atop" : "over" }]));
  }

  const output = sharp(image.data, { raw: image.info });
  if (format === "jpeg") return output.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  if (format === "webp") return output.webp({ quality: 92 }).toBuffer();
  return output.png().toBuffer();
}
