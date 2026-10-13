/**
 * Convert a folder of Hald CLUT PNGs (such as the RawTherapee Film Simulation
 * Collection) into 1D LUT photo filters: per-channel input curves, a 3×3
 * channel mix, then per-channel output curves, fitted to each 3D CLUT by
 * alternating least squares. Muted colors, which most photos are made of,
 * weigh more in the fit than fully saturated ones.
 *
 *   node --import tsx scripts/convert-haldclut.ts <HaldCLUT folder> src/lib/photo-film-looks.ts
 */
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/** Knots per curve. */
const KNOTS = 33;
/** Samples per axis of the CLUT used for fitting. */
const GRID = 33;
const ITERATIONS = 15;
const SMOOTHING = 2;
const RIDGE = 1e-6;
const OUTPUT_RIDGE = 1e-4;
/** Colors with this much chroma (max − min channel) weigh about a third as much as grays. */
const CHROMA_FALLOFF = 0.35;

type Samples = { input: Float64Array; output: Float64Array; weight: Float64Array; count: number };
type Curves = [Float64Array, Float64Array, Float64Array];

async function readClut(file: string): Promise<Samples> {
  const { data, info } = await sharp(file).removeAlpha().toColourspace("srgb").raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  const level = Math.round(Math.cbrt(info.width));
  if (level ** 3 !== info.width || info.width !== info.height) throw new Error(`${file} is not a Hald CLUT`);
  const size = level * level;
  const count = GRID ** 3;
  const input = new Float64Array(count * 3);
  const output = new Float64Array(count * 3);
  const weight = new Float64Array(count);
  let sample = 0;
  for (let b = 0; b < GRID; b += 1) {
    for (let g = 0; g < GRID; g += 1) {
      for (let r = 0; r < GRID; r += 1) {
        const index = [r, g, b].map((value) => Math.round((value * (size - 1)) / (GRID - 1)));
        const pixel = (index[0] + index[1] * size + index[2] * size * size) * info.channels;
        for (let channel = 0; channel < 3; channel += 1) {
          input[sample * 3 + channel] = index[channel] / (size - 1);
          output[sample * 3 + channel] = data[pixel + channel] / 255;
        }
        const chroma = (Math.max(...index) - Math.min(...index)) / (size - 1);
        weight[sample] = Math.exp(-((chroma / CHROMA_FALLOFF) ** 2)) + 0.05;
        sample += 1;
      }
    }
  }
  return { input, output, weight, count };
}

/** Piecewise-linear knot weights for a value, clamped to 0–1 as the filter does. */
function knotWeights(value: number): [number, number, number] {
  const position = Math.min(1, Math.max(0, value)) * (KNOTS - 1);
  const index = Math.min(KNOTS - 2, Math.floor(position));
  const fraction = position - index;
  return [index, 1 - fraction, fraction];
}

function curveAt(curve: Float64Array, value: number) {
  const [index, w0, w1] = knotWeights(value);
  return curve[index] * w0 + curve[index + 1] * w1;
}

/** The input that brings a curve closest to `value`. */
function inverseAt(curve: Float64Array, value: number) {
  let best = 0;
  let distance = Infinity;
  for (let step = 0; step <= 256; step += 1) {
    const difference = Math.abs(curveAt(curve, step / 256) - value);
    if (difference < distance) { distance = difference; best = step / 256; }
  }
  return best;
}

/** Solve a small linear system (Gaussian elimination with partial pivoting). */
function solve(matrix: Float64Array, vector: Float64Array, size: number) {
  const a = Float64Array.from(matrix);
  const b = Float64Array.from(vector);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(a[row * size + column]) > Math.abs(a[pivot * size + column])) pivot = row;
    if (pivot !== column) {
      for (let k = 0; k < size; k += 1) [a[column * size + k], a[pivot * size + k]] = [a[pivot * size + k], a[column * size + k]];
      [b[column], b[pivot]] = [b[pivot], b[column]];
    }
    for (let row = column + 1; row < size; row += 1) {
      const factor = a[row * size + column] / a[column * size + column];
      if (!factor) continue;
      for (let k = column; k < size; k += 1) a[row * size + k] -= factor * a[column * size + k];
      b[row] -= factor * b[column];
    }
  }
  const result = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = b[row];
    for (let k = row + 1; k < size; k += 1) value -= a[row * size + k] * result[k];
    result[row] = value / a[row * size + row];
  }
  return result;
}

/** Penalize bends in the curve whose knots start at `offset`. */
function addSmoothing(normal: Float64Array, size: number, offset: number, weight: number) {
  for (let knot = 1; knot < KNOTS - 1; knot += 1) {
    const indexes = [knot - 1, knot, knot + 1].map((value) => offset + value);
    const coefficients = [1, -2, 1];
    for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) normal[indexes[a] * size + indexes[b]] += weight * coefficients[a] * coefficients[b];
  }
}

/** output ≈ outputCurves(mix · inputCurves(input)). */
function fit(samples: Samples) {
  const { input, output, weight, count } = samples;
  const totalWeight = weight.reduce((sum, value) => sum + value, 0);
  // Start from the response along the gray axis.
  const inputCurves = [0, 1, 2].map((channel) => Float64Array.from({ length: KNOTS }, (_, knot) => {
    const at = Math.round((knot / (KNOTS - 1)) * (GRID - 1));
    return output[(at + at * GRID + at * GRID * GRID) * 3 + channel];
  })) as Curves;
  const mix = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const outputCurves = [0, 1, 2].map(() => Float64Array.from({ length: KNOTS }, (_, knot) => knot / (KNOTS - 1))) as Curves;
  const unknowns = 3 * KNOTS;
  const shaped = new Float64Array(count * 3);
  const target = new Float64Array(count * 3);

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    // What the mix should produce, given the output curves. The CLUT holds 8-bit values.
    const inverses = outputCurves.map((curve) => Float64Array.from({ length: 256 }, (_, level) => inverseAt(curve, level / 255)));
    for (let index = 0; index < count * 3; index += 1) target[index] = inverses[index % 3][Math.round(output[index] * 255)];

    // Input curves, given the mix.
    const normal = new Float64Array(unknowns * unknowns);
    const right = new Float64Array(unknowns);
    const columns = new Int32Array(6);
    const values = new Float64Array(6);
    for (let sample = 0; sample < count; sample += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const [index, w0, w1] = knotWeights(input[sample * 3 + channel]);
        columns[channel * 2] = channel * KNOTS + index;
        columns[channel * 2 + 1] = channel * KNOTS + index + 1;
        values[channel * 2] = w0;
        values[channel * 2 + 1] = w1;
      }
      for (let out = 0; out < 3; out += 1) {
        for (let a = 0; a < 6; a += 1) {
          const va = weight[sample] * mix[out * 3 + (a >> 1)] * values[a];
          if (!va) continue;
          right[columns[a]] += va * target[sample * 3 + out];
          for (let b = 0; b < 6; b += 1) normal[columns[a] * unknowns + columns[b]] += va * mix[out * 3 + (b >> 1)] * values[b];
        }
      }
    }
    for (let channel = 0; channel < 3; channel += 1) addSmoothing(normal, unknowns, channel * KNOTS, (SMOOTHING * totalWeight) / KNOTS);
    for (let index = 0; index < unknowns; index += 1) normal[index * unknowns + index] += RIDGE * totalWeight;
    const knots = solve(normal, right, unknowns);
    for (let channel = 0; channel < 3; channel += 1) inputCurves[channel].set(knots.subarray(channel * KNOTS, (channel + 1) * KNOTS));

    // Mix, given the input curves.
    for (let sample = 0; sample < count; sample += 1) {
      for (let channel = 0; channel < 3; channel += 1) shaped[sample * 3 + channel] = curveAt(inputCurves[channel], input[sample * 3 + channel]);
    }
    for (let out = 0; out < 3; out += 1) {
      const small = new Float64Array(9);
      const vector = new Float64Array(3);
      for (let sample = 0; sample < count; sample += 1) {
        for (let a = 0; a < 3; a += 1) {
          vector[a] += weight[sample] * shaped[sample * 3 + a] * target[sample * 3 + out];
          for (let b = 0; b < 3; b += 1) small[a * 3 + b] += weight[sample] * shaped[sample * 3 + a] * shaped[sample * 3 + b];
        }
      }
      for (let a = 0; a < 3; a += 1) small[a * 4] += RIDGE * totalWeight;
      mix.set(solve(small, vector, 3), out * 3);
    }

    // Output curves, given everything before them.
    for (let out = 0; out < 3; out += 1) {
      const normal = new Float64Array(KNOTS * KNOTS);
      const right = new Float64Array(KNOTS);
      for (let sample = 0; sample < count; sample += 1) {
        const mixed = mix[out * 3] * shaped[sample * 3] + mix[out * 3 + 1] * shaped[sample * 3 + 1] + mix[out * 3 + 2] * shaped[sample * 3 + 2];
        const [index, w0, w1] = knotWeights(mixed);
        const w = weight[sample];
        const value = output[sample * 3 + out];
        right[index] += w * w0 * value;
        right[index + 1] += w * w1 * value;
        normal[index * KNOTS + index] += w * w0 * w0;
        normal[index * KNOTS + index + 1] += w * w0 * w1;
        normal[(index + 1) * KNOTS + index] += w * w0 * w1;
        normal[(index + 1) * KNOTS + index + 1] += w * w1 * w1;
      }
      addSmoothing(normal, KNOTS, 0, (SMOOTHING * totalWeight) / KNOTS);
      for (let index = 0; index < KNOTS; index += 1) normal[index * KNOTS + index] += OUTPUT_RIDGE * totalWeight;
      outputCurves[out] = solve(normal, right, KNOTS);
    }
  }
  return { inputCurves, mix, outputCurves };
}

/** Mean error over muted colors and over all colors, and the worst error, in 0–255 units. */
function fitError(samples: Samples, { inputCurves, mix, outputCurves }: ReturnType<typeof fit>) {
  let total = 0;
  let muted = 0;
  let mutedCount = 0;
  let worst = 0;
  for (let sample = 0; sample < samples.count; sample += 1) {
    const rgb = [0, 1, 2].map((channel) => samples.input[sample * 3 + channel]);
    const shaped = rgb.map((value, channel) => curveAt(inputCurves[channel], value));
    let error = 0;
    for (let out = 0; out < 3; out += 1) {
      const mixed = mix[out * 3] * shaped[0] + mix[out * 3 + 1] * shaped[1] + mix[out * 3 + 2] * shaped[2];
      const value = Math.min(1, Math.max(0, curveAt(outputCurves[out], mixed)));
      error += (Math.abs(value - samples.output[sample * 3 + out]) * 255) / 3;
    }
    total += error;
    worst = Math.max(worst, error);
    if (Math.max(...rgb) - Math.min(...rgb) < CHROMA_FALLOFF) { muted += error; mutedCount += 1; }
  }
  return { mean: total / samples.count, muted: muted / mutedCount, worst };
}

/** "Kodak Portra 160 NC 1 -" → "Kodak Portra 160 NC −1"; "BleachBypass2" → "Bleach Bypass 2". */
function lookLabel(name: string) {
  // Creative looks are CamelCase with a variant number that stays.
  if (!name.includes(" ")) return name.replace(/([a-z])([A-Z\d])/g, "$1 $2");
  return name
    .replace(/ \d( ([-+]+))?( Alt)?$/, (_, _signs, signs: string | undefined, alt: string | undefined) =>
      `${signs ? ` ${signs[0] === "+" ? "+" : "−"}${signs.length}` : ""}${alt ?? ""}`)
    .trim();
}

function lookGroup(relative: string) {
  const [category, brand] = relative.split(path.sep);
  if (brand === undefined || brand === "CreativePack-1") return "Creative";
  return `${category === "Black-and-White" ? "B&W film" : "Color film"} · ${brand}`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/\+/g, "plus").replace(/&/g, "").replace(/[^a-z\d]+/g, "-").replace(/^-|-$/g, "");
}

async function listPngs(folder: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(folder, relative), { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) return listPngs(folder, next);
    return entry.name.toLowerCase().endsWith(".png") ? [next] : [];
  }));
  return files.flat();
}

const round = (value: number) => Math.round(value * 10000);

async function main() {
  const [folder, outputFile] = process.argv.slice(2);
  if (!folder || !outputFile) throw new Error("Usage: convert-haldclut.ts <HaldCLUT folder> <output .ts file>");
  const files = (await listPngs(folder)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const lines: string[] = [];
  const errors: number[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    const group = lookGroup(path.dirname(file) === "." ? name : file);
    const label = lookLabel(name);
    const id = `film-${slug(`${group.startsWith("B&W") ? "bw " : ""}${name}`)}`;
    if (ids.has(id)) throw new Error(`Duplicate id ${id}`);
    ids.add(id);
    const samples = await readClut(path.join(folder, file));
    const result = fit(samples);
    const error = fitError(samples, result);
    errors.push(error.muted);
    console.log(`${error.muted.toFixed(2).padStart(6)} ${error.mean.toFixed(2).padStart(6)} ${error.worst.toFixed(1).padStart(6)}  ${group} / ${label}`);
    const values = [...result.inputCurves.flatMap((curve) => [...curve]), ...result.mix, ...result.outputCurves.flatMap((curve) => [...curve])].map(round);
    lines.push(`  look(${JSON.stringify(id)}, ${JSON.stringify(label)}, ${JSON.stringify(group)}, [${values.join(",")}]),`);
  }
  const sorted = [...errors].sort((a, b) => a - b);
  console.log(`\n${files.length} looks. Mean error on muted colors: average ${(errors.reduce((sum, value) => sum + value, 0) / errors.length).toFixed(2)}, median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}, worst ${sorted[sorted.length - 1].toFixed(2)} (0–255)`);

  await writeFile(outputFile, `/*!
 * Film looks fitted from the RawTherapee Film Simulation Collection (version 2015-09-20),
 * https://rawpedia.rawtherapee.com/Film_Simulation, by Pat David, Pavlov Dmitry and
 * Michael Ezra. Licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/).
 *
 * Changed from the original: each 3D Hald CLUT is approximated by per-channel curves,
 * a 3×3 channel mix and per-channel output curves. This file is therefore also licensed
 * under CC BY-SA 4.0.
 *
 * Film stock names are trademarks of their owners, used only to say which film a look
 * approximates. Neither the authors nor Libera are affiliated with or endorsed by them.
 *
 * Generated by scripts/convert-haldclut.ts. Do not edit by hand.
 */
import type { PhotoFilter } from "./photo-filters";

const KNOTS = ${KNOTS};

/** \`values\` holds three input curves of KNOTS points, a row-major 3×3 mix, then three output curves, all × 10000. */
function look(id: string, label: string, group: string, values: number[]): PhotoFilter {
  const scaled = values.map((value) => value / 10000);
  const curves = (offset: number) => [0, 1, 2].map((channel) => scaled.slice(offset + channel * KNOTS, offset + (channel + 1) * KNOTS)) as [number[], number[], number[]];
  return { id, label, group, steps: [{ type: "lut", curves: curves(0), mix: scaled.slice(3 * KNOTS, 3 * KNOTS + 9), outputCurves: curves(3 * KNOTS + 9) }] };
}

export const FILM_LOOKS: PhotoFilter[] = [
${lines.join("\n")}
];
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
