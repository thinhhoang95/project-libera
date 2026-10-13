import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getOpenRouterApiKey } from "./openrouter";
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  DEFAULT_IMAGE_MODEL,
  IMAGE_PARAMETER_ORDER,
  MAX_REFERENCE_IMAGE_BYTES,
  REFERENCE_IMAGE_TYPES,
  parseImageGenerationSettings,
  validParameterValues,
  type ImageGenerationModel,
  type ImageGenerationSettings,
  type ImageParameterDescriptor,
  type ImageParameterValues,
} from "./image-generation";

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images";
const OPENROUTER_IMAGE_MODELS_URL = "https://openrouter.ai/api/v1/images/models";
const MODELS_CACHE_MS = 30 * 60 * 1000;

function settingsPath() {
  const directory = process.env.LIBERA_CONFIG_PATH
    ? path.dirname(process.env.LIBERA_CONFIG_PATH)
    : path.resolve(process.env.LIBERA_DATA_DIR || path.join(process.cwd(), "data", "libera"), ".libera");
  return path.join(directory, "image-generation.json");
}

export function defaultImageModel() {
  return process.env.LIBERA_AI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL;
}

export async function readImageGenerationSettings(): Promise<ImageGenerationSettings> {
  let content: string;
  try { content = await readFile(settingsPath(), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_IMAGE_GENERATION_SETTINGS, model: defaultImageModel() };
    throw error;
  }
  // Damaged settings must not keep the panel from opening.
  try { return parseImageGenerationSettings(JSON.parse(content)); } catch { return { ...DEFAULT_IMAGE_GENERATION_SETTINGS, model: defaultImageModel() }; }
}

export async function writeImageGenerationSettings(input: unknown) {
  const settings = parseImageGenerationSettings(input);
  const target = settingsPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return settings;
}

function parseDescriptor(value: unknown): ImageParameterDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const descriptor = value as { type?: unknown; values?: unknown; min?: unknown; max?: unknown };
  if (descriptor.type === "enum" && Array.isArray(descriptor.values)) {
    const values = descriptor.values.filter((entry): entry is string => typeof entry === "string" && entry.length <= 40);
    return values.length ? { type: "enum", values } : null;
  }
  if (descriptor.type === "range" && typeof descriptor.min === "number" && typeof descriptor.max === "number" && descriptor.max >= descriptor.min) {
    return { type: "range", min: descriptor.min, max: descriptor.max };
  }
  return descriptor.type === "boolean" ? { type: "boolean" } : null;
}

type ModelsCache = { expiresAt: number; models: ImageGenerationModel[] };
const MODELS_CACHE = Symbol.for("libera.imageModels.v2");

export async function getImageGenerationModels(signal?: AbortSignal): Promise<ImageGenerationModel[]> {
  const cache = globalThis as { [MODELS_CACHE]?: ModelsCache };
  const cached = cache[MODELS_CACHE];
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const apiKey = getOpenRouterApiKey();
  const response = await fetch(OPENROUTER_IMAGE_MODELS_URL, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal,
  });
  if (!response.ok) throw new Error("Could not load image models from OpenRouter.");
  const payload = (await response.json()) as { data?: unknown[] };
  const models = (payload.data ?? []).flatMap((entry): ImageGenerationModel[] => {
    if (!entry || typeof entry !== "object") return [];
    const model = entry as { id?: unknown; name?: unknown; description?: unknown; supported_parameters?: unknown; architecture?: { input_modalities?: unknown } };
    if (typeof model.id !== "string") return [];
    // Models that need an input image cannot work from a prompt alone.
    const inputs = Array.isArray(model.architecture?.input_modalities) ? model.architecture.input_modalities : ["text"];
    if (!inputs.includes("text")) return [];
    const supported = (model.supported_parameters ?? {}) as Record<string, unknown>;
    const references = parseDescriptor(supported.input_references);
    const parameters: Record<string, ImageParameterDescriptor> = {};
    for (const key of IMAGE_PARAMETER_ORDER) {
      const descriptor = parseDescriptor(supported[key]);
      if (descriptor) parameters[key] = descriptor;
    }
    return [{
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      description: typeof model.description === "string" ? model.description : undefined,
      parameters,
      ...(references?.type === "range" && references.max > 0 ? { references: { min: references.min, max: references.max } } : {}),
    }];
  });
  cache[MODELS_CACHE] = { expiresAt: Date.now() + MODELS_CACHE_MS, models };
  return models;
}

export type GeneratedImage = { body: Buffer; mediaType: string };

/** Check reference photos are image data URLs of a sensible size. */
export function parseReferenceImages(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("Too many reference photos.");
  return value.map((entry) => {
    const match = typeof entry === "string" ? /^data:([a-z/+-]+);base64,([A-Za-z0-9+/]+=*)$/.exec(entry) : null;
    if (!match || !REFERENCE_IMAGE_TYPES.includes(match[1])) throw new Error("Reference photos must be PNG, JPEG, WebP or GIF images.");
    if (match[2].length * 0.75 > MAX_REFERENCE_IMAGE_BYTES) throw new Error("A reference photo is too large.");
    return entry as string;
  });
}

export async function generateImages(
  { model: modelId, prompt, params, references = [] }: { model: string; prompt: string; params: ImageParameterValues; references?: string[] },
  signal?: AbortSignal,
): Promise<{ images: GeneratedImage[]; cost?: number }> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) throw new Error("Add an OpenRouter API key to generate images.");

  const models = await getImageGenerationModels(signal);
  const model = models.find((entry) => entry.id === modelId);
  if (!model) throw new Error(`OpenRouter does not offer “${modelId}” for image generation.`);
  const allowed = model.references ?? { min: 0, max: 0 };
  if (references.length > allowed.max) {
    throw new Error(allowed.max ? `${model.name} takes at most ${allowed.max} reference ${allowed.max === 1 ? "photo" : "photos"}.` : `${model.name} does not take reference photos.`);
  }
  if (references.length < allowed.min) {
    throw new Error(`${model.name} needs at least ${allowed.min} reference ${allowed.min === 1 ? "photo" : "photos"}.`);
  }

  const response = await fetch(OPENROUTER_IMAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Libera",
    },
    signal,
    body: JSON.stringify({
      model: model.id,
      prompt,
      ...validParameterValues(model, params),
      ...(references.length ? { input_references: references.map((url) => ({ type: "image_url", image_url: { url } })) } : {}),
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    data?: Array<{ b64_json?: string; url?: string; media_type?: string }>;
    usage?: { cost?: number };
    error?: { message?: string };
  } | null;
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error?.message || response.statusText || "OpenRouter could not generate the image.");
  }

  const images: GeneratedImage[] = [];
  for (const item of payload?.data ?? []) {
    if (item.b64_json) {
      images.push({ body: Buffer.from(item.b64_json, "base64"), mediaType: item.media_type ?? sniffMediaType(Buffer.from(item.b64_json.slice(0, 32), "base64")) });
    } else if (item.url?.startsWith("data:")) {
      const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(item.url);
      if (match) images.push({ body: Buffer.from(match[3], match[2] ? "base64" : "utf8"), mediaType: match[1] ?? "image/png" });
    }
  }
  if (!images.length) throw new Error("OpenRouter returned no image. Try a different prompt or model.");
  return { images, cost: payload?.usage?.cost };
}

function sniffMediaType(head: Buffer) {
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "RIFF") return "image/webp";
  if (head.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (head.subarray(0, 5).toString("latin1").startsWith("<")) return "image/svg+xml";
  return "image/png";
}

export function extensionForMediaType(mediaType: string) {
  return { "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg" }[mediaType] ?? ".png";
}

/** `2026-10-13 14.05.22 red panda astronaut.png`, so names sort by date on disk. */
export function generatedImageName(prompt: string, mediaType: string, index: number, date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  const words = prompt
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(" ")
    .slice(0, 60)
    .trim();
  return `${stamp}${words ? ` ${words}` : ""}${index ? ` (${index + 1})` : ""}${extensionForMediaType(mediaType)}`;
}
