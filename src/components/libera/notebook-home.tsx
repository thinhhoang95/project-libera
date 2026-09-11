"use client";

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Sparkles,
  ArrowUpRight,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type CSSProperties,
  PointerEvent,
  WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { encodeFilePath } from "@/components/libera/api-client";
import { FileTypeIcon, fileTypeLabel } from "@/components/libera/file-type";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

import styles from "./notebook-home.module.css";
import { notebookIllustrationUrl } from "@/lib/notebook-illustrations";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

type NotebookHomeProps = {
  yourName: string;
  notebook: LiberaNotebookNode;
  onCreateMarkdown: (notebook: string) => Promise<void>;
  onCreateSlides: (notebook: string) => Promise<void>;
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
  const files: LiberaFileNode[] = [];
  const notes: LiberaFileNode[] = [];
  const images: LiberaFileNode[] = [];
  let folders = 0;

  for (const node of nodes) {
    if (node.kind === "folder") {
      const nested = collectNotebookFiles(node.children);
      folders += 1 + nested.folders;
      files.push(...nested.files);
      notes.push(...nested.notes);
      images.push(...nested.images);
      continue;
    }

    files.push(node);

    if (node.fileType === "markdown") {
      notes.push(node);
    }

    if (node.fileType === "image") {
      images.push(node);
    }
  }

  return { files, notes, images, folders };
}

export function NotebookHome({
  notebook,
  onCreateMarkdown,
  onCreateSlides,
  onOpenFile,
}: NotebookHomeProps) {
  const { files, notes, images, folders } = useMemo(
    () => collectNotebookFiles(notebook.children),
    [notebook.children],
  );
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const fileSearchResults = useMemo(() => {
    const normalizedQuery = fileSearchQuery.trim().toLowerCase();

    if (!normalizedQuery) {
      return [];
    }

    return files
      .filter((file) => file.name.toLowerCase().includes(normalizedQuery))
      .slice(0, 10);
  }, [fileSearchQuery, files]);
  const [sort, setSort] = useState("updated");
  const [view, setView] = useState<"list" | "grid">("list");
  const sortedFiles = useMemo(() => [...files].sort((a, b) =>
    sort === "name" ? a.name.localeCompare(b.name) :
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  ), [files, sort]);
  const updatedAt = files.reduce((latest, file) =>
    new Date(file.updatedAt) > new Date(latest) ? file.updatedAt : latest,
    notebook.updatedAt,
  );
  const formatDate = (value: string) => new Date(value).toLocaleDateString(undefined, {
    day: "numeric", month: "short", year: "numeric",
  });
  const relativePath = (file: LiberaFileNode) => file.path.startsWith(`${notebook.path}/`)
    ? file.path.slice(notebook.path.length + 1) : file.path;
  const trimmedFileSearchQuery = fileSearchQuery.trim();

  function openSearchResult(file: LiberaFileNode) {
    setFileSearchQuery("");
    onOpenFile(file);
  }

  return (
    <div className={styles.home}>
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.notebookIcon} style={{ backgroundColor: notebook.color }}>
              {notebook.emoji}
            </span>
            <div className="min-w-0">
              <h2 className={styles.title}>{notebook.name}</h2>
              <p className={styles.metadata}>
                <FileText aria-hidden size={15} /> {notes.length} {notes.length === 1 ? "note" : "notes"}
                <span aria-hidden>·</span> Updated {formatDate(updatedAt)}
              </p>
            </div>
          </div>
          <div className={styles.actions}>
            <button className={styles.secondaryButton} type="button" onClick={() => onCreateMarkdown(notebook.name)}>
              <FileText aria-hidden size={17} /> New note
            </button>
            <button className={styles.primaryButton} type="button" onClick={() => onCreateSlides(notebook.name)}>
              <FilePlus2 aria-hidden size={17} /> New slides
            </button>
          </div>
        </header>

        <section className={styles.hero} aria-labelledby="notebook-welcome"
          style={{ "--notebook-illustration": `url("${notebookIllustrationUrl(notebook.illustration, notebook.createdAt)}")` } as CSSProperties}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}><Sparkles aria-hidden size={14} /> Keep exploring</p>
            <h1 id="notebook-welcome">What&apos;s next for {notebook.name}?</h1>
          </div>
          <div className={styles.search}>
            <Search aria-hidden className={styles.searchIcon} size={20} />
            <input
              aria-label={`Search files in ${notebook.name}`}
              placeholder="Search files in this notebook…"
              value={fileSearchQuery}
              onChange={(event) => setFileSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setFileSearchQuery("");
                if (event.key === "Enter" && fileSearchResults[0]) openSearchResult(fileSearchResults[0]);
              }}
            />
            {trimmedFileSearchQuery ? (
              <>
                <button className={styles.clearSearch} type="button" aria-label="Clear notebook search" onClick={() => setFileSearchQuery("")}><X size={16} /></button>
                <div className={styles.searchResults}>
                  {fileSearchResults.length ? fileSearchResults.map((file) => (
                    <button key={file.path} type="button" onClick={() => openSearchResult(file)}>
                      <span className={styles.fileIcon} data-type={file.fileType}><FileTypeIcon fileType={file.fileType} /></span>
                      <span className={styles.fileName}><strong>{file.name}</strong><small>{relativePath(file)}</small></span>
                      <span className={styles.fileType}>{fileTypeLabel(file.fileType)}</span>
                    </button>
                  )) : <p className={styles.noResults}>No files found in this notebook.</p>}
                </div>
              </>
            ) : null}
          </div>
        </section>

        <section className={styles.stats} aria-label="Notebook overview">
          <div className={styles.stat} data-tone="blue"><span className={styles.statIcon}><FileText aria-hidden /></span><div><strong>{notes.length}</strong><span>Notes</span></div></div>
          <div className={styles.stat} data-tone="green"><span className={styles.statIcon}><ImageIcon aria-hidden /></span><div><strong>{images.length}</strong><span>Images</span></div></div>
          <div className={styles.stat} data-tone="amber"><span className={styles.statIcon}><FolderOpen aria-hidden /></span><div><strong>{folders}</strong><span>Folders</span></div></div>
          <div className={styles.stat} data-tone="violet"><span className={styles.statIcon}><CalendarDays aria-hidden /></span><div><span>Last updated</span><strong className={styles.statDate}>{formatDate(updatedAt)}</strong></div></div>
        </section>

        <section aria-labelledby="notebook-files">
          <div className={styles.sectionHeader}>
            <h3 id="notebook-files">Files <span>{files.length}</span></h3>
            <div className={styles.fileControls}>
              <select aria-label="Sort notebook files" value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="updated">Last modified</option><option value="name">Name</option>
              </select>
              <div className={styles.viewToggle} aria-label="File view" role="group">
                <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><List size={17} /></button>
                <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid size={16} /></button>
              </div>
            </div>
          </div>
          {sortedFiles.length ? (
            <div className={view === "list" ? styles.fileList : styles.fileGrid}>
              {view === "list" ? <div className={styles.tableHeading}><span>Name</span><span>Last modified</span><span /></div> : null}
              {sortedFiles.map((file) => (
                <button key={file.path} className={styles.fileRow} type="button" onClick={() => onOpenFile(file)}>
                  <span className={styles.fileDetails}>
                    <span className={styles.fileIcon} data-type={file.fileType}><FileTypeIcon fileType={file.fileType} /></span>
                    <span className={styles.fileName}><strong>{file.name}</strong><small>{relativePath(file)}</small></span>
                  </span>
                  <time className={styles.fileDate} dateTime={file.updatedAt}>{formatDate(file.updatedAt)}</time>
                  <ArrowUpRight aria-hidden className={styles.openArrow} size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <span className={styles.emptyIllustration}><FilePlus2 aria-hidden size={34} /><Sparkles aria-hidden size={20} /></span>
              <h4>Big ideas start with a blank page.</h4>
              <p>Create your first note and give this notebook a little life.</p>
              <button className={styles.primaryButton} type="button" onClick={() => onCreateMarkdown(notebook.name)}><FilePlus2 aria-hidden size={16} /> Create a note</button>
            </div>
          )}
        </section>

        {images.length ? (
          <section aria-labelledby="notebook-images">
            <div className={styles.sectionHeader}><h3 id="notebook-images">Image gallery <span>{images.length}</span></h3></div>
            <div className={styles.gallery}>
              {images.map((image, index) => (
                <figure key={image.path}>
                  <button className={styles.imagePreview} type="button" aria-label={`Preview ${image.name}`} onClick={() => setPreviewIndex(index)}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated local file URLs should not use Next image optimization. */}
                    <img alt={image.name} loading="lazy" src={rawFileUrl(image)} />
                  </button>
                  <figcaption><span>{image.name}</span><button type="button" aria-label={`Open ${image.name} in official viewer`} onClick={() => onOpenFile(image)}><ExternalLink aria-hidden size={16} /></button></figcaption>
                </figure>
              ))}
            </div>
          </section>
        ) : null}
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
          <p className="truncate text-xs text-muted-foreground">{currentImage.path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 hover:bg-white/10 disabled:opacity-40"
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 hover:bg-white/10 disabled:opacity-40"
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => changeZoom(ZOOM_STEP)}
          >
            <ZoomIn aria-hidden className="h-4 w-4" />
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 hover:bg-white/10"
            type="button"
            aria-label="Reset view"
            title="Reset view"
            onClick={resetView}
          >
            <RotateCcw aria-hidden className="h-4 w-4" />
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-white/20 px-2.5 py-1.5 text-sm hover:bg-white/10"
            type="button"
            onClick={() => onOpenOfficialViewer(currentImage)}
          >
            <ExternalLink aria-hidden className="h-4 w-4" />
            Open viewer
          </button>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/20 hover:bg-white/10"
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
