"use client";

import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FilePlus2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  LayoutGrid,
  List,
  Mic,
  Plus,
  Sparkles,
  Tag,
  ArrowUpRight,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  Fragment,
  PointerEvent,
  WheelEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { encodeFilePath } from "@/components/libera/api-client";
import { FileTypeIcon } from "@/components/libera/file-type";
import {
  FILE_KIND_LABELS,
  TagChip,
  collectAllTags,
  completeTagQuery,
  fileKind,
  fileMatchesTags,
  parseTagQuery,
} from "@/components/libera/file-tags";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

import styles from "./notebook-home.module.css";
import { notebookCoverUrl } from "@/lib/notebook-illustrations";
import { NotebookIllustrationDialog } from "@/components/libera/notebook-illustration-dialog";
import { useNotebookIllustrationLibrary } from "@/components/libera/use-notebook-illustrations";
import {
  DEFAULT_NOTEBOOK_FILE_SORT,
  DEFAULT_NOTEBOOK_FILE_VIEW,
  readNotebookFileSort,
  readNotebookFileView,
  saveNotebookFileSort,
  saveNotebookFileView,
  subscribeNotebookHomePreferences,
} from "./notebook-home-preferences";

import { useWorkspaceView } from "./workspace-view-context";
import { WhereWasICard } from "./where-was-i-card";
import { useRecorderLauncher } from "@/components/libera/recording/meeting-recorder";
import { fullDateLabel, relativeTimeLabel } from "@/lib/relative-time";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.25;

type NotebookHomeProps = {
  yourName: string;
  notebook: LiberaNotebookNode;
  /** The selected entry is a linked folder from disk, so call it a folder. */
  isFolder?: boolean;
  fileTags: Record<string, string[]>;
  onEditFileTags: (file: LiberaFileNode) => void;
  onCreateMarkdown: (notebook: string) => Promise<void>;
  onCreateSlides: (notebook: string) => Promise<void>;
  onCreateLatex?: (notebook: string) => Promise<void>;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
  /** Copies an illustration into the notebook as its cover; null goes back to a random one. */
  onChangeIllustration?: (notebook: string, illustration: string | null) => Promise<void>;
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

    if (node.fileType === "markdown" || node.fileType === "latex") {
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
  isFolder = false,
  fileTags,
  onEditFileTags,
  onCreateMarkdown,
  onCreateSlides,
  onCreateLatex,
  onOpenFile,
  onChangeIllustration,
}: NotebookHomeProps) {
  const recorder = useRecorderLauncher();
  const illustrationLibrary = useNotebookIllustrationLibrary();
  const coverUrl = notebookCoverUrl(notebook, illustrationLibrary);
  const [changingIllustration, setChangingIllustration] = useState(false);
  const { files, notes, images, folders } = useMemo(
    () => collectNotebookFiles(notebook.children),
    [notebook.children],
  );
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const tagQuery = useMemo(() => parseTagQuery(fileSearchQuery), [fileSearchQuery]);
  const fileSearchResults = useMemo(() => {
    const text = tagQuery.text.toLowerCase();

    if (!text && !tagQuery.tags.length) {
      return [];
    }

    return files
      .filter((file) => file.name.toLowerCase().includes(text) && fileMatchesTags(fileTags[file.path], tagQuery.tags))
      .slice(0, 20);
  }, [tagQuery, files, fileTags]);
  // While a `tags:` filter is being typed, offer this notebook's tags to complete it.
  const tagSuggestions = useMemo(() => {
    if (tagQuery.partialTag === null) return [];
    const partial = tagQuery.partialTag.replace(/^"/, "").toLowerCase();
    const notebookTags = collectAllTags(Object.fromEntries(files.map((file) => [file.path, fileTags[file.path] ?? []])));
    return notebookTags.filter((tag) => tag.toLowerCase().startsWith(partial) && tag.toLowerCase() !== partial).slice(0, 12);
  }, [tagQuery.partialTag, files, fileTags]);
  const workspaceView = useWorkspaceView();
  const librarySort = useSyncExternalStore(
    subscribeNotebookHomePreferences,
    readNotebookFileSort,
    () => DEFAULT_NOTEBOOK_FILE_SORT,
  );
  const libraryView = useSyncExternalStore(
    subscribeNotebookHomePreferences,
    readNotebookFileView,
    () => DEFAULT_NOTEBOOK_FILE_VIEW,
  );
  const sort = workspaceView?.view?.fileSort ?? librarySort;
  const view = workspaceView?.view?.fileView ?? libraryView;
  function changeSort(fileSort: "name" | "updated") {
    if (workspaceView?.view) void workspaceView.updateView((value) => ({ ...value, fileSort }));
    else saveNotebookFileSort(fileSort);
  }
  function changeView(fileView: "grid" | "list") {
    if (workspaceView?.view) void workspaceView.updateView((value) => ({ ...value, fileView }));
    else saveNotebookFileView(fileView);
  }
  const sortedFiles = useMemo(() => [...files].sort((a, b) =>
    sort === "name" ? a.name.localeCompare(b.name) :
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  ), [files, sort]);
  const updatedAt = files.reduce((latest, file) =>
    new Date(file.updatedAt) > new Date(latest) ? file.updatedAt : latest,
    notebook.updatedAt,
  );
  const relativePath = (file: LiberaFileNode) => file.path.startsWith(`${notebook.path}/`)
    ? file.path.slice(notebook.path.length + 1) : file.path;
  const trimmedFileSearchQuery = fileSearchQuery.trim();

  function openSearchResult(file: LiberaFileNode) {
    setFileSearchQuery("");
    onOpenFile(file);
  }

  return (
    <div className={styles.home}>
      <section
        className={styles.cover}
        aria-label={notebook.name}
        style={{ "--notebook-illustration": `url("${coverUrl}")` } as CSSProperties}
      >
        <div className={styles.coverInner}>
          <header className={styles.header}>
            <div className={styles.identity}>
              <span className={styles.notebookIcon} style={{ backgroundColor: notebook.color }}>
                {notebook.emoji}
              </span>
              <div className="min-w-0">
                <h2 className={styles.title}>{notebook.name}</h2>
                <p className={styles.metadata}>
                  <FileText aria-hidden size={15} /> {notes.length} {notes.length === 1 ? "note" : "notes"}
                  <span aria-hidden>·</span> <time dateTime={updatedAt} title={fullDateLabel(updatedAt)}>Updated {relativeTimeLabel(updatedAt)}</time>
                </p>
              </div>
            </div>
            <div className={styles.actions}>
              <NewMenu
                items={[
                  { label: "Note", icon: <FileText aria-hidden size={16} />, onSelect: () => onCreateMarkdown(notebook.name) },
                  ...(onCreateLatex ? [{ label: "LaTeX document", icon: <FileCode2 aria-hidden size={16} />, onSelect: () => onCreateLatex(notebook.name) }] : []),
                  { label: "Slides", icon: <FilePlus2 aria-hidden size={16} />, onSelect: () => onCreateSlides(notebook.name) },
                  ...(recorder && !recorder.busy ? [{ label: "Audio recording", icon: <Mic aria-hidden size={16} />, onSelect: () => recorder.startRecording(notebook.name) }] : []),
                  ...(onChangeIllustration ? [{ label: "Change illustration", icon: <ImagePlus aria-hidden size={16} />, onSelect: () => setChangingIllustration(true), separated: true }] : []),
                ]}
              />
            </div>
          </header>

          <div className={styles.hero}>
            <div className={styles.search}>
              <Search aria-hidden className={styles.searchIcon} size={20} />
              <input
                aria-label={`Search files in ${notebook.name}`}
                placeholder={`Search files in this ${isFolder ? "folder" : "notebook"}… (tags:name to filter)`}
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
                    {tagSuggestions.length ? (
                      <div className={styles.tagSuggestions}>
                        <span>Tags</span>
                        {tagSuggestions.map((tag) => (
                          <button key={tag} type="button" aria-label={`Filter by tag ${tag}`} onClick={() => setFileSearchQuery((query) => completeTagQuery(query, tag))}>
                            <TagChip tag={tag} />
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {fileSearchResults.length ? fileSearchResults.map((file) => (
                      <button key={file.path} type="button" onClick={() => openSearchResult(file)}>
                        <span className={styles.fileIcon} data-type={file.fileType}><FileTypeIcon fileType={file.fileType} name={file.name} /></span>
                        <span className={styles.fileName}><strong>{file.name}</strong><small>{relativePath(file)}</small></span>
                        <span className={styles.resultTags}>{(fileTags[file.path] ?? []).map((tag) => <TagChip key={tag} tag={tag} />)}</span>
                        <span className={styles.kindChip} data-kind={fileKind(file)}>{FILE_KIND_LABELS[fileKind(file)]}</span>
                      </button>
                    )) : !tagSuggestions.length ? <p className={styles.noResults}>No files found in this {isFolder ? "folder" : "notebook"}.</p> : null}
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className={styles.content}>
        <WhereWasICard notebook={notebook} files={files} onOpenFile={(file) => { void onOpenFile(file); }} />

        <section className={styles.stats} aria-label="Notebook overview">
          <div className={styles.stat} data-tone="blue"><span className={styles.statIcon}><FileText aria-hidden /></span><div><strong>{notes.length}</strong><span>Notes</span></div></div>
          <div className={styles.stat} data-tone="green"><span className={styles.statIcon}><ImageIcon aria-hidden /></span><div><strong>{images.length}</strong><span>Images</span></div></div>
          <div className={styles.stat} data-tone="amber"><span className={styles.statIcon}><FolderOpen aria-hidden /></span><div><strong>{folders}</strong><span>Folders</span></div></div>
          <div className={styles.stat} data-tone="violet"><span className={styles.statIcon}><CalendarDays aria-hidden /></span><div><span>Last updated</span><strong className={styles.statDate} title={fullDateLabel(updatedAt)}>{relativeTimeLabel(updatedAt)}</strong></div></div>
        </section>

        <section aria-labelledby="notebook-files">
          <div className={styles.sectionHeader}>
            <h3 id="notebook-files">Files <span>{files.length}</span></h3>
            <div className={styles.fileControls}>
              <select aria-label={`Sort ${isFolder ? "folder" : "notebook"} files`} value={sort} onChange={(event) => changeSort(event.target.value === "name" ? "name" : "updated")}>
                <option value="updated">Last modified</option><option value="name">Name</option>
              </select>
              <div className={styles.viewToggle} aria-label="File view" role="group">
                <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => changeView("list")}><List size={17} /></button>
                <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => changeView("grid")}><LayoutGrid size={16} /></button>
              </div>
            </div>
          </div>
          {sortedFiles.length ? (
            <div className={view === "list" ? styles.fileList : styles.fileGrid}>
              {view === "list" ? <div className={styles.tableHeading}><span>Name</span><span>Type</span><span>Tags</span><span>Last modified</span><span /></div> : null}
              {sortedFiles.map((file) => {
                const tags = fileTags[file.path] ?? [];
                const kind = fileKind(file);
                return (
                  <div key={file.path} className={styles.fileRow}>
                    {/* The open button stretches over the whole row; the tag button sits above it. */}
                    <button className={styles.fileOpen} type="button" onClick={() => onOpenFile(file)}>
                      <span className={styles.fileDetails}>
                        <span className={styles.fileIcon} data-type={file.fileType}><FileTypeIcon fileType={file.fileType} name={file.name} /></span>
                        <span className={styles.fileName}><strong>{file.name}</strong><small>{relativePath(file)}</small></span>
                      </span>
                    </button>
                    <span className={styles.fileKind}><span className={styles.kindChip} data-kind={kind}>{FILE_KIND_LABELS[kind]}</span></span>
                    <span className={styles.fileTags}>
                      {tags.map((tag) => <TagChip key={tag} tag={tag} />)}
                      <button
                        className={styles.editTags}
                        data-empty={!tags.length}
                        type="button"
                        aria-label={`Edit tags for ${file.name}`}
                        title="Edit tags"
                        onClick={() => onEditFileTags(file)}
                      >
                        <Tag aria-hidden size={12} />{tags.length ? null : <span>Add tag</span>}
                      </button>
                    </span>
                    <time className={styles.fileDate} dateTime={file.updatedAt} title={fullDateLabel(file.updatedAt)}>{relativeTimeLabel(file.updatedAt)}</time>
                    <ArrowUpRight aria-hidden className={styles.openArrow} size={16} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <span className={styles.emptyIllustration}><FilePlus2 aria-hidden size={34} /><Sparkles aria-hidden size={20} /></span>
              <h4>Big ideas start with a blank page.</h4>
              <p>Create your first note and give this {isFolder ? "folder" : "notebook"} a little life.</p>
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
      {changingIllustration && onChangeIllustration ? (
        <NotebookIllustrationDialog
          notebook={notebook}
          coverUrl={coverUrl}
          onChange={onChangeIllustration}
          onClose={() => setChangingIllustration(false)}
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

type NewMenuItem = { label: string; icon: ReactNode; onSelect: () => void; separated?: boolean };

/** The cover's single "New" button; opens a menu of the file kinds a notebook can create. */
function NewMenu({ items }: { items: NewMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") { event.preventDefault(); triggerRef.current?.focus(); }
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
    }
  }

  return (
    <div ref={rootRef} className={styles.newMenu}>
      <button
        ref={triggerRef}
        className={styles.primaryButton}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); }
        }}
      >
        <Plus aria-hidden size={17} /> New <ChevronDown aria-hidden size={15} className={styles.newMenuChevron} data-open={open} />
      </button>
      {open ? (
        <div ref={menuRef} role="menu" aria-label="Create new" className={styles.newMenuList} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <Fragment key={item.label}>
              {item.separated ? <div role="separator" className={styles.newMenuSeparator} /> : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); item.onSelect(); }}
              >
                {item.icon} {item.label}
              </button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
