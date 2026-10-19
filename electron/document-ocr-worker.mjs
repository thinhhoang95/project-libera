// Worker for reading PDF pages and snips into Markdown.
//
// The Next server forks this file as a separate Node process (Electron runs it
// with ELECTRON_RUN_AS_NODE), like the search worker, so inference never
// blocks the app and its memory is returned when the worker exits after a
// quiet spell.
//
// The model is IBM granite-docling-258M through Transformers.js on the CPU. It
// reads a page image and writes DocTags; the server converts those to
// Markdown. The model files are downloaded by the server into one folder,
// which this worker only reads.
//
// Protocol (process.send / "message", advanced serialization):
//   → { id, type: "configure", config: { modelDirectory, threads, dtype } }
//   → { id, type: "load" }                              ← { loadMs }
//   → { id, type: "convert", image, maxNewTokens, maxEdge } ← { doctags, tokens, stopped, ms }
//   → { id, type: "cancel", target }                    stops request `target` early
// `image` is the encoded image as a Uint8Array. The model cuts an image into
// 512 px tiles plus one overview, and each tile costs most of the time on a
// CPU, so the image is scaled to the fewest tiles that fit it, capped by
// `maxEdge` (2048 px by default, the scale the model was trained on; at
// 1536 px it misreads small print).
// `stopped` is "eos", "length", "loop" or "cancelled". Conversions run one at
// a time; cancel skips the queue.

import fs from "node:fs";
import path from "node:path";
import { completeBlocks, loopCutoff } from "./document-ocr-loop.mjs";

const PROMPT = "Convert this page to docling.";
const DOCTAG_START = "<doctag>";
const TILE = 512;
const DEFAULT_MAX_EDGE = 2048;

let transformers = null;
let config = {};
let modelPromise = null;
const running = new Map();
// Conversions cancelled while still queued, and the newest one that started.
const cancelledBeforeStart = new Set();
let lastStartedId = 0;

async function loadModel() {
  const started = Date.now();
  transformers ??= await import("@huggingface/transformers");
  const { AutoModelForVision2Seq, AutoProcessor, env } = transformers;

  if (typeof config.modelDirectory !== "string" || !config.modelDirectory) {
    throw new Error("The PDF reading model is not installed.");
  }

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useFSCache = false;

  const threads = Number.isInteger(config.threads) && config.threads > 0 ? config.threads : undefined;
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(config.modelDirectory),
    AutoModelForVision2Seq.from_pretrained(config.modelDirectory, {
      device: "cpu",
      dtype: config.dtype,
      session_options: {
        ...(threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {}),
        // Allocate each tensor on its own. The default arena grows in
        // power-of-two chunks and the memory planner reserves one block for
        // all intermediates; for a page of tiles those requests reach several
        // GB. Inside Electron, native memory comes from Chromium's allocator,
        // which crashes the process (SIGTRAP) instead of failing such a request.
        enableCpuMemArena: false,
        enableMemPattern: false,
      },
    }),
  ]);

  const vocabulary = JSON.parse(fs.readFileSync(path.join(config.modelDirectory, "tokenizer.json"), "utf8"));
  const locationIds = new Set(
    (vocabulary.added_tokens ?? []).filter((token) => /^<loc_\d+>$/.test(token.content)).map((token) => token.id),
  );

  return { model, processor, locationIds, info: { loadMs: Date.now() - started } };
}

function getModel() {
  modelPromise ??= loadModel().catch((error) => {
    modelPromise = null;
    throw error;
  });
  return modelPromise;
}

function createStopper(transformersModule, promptLength, locationIds) {
  const { StoppingCriteria } = transformersModule;

  class ConversionStopper extends StoppingCriteria {
    cancelled = false;
    loop = null;

    _call(inputIds) {
      return inputIds.map((ids) => {
        if (this.cancelled) return true;
        const keep = loopCutoff(ids.slice(promptLength).map(Number), locationIds);
        if (keep !== null) {
          // Keep one copy of the cycle; drop the repeats.
          this.loop = { keep };
          return true;
        }
        return false;
      });
    }
  }

  return new ConversionStopper();
}

/** The long edge to scale to: a whole number of tiles, enough for the image, at most `maxEdge`. */
function targetEdge(picture, maxEdge) {
  const limit = Math.max(TILE, Math.min(2048, Math.floor((Number(maxEdge) || DEFAULT_MAX_EDGE) / TILE) * TILE));
  const longest = Math.max(picture.width, picture.height);
  return Math.min(limit, Math.max(TILE, Math.ceil(longest / TILE) * TILE));
}

async function convert({ id, image, maxNewTokens = 4096, maxEdge }) {
  if (!(image instanceof Uint8Array) || !image.length) throw new Error("The image is missing.");

  const started = Date.now();
  // Stands in for the stopper while the model loads and the image is prepared.
  const pending = { cancelled: false };
  running.set(id, pending);

  try {
    const { model, processor, locationIds } = await getModel();
    const { RawImage } = transformers;
    const picture = await RawImage.fromBlob(new Blob([image]));
    const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: PROMPT }] }];
    // Start the reply with <doctag>: otherwise the model sometimes answers in
    // prose (a summary of the page) instead of transcribing it.
    const prompt = `${processor.apply_chat_template(messages, { add_generation_prompt: true })}${DOCTAG_START}`;
    processor.image_processor.size = { longest_edge: targetEdge(picture, maxEdge) };
    const inputs = await processor(prompt, [picture], { do_image_splitting: true });
    if (pending.cancelled) throw new Error("Cancelled.");

    const promptLength = inputs.input_ids.dims.at(-1);
    const stopper = createStopper(transformers, promptLength, locationIds);
    running.set(id, stopper);

    const output = await model.generate({
      ...inputs,
      max_new_tokens: Math.max(16, Math.min(8192, Number(maxNewTokens) || 4096)),
      do_sample: false,
      stopping_criteria: [stopper],
    });

    let generated = Array.from(output.slice(null, [promptLength, null]).data, Number);
    if (stopper.loop) generated = generated.slice(0, stopper.loop.keep);
    let doctags = DOCTAG_START + processor.tokenizer.decode(generated, { skip_special_tokens: false });
    // The block a loop starts in is unreliable: the model usually invents
    // its text before repeating it. Keep complete blocks only.
    if (stopper.loop) doctags = completeBlocks(doctags);
    const eos = model.generation_config?.eos_token_id ?? processor.tokenizer.eos_token_id;
    const eosIds = new Set([eos].flat().map(Number));
    const stopped = stopper.cancelled
      ? "cancelled"
      : stopper.loop
        ? "loop"
        : eosIds.has(generated.at(-1))
          ? "eos"
          : "length";

    return { doctags, tokens: generated.length, stopped, ms: Date.now() - started };
  } finally {
    running.delete(id);
  }
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
    case "convert":
      return convert(message);
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
  if (message?.type === "cancel") {
    const stopper = running.get(message.target);
    if (stopper) stopper.cancelled = true;
    // A conversion still waiting in the queue is skipped when its turn comes.
    else if (message.target > lastStartedId) cancelledBeforeStart.add(message.target);
    return;
  }

  queue = queue.then(() => {
    if (typeof message?.id === "number") lastStartedId = Math.max(lastStartedId, message.id);
    if (cancelledBeforeStart.delete(message?.id)) {
      process.send?.({ id: message.id, ok: false, error: "Cancelled." });
      return undefined;
    }
    return respond(message);
  });
});

process.on("disconnect", () => process.exit(0));
process.send?.({ type: "ready" });
