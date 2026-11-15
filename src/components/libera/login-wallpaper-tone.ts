import { contrast, coverCanvas, hslToRgb, hueOf, loadImage, luminance, type Sample } from "./image-tone";

export type WallpaperTone = "light" | "dark";

/** How the login foreground should look on a wallpaper: ink tone plus a two-stop logo tint. */
export type WallpaperLook = { tone: WallpaperTone; logo: [string, string] };

// Relative luminance where white and near-black ink give equal contrast; above it dark ink reads better.
const LIGHT_THRESHOLD = 0.2;
// Below this average chroma the wallpaper is effectively grey, so the logo keeps its brand colors.
const NEUTRAL_CHROMA = 0.05;
// The logo is a large graphic; 4:1 keeps it clearly legible while still letting it take on color.
const LOGO_CONTRAST = 4;
const BRAND = { light: "#106660", dark: "#ffffff" } as const;
const cache = new Map<string, WallpaperLook>();

/**
 * A color of the given hue that stays legible on the background: deep on light
 * wallpapers, pale on dark ones, stepping lightness until the contrast holds.
 */
function inkFor(hue: number, chroma: number, tone: WallpaperTone, background: number) {
  const saturation = Math.min(0.62, 0.35 + chroma * 1.4);
  for (let step = 0; step <= 40; step++) {
    const lightness = tone === "light" ? 0.36 - step * 0.008 : 0.84 + step * 0.004;
    const [r, g, b] = hslToRgb(hue, saturation, lightness);
    if (contrast(luminance(r, g, b), background) >= LOGO_CONTRAST || step === 40) return `rgb(${r} ${g} ${b})`;
  }
  return BRAND[tone];
}

function lookOf(all: Sample[], first: Sample[], second: Sample[]): WallpaperLook {
  let total = 0;
  let weight = 0;
  for (const { r, g, b, weight: w } of all) {
    total += luminance(r, g, b) * w;
    weight += w;
  }
  const background = weight ? total / weight : 1;
  const tone = background > LIGHT_THRESHOLD ? "light" : "dark";
  const overall = hueOf(all);
  if (overall.chroma < NEUTRAL_CHROMA) return { tone, logo: [BRAND[tone], BRAND[tone]] };
  const a = hueOf(first);
  const b = hueOf(second);
  return { tone, logo: [inkFor(a.hue, overall.chroma, tone, background), inkFor(b.hue, overall.chroma, tone, background)] };
}

/** Gradients: every color stop, weighted by opacity; the tint runs from the mean hue to the most vivid stop. */
function gradientLook(background: string): WallpaperLook {
  const stops: Sample[] = [];
  for (const [, hex] of background.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const [r, g, b, a = 255] = full.match(/../g)!.map((pair) => parseInt(pair, 16));
    stops.push({ r, g, b, weight: a });
  }
  const vivid = stops.reduce<Sample | undefined>((best, stop) =>
    !best || Math.max(stop.r, stop.g, stop.b) - Math.min(stop.r, stop.g, stop.b) > Math.max(best.r, best.g, best.b) - Math.min(best.r, best.g, best.b) ? stop : best, undefined);
  return lookOf(stops, stops, vivid ? [vivid] : stops);
}

/**
 * Images: sample the band the sign-in stack sits on (logo, greeting and
 * password at the bottom), as `background-size: cover` crops it. The logo tint
 * runs from the left half's hue to the right half's.
 */
async function imageLook(url: string, signal: AbortSignal): Promise<WallpaperLook> {
  const image = await loadImage(url, signal);
  const { context, width, height } = coverCanvas(image, window.innerWidth / Math.max(window.innerHeight, 1));

  const left = Math.floor(width * 0.3);
  const top = Math.floor(height * 0.62);
  const bandWidth = Math.ceil(width * 0.7) - left;
  const { data } = context.getImageData(left, top, bandWidth, Math.max(1, Math.ceil(height * 0.98) - top));
  const all: Sample[] = [];
  const first: Sample[] = [];
  const second: Sample[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const sample = { r: data[i], g: data[i + 1], b: data[i + 2], weight: 1 };
    all.push(sample);
    ((i / 4) % bandWidth < bandWidth / 2 ? first : second).push(sample);
  }
  return lookOf(all, first, second);
}

/** Reads a CSS `background` value and decides the foreground tone and logo tint that suit it. */
export async function detectWallpaperLook(background: string, signal: AbortSignal): Promise<WallpaperLook> {
  const cached = cache.get(background);
  if (cached) return cached;
  const url = background.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
  const look = url ? await imageLook(url, signal) : gradientLook(background);
  cache.set(background, look);
  return look;
}
