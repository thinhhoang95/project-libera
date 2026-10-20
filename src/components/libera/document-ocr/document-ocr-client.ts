"use client";

import { apiRequest } from "@/components/libera/api-client";
import { ensureLocalModel } from "@/components/libera/local-models/local-model-client";
import { PICTURE_PLACEHOLDER_PREFIX, type DocTagsConversion, type DocumentBox } from "@/lib/document-ocr/doctags";
import type { MathMarkerSettings } from "@/lib/math-markers";

export type DocumentOcrPageResult = DocTagsConversion & {
  stopped: "eos" | "length" | "loop" | "cancelled";
  tokens: number;
  ms: number;
};

/** Resolve true once the PDF reading model is installed, offering its download first when needed. */
export function ensureDocumentOcrModel() {
  return ensureLocalModel("reading");
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
