import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { DetectionNotReadyError, runDetection, type DetectionRunSettings, type WorkerPrompt } from "@/lib/detection/detect";
import type { Box } from "@/lib/detection/results";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const MAX_PROMPTS = 40;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/bmp": ".bmp", "image/tiff": ".tif" };

type PromptInput = { id?: unknown; label?: unknown; type?: unknown; text?: unknown; source?: unknown; boxes?: unknown };

function isBox(value: unknown): value is Box {
  return Array.isArray(value) && value.length === 4 && value.every((item) => typeof item === "number" && Number.isFinite(item)) && value[2] > value[0] && value[3] > value[1];
}

async function saveImage(file: File, folder: string, name: string) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error("This image is too large to analyze (over 80 MB).");
  const extension = IMAGE_TYPES[file.type];
  if (!extension) throw new Error("Send the image as JPEG, PNG, WebP, BMP or TIFF.");
  const target = path.join(folder, `${name}${extension}`);
  await writeFile(target, Buffer.from(await file.arrayBuffer()));
  return target;
}

/**
 * Detect and segment objects in one photo (`image`) with YOLOE-26. `request`
 * is JSON: `{ prompts, settings }`, where each prompt is text or example boxes
 * on the photo (`source: "photo"`) or on an uploaded reference sent as
 * `reference:<prompt id>`. `settings` overrides Preferences for this run.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Send the photo and prompts as a form.", 400);
  }
  const image = form.get("image");
  if (!(image instanceof File)) return jsonError("Send the photo to analyze.", 400);
  let body: { prompts?: unknown; settings?: Partial<DetectionRunSettings> };
  try {
    body = JSON.parse(String(form.get("request") ?? "{}"));
  } catch {
    return jsonError("The prompts could not be read.", 400);
  }
  const inputs = Array.isArray(body.prompts) ? (body.prompts as PromptInput[]) : [];
  if (!inputs.length) return jsonError("Add at least one prompt.", 400);
  if (inputs.length > MAX_PROMPTS) return jsonError(`Use at most ${MAX_PROMPTS} prompts at once.`, 400);

  const folder = path.join(os.tmpdir(), "libera-detection", randomUUID());
  await mkdir(folder, { recursive: true });
  try {
    const imagePath = await saveImage(image, folder, "photo");
    const prompts: WorkerPrompt[] = [];
    for (const [index, input] of inputs.entries()) {
      const id = typeof input.id === "string" && input.id ? input.id.slice(0, 80) : `prompt-${index}`;
      const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 200) : `Prompt ${index + 1}`;
      if (input.type === "text") {
        const text = typeof input.text === "string" ? input.text.trim().slice(0, 300) : "";
        if (!text) return jsonError(`Prompt ${index + 1} has no text.`, 400);
        prompts.push({ id, label, type: "text", text });
        continue;
      }
      const boxes = Array.isArray(input.boxes) ? input.boxes.filter(isBox).slice(0, 50) : [];
      if (!boxes.length) return jsonError(`“${label}” needs at least one example box.`, 400);
      let reference = imagePath;
      if (input.source === "upload") {
        const file = form.get(`reference:${id}`);
        if (!(file instanceof File)) return jsonError(`The reference image for “${label}” is missing.`, 400);
        reference = await saveImage(file, folder, `reference-${index}`);
      }
      prompts.push({ id, label, type: "visual", image: reference, boxes });
    }

    const settings = body.settings ?? {};
    const result = await runDetection(imagePath, prompts, {
      ...(typeof settings.variant === "string" ? { variant: settings.variant } : {}),
      ...(typeof settings.confidence === "number" ? { confidence: Math.min(0.99, Math.max(0.01, settings.confidence)) } : {}),
      ...(typeof settings.iou === "number" ? { iou: Math.min(0.95, Math.max(0.05, settings.iou)) } : {}),
      ...([640, 960, 1280].includes(settings.imageSize as number) ? { imageSize: settings.imageSize } : {}),
      ...(typeof settings.maxDetections === "number" ? { maxDetections: Math.round(Math.min(3000, Math.max(1, settings.maxDetections))) } : {}),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DetectionNotReadyError) return NextResponse.json({ error: error.message, notReady: true }, { status: 409 });
    return jsonError(error instanceof Error ? error.message : "Detection failed.", 500);
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}
