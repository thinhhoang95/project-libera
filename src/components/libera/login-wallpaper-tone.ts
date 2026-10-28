export type WallpaperTone = "light" | "dark";

/** How the login foreground should look on a wallpaper: ink tone plus a two-stop logo tint. */
export type WallpaperLook = { tone: WallpaperTone; logo: [string, string] };

type Sample = { r: number; g: number; b: number; weight: number };

// Relative luminance where white and near-black ink give equal contrast; above it dark ink reads better.
const LIGHT_THRESHOLD = 0.2;
// Below this average chroma the wallpaper is effectively grey, so the logo keeps its brand colors.
const NEUTRAL_CHROMA = 0.05;
// The logo is a large graphic; 4:1 keeps it clearly legible while still letting it take on color.
const LOGO_CONTRAST = 4;
const BRAND = { light: "#106660", dark: "#ffffff" } as const;
const cache = new Map<string, WallpaperLook>();

function channel(value: number) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(r: number, g: number, b: number) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: number, b: number) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hslToRgb(h: number, s: number, l: number) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)] as const;
}

/** Saturation-weighted mean hue (as a vector, so 350° and 10° average to 0°) and mean chroma. */
function hueOf(samples: Sample[]) {
  let x = 0;
  let y = 0;
  let chroma = 0;
  let weight = 0;
  for (const { r, g, b, weight: w } of samples) {
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const c = max - min;
    weight += w;
    chroma += c * w;
    if (!c) continue;
    const h = max === r / 255 ? ((g - b) / 255 / c) % 6 : max === g / 255 ? (b - r) / 255 / c + 2 : (r - g) / 255 / c + 4;
    const angle = (h * 60 * Math.PI) / 180;
    x += Math.cos(angle) * c * w;
    y += Math.sin(angle) * c * w;
  }
  return { hue: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, chroma: weight ? chroma / weight : 0 };
}

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
  // The load event, not decode(): decode() can stall or reject while the window is in the background.
  const image = new Image();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Wallpaper took too long to load.")), 10_000);
    image.onload = () => { clearTimeout(timeout); resolve(undefined); };
    image.onerror = () => { clearTimeout(timeout); reject(new Error("Wallpaper failed to load.")); };
    image.src = url;
  });
  if (signal.aborted) throw signal.reason;

  const width = 96;
  const viewport = window.innerWidth / Math.max(window.innerHeight, 1);
  const height = Math.max(1, Math.round(width / viewport));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawnWidth = image.naturalWidth * scale;
  const drawnHeight = image.naturalHeight * scale;
  context.drawImage(image, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);

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
