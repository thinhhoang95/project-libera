import { statSync } from "node:fs";
import path from "node:path";
import { defaultModelDirectory, huggingFaceUrl, sharedModelDownloader, type ModelDownloadFile } from "@/lib/models/downloader";

/**
 * Google's EmbeddingGemma 2 (Apache-2.0) in the ONNX build for Transformers.js,
 * as Libera downloads it: the 8-bit text model and vision encoder, which on a
 * CPU are as fast as the 4-bit ones and closer to the original (about 540 MB).
 * Pinned to one revision and checked by size and, for the large files, SHA-256.
 * Preferences → Search can name other weights instead.
 */
export const SEARCH_MODEL = {
  name: "EmbeddingGemma 2",
  repository: "onnx-community/embeddinggemma-2-ONNX",
  revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
  license: "Apache-2.0",
  textWeights: "onnx/model_quantized.onnx",
  visionWeights: "onnx/vision_encoder_quantized.onnx",
  files: [
    { path: "config.json", size: 5031, sha256: null },
    { path: "config_sentence_transformers.json", size: 1565, sha256: null },
    { path: "preprocessor_config.json", size: 560, sha256: null },
    { path: "processor_config.json", size: 1788, sha256: null },
    { path: "tokenizer.json", size: 32170510, sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4" },
    { path: "tokenizer_config.json", size: 1599, sha256: null },
    { path: "chat_template.jinja", size: 1016, sha256: null },
    { path: "onnx/model_quantized.onnx", size: 495165, sha256: "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953" },
    { path: "onnx/model_quantized.onnx_data", size: 313724928, sha256: "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b" },
    { path: "onnx/vision_encoder_quantized.onnx", size: 162495, sha256: "bb0de2df53a2448a32dc7908a187c168c8afd514d4d6f674f7f46024875fa4e3" },
    { path: "onnx/vision_encoder_quantized.onnx_data", size: 195228672, sha256: "3dabd69c0a36e9a8771ad82030dde74daa5a0e02b7047a5d3f3382b1137bab89" },
  ] as Array<{ path: string; size: number; sha256: string | null }>,
};

export function searchModelDownloadFiles(): ModelDownloadFile[] {
  return SEARCH_MODEL.files.map((file) => ({
    url: huggingFaceUrl(SEARCH_MODEL.repository, SEARCH_MODEL.revision, file.path),
    target: file.path,
    size: file.size,
    sha256: file.sha256,
  }));
}

function hasFile(filePath: string) {
  try {
    return statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/** A weight file is usable with its external data; files still downloading are named .part. */
function hasWeights(directory: string, relative: string) {
  return hasFile(path.join(directory, relative)) && hasFile(path.join(directory, `${relative}_data`));
}

/**
 * The downloaded weights, for when Preferences names none: each path is empty
 * until its files are in the default folder, and both stay empty while a
 * download runs, so the index does not switch models halfway. Synchronous,
 * since preferences are read on every search.
 */
export function downloadedSearchWeights() {
  const directory = defaultModelDirectory("search");
  const none = { directory, textWeights: "", visionWeights: "" };
  if (sharedModelDownloader("search").running) return none;
  if (!["config.json", "tokenizer.json", "tokenizer_config.json"].every((name) => hasFile(path.join(directory, name)))) return none;
  if (!hasWeights(directory, SEARCH_MODEL.textWeights)) return none;
  return {
    directory,
    textWeights: path.join(directory, SEARCH_MODEL.textWeights),
    visionWeights: hasWeights(directory, SEARCH_MODEL.visionWeights) ? path.join(directory, SEARCH_MODEL.visionWeights) : "",
  };
}
