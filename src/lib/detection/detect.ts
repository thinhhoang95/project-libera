import {
  DETECTION_TEXT_ENCODER,
  inspectDetectionFolder,
  type DetectionPreferences,
} from "../../../electron/detection-preferences.cjs";
import { DETECTION_RUNTIME } from "@/lib/detection/runtime";
import { detectionDirectory, detectionVariant, getDetectionPreferences } from "@/lib/detection/settings";
import { getDetectionWorker } from "@/lib/detection/worker-client";
import { measureDetection, type Box, type Detection, type DetectionModelInfo, type Point } from "@/lib/detection/results";

/** A prompt as the worker takes it, with a visual prompt's reference saved to a file. */
export type WorkerPrompt =
  | { id: string; label: string; type: "text"; text: string }
  | { id: string; label: string; type: "visual"; image: string; boxes: Box[] };

type WorkerResult = {
  width: number;
  height: number;
  detections: Array<{ cls: number; confidence: number; box: Box; polygon: Point[] }>;
  timing: Record<string, unknown>;
};

export type DetectionRunSettings = Pick<DetectionPreferences, "variant" | "confidence" | "iou" | "imageSize" | "maxDetections">;

export type DetectionRun = {
  width: number;
  height: number;
  detections: Detection[];
  model: DetectionModelInfo;
  timing: Record<string, unknown>;
};

export class DetectionNotReadyError extends Error {}

/** Run YOLOE-26 on one photo with every prompt at once; each prompt is a class. */
export async function runDetection(image: string, prompts: WorkerPrompt[], overrides: Partial<DetectionRunSettings>): Promise<DetectionRun> {
  const preferences = { ...getDetectionPreferences(), ...overrides };
  const variant = detectionVariant(preferences.variant);
  if (!variant) throw new Error("Unknown model variant.");
  const directory = detectionDirectory();
  const report = inspectDetectionFolder(directory);
  if (!report.runtime || !report.variants[variant.id] || (!report.textEncoder && prompts.some((prompt) => prompt.type === "text"))) {
    throw new DetectionNotReadyError(`${variant.name} is not downloaded yet.`);
  }

  const result = await getDetectionWorker().request<WorkerResult>(directory, {
    op: "detect",
    weights: variant.file,
    device: preferences.device,
    image,
    imageSize: preferences.imageSize,
    confidence: preferences.confidence,
    iou: preferences.iou,
    maxDetections: preferences.maxDetections,
    prompts: prompts.map((prompt) => (prompt.type === "text" ? { type: "text", text: prompt.text } : { type: "visual", image: prompt.image, boxes: prompt.boxes })),
  });

  const detections = result.detections
    .filter((raw) => prompts[raw.cls])
    .sort((a, b) => b.confidence - a.confidence)
    .map((raw, index): Detection => ({
      id: index + 1,
      promptId: prompts[raw.cls].id,
      label: prompts[raw.cls].label,
      confidence: raw.confidence,
      box: raw.box,
      polygon: raw.polygon,
      ...measureDetection(raw),
      origin: "model",
      shape: raw.polygon.length >= 3 ? "polygon" : "box",
    }));

  return {
    width: result.width,
    height: result.height,
    detections,
    timing: result.timing,
    model: {
      family: "YOLOE-26",
      variant: variant.id,
      name: variant.name,
      weights: variant.file,
      textEncoder: DETECTION_TEXT_ENCODER.file.replace(/\.ts$/, "").replace("mobileclip2_b", "MobileCLIP2-B"),
      framework: `Ultralytics ${DETECTION_RUNTIME.ultralytics}`,
      device: preferences.device,
      imageSize: preferences.imageSize,
      confidence: preferences.confidence,
      iou: preferences.iou,
      maxDetections: preferences.maxDetections,
    },
  };
}
