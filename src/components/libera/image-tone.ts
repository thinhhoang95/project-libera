/** Pixel sampling shared by the surfaces that set text on artwork (login wallpaper, notebook cover). */

export type Sample = { r: number; g: number; b: number; weight: number };

function channel(value: number) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB color with 0–255 channels. */
export function luminance(r: number, g: number, b: number) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: number, b: number) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function hslToRgb(h: number, s: number, l: number) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)] as const;
}

/** Saturation-weighted mean hue (as a vector, so 350° and 10° average to 0°) and mean chroma. */
export function hueOf(samples: Sample[]) {
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

export async function loadImage(url: string, signal: AbortSignal) {
  // The load event, not decode(): decode() can stall or reject while the window is in the background.
  const image = new Image();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Image took too long to load.")), 10_000);
    image.onload = () => { clearTimeout(timeout); resolve(undefined); };
    image.onerror = () => { clearTimeout(timeout); reject(new Error("Image failed to load.")); };
    image.src = url;
  });
  if (signal.aborted) throw signal.reason;
  return image;
}

/**
 * Draws the image small, cropped as `background-size: cover` crops it in a box
 * of the given aspect ratio; positionX/Y are the background-position fractions.
 * The low resolution doubles as a blur, so single pixels stand for small areas.
 */
export function coverCanvas(image: HTMLImageElement, aspect: number, positionX = 0.5, positionY = 0.5) {
  const width = 96;
  const height = Math.max(1, Math.round(width / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawnWidth = image.naturalWidth * scale;
  const drawnHeight = image.naturalHeight * scale;
  context.drawImage(image, (width - drawnWidth) * positionX, (height - drawnHeight) * positionY, drawnWidth, drawnHeight);
  return { context, width, height };
}
