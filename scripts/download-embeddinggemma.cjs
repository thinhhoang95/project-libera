// Download EmbeddingGemma 2 (ONNX) for Global Search, outside the app.
//
//   npm run search:download-model -- [--dir ~/Models/embeddinggemma-2-ONNX] [--dtype q8|q4|q4f16|fp16|fp32] [--text-only]
//
// Then choose the printed weight files in Preferences → Search.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPOSITORY = "onnx-community/embeddinggemma-2-ONNX";
const SUFFIXES = { fp32: "", fp16: "_fp16", q8: "_quantized", q4: "_q4", q4f16: "_q4f16" };
const SHARED_FILES = [
  "config.json",
  "config_sentence_transformers.json",
  "preprocessor_config.json",
  "processor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "chat_template.jinja",
];

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function expandHome(value) {
  return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
}

async function download(file, directory) {
  const target = path.join(directory, ...file.split("/"));
  const url = `https://huggingface.co/${REPOSITORY}/resolve/main/${file}`;
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!head.ok) throw new Error(`${file}: HTTP ${head.status}`);
  const size = Number(head.headers.get("content-length") ?? 0);

  if (size && fs.existsSync(target) && fs.statSync(target).size === size) {
    console.log(`✓ ${file} (already downloaded)`);
    return target;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${file}: HTTP ${response.status}`);
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  fs.renameSync(partial, target);
  console.log(`✓ ${file}${size ? ` (${(size / 1e6).toFixed(1)} MB)` : ""}`);
  return target;
}

async function main() {
  const directory = path.resolve(expandHome(option("dir", path.join("~", "Models", "embeddinggemma-2-ONNX"))));
  const dtype = option("dtype", "q8");
  const suffix = SUFFIXES[dtype];
  if (suffix === undefined) throw new Error(`Unknown dtype ${dtype}. Use one of ${Object.keys(SUFFIXES).join(", ")}.`);

  const weights = [`model${suffix}`];
  if (!process.argv.includes("--text-only")) weights.push(`vision_encoder${suffix}`);

  console.log(`Downloading ${REPOSITORY} (${dtype}) to ${directory}`);
  for (const file of SHARED_FILES) await download(file, directory);
  for (const name of weights) {
    await download(`onnx/${name}.onnx`, directory);
    await download(`onnx/${name}.onnx_data`, directory);
  }

  console.log("\nIn Libera, open Preferences → Search and choose:");
  console.log(`  Text model weights:     ${path.join(directory, "onnx", `${weights[0]}.onnx`)}`);
  if (weights[1]) console.log(`  Vision encoder weights: ${path.join(directory, "onnx", `${weights[1]}.onnx`)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
