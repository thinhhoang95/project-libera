// Background worker for Global Search.
//
// The Next server forks this file as a separate Node process (Electron runs it
// with ELECTRON_RUN_AS_NODE), so model inference and PDF parsing never block
// the app, a crash cannot take the app down, and the memory is returned when
// the worker exits after a quiet spell.
//
// The model is EmbeddingGemma 2 through Transformers.js on the CPU. Its weights
// stay outside the app: the user designates a text model file and, optionally,
// a vision encoder file in Preferences → Search. The tokenizer and configs are
// read from the text model's folder (or the folder above an `onnx/` folder),
// and the two weight files are served to Transformers.js from wherever they
// are, so they can live in different places. The model loads on first use.
//
// Protocol (process.send / "message", advanced serialization):
//   → { id, type: "configure", config: { textWeights, visionWeights, threads, visionTokens } }
//   → { id, type: "load" }                          ← { textDtype, visionDtype, vision, loadMs }
//   → { id, type: "embed", inputs, priority }       ← Float32Array[] (unit length, one per input)
//   → { id, type: "pdf-text", path, from, to }      ← { numPages, pages: [{ pageNumber, items }] }
//   → { id, type: "pdf-close", path }
// An embed input is { text?: string, images?: ImageSource[] } and an
// ImageSource is { path } or { data: Uint8Array }. A text may contain
// `<|image|>` placeholders that are filled from its images in order.
// Requests run in order, except `priority: "query"` embeddings, which skip the
// queue. The model still runs one inference at a time, so the server keeps
// indexing batches small and pauses them while someone is searching.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const WEIGHT_FILE_PATTERN = /^(model|vision_encoder)(_fp16|_q4f16|_q4|_quantized|_int8|_uint8|_bnb4)?\.onnx$/;
const DTYPE_BY_SUFFIX = {
  "": "fp32",
  _fp16: "fp16",
  _q4f16: "q4f16",
  _q4: "q4",
  _quantized: "q8",
  _int8: "int8",
  _uint8: "uint8",
  _bnb4: "bnb4",
};
const IMAGE_PLACEHOLDER = "<|image|>";
const VISION_TOKEN_BUDGETS = new Set([70, 140, 280, 560, 1120]);
// Chunks are a few hundred tokens; this only guards against pathological input.
const MAX_TEXT_TOKENS = 2048;

let transformers = null;
let config = {};
let modelPromise = null;

function describeWeights(filePath, expectedName) {
  const resolved = path.resolve(filePath);
  const match = WEIGHT_FILE_PATTERN.exec(path.basename(resolved));

  if (!match || match[1] !== expectedName) {
    throw new Error(
      `${expectedName === "model" ? "The text model" : "The vision encoder"} file must be named like ` +
        `${expectedName}_q4.onnx (found ${path.basename(resolved)}).`,
    );
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Weights file not found: ${resolved}`);
  }

  return { path: resolved, dtype: DTYPE_BY_SUFFIX[match[2] ?? ""], fileName: path.basename(resolved) };
}

/** The folder with config.json and tokenizer.json: next to the weights, or above an `onnx/` folder. */
function findModelDirectory(weightsPath) {
  const directory = path.dirname(weightsPath);

  for (const candidate of [directory, path.dirname(directory)]) {
    if (fs.existsSync(path.join(candidate, "config.json")) && fs.existsSync(path.join(candidate, "tokenizer.json"))) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find config.json and tokenizer.json next to ${path.basename(weightsPath)} or in the folder above it.`,
  );
}

function externalDataCount(modelConfig, fileName) {
  const value = modelConfig?.["transformers.js_config"]?.use_external_data_format;
  if (!value) return 0;
  if (typeof value === "object") return Number(value[fileName] ?? 0);
  return Number(value);
}

function externalDataPaths(modelConfig, weights) {
  return Array.from({ length: externalDataCount(modelConfig, weights.fileName) }, (_, index) => {
    const suffix = `_data${index === 0 ? "" : `_${index}`}`;
    return { key: `onnx/${weights.fileName}${suffix}`, path: `${weights.path}${suffix}` };
  });
}

async function loadModel() {
  const started = Date.now();
  transformers ??= await import("@huggingface/transformers");
  const { AutoConfig, AutoModel, AutoProcessor, env } = transformers;

  if (typeof config.textWeights !== "string" || !config.textWeights.trim()) {
    throw new Error("Choose the EmbeddingGemma 2 text model weights in Preferences → Search.");
  }

  const text = describeWeights(config.textWeights.trim(), "model");
  const vision = typeof config.visionWeights === "string" && config.visionWeights.trim()
    ? describeWeights(config.visionWeights.trim(), "vision_encoder")
    : null;
  const modelDirectory = findModelDirectory(text.path);
  const rawConfig = JSON.parse(fs.readFileSync(path.join(modelDirectory, "config.json"), "utf8"));

  // Serve the designated weight files (and their external data) wherever they
  // are. Transformers.js asks its cache first, by local path and by Hub URL.
  const redirects = new Map();
  for (const weights of [text, vision].filter(Boolean)) {
    redirects.set(`onnx/${weights.fileName}`, weights.path);
    for (const data of externalDataPaths(rawConfig, weights)) {
      if (!fs.existsSync(data.path)) {
        throw new Error(`${path.basename(data.path)} must be in the same folder as ${weights.fileName}.`);
      }
      redirects.set(data.key, data.path);
    }
  }

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useCustomCache = true;
  env.customCache = {
    async match(key) {
      const normalized = String(key).replaceAll("\\", "/");
      for (const [suffix, target] of redirects) {
        if (normalized.endsWith(`/${suffix}`)) return target;
      }
      return undefined;
    },
    async put() {},
  };

  const modelConfig = await AutoConfig.from_pretrained(modelDirectory);
  // Load only what is needed: audio is never used, vision only when designated.
  modelConfig.audio_config = null;
  if (!vision) modelConfig.vision_config = null;

  const threads = Number.isInteger(config.threads) && config.threads > 0 ? config.threads : undefined;
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(modelDirectory),
    AutoModel.from_pretrained(modelDirectory, {
      config: modelConfig,
      device: "cpu",
      dtype: vision ? { model: text.dtype, vision_encoder: vision.dtype } : { model: text.dtype },
      session_options: threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : undefined,
    }),
  ]);

  // Fewer soft tokens per image trade a little precision for much faster indexing.
  if (vision && VISION_TOKEN_BUDGETS.has(config.visionTokens) && processor.image_processor) {
    processor.image_processor.max_soft_tokens = config.visionTokens;
  }

  return {
    model,
    processor,
    info: {
      textDtype: text.dtype,
      visionDtype: vision?.dtype ?? null,
      vision: Boolean(vision),
      modelDirectory,
      loadMs: Date.now() - started,
    },
  };
}

function getModel() {
  modelPromise ??= loadModel().catch((error) => {
    modelPromise = null;
    throw error;
  });
  return modelPromise;
}

async function readImage(source) {
  const { RawImage } = transformers;

  if (source && typeof source.path === "string") {
    return RawImage.fromBlob(new Blob([fs.readFileSync(source.path)]));
  }

  if (source?.data instanceof Uint8Array) {
    return RawImage.fromBlob(new Blob([source.data]));
  }

  throw new Error("Image input is invalid.");
}

function unitRows(tensor) {
  const [rows, width] = tensor.dims;
  const vectors = [];

  for (let row = 0; row < rows; row += 1) {
    const vector = new Float32Array(tensor.data.subarray(row * width, (row + 1) * width));
    let norm = 0;
    for (let index = 0; index < width; index += 1) norm += vector[index] * vector[index];
    norm = Math.sqrt(norm) || 1;
    for (let index = 0; index < width; index += 1) vector[index] /= norm;
    vectors.push(vector);
  }

  return vectors;
}

async function embed(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("Embedding inputs are invalid.");

  const { model, processor, info } = await getModel();
  const results = new Array(inputs.length);
  const textOnly = [];
  const imageOnly = [];

  inputs.forEach((input, index) => {
    const imageCount = Array.isArray(input?.images) ? input.images.length : 0;
    const hasText = typeof input?.text === "string" && input.text.length > 0;
    if (imageCount && !info.vision) {
      throw new Error("Image search needs the EmbeddingGemma 2 vision encoder. Choose it in Preferences → Search.");
    }
    if (!hasText && !imageCount) throw new Error("An embedding input is empty.");
    if (!imageCount) textOnly.push(index);
    else if (!hasText && imageCount === 1) imageOnly.push(index);
  });

  if (textOnly.length) {
    const encoded = processor.tokenizer(textOnly.map((index) => inputs[index].text), {
      padding: true,
      truncation: true,
      max_length: MAX_TEXT_TOKENS,
    });
    const output = await model({ input_ids: encoded.input_ids, attention_mask: encoded.attention_mask });
    unitRows(output.sentence_embedding).forEach((vector, position) => { results[textOnly[position]] = vector; });
  }

  // Single images share one encoder run: one list per sample.
  if (imageOnly.length) {
    const images = [];
    for (const index of imageOnly) images.push([await readImage(inputs[index].images[0])]);
    const output = await model(await processor(null, images));
    unitRows(output.sentence_embedding).forEach((vector, position) => { results[imageOnly[position]] = vector; });
  }

  // Text with images, or several images, form one combined sample each.
  for (let index = 0; index < inputs.length; index += 1) {
    if (results[index]) continue;
    const input = inputs[index];
    const images = [];
    for (const source of input.images) images.push(await readImage(source));
    const text = input.text || "";
    const placeholders = text.split(IMAGE_PLACEHOLDER).length - 1;
    const prompt = placeholders === images.length
      ? text
      : `${IMAGE_PLACEHOLDER.repeat(images.length)} ${text.replaceAll(IMAGE_PLACEHOLDER, "")}`.trim();
    const output = await model(await processor([prompt], [images]));
    results[index] = unitRows(output.sentence_embedding)[0];
  }

  return results;
}

// PDF text extraction runs here too, so large PDFs never stall the app. The
// raw text items go back to the server, which normalizes them exactly like
// the PDF text cache does. Open documents are kept between page ranges.
const pdfDocuments = new Map();
let pdfjs = null;

async function openPdf(filePath) {
  const cached = pdfDocuments.get(filePath);
  if (cached) return cached;

  if (!pdfjs) {
    pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  }

  const standardFontDataUrl = pathToFileURL(
    `${path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts")}${path.sep}`,
  ).href;
  const document = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(filePath)),
    disableFontFace: true,
    standardFontDataUrl,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;
  pdfDocuments.set(filePath, document);
  return document;
}

async function closePdf(filePath) {
  const document = pdfDocuments.get(filePath);
  pdfDocuments.delete(filePath);
  await document?.destroy().catch(() => undefined);
  return true;
}

async function pdfText({ path: filePath, from = 1, to = Number.POSITIVE_INFINITY }) {
  if (typeof filePath !== "string" || !filePath) throw new Error("PDF path is invalid.");
  const document = await openPdf(filePath);
  const pages = [];
  const last = Math.min(document.numPages, to);

  for (let pageNumber = Math.max(1, from); pageNumber <= last; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({
      pageNumber,
      items: content.items
        .filter((item) => typeof item?.str === "string")
        .map((item) => ({ str: item.str, hasEOL: Boolean(item.hasEOL) })),
    });
    page.cleanup();
  }

  if (last >= document.numPages) await closePdf(filePath);
  return { numPages: document.numPages, pages };
}

async function handle(message) {
  switch (message?.type) {
    case "configure":
      config = message.config ?? {};
      void modelPromise?.then(({ model }) => model.dispose?.()).catch(() => undefined);
      modelPromise = null;
      return true;
    case "load":
      return (await getModel()).info;
    case "embed":
      return embed(message.inputs);
    case "pdf-text":
      return pdfText(message);
    case "pdf-close":
      return closePdf(message.path);
    default:
      throw new Error(`Unknown request: ${String(message?.type)}`);
  }
}

async function respond(message) {
  try {
    const result = await handle(message);
    process.send?.({ id: message?.id, ok: true, result });
  } catch (error) {
    process.send?.({ id: message?.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

let queue = Promise.resolve();

process.on("message", (message) => {
  if (message?.type === "embed" && message.priority === "query") {
    void respond(message);
    return;
  }
  queue = queue.then(() => respond(message));
});

process.on("disconnect", () => process.exit(0));
process.send?.({ type: "ready" });
