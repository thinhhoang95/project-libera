const fs = require("node:fs");
const path = require("node:path");

// Preferences → Detection and Segmentation. Like Read Aloud, the Electron
// main process saves these in the config file and the Next server reads them
// from there while it runs, so changes apply without a restart. A web
// deployment uses the LIBERA_DETECTION_* variables.

/**
 * The YOLOE-26 prompt models (text and visual prompts), smallest first, with
 * their LVIS minival mAP50-95 for text / visual prompts from Ultralytics.
 */
const DETECTION_VARIANTS = Object.freeze([
  Object.freeze({ id: "n", name: "YOLOE-26n", file: "yoloe-26n-seg.pt", size: 11710443, parameters: "4.8M", textMap: 24.7, visualMap: 21.9 }),
  Object.freeze({ id: "s", name: "YOLOE-26s", file: "yoloe-26s-seg.pt", size: 31072171, parameters: "13M", textMap: 30.8, visualMap: 28.6 }),
  Object.freeze({ id: "m", name: "YOLOE-26m", file: "yoloe-26m-seg.pt", size: 70443185, parameters: "28M", textMap: 35.4, visualMap: 33.9 }),
  Object.freeze({ id: "l", name: "YOLOE-26l", file: "yoloe-26l-seg.pt", size: 79417413, parameters: "32M", textMap: 37.8, visualMap: 36.3 }),
  Object.freeze({ id: "x", name: "YOLOE-26x", file: "yoloe-26x-seg.pt", size: 171640453, parameters: "70M", textMap: 40.6, visualMap: 38.5 }),
]);
const DETECTION_VARIANT_IDS = DETECTION_VARIANTS.map((variant) => variant.id);
/** MobileCLIP2-B, the text encoder YOLOE-26 turns text prompts into embeddings with. */
const DETECTION_TEXT_ENCODER = Object.freeze({ file: "mobileclip2_b.ts", size: 253794476 });
const DETECTION_DEVICES = ["cpu", "mps", "cuda"];
const DETECTION_IMAGE_SIZES = [640, 960, 1280];
const DEFAULT_DETECTION_PREFERENCES = Object.freeze({
  variant: "s",
  // The CPU always works; the GPU is opt-in.
  device: "cpu",
  confidence: 0.25,
  iou: 0.7,
  maxDetections: 300,
  imageSize: 640,
  modelDirectory: "",
});

function normalizePath(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) return "";
  return path.resolve(trimmed);
}

function normalizeNumber(value, min, max, fallback, digits = 2) {
  const number = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return fallback;
  const scale = 10 ** digits;
  return Math.round(Math.min(max, Math.max(min, number)) * scale) / scale;
}

function normalizeDetectionPreferences(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const imageSize = typeof value.imageSize === "string" ? Number.parseInt(value.imageSize, 10) : value.imageSize;

  return {
    variant: DETECTION_VARIANT_IDS.includes(value.variant) ? value.variant : DEFAULT_DETECTION_PREFERENCES.variant,
    device: DETECTION_DEVICES.includes(value.device) ? value.device : DEFAULT_DETECTION_PREFERENCES.device,
    confidence: normalizeNumber(value.confidence, 0.01, 0.99, DEFAULT_DETECTION_PREFERENCES.confidence),
    iou: normalizeNumber(value.iou, 0.05, 0.95, DEFAULT_DETECTION_PREFERENCES.iou),
    maxDetections: normalizeNumber(value.maxDetections, 1, 3000, DEFAULT_DETECTION_PREFERENCES.maxDetections, 0),
    imageSize: DETECTION_IMAGE_SIZES.includes(imageSize) ? imageSize : DEFAULT_DETECTION_PREFERENCES.imageSize,
    // Holds the weights and the Python runtime; empty uses Libera's application data.
    modelDirectory: normalizePath(value.modelDirectory),
  };
}

function isFileOfSize(filePath, size) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() && stats.size === size;
  } catch {
    return false;
  }
}

/** The Python inside the runtime's virtual environment. */
function detectionPythonPath(directory, platform = process.platform) {
  return platform === "win32"
    ? path.join(directory, "runtime", "venv", "Scripts", "python.exe")
    : path.join(directory, "runtime", "venv", "bin", "python");
}

/**
 * What a detection folder holds, for Preferences and the tool: whether the
 * Python runtime is installed, the text encoder, and which variants.
 */
function inspectDetectionFolder(directory) {
  const folder = normalizePath(directory);
  const variants = Object.fromEntries(DETECTION_VARIANTS.map((variant) => [variant.id, false]));
  if (!folder) return { exists: false, runtime: false, textEncoder: false, variants };
  let exists = false;
  try {
    exists = fs.statSync(folder).isDirectory();
  } catch {
    // Reported below.
  }
  for (const variant of DETECTION_VARIANTS) variants[variant.id] = isFileOfSize(path.join(folder, variant.file), variant.size);
  let runtime = false;
  try {
    runtime = fs.statSync(detectionPythonPath(folder)).isFile() && fs.existsSync(path.join(folder, "runtime", "installed.json"));
  } catch {
    // Not installed.
  }
  return {
    exists,
    runtime,
    textEncoder: isFileOfSize(path.join(folder, DETECTION_TEXT_ENCODER.file), DETECTION_TEXT_ENCODER.size),
    variants,
  };
}

/** Preferences from LIBERA_DETECTION_* variables, for deployments without the desktop config file. */
function detectionPreferencesFromEnvironment(env = process.env) {
  return normalizeDetectionPreferences({
    variant: env.LIBERA_DETECTION_VARIANT,
    device: env.LIBERA_DETECTION_DEVICE,
    confidence: env.LIBERA_DETECTION_CONFIDENCE,
    iou: env.LIBERA_DETECTION_IOU,
    maxDetections: env.LIBERA_DETECTION_MAX_DETECTIONS,
    imageSize: env.LIBERA_DETECTION_IMAGE_SIZE,
    modelDirectory: env.LIBERA_DETECTION_MODEL_DIR,
  });
}

module.exports = {
  DEFAULT_DETECTION_PREFERENCES,
  DETECTION_DEVICES,
  DETECTION_IMAGE_SIZES,
  DETECTION_TEXT_ENCODER,
  DETECTION_VARIANTS,
  detectionPreferencesFromEnvironment,
  detectionPythonPath,
  inspectDetectionFolder,
  normalizeDetectionPreferences,
};
