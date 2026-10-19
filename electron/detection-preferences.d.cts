export type DetectionVariantId = "n" | "s" | "m" | "l" | "x";

export type DetectionVariant = {
  id: DetectionVariantId;
  name: string;
  /** The checkpoint in Ultralytics' v8.4.0 release. */
  file: string;
  size: number;
  parameters: string;
  /** LVIS minival mAP50-95 with text prompts. */
  textMap: number;
  /** LVIS minival mAP50-95 with visual prompts. */
  visualMap: number;
};

export type DetectionPreferences = {
  variant: DetectionVariantId;
  /** Where PyTorch runs the model: the CPU, Apple's GPU (Metal) or an NVIDIA GPU. */
  device: "cpu" | "mps" | "cuda";
  /** Detections below this score are dropped, 0.01–0.99. */
  confidence: number;
  /** Overlap above which a weaker box is suppressed, 0.05–0.95. */
  iou: number;
  maxDetections: number;
  /** The longer side the photo is resized to before inference. */
  imageSize: 640 | 960 | 1280;
  /** Holds the weights and the Python runtime; empty when not chosen. */
  modelDirectory: string;
};

export type DetectionFolderReport = {
  exists: boolean;
  /** The Python runtime with Ultralytics is installed. */
  runtime: boolean;
  /** MobileCLIP2-B, needed for text prompts. */
  textEncoder: boolean;
  variants: Record<DetectionVariantId, boolean>;
};

export const DEFAULT_DETECTION_PREFERENCES: Readonly<DetectionPreferences>;
export const DETECTION_DEVICES: DetectionPreferences["device"][];
export const DETECTION_IMAGE_SIZES: DetectionPreferences["imageSize"][];
export const DETECTION_TEXT_ENCODER: Readonly<{ file: string; size: number }>;
export const DETECTION_VARIANTS: ReadonlyArray<Readonly<DetectionVariant>>;
export function detectionPreferencesFromEnvironment(env?: NodeJS.ProcessEnv): DetectionPreferences;
export function detectionPythonPath(directory: string, platform?: string): string;
export function inspectDetectionFolder(directory: unknown): DetectionFolderReport;
export function normalizeDetectionPreferences(input: unknown): DetectionPreferences;
