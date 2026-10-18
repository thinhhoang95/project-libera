"use client";

import { ArrowLeft, ClipboardPaste, ImageUp, Loader2, ScanText } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { ensureDocumentOcrModel, readImageAsMarkdown } from "@/components/libera/document-ocr/document-ocr-client";
import { splitBibliography } from "@/lib/references/identifiers";
import type { ReferenceEntryInput, ReferenceLibrary, ReferenceLibraryOp } from "@/lib/references/types";
import { CandidateList, isAbortError, resolveReference, type ResolveRequest, type ResolveResponse } from "./reference-candidates";

// A reference list from a screenshot or a photo (plan.md §5, "Screenshot or
// photo of a reference list"): the image is read on this computer by the same
// local model as PDF to Markdown (POST /api/document-ocr/convert, with the
// same model setup and download prompt), the text is split into references
// like a pasted bibliography (splitBibliography), each reference is looked up
// through /api/references/resolve, at most four at a time, and the results
// are confirmed on the Add box's candidate cards (reference-candidates.tsx).
//
// importReferenceImage() is the pipeline; ReferenceImageImport is the drop,
// paste and pick control around it, placed in the Add box with one line.

export const REFERENCE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/i;
/** The long edge the model reads a list at: the scale it was trained on (as PDF pages). */
const READ_MAX_EDGE = 2048;
const RESOLVE_CONCURRENCY = 4;
const HEADINGS = /^(?:references|bibliography|works cited|literature cited|literature|sources|notes|cited works|reference list)\s*:?$/i;

export type ReferenceImageProgress =
  | { phase: "model" }
  | { phase: "reading" }
  | { phase: "resolving"; done: number; total: number };

export type ReferenceImageImportOptions = {
  notebook: string;
  webSearch?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ReferenceImageProgress) => void;
  /** The model check (default: the app's setup prompt, ensureDocumentOcrModel). */
  ensureModel?: () => Promise<boolean>;
  /** Image → Markdown (default: the local model through /api/document-ocr/convert). */
  readImage?: (image: Blob, options: { maxEdge: number; signal?: AbortSignal }) => Promise<{ markdown: string }>;
  /** One lookup (default: POST /api/references/resolve). */
  resolve?: (request: ResolveRequest, signal?: AbortSignal) => Promise<ResolveResponse>;
};

export type ReferenceImageImport = {
  /** What the model read, as Markdown. */
  markdown: string;
  /** The references found in it, in order. */
  items: string[];
  /** Every lookup's candidates in item order, with duplicate indexes shifted to match. */
  result: ResolveResponse;
};

/** The model is not set up, or the user closed its setup prompt. */
export class ReadingModelUnavailableError extends Error {
  constructor() {
    super("Reading images needs the local reading model. Set it up in Preferences → Search (PDF reading model), then try again.");
    this.name = "ReadingModelUnavailableError";
  }
}

/** Whether a file is an image the import reads (PNG, JPEG or WebP). */
export function isReferenceImage(file: Pick<File, "type"> & { name?: string }) {
  return (REFERENCE_IMAGE_TYPES as readonly string[]).includes(file.type) || (!file.type && IMAGE_EXTENSION.test(file.name ?? ""));
}

/**
 * The model's Markdown as reference-list text for splitBibliography: one
 * paragraph per bullet item, numbered items kept, and Markdown markup
 * (emphasis, escapes, links, headings, pictures, tags) reduced to its text.
 */
export function referenceListText(markdown: string) {
  const lines: string[] = [];
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    let line = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g, (_, text: string, url: string) => text.includes(url) || !url ? text : `${text} ${url}`)
      .replace(/<[^>]+>/g, "")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(^|[^\p{L}\p{N}])[*_](\S(?:.*?\S)?)[*_](?=[^\p{L}\p{N}]|$)/gu, "$1$2")
      .replace(/\\([!-/:-@[-`{-~])/g, "$1");
    if (/^\s*#{1,6}\s+/.test(line)) line = line.replace(/^\s*#{1,6}\s+/, "");
    const bullet = /^\s*[-*+•]\s+/.exec(line);
    if (bullet) {
      // A bullet starts a new reference: keep it apart with a blank line.
      if (lines.length && lines[lines.length - 1].trim()) lines.push("");
      line = line.slice(bullet[0].length);
    }
    lines.push(line);
  }
  return lines.join("\n").trim();
}

/** The references in a read list: splitBibliography, without headings such as "References". */
export function referenceListItems(markdown: string) {
  return splitBibliography(referenceListText(markdown)).map((item) => item.trim()).filter((item) => item && !HEADINGS.test(item));
}

/** Join lookups in item order; each lookup's duplicate indexes are shifted past the earlier candidates. */
export function mergeResolveResults(results: Array<{ item: string; result: ResolveResponse | null; error?: string }>): ResolveResponse {
  const merged: ResolveResponse = { candidates: [], duplicates: [], updates: [], warnings: [] };
  for (const { item, result, error } of results) {
    const label = item.length > 80 ? `${item.slice(0, 77)}…` : item;
    if (!result) {
      merged.warnings.push(`Could not look up “${label}”${error ? `: ${error}` : "."}`);
      continue;
    }
    const offset = merged.candidates.length;
    merged.candidates.push(...result.candidates);
    merged.duplicates.push(...result.duplicates.map((duplicate) => ({ ...duplicate, candidateIndex: duplicate.candidateIndex + offset })));
    merged.updates.push(...result.updates);
    merged.warnings.push(...result.warnings);
    if (!result.candidates.length) merged.warnings.push(`Nothing was found for “${label}”.`);
  }
  return merged;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** PNG and JPEG go to the model as they are; anything else (WebP) is drawn and sent as PNG. */
async function modelImage(image: Blob) {
  if (image.type === "image/png" || image.type === "image/jpeg") return image;
  const bitmap = await createImageBitmap(image);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not read the image.")), "image/png"));
}

function abortError() {
  return new DOMException("The import was cancelled.", "AbortError");
}

/**
 * Read a reference list from an image and look up each reference. Throws
 * ReadingModelUnavailableError when the model is not set up (the user saw
 * the setup prompt), an AbortError when cancelled, and an Error when the
 * image holds no references. Nothing is written to the library.
 */
export async function importReferenceImage(file: Blob & { name?: string }, options: ReferenceImageImportOptions): Promise<ReferenceImageImport> {
  const { notebook, webSearch = false, signal, onProgress } = options;
  if (!isReferenceImage(file)) throw new Error("Use a PNG, JPEG or WebP image of the reference list.");
  onProgress?.({ phase: "model" });
  if (!await (options.ensureModel ?? ensureDocumentOcrModel)()) throw new ReadingModelUnavailableError();
  if (signal?.aborted) throw abortError();

  onProgress?.({ phase: "reading" });
  const read = options.readImage ?? ((image, readOptions) => readImageAsMarkdown(image, readOptions));
  const { markdown } = await read(options.readImage ? file : await modelImage(file), { maxEdge: READ_MAX_EDGE, signal });
  if (signal?.aborted) throw abortError();
  const items = referenceListItems(markdown);
  if (!items.length) throw new Error("No references were found in the image.");

  const lookup = options.resolve ?? resolveReference;
  let done = 0;
  onProgress?.({ phase: "resolving", done, total: items.length });
  const results = await mapLimited(items, RESOLVE_CONCURRENCY, async (item) => {
    if (signal?.aborted) throw abortError();
    try {
      return { item, result: await lookup({ notebook, input: item, webSearch }, signal) };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw abortError();
      return { item, result: null, error: error instanceof Error ? error.message : undefined };
    } finally {
      onProgress?.({ phase: "resolving", done: ++done, total: items.length });
    }
  });
  return { markdown, items, result: mergeResolveResults(results) };
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

export type ReferenceImageImportProps = {
  notebook: string;
  library: ReferenceLibrary | null;
  webSearch: boolean;
  busy?: boolean;
  /** As the Add box's candidate list: apply confirmed candidates as one transaction. */
  onCommit: (ops: ReferenceLibraryOp[], label: string, revealId?: string) => Promise<void>;
  onEdit: (candidate: ReferenceEntryInput, extraOps: ReferenceLibraryOp[]) => void;
  onReveal: (entryId: string) => void;
  /** An online lookup is starting (for the privacy notice). */
  onLookup?: () => void;
  /** Injection for tests (see importReferenceImage). */
  importOptions?: Pick<ReferenceImageImportOptions, "ensureModel" | "readImage" | "resolve">;
};

type State =
  | { kind: "idle" }
  | { kind: "working"; progress: ReferenceImageProgress }
  | { kind: "candidates"; imported: ReferenceImageImport }
  | { kind: "error"; message: string; model: boolean };

function progressText(progress: ReferenceImageProgress) {
  if (progress.phase === "model") return "Checking the reading model…";
  if (progress.phase === "reading") return "Reading the image on this computer…";
  return `Looking up ${progress.done} of ${progress.total} references…`;
}

/** Drop, paste or pick an image of a reference list; its references are looked up and confirmed as candidates. */
export function ReferenceImageImport({ notebook, library, webSearch, busy = false, onCommit, onEdit, onReveal, onLookup, importOptions }: ReferenceImageImportProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const start = async (file: File | Blob) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: "working", progress: { phase: "model" } });
    try {
      const imported = await importReferenceImage(file, {
        notebook, webSearch, signal: controller.signal, ...importOptions,
        onProgress: (progress) => {
          if (progress.phase === "resolving" && progress.done === 0) onLookup?.();
          if (!controller.signal.aborted) setState({ kind: "working", progress });
        },
      });
      if (!controller.signal.aborted) setState({ kind: "candidates", imported });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setState({ kind: "error", message: error instanceof Error ? error.message : "The image could not be read.", model: error instanceof ReadingModelUnavailableError });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  const take = (files: Iterable<File> | ArrayLike<File> | null | undefined) => {
    const image = Array.from(files ?? []).find(isReferenceImage);
    if (image) void start(image);
    else setState({ kind: "error", message: "Use a PNG, JPEG or WebP image of the reference list.", model: false });
  };

  const pasteFromClipboard = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((candidate) => (REFERENCE_IMAGE_TYPES as readonly string[]).includes(candidate));
        if (type) {
          void start(await item.getType(type));
          return;
        }
      }
      setState({ kind: "error", message: "The clipboard holds no image.", model: false });
    } catch {
      setState({ kind: "error", message: "The clipboard could not be read. Click the box below and press Ctrl+V (⌘V) instead.", model: false });
    }
  };

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState({ kind: "idle" });
  };

  if (state.kind === "candidates") {
    return (
      <div className="space-y-2" aria-label="References from the image">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <button type="button" className="libera-sidebar-icon-button inline-flex h-6 w-6 items-center justify-center rounded-md" aria-label="Back to the image import" onClick={() => setState({ kind: "idle" })}>
            <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          </button>
          <span>{state.imported.items.length} reference{state.imported.items.length === 1 ? "" : "s"} read from the image.</span>
        </div>
        {library ? (
          <CandidateList notebook={notebook} library={library} result={state.imported.result} busy={busy} onCommit={onCommit} onEdit={onEdit} onReveal={onReveal} />
        ) : <p className="text-[11px] text-muted-foreground">Loading the library…</p>}
      </div>
    );
  }

  const working = state.kind === "working";
  return (
    <div className="space-y-1.5" data-reference-image-import="">
      <div
        role="button"
        tabIndex={0}
        aria-label="Reference list image: paste, drop or choose a screenshot or photo"
        aria-busy={working}
        className={`flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-2 text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring ${dragging ? "border-accent bg-muted" : "border-input"}`}
        onPaste={(event: ClipboardEvent<HTMLDivElement>) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length) return;
          event.preventDefault();
          take(files);
        }}
        onDragOver={(event: DragEvent<HTMLDivElement>) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          setDragging(false);
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          event.stopPropagation();
          take(event.dataTransfer.files);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        {working ? <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <ScanText aria-hidden className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 flex-1" role={working ? "status" : undefined}>
          {working ? progressText(state.progress) : "Screenshot or photo of a reference list: paste or drop it here"}
        </span>
        {working ? (
          <button type="button" className="libera-panel-button h-6 px-2 text-[11px]" onClick={cancel}>Cancel</button>
        ) : (
          <>
            <button type="button" className="libera-panel-button h-6 px-2 text-[11px]" title="Paste an image from the clipboard" onClick={() => void pasteFromClipboard()}>
              <ClipboardPaste aria-hidden className="h-3 w-3" /> Paste
            </button>
            <button type="button" className="libera-panel-button h-6 px-2 text-[11px]" title="Choose an image" onClick={() => inputRef.current?.click()}>
              <ImageUp aria-hidden className="h-3 w-3" /> Image
            </button>
          </>
        )}
      </div>
      {state.kind === "error" ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-destructive-muted p-2 text-[11px] text-destructive">
          <span className="min-w-0 flex-1">{state.message}</span>
          {state.model ? (
            <button type="button" className="shrink-0 font-semibold hover:underline" onClick={() => void (importOptions?.ensureModel ?? ensureDocumentOcrModel)().then((ready) => { if (ready) setState({ kind: "idle" }); })}>
              Set up
            </button>
          ) : null}
        </div>
      ) : null}
      <input ref={inputRef} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Reference list image" onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        take(files);
      }} />
    </div>
  );
}
