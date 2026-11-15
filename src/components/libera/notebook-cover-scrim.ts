import { coverCanvas, hueOf, loadImage, luminance, type Sample } from "./image-tone";

/**
 * How strongly the notebook cover must be washed out behind its title, for the
 * light and the dark theme, plus the artwork's own hue to tint the wash and the
 * ink with. Hue and saturation are left out for near-grey artwork, which keeps
 * the default navy.
 */
export type CoverScrim = { light: number; dark: number; hue?: number; saturation?: number };

// Below this average chroma the artwork is effectively grey.
const NEUTRAL_CHROMA = 0.05;
const MIN_STRENGTH = 0.25;
const MAX_STRENGTH = 0.92;
// The share of pixels allowed to fall short: the scrim is sized for the rest.
const TAIL = 0.08;
// Grey levels of the wash, and the background luminance at which the metadata
// line reaches 4.5:1. Both follow --cover-wash and --cover-muted in notebook-home.module.css.
const LIGHT = { wash: 247, luminance: 0.5 };
const DARK = { wash: 30, luminance: 0.1 };

const cache = new Map<string, CoverScrim>();

/** The weakest wash over `pixel` that brings it to the luminance the text needs. */
function strengthFor(pixel: Sample, wash: number, holds: (value: number) => boolean) {
  for (let alpha = MIN_STRENGTH; alpha < MAX_STRENGTH; alpha += 0.02) {
    const mix = (c: number) => alpha * wash + (1 - alpha) * c;
    if (holds(luminance(mix(pixel.r), mix(pixel.g), mix(pixel.b)))) return Math.round(alpha * 100) / 100;
  }
  return MAX_STRENGTH;
}

/**
 * Samples the top-left of the cover, where the title and metadata sit, as the
 * cover crops its artwork (`center 35% / cover`) at the given aspect ratio.
 */
export async function detectCoverScrim(url: string, aspect: number, signal: AbortSignal): Promise<CoverScrim> {
  const key = `${url}|${aspect.toFixed(1)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const image = await loadImage(url, signal);
  const { context, width, height } = coverCanvas(image, aspect, 0.5, 0.35);
  const { data } = context.getImageData(0, 0, Math.ceil(width * 0.62), Math.max(1, Math.ceil(height * 0.45)));
  const samples: Sample[] = [];
  for (let i = 0; i < data.length; i += 4) samples.push({ r: data[i], g: data[i + 1], b: data[i + 2], weight: 1 });

  const byLuminance = [...samples].sort((a, b) => luminance(a.r, a.g, a.b) - luminance(b.r, b.g, b.b));
  const darkest = byLuminance[Math.floor(byLuminance.length * TAIL)];
  const brightest = byLuminance[Math.ceil(byLuminance.length * (1 - TAIL)) - 1];
  const { hue, chroma } = hueOf(samples);
  const scrim: CoverScrim = {
    light: strengthFor(darkest, LIGHT.wash, (value) => value >= LIGHT.luminance),
    dark: strengthFor(brightest, DARK.wash, (value) => value <= DARK.luminance),
    ...(chroma >= NEUTRAL_CHROMA ? { hue: Math.round(hue), saturation: Math.round(Math.min(55, 22 + chroma * 140)) } : {}),
  };
  cache.set(key, scrim);
  return scrim;
}
