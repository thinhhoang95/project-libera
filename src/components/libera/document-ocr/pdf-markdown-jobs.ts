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
import { joinDocumentPages, type DocumentBlock, type DocumentPicture } from "@/lib/document-ocr/doctags";
import { applyHeadingLevels, extractMarkdownHeadings, joinMarkdownPages } from "@/lib/document-ocr/markdown-pages";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { LiberaFileNode } from "@/lib/types";

/**
 * Convert PDF to Markdown, one page at a time with the local model, or
 * several pages at once with an OpenRouter model (Preferences → AI).
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

/** Which engine reads the pages, from Preferences → AI → Convert PDF to Markdown. */
export type PdfReadingSettings = {
  engine: "local" | "openrouter";
  model: string;
  concurrency: number;
  cleanup: boolean;
  /** Whether an OpenRouter key is set. */
  available: boolean;
};

export function getPdfReadingSettings(signal?: AbortSignal) {
  return apiRequest<PdfReadingSettings>("/api/document-ocr/openrouter", { signal });
}

export type PdfMarkdownJob = {
  pdfPath: string;
  state: "running" | "done" | "cancelled" | "error";
  engine?: PdfReadingSettings["engine"];
  /** OpenRouter only: tidying heading levels after the last page. */
  tidying?: boolean;
  firstPage: number;
  lastPage: number;
  /** Pages finished so far. */
  done: number;
  /** The page being read now; with an OpenRouter model, the earliest of those being read. */
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
    const settings = await getPdfReadingSettings(signal);
    job.engine = settings.engine;
    if (settings.engine === "openrouter" && !settings.available) {
      throw new Error("Add an OpenRouter API key in Preferences, or choose the local model in Preferences → AI → Convert PDF to Markdown.");
    }
    if (settings.engine === "local" && !(await ensureDocumentOcrModel())) {
      job.state = "cancelled";
      return;
    }

    const response = await fetch(src, { signal });
    if (!response.ok) throw new Error("Could not open the PDF.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // pdf.js may hand its buffer to its worker; the OpenRouter path splits the original.
    pdf = await getDocument({ data: settings.engine === "openrouter" ? bytes.slice() : bytes }).promise;
    const last = Math.min(lastPage, pdf.numPages);
    job.lastPage = last;

    const output = await conversionOutput(pdfPath, conversion);
    const file = output.file;
    job.file = file;
    publish(job);

    const pages: DocumentBlock[][] = [];
    const pictureStem = file.name.replace(/\.md$/i, "");

    if (settings.engine === "openrouter") {
      await readWithOpenRouter({ pdf, bytes, job, firstPage, lastPage: last, file, writeFile: output.writeFile, pictureStem, mathMarkers, settings, signal });
      job.state = "done";
      conversion.openFile(file);
      return;
    }

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

/**
 * Read pages with the OpenRouter model, `settings.concurrency` at a time. Each
 * page goes up as a one-page PDF, so the model sees its text layer as well as
 * its look; a PDF that pdf-lib cannot split is sent as page images instead.
 * The file is saved after every page, with a note for pages not read yet, and
 * once all are in the heading levels are made consistent across pages.
 */
async function readWithOpenRouter({ pdf, bytes, job, firstPage, lastPage, file, writeFile, pictureStem, mathMarkers, settings, signal }: {
  pdf: PDFDocumentProxy;
  bytes: Uint8Array;
  job: PdfMarkdownJob;
  firstPage: number;
  lastPage: number;
  file: LiberaFileNode;
  writeFile: (path: string, content: string) => Promise<void>;
  pictureStem: string;
  mathMarkers?: MathMarkerSettings;
  settings: PdfReadingSettings;
  signal: AbortSignal;
}) {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).catch(() => null);
  const pages: (string | undefined)[] = [];
  const reading = new Set<number>();
  // Stops the other pages when the model fails on every page it tries.
  const stop = new AbortController();
  const stopped = AbortSignal.any([signal, stop.signal]);
  let nextPage = firstPage;
  let succeeded = 0;
  let failed = 0;
  let saving = Promise.resolve();

  const assemble = (missing: string) => {
    const read = Array.from({ length: pages.length }, (_, index) => pages[index] ?? `<!-- Page ${firstPage + index} ${missing}. -->`);
    return `${joinMarkdownPages(read)}\n`;
  };
  const save = (content: string) => {
    saving = saving.then(() => writeFile(file.path, content));
    return saving;
  };

  const pageFile = async (page: PDFPageProxy, pageNumber: number) => {
    if (source) {
      const single = await PDFDocument.create();
      const [copied] = await single.copyPages(source, [pageNumber - 1]);
      single.addPage(copied);
      return new Blob([new Uint8Array(await single.save())], { type: "application/pdf" });
    }
    const canvas = await renderPage(page, PAGE_MAX_EDGE);
    const image = await canvasToBlob(canvas);
    canvas.width = 0;
    return image;
  };

  const readPage = async (pageNumber: number) => {
    const page = await pdf.getPage(pageNumber);
    const pageBlob = await pageFile(page, pageNumber);
    const form = new FormData();
    form.set("page", pageBlob, pageBlob.type === "application/pdf" ? `page-${pageNumber}.pdf` : `page-${pageNumber}.png`);
    form.set("pageNumber", String(pageNumber));
    if (mathMarkers?.inlineMathMarkers) form.set("inlineMathMarkers", mathMarkers.inlineMathMarkers);
    if (mathMarkers?.blockMathMarkers) form.set("blockMathMarkers", mathMarkers.blockMathMarkers);
    const result = await apiRequest<{ markdown: string; pictures: DocumentPicture[]; incomplete: boolean }>(
      "/api/document-ocr/openrouter", { method: "POST", body: form, signal: stopped });
    if (result.incomplete) job.warnings.push(`Page ${pageNumber} may be incomplete.`);

    let markdown = result.markdown;
    if (result.pictures.length) {
      const sharp = await renderPage(page, PICTURE_RENDER_EDGE);
      markdown = await resolvePicturePlaceholders(markdown, result.pictures, sharp, (image, index) =>
        uploadPicture(file.path, image, `${pictureStem}-p${pageNumber}-figure-${index + 1}.png`));
      sharp.width = 0;
    }
    page.cleanup();
    return markdown;
  };

  const worker = async () => {
    while (nextPage <= lastPage) {
      stopped.throwIfAborted();
      const pageNumber = nextPage++;
      reading.add(pageNumber);
      job.current = Math.min(...reading);
      publish(job);
      try {
        pages[pageNumber - firstPage] = await readPage(pageNumber);
        succeeded += 1;
      } catch (error) {
        if (stopped.aborted) throw error;
        failed += 1;
        // A wrong model name or a spent key fails every page: stop early with its message.
        if (!succeeded && failed >= Math.min(3, lastPage - firstPage + 1)) {
          stop.abort();
          throw error;
        }
        const message = error instanceof Error ? error.message : "the model failed";
        pages[pageNumber - firstPage] = `<!-- Page ${pageNumber} could not be read: ${message.replace(/-->/g, "")} -->`;
        job.warnings.push(`Page ${pageNumber} could not be read (${message}).`);
      } finally {
        reading.delete(pageNumber);
      }
      job.done += 1;
      if (reading.size) job.current = Math.min(...reading);
      publish(job);
      await save(assemble("is still being read"));
    }
  };

  try {
    const workers = Math.max(1, Math.min(settings.concurrency, lastPage - firstPage + 1));
    await Promise.all(Array.from({ length: workers }, worker));
  } catch (error) {
    stop.abort();
    // Keep every page that was read, marking the rest.
    await saving.catch(() => undefined);
    if (succeeded) await save(assemble("was not read")).catch(() => undefined);
    throw error;
  }

  let markdown = assemble("was not read");
  if (settings.cleanup) {
    job.tidying = true;
    publish(job);
    const headings = pages.flatMap((page, index) => extractMarkdownHeadings(page ?? "", firstPage + index));
    try {
      // Levels are applied in order, so the joined file must have the same headings.
      if (headings.length >= 2 && extractMarkdownHeadings(markdown, 0).length === headings.length) {
        const { levels } = await apiRequest<{ levels: number[] | null }>("/api/document-ocr/openrouter/headings", {
          method: "POST",
          body: JSON.stringify({ headings }),
          signal,
        });
        if (levels) markdown = applyHeadingLevels(markdown, levels);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      job.warnings.push("Heading levels were left as each page had them.");
    }
    job.tidying = false;
  }
  await saving;
  await save(markdown);
}
