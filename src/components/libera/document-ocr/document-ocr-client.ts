"use client";

import { apiRequest } from "@/components/libera/api-client";
import { PICTURE_PLACEHOLDER_PREFIX, type DocTagsConversion, type DocumentBox } from "@/lib/document-ocr/doctags";
import type { MathMarkerSettings } from "@/lib/math-markers";

export type DocumentOcrModelStatus = {
  state: "unconfigured" | "missing" | "downloading" | "ready" | "error";
  directory: string;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
  model: string;
  license: string;
};

export type DocumentOcrPageResult = DocTagsConversion & {
  stopped: "eos" | "length" | "loop" | "cancelled";
  tokens: number;
  ms: number;
};

export function fetchDocumentOcrModelStatus() {
  return apiRequest<DocumentOcrModelStatus>("/api/document-ocr/model");
}

export function startDocumentOcrModelDownload() {
  return apiRequest<DocumentOcrModelStatus>("/api/document-ocr/model", { method: "POST" });
}

export function cancelDocumentOcrModelDownload() {
  return apiRequest<DocumentOcrModelStatus>("/api/document-ocr/model", { method: "DELETE" });
}

// One prompt for the whole app: features ask for the model, and the dialog
// (mounted once) shows setup or download progress until it is ready.
type GateState = { open: boolean };
let gateState: GateState = { open: false };
const gateListeners = new Set<() => void>();
let gateWaiters: Array<(ready: boolean) => void> = [];

function setGate(next: GateState) {
  gateState = next;
  for (const listener of gateListeners) listener();
}

export function subscribeDocumentOcrGate(listener: () => void) {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
}

export function getDocumentOcrGate() {
  return gateState;
}

/** Called by the dialog when the model became ready (true) or the user closed it (false). */
export function settleDocumentOcrGate(ready: boolean) {
  const waiters = gateWaiters;
  gateWaiters = [];
  setGate({ open: false });
  for (const resolve of waiters) resolve(ready);
}

/** Resolve true once the model is installed, asking the user to set it up first when needed. */
export async function ensureDocumentOcrModel(): Promise<boolean> {
  try {
    if ((await fetchDocumentOcrModelStatus()).state === "ready") return true;
  } catch {
    // Show the dialog; it reports the error.
  }

  return new Promise<boolean>((resolve) => {
    gateWaiters.push(resolve);
    setGate({ open: true });
  });
}

/** Read one image into Markdown. `maxEdge` caps the resolution the model reads it at. */
export async function readImageAsMarkdown(
  image: Blob,
  { mathMarkers, maxEdge, maxNewTokens, signal }: { mathMarkers?: MathMarkerSettings; maxEdge?: number; maxNewTokens?: number; signal?: AbortSignal } = {},
) {
  const form = new FormData();
  form.set("image", image, "page.png");
  if (mathMarkers?.inlineMathMarkers) form.set("inlineMathMarkers", mathMarkers.inlineMathMarkers);
  if (mathMarkers?.blockMathMarkers) form.set("blockMathMarkers", mathMarkers.blockMathMarkers);
  if (maxEdge) form.set("maxEdge", String(maxEdge));
  if (maxNewTokens) form.set("maxNewTokens", String(maxNewTokens));
  return apiRequest<DocumentOcrPageResult>("/api/document-ocr/convert", { method: "POST", body: form, signal });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png") {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))), type);
  });
}

/** Cut a region, given as fractions of the canvas, into its own canvas. */
export function cropCanvas(source: HTMLCanvasElement, box: DocumentBox, padding = 0.004) {
  const x = Math.max(0, Math.floor((box.x - padding) * source.width));
  const y = Math.max(0, Math.floor((box.y - padding) * source.height));
  const right = Math.min(source.width, Math.ceil((box.x + box.width + padding) * source.width));
  const bottom = Math.min(source.height, Math.ceil((box.y + box.height + padding) * source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, right - x);
  canvas.height = Math.max(1, bottom - y);
  canvas.getContext("2d")?.drawImage(source, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Replace picture placeholders with real images cropped from the page.
 * `upload` stores one image and returns its Markdown source; a picture that
 * is too small or fails to upload is left out rather than left broken.
 */
export async function resolvePicturePlaceholders(
  markdown: string,
  pictures: DocTagsConversion["pictures"],
  page: HTMLCanvasElement,
  upload: (image: Blob, index: number) => Promise<string>,
) {
  let result = markdown;

  for (const picture of pictures) {
    const placeholder = `(${PICTURE_PLACEHOLDER_PREFIX}${picture.index})`;
    let source = "";
    const tooSmall = picture.box.width * page.width < 24 || picture.box.height * page.height < 24;

    if (!tooSmall) {
      try {
        source = await upload(await canvasToBlob(cropCanvas(page, picture.box)), picture.index);
      } catch {
        source = "";
      }
    }

    result = source
      ? result.replace(placeholder, `(${source})`)
      : result.replace(new RegExp(`!\\[[^\\]]*\\]\\(${PICTURE_PLACEHOLDER_PREFIX}${picture.index}\\)\\n*`), "");
  }

  return result.trim();
}
