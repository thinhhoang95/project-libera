"use client";

import { apiRequest } from "@/components/libera/api-client";
import { appMetadata } from "@/lib/app-metadata";
import {
  DETECTION_FILE_FORMAT,
  DETECTION_FILE_VERSION,
  computeStatistics,
  type Detection,
  type DetectionFile,
  type DetectionModelInfo,
  type DetectionPrompt,
  type DetectionScale,
  type RemovedDetection,
  provenanceOf,
} from "@/lib/detection/results";

export type DetectionVariantId = "n" | "s" | "m" | "l" | "x";

export type DetectionVariantInfo = {
  id: DetectionVariantId;
  name: string;
  file: string;
  size: number;
  parameters: string;
  textMap: number;
  visualMap: number;
};

export type DetectionRunSettings = {
  variant: DetectionVariantId;
  device: "cpu" | "mps" | "cuda";
  confidence: number;
  iou: number;
  maxDetections: number;
  imageSize: 640 | 960 | 1280;
};

export type DetectionStatus = {
  directory: string;
  exists: boolean;
  runtime: boolean;
  textEncoder: boolean;
  variants: Record<DetectionVariantId, boolean>;
  variant: DetectionVariantId;
  preferences: DetectionRunSettings;
  catalog: DetectionVariantInfo[];
  job: {
    phase: "runtime" | "python" | "packages" | "weights";
    variant: DetectionVariantId;
    running: boolean;
    error: string;
    downloadedBytes: number;
    totalBytes: number;
  } | null;
  sizes: { runtime: number; textEncoder: number; variants: Record<DetectionVariantId, number> };
};

export type DetectionRunResult = {
  width: number;
  height: number;
  detections: Detection[];
  model: DetectionModelInfo;
  timing: Record<string, unknown>;
};

export class DetectionNotReady extends Error {}

export function fetchDetectionStatus() {
  return apiRequest<DetectionStatus>("/api/detection");
}

export function startDetectionSetup(variant: DetectionVariantId) {
  return apiRequest<DetectionStatus>("/api/detection", { method: "POST", body: JSON.stringify({ variant }) });
}

export function cancelDetectionSetup() {
  return apiRequest<DetectionStatus>("/api/detection", { method: "DELETE" });
}

/** True when `status` can run `variant` with these prompts. */
export function variantReady(status: DetectionStatus | null, variant: DetectionVariantId, needsText: boolean) {
  return Boolean(status?.runtime && status.variants[variant] && (!needsText || status.textEncoder));
}

const SENDABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff"]);

/** The photo's bytes in a format the runtime reads; others (SVG, AVIF, HEIC…) are drawn to a PNG first. */
export async function photoBlob(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load the photo.");
  const blob = await response.blob();
  if (SENDABLE_TYPES.has(blob.type)) return blob;
  const image = await loadImage(URL.createObjectURL(blob));
  return canvasBlob(image, image.naturalWidth, image.naturalHeight, "image/png");
}

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read this image."));
    image.src = src;
  });
}

function canvasBlob(image: CanvasImageSource, width: number, height: number, type: string, quality?: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not convert the image."))), type, quality));
}

/** A crop of `image` as a small JPEG data URL, for a visual prompt's thumbnail. */
export function cropThumbnail(image: HTMLImageElement, [x1, y1, x2, y2]: [number, number, number, number], size = 96) {
  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);
  const scale = size / Math.max(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d")!.drawImage(image, x1, y1, width, height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** An uploaded reference, at most `maxSide` pixels on its longer side, as a JPEG data URL with its size. */
export function downscaleReference(image: HTMLImageElement, maxSide = 1280) {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.9), width, height };
}

async function dataUrlBlob(dataUrl: string) {
  return (await fetch(dataUrl)).blob();
}

/** Run YOLOE-26 on the photo with every prompt. */
export async function runDetection(photo: Blob, prompts: DetectionPrompt[], settings: Partial<DetectionRunSettings>): Promise<DetectionRunResult> {
  const form = new FormData();
  form.set("image", photo, photo.type === "image/png" ? "photo.png" : "photo.jpg");
  form.set("request", JSON.stringify({
    prompts: prompts.map((prompt) => (prompt.type === "text"
      ? { id: prompt.id, label: prompt.label, type: "text", text: prompt.text }
      : { id: prompt.id, label: prompt.label, type: "visual", source: prompt.source, boxes: prompt.boxes })),
    settings,
  }));
  for (const prompt of prompts) {
    if (prompt.type === "visual" && prompt.source === "upload") {
      if (!prompt.reference) throw new Error(`The reference image for “${prompt.label}” is missing. Upload it again.`);
      form.set(`reference:${prompt.id}`, await dataUrlBlob(prompt.reference), "reference.jpg");
    }
  }
  const response = await fetch("/api/detection/detect", { method: "POST", body: form });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; notReady?: boolean } & DetectionRunResult;
  if (!response.ok) {
    if (payload.notReady) throw new DetectionNotReady(payload.error ?? "The model is not downloaded yet.");
    throw new Error(payload.error ?? "Detection failed.");
  }
  return payload;
}

/** The saved file: everything needed to show the detections again and to repeat the run. */
export function buildDetectionFile(input: {
  imageName: string;
  imageSource?: string;
  /** `model` is null when every object was tagged by hand. */
  result: Omit<DetectionRunResult, "model"> & { model: DetectionModelInfo | null; removed: RemovedDetection[] };
  prompts: DetectionPrompt[];
  scale: DetectionScale;
  displayConfidence: number;
  createdAt: string;
}): DetectionFile {
  const { result, prompts, scale, displayConfidence } = input;
  return {
    format: DETECTION_FILE_FORMAT,
    version: DETECTION_FILE_VERSION,
    createdAt: input.createdAt,
    generator: { app: appMetadata.name, version: appMetadata.version },
    image: { name: input.imageName, width: result.width, height: result.height, ...(input.imageSource ? { source: input.imageSource } : {}) },
    model: result.model,
    prompts,
    scale,
    displayConfidence,
    detections: result.detections,
    removedDetections: result.removed,
    provenance: provenanceOf(result.detections, result.removed),
    statistics: computeStatistics(result.detections, prompts, result.width, result.height, scale, displayConfidence),
    timing: result.timing,
  };
}

/** A Save dialog in the desktop app; a download in a browser. */
export async function saveTextFile(name: string, text: string, filterName: string, extension: string, type: string) {
  const save = window.liberaExport?.saveTextFile;
  if (save) {
    const result = await save({ content: text, fileName: name, filterName, extensions: [extension] });
    return !result.canceled;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function csvCell(value: string | number) {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "") : value;
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

/** One row per detection, with sizes in the calibrated unit. */
export function detectionsCsv(detections: Detection[], scale: DetectionScale) {
  const length = scale.unit === "px" ? 1 : scale.perPixel;
  const unit = scale.unit;
  const header = ["id", "label", "origin", "confidence", "x1_px", "y1_px", "x2_px", "y2_px", "centroid_x_px", "centroid_y_px", `area_${unit}2`, `perimeter_${unit}`, `equivalent_diameter_${unit}`, "circularity"];
  const rows = detections.map((detection) => {
    const area = detection.area * length * length;
    return [
      detection.id,
      detection.label,
      detection.origin,
      // Hand-tagged objects have no model score.
      detection.origin === "manual" ? NaN : detection.confidence,
      ...detection.box,
      ...detection.centroid,
      area,
      detection.perimeter * length,
      2 * Math.sqrt(area / Math.PI),
      detection.perimeter > 0 ? Math.min(1, (4 * Math.PI * detection.area) / detection.perimeter ** 2) : NaN,
    ].map(csvCell).join(",");
  });
  return `${[header.join(","), ...rows].join("\n")}\n`;
}
