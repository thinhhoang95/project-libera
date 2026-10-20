import { existsSync } from "node:fs";
import {
  DOCUMENT_OCR_MODEL,
  cancelDocumentOcrModelDownload,
  getDocumentOcrModelStatus,
  startDocumentOcrModelDownload,
} from "@/lib/document-ocr/model";
import { defaultModelDirectory, sharedModelDownloader } from "@/lib/models/downloader";
import { SEARCH_MODEL, searchModelDownloadFiles } from "@/lib/search/model";
import { getChosenSearchPreferences, getSearchPreferences } from "@/lib/search/settings";
import { KOKORO_MODEL, cancelKokoroModelDownload, getKokoroModelStatus, startKokoroModelDownload } from "@/lib/tts/kokoro";

/**
 * The local models a feature can ask the user to download with one click:
 * EmbeddingGemma 2 for Global Search, granite-docling for reading PDFs and
 * Kokoro for reading aloud. The speech models have their own setup in the
 * transcript panel (src/lib/transcription/models.ts).
 */
export const LOCAL_MODEL_IDS = ["search", "reading", "read-aloud"] as const;
export type LocalModelId = (typeof LOCAL_MODEL_IDS)[number];

export type LocalModelStatus = {
  id: LocalModelId;
  name: string;
  license: string;
  state: "missing" | "downloading" | "ready" | "error";
  directory: string;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
};

const SEARCH_BYTES = SEARCH_MODEL.files.reduce((total, file) => total + file.size, 0);

async function searchModelStatus(): Promise<Omit<LocalModelStatus, "id" | "name" | "license">> {
  const directory = defaultModelDirectory("search");
  const chosen = getChosenSearchPreferences().textWeights;
  const base = { directory, downloadedBytes: 0, totalBytes: SEARCH_BYTES, error: "" };
  if (chosen) {
    return existsSync(chosen)
      ? { ...base, directory: chosen, state: "ready", downloadedBytes: SEARCH_BYTES }
      : { ...base, directory: chosen, state: "error", error: "The weights chosen in Preferences → Search are missing. Choose them again, or clear the field to use Libera’s download." };
  }
  const download = sharedModelDownloader("search").progress(directory);
  if (download?.running) return { ...base, state: "downloading", downloadedBytes: download.downloadedBytes };
  if (getSearchPreferences().textWeights) return { ...base, state: "ready", downloadedBytes: SEARCH_BYTES };
  if (download?.error) return { ...base, state: "error", error: download.error, downloadedBytes: download.downloadedBytes };
  return { ...base, state: "missing" };
}

const MODELS: Record<LocalModelId, {
  name: string;
  license: string;
  status: () => Promise<Omit<LocalModelStatus, "id" | "name" | "license">>;
  start: () => void;
  cancel: () => void;
}> = {
  search: {
    name: SEARCH_MODEL.name,
    license: SEARCH_MODEL.license,
    status: searchModelStatus,
    start: () => {
      if (getChosenSearchPreferences().textWeights) throw new Error("Preferences → Search names other weights. Clear them to use Libera’s download.");
      sharedModelDownloader("search").start(defaultModelDirectory("search"), searchModelDownloadFiles());
    },
    cancel: () => sharedModelDownloader("search").cancel(),
  },
  reading: {
    name: DOCUMENT_OCR_MODEL.name,
    license: DOCUMENT_OCR_MODEL.license,
    status: getDocumentOcrModelStatus,
    start: startDocumentOcrModelDownload,
    cancel: cancelDocumentOcrModelDownload,
  },
  "read-aloud": {
    name: KOKORO_MODEL.name,
    license: KOKORO_MODEL.license,
    status: getKokoroModelStatus,
    start: startKokoroModelDownload,
    cancel: cancelKokoroModelDownload,
  },
};

export function isLocalModelId(value: unknown): value is LocalModelId {
  return LOCAL_MODEL_IDS.includes(value as LocalModelId);
}

export async function getLocalModelStatus(id: LocalModelId): Promise<LocalModelStatus> {
  const model = MODELS[id];
  return { id, name: model.name, license: model.license, ...(await model.status()) };
}

export function startLocalModelDownload(id: LocalModelId) {
  MODELS[id].start();
}

export function cancelLocalModelDownload(id: LocalModelId) {
  MODELS[id].cancel();
}
