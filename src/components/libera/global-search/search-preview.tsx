"use client";

import { ArrowUpRight, Images, Loader2, PanelRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { GlobalWorkerOptions, Util, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { apiRequest, encodeFilePath } from "@/components/libera/api-client";
import { FileTypeIcon } from "@/components/libera/file-type";
import { resultImageRef, resultThumbnail, type SearchEntry } from "@/components/libera/global-search/search-results";
import { buildPdfSearchPage } from "@/components/libera/pdf-find";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import {
  findTermRanges,
  searchKindLabel,
  searchLocationLabel,
  type SearchHit,
  type SearchImageRef,
  type SearchResultFile,
} from "@/lib/global-search";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { LiberaFilePayload } from "@/lib/types";

GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();

const CONTEXT_CHARS = 700;
const CONTEXT_LINES = 6;
const HIGHLIGHT_NAME = "libera-search-term";

// File contents and PDFs are kept while results are browsed, a few at a time.
const contentCache = new Map<string, Promise<string>>();
const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();

function remember<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>, limit: number) {
  let value = cache.get(key);
  if (!value) {
    value = load();
    value.catch(() => cache.delete(key));
    cache.set(key, value);
    while (cache.size > limit) {
      const oldest = cache.keys().next().value as string;
      const evicted = cache.get(oldest);
      cache.delete(oldest);
      void evicted?.then((document) => (document as { destroy?: () => unknown })?.destroy?.()).catch(() => undefined);
    }
  }
  return value;
}

/** Forget cached contents, so a new search shows files as they are now. */
export function clearSearchPreviewCache() {
  contentCache.clear();
}

function loadContent(path: string) {
  return remember(contentCache, path, async () => {
    const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`);
    return payload.content ?? "";
  }, 12);
}

function loadPdf(path: string) {
  return remember(pdfCache, path, () => getDocument({ url: `/api/files/raw/${encodeFilePath(path)}` }).promise, 3);
}

function useAsync<T>(load: (() => Promise<T>) | null, key: string) {
  const [state, setState] = useState<{ key: string; value?: T; error?: string }>({ key: "" });
  useEffect(() => {
    if (!load) return;
    let active = true;
    load().then(
      (value) => { if (active) setState({ key, value }); },
      (error: unknown) => { if (active) setState({ key, error: error instanceof Error ? error.message : "Could not load the preview." }); },
    );
    return () => { active = false; };
    // `key` identifies the request; `load` is recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { key };
}

/** Highlight the query's words in rendered content with the CSS Custom Highlight API. */
function useTermHighlights(containerRef: RefObject<HTMLElement | null>, terms: string[], version: string) {
  useEffect(() => {
    const container = containerRef.current;
    const registry = typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined;
    const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!container || !registry || !HighlightClass || !terms.length) return;

    const ranges: Range[] = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [start, end] of findTermRanges(node.textContent ?? "", terms)) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        ranges.push(range);
      }
    }
    registry.set(HIGHLIGHT_NAME, new HighlightClass(...ranges));
    return () => { registry.delete(HIGHLIGHT_NAME); };
  }, [containerRef, terms, version]);
}

/** Where the indexed passage is in the file now; files can change after indexing. */
function locatePassage(content: string, hit: SearchHit) {
  const { start, end } = hit.location;
  if (start !== undefined && end !== undefined && content.slice(start, end) === hit.text) return { start, end };
  const found = content.indexOf(hit.text);
  if (found >= 0) return { start: found, end: found + hit.text.length };
  return null;
}

function blockBoundaryBefore(content: string, offset: number) {
  const from = Math.max(0, offset - CONTEXT_CHARS);
  const blank = content.indexOf("\n\n", from);
  return blank >= 0 && blank < offset ? blank + 2 : from === 0 ? 0 : content.lastIndexOf("\n", from) + 1;
}

function blockBoundaryAfter(content: string, offset: number) {
  const to = Math.min(content.length, offset + CONTEXT_CHARS);
  const blank = content.lastIndexOf("\n\n", to);
  return blank > offset ? blank : to === content.length ? to : Math.max(offset, content.indexOf("\n", to) >= 0 ? content.indexOf("\n", to) : to);
}

function StaleNotice() {
  return <p className="mb-3 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">This file changed after it was indexed. The passage below is from the index; it will be updated shortly.</p>;
}

function MarkdownPassage({ result, hit, mathMarkers, terms }: { result: SearchResultFile; hit: SearchHit; mathMarkers?: MathMarkerSettings; terms: string[] }) {
  const content = useAsync(() => loadContent(result.path), result.path);
  const containerRef = useRef<HTMLDivElement>(null);
  const passage = content.value !== undefined ? locatePassage(content.value, hit) : null;
  useTermHighlights(containerRef, terms, `${result.key}:${hit.chunkId}:${content.value !== undefined}`);

  useEffect(() => {
    containerRef.current?.querySelector("[data-search-passage]")?.scrollIntoView({ block: "center" });
  }, [hit.chunkId, content.value]);

  if (content.error) return <p className="text-sm text-destructive">{content.error}</p>;
  if (content.value === undefined) return <PreviewLoading />;

  const source = content.value;
  const renderer = (text: string) => (
    <MarkdownRenderer content={text} mathMarkers={mathMarkers} documentPath={result.path} baseFontSize={14} baseLineHeight={1.6} />
  );

  if (!passage) {
    return <div ref={containerRef}><StaleNotice /><div data-search-passage className="libera-search-passage">{renderer(hit.text)}</div></div>;
  }

  const before = source.slice(blockBoundaryBefore(source, passage.start), passage.start);
  const after = source.slice(passage.end, blockBoundaryAfter(source, passage.end));
  return (
    <div ref={containerRef} className="libera-search-markdown">
      {before.trim() ? <div className="opacity-55">{renderer(before)}</div> : null}
      <div data-search-passage className="libera-search-passage">{renderer(source.slice(passage.start, passage.end))}</div>
      {after.trim() ? <div className="opacity-55">{renderer(after)}</div> : null}
    </div>
  );
}

function SourcePassage({ result, hit, terms }: { result: SearchResultFile; hit: SearchHit; terms: string[] }) {
  const content = useAsync(() => loadContent(result.path), result.path);
  const containerRef = useRef<HTMLDivElement>(null);
  useTermHighlights(containerRef, terms, `${result.key}:${hit.chunkId}:${content.value !== undefined}`);

  const view = useMemo(() => {
    if (content.value === undefined) return null;
    const lines = content.value.split("\n");
    const passage = locatePassage(content.value, hit);
    const firstLine = passage ? content.value.slice(0, passage.start).split("\n").length : hit.location.line ?? 1;
    const lastLine = passage ? content.value.slice(0, passage.end).split("\n").length : hit.location.endLine ?? firstLine;
    const from = Math.max(1, firstLine - CONTEXT_LINES);
    const to = Math.min(lines.length, lastLine + CONTEXT_LINES);
    return { lines: lines.slice(from - 1, to), from, firstLine, lastLine, stale: !passage };
  }, [content.value, hit]);

  useEffect(() => {
    containerRef.current?.querySelector("[data-search-passage]")?.scrollIntoView({ block: "center" });
  }, [view]);

  if (content.error) return <p className="text-sm text-destructive">{content.error}</p>;
  if (!view) return <PreviewLoading />;

  return (
    <div ref={containerRef}>
      {view.stale ? <StaleNotice /> : null}
      <pre className="overflow-x-auto rounded-lg border border-border bg-card py-2 font-mono text-[12.5px] leading-[1.65]">
        {view.lines.map((line, index) => {
          const number = view.from + index;
          const inPassage = number >= view.firstLine && number <= view.lastLine;
          return (
            <div key={number} data-search-passage={number === view.firstLine ? "" : undefined} className={`flex ${inPassage ? "bg-accent/10" : "opacity-60"}`}>
              <span className={`w-12 shrink-0 select-none pr-3 text-right tabular-nums ${inPassage ? "text-accent" : "text-muted-foreground"}`}>{number}</span>
              <span className="whitespace-pre-wrap break-words pr-3">{line || " "}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

/** Offsets of a string with all whitespace removed, mapped back to the original. */
function squash(text: string) {
  let value = "";
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (/\s/.test(text[index])) continue;
    value += text[index].toLowerCase();
    offsets.push(index);
  }
  return { value, offsets };
}

type PdfRect = { left: number; top: number; width: number; height: number };

function PdfPassage({ result, hit, terms }: { result: SearchResultFile; hit: SearchHit; terms: string[] }) {
  const pageNumber = hit.location.page ?? 1;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [rendered, setRendered] = useState<{ key: string; height: number; rects: PdfRect[]; error?: string } | null>(null);
  const renderKey = `${result.path}:${pageNumber}:${hit.chunkId}:${width}`;
  useTermHighlights(textRef, terms, `${result.key}:${hit.chunkId}`);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!width) return;
    let active = true;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;

    void (async () => {
      try {
        const pdf = await loadPdf(result.path);
        const page = await pdf.getPage(Math.min(pageNumber, pdf.numPages));
        if (!active) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: width / base.width });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (!context) return;
        task = page.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        await task.promise;

        // Box the passage: find its first and last words on the page, ignoring spacing.
        const content = await page.getTextContent();
        const searchPage = buildPdfSearchPage(content);
        const pageText = squash(searchPage.text);
        const passage = squash(hit.text).value;
        const head = passage.slice(0, 48);
        const tail = passage.slice(-48);
        const startAt = head ? pageText.value.indexOf(head) : -1;
        const endAt = startAt >= 0 ? pageText.value.indexOf(tail, startAt) : -1;
        const rects: PdfRect[] = [];
        if (startAt >= 0) {
          const from = pageText.offsets[startAt];
          const to = pageText.offsets[Math.min(pageText.offsets.length - 1, (endAt >= 0 ? endAt + tail.length : startAt + head.length) - 1)] + 1;
          const textItems = content.items.filter((item) => "str" in item);
          searchPage.items.forEach((range, index) => {
            if (range.end <= from || range.start >= to) return;
            const item = textItems[index] as { transform: number[]; width: number; height: number; str: string };
            if (!item?.str.trim()) return;
            const transform = Util.transform(viewport.transform, item.transform);
            const height = Math.hypot(transform[2], transform[3]) || item.height * viewport.scale;
            rects.push({ left: transform[4], top: transform[5] - height, width: item.width * viewport.scale, height: height * 1.15 });
          });
        }
        if (active) setRendered({ key: renderKey, height: viewport.height, rects });
      } catch (error) {
        if (active && !(error instanceof Error && error.name === "RenderingCancelledException")) {
          setRendered({ key: renderKey, height: 0, rects: [], error: error instanceof Error ? error.message : "Could not show this page." });
        }
      }
    })();

    return () => {
      active = false;
      task?.cancel();
    };
  }, [hit.chunkId, hit.text, pageNumber, renderKey, result.path, width]);

  useEffect(() => {
    if (rendered?.key !== renderKey) return;
    hostRef.current?.querySelector("[data-search-passage]")?.scrollIntoView({ block: "center" });
  }, [rendered, renderKey]);

  const current = rendered?.key === renderKey ? rendered : null;
  return (
    <div className="flex flex-col gap-3">
      <div ref={hostRef} className="relative overflow-hidden rounded-lg border border-border bg-white shadow-sm" style={{ minHeight: current?.height || 240 }}>
        <canvas ref={canvasRef} className="block" />
        {current?.rects.map((rect, index) => (
          <div key={index} data-search-passage={index === 0 ? "" : undefined} className="libera-search-pdf-rect pointer-events-none absolute" style={rect} />
        ))}
        {!current ? <div className="absolute inset-0 flex items-center justify-center"><PreviewLoading /></div> : null}
        {current?.error ? <p className="absolute inset-x-0 top-1/2 text-center text-sm text-destructive">{current.error}</p> : null}
      </div>
      <div ref={textRef} className="rounded-lg bg-muted/60 px-3 py-2 text-[13px] leading-5 text-foreground/85">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Passage on page {pageNumber}</div>
        {hit.text.replace(/\s+/g, " ").trim()}
      </div>
    </div>
  );
}

function ImagePassage({ result, onFindSimilar }: { result: SearchResultFile; onFindSimilar: (image: SearchImageRef) => void }) {
  const image = resultImageRef(result);
  const source = result.source === "gallery" && result.photo
    ? `/api/gallery/raw/${result.photo.path.split("/").map(encodeURIComponent).join("/")}?v=${encodeURIComponent(`${result.photo.updatedAt}-${result.photo.size}`)}`
    : resultThumbnail(result);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/50">
        {/* eslint-disable-next-line @next/next/no-img-element -- local files served by the app */}
        <img src={source} alt={result.name} className="max-h-[60vh] w-auto max-w-full object-contain" />
      </div>
      {result.photo?.prompt ? (
        <div className="rounded-lg bg-muted/60 px-3 py-2 text-[13px] leading-5">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Prompt</div>
          {result.photo.prompt}
        </div>
      ) : null}
      {image ? (
        <button type="button" className="inline-flex items-center gap-1.5 self-start rounded-lg border border-border px-2.5 py-1.5 text-sm hover:bg-muted" onClick={() => onFindSimilar(image)}>
          <Images aria-hidden className="h-4 w-4" /> Find similar images
        </button>
      ) : null}
    </div>
  );
}

function PreviewLoading() {
  return <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Loading preview…</div>;
}

export function SearchPreview({
  entry,
  terms,
  mathMarkers,
  onOpen,
  onFindSimilar,
}: {
  entry: SearchEntry | null;
  terms: string[];
  mathMarkers?: MathMarkerSettings;
  onOpen: (entry: SearchEntry, placement: "tab" | "right") => void;
  onFindSimilar: (image: SearchImageRef) => void;
}) {
  if (!entry) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">Select a result to preview it here.</div>;
  }

  const { result } = entry;
  const hit = result.hits[entry.hit] ?? result.hits[0];
  const location = searchLocationLabel(result.kind, hit.location);
  const where = result.source === "gallery" ? "Image Gallery" : result.path.split("/").slice(0, -1).join(" / ");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start gap-2 border-b border-border px-4 py-3">
        <span className="mt-0.5 text-muted-foreground"><FileTypeIcon fileType={result.kind} name={result.name} /></span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{result.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {[where, searchKindLabel(result.kind), location].filter(Boolean).join(" · ")}
          </p>
        </div>
        <button type="button" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90" title="Open at this passage (Enter)" onClick={() => onOpen(entry, "tab")}>
          Open <ArrowUpRight aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-8 w-8 items-center justify-center rounded-lg" aria-label="Open to the right" title="Open to the right (⌘/Ctrl+Enter)" onClick={() => onOpen(entry, "right")}>
          <PanelRight aria-hidden className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {result.kind === "markdown" ? <MarkdownPassage key={`${result.key}:${hit.chunkId}`} result={result} hit={hit} mathMarkers={mathMarkers} terms={terms} />
          : result.kind === "pdf" ? <PdfPassage key={result.key} result={result} hit={hit} terms={terms} />
          : result.kind === "image" ? <ImagePassage result={result} onFindSimilar={onFindSimilar} />
          : <SourcePassage key={`${result.key}:${hit.chunkId}`} result={result} hit={hit} terms={terms} />}
      </div>
    </div>
  );
}
