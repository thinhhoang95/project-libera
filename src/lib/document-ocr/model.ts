import path from "node:path";
import { defaultModelDirectory, fileSize, huggingFaceUrl, sharedModelDownloader } from "@/lib/models/downloader";
import { getSearchPreferences } from "@/lib/search/settings";

/**
 * The PDF reading model: IBM granite-docling-258M (Apache-2.0) in the ONNX
 * build for Transformers.js. It reads a page image and writes DocTags, which
 * `doctags.ts` turns into Markdown.
 *
 * Libera downloads it into its application data, or into a folder chosen in
 * Preferences → Search, laid out like its Hugging Face repository (configs at
 * the top, weights in `onnx/`); the user can also put the files there.
 *
 * The download is pinned to one revision and checked against file sizes and,
 * for the weights, SHA-256. It takes the full-precision vision encoder, since
 * the 8-bit one misreads text badly (names garbled, then repetition loops),
 * and the 8-bit decoder and token embeddings, which read correctly and run
 * well on the CPU: about 600 MB in all. A folder with other precisions works too.
 */
export const DOCUMENT_OCR_MODEL = {
  name: "granite-docling-258M",
  repository: "onnx-community/granite-docling-258M-ONNX",
  revision: "e8602580df77443fc3421cf3bae0601da601e5c6",
  license: "Apache-2.0",
  files: [
    { path: "config.json", size: 1819, sha256: null },
    { path: "generation_config.json", size: 174, sha256: null },
    { path: "preprocessor_config.json", size: 486, sha256: null },
    { path: "processor_config.json", size: 68, sha256: null },
    { path: "special_tokens_map.json", size: 1078, sha256: null },
    { path: "tokenizer.json", size: 4131145, sha256: null },
    { path: "tokenizer_config.json", size: 18616, sha256: null },
    { path: "added_tokens.json", size: 35, sha256: null },
    { path: "chat_template.jinja", size: 588, sha256: null },
    { path: "onnx/vision_encoder.onnx", size: 296983, sha256: "6e36ea30b1d36caf50ef040c98529796477be614e2b6b89a70afefb5b4a5d394" },
    { path: "onnx/vision_encoder.onnx_data", size: 374043648, sha256: "f7ffa6adbcd3ba15c3419b65497a096dd6e2bd4e7a6dc739a196e603a6400318" },
    { path: "onnx/embed_tokens_quantized.onnx", size: 767, sha256: "b9832aee6f125d71ff52fd4a31d305ecd44d721a746a18856663514600ac5d74" },
    { path: "onnx/embed_tokens_quantized.onnx_data", size: 57802752, sha256: "f384533f15a3caf44f8fc541984776e6d06c24c2251752e13c8aa7b34907b810" },
    { path: "onnx/decoder_model_merged_quantized.onnx", size: 1758534, sha256: "81560c7e40adbbb9c934c8677885b94ab39e70201a8479743fc968dcfae25d63" },
    { path: "onnx/decoder_model_merged_quantized.onnx_data", size: 166208768, sha256: "29ad09d8d5808e3c3182e77797b6396d842192d56c5c51131e92b29132e640dc" },
  ] as Array<{ path: string; size: number; sha256: string | null }>,
};

export const DOCUMENT_OCR_MODEL_BYTES = DOCUMENT_OCR_MODEL.files.reduce((total, file) => total + file.size, 0);

const REQUIRED_CONFIGS = ["config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "processor_config.json"];
// Weight precisions in order of preference for each part, by file suffix.
// The vision encoder needs full precision to read small print; the text
// parts read correctly at 8-bit, which is faster on the CPU.
const DTYPE_SUFFIXES: Record<string, string> = { fp32: "", q8: "_quantized", int8: "_int8", uint8: "_uint8", fp16: "_fp16", q4: "_q4", q4f16: "_q4f16", bnb4: "_bnb4" };
const DTYPE_PREFERENCE: Record<string, string[]> = {
  vision_encoder: ["fp32", "fp16", "q8", "int8", "uint8", "q4", "q4f16", "bnb4"],
  embed_tokens: ["q8", "int8", "uint8", "fp32", "fp16", "q4", "q4f16"],
  decoder_model_merged: ["q8", "fp32", "int8", "uint8", "q4", "fp16", "q4f16"],
};

export type DocumentOcrDtype = Record<keyof typeof DTYPE_PREFERENCE, string>;

/** The folder from Preferences → Search, or Libera's download folder. */
export function documentOcrModelDirectory() {
  const chosen = getSearchPreferences().readingModelDirectory;
  if (chosen) return path.basename(chosen) === "onnx" ? path.dirname(chosen) : chosen;
  return defaultModelDirectory("reading");
}

/** The weight precision to load for each part, or null when the folder lacks a usable model. */
export async function detectDocumentOcrModel(directory: string): Promise<DocumentOcrDtype | null> {
  if (!directory) return null;

  for (const name of REQUIRED_CONFIGS) {
    if ((await fileSize(path.join(directory, name))) <= 0) return null;
  }

  const dtype: Partial<DocumentOcrDtype> = {};
  for (const [part, preference] of Object.entries(DTYPE_PREFERENCE)) {
    for (const choice of preference) {
      const base = path.join(directory, "onnx", `${part}${DTYPE_SUFFIXES[choice]}.onnx`);
      if ((await fileSize(base)) > 0 && (await fileSize(`${base}_data`)) > 0) {
        dtype[part as keyof DocumentOcrDtype] = choice;
        break;
      }
    }
    if (!dtype[part as keyof DocumentOcrDtype]) return null;
  }

  return dtype as DocumentOcrDtype;
}

export type DocumentOcrModelStatus = {
  state: "missing" | "downloading" | "ready" | "error";
  directory: string;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
};

const downloader = () => sharedModelDownloader("reading");

export async function getDocumentOcrModelStatus(): Promise<DocumentOcrModelStatus> {
  const directory = documentOcrModelDirectory();
  const base = { directory, downloadedBytes: 0, totalBytes: DOCUMENT_OCR_MODEL_BYTES, error: "" };
  const download = downloader().progress(directory);
  if (download?.running) return { ...base, state: "downloading", downloadedBytes: download.downloadedBytes };
  if (await detectDocumentOcrModel(directory)) return { ...base, state: "ready", downloadedBytes: DOCUMENT_OCR_MODEL_BYTES };
  if (download?.error) return { ...base, state: "error", error: download.error, downloadedBytes: download.downloadedBytes };
  return { ...base, state: "missing" };
}

/** Download the pinned files into the model folder; an interrupted download resumes. */
export function startDocumentOcrModelDownload() {
  downloader().start(documentOcrModelDirectory(), DOCUMENT_OCR_MODEL.files.map((file) => ({
    url: huggingFaceUrl(DOCUMENT_OCR_MODEL.repository, DOCUMENT_OCR_MODEL.revision, file.path),
    target: file.path,
    size: file.size,
    sha256: file.sha256,
  })));
}

export function cancelDocumentOcrModelDownload() {
  downloader().cancel();
}
