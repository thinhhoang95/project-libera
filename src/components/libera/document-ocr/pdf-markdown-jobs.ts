"use client";

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api";
import { apiRequest } from "@/components/libera/api-client";
import {
  canvasToBlob,
  ensureDocumentOcrModel,
  readImageAsMarkdown,
  resolvePicturePlaceholders,
} from "@/components/libera/document-ocr/document-ocr-client";
import { joinDocumentPages, type DocumentBlock } from "@/lib/document-ocr/doctags";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { LiberaFileNode } from "@/lib/types";

/**
 * Convert PDF to Markdown, one page at a time with the local model.
 *
 * A job belongs to the app, not to the PDF tab: it loads its own copy of the
 * document, so switching tabs does not stop it. Each finished page is saved
 * into the Markdown file at once, so stopping keeps everything read so far.
 */

GlobalWorkerOptions.workerSrc ||= new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

// Pages are read at the scale the model was trained on: a 2048 px long edge.
// Smaller pages make small print unreadable to it.
const PAGE_MAX_EDGE = 2048;
// Figures are cropped from a sharper render than the one the model reads.
const PICTURE_RENDER_EDGE = 2600;

export type PdfMarkdownConversion = {
  createFile: (pdfPath: string) => Promise<LiberaFileNode>;
  writeFile: (path: string, content: string) => Promise<void>;
  openFile: (file: LiberaFileNode) => void;
};

export type PdfMarkdownJob = {
  pdfPath: string;
  state: "running" | "done" | "cancelled" | "error";
  firstPage: number;
  lastPage: number;
  /** Pages finished so far. */
  done: number;
  /** The page being read now. */
  current: number;
  startedAt: number;
  file?: LiberaFileNode;
  error: string;
  /** Pages the model gave up on (too long or repeating), for the summary. */
  warnings: string[];
};

const jobs = new Map<string, PdfMarkdownJob>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, PdfMarkdownJob> = new Map();

function publish(job: PdfMarkdownJob) {
  jobs.set(job.pdfPath, { ...job });
  snapshot = new Map(jobs);
  for (const listener of listeners) listener();
}

export function subscribePdfMarkdownJobs(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPdfMarkdownJobs() {
  return snapshot;
}

export function dismissPdfMarkdownJob(pdfPath: string) {
  if (jobs.get(pdfPath)?.state === "running") return;
  jobs.delete(pdfPath);
  snapshot = new Map(jobs);
  for (const listener of listeners) listener();
}

export function cancelPdfMarkdownJob(pdfPath: string) {
  controllers.get(pdfPath)?.abort();
}

async function renderPage(page: PDFPageProxy, longEdge: number) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: longEdge / Math.max(base.width, base.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a canvas to read the page.");
  // Transparent PDFs would otherwise read as black on white.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

/**
 * Into a shared notebook the file is created, and each page applied, through
 * /api/document-ocr/output (the collab host, with AI provenance). Elsewhere
 * the route answers { shared: false } and the app's own file writers are used
 * as before.
 */
async function conversionOutput(pdfPath: string, conversion: PdfMarkdownConversion) {
  const target = await apiRequest<{ shared: boolean; file?: LiberaFileNode }>("/api/document-ocr/output", {
    method: "POST",
    body: JSON.stringify({ pdfPath }),
  });
  if (!target.shared || !target.file) return { file: await conversion.createFile(pdfPath), writeFile: conversion.writeFile };
  let previous = "";
  return {
    file: target.file,
    writeFile: async (path: string, content: string) => {
      await apiRequest<{ text: string }>("/api/document-ocr/output", { method: "PATCH", body: JSON.stringify({ path, content, previous }) });
      previous = content;
    },
  };
}

async function uploadPicture(markdownPath: string, image: Blob, name: string) {
  const form = new FormData();
  form.append("documentPath", markdownPath);
  form.append("file", new File([image], name, { type: "image/png" }));
  const payload = await apiRequest<{ markdown: string }>("/api/markdown-assets", { method: "POST", body: form });
  return /\]\(([^)\s]+)\)/.exec(payload.markdown)?.[1] ?? "";
}

export function startPdfMarkdownJob(options: {
  pdfPath: string;
  src: string;
  firstPage: number;
  lastPage: number;
  mathMarkers?: MathMarkerSettings;
  conversion: PdfMarkdownConversion;
}) {
  if (jobs.get(options.pdfPath)?.state === "running") return;
  const controller = new AbortController();
  controllers.set(options.pdfPath, controller);
  void runJob(options, controller.signal).finally(() => {
    if (controllers.get(options.pdfPath) === controller) controllers.delete(options.pdfPath);
  });
}

async function runJob(
  { pdfPath, src, firstPage, lastPage, mathMarkers, conversion }: Parameters<typeof startPdfMarkdownJob>[0],
  signal: AbortSignal,
) {
  const job: PdfMarkdownJob = {
    pdfPath,
    state: "running",
    firstPage,
    lastPage,
    done: 0,
    current: firstPage,
    startedAt: Date.now(),
    error: "",
    warnings: [],
  };
  publish(job);

  let pdf: PDFDocumentProxy | null = null;

  try {
    if (!(await ensureDocumentOcrModel())) {
      job.state = "cancelled";
      return;
    }

    const response = await fetch(src, { signal });
    if (!response.ok) throw new Error("Could not open the PDF.");
    pdf = await getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
    const last = Math.min(lastPage, pdf.numPages);
    job.lastPage = last;

    const output = await conversionOutput(pdfPath, conversion);
    const file = output.file;
    job.file = file;
    publish(job);

    const pages: DocumentBlock[][] = [];
    const pictureStem = file.name.replace(/\.md$/i, "");

    for (let pageNumber = firstPage; pageNumber <= last; pageNumber += 1) {
      signal.throwIfAborted();
      job.current = pageNumber;
      publish(job);

      const page = await pdf.getPage(pageNumber);
      const canvas = await renderPage(page, PAGE_MAX_EDGE);
      const result = await readImageAsMarkdown(await canvasToBlob(canvas), {
        mathMarkers,
        maxEdge: PAGE_MAX_EDGE,
        signal,
      });
      canvas.width = 0;

      if (result.stopped === "loop" || result.stopped === "length") {
        job.warnings.push(`Page ${pageNumber} may be incomplete.`);
      }

      let blocks = result.blocks;
      if (result.pictures.length) {
        const sharp = await renderPage(page, PICTURE_RENDER_EDGE);
        blocks = await Promise.all(blocks.map(async (block) => {
          if (block.kind !== "picture" || block.pictureIndex === undefined) return block;
          const picture = result.pictures.find((item) => item.index === block.pictureIndex);
          if (!picture) return block;
          const markdown = await resolvePicturePlaceholders(block.markdown, [picture], sharp, (image) =>
            uploadPicture(file.path, image, `${pictureStem}-p${pageNumber}-figure-${picture.index + 1}.png`));
          return { ...block, markdown };
        }));
        sharp.width = 0;
      }
      page.cleanup();

      pages.push(blocks.filter((block) => block.markdown.trim()));
      await output.writeFile(file.path, `${joinDocumentPages(pages)}\n`);
      job.done += 1;
      publish(job);
    }

    job.state = "done";
    conversion.openFile(file);
  } catch (error) {
    if (signal.aborted) {
      job.state = "cancelled";
    } else {
      job.state = "error";
      job.error = error instanceof Error ? error.message : "The conversion failed.";
    }
  } finally {
    if (job.state === "running") job.state = "cancelled";
    publish(job);
    void pdf?.destroy();
  }
}
