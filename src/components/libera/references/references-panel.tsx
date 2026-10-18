"use client";

import {
  Check,
  Download,
  FileUp,
  Loader2,
  MoreVertical,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import {
  AddReferenceBox,
  announceLibraryChange,
  droppedFileEntry,
  entryWithAttachment,
  importReferences,
  isImportablePath,
  TREE_FILE_MIME,
} from "@/components/libera/references/add-reference-box";
import { ReferenceCard } from "@/components/libera/references/reference-card";
import {
  citingPaths,
  entrySearchText,
  entryMatchesWords,
  fileBaseName,
  formatPlainReference,
  hasPdf,
  keyLookup,
  REFERENCE_SORTS,
  searchWords,
  sortEntries,
  type ReferenceSort,
} from "@/components/libera/references/reference-display";
import { ReferenceEditForm } from "@/components/libera/references/reference-edit-form";
import {
  MissingReferenceRow,
  REFERENCE_ROW_HEIGHT,
  ReferenceActionsMenu,
  ReferenceRow,
  type ReferenceMenuAction,
} from "@/components/libera/references/reference-row";
import {
  DeleteReferencesDialog,
  DuplicateGroupsList,
  EXPORT_FORMATS,
  exportReferences,
  ManageReferencesDialog,
  MergeReferencesDialog,
  type ExportFormat,
} from "@/components/libera/references/manage-references-dialog";
import {
  useDocumentCitedKeys,
  useReferenceCitations,
  type OpenReferenceDraft,
} from "@/components/libera/references/use-reference-citations";
import { useReferenceLibrary } from "@/components/libera/references/use-reference-library";
import { isReferenceUndoShortcut, useReferenceUndo } from "@/components/libera/references/use-reference-undo";
import { findDuplicateGroups } from "@/lib/references/dedupe";
import {
  BUNDLED_CSL_STYLES,
  REFERENCES_ADD_REQUEST_EVENT,
  REFERENCES_REVEAL_EVENT,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceLibraryOp,
  type ReferencesAddRequestDetail,
  type ReferencesRevealDetail,
} from "@/lib/references/types";
import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";

// The References panel in the left rail: the library of the selected
// notebook with search, filters and sorting, the cited-in-this-document
// highlight, row actions, the detail card, the Add box, drops from the
// notebook tree and the OS, the style picker, export, undo and the Manage
// references dialog. See docs/references/plan.md §1.1.

export type ReferenceFilter = "all" | "cited" | "review" | "uncited" | "duplicates" | "missing-pdf";

export const REFERENCE_FILTERS: Array<{ id: ReferenceFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "cited", label: "Cited in this document" },
  { id: "review", label: "Needs review" },
  { id: "uncited", label: "Uncited" },
  { id: "duplicates", label: "Duplicates" },
  { id: "missing-pdf", label: "Missing PDF" },
];

/** Lists longer than this render only the rows in view. */
export const REFERENCE_WINDOW_THRESHOLD = 300;

export type ReferencesPanelRequest =
  | { id: number; kind: "reveal"; notebook: string; entryId?: string; key?: string }
  | { id: number; kind: "add"; notebook: string; query: string };

type PanelViewState = { query: string; filter: ReferenceFilter; sort: ReferenceSort };
const DEFAULT_VIEW: PanelViewState = { query: "", filter: "all", sort: "author" };
/** Search, filter and sort per notebook, kept for the session. */
const viewStates = new Map<string, PanelViewState>();

export function resetReferencesPanelState() {
  viewStates.clear();
}

let nextRequestId = 1;

/**
 * Turns REFERENCES_REVEAL_EVENT and REFERENCES_ADD_REQUEST_EVENT into a
 * request for the panel. `onShow` switches the rail to References and
 * selects the notebook; the panel handles the request once its library has
 * loaded and calls `handled`.
 */
export function useReferencesPanelRequests(onShow: (notebook: string) => void) {
  const [request, setRequest] = useState<ReferencesPanelRequest | null>(null);
  const showRef = useRef(onShow);
  useEffect(() => {
    showRef.current = onShow;
  }, [onShow]);
  useEffect(() => {
    function reveal(event: Event) {
      const detail = (event as CustomEvent<ReferencesRevealDetail>).detail;
      if (!detail?.notebook || (!detail.entryId && !detail.key)) return;
      setRequest({ id: nextRequestId++, kind: "reveal", notebook: detail.notebook, entryId: detail.entryId, key: detail.key });
      showRef.current(detail.notebook);
    }
    function add(event: Event) {
      const detail = (event as CustomEvent<ReferencesAddRequestDetail>).detail;
      if (!detail?.notebook) return;
      setRequest({ id: nextRequestId++, kind: "add", notebook: detail.notebook, query: detail.query ?? "" });
      showRef.current(detail.notebook);
    }
    window.addEventListener(REFERENCES_REVEAL_EVENT, reveal);
    window.addEventListener(REFERENCES_ADD_REQUEST_EVENT, add);
    return () => {
      window.removeEventListener(REFERENCES_REVEAL_EVENT, reveal);
      window.removeEventListener(REFERENCES_ADD_REQUEST_EVENT, add);
    };
  }, []);
  const handled = useCallback((id: number) => setRequest((current) => current?.id === id ? null : current), []);
  return { request, handled };
}

export type ReferencesPanelProps = {
  /** The selected notebook, or "" when none is. */
  notebook: string;
  tree: LiberaTree;
  /** Markdown text of the active document (its open draft), or null when no Markdown document is active. */
  activeMarkdownDraft: string | null;
  /** Unsaved text of open Markdown tabs, for citation counts. */
  openDrafts: OpenReferenceDraft[];
  /** A Markdown editor is active, so Cite at cursor can insert. */
  canCite: boolean;
  onCite: (key: string) => void;
  onOpenPath: (path: string) => void;
  /** Upload OS files into the notebook root with the app's usual naming; resolves to the uploaded files. */
  onUploadFiles?: (notebook: string, files: File[]) => Promise<LiberaFileNode[] | void>;
  request?: ReferencesPanelRequest | null;
  onRequestHandled?: (id: number) => void;
};

export function ReferencesPanel(props: ReferencesPanelProps) {
  if (!props.notebook) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeading title="References" />
        <div className="px-3 pt-2">
          <div className="rounded-lg border border-dashed border-input p-4 text-sm text-muted-foreground">
            Select a notebook to see its references. Each notebook keeps its own library.
          </div>
        </div>
      </div>
    );
  }
  return <ReferencesPanelBody key={props.notebook} {...props} />;
}

function PanelHeading({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="libera-notebook-heading flex items-center justify-between px-3 pb-2 pt-4">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {subtitle ? <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children ? <div className="flex items-center">{children}</div> : null}
    </div>
  );
}

const iconButton = "libera-sidebar-icon-button inline-flex h-9 w-9 items-center justify-center rounded-lg disabled:pointer-events-none disabled:opacity-40";

/** Paths of `.csl` style files in a notebook. */
function notebookStyleFiles(tree: LiberaTree, notebook: string) {
  const files: string[] = [];
  const walk = (nodes: LiberaTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "folder") walk(node.children);
      else if (node.name.toLowerCase().endsWith(".csl")) files.push(node.path);
    }
  };
  walk(tree.notebooks.find((item) => item.name === notebook)?.children ?? []);
  return files.sort();
}

/** Changes when a saved Markdown file of the notebook changes, so the citation index is refetched. */
function savedMarkdownToken(tree: LiberaTree, notebook: string) {
  let count = 0;
  let latest = "";
  const walk = (nodes: LiberaTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "folder") walk(node.children);
      else if (node.fileType === "markdown") {
        count += 1;
        const stamp = `${node.updatedAt}|${node.size}`;
        if (stamp > latest) latest = stamp;
      }
    }
  };
  walk(tree.notebooks.find((item) => item.name === notebook)?.children ?? []);
  return `${count}:${latest}`;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

type Notice = { tone: "info" | "error"; text: string; undo?: boolean };

function ReferencesPanelBody({
  notebook,
  tree,
  activeMarkdownDraft,
  openDrafts,
  canCite,
  onCite,
  onOpenPath,
  onUploadFiles,
  request,
  onRequestHandled,
}: ReferencesPanelProps) {
  const { library, error, reload } = useReferenceLibrary(notebook);
  const undo = useReferenceUndo(notebook, library);
  const refreshToken = useMemo(() => savedMarkdownToken(tree, notebook), [tree, notebook]);
  const citations = useReferenceCitations(notebook, openDrafts, refreshToken);
  const activeKeys = useDocumentCitedKeys(activeMarkdownDraft);

  const [view, setViewState] = useState<PanelViewState>(() => viewStates.get(notebook) ?? DEFAULT_VIEW);
  const setView = useCallback((patch: Partial<PanelViewState>) => setViewState((current) => {
    const next = { ...current, ...patch };
    viewStates.set(notebook, next);
    return next;
  }), [notebook]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addBox, setAddBox] = useState<{ id: number; query: string } | null>(null);
  const [menu, setMenu] = useState<{ entryId: string; point: { x: number; y: number } } | null>(null);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [editing, setEditing] = useState<{ entry?: ReferenceEntry; initial?: ReferenceEntryInput } | null>(null);
  const [deleting, setDeleting] = useState<ReferenceEntry[] | null>(null);
  const [mergeGroup, setMergeGroup] = useState<ReferenceEntry[] | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const timer = window.setTimeout(() => setNotice(null), notice.undo ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const entries = useMemo(() => Object.values(library?.entries ?? {}), [library]);
  const lookup = useMemo(() => keyLookup(library), [library]);
  const citingById = useMemo(() => new Map(entries.map((entry) => [entry.id, citingPaths(entry, citations.byKey)])), [entries, citations.byKey]);
  const citingOf = useCallback((entry: ReferenceEntry) => citingById.get(entry.id) ?? citingPaths(entry, citations.byKey), [citingById, citations.byKey]);
  const duplicateGroups = useMemo(() => findDuplicateGroups(entries), [entries]);
  const duplicateIds = useMemo(() => new Set(duplicateGroups.flat().map((entry) => entry.id)), [duplicateGroups]);
  const searchTexts = useMemo(() => new Map(entries.map((entry) => [entry.id, entrySearchText(entry)])), [entries]);

  // Keys the active document cites, resolved through keys and aliases.
  const { activeIds, missingKeys } = useMemo(() => {
    const ids = new Set<string>();
    const missing: string[] = [];
    for (const key of activeKeys) {
      const entry = lookup.get(key.toLowerCase());
      if (entry) ids.add(entry.id);
      else missing.push(key);
    }
    return { activeIds: ids, missingKeys: missing };
  }, [activeKeys, lookup]);

  const words = useMemo(() => searchWords(view.query), [view.query]);
  const listed = useMemo(() => {
    const matching = entries.filter((entry) => {
      if (words.length && !entryMatchesWords(searchTexts.get(entry.id) ?? "", words)) return false;
      switch (view.filter) {
        case "cited": return activeIds.has(entry.id);
        case "review": return entry.status !== "confirmed";
        case "uncited": return !(citingById.get(entry.id)?.length);
        case "duplicates": return duplicateIds.has(entry.id);
        case "missing-pdf": return !hasPdf(entry);
        default: return true;
      }
    });
    return sortEntries(matching, view.sort);
  }, [entries, words, searchTexts, view.filter, view.sort, activeIds, citingById, duplicateIds]);
  const listedMissing = view.filter === "cited"
    ? missingKeys.filter((key) => !words.length || words.every((word) => key.toLowerCase().includes(word)))
    : [];
  const listedGroups = view.filter === "duplicates"
    ? duplicateGroups.filter((group) => group.some((entry) => listed.some((item) => item.id === entry.id)))
    : [];

  const counts = useMemo(() => ({
    all: entries.length,
    cited: activeIds.size + missingKeys.length,
    review: entries.filter((entry) => entry.status !== "confirmed").length,
    uncited: entries.filter((entry) => !(citingById.get(entry.id)?.length)).length,
    duplicates: duplicateGroups.length,
    "missing-pdf": entries.filter((entry) => !hasPdf(entry)).length,
  }), [entries, activeIds, missingKeys, citingById, duplicateGroups]);

  const run = useCallback(async (ops: ReferenceLibraryOp[], label: string, message?: string) => {
    try {
      const result = await undo.apply(ops, label);
      if (message) setNotice({ tone: "info", text: message, undo: true });
      return result;
    } catch (applyError) {
      setNotice({ tone: "error", text: applyError instanceof Error ? applyError.message : "The change could not be saved." });
      throw applyError;
    }
  }, [undo]);

  const runUndo = useCallback(async () => {
    if (!undo.canUndo) return;
    try {
      await undo.undo();
      setNotice({ tone: "info", text: `Undid ${undo.undoLabel ?? "the last change"}.` });
    } catch (undoError) {
      setNotice({ tone: "error", text: undoError instanceof Error ? undoError.message : "Could not undo." });
    }
  }, [undo]);

  const reveal = useCallback((entryId: string) => {
    const entry = library?.entries[entryId];
    if (!entry) return;
    // Show it even when the search or filter would hide it.
    const visible = listed.some((item) => item.id === entryId);
    if (!visible) setView({ query: "", filter: "all" });
    setSelectedId(entryId);
    setOpenId(entryId);
  }, [library, listed, setView]);

  // Requests from REFERENCES_REVEAL_EVENT / REFERENCES_ADD_REQUEST_EVENT, once the library is here.
  useEffect(() => {
    if (!request || request.notebook !== notebook) return;
    if (request.kind === "add") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenId(null);
      setAddBox({ id: request.id, query: request.query });
      onRequestHandled?.(request.id);
      return;
    }
    if (!library) return;
    const entry = (request.entryId ? library.entries[request.entryId] : undefined) ?? (request.key ? lookup.get(request.key.toLowerCase()) : undefined);
    if (entry) reveal(entry.id);
    else setNotice({ tone: "error", text: `“${request.key ?? request.entryId}” is not in this notebook's library.` });
    onRequestHandled?.(request.id);
  }, [request, notebook, library, lookup, reveal, onRequestHandled]);

  // Keep the selected row in view.
  const windowed = listed.length > REFERENCE_WINDOW_THRESHOLD;
  const offset = listedMissing.length * REFERENCE_ROW_HEIGHT;
  useEffect(() => {
    if (!selectedId || openId) return;
    const container = listRef.current;
    if (!container) return;
    const index = listed.findIndex((entry) => entry.id === selectedId);
    if (index < 0) return;
    const top = offset + index * REFERENCE_ROW_HEIGHT;
    const height = container.clientHeight || 600;
    if (top < container.scrollTop) container.scrollTop = top;
    else if (top + REFERENCE_ROW_HEIGHT > container.scrollTop + height) container.scrollTop = top + REFERENCE_ROW_HEIGHT - height;
  }, [selectedId, openId, listed, offset]);

  function cite(entry: ReferenceEntry) {
    if (!canCite) {
      setNotice({ tone: "error", text: "Open a Markdown document to cite into it." });
      return;
    }
    onCite(entry.key);
  }

  async function copy(text: string, what: string) {
    try {
      await copyText(text);
      setNotice({ tone: "info", text: `${what} copied.` });
    } catch {
      setNotice({ tone: "error", text: `${what} could not be copied.` });
    }
  }

  function requestDelete(entry: ReferenceEntry) {
    if (citingOf(entry).length) {
      setDeleting([entry]);
      return;
    }
    if (openId === entry.id) setOpenId(null);
    void run([{ op: "delete", id: entry.id }], `Delete ${entry.key}`, `Deleted ${entry.key}.`).catch(() => undefined);
  }

  function menuAction(entry: ReferenceEntry, action: ReferenceMenuAction) {
    const attachment = (kind: "pdf" | "markdown") => entry.attachments.find((item) => item.kind === kind);
    switch (action) {
      case "cite": return cite(entry);
      case "open-pdf": { const pdf = attachment("pdf"); if (pdf && pdf.kind !== "url") onOpenPath(pdf.path); return; }
      case "open-note": { const note = attachment("markdown"); if (note && note.kind !== "url") onOpenPath(note.path); return; }
      case "copy-key": return void copy(entry.key, "Key");
      case "copy-formatted": return void copy(formatPlainReference(entry.csl), "Reference");
      case "edit": return setEditing({ entry });
      case "delete": return requestDelete(entry);
    }
  }

  function moveSelection(step: number) {
    if (!listed.length) return;
    const index = listed.findIndex((entry) => entry.id === selectedId);
    const next = index < 0 ? (step > 0 ? 0 : listed.length - 1) : Math.max(0, Math.min(listed.length - 1, index + step));
    setSelectedId(listed[next].id);
  }

  function listKeyDown(event: ReactKeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && selectedId && library?.entries[selectedId]) {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) cite(library.entries[selectedId]);
      else setOpenId(selectedId);
    }
  }

  function panelKeyDown(event: ReactKeyboardEvent) {
    if (isReferenceUndoShortcut({ ...event, target: event.target })) {
      event.preventDefault();
      void runUndo();
    }
  }

  // -------------------------------------------------------------------------
  // Drops
  // -------------------------------------------------------------------------

  async function attachFiles(paths: string[]) {
    const fresh: ReferenceEntryInput[] = [];
    let revealId: string | null = null;
    for (const path of paths) {
      const existing = entryWithAttachment(library, path);
      if (existing) {
        revealId = existing.id;
        continue;
      }
      const input = droppedFileEntry(path);
      if (input) fresh.push(input);
    }
    if (fresh.length) {
      const before = new Set(Object.keys(library?.entries ?? {}));
      const after = await run(fresh.map((entry) => ({ op: "add", entry })), fresh.length === 1 ? `Add ${fileBaseName(paths[0])}` : `Add ${fresh.length} files`,
        fresh.length === 1 ? `Added an entry for ${fileBaseName(paths[0])}. Fill in its details or confirm it.` : `Added ${fresh.length} entries.`);
      const added = Object.keys(after.entries).filter((id) => !before.has(id));
      if (added.length === 1) revealId = added[0];
    }
    if (revealId) {
      if (!fresh.length) setNotice({ tone: "info", text: "That file is already attached to this reference." });
      reveal(revealId);
    }
  }

  async function handleDrop(event: ReactDragEvent) {
    event.preventDefault();
    setDragActive(false);
    const treePath = event.dataTransfer.getData(TREE_FILE_MIME);
    try {
      if (treePath) {
        if (!treePath.startsWith(`${notebook}/`)) {
          setNotice({ tone: "error", text: `Only files in ${notebook} can be added to its references.` });
        } else if (isImportablePath(treePath)) {
          const before = library;
          const result = await importReferences({ notebook, path: treePath });
          if (before) undo.record(before, result.library, `Import ${fileBaseName(treePath)}`, result.added);
          announceLibraryChange(notebook, result.library.revision);
          setNotice({ tone: result.errors.length ? "error" : "info", text: `Imported ${result.added.length} reference${result.added.length === 1 ? "" : "s"} from ${fileBaseName(treePath)}${result.duplicates.length ? `; ${result.duplicates.length} possible duplicate${result.duplicates.length === 1 ? "" : "s"}` : ""}${result.errors.length ? `; ${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}` : ""}.` });
        } else if (droppedFileEntry(treePath)) {
          await attachFiles([treePath]);
        } else {
          setNotice({ tone: "error", text: "Drop a PDF or Markdown file, or a .bib, .ris or CSL-JSON file to import." });
        }
        return;
      }
      const files = Array.from(event.dataTransfer.files ?? []);
      const pdfs = files.filter((file) => file.name.toLowerCase().endsWith(".pdf"));
      if (!files.length) return;
      if (!pdfs.length) {
        setNotice({ tone: "error", text: "Only PDFs can be dropped from your computer. Paste BibTeX or RIS into Add instead." });
        return;
      }
      if (!onUploadFiles) {
        setNotice({ tone: "error", text: "Files cannot be uploaded here." });
        return;
      }
      const uploaded = await onUploadFiles(notebook, pdfs);
      const paths = (uploaded ?? []).filter((file) => file.fileType === "pdf").map((file) => file.path);
      if (!paths.length) {
        setNotice({ tone: "error", text: "The PDF could not be uploaded." });
        return;
      }
      await attachFiles(paths);
    } catch (dropError) {
      setNotice({ tone: "error", text: dropError instanceof Error ? dropError.message : "The drop could not be added." });
    }
  }

  function dragOver(event: ReactDragEvent) {
    const types = Array.from(event.dataTransfer.types ?? []);
    if (!types.includes(TREE_FILE_MIME) && !types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragActive) setDragActive(true);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  const styleFiles = useMemo(() => notebookStyleFiles(tree, notebook), [tree, notebook]);
  const currentStyle = library?.style ?? "";
  const styleLabel = BUNDLED_CSL_STYLES.find((style) => style.id === currentStyle)?.label ?? (currentStyle ? fileBaseName(currentStyle) : "");
  const openEntry = openId ? library?.entries[openId] : undefined;
  const menuEntry = menu ? library?.entries[menu.entryId] : undefined;

  const first = windowed ? Math.max(0, Math.floor(Math.max(0, scroll.top - offset) / REFERENCE_ROW_HEIGHT) - 8) : 0;
  const last = windowed ? Math.min(listed.length, Math.ceil((scroll.top - offset + scroll.height) / REFERENCE_ROW_HEIGHT) + 8) : listed.length;

  function renderList() {
    if (!library) {
      if (error) {
        return (
          <div role="alert" className="mx-3 space-y-2 rounded-lg bg-destructive-muted p-3 text-xs text-destructive">
            <p>{error}</p>
            <button type="button" className="libera-panel-button h-7 px-2.5 text-foreground" onClick={() => void reload().catch(() => undefined)}>
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        );
      }
      return (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground" role="status">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Loading references…
        </div>
      );
    }
    if (!entries.length) {
      return (
        <div className="mx-3 space-y-2 rounded-lg border border-dashed border-input p-4 text-[12px] leading-relaxed text-muted-foreground" aria-label="Empty library">
          <p className="font-medium text-foreground">No references in {notebook} yet.</p>
          <p><button type="button" className="font-medium text-accent hover:underline" onClick={() => setAddBox({ id: Date.now(), query: "" })}>Add one</button> by pasting a DOI, arXiv ID, ISBN, URL, BibTeX or a whole bibliography.</p>
          <p>Drop PDFs here from the notebook or from your computer, or drop a <span className="font-mono">.bib</span> file to import it.</p>
        </div>
      );
    }
    if (view.filter === "duplicates") {
      return (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
          <DuplicateGroupsList groups={listedGroups} onMerge={setMergeGroup} onOpen={(entry) => { setSelectedId(entry.id); setOpenId(entry.id); }} />
        </div>
      );
    }
    if (!listed.length && !listedMissing.length) {
      return (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {words.length ? "No references match." : view.filter === "cited" ? (activeMarkdownDraft === null ? "Open a Markdown document to see what it cites." : "This document cites nothing yet.") : "Nothing here."}
        </p>
      );
    }
    const rowProps = (entry: ReferenceEntry) => ({
      entry,
      words,
      selected: entry.id === selectedId,
      citedByActive: activeIds.has(entry.id),
      citingCount: citingById.get(entry.id)?.length ?? 0,
      duplicate: duplicateIds.has(entry.id),
      canCite,
      onOpen: () => { setSelectedId(entry.id); setOpenId(entry.id); },
      onCite: () => cite(entry),
      onOpenAttachment: onOpenPath,
      onMenu: (point: { x: number; y: number }) => { setSelectedId(entry.id); setMenu({ entryId: entry.id, point }); },
    });
    return (
      <div
        ref={listRef}
        role="listbox"
        aria-label="References"
        aria-activedescendant={selectedId ? `reference-row-${selectedId}` : undefined}
        tabIndex={0}
        className="libera-reference-list min-h-0 flex-1 overflow-auto px-1.5 pb-4 outline-none"
        onKeyDown={listKeyDown}
        onScroll={(event) => {
          const target = event.currentTarget;
          if (windowed) setScroll({ top: target.scrollTop, height: target.clientHeight || 600 });
        }}
      >
        {listedMissing.map((key) => (
          <MissingReferenceRow key={`missing:${key}`} citationKey={key} onAdd={() => { setOpenId(null); setAddBox({ id: Date.now(), query: key }); }} />
        ))}
        {windowed ? (
          <div style={{ position: "relative", height: listed.length * REFERENCE_ROW_HEIGHT }}>
            {listed.slice(first, last).map((entry, index) => (
              <ReferenceRow key={entry.id} {...rowProps(entry)} top={(first + index) * REFERENCE_ROW_HEIGHT} />
            ))}
          </div>
        ) : listed.map((entry) => <ReferenceRow key={entry.id} {...rowProps(entry)} />)}
      </div>
    );
  }

  return (
    <div
      className="libera-references-panel relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-drag-active={dragActive || undefined}
      onKeyDown={panelKeyDown}
      onDragOver={dragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      <PanelHeading title="References" subtitle={library ? `${notebook}${styleLabel ? ` · ${styleLabel}` : ""}` : notebook}>
        <button type="button" className={iconButton} aria-label="Add references" title="Add references" aria-pressed={Boolean(addBox)} onClick={() => setAddBox((current) => current ? null : { id: Date.now(), query: "" })}>
          <Plus aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className={iconButton} aria-label="Manage references" title="Manage references" disabled={!library} onClick={() => setManageOpen(true)}>
          <Table2 aria-hidden className="h-4 w-4" />
        </button>
        <div className="relative">
          <button type="button" className={iconButton} aria-label="References menu" title="Style, export and undo" aria-haspopup="menu" aria-expanded={panelMenuOpen} disabled={!library} onClick={() => setPanelMenuOpen((current) => !current)}>
            <MoreVertical aria-hidden className="h-4 w-4" />
          </button>
          {panelMenuOpen && library ? (
            <PanelMenu
              currentStyle={currentStyle}
              styleFiles={styleFiles}
              undoLabel={undo.canUndo ? undo.undoLabel : null}
              undoStale={undo.stale}
              onClose={() => setPanelMenuOpen(false)}
              onUndo={() => void runUndo()}
              onStyle={(style) => void run([{ op: "set-style", style }], "Change citation style", `Citation style: ${BUNDLED_CSL_STYLES.find((item) => item.id === style)?.label ?? fileBaseName(style)}.`).catch(() => undefined)}
              onExport={(format) => void exportReferences({ notebook, format })
                .then((fileName) => setNotice({ tone: "info", text: `Exported ${fileName}.` }))
                .catch((exportError: Error) => setNotice({ tone: "error", text: exportError.message }))}
              onImport={() => { setOpenId(null); setAddBox({ id: Date.now(), query: "" }); }}
              onManage={() => setManageOpen(true)}
            />
          ) : null}
        </div>
      </PanelHeading>

      {notice ? (
        <div role={notice.tone === "error" ? "alert" : "status"} className={`mx-3 mb-2 flex items-start gap-2 rounded-lg p-2 text-[11px] leading-relaxed ${notice.tone === "error" ? "bg-destructive-muted text-destructive" : "libera-panel-card"}`}>
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.undo && undo.canUndo ? <button type="button" className="shrink-0 font-semibold text-accent hover:underline" onClick={() => { setNotice(null); void runUndo(); }}>Undo</button> : null}
          <button type="button" className="shrink-0" aria-label="Dismiss" onClick={() => setNotice(null)}><X aria-hidden className="h-3 w-3" /></button>
        </div>
      ) : null}

      {addBox && library ? (
        <AddReferenceBox
          key={addBox.id}
          notebook={notebook}
          library={library}
          initialQuery={addBox.query}
          apply={(ops, label) => run(ops, label)}
          record={undo.record}
          onClose={() => setAddBox(null)}
          onReveal={(entryId) => { setAddBox(null); reveal(entryId); }}
          onEditNew={(initial) => setEditing({ initial })}
          onMerge={(ids) => setMergeGroup(ids.map((id) => library.entries[id]).filter(Boolean))}
        />
      ) : null}

      {openEntry && library ? (
        <ReferenceCard
          key={openEntry.id}
          entry={openEntry}
          library={library}
          citing={citingOf(openEntry)}
          canCite={canCite}
          apply={run}
          onBack={() => {
            setOpenId(null);
            window.requestAnimationFrame?.(() => listRef.current?.focus());
          }}
          onCite={() => cite(openEntry)}
          onCopy={(text, what) => void copy(text, what)}
          onOpenPath={onOpenPath}
          onEditAll={() => setEditing({ entry: openEntry })}
          onDelete={() => requestDelete(openEntry)}
        />
      ) : (
        <>
          {library && entries.length ? (
            <div className="space-y-2 px-3 pb-2">
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchRef}
                  aria-label="Search references"
                  className="libera-sidebar-search-input h-10 w-full rounded-xl border border-input bg-card px-9 text-sm outline-none transition focus:border-ring"
                  placeholder="Search references"
                  value={view.query}
                  onChange={(event) => setView({ query: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && view.query) {
                      event.stopPropagation();
                      setView({ query: "" });
                    } else listKeyDown(event);
                  }}
                />
                {view.query ? (
                  <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Clear reference search" onClick={() => setView({ query: "" })}>
                    <X aria-hidden className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
              <div className="flex gap-1.5">
                <select
                  aria-label="Filter references"
                  className="libera-sidebar-search-input h-8 min-w-0 flex-1 appearance-none rounded-lg border border-input bg-card pl-2.5 pr-2 text-xs text-foreground outline-none transition hover:bg-muted focus-visible:border-ring"
                  value={view.filter}
                  onChange={(event) => setView({ filter: event.target.value as ReferenceFilter })}
                >
                  {REFERENCE_FILTERS.map((filter) => <option key={filter.id} value={filter.id}>{filter.label} ({counts[filter.id]})</option>)}
                </select>
                <select
                  aria-label="Sort references"
                  className="libera-sidebar-search-input h-8 w-28 shrink-0 appearance-none rounded-lg border border-input bg-card pl-2.5 pr-2 text-xs text-foreground outline-none transition hover:bg-muted focus-visible:border-ring"
                  value={view.sort}
                  onChange={(event) => setView({ sort: event.target.value as ReferenceSort })}
                >
                  {REFERENCE_SORTS.map((sort) => <option key={sort.id} value={sort.id}>{sort.label}</option>)}
                </select>
              </div>
            </div>
          ) : null}
          {renderList()}
        </>
      )}

      {dragActive ? (
        <div className="libera-reference-dropzone pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl text-sm font-medium">
          <FileUp aria-hidden className="mr-2 h-4 w-4" /> Drop to add to the references of {notebook}
        </div>
      ) : null}

      {menu && menuEntry ? (
        <ReferenceActionsMenu
          entry={menuEntry}
          point={menu.point}
          canCite={canCite}
          citing={citingOf(menuEntry)}
          onAction={(action) => menuAction(menuEntry, action)}
          onOpenPath={onOpenPath}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <ReferenceEditForm
        open={Boolean(editing)}
        entry={editing?.entry ? library?.entries[editing.entry.id] ?? editing.entry : null}
        initial={editing?.initial}
        onClose={() => setEditing(null)}
        onSubmit={async (ops) => {
          const before = new Set(Object.keys(library?.entries ?? {}));
          const after = await undo.apply(ops, editing?.entry ? `Edit ${editing.entry.key}` : "Add reference");
          const added = Object.keys(after.entries).filter((id) => !before.has(id));
          if (added.length === 1) reveal(added[0]);
        }}
      />
      <DeleteReferencesDialog
        entries={deleting}
        citing={citingOf}
        onClose={() => setDeleting(null)}
        onDelete={async (ids) => {
          if (openId && ids.includes(openId)) setOpenId(null);
          await undo.apply(ids.map((id) => ({ op: "delete", id })), ids.length === 1 ? `Delete ${library?.entries[ids[0]]?.key ?? "reference"}` : `Delete ${ids.length} references`);
          setNotice({ tone: "info", text: `Deleted ${ids.length === 1 ? library?.entries[ids[0]]?.key ?? "the reference" : `${ids.length} references`}.`, undo: true });
        }}
      />
      <MergeReferencesDialog
        group={mergeGroup}
        onClose={() => setMergeGroup(null)}
        onMerge={async (keepId, mergeIds) => {
          await undo.apply([{ op: "merge", keepId, mergeIds }], `Merge into ${library?.entries[keepId]?.key ?? "reference"}`);
          setNotice({ tone: "info", text: `Merged into ${library?.entries[keepId]?.key ?? "the kept reference"}.`, undo: true });
        }}
      />
      {library ? (
        <ManageReferencesDialog
          open={manageOpen}
          notebook={notebook}
          library={library}
          citations={citations.byKey}
          duplicateGroups={duplicateGroups}
          apply={(ops, label) => undo.apply(ops, label)}
          undo={{ canUndo: undo.canUndo, stale: undo.stale, label: undo.undoLabel, run: () => undo.undo() }}
          onClose={() => setManageOpen(false)}
        />
      ) : null}
    </div>
  );
}

function PanelMenu({
  currentStyle,
  styleFiles,
  undoLabel,
  undoStale,
  onClose,
  onUndo,
  onStyle,
  onExport,
  onImport,
  onManage,
}: {
  currentStyle: string;
  styleFiles: string[];
  undoLabel: string | null;
  undoStale: boolean;
  onClose: () => void;
  onUndo: () => void;
  onStyle: (style: string) => void;
  onExport: (format: ExportFormat) => void;
  onImport: () => void;
  onManage: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function close(event: PointerEvent) {
      if (!menuRef.current?.parentElement?.contains(event.target as Node)) onClose();
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const item = "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] hover:bg-muted disabled:opacity-40";
  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div ref={menuRef} role="menu" aria-label="References menu" className="absolute right-0 top-10 z-50 max-h-[70vh] w-64 overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg">
      <button type="button" role="menuitem" className={item} disabled={!undoLabel} title={undoStale ? "The last change was changed again elsewhere and cannot be undone" : undefined} onClick={act(onUndo)}>
        <Undo2 aria-hidden className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">{undoLabel ? `Undo ${undoLabel}` : "Nothing to undo"}</span>
        <span className="text-[11px] text-muted-foreground">⌘Z</span>
      </button>
      <div className="my-1 h-px bg-border" />
      <p className="flex items-center gap-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Palette aria-hidden className="h-3.5 w-3.5" /> Citation style</p>
      <div role="group" aria-label="Citation style">
        {[...BUNDLED_CSL_STYLES.map((style) => ({ id: style.id as string, label: style.label as string })), ...styleFiles.map((path) => ({ id: path, label: fileBaseName(path) }))].map((style) => (
          <button key={style.id} type="button" role="menuitemradio" aria-checked={style.id === currentStyle} className={item} title={style.id} onClick={act(() => { if (style.id !== currentStyle) onStyle(style.id); })}>
            <span className="flex w-4 justify-center">{style.id === currentStyle ? <Check aria-hidden className="h-3.5 w-3.5" /> : null}</span>
            <span className="min-w-0 flex-1 truncate">{style.label}</span>
          </button>
        ))}
      </div>
      <div className="my-1 h-px bg-border" />
      <p className="flex items-center gap-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><Download aria-hidden className="h-3.5 w-3.5" /> Export library</p>
      {EXPORT_FORMATS.map((format) => (
        <button key={format.id} type="button" role="menuitem" className={item} onClick={act(() => onExport(format.id))}>
          <span className="w-4" />
          <span className="min-w-0 flex-1 truncate">{format.label}</span>
          <span className="font-mono text-[11px] text-muted-foreground">.{format.extension}</span>
        </button>
      ))}
      <div className="my-1 h-px bg-border" />
      <button type="button" role="menuitem" className={item} onClick={act(onImport)}>
        <FileUp aria-hidden className="h-4 w-4" /> Import or paste…
      </button>
      <button type="button" role="menuitem" className={item} onClick={act(onManage)}>
        <Table2 aria-hidden className="h-4 w-4" /> Manage references…
      </button>
    </div>
  );
}
