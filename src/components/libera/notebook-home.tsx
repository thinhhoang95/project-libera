"use client";

import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  PointerEvent,
  WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { encodeFilePath } from "@/components/libera/api-client";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

type NotebookHomeProps = {
  notebook: LiberaNotebookNode;
  onCreateMarkdown: (notebook: string) => Promise<void>;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
};

type Point = {
  x: number;
  y: number;
};

function rawFileUrl(file: LiberaFileNode) {
  return `/api/files/raw/${encodeFilePath(file.path)}`;
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function collectNotebookFiles(nodes: LiberaTreeNode[]) {
  const notes: LiberaFileNode[] = [];
  const images: LiberaFileNode[] = [];

  for (const node of nodes) {
    if (node.kind === "folder") {
      const nested = collectNotebookFiles(node.children);
      notes.push(...nested.notes);
      images.push(...nested.images);
      continue;
    }

    if (node.fileType === "markdown") {
      notes.push(node);
    }

    if (node.fileType === "image") {
      images.push(node);
    }
  }

  return { notes, images };
}

export function NotebookHome({
  notebook,
  onCreateMarkdown,
  onOpenFile,
}: NotebookHomeProps) {
  const { notes, images } = useMemo(
    () => collectNotebookFiles(notebook.children),
    [notebook.children],
  );
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  return (
    <div className="min-h-[calc(100vh-120px)] overflow-auto bg-zinc-50 px-5 py-5">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-xl"
              style={{ backgroundColor: notebook.color, color: "#ffffff" }}
            >
              {notebook.emoji}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-xl font-semibold tracking-tight">
                {notebook.name}
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                {notes.length} notes · {images.length} images
              </p>
            </div>
          </div>
          <button
            className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
            type="button"
            onClick={() => onCreateMarkdown(notebook.name)}
          >
            <FileText aria-hidden className="h-4 w-4" />
            New note
          </button>
        </header>

        <section className="rounded-md border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Note files
            </h3>
            <span className="text-xs text-zinc-500">{notes.length}</span>
          </div>
          {notes.length ? (
            <div className="divide-y divide-zinc-100">
              {notes.map((note) => (
                <button
                  key={note.path}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-50"
                  type="button"
                  onClick={() => onOpenFile(note)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{note.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-zinc-500">
                      {note.path}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-zinc-400">
                    {new Date(note.updatedAt).toLocaleDateString()}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No Markdown notes in this notebook.
            </div>
          )}
        </section>

        <section className="rounded-md border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Image previews
            </h3>
            <span className="text-xs text-zinc-500">{images.length}</span>
          </div>
          {images.length ? (
            <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
              {images.map((image, index) => (
                <figure
                  key={image.path}
                  className="overflow-hidden rounded-md border border-zinc-200 bg-zinc-50"
                >
                  <button
                    className="block aspect-[4/3] w-full bg-zinc-200"
                    type="button"
                    onClick={() => setPreviewIndex(index)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated local file URLs should not use Next image optimization. */}
                    <img
                      alt={image.name}
                      className="h-full w-full object-cover"
                      src={rawFileUrl(image)}
                    />
                  </button>
                  <figcaption className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{image.name}</span>
                      <span className="block truncate text-xs text-zinc-500">
                        {image.path}
                      </span>
                    </span>
                    <button
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-300 text-zinc-600 hover:bg-white"
                      type="button"
                      aria-label={`Open ${image.name} in official viewer`}
                      title="Open official viewer"
                      onClick={() => onOpenFile(image)}
                    >
                      <ExternalLink aria-hidden className="h-4 w-4" />
                    </button>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-zinc-500">
              <ImageIcon aria-hidden className="h-4 w-4" />
              No image files in this notebook.
            </div>
          )}
        </section>
      </div>

      {previewIndex !== null ? (
        <ImagePreviewModal
          key={images[previewIndex]?.path ?? previewIndex}
          images={images}
          index={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onIndexChange={setPreviewIndex}
          onOpenOfficialViewer={(image) => {
            setPreviewIndex(null);
            onOpenFile(image);
          }}
        />
      ) : null}
    </div>
  );
}

function ImagePreviewModal({
  images,
  index,
  onClose,
  onIndexChange,
  onOpenOfficialViewer,
}: {
  images: LiberaFileNode[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  onOpenOfficialViewer: (image: LiberaFileNode) => void;
}) {
  const currentImage = images[index];
  const lastPointerRef = useRef<Point | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    lastPointerRef.current = null;
  }

  function showPrevious() {
    onIndexChange(index === 0 ? images.length - 1 : index - 1);
  }

  function showNext() {
    onIndexChange(index === images.length - 1 ? 0 : index + 1);
  }

  function changeZoom(delta: number) {
    setZoom((currentZoom) => clampZoom(currentZoom + delta));
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    setIsPanning(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!lastPointerRef.current) {
      return;
    }

    const nextPoint = { x: event.clientX, y: event.clientY };
    const previousPoint = lastPointerRef.current;
    lastPointerRef.current = nextPoint;

    setPan((currentPan) => ({
      x: currentPan.x + nextPoint.x - previousPoint.x,
      y: currentPan.y + nextPoint.y - previousPoint.y,
    }));
  }

  function handlePointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    lastPointerRef.current = null;
    setIsPanning(false);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }

      if (event.key === "ArrowLeft" && images.length > 1) {
        event.preventDefault();
        onIndexChange(index === 0 ? images.length - 1 : index - 1);
      }

      if (event.key === "ArrowRight" && images.length > 1) {
        event.preventDefault();
        onIndexChange(index === images.length - 1 ? 0 : index + 1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [images.length, index, onClose, onIndexChange]);

  if (!currentImage) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-zinc-950 text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-zinc-950 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{currentImage.name}</p>
          <p className="truncate text-xs text-zinc-400">{currentImage.path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/20 hover:bg-white/10 disabled:opacity-40"
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => changeZoom(-ZOOM_STEP)}
          >
            <ZoomOut aria-hidden className="h-4 w-4" />
          </button>
          <span className="min-w-14 text-center text-sm">{Math.round(zoom * 100)}%</span>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/20 hover:bg-white/10 disabled:opacity-40"
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => changeZoom(ZOOM_STEP)}
          >
            <ZoomIn aria-hidden className="h-4 w-4" />
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/20 hover:bg-white/10"
            type="button"
            aria-label="Reset view"
            title="Reset view"
            onClick={resetView}
          >
            <RotateCcw aria-hidden className="h-4 w-4" />
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-md border border-white/20 px-2.5 py-1.5 text-sm hover:bg-white/10"
            type="button"
            onClick={() => onOpenOfficialViewer(currentImage)}
          >
            <ExternalLink aria-hidden className="h-4 w-4" />
            Open viewer
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/20 hover:bg-white/10"
            type="button"
            aria-label="Close preview"
            title="Close"
            onClick={onClose}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div
        className={`relative min-h-0 flex-1 overflow-hidden ${
          isPanning ? "cursor-grabbing" : "cursor-grab"
        }`}
        onDoubleClick={resetView}
        onPointerCancel={handlePointerEnd}
        onPointerDown={handlePointerDown}
        onPointerLeave={handlePointerEnd}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onWheel={handleWheel}
        style={{ touchAction: "none" }}
      >
        {images.length > 1 ? (
          <>
            <button
              className="absolute left-4 top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-zinc-950/70 hover:bg-zinc-900"
              type="button"
              aria-label="Previous image"
              onClick={showPrevious}
            >
              <ChevronLeft aria-hidden className="h-5 w-5" />
            </button>
            <button
              className="absolute right-4 top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-zinc-950/70 hover:bg-zinc-900"
              type="button"
              aria-label="Next image"
              onClick={showNext}
            >
              <ChevronRight aria-hidden className="h-5 w-5" />
            </button>
          </>
        ) : null}

        <div className="flex h-full items-center justify-center p-6">
          {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated local file URLs should not use Next image optimization. */}
          <img
            alt={currentImage.name}
            className="max-h-full max-w-full select-none object-contain"
            draggable={false}
            src={rawFileUrl(currentImage)}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transition: isPanning ? "none" : "transform 120ms ease-out",
              transformOrigin: "center",
            }}
          />
        </div>
      </div>
    </div>
  );
}
