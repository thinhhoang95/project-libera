/**
 * Photo filters: named color looks applied before the editor's adjustments.
 *
 * A filter is a list of steps run on 0–1 sRGB values, clamped after each step.
 * The same code runs in the editor (preview and thumbnails) and on the server,
 * so a saved photo matches the preview.
 */

export type BlendMode = "multiply" | "screen" | "overlay" | "darken" | "lighten" | "soft-light";
/** Straight (not premultiplied) 0–1 RGBA. */
type Rgba = [number, number, number, number];
type GradientStop = { offset: number; color: Rgba };
type Curves = [number[], number[], number[]];

/** A color laid over the photo: solid, a circle from the center out to the corners, or top to bottom. */
export type FilterFill =
  | { type: "solid"; color: Rgba }
  | { type: "radial"; stops: GradientStop[] }
  | { type: "linear"; stops: GradientStop[] };

export type FilterStep =
  /** 3×4 row-major; the last column is an offset. */
  | { type: "matrix"; values: number[] }
  /**
   * A 1D LUT: per-channel curves sampled evenly over 0–1, then an optional
   * row-major 3×3 channel mix and optional per-channel output curves.
   */
  | { type: "lut"; curves: Curves; mix?: number[]; outputCurves?: Curves }
  | { type: "blend"; mode: BlendMode; fill: FilterFill };

export type PhotoFilter = { id: string; label: string; group: string; steps: FilterStep[] };

// --- CSS filter functions (Filter Effects Module Level 1) ---

function affine(slope: number, intercept: number): number[] {
  return [slope, 0, 0, intercept, 0, slope, 0, intercept, 0, 0, slope, intercept];
}

function linearMatrix(rows: number[][]): number[] {
  return rows.flatMap((row) => [...row, 0]);
}

function cssFunctionStep(name: string, amount: number): FilterStep {
  const inverse = 1 - Math.min(1, Math.max(0, amount));
  switch (name) {
    case "brightness": return { type: "matrix", values: affine(amount, 0) };
    case "contrast": return { type: "matrix", values: affine(amount, 0.5 - 0.5 * amount) };
    case "saturate": return { type: "matrix", values: linearMatrix([
      [0.213 + 0.787 * amount, 0.715 - 0.715 * amount, 0.072 - 0.072 * amount],
      [0.213 - 0.213 * amount, 0.715 + 0.285 * amount, 0.072 - 0.072 * amount],
      [0.213 - 0.213 * amount, 0.715 - 0.715 * amount, 0.072 + 0.928 * amount],
    ]) };
    case "grayscale": return { type: "matrix", values: linearMatrix([
      [0.2126 + 0.7874 * inverse, 0.7152 - 0.7152 * inverse, 0.0722 - 0.0722 * inverse],
      [0.2126 - 0.2126 * inverse, 0.7152 + 0.2848 * inverse, 0.0722 - 0.0722 * inverse],
      [0.2126 - 0.2126 * inverse, 0.7152 - 0.7152 * inverse, 0.0722 + 0.9278 * inverse],
    ]) };
    case "sepia": return { type: "matrix", values: linearMatrix([
      [0.393 + 0.607 * inverse, 0.769 - 0.769 * inverse, 0.189 - 0.189 * inverse],
      [0.349 - 0.349 * inverse, 0.686 + 0.314 * inverse, 0.168 - 0.168 * inverse],
      [0.272 - 0.272 * inverse, 0.534 - 0.534 * inverse, 0.131 + 0.869 * inverse],
    ]) };
    case "hue-rotate": {
      const cos = Math.cos((amount * Math.PI) / 180);
      const sin = Math.sin((amount * Math.PI) / 180);
      return { type: "matrix", values: linearMatrix([
        [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928],
        [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283],
        [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072],
      ]) };
    }
    default: throw new Error(`Unsupported CSS filter function: ${name}`);
  }
}

/** Steps for a CSS `filter` value such as `sepia(.5) hue-rotate(-30deg)`. */
export function cssFilterSteps(value: string): FilterStep[] {
  return [...value.matchAll(/([a-z-]+)\(\s*(-?[\d.]+)(deg|%)?\s*\)/g)].map(([, name, amount, unit]) =>
    cssFunctionStep(name, Number(amount) / (unit === "%" ? 100 : 1)));
}

function splitTopLevel(value: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    else if (value[index] === ")") depth -= 1;
    else if (value[index] === "," && depth === 0) { parts.push(value.slice(start, index).trim()); start = index + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function cssColor(value: string): Rgba {
  if (value === "transparent") return [0, 0, 0, 0];
  if (value === "black") return [0, 0, 0, 1];
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16) / 255).concat(1) as Rgba;
  const rgba = /^rgba?\(([^)]*)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(",").map(Number);
    return [r / 255, g / 255, b / 255, a];
  }
  throw new Error(`Unsupported CSS color: ${value}`);
}

/** Color stops with CSS's rules for missing positions. */
function cssStops(parts: string[]): GradientStop[] {
  const parsed = parts.map((part) => {
    const match = /^(.*?)(?:\s+(-?[\d.]+)%?)?$/.exec(part)!;
    return { color: cssColor(match[1].trim()), offset: match[2] === undefined ? null : Number(match[2]) / 100 };
  });
  if (parsed[0].offset === null) parsed[0].offset = 0;
  if (parsed[parsed.length - 1].offset === null) parsed[parsed.length - 1].offset = 1;
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].offset !== null) continue;
    let next = index;
    while (parsed[next].offset === null) next += 1;
    const from = parsed[index - 1].offset!;
    parsed[index].offset = from + (parsed[next].offset! - from) / (next - index + 1);
  }
  return parsed.map(({ color, offset }) => ({ color, offset: offset! }));
}

/** A fill for a CSS `background`: a color, a centered `radial-gradient(circle …)` or `linear-gradient(to bottom, …)`. */
export function cssFill(value: string): FilterFill {
  const gradient = /^(radial|linear)-gradient\((.*)\)$/.exec(value);
  if (!gradient) return { type: "solid", color: cssColor(value) };
  const [shape, ...stops] = splitTopLevel(gradient[2]);
  if (gradient[1] === "linear" && shape === "to bottom") return { type: "linear", stops: cssStops(stops) };
  // From the center, the closest and farthest corners are equally far.
  if (gradient[1] === "radial" && /^circle( (closest|farthest)-corner)?$/.test(shape)) return { type: "radial", stops: cssStops(stops) };
  throw new Error(`Unsupported CSS gradient: ${value}`);
}

// --- Applying filters ---

function blendChannel(mode: BlendMode, backdrop: number, source: number) {
  switch (mode) {
    case "multiply": return backdrop * source;
    case "screen": return backdrop + source - backdrop * source;
    case "overlay": return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
    case "darken": return Math.min(backdrop, source);
    case "lighten": return Math.max(backdrop, source);
    case "soft-light": {
      if (source <= 0.5) return backdrop - (1 - 2 * source) * backdrop * (1 - backdrop);
      const lifted = backdrop <= 0.25 ? ((16 * backdrop - 12) * backdrop + 4) * backdrop : Math.sqrt(backdrop);
      return backdrop + (2 * source - 1) * (lifted - backdrop);
    }
  }
}

/** Gradient colors at evenly spaced positions, premultiplied as CSS interpolates them. */
const GRADIENT_SAMPLES = 1024;
function sampleGradient(stops: GradientStop[]) {
  const table = new Float32Array(GRADIENT_SAMPLES * 4);
  for (let sample = 0; sample < GRADIENT_SAMPLES; sample += 1) {
    const at = sample / (GRADIENT_SAMPLES - 1);
    let next = stops.findIndex((stop) => stop.offset >= at);
    if (next === -1) next = stops.length - 1;
    const from = stops[Math.max(0, next - 1)];
    const to = stops[next];
    const mix = to.offset > from.offset ? Math.min(1, Math.max(0, (at - from.offset) / (to.offset - from.offset))) : 1;
    const alpha = from.color[3] + (to.color[3] - from.color[3]) * mix;
    for (let channel = 0; channel < 3; channel += 1) {
      const premultiplied = from.color[channel] * from.color[3] + (to.color[channel] * to.color[3] - from.color[channel] * from.color[3]) * mix;
      table[sample * 4 + channel] = alpha > 0 ? premultiplied / alpha : 0;
    }
    table[sample * 4 + 3] = alpha;
  }
  return table;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** A curve's value at 0–1 `value`, which is clamped. */
function curveAt(curve: number[], value: number) {
  const position = clamp01(value) * (curve.length - 1);
  const index = Math.min(curve.length - 2, Math.floor(position));
  return curve[index] + (curve[index + 1] - curve[index]) * (position - index);
}

/**
 * Filter 8-bit pixels (RGB or RGBA, row by row) into `output`. Alpha is kept.
 * `output` may be `input`.
 */
export function applyPhotoFilter(
  input: ArrayLike<number>,
  output: { [index: number]: number },
  width: number,
  height: number,
  channels: 3 | 4,
  filter: PhotoFilter,
) {
  const gradients = filter.steps.map((step) => (step.type === "blend" && step.fill.type !== "solid" ? sampleGradient(step.fill.stops) : null));
  const halfDiagonal = Math.hypot(width / 2, height / 2);
  const color = [0, 0, 0];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      let r = input[offset] / 255;
      let g = input[offset + 1] / 255;
      let b = input[offset + 2] / 255;
      for (let index = 0; index < filter.steps.length; index += 1) {
        const step = filter.steps[index];
        if (step.type === "matrix") {
          const m = step.values;
          const nr = m[0] * r + m[1] * g + m[2] * b + m[3];
          const ng = m[4] * r + m[5] * g + m[6] * b + m[7];
          const nb = m[8] * r + m[9] * g + m[10] * b + m[11];
          r = clamp01(nr); g = clamp01(ng); b = clamp01(nb);
        } else if (step.type === "lut") {
          const cr = curveAt(step.curves[0], r);
          const cg = curveAt(step.curves[1], g);
          const cb = curveAt(step.curves[2], b);
          const m = step.mix;
          if (m) {
            r = m[0] * cr + m[1] * cg + m[2] * cb;
            g = m[3] * cr + m[4] * cg + m[5] * cb;
            b = m[6] * cr + m[7] * cg + m[8] * cb;
          } else {
            r = cr; g = cg; b = cb;
          }
          const out = step.outputCurves;
          if (out) { r = curveAt(out[0], r); g = curveAt(out[1], g); b = curveAt(out[2], b); }
          r = clamp01(r); g = clamp01(g); b = clamp01(b);
        } else {
          let alpha: number;
          const fill = step.fill;
          if (fill.type === "solid") {
            color[0] = fill.color[0]; color[1] = fill.color[1]; color[2] = fill.color[2]; alpha = fill.color[3];
          } else {
            const at = fill.type === "radial"
              ? Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) / halfDiagonal
              : (y + 0.5) / height;
            const table = gradients[index]!;
            const sample = Math.min(GRADIENT_SAMPLES - 1, Math.round(at * (GRADIENT_SAMPLES - 1))) * 4;
            color[0] = table[sample]; color[1] = table[sample + 1]; color[2] = table[sample + 2]; alpha = table[sample + 3];
          }
          if (alpha > 0) {
            r = clamp01(r + alpha * (blendChannel(step.mode, r, color[0]) - r));
            g = clamp01(g + alpha * (blendChannel(step.mode, g, color[1]) - g));
            b = clamp01(b + alpha * (blendChannel(step.mode, b, color[2]) - b));
          }
        }
      }
      output[offset] = Math.round(r * 255);
      output[offset + 1] = Math.round(g * 255);
      output[offset + 2] = Math.round(b * 255);
      if (channels === 4) output[offset + 3] = input[offset + 3];
    }
  }
}

/** Mix filtered pixels back toward the originals; `strength` runs from 0 to 1. Alpha is kept. */
export function mixFilteredPixels(
  original: ArrayLike<number>,
  filtered: ArrayLike<number>,
  output: { [index: number]: number },
  channels: 3 | 4,
  strength: number,
) {
  for (let offset = 0; offset < original.length; offset += channels) {
    for (let channel = 0; channel < 3; channel += 1) {
      const from = original[offset + channel];
      output[offset + channel] = Math.round(from + (filtered[offset + channel] - from) * strength);
    }
    if (channels === 4) output[offset + 3] = original[offset + 3];
  }
}

// --- The filter library ---

/*!
 * Filters from Instagram.css v0.1.4, https://github.com/picturepan2/instagram.css
 * MIT License, Copyright (c) 2017 Yan Zhu
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// [id, label, CSS filter, ::before background, ::before mix-blend-mode]. In CSS the
// overlay sits inside the filtered element, so it is blended first.
const INSTAGRAM_CSS: Array<[string, string, string, string?, BlendMode?]> = [
  ["1977", "1977", "sepia(.5) hue-rotate(-30deg) saturate(1.4)"],
  ["aden", "Aden", "sepia(.2) brightness(1.15) saturate(1.4)", "rgba(125, 105, 24, .1)", "multiply"],
  ["amaro", "Amaro", "sepia(.35) contrast(1.1) brightness(1.2) saturate(1.3)", "rgba(125, 105, 24, .2)", "overlay"],
  ["ashby", "Ashby", "sepia(.5) contrast(1.2) saturate(1.8)", "rgba(125, 105, 24, .35)", "lighten"],
  ["brannan", "Brannan", "sepia(.4) contrast(1.25) brightness(1.1) saturate(.9) hue-rotate(-2deg)"],
  ["brooklyn", "Brooklyn", "sepia(.25) contrast(1.25) brightness(1.25) hue-rotate(5deg)", "rgba(127, 187, 227, .2)", "overlay"],
  ["charmes", "Charmes", "sepia(.25) contrast(1.25) brightness(1.25) saturate(1.35) hue-rotate(-5deg)", "rgba(125, 105, 24, .25)", "darken"],
  ["clarendon", "Clarendon", "sepia(.15) contrast(1.25) brightness(1.25) hue-rotate(5deg)", "rgba(127, 187, 227, .4)", "overlay"],
  ["crema", "Crema", "sepia(.5) contrast(1.25) brightness(1.15) saturate(.9) hue-rotate(-2deg)", "rgba(125, 105, 24, .2)", "multiply"],
  ["dogpatch", "Dogpatch", "sepia(.35) saturate(1.1) contrast(1.5)"],
  ["earlybird", "Earlybird", "sepia(.25) contrast(1.25) brightness(1.15) saturate(.9) hue-rotate(-5deg)", "radial-gradient(circle closest-corner, transparent 0, rgba(125, 105, 24, .2) 100%)", "multiply"],
  ["gingham", "Gingham", "contrast(1.1) brightness(1.1)", "#e6e6e6", "soft-light"],
  ["ginza", "Ginza", "sepia(.25) contrast(1.15) brightness(1.2) saturate(1.35) hue-rotate(-5deg)", "rgba(125, 105, 24, .15)", "darken"],
  ["hefe", "Hefe", "sepia(.4) contrast(1.5) brightness(1.2) saturate(1.4) hue-rotate(-10deg)", "radial-gradient(circle closest-corner, transparent 0, rgba(0, 0, 0, .25) 100%)", "multiply"],
  ["helena", "Helena", "sepia(.5) contrast(1.05) brightness(1.05) saturate(1.35)", "rgba(158, 175, 30, .25)", "overlay"],
  ["hudson", "Hudson", "sepia(.25) contrast(1.2) brightness(1.2) saturate(1.05) hue-rotate(-15deg)", "radial-gradient(circle closest-corner, transparent 25%, rgba(25, 62, 167, .25) 100%)", "multiply"],
  ["inkwell", "Inkwell", "brightness(1.25) contrast(.85) grayscale(1)"],
  ["juno", "Juno", "sepia(.35) contrast(1.15) brightness(1.15) saturate(1.8)", "rgba(127, 187, 227, .2)", "overlay"],
  ["kelvin", "Kelvin", "sepia(.15) contrast(1.5) brightness(1.1) hue-rotate(-10deg)", "radial-gradient(circle closest-corner, rgba(128, 78, 15, .25) 0, rgba(128, 78, 15, .5) 100%)", "overlay"],
  ["lark", "Lark", "sepia(.25) contrast(1.2) brightness(1.3) saturate(1.25)"],
  ["lofi", "Lo-Fi", "saturate(1.1) contrast(1.5)"],
  ["ludwig", "Ludwig", "sepia(.25) contrast(1.05) brightness(1.05) saturate(2)", "rgba(125, 105, 24, .1)", "overlay"],
  ["maven", "Maven", "sepia(.35) contrast(1.05) brightness(1.05) saturate(1.75)", "rgba(158, 175, 30, .25)", "darken"],
  ["mayfair", "Mayfair", "contrast(1.1) brightness(1.15) saturate(1.1)", "radial-gradient(circle closest-corner, transparent 0, rgba(175, 105, 24, .4) 100%)", "multiply"],
  ["moon", "Moon", "brightness(1.4) contrast(.95) saturate(0) sepia(.35)"],
  ["nashville", "Nashville", "sepia(.25) contrast(1.5) brightness(.9) hue-rotate(-15deg)", "radial-gradient(circle closest-corner, rgba(128, 78, 15, .5) 0, rgba(128, 78, 15, .65) 100%)", "screen"],
  ["perpetua", "Perpetua", "contrast(1.1) brightness(1.25) saturate(1.1)", "linear-gradient(to bottom, rgba(0, 91, 154, .25), rgba(230, 193, 61, .25))", "multiply"],
  ["poprocket", "Poprocket", "sepia(.15) brightness(1.2)", "radial-gradient(circle closest-corner, rgba(206, 39, 70, .75) 40%, black 80%)", "screen"],
  ["reyes", "Reyes", "sepia(.75) contrast(.75) brightness(1.25) saturate(1.4)"],
  ["rise", "Rise", "sepia(.25) contrast(1.25) brightness(1.2) saturate(.9)", "radial-gradient(circle closest-corner, transparent 0, rgba(230, 193, 61, .25) 100%)", "lighten"],
  ["sierra", "Sierra", "sepia(.25) contrast(1.5) brightness(.9) hue-rotate(-15deg)", "radial-gradient(circle closest-corner, rgba(128, 78, 15, .5) 0, rgba(0, 0, 0, .65) 100%)", "screen"],
  ["skyline", "Skyline", "sepia(.15) contrast(1.25) brightness(1.25) saturate(1.2)"],
  ["slumber", "Slumber", "sepia(.35) contrast(1.25) saturate(1.25)", "rgba(125, 105, 24, .2)", "darken"],
  ["stinson", "Stinson", "sepia(.35) contrast(1.25) brightness(1.1) saturate(1.25)", "rgba(125, 105, 24, .45)", "lighten"],
  ["sutro", "Sutro", "sepia(.4) contrast(1.2) brightness(.9) saturate(1.4) hue-rotate(-10deg)", "radial-gradient(circle closest-corner, transparent 50%, rgba(0, 0, 0, .5) 90%)", "darken"],
  ["toaster", "Toaster", "sepia(.25) contrast(1.5) brightness(.95) hue-rotate(-15deg)", "radial-gradient(circle, #804e0f, rgba(0, 0, 0, .25))", "screen"],
  ["valencia", "Valencia", "sepia(.25) contrast(1.1) brightness(1.1)", "rgba(230, 193, 61, .1)", "lighten"],
  ["vesper", "Vesper", "sepia(.35) contrast(1.15) brightness(1.2) saturate(1.3)", "rgba(125, 105, 24, .25)", "overlay"],
  ["walden", "Walden", "sepia(.35) contrast(.8) brightness(1.25) saturate(1.4)", "rgba(229, 240, 128, .5)", "darken"],
  ["willow", "Willow", "brightness(1.2) contrast(.85) saturate(.05) sepia(.2)"],
  ["xpro-ii", "X-Pro II", "sepia(.45) contrast(1.25) brightness(1.75) saturate(1.3) hue-rotate(-5deg)", "radial-gradient(circle closest-corner, rgba(0, 91, 154, .35) 0, rgba(0, 0, 0, .65) 100%)", "multiply"],
];

export const INSTAGRAM_GROUP = "Instagram";

export const INSTAGRAM_FILTERS: PhotoFilter[] = INSTAGRAM_CSS.map(([id, label, filter, background, mode]) => ({
  id: `ig-${id}`,
  label,
  group: INSTAGRAM_GROUP,
  steps: [
    ...(background && mode ? [{ type: "blend", mode, fill: cssFill(background) } satisfies FilterStep] : []),
    ...cssFilterSteps(filter),
  ],
}));

/** Shown with the film looks, as their license asks. */
export const FILM_LOOKS_CREDIT = "Film looks fitted from the RawTherapee Film Simulation Collection by Pat David, Pavlov Dmitry and Michael Ezra (CC BY-SA 4.0).";

/** Every filter. The film looks are large, so they load on first use. */
export async function loadPhotoFilters(): Promise<PhotoFilter[]> {
  const { FILM_LOOKS } = await import("./photo-film-looks");
  return [...INSTAGRAM_FILTERS, ...FILM_LOOKS];
}

export async function findPhotoFilter(id: string): Promise<PhotoFilter | null> {
  return INSTAGRAM_FILTERS.find((filter) => filter.id === id)
    ?? (await loadPhotoFilters()).find((filter) => filter.id === id)
    ?? null;
}
