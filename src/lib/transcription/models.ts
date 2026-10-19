import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getTranscriptionPreferences } from "@/lib/transcription/settings";
import type { SpeechModelsStatus } from "@/lib/transcription/types";

/**
 * The local speech models, all run through sherpa-onnx:
 *
 * - NVIDIA Parakeet TDT 0.6B v3 (CC-BY-4.0), 25 European languages with
 *   punctuation, in sherpa-onnx's 8-bit export (about 670 MB);
 * - pyannote segmentation-3.0 (MIT), which finds who speaks when in windows of
 *   a few seconds (6 MB);
 * - 3D-Speaker CAM++ (Apache-2.0), a speaker embedding for Chinese and English
 *   speech that also tells apart voices in other languages, used to cluster
 *   pyannote's windows into speakers across the recording (28 MB).
 *
 * Like the EmbeddingGemma and granite-docling weights, they stay outside
 * Libera, in one folder chosen in Preferences → Speech, each in a subfolder.
 * Libera can download them there (pinned revisions, checked by size and
 * SHA-256), or the user can put other precisions of the same models there.
 */
type ModelFile = { path: string; size: number; sha256: string | null };
type ModelPart = { name: string; folder: string; repository: string; revision: string; license: string; files: ModelFile[] };

export const SPEECH_MODELS = {
  asr: {
    name: "Parakeet TDT 0.6B v3",
    folder: "parakeet-tdt-0.6b-v3",
    repository: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    revision: "2bda32ec70b097a55adaa07d9a7173915b43cc78",
    license: "CC-BY-4.0",
    files: [
      { path: "encoder.int8.onnx", size: 652184281, sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247" },
      { path: "decoder.int8.onnx", size: 11845275, sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e" },
      { path: "joiner.int8.onnx", size: 6355277, sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3" },
      { path: "tokens.txt", size: 93939, sha256: null },
    ],
  },
  segmentation: {
    name: "pyannote segmentation-3.0",
    folder: "pyannote-segmentation-3.0",
    repository: "csukuangfj/sherpa-onnx-pyannote-segmentation-3-0",
    revision: "9403a6902bb58e3d5ae8c7e77c3422de279db2e0",
    license: "MIT",
    files: [
      { path: "model.onnx", size: 5992913, sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079" },
    ],
  },
  embedding: {
    name: "3D-Speaker CAM++",
    folder: "speaker-embedding",
    repository: "csukuangfj/speaker-embedding-models",
    revision: "0743f301363dec56491a490f6d6cbc9d67f9a3bf",
    license: "Apache-2.0",
    files: [
      { path: "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx", size: 28281164, sha256: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2" },
    ],
  },
} satisfies Record<string, ModelPart>;

const ALL_PARTS: ModelPart[] = [SPEECH_MODELS.asr, SPEECH_MODELS.segmentation, SPEECH_MODELS.embedding];
export const SPEECH_MODELS_BYTES = ALL_PARTS.flatMap((part) => part.files).reduce((total, file) => total + file.size, 0);
const DIARIZATION_PARTS: ModelPart[] = [SPEECH_MODELS.segmentation, SPEECH_MODELS.embedding];

export type AsrModelFiles = { encoder: string; decoder: string; joiner: string; tokens: string };
export type DiarizationModelFiles = { segmentation: string; embedding: string };

export function speechModelsDirectory() {
  return getTranscriptionPreferences().modelDirectory;
}

async function fileSize(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}

async function listOnnx(directory: string) {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".onnx")).sort();
  } catch {
    return [];
  }
}

/** The 8-bit weights when present (as fast on a CPU and much smaller), otherwise full precision. */
function pickWeights(names: string[], prefix: string) {
  const matching = names.filter((name) => name.startsWith(prefix));
  return matching.find((name) => name.includes(".int8.")) ?? matching.find((name) => name === `${prefix}.onnx`) ?? matching[0];
}

export async function detectAsrModel(directory = speechModelsDirectory()): Promise<AsrModelFiles | null> {
  if (!directory) return null;
  const folder = path.join(directory, SPEECH_MODELS.asr.folder);
  const names = await listOnnx(folder);
  const encoder = pickWeights(names, "encoder");
  const decoder = pickWeights(names, "decoder");
  const joiner = pickWeights(names, "joiner");
  const tokens = path.join(folder, "tokens.txt");
  if (!encoder || !decoder || !joiner || (await fileSize(tokens)) <= 0) return null;
  return { encoder: path.join(folder, encoder), decoder: path.join(folder, decoder), joiner: path.join(folder, joiner), tokens };
}

export async function detectDiarizationModels(directory = speechModelsDirectory()): Promise<DiarizationModelFiles | null> {
  if (!directory) return null;
  const segmentationFolder = path.join(directory, SPEECH_MODELS.segmentation.folder);
  const segmentation = pickWeights(await listOnnx(segmentationFolder), "model");
  const embeddingFolder = path.join(directory, SPEECH_MODELS.embedding.folder);
  const embeddingNames = await listOnnx(embeddingFolder);
  const embedding = embeddingNames.includes(SPEECH_MODELS.embedding.files[0].path) ? SPEECH_MODELS.embedding.files[0].path : embeddingNames[0];
  if (!segmentation || !embedding) return null;
  return { segmentation: path.join(segmentationFolder, segmentation), embedding: path.join(embeddingFolder, embedding) };
}

function fileUrl(part: ModelPart, file: ModelFile) {
  return `https://huggingface.co/${part.repository}/resolve/${part.revision}/${file.path}`;
}

/**
 * Downloads the pinned files into the chosen folder. Each file arrives as
 * `name.part` and is renamed once its size and checksum are right, so the
 * folder never holds a broken weight file. An interrupted download resumes.
 */
class SpeechModelDownloader {
  private download: { directory: string; parts: ModelPart[]; totalBytes: number; downloadedBytes: number; error: string; running: boolean; controller: AbortController } | null = null;

  async getStatus(): Promise<SpeechModelsStatus> {
    const directory = speechModelsDirectory();
    const [asr, diarization] = await Promise.all([detectAsrModel(directory), detectDiarizationModels(directory)]);
    const base = {
      directory,
      asr: Boolean(asr),
      segmentation: Boolean(diarization),
      embedding: Boolean(diarization),
      downloadedBytes: 0,
      totalBytes: SPEECH_MODELS_BYTES,
      error: "",
    };
    const download = this.download?.directory === directory ? this.download : null;
    if (download?.running) return { ...base, state: "downloading", downloadedBytes: download.downloadedBytes, totalBytes: download.totalBytes };
    if (!directory) return { ...base, state: "unconfigured" };
    if (asr && diarization) return { ...base, state: "ready", downloadedBytes: SPEECH_MODELS_BYTES };
    if (download?.error) return { ...base, state: "error", error: download.error, downloadedBytes: download.downloadedBytes };
    return { ...base, state: "missing" };
  }

  /** `only: "diarization"` fetches just the small speaker models, for transcribing with OpenRouter. */
  start({ only }: { only?: "diarization" } = {}) {
    const directory = speechModelsDirectory();
    if (!directory) throw new Error("Choose a folder for the speech models in Preferences → Speech.");
    if (this.download?.running) return;
    const parts = only === "diarization" ? DIARIZATION_PARTS : ALL_PARTS;
    const controller = new AbortController();
    const download = {
      directory,
      parts,
      totalBytes: parts.flatMap((part) => part.files).reduce((total, file) => total + file.size, 0),
      downloadedBytes: 0,
      error: "",
      running: true,
      controller,
    };
    this.download = download;
    void this.run(download).catch((error: unknown) => {
      download.error = controller.signal.aborted ? "" : error instanceof Error ? error.message : "The model download failed.";
    }).finally(() => {
      download.running = false;
    });
  }

  cancel() {
    this.download?.controller.abort();
  }

  private async run(download: NonNullable<SpeechModelDownloader["download"]>) {
    const { directory, controller: { signal } } = download;
    let completedBytes = 0;
    for (const part of download.parts) {
      for (const file of part.files) {
        const target = path.join(directory, part.folder, file.path);
        const partial = `${target}.part`;
        if ((await fileSize(target)) === file.size) {
          completedBytes += file.size;
          download.downloadedBytes = completedBytes;
          continue;
        }

        await mkdir(path.dirname(target), { recursive: true });
        let offset = Math.max(0, await fileSize(partial));
        if (offset > file.size) {
          await rm(partial, { force: true });
          offset = 0;
        }
        const response = offset < file.size
          ? await fetch(fileUrl(part, file), { headers: offset ? { Range: `bytes=${offset}-` } : undefined, redirect: "follow", signal })
          : null;
        if (response) {
          if (!response.ok || !response.body) throw new Error(`Could not download ${file.path} (HTTP ${response.status}).`);
          // A server that ignores the range sends the whole file again.
          if (offset && response.status !== 206) offset = 0;
          download.downloadedBytes = completedBytes + offset;
          const counter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
              download.downloadedBytes += chunk.length;
              callback(null, chunk);
            },
          });
          await pipeline(
            Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
            counter,
            createWriteStream(partial, { flags: offset ? "a" : "w" }),
            { signal },
          );
        }

        if ((await fileSize(partial)) !== file.size) {
          await rm(partial, { force: true });
          throw new Error(`${file.path} arrived with the wrong size. Try the download again.`);
        }
        if (file.sha256) {
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(partial)) hash.update(chunk as Buffer);
          if (hash.digest("hex") !== file.sha256) {
            await rm(partial, { force: true });
            throw new Error(`${file.path} did not match its checksum. Try the download again.`);
          }
        }
        await rename(partial, target);
        completedBytes += file.size;
        download.downloadedBytes = completedBytes;
      }
    }
  }
}

const DOWNLOADER_KEY = Symbol.for("libera.speechModelDownloader");

export function getSpeechModelDownloader() {
  const store = globalThis as { [DOWNLOADER_KEY]?: SpeechModelDownloader };
  store[DOWNLOADER_KEY] ??= new SpeechModelDownloader();
  return store[DOWNLOADER_KEY];
}
