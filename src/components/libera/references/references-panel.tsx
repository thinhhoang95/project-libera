"use client";

import { popupReferenceMenu } from "./native-reference-menu";
import { DocumentStylePicker } from "@/components/libera/references/document-style-picker";
import { retractionTone } from "@/components/libera/references/retraction-badge";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  FileSearch,
  FileUp,
  ListChecks,
  Loader2,
  MoreVertical,
  Palette,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Table2,
  TextQuote,
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
import {
  claimPrivacyNotice,
  formattedReferenceForCopy,
  PrivacyNotice,
  ReresolveDialog,
  sessionWebSearchChoice,
  setSessionWebSearch,
  writeRichClipboard,
} from "@/components/libera/references/reference-candidates";
import {
  BIBLIOGRAPHY_FORMATS,
  copyBibliography,
  DOCUMENT_EXPORT_FORMATS,
  downloadBibliography,
  unresolvedNote,
  type BibliographyRequest,
  type DocumentExportFormat,
} from "@/components/libera/references/bibliography-actions";
import { ReferenceCard } from "@/components/libera/references/reference-card";
import {
  citingPaths,
  entrySearchText,
  entryMatchesWords,
  fileBaseName,
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
  openNativeReferenceActionsMenu,
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
import { useReferenceJobs } from "@/components/libera/references/use-reference-jobs";
import { useReferenceLibrary } from "@/components/libera/references/use-reference-library";
import { useReferencePreferences } from "@/components/libera/references/use-reference-preferences";
import {
  RewriteCitationsDialog,
  type ApplyCitationRewriteToTab,
  type CitationRewriteRequest,
  type RevertCitationRewriteInTab,
} from "@/components/libera/references/rewrite-citations-dialog";
import { isReferenceUndoShortcut, useReferenceUndo } from "@/components/libera/references/use-reference-undo";
import { findDuplicateGroups } from "@/lib/references/dedupe";
import { isActiveReferenceJob, type ReferenceJobRequest, type ReferenceJobStatus } from "@/lib/references/jobs-types";
import {
  BUNDLED_CSL_STYLES,
  FACT_CHECK_REQUEST_EVENT,
  REFERENCES_ADD_REQUEST_EVENT,
  REFERENCES_REVEAL_EVENT,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceLibraryOp,
  type FactCheckRequestDetail,
  type ReferenceLibrary,
  type ReferencesAddRequestDetail,
  type ReferencesRevealDetail,
} from "@/lib/references/types";
import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";

// The References panel in the left rail: the library of the selected
// notebook with search, filters and sorting, the cited-in-this-document
// highlight, row actions, the detail card, the Add box with lookups and
// candidate confirmation, drops from the notebook tree and the OS, background
// jobs for PDFs, re-resolve, the style picker, export, undo, the fact-check
// entry point and the Manage references dialog. See docs/references/plan.md
// §1.1 and §4.4.

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
  /** Library path of the active document, when it is a saved file. */
  activeDocumentPath?: string | null;
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
  /** Put a citation key rewrite into an open tab: its draft, and its saved copy when the file was rewritten. Returns the change, for undo. */
  onApplyCitationRewrite?: ApplyCitationRewriteToTab;
  /** Undo such a change in an open tab, reloading its saved copy when the file was restored. */
  onRevertCitationRewrite?: RevertCitationRewriteInTab;
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

/** After merging: every key and alias of the merged entries → the kept key, for rewriting their citations. */
export function mergeRewriteMap(keep: ReferenceEntry, merged: ReferenceEntry[]) {
  const map: Record<string, string> = {};
  for (const entry of merged) {
    for (const key of [entry.key, ...entry.aliases]) if (key.toLowerCase() !== keep.key.toLowerCase()) map[key] = keep.key;
  }
  return map;
}

function referencesCount(count: number) {
  return `${count} reference${count === 1 ? "" : "s"}`;
}

const MARKDOWN_PATH = /\.(md|markdown)$/i;

/** Library paths a tree drag carries (one path; several separated by newlines). */
function treePaths(data: string) {
  return data.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
}

function ReferencesPanelBody({
  notebook,
  tree,
  activeMarkdownDraft,
  activeDocumentPath,
  openDrafts,
  canCite,
  onCite,
  onOpenPath,
  onUploadFiles,
  request,
  onRequestHandled,
  onApplyCitationRewrite,
  onRevertCitationRewrite,
}: ReferencesPanelProps) {
  const { library, error, reload } = useReferenceLibrary(notebook);
  const undo = useReferenceUndo(notebook, library);
  const refreshToken = useMemo(() => savedMarkdownToken(tree, notebook), [tree, notebook]);
  const citations = useReferenceCitations(notebook, openDrafts, refreshToken);
  // With the library, resolved narrative citations (`@key`) count too.
  const activeKeys = useDocumentCitedKeys(activeMarkdownDraft, undefined, library);

  const [view, setViewState] = useState<PanelViewState>(() => viewStates.get(notebook) ?? DEFAULT_VIEW);
  const setView = useCallback((patch: Partial<PanelViewState>) => setViewState((current) => {
    const next = { ...current, ...patch };
    viewStates.set(notebook, next);
    return next;
  }), [notebook]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addBox, setAddBox] = useState<{ id: number; query: string; path?: string } | null>(null);
  const [menu, setMenu] = useState<{ entryId: string; point: { x: number; y: number } } | null>(null);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [editing, setEditing] = useState<{ entry?: ReferenceEntry; initial?: ReferenceEntryInput; extraOps?: ReferenceLibraryOp[] } | null>(null);
  const [deleting, setDeleting] = useState<ReferenceEntry[] | null>(null);
  const [mergeGroup, setMergeGroup] = useState<ReferenceEntry[] | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const preferences = useReferencePreferences();
  const [webSearchChoice, setWebSearchChoice] = useState(() => sessionWebSearchChoice());
  // The session's choice wins; until there is one, the Preferences default (off while it cannot be read).
  const webSearch = webSearchChoice ?? preferences?.webSearch ?? false;
  const webSearchChosen = webSearchChoice !== null;
  const [rewriteRequest, setRewriteRequest] = useState<CitationRewriteRequest | null>(null);
  const [privacyNotice, setPrivacyNotice] = useState(false);
  const [reresolving, setReresolving] = useState<ReferenceEntry | null>(null);
  const [reviewFilter, setReviewFilter] = useState<{ jobId: string; ids: Set<string> } | null>(null);
  const [factCheckOpen, setFactCheckOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const reloadLibrary = useCallback(() => void reload().catch(() => undefined), [reload]);
  const jobs = useReferenceJobs(notebook, reloadLibrary);

  const setWebSearch = useCallback((value: boolean) => {
    setSessionWebSearch(value);
    setWebSearchChoice(value);
  }, []);

  /** Offer to rewrite citations of old keys (still aliases) to their new key. */
  const offerRewrite = useCallback((map: Record<string, string>, reason: CitationRewriteRequest["reason"]) => {
    if (Object.keys(map).length) setRewriteRequest({ id: Date.now(), map, reason });
  }, []);

  /** The first online lookup of the session shows what is sent where. */
  const noteLookup = useCallback(() => {
    if (claimPrivacyNotice()) setPrivacyNotice(true);
  }, []);

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
      // The temporary filter of a job's new entries replaces the chosen filter while it is on.
      if (reviewFilter) return reviewFilter.ids.has(entry.id);
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
  }, [entries, words, searchTexts, view.filter, view.sort, activeIds, citingById, duplicateIds, reviewFilter]);
  const listedMissing = view.filter === "cited" && !reviewFilter
    ? missingKeys.filter((key) => !words.length || words.every((word) => key.toLowerCase().includes(word)))
    : [];
  const listedGroups = view.filter === "duplicates" && !reviewFilter
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

  // Revealing waits for the entry to be in the library (it may have just been added).
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const reveal = useCallback((entryId: string) => setRevealTarget(entryId), []);
  useEffect(() => {
    if (!revealTarget || !library?.entries[revealTarget]) return;
    // Show it even when the search or filter would hide it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!listed.some((item) => item.id === revealTarget)) setView({ query: "", filter: "all" });
    setSelectedId(revealTarget);
    setOpenId(revealTarget);
    setRevealTarget(null);
  }, [revealTarget, library, listed, setView]);

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

  async function copyFormatted(entry: ReferenceEntry) {
    try {
      const { text, html } = await formattedReferenceForCopy(notebook, library?.style ?? "", entry);
      await writeRichClipboard(text, html);
      setNotice({ tone: "info", text: "Reference copied." });
    } catch {
      setNotice({ tone: "error", text: "Reference could not be copied." });
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
      case "copy-formatted": return void copyFormatted(entry);
      case "reresolve": return setReresolving(entry);
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

  /** Today's entries for files that cannot be resolved: titled after the file, unresolved, attached. */
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

  async function startJob(request: Omit<ReferenceJobRequest, "notebook" | "webSearch">) {
    noteLookup();
    setReviewFilter(null);
    return jobs.start({ ...request, webSearch });
  }

  /**
   * Dropped PDFs and Markdown files: one is looked up and confirmed in the
   * Add box; several are read by a background job. Files that already have
   * an entry reveal it.
   */
  async function resolveFiles(paths: string[]) {
    const fresh = paths.filter((path) => !entryWithAttachment(library, path));
    if (!fresh.length) {
      await attachFiles(paths);
      return;
    }
    if (fresh.length === 1) {
      setOpenId(null);
      setAddBox({ id: Date.now(), query: "", path: fresh[0] });
      return;
    }
    try {
      await startJob({ action: "resolve-paths", paths: fresh });
      setNotice({ tone: "info", text: `Reading ${fresh.length} files in the background. New entries appear as they are found.` });
    } catch (jobError) {
      // Without the job, the files still get entries to complete later.
      await attachFiles(fresh);
      setNotice({ tone: "error", text: `${jobError instanceof Error ? jobError.message : "The files could not be looked up."} They were added as unresolved entries.` });
    }
  }

  async function handleDrop(event: ReactDragEvent) {
    event.preventDefault();
    setDragActive(false);
    const dragged = treePaths(event.dataTransfer.getData(TREE_FILE_MIME));
    try {
      if (dragged.length) {
        if (dragged.some((path) => !path.startsWith(`${notebook}/`))) {
          setNotice({ tone: "error", text: `Only files in ${notebook} can be added to its references.` });
          return;
        }
        const imports = dragged.filter(isImportablePath);
        for (const treePath of imports) {
          const before = library;
          const result = await importReferences({ notebook, path: treePath });
          if (before) undo.record(before, result.library, `Import ${fileBaseName(treePath)}`, result.added);
          announceLibraryChange(notebook, result.library.revision);
          setNotice({ tone: result.errors.length ? "error" : "info", text: `Imported ${result.added.length} reference${result.added.length === 1 ? "" : "s"} from ${fileBaseName(treePath)}${result.duplicates.length ? `; ${result.duplicates.length} possible duplicate${result.duplicates.length === 1 ? "" : "s"}` : ""}${result.errors.length ? `; ${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}` : ""}.` });
        }
        const files = dragged.filter((path) => droppedFileEntry(path));
        if (files.length) await resolveFiles(files);
        else if (!imports.length) setNotice({ tone: "error", text: "Drop a PDF or Markdown file, or a .bib, .ris or CSL-JSON file to import." });
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
      await resolveFiles(paths);
    } catch (dropError) {
      setNotice({ tone: "error", text: dropError instanceof Error ? dropError.message : "The drop could not be added." });
    }
  }

  // -------------------------------------------------------------------------
  // Background jobs and fact-check
  // -------------------------------------------------------------------------

  async function generateForPdfs() {
    try {
      await startJob({ action: "resolve-pdfs" });
    } catch (jobError) {
      setNotice({ tone: "error", text: jobError instanceof Error ? jobError.message : "The PDFs could not be read." });
    }
  }

  const activeIsMarkdown = Boolean(activeDocumentPath && MARKDOWN_PATH.test(activeDocumentPath) && activeMarkdownDraft !== null);
  const factCheckBlocker = !activeIsMarkdown ? "Open a saved Markdown document to fact-check its citations." : !activeKeys.length ? "This document cites nothing yet." : null;

  function requestFactCheck(withWeb: boolean) {
    if (!activeDocumentPath || factCheckBlocker) return;
    setFactCheckOpen(false);
    window.dispatchEvent(new CustomEvent<FactCheckRequestDetail>(FACT_CHECK_REQUEST_EVENT, { detail: { path: activeDocumentPath, webSearch: withWeb } }));
    setNotice({ tone: "info", text: `Fact-checking the citations of ${fileBaseName(activeDocumentPath)} in the AI panel.` });
  }

  // -------------------------------------------------------------------------
  // Formatted reference lists and document bibliographies
  // -------------------------------------------------------------------------

  const documentBlocker = activeMarkdownDraft === null ? "Open a Markdown document to use what it cites." : !activeKeys.length ? "This document cites nothing yet." : null;

  function listRequest(forDocument: boolean): BibliographyRequest {
    return forDocument ? { notebook, documentText: activeMarkdownDraft ?? "", ...(activeDocumentPath ? { documentName: activeDocumentPath } : {}) } : { notebook };
  }

  async function copyList(forDocument: boolean) {
    const what = forDocument ? "Bibliography" : "Reference list";
    try {
      const result = await copyBibliography(listRequest(forDocument));
      // Unresolved keys stay on screen until dismissed.
      setNotice({ tone: result.unresolvedKeys.length ? "error" : "info", text: `${what} copied (${referencesCount(result.count)}).${unresolvedNote(result.unresolvedKeys)}` });
    } catch (copyError) {
      setNotice({ tone: "error", text: copyError instanceof Error ? copyError.message : `${what} could not be copied.` });
    }
  }

  async function exportList(format: DocumentExportFormat, forDocument: boolean) {
    try {
      const result = await downloadBibliography({ ...listRequest(forDocument), format });
      setNotice({ tone: result.unresolvedKeys.length ? "error" : "info", text: `Exported ${result.fileName}.${unresolvedNote(result.unresolvedKeys)}` });
    } catch (exportError) {
      setNotice({ tone: "error", text: exportError instanceof Error ? exportError.message : "The reference list could not be exported." });
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

  const panelMenuProps: PanelMenuProps = {
    currentStyle,
    styleFiles,
    undoLabel: undo.canUndo ? undo.undoLabel : null,
    undoStale: undo.stale,
    onClose: () => setPanelMenuOpen(false),
    onUndo: () => void runUndo(),
    onStyle: (style) => void run([{ op: "set-style", style }], "Change citation style", `Citation style: ${BUNDLED_CSL_STYLES.find((item) => item.id === style)?.label ?? fileBaseName(style)}.`).catch(() => undefined),
    onExport: (format) => void exportReferences({ notebook, format })
      .then((fileName) => setNotice({ tone: "info", text: `Exported ${fileName}.` }))
      .catch((exportError: Error) => setNotice({ tone: "error", text: exportError.message })),
    onImport: () => { setOpenId(null); setAddBox({ id: Date.now(), query: "" }); },
    onManage: () => setManageOpen(true),
    jobActive: jobs.active,
    onGenerate: () => void generateForPdfs(),
    autoCreate: library?.settings?.autoCreateForPdfs,
    onAutoCreate: (value) => void run([{ op: "set-settings", settings: { autoCreateForPdfs: value } }], "Change automatic PDF entries",
      value === null ? "New PDFs follow the preference." : value ? `New PDFs in ${notebook} get entries automatically.` : `New PDFs in ${notebook} do not get entries automatically.`).catch(() => undefined),
    autoCreateDefault: preferences ? preferences.autoCreateForPdfs : null,
    factCheckBlocker,
    onFactCheck: () => setFactCheckOpen(true),
    onCopyList: () => void copyList(false),
    onExportList: (format) => void exportList(format, false),
    documentBlocker,
    onCopyDocument: () => void copyList(true),
    onExportDocument: (format) => void exportList(format, true),
  };

  async function openPanelMenu(button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    if (!await openNativePanelMenu(panelMenuProps, { x: rect.left, y: rect.bottom })) {
      setPanelMenuOpen((current) => !current);
    }
  }

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
    if (view.filter === "duplicates" && !reviewFilter) {
      return (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
          <DuplicateGroupsList groups={listedGroups} onMerge={setMergeGroup} onOpen={(entry) => { setSelectedId(entry.id); setOpenId(entry.id); }} />
        </div>
      );
    }
    if (!listed.length && !listedMissing.length) {
      return (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          {words.length ? "No references match." : reviewFilter ? "None of the new entries are left." : view.filter === "cited" ? (activeMarkdownDraft === null ? "Open a Markdown document to see what it cites." : "This document cites nothing yet.") : "Nothing here."}
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
      onMenu: async (point: { x: number; y: number }) => {
        setSelectedId(entry.id);
        if (!await openNativeReferenceActionsMenu({ entry, point, canCite, citing: citingOf(entry), onAction: (action) => menuAction(entry, action), onOpenPath })) {
          setMenu({ entryId: entry.id, point });
        }
      },
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
        <button type="button" className={iconButton} aria-label="Generate entries for PDFs without one" title={jobs.active ? "Reading PDFs…" : "Generate entries for PDFs without one"} disabled={!library || jobs.active} onClick={() => void generateForPdfs()}>
          <FileSearch aria-hidden className="h-4 w-4" />
        </button>
        <button type="button" className={iconButton} aria-label="Manage references" title="Manage references" disabled={!library} onClick={() => setManageOpen(true)}>
          <Table2 aria-hidden className="h-4 w-4" />
        </button>
        <div className="relative">
          <button type="button" className={iconButton} aria-label="References menu" title="Style, export and undo" aria-haspopup="menu" aria-expanded={panelMenuOpen} disabled={!library} onClick={(event) => void openPanelMenu(event.currentTarget)}>
            <MoreVertical aria-hidden className="h-4 w-4" />
          </button>
          {panelMenuOpen && library ? (
            <PanelMenu {...panelMenuProps} />
          ) : null}
        </div>
      </PanelHeading>
      <DocumentStylePicker notebook={notebook} documentPath={activeDocumentPath ?? null} draft={activeMarkdownDraft} styleFiles={styleFiles} />

      {notice ? (
        <div role={notice.tone === "error" ? "alert" : "status"} className={`mx-3 mb-2 flex items-start gap-2 rounded-lg p-2 text-[11px] leading-relaxed ${notice.tone === "error" ? "bg-destructive-muted text-destructive" : "libera-panel-card"}`}>
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.undo && undo.canUndo ? <button type="button" className="shrink-0 font-semibold text-accent hover:underline" onClick={() => { setNotice(null); void runUndo(); }}>Undo</button> : null}
          <button type="button" className="shrink-0" aria-label="Dismiss" onClick={() => setNotice(null)}><X aria-hidden className="h-3 w-3" /></button>
        </div>
      ) : null}

      {factCheckOpen ? (
        <FactCheckPopover
          path={activeDocumentPath ?? ""}
          defaultWebSearch={webSearch}
          blocker={factCheckBlocker}
          onCancel={() => setFactCheckOpen(false)}
          onStart={requestFactCheck}
        />
      ) : null}

      {jobs.job ? (
        <JobStatusLine
          job={jobs.job}
          library={library}
          error={jobs.error}
          reviewing={reviewFilter?.jobId === jobs.job.id}
          onCancel={(jobId) => void jobs.cancel(jobId)}
          onDismiss={(jobId) => {
            jobs.dismiss(jobId);
            if (reviewFilter?.jobId === jobId) setReviewFilter(null);
          }}
          onReview={(job) => {
            setOpenId(null);
            setReviewFilter({ jobId: job.id, ids: new Set([...job.createdEntryIds, ...job.updatedEntryIds]) });
          }}
        />
      ) : null}

      {addBox && library ? (
        <AddReferenceBox
          key={addBox.id}
          notebook={notebook}
          library={library}
          initialQuery={addBox.query}
          initialPath={addBox.path}
          webSearch={webSearch}
          webSearchChosen={webSearchChosen}
          webSearchDefault={preferences ? preferences.webSearch : null}
          onWebSearchChange={setWebSearch}
          apply={(ops, label) => run(ops, label)}
          record={undo.record}
          onClose={() => setAddBox(null)}
          onReveal={(entryId) => { setAddBox(null); reveal(entryId); }}
          onEditNew={(initial, extraOps) => setEditing({ initial, extraOps })}
          onMerge={(ids) => setMergeGroup(ids.map((id) => library.entries[id]).filter(Boolean))}
          onLookup={noteLookup}
          onNotice={setNotice}
        />
      ) : null}

      {privacyNotice ? <PrivacyNotice onDismiss={() => setPrivacyNotice(false)} /> : null}

      {openEntry && library ? (
        <ReferenceCard
          key={openEntry.id}
          notebook={notebook}
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
          onCopyFormatted={() => void copyFormatted(openEntry)}
          onReresolve={() => setReresolving(openEntry)}
          onOpenPath={onOpenPath}
          onEditAll={() => setEditing({ entry: openEntry })}
          onDelete={() => requestDelete(openEntry)}
          onUpdateCitations={(from, to) => offerRewrite({ [from]: to }, { kind: "rename" })}
        />
      ) : (
        <>
          {reviewFilter ? (
            <div className="flex items-center gap-1.5 px-3 pb-2" aria-label="Temporary filter">
              <span className="libera-reference-tag">
                <ListChecks aria-hidden className="h-3 w-3" /> New from the PDF lookup ({reviewFilter.ids.size})
                <button type="button" aria-label="Clear the new-entries filter" onClick={() => setReviewFilter(null)}><X aria-hidden className="h-3 w-3" /></button>
              </span>
            </div>
          ) : null}
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
          // Updates that come with a looked-up candidate (attaching a converted note) apply with it.
          const all = editing?.entry ? ops : [...ops, ...(editing?.extraOps ?? [])];
          const after = await undo.apply(all, editing?.entry ? `Edit ${editing.entry.key}` : "Add reference");
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
          const keep = library?.entries[keepId];
          const merged = mergeIds.map((id) => library?.entries[id]).filter((entry): entry is ReferenceEntry => Boolean(entry));
          await undo.apply([{ op: "merge", keepId, mergeIds }], `Merge into ${keep?.key ?? "reference"}`);
          setNotice({ tone: "info", text: `Merged into ${keep?.key ?? "the kept reference"}.`, undo: true });
          // The merged keys are aliases now, so nothing breaks; documents citing them can be rewritten to the kept key.
          if (keep && merged.some((entry) => citingOf(entry).length)) offerRewrite(mergeRewriteMap(keep, merged), { kind: "merge", keep: keep.key });
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
          webSearch={webSearch}
          onLookup={noteLookup}
          onMerged={(keep, merged) => {
            if (merged.some((entry) => citingOf(entry).length)) offerRewrite(mergeRewriteMap(keep, merged), { kind: "merge", keep: keep.key });
          }}
          blocked={Boolean(rewriteRequest)}
          onClose={() => setManageOpen(false)}
        />
      ) : null}
      <RewriteCitationsDialog
        notebook={notebook}
        request={rewriteRequest}
        openDrafts={openDrafts}
        onApplyToTab={onApplyCitationRewrite}
        onRevertTab={onRevertCitationRewrite}
        onChanged={() => void citations.reload()}
        onClose={() => setRewriteRequest(null)}
      />
      {reresolving ? (
        <ReresolveDialog
          key={reresolving.id}
          notebook={notebook}
          entry={library?.entries[reresolving.id] ?? reresolving}
          webSearch={webSearch}
          onLookup={noteLookup}
          onClose={() => setReresolving(null)}
          onApply={(op, label) => run([op], label, `Updated ${reresolving.key} from its sources.`)}
        />
      ) : null}
    </div>
  );
}

const AUTO_CREATE_CHOICES: Array<{ value: boolean | null; label: string }> = [
  { value: null, label: "Follow Preferences" },
  { value: true, label: "On for this notebook" },
  { value: false, label: "Off for this notebook" },
];

/** "Reading 3 of 12 PDFs… current file" while a job runs; "N new entries · M need review · K failed" when it is done. */
export function jobProgressText(job: ReferenceJobStatus) {
  if (job.kind === "check-retractions") {
    if (job.state === "queued") return "Waiting to check for retractions…";
    if (!job.total) return "Checking for retractions…";
    const position = Math.min(job.total, job.done + job.failed + 1);
    return `Checking ${position} of ${job.total} references for retractions…`;
  }
  const things = job.kind === "resolve-pdfs" ? "PDFs" : "files";
  if (job.state === "queued") return `Waiting to read ${things}…`;
  if (!job.total) return job.kind === "resolve-pdfs" ? "Looking for PDFs without an entry…" : "Starting…";
  const position = Math.min(job.total, job.done + job.failed + 1);
  return `Reading ${position} of ${job.total} ${things}…${job.current ? ` ${fileBaseName(job.current)}` : ""}`;
}

export function jobSummaryText(job: ReferenceJobStatus, library: ReferenceLibrary | null) {
  if (job.kind === "check-retractions") {
    const changed = job.updatedEntryIds.map((id) => library?.entries[id]).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const warnings = changed.filter((entry) => retractionTone(entry.retraction) === "warning").length;
    const notes = changed.filter((entry) => retractionTone(entry.retraction) === "note").length;
    const parts = warnings || notes ? [`${warnings} retracted or flagged`, `${notes} corrected`] : ["No new notices"];
    if (job.failed) parts.push(`${job.failed} not checked`);
    const prefix = job.state === "cancelled" ? "Stopped: " : job.state === "failed" ? "The check failed: " : "Retraction check: ";
    return `${prefix}${parts.join(" · ")}`;
  }
  const ids = [...new Set([...job.createdEntryIds, ...job.updatedEntryIds])];
  const review = ids.filter((id) => library?.entries[id] && library.entries[id].status !== "confirmed").length;
  const created = job.createdEntryIds.length;
  const parts = [`${created} new entr${created === 1 ? "y" : "ies"}`, `${review} need${review === 1 ? "s" : ""} review`, `${job.failed} failed`];
  const prefix = job.state === "cancelled" ? "Stopped: " : job.state === "failed" ? "The job failed: " : "";
  return `${prefix}${parts.join(" · ")}`;
}

function JobStatusLine({ job, library, error, reviewing, onCancel, onDismiss, onReview }: {
  job: ReferenceJobStatus;
  library: ReferenceLibrary | null;
  error: string;
  reviewing: boolean;
  onCancel: (jobId: string) => void;
  onDismiss: (jobId: string) => void;
  onReview: (job: ReferenceJobStatus) => void;
}) {
  const [showErrors, setShowErrors] = useState(false);
  const active = isActiveReferenceJob(job);
  const touched = job.createdEntryIds.length + job.updatedEntryIds.length;
  return (
    <div className="libera-panel-card mx-3 mb-2 space-y-1 p-2 text-[11px] leading-relaxed" role="status" aria-label="Background lookup" data-job-state={job.state}>
      <div className="flex items-center gap-2">
        {active ? <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" /> : job.failed || job.state === "failed" ? <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0 text-destructive" /> : <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-accent" />}
        <span className="min-w-0 flex-1 truncate" title={job.current}>{active ? jobProgressText(job) : jobSummaryText(job, library)}</span>
        {active ? (
          <button type="button" className="libera-panel-button h-6 shrink-0 px-2 text-[11px]" onClick={() => onCancel(job.id)}>Cancel</button>
        ) : (
          <button type="button" className="shrink-0" aria-label="Dismiss" onClick={() => onDismiss(job.id)}><X aria-hidden className="h-3 w-3" /></button>
        )}
      </div>
      {!active && (touched || job.errors.length) ? (
        <div className="flex flex-wrap items-center gap-2 pl-5">
          {touched ? <button type="button" className="font-medium text-accent hover:underline disabled:opacity-50" disabled={reviewing} onClick={() => onReview(job)}>Review new entries</button> : null}
          {job.errors.length ? <button type="button" className="font-medium text-accent hover:underline" aria-expanded={showErrors} onClick={() => setShowErrors((current) => !current)}>{showErrors ? "Hide errors" : "Show errors"}</button> : null}
        </div>
      ) : null}
      {showErrors && !active ? (
        <ul className="max-h-32 space-y-0.5 overflow-auto pl-5 text-destructive" aria-label="Job errors">
          {job.errors.map((item, index) => <li key={index}><span className="font-medium">{fileBaseName(item.path)}</span>: {item.message}</li>)}
        </ul>
      ) : null}
      {error ? <p className="pl-5 text-destructive">{error}</p> : null}
    </div>
  );
}

function FactCheckPopover({ path, defaultWebSearch, blocker, onCancel, onStart }: {
  path: string;
  defaultWebSearch: boolean;
  blocker: string | null;
  onCancel: () => void;
  onStart: (webSearch: boolean) => void;
}) {
  const [webSearch, setWebSearch] = useState(defaultWebSearch);
  return (
    <div className="libera-panel-card mx-3 mb-2 space-y-2 p-2.5 text-[12px]" role="dialog" aria-label="Fact-check citations">
      <p className="font-semibold">Fact-check citations</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The AI panel checks each citation in <span className="font-medium text-foreground">{fileBaseName(path)}</span> against its source and suggests corrections you can review.
      </p>
      {blocker ? <p role="alert" className="text-[11px] text-destructive">{blocker}</p> : null}
      <label className="flex items-center gap-1.5 text-[11px]">
        <input type="checkbox" checked={webSearch} onChange={(event) => setWebSearch(event.target.checked)} /> Let the AI search the web for sources
      </label>
      <div className="flex justify-end gap-1.5">
        <button type="button" className="libera-panel-button h-7 px-3" onClick={onCancel}>Cancel</button>
        <button type="button" className="libera-panel-primary h-7 px-3 text-[12px]" disabled={Boolean(blocker)} onClick={() => onStart(webSearch)}>Start fact-check</button>
      </div>
    </div>
  );
}

type PanelMenuProps = {
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
  jobActive: boolean;
  onGenerate: () => void;
  /** The notebook's setting: on, off, or unset (follow the preference). */
  autoCreate: boolean | undefined;
  onAutoCreate: (value: boolean | null) => void;
  /** The Preferences default for new PDFs, or null when it cannot be read. */
  autoCreateDefault: boolean | null;
  /** Why fact-checking is unavailable, or null. */
  factCheckBlocker: string | null;
  onFactCheck: () => void;
  /** The whole library's formatted reference list. */
  onCopyList: () => void;
  onExportList: (format: DocumentExportFormat) => void;
  /** Why the active document has no bibliography to copy or export, or null. */
  documentBlocker: string | null;
  onCopyDocument: () => void;
  onExportDocument: (format: DocumentExportFormat) => void;
};

function openNativePanelMenu(props: PanelMenuProps, point: { x: number; y: number }) {
  const styles = [...BUNDLED_CSL_STYLES, ...props.styleFiles.map((path) => ({ id: path, label: fileBaseName(path) }))];
  return popupReferenceMenu([
    { id: "undo", label: props.undoLabel ? `Undo ${props.undoLabel}` : "Nothing to undo", enabled: Boolean(props.undoLabel) && !props.undoStale, onSelect: props.onUndo },
    { type: "separator" },
    { id: "style", label: "Citation style", submenu: styles.map((style, index) => ({
      id: `style:${index}`, label: style.label, type: "radio", checked: style.id === props.currentStyle,
      onSelect: () => { if (style.id !== props.currentStyle) props.onStyle(style.id); },
    })) },
    { id: "export", label: "Export library", submenu: EXPORT_FORMATS.map((format) => ({
      id: `export:${format.id}`, label: `${format.label} (.${format.extension})`, onSelect: () => props.onExport(format.id),
    })) },
    { type: "separator" },
    { id: "copy-list", label: "Copy reference list", onSelect: props.onCopyList },
    { id: "export-list", label: "Export reference list…", submenu: BIBLIOGRAPHY_FORMATS.map((format) => ({
      id: `export-list:${format.id}`, label: format.label, onSelect: () => props.onExportList(format.id),
    })) },
    { id: "copy-document", label: "Copy bibliography", enabled: !props.documentBlocker, onSelect: props.onCopyDocument },
    { id: "export-document", label: "Export bibliography as", enabled: !props.documentBlocker, submenu: DOCUMENT_EXPORT_FORMATS.map((format) => ({
      id: `export-document:${format.id}`, label: format.label, onSelect: () => props.onExportDocument(format.id),
    })) },
    { type: "separator" },
    { id: "generate", label: "Generate entries for PDFs without one", enabled: !props.jobActive, onSelect: props.onGenerate },
    { id: "auto-create", label: "Create entries for new PDFs automatically", submenu: AUTO_CREATE_CHOICES.map((choice) => ({
      id: `auto-create:${choice.value}`, label: choice.value === null && props.autoCreateDefault !== null ? `${choice.label} (${props.autoCreateDefault ? "on" : "off"})` : choice.label,
      type: "radio", checked: (props.autoCreate ?? null) === choice.value,
      onSelect: () => { if ((props.autoCreate ?? null) !== choice.value) props.onAutoCreate(choice.value); },
    })) },
    { type: "separator" },
    { id: "fact-check", label: "Fact-check citations…", enabled: !props.factCheckBlocker, onSelect: props.onFactCheck },
    { type: "separator" },
    { id: "import", label: "Import or paste…", onSelect: props.onImport },
    { id: "manage", label: "Manage references…", onSelect: props.onManage },
  ], point);
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
  jobActive,
  onGenerate,
  autoCreate,
  onAutoCreate,
  autoCreateDefault,
  factCheckBlocker,
  onFactCheck,
  onCopyList,
  onExportList,
  documentBlocker,
  onCopyDocument,
  onExportDocument,
}: PanelMenuProps) {
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
  const chip = "rounded border border-input px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted disabled:opacity-40";
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
      <p className="flex items-center gap-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><TextQuote aria-hidden className="h-3.5 w-3.5" /> Reference list</p>
      <button type="button" role="menuitem" className={item} title="The whole library, formatted in the citation style" onClick={act(onCopyList)}>
        <Copy aria-hidden className="h-4 w-4" /> Copy reference list
      </button>
      <div className="flex flex-wrap items-center gap-1 px-2.5 py-1 text-[12px]" role="group" aria-label="Export reference list">
        <span className="mr-1 text-muted-foreground">Export reference list…</span>
        {BIBLIOGRAPHY_FORMATS.map((format) => (
          <button key={format.id} type="button" role="menuitem" className={chip} aria-label={`Export reference list as ${format.label}`} title={format.label} onClick={act(() => onExportList(format.id))}>.{format.extension}</button>
        ))}
      </div>
      <p className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">For this document</p>
      <button type="button" role="menuitem" className={item} disabled={Boolean(documentBlocker)} title={documentBlocker ?? "What the active document cites, formatted in the citation style"} onClick={act(onCopyDocument)}>
        <Copy aria-hidden className="h-4 w-4" /> Copy bibliography
      </button>
      <div className="flex flex-wrap items-center gap-1 px-2.5 py-1 text-[12px]" role="group" aria-label="Export bibliography" title={documentBlocker ?? undefined}>
        <span className="mr-1 text-muted-foreground">Export bibliography as</span>
        {DOCUMENT_EXPORT_FORMATS.map((format) => (
          <button key={format.id} type="button" role="menuitem" className={chip} disabled={Boolean(documentBlocker)} aria-label={`Export bibliography as ${format.label}`} title={format.label} onClick={act(() => onExportDocument(format.id))}>
            {format.id === "bibtex" ? "BibTeX" : format.id === "biblatex" ? "BibLaTeX" : format.id === "csl-json" ? "CSL-JSON" : format.id === "ris" ? "RIS" : `.${format.extension}`}
          </button>
        ))}
      </div>
      <div className="my-1 h-px bg-border" />
      <button type="button" role="menuitem" className={item} disabled={jobActive} title={jobActive ? "PDFs are being read" : undefined} onClick={act(onGenerate)}>
        <FileSearch aria-hidden className="h-4 w-4" /> Generate entries for PDFs without one
      </button>
      <p className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Create entries for new PDFs automatically</p>
      <div role="group" aria-label="Create entries for new PDFs automatically">
        {AUTO_CREATE_CHOICES.map((choice) => {
          const checked = (autoCreate ?? null) === choice.value;
          return (
            <button key={String(choice.value)} type="button" role="menuitemradio" aria-checked={checked} className={item} onClick={act(() => { if (!checked) onAutoCreate(choice.value); })}>
              <span className="flex w-4 justify-center">{checked ? <Check aria-hidden className="h-3.5 w-3.5" /> : null}</span>
              <span className="min-w-0 flex-1 truncate">{choice.value === null && autoCreateDefault !== null ? `${choice.label} (${autoCreateDefault ? "on" : "off"})` : choice.label}</span>
            </button>
          );
        })}
      </div>
      <div className="my-1 h-px bg-border" />
      <button type="button" role="menuitem" className={item} disabled={Boolean(factCheckBlocker)} title={factCheckBlocker ?? "Check that the cited sources support each claim"} onClick={act(onFactCheck)}>
        <ShieldCheck aria-hidden className="h-4 w-4" /> Fact-check citations…
      </button>
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
