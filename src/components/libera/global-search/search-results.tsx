"use client";

import { ArrowUpRight, BookOpen, ImageIcon, ScanSearch } from "lucide-react";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { FileTypeIcon } from "@/components/libera/file-type";
import { SEARCH_IMAGE_DRAG_MIME, searchImageThumbnail } from "@/components/libera/global-search/search-query-input";
import {
  findTermRanges,
  searchKindLabel,
  searchLocationLabel,
  snippetWindow,
  type SearchImageRef,
  type SearchResultFile,
} from "@/lib/global-search";
import { embeddingText } from "@/lib/search/chunking";

export type SearchSelection = { key: string; hit: number };
/** A result and one of its passages; `terms` (the query's words) travel along when it is opened. */
export type SearchEntry = { result: SearchResultFile; hit: number; terms?: string[] };

/** The image a result stands for, as it would go in the search box. */
export function resultImageRef(result: SearchResultFile): SearchImageRef | null {
  if (result.kind !== "image") return null;
  if (result.source === "gallery" && result.photo) {
    return { kind: "gallery", id: result.photo.id, path: result.photo.path, name: result.photo.name };
  }
  return { kind: "file", path: result.path, name: result.name };
}

export function resultThumbnail(result: SearchResultFile) {
  const image = resultImageRef(result);
  return image ? searchImageThumbnail(image) : "";
}

/** The order the arrow keys walk: the image strip, then each document's passages. */
export function searchEntries(results: SearchResultFile[], imagesAsGrid: boolean): SearchEntry[] {
  const images = results.filter((result) => result.kind === "image");
  const documents = results.filter((result) => result.kind !== "image");
  const entries: SearchEntry[] = (imagesAsGrid ? images : images.slice(0, MAX_STRIP_IMAGES)).map((result) => ({ result, hit: 0 }));
  for (const result of documents) {
    result.hits.slice(0, MAX_LISTED_HITS).forEach((_, hit) => entries.push({ result, hit }));
  }
  return entries;
}

const MAX_STRIP_IMAGES = 12;
const MAX_LISTED_HITS = 3;

export function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const ranges = findTermRanges(text, terms);
  if (!ranges.length) return <>{text}</>;
  const pieces: ReactNode[] = [];
  let offset = 0;
  ranges.forEach(([start, end], index) => {
    if (start > offset) pieces.push(<Fragment key={`t${index}`}>{text.slice(offset, start)}</Fragment>);
    pieces.push(<mark key={`m${index}`} className="libera-search-mark">{text.slice(start, end)}</mark>);
    offset = end;
  });
  if (offset < text.length) pieces.push(<Fragment key="rest">{text.slice(offset)}</Fragment>);
  return <>{pieces}</>;
}

function matchLabel(result: SearchResultFile) {
  const hit = result.hits[0];
  if (hit.similarity !== undefined) return `${Math.round(Math.max(0, Math.min(1, hit.similarity)) * 100)}%`;
  return "Keyword";
}

function folderOf(path: string) {
  const parts = path.split("/");
  return parts.slice(0, -1).join(" / ");
}

/** The kind icon of a result: a file type, or a book for a References entry. */
export function ResultKindIcon({ result }: { result: SearchResultFile }) {
  if (result.kind === "reference") return <BookOpen aria-hidden className="h-4 w-4" />;
  return <FileTypeIcon fileType={result.kind} name={result.name} />;
}

/** Where a result is: its folder, or for a References entry its authors, year and notebook. */
export function resultWhere(result: SearchResultFile) {
  if (result.reference) {
    const byline = [result.reference.authors, result.reference.year ? `(${result.reference.year})` : ""].filter(Boolean).join(" ");
    return [byline, `References · ${result.reference.notebook}`].filter(Boolean).join(" · ");
  }
  return result.source === "gallery" ? "Image Gallery" : folderOf(result.path);
}

export function SearchResults({
  results,
  terms,
  imagesAsGrid,
  selection,
  onSelect,
  onOpen,
}: {
  results: SearchResultFile[];
  terms: string[];
  imagesAsGrid: boolean;
  selection: SearchSelection | null;
  onSelect: (selection: SearchSelection) => void;
  onOpen: (entry: SearchEntry, placement: "tab" | "right") => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const images = results.filter((result) => result.kind === "image");
  const documents = results.filter((result) => result.kind !== "image");

  // Keep the keyboard selection in view.
  useEffect(() => {
    if (!selection) return;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-search-entry="${CSS.escape(`${selection.key}#${selection.hit}`)}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [selection]);

  const isSelected = (key: string, hit: number) => selection?.key === key && selection.hit === hit;

  function imageTile(result: SearchResultFile, large: boolean) {
    const selected = isSelected(result.key, 0);
    const image = resultImageRef(result);
    return (
      <button
        key={result.key}
        type="button"
        data-search-entry={`${result.key}#0`}
        aria-pressed={selected}
        title={`${result.source === "gallery" ? "Gallery" : folderOf(result.path) || result.path} — ${result.name}`}
        draggable
        onDragStart={(event) => {
          if (image) event.dataTransfer.setData(SEARCH_IMAGE_DRAG_MIME, JSON.stringify(image));
        }}
        className={`group relative shrink-0 overflow-hidden rounded-lg border bg-muted text-left transition ${large ? "aspect-square w-full" : "h-28 w-28"} ${selected ? "border-accent ring-2 ring-accent/40" : "border-border hover:border-foreground/30"}`}
        onClick={() => onSelect({ key: result.key, hit: 0 })}
        onDoubleClick={() => onOpen({ result, hit: 0 }, "tab")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- local files served by the app */}
        <img src={resultThumbnail(result)} alt={result.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1 pt-4 text-[11px] text-white">
          {result.name}
        </span>
        <span className="absolute right-1 top-1 rounded bg-black/55 px-1 text-[10px] font-medium text-white">{matchLabel(result)}</span>
      </button>
    );
  }

  return (
    <div ref={listRef} role="listbox" aria-label="Search results" className="flex flex-col gap-4 pb-8">
      {images.length ? (
        <section aria-label="Images">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ImageIcon aria-hidden className="h-3.5 w-3.5" /> Images
            <span className="font-normal normal-case tracking-normal">{images.length}</span>
          </h3>
          {imagesAsGrid ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
              {images.map((result) => imageTile(result, true))}
            </div>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">{images.slice(0, MAX_STRIP_IMAGES).map((result) => imageTile(result, false))}</div>
          )}
        </section>
      ) : null}

      {documents.length ? (
        <section aria-label="Documents" className="flex flex-col gap-2">
          {images.length ? (
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ScanSearch aria-hidden className="h-3.5 w-3.5" /> Documents
              <span className="font-normal normal-case tracking-normal">{documents.length}</span>
            </h3>
          ) : null}
          {documents.map((result) => (
            <article key={result.key} className="rounded-xl border border-border bg-card">
              <header className="flex items-start gap-2 px-3 pt-2.5">
                <span className="mt-0.5 text-muted-foreground"><ResultKindIcon result={result} /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold"><Highlighted text={result.name} terms={terms} /></div>
                  <div className="truncate text-xs text-muted-foreground">{resultWhere(result) || searchKindLabel(result.kind)}</div>
                </div>
                <span
                  className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
                  title={result.hits[0].similarity !== undefined ? "Similarity of the best passage to your search" : "Matched your words"}
                >
                  {matchLabel(result)}
                </span>
              </header>
              <ul className="mt-1 pb-1.5">
                {result.hits.slice(0, MAX_LISTED_HITS).map((hit, index) => {
                  const selected = isSelected(result.key, index);
                  const snippet = snippetWindow(embeddingText(result.kind, hit.text), terms, 240);
                  const location = searchLocationLabel(result.kind, hit.location);
                  return (
                    <li key={hit.chunkId}>
                      <div
                        role="option"
                        tabIndex={-1}
                        aria-selected={selected}
                        data-search-entry={`${result.key}#${index}`}
                        className={`group/hit relative mx-1.5 cursor-default rounded-lg px-2 py-1.5 ${selected ? "bg-accent/10 ring-1 ring-accent/40" : "hover:bg-muted"}`}
                        onClick={() => onSelect({ key: result.key, hit: index })}
                        onDoubleClick={() => onOpen({ result, hit: index }, "tab")}
                      >
                        {location ? <div className="mb-0.5 truncate text-[11px] font-medium text-accent">{location}</div> : null}
                        <p className="line-clamp-3 text-[13px] leading-5 text-foreground/85">
                          {snippet.clippedStart ? "… " : ""}
                          <Highlighted text={snippet.text} terms={terms} />
                          {snippet.clippedEnd ? " …" : ""}
                        </p>
                        <button
                          type="button"
                          className={`absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] shadow-sm transition ${selected ? "opacity-100" : "opacity-0 group-hover/hit:opacity-100 focus-visible:opacity-100"}`}
                          title="Open here (Enter)"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpen({ result, hit: index }, "tab");
                          }}
                        >
                          Open <ArrowUpRight aria-hidden className="h-3 w-3" />
                        </button>
                      </div>
                    </li>
                  );
                })}
                {result.hits.length > MAX_LISTED_HITS ? (
                  <li className="px-3.5 pb-1 text-[11px] text-muted-foreground">
                    +{result.hits.length - MAX_LISTED_HITS} more in this file
                  </li>
                ) : null}
              </ul>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
