"use client";

import { popupReferenceMenu } from "./native-reference-menu";
import { DocumentStylePicker } from "@/components/libera/references/document-style-picker";
import { retractionTone } from "@/components/libera/references/retraction-badge";
import {
  AlertCircle,
  BookCheck,
  BookOpen,
  Braces,
  Check,
  Copy,
  Download,
  FileSearch,
  FileUp,
  Link2,
  ListChecks,
  Loader2,
  MoreVertical,
  Palette,
  Plus,
  Quote,
  RefreshCw,
  ScrollText,
  Search,
  ShieldCheck,
  Table2,
  Tag,
  TextQuote,
  Trash2,
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
  type BibliographyFormat,
  type BibliographyRequest,
  type DocumentExportFormat,
} from "@/components/libera/references/bibliography-actions";
import { BibTetherDialog } from "@/components/libera/references/bib-tether-dialog";
import { ReferenceCard } from "@/components/libera/references/reference-card";
import {
  changedTags,
  citationText,
  citingPaths,
  entrySearchText,
  entryMatchesWords,
  fileBaseName,
  hasPdf,
  hasTag,
  keyLookup,
  libraryTags,
  REFERENCE_SORTS,
  searchWords,
  sortEntries,
  tagChangeText,
  type CitationCopyFormat,
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
import type { CitationSnippet } from "@/lib/references/occurrences";
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
import { tetherStateText, useBibTether } from "@/components/libera/references/use-bib-tether";
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
import type { TetherStatus } from "@/lib/references/bib-tether-types";
import { findDuplicateGroups } from "@/lib/references/dedupe";
import { isActiveReferenceJob, type ReferenceJobRequest, type ReferenceJobStatus } from "@/lib/references/jobs-types";
import {
  BUNDLED_CSL_STYLES,
  FACT_CHECK_REQUEST_EVENT,
  REFERENCES_ADD_REQUEST_EVENT,
  REFERENCES_COMMAND_EVENT,
  REFERENCES_REVEAL_EVENT,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceLibraryOp,
  type FactCheckRequestDetail,
  type ReadingState,
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

export type ReferenceFilter = "all" | "cited" | "review" | "to-read" | "uncited" | "duplicates" | "missing-pdf";

export const REFERENCE_FILTERS: Array<{ id: ReferenceFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "cited", label: "Cited in this document" },
  { id: "review", label: "Needs review" },
  { id: "to-read", label: "To read" },
  { id: "uncited", label: "Uncited" },
  { id: "duplicates", label: "Duplicates" },
  { id: "missing-pdf", label: "Missing PDF" },
];

/** Lists longer than this render only the rows in view. */
export const REFERENCE_WINDOW_THRESHOLD = 300;

/** An action of the panel run from outside it, such as the command palette. */
export type ReferencesPanelCommand =
  /** Focus the search box, to find an entry and cite it at the cursor. */
  | { action: "search" }
  | { action: "manage" }
  | { action: "generate" }
  | { action: "fact-check" }
  | { action: "undo" }
  | { action: "copy-list" }
  | { action: "copy-bibliography" }
  | { action: "export-library"; format: ExportFormat }
  | { action: "export-list"; format: BibliographyFormat }
  | { action: "export-bibliography"; format: DocumentExportFormat }
  | { action: "style"; style: string }
  | { action: "filter"; filter: ReferenceFilter };
export type ReferencesCommandDetail = { notebook: string; command: ReferencesPanelCommand };

/** Shows the References panel for `notebook` and runs `command` there. */
export function runReferencesCommand(notebook: string, command: ReferencesPanelCommand) {
  window.dispatchEvent(new CustomEvent<ReferencesCommandDetail>(REFERENCES_COMMAND_EVENT, { detail: { notebook, command } }));
}

export type ReferencesPanelRequest =
  | { id: number; kind: "reveal"; notebook: string; entryId?: string; key?: string }
  | { id: number; kind: "add"; notebook: string; query: string }
  | { id: number; kind: "command"; notebook: string; command: ReferencesPanelCommand };

type PanelViewState = { query: string; filter: ReferenceFilter; sort: ReferenceSort; tag: string | null };
const DEFAULT_VIEW: PanelViewState = { query: "", filter: "all", sort: "author", tag: null };
/** Search, filter, sort and tag per notebook: kept for the session, and in localStorage across restarts. */
const viewStates = new Map<string, PanelViewState>();
const VIEW_STORAGE_PREFIX = "libera:references-view:";

function storedView(notebook: string): PanelViewState | null {
  try {
    const raw = window.localStorage.getItem(`${VIEW_STORAGE_PREFIX}${notebook}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PanelViewState>;
    return {
      query: typeof value.query === "string" ? value.query : "",
      filter: REFERENCE_FILTERS.some((filter) => filter.id === value.filter) ? value.filter as ReferenceFilter : "all",
      sort: REFERENCE_SORTS.some((sort) => sort.id === value.sort) ? value.sort as ReferenceSort : "author",
      tag: typeof value.tag === "string" && value.tag ? value.tag : null,
    };
  } catch {
    return null;
  }
}

function storeView(notebook: string, view: PanelViewState) {
  try {
    window.localStorage.setItem(`${VIEW_STORAGE_PREFIX}${notebook}`, JSON.stringify(view));
  } catch {
    // Storage unavailable: the view is kept for the session only.
  }
}

function initialView(notebook: string) {
  return viewStates.get(notebook) ?? storedView(notebook) ?? DEFAULT_VIEW;
}

export function resetReferencesPanelState() {
  viewStates.clear();
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(VIEW_STORAGE_PREFIX)) window.localStorage.removeItem(key);
  } catch {
    // Nothing stored.
  }
}

/** A `:::bibliography` marker anywhere in a document (remark-bibliography's BIBLIOGRAPHY_MARKER, per line). */
const BIBLIOGRAPHY_MARKER_LINES = /^:::bibliography[ \t]*\r?\n[ \t]*:::[ \t]*$/m;

/** Files that can be imported as text when dropped from the computer. */
const IMPORTABLE_FILE = /\.(bib|ris|nbib|json)$/i;

/** The text of a citing document: its open draft, else the saved file. */
async function documentText(path: string, openDrafts: OpenReferenceDraft[]) {
  const draft = openDrafts.find((item) => item.path === path);
  if (draft) return draft.text;
  const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${fileBaseName(path)} could not be read.`);
  const body = await response.json() as { content?: unknown };
  if (typeof body.content !== "string") throw new Error(`${fileBaseName(path)} could not be read.`);
  return body.content;
}

/** True when keys typed into this element are text, not shortcuts. */
function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
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
    function command(event: Event) {
      const detail = (event as CustomEvent<ReferencesCommandDetail>).detail;
      if (!detail?.notebook || !detail.command) return;
      setRequest({ id: nextRequestId++, kind: "command", notebook: detail.notebook, command: detail.command });
      showRef.current(detail.notebook);
    }
    window.addEventListener(REFERENCES_REVEAL_EVENT, reveal);
    window.addEventListener(REFERENCES_ADD_REQUEST_EVENT, add);
    window.addEventListener(REFERENCES_COMMAND_EVENT, command);
    return () => {
      window.removeEventListener(REFERENCES_REVEAL_EVENT, reveal);
      window.removeEventListener(REFERENCES_ADD_REQUEST_EVENT, add);
      window.removeEventListener(REFERENCES_COMMAND_EVENT, command);
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
  /** Cite several works at the cursor as one citation, `[@a; @b]`. */
  onCiteMany?: (keys: string[]) => void;
  onOpenPath: (path: string) => void;
  /** Open a Markdown document with a citation in it selected. */
  onOpenCitation?: (path: string, range: { start: number; end: number; line: number }) => void;
  /** Insert a `:::bibliography` marker at the cursor of the active Markdown editor. */
  onInsertBibliography?: () => void;
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
  onCiteMany,
  onOpenPath,
  onOpenCitation,
  onInsertBibliography,
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

  const [view, setViewState] = useState<PanelViewState>(() => initialView(notebook));
  const setView = useCallback((patch: Partial<PanelViewState>) => setViewState((current) => {
    const next = { ...current, ...patch };
    viewStates.set(notebook, next);
    storeView(notebook, next);
    return next;
  }), [notebook]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Entries selected together (⌘/Ctrl-click, Shift-click, Shift+↑/↓, ⌘/Ctrl+A), for bulk actions. */
  const [multi, setMulti] = useState<Set<string>>(() => new Set());
  const [bulkTags, setBulkTags] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [addBox, setAddBox] = useState<{ id: number; query: string; path?: string } | null>(null);
  const [menu, setMenu] = useState<{ entryId: string; point: { x: number; y: number } } | null>(null);
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [editing, setEditing] = useState<{ entry?: ReferenceEntry; initial?: ReferenceEntryInput; extraOps?: ReferenceLibraryOp[] } | null>(null);
  const [deleting, setDeleting] = useState<ReferenceEntry[] | null>(null);
  const [mergeGroup, setMergeGroup] = useState<ReferenceEntry[] | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [tetherOpen, setTetherOpen] = useState(false);
  const bibTether = useBibTether(notebook);
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
  const panelRef = useRef<HTMLDivElement>(null);

  // Opening a card unmounts the list (or the previous card) and with it the
  // focused element; the card takes focus so its keys keep working. Focus
  // elsewhere, such as an editor, is left alone.
  useEffect(() => {
    if (!openId) return;
    const frame = window.requestAnimationFrame?.(() => {
      const active = document.activeElement;
      if (active && active !== document.body && !panelRef.current?.contains(active)) return;
      panelRef.current?.querySelector<HTMLElement>(".libera-reference-card")?.focus({ preventScroll: true });
    });
    return () => { if (frame !== undefined) window.cancelAnimationFrame?.(frame); };
  }, [openId]);

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
  const tags = useMemo(() => libraryTags(entries), [entries]);
  const knownTags = useMemo(() => tags.map((item) => item.tag), [tags]);
  // A tag no entry carries any more is not a filter.
  const activeTag = view.tag && tags.some((item) => item.tag.toLowerCase() === view.tag!.toLowerCase()) ? view.tag : null;

  // "Recently cited": when a document citing each entry last changed. Open drafts count as now.
  const citedAt = useMemo(() => {
    const changed = new Map<string, string>();
    const walk = (nodes: LiberaTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "folder") walk(node.children);
        else if (node.fileType === "markdown") changed.set(node.path, node.updatedAt);
      }
    };
    walk(tree.notebooks.find((item) => item.name === notebook)?.children ?? []);
    const now = new Date().toISOString();
    for (const draft of openDrafts) changed.set(draft.path, now);
    const result = new Map<string, string>();
    for (const [id, paths] of citingById) {
      let latest = "";
      for (const path of paths) {
        const stamp = changed.get(path) ?? "";
        if (stamp > latest) latest = stamp;
      }
      if (paths.length) result.set(id, latest || "0");
    }
    return result;
  }, [tree, notebook, openDrafts, citingById]);

  // PDFs and notes of the notebook, for the card's Attach file.
  const attachableFiles = useMemo(() => {
    const files: Array<{ path: string; kind: "pdf" | "markdown" }> = [];
    const walk = (nodes: LiberaTreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "folder") walk(node.children);
        else if (node.fileType === "pdf") files.push({ path: node.path, kind: "pdf" });
        else if (node.fileType === "markdown") files.push({ path: node.path, kind: "markdown" });
      }
    };
    walk(tree.notebooks.find((item) => item.name === notebook)?.children ?? []);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }, [tree, notebook]);

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
      if (activeTag && !hasTag(entry, activeTag)) return false;
      // The temporary filter of a job's new entries replaces the chosen filter while it is on.
      if (reviewFilter) return reviewFilter.ids.has(entry.id);
      switch (view.filter) {
        case "cited": return activeIds.has(entry.id);
        case "review": return entry.status !== "confirmed";
        case "to-read": return entry.reading === "to-read";
        case "uncited": return !(citingById.get(entry.id)?.length);
        case "duplicates": return duplicateIds.has(entry.id);
        case "missing-pdf": return !hasPdf(entry);
        default: return true;
      }
    });
    return sortEntries(matching, view.sort, { citedAt });
  }, [entries, words, searchTexts, activeTag, view.filter, view.sort, citedAt, activeIds, citingById, duplicateIds, reviewFilter]);
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
    "to-read": entries.filter((entry) => entry.reading === "to-read").length,
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
    if (!listed.some((item) => item.id === revealTarget)) setView({ query: "", filter: "all", tag: null });
    setSelectedId(revealTarget);
    setOpenId(revealTarget);
    setRevealTarget(null);
  }, [revealTarget, library, listed, setView]);

  // Requests from REFERENCES_REVEAL_EVENT / REFERENCES_ADD_REQUEST_EVENT, once the library is here.
  useEffect(() => {
    if (!request || request.notebook !== notebook || request.kind === "command") return;
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

  /** Selected entries in list order: the multi-selection, else the focused row. */
  const selection = useMemo(() => {
    if (multi.size) return listed.filter((entry) => multi.has(entry.id));
    const focused = selectedId ? library?.entries[selectedId] : undefined;
    return focused ? [focused] : [];
  }, [multi, listed, selectedId, library]);
  const multiSelection = multi.size ? selection : [];

  function clearMulti() {
    setMulti((current) => current.size ? new Set() : current);
    setBulkTags(false);
  }

  function citeMany(group: ReferenceEntry[]) {
    if (group.length === 1) return cite(group[0]);
    if (!canCite) {
      setNotice({ tone: "error", text: "Open a Markdown document to cite into it." });
      return;
    }
    if (onCiteMany) onCiteMany(group.map((entry) => entry.key));
    else for (const entry of group) onCite(entry.key);
  }

  function copyCitation(group: ReferenceEntry[], format: CitationCopyFormat) {
    if (group.length) void copy(citationText(group.map((entry) => entry.key), format), group.length === 1 ? "Citation" : `Citation of ${group.length} references`);
  }

  async function copyFormattedMany(group: ReferenceEntry[]) {
    if (group.length === 1) return copyFormatted(group[0]);
    try {
      const parts = await Promise.all(group.map((entry) => formattedReferenceForCopy(notebook, library?.style ?? "", entry)));
      await writeRichClipboard(parts.map((part) => part.text).join("\n"), parts.map((part) => `<p>${part.html}</p>`).join(""));
      setNotice({ tone: "info", text: `${group.length} references copied.` });
    } catch {
      setNotice({ tone: "error", text: "The references could not be copied." });
    }
  }

  function setReading(group: ReferenceEntry[], reading: ReadingState | null) {
    const changing = group.filter((entry) => (entry.reading ?? null) !== reading);
    if (!changing.length) return;
    const what = reading === "to-read" ? "To read" : reading === "read" ? "read" : "without a reading flag";
    const label = changing.length === 1 ? `Mark ${changing[0].key} ${what}` : `Mark ${changing.length} references ${what}`;
    void run(changing.map((entry) => ({ op: "update", id: entry.id, reading })), label, changing.length === 1 ? undefined : `${changing.length} references marked ${what}.`).catch(() => undefined);
  }

  function toggleReading(entry: ReferenceEntry, reading: ReadingState) {
    setReading([entry], entry.reading === reading ? null : reading);
  }

  function changeTags(group: ReferenceEntry[], add: string[], remove: string[]) {
    const ops: ReferenceLibraryOp[] = [];
    for (const entry of group) {
      const next = changedTags(entry, add, remove);
      if (next) ops.push({ op: "update", id: entry.id, tags: next });
    }
    if (!ops.length) return;
    const { label, message } = tagChangeText(ops.length, add, remove);
    void run(ops, label, message).catch(() => undefined);
  }

  function confirmMany(group: ReferenceEntry[]) {
    const ops: ReferenceLibraryOp[] = group.filter((entry) => entry.status !== "confirmed").map((entry) => ({ op: "update", id: entry.id, status: "confirmed" }));
    if (!ops.length) return;
    void run(ops, ops.length === 1 ? "Confirm 1 reference" : `Confirm ${ops.length} references`, `${ops.length} marked confirmed.`).catch(() => undefined);
  }

  function deleteMany(group: ReferenceEntry[]) {
    if (!group.length) return;
    if (group.length === 1) return requestDelete(group[0]);
    setDeleting(group);
  }

  function showTag(tag: string) {
    clearMulti();
    setOpenId(null);
    setView({ tag });
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
      case "copy-citation": return copyCitation([entry], "pandoc");
      case "copy-latex": return copyCitation([entry], "latex");
      case "copy-formatted": return void copyFormatted(entry);
      case "to-read": return toggleReading(entry, "to-read");
      case "read": return toggleReading(entry, "read");
      case "reresolve": return setReresolving(entry);
      case "edit": return setEditing({ entry });
      case "delete": return requestDelete(entry);
    }
  }

  /** Select from the anchor (the focused row) to `entryId`, in list order. */
  function selectRange(entryId: string) {
    const from = listed.findIndex((entry) => entry.id === (selectedId ?? entryId));
    const to = listed.findIndex((entry) => entry.id === entryId);
    if (from < 0 || to < 0) return;
    const [low, high] = from < to ? [from, to] : [to, from];
    setMulti(new Set(listed.slice(low, high + 1).map((entry) => entry.id)));
  }

  function moveSelection(step: number, extend = false) {
    if (!listed.length) return;
    const index = listed.findIndex((entry) => entry.id === selectedId);
    const next = index < 0 ? (step > 0 ? 0 : listed.length - 1) : Math.max(0, Math.min(listed.length - 1, index + step));
    const nextId = listed[next].id;
    if (extend && selectedId) {
      setMulti((current) => {
        const updated = new Set(current.size ? current : [selectedId]);
        // Moving back over a selected row deselects the row being left.
        if (updated.has(nextId) && updated.size > 1) updated.delete(selectedId);
        else updated.add(nextId);
        return updated;
      });
    } else if (!extend) {
      clearMulti();
    }
    setSelectedId(nextId);
  }

  function openRow(entry: ReferenceEntry, modifiers: { range: boolean; toggle: boolean }) {
    if (modifiers.range && selectedId) {
      selectRange(entry.id);
      return;
    }
    if (modifiers.toggle) {
      setMulti((current) => {
        const next = new Set(current.size ? current : selectedId && selectedId !== entry.id ? [selectedId] : []);
        if (next.has(entry.id)) next.delete(entry.id);
        else next.add(entry.id);
        return next;
      });
      setSelectedId(entry.id);
      return;
    }
    clearMulti();
    setSelectedId(entry.id);
    setOpenId(entry.id);
  }

  function listKeyDown(event: ReactKeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    // Letter shortcuts only from the list itself: in the search field they are typing.
    const fromList = event.target === listRef.current;
    const focused = selectedId ? library?.entries[selectedId] : undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
    } else if (event.key === "Enter" && focused) {
      event.preventDefault();
      if (mod) citeMany(selection);
      else {
        clearMulti();
        setOpenId(focused.id);
      }
    } else if (!fromList) {
      return;
    } else if (event.key === " " && focused) {
      event.preventDefault();
      setOpenId(focused.id);
    } else if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setMulti(new Set(listed.map((entry) => entry.id)));
    } else if (mod && event.key.toLowerCase() === "c" && selection.length) {
      event.preventDefault();
      if (event.shiftKey) void copyFormattedMany(selection);
      else void copy(selection.map((entry) => entry.key).join(", "), selection.length === 1 ? "Key" : `${selection.length} keys`);
    } else if ((event.key === "Delete" || event.key === "Backspace") && selection.length) {
      event.preventDefault();
      deleteMany(selection);
    } else if (!mod && !event.altKey && event.key.toLowerCase() === "e" && focused) {
      event.preventDefault();
      setEditing({ entry: focused });
    } else if (event.key === "Escape" && multi.size) {
      event.preventDefault();
      event.stopPropagation();
      clearMulti();
    }
  }

  function panelKeyDown(event: ReactKeyboardEvent) {
    if (isReferenceUndoShortcut({ ...event, target: event.target })) {
      event.preventDefault();
      void runUndo();
      return;
    }
    if (event.nativeEvent.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (openEntry) {
      if (mod && event.shiftKey && event.key === "Enter" && openEntry.status !== "confirmed") {
        event.preventDefault();
        void confirmAndNext();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        stepCard(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Escape" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        closeCard();
      }
      return;
    }
    if ((event.key === "/" && !isEditableTarget(event.target)) || (mod && !event.shiftKey && event.key.toLowerCase() === "f")) {
      if (!searchRef.current) return;
      event.preventDefault();
      searchRef.current.focus();
      searchRef.current.select();
    }
  }

  // -------------------------------------------------------------------------
  // The card: previous/next and review
  // -------------------------------------------------------------------------

  const openEntry = openId ? library?.entries[openId] : undefined;
  const openIndex = openEntry ? listed.findIndex((entry) => entry.id === openEntry.id) : -1;
  const reviewLeft = openEntry ? listed.filter((entry) => entry.status !== "confirmed" && entry.id !== openEntry.id).length : 0;

  function closeCard() {
    setOpenId(null);
    window.requestAnimationFrame?.(() => listRef.current?.focus());
  }

  function stepCard(step: number) {
    if (openIndex < 0) return;
    const next = listed[openIndex + step];
    if (!next) return;
    setSelectedId(next.id);
    setOpenId(next.id);
  }

  /** The next entry after `fromId` in the list that still needs review, wrapping around. */
  function nextToReview(fromId: string) {
    const index = listed.findIndex((entry) => entry.id === fromId);
    for (let step = 1; step <= listed.length; step += 1) {
      const entry = listed[(Math.max(index, 0) + step) % listed.length];
      if (entry.id !== fromId && entry.status !== "confirmed") return entry;
    }
    return undefined;
  }

  async function confirmAndNext() {
    if (!openEntry) return;
    const next = nextToReview(openEntry.id);
    try {
      if (openEntry.status !== "confirmed") await run([{ op: "update", id: openEntry.id, status: "confirmed" }], `Confirm ${openEntry.key}`);
    } catch {
      return;
    }
    if (next) {
      setSelectedId(next.id);
      setOpenId(next.id);
    } else {
      closeCard();
      setNotice({ tone: "info", text: "Every reference in this list is confirmed.", undo: true });
    }
  }

  function openCitation(path: string, snippet: CitationSnippet) {
    if (onOpenCitation) onOpenCitation(path, { start: snippet.start, end: snippet.end, line: snippet.line });
    else onOpenPath(path);
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
      const referenceFiles = files.filter((file) => IMPORTABLE_FILE.test(file.name));
      if (!files.length) return;
      // .bib, .ris, .nbib and CSL-JSON files are imported from their text; nothing is uploaded.
      for (const file of referenceFiles) {
        const before = library;
        const result = await importReferences({ notebook, text: await file.text() });
        if (before) undo.record(before, result.library, `Import ${file.name}`, result.added);
        announceLibraryChange(notebook, result.library.revision);
        setNotice({ tone: result.errors.length || !result.added.length ? "error" : "info", text: `Imported ${result.added.length} reference${result.added.length === 1 ? "" : "s"} from ${file.name}${result.duplicates.length ? `; ${result.duplicates.length} possible duplicate${result.duplicates.length === 1 ? "" : "s"}` : ""}${result.errors.length ? `; ${result.errors.length} problem${result.errors.length === 1 ? "" : "s"}` : ""}.` });
      }
      if (!pdfs.length) {
        if (!referenceFiles.length) setNotice({ tone: "error", text: "Drop PDFs, or .bib, .ris, .nbib or CSL-JSON files." });
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
    tether: bibTether.status,
    onTether: () => setTetherOpen(true),
    onSyncTether: () => void bibTether.run({ action: "sync" })
      .then((status) => setNotice(status?.state === "synced" ? { tone: "info", text: `${status.fileName} is in sync.` } : { tone: "error", text: status ? `${status.fileName}: ${status.message ?? tetherStateText(status)}` : "The notebook is no longer tethered." }))
      .catch((syncError: Error) => setNotice({ tone: "error", text: syncError.message })),
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
    bibliographyBlocker: !onInsertBibliography || activeMarkdownDraft === null || !canCite
      ? "Open a Markdown document and place the cursor to insert its bibliography."
      : BIBLIOGRAPHY_MARKER_LINES.test(activeMarkdownDraft)
        ? "This document already places its bibliography."
        : null,
    onInsertBibliography: () => onInsertBibliography?.(),
  };

  // Actions asked for from outside the panel (runReferencesCommand), once the library is here.
  const commandRequest = request?.kind === "command" && request.notebook === notebook && library ? request : null;
  const runCommandRef = useRef<(command: ReferencesPanelCommand) => void>(() => undefined);
  useEffect(() => {
    runCommandRef.current = (command) => {
      switch (command.action) {
        case "search":
          setOpenId(null);
          // An empty library has nothing to cite yet: add the first reference instead.
          if (!entries.length) {
            setAddBox({ id: Date.now(), query: "" });
            return;
          }
          setAddBox(null);
          window.requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select(); });
          return;
        case "manage": setManageOpen(true); return;
        case "generate": if (!jobs.active) void generateForPdfs(); return;
        case "fact-check":
          if (factCheckBlocker) setNotice({ tone: "error", text: factCheckBlocker });
          else setFactCheckOpen(true);
          return;
        case "undo":
          if (undo.canUndo && !undo.stale) void runUndo();
          else setNotice({ tone: "info", text: "Nothing to undo." });
          return;
        case "copy-list": void copyList(false); return;
        case "export-library": panelMenuProps.onExport(command.format); return;
        case "export-list": void exportList(command.format, false); return;
        case "copy-bibliography":
        case "export-bibliography":
          if (documentBlocker) setNotice({ tone: "error", text: documentBlocker });
          else if (command.action === "copy-bibliography") void copyList(true);
          else void exportList(command.format, true);
          return;
        case "style": if (command.style !== currentStyle) panelMenuProps.onStyle(command.style); return;
        case "filter":
          setReviewFilter(null);
          setOpenId(null);
          setView({ filter: command.filter });
          return;
      }
    };
  });
  useEffect(() => {
    if (!commandRequest) return;
    runCommandRef.current(commandRequest.command);
    onRequestHandled?.(commandRequest.id);
  }, [commandRequest, onRequestHandled]);

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
      inSelection: multi.has(entry.id),
      citedByActive: activeIds.has(entry.id),
      citingCount: citingById.get(entry.id)?.length ?? 0,
      duplicate: duplicateIds.has(entry.id),
      canCite,
      onOpen: (modifiers: { range: boolean; toggle: boolean }) => openRow(entry, modifiers),
      onTag: showTag,
      onCite: () => cite(entry),
      onOpenAttachment: onOpenPath,
      onMenu: async (point: { x: number; y: number }) => {
        if (!multi.has(entry.id)) clearMulti();
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
      ref={panelRef}
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
      {bibTether.status ? <TetherStatusLine status={bibTether.status} onOpen={() => setTetherOpen(true)} /> : null}
      {bibTether.error ? <p role="alert" className="mx-3 mb-2 text-xs text-destructive">{bibTether.error}</p> : null}

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
          onBack={closeCard}
          position={openIndex >= 0 ? { index: openIndex, total: listed.length } : undefined}
          onPrevious={() => stepCard(-1)}
          onNext={() => stepCard(1)}
          reviewLeft={reviewLeft}
          onConfirmNext={() => void confirmAndNext()}
          attachableFiles={attachableFiles}
          knownTags={knownTags}
          onTag={showTag}
          loadDocument={(path) => documentText(path, openDrafts)}
          onOpenCitation={openCitation}
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
              <div className="flex flex-wrap gap-1.5">
                <select
                  aria-label="Filter references"
                  className="libera-sidebar-search-input h-8 min-w-32 flex-1 appearance-none rounded-lg border border-input bg-card pl-2.5 pr-2 text-xs text-foreground outline-none transition hover:bg-muted focus-visible:border-ring"
                  value={view.filter}
                  onChange={(event) => setView({ filter: event.target.value as ReferenceFilter })}
                >
                  {REFERENCE_FILTERS.map((filter) => <option key={filter.id} value={filter.id}>{filter.label} ({counts[filter.id]})</option>)}
                </select>
                {tags.length ? (
                  <select
                    aria-label="Filter by tag"
                    className="libera-sidebar-search-input h-8 min-w-24 flex-1 appearance-none rounded-lg border border-input bg-card pl-2.5 pr-2 text-xs text-foreground outline-none transition hover:bg-muted focus-visible:border-ring"
                    value={activeTag ?? ""}
                    onChange={(event) => setView({ tag: event.target.value || null })}
                  >
                    <option value="">All tags</option>
                    {tags.map((item) => <option key={item.tag} value={item.tag}>#{item.tag} ({item.count})</option>)}
                  </select>
                ) : null}
                <select
                  aria-label="Sort references"
                  className="libera-sidebar-search-input h-8 min-w-24 flex-1 appearance-none rounded-lg border border-input bg-card pl-2.5 pr-2 text-xs text-foreground outline-none transition hover:bg-muted focus-visible:border-ring"
                  value={view.sort}
                  onChange={(event) => setView({ sort: event.target.value as ReferenceSort })}
                >
                  {REFERENCE_SORTS.map((sort) => <option key={sort.id} value={sort.id}>{sort.label}</option>)}
                </select>
              </div>
              {activeTag ? (
                <div className="flex items-center gap-1.5" aria-label="Tag filter">
                  <span className="libera-reference-tag">
                    <Tag aria-hidden className="h-3 w-3" /> {activeTag}
                    <button type="button" aria-label="Clear the tag filter" onClick={() => setView({ tag: null })}><X aria-hidden className="h-3 w-3" /></button>
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
          {multiSelection.length ? (
            <BulkActionsBar
              count={multiSelection.length}
              canCite={canCite}
              entries={multiSelection}
              knownTags={knownTags}
              tagsOpen={bulkTags}
              onTagsOpen={setBulkTags}
              onCite={() => citeMany(multiSelection)}
              onCopyCitation={(format) => copyCitation(multiSelection, format)}
              onCopyFormatted={() => void copyFormattedMany(multiSelection)}
              onTags={(add, remove) => changeTags(multiSelection, add, remove)}
              onReading={(reading) => setReading(multiSelection, reading)}
              onConfirm={() => confirmMany(multiSelection)}
              onDelete={() => deleteMany(multiSelection)}
              onClear={clearMulti}
            />
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
          clearMulti();
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
      <BibTetherDialog
        open={tetherOpen}
        notebook={notebook}
        status={bibTether.status}
        run={bibTether.run}
        onClose={() => setTetherOpen(false)}
        onDone={(text) => setNotice({ tone: "info", text })}
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

/** The tethered .bib file under the heading: its name and state; opens the tether dialog. */
function TetherStatusLine({ status, onOpen }: { status: TetherStatus; onOpen: () => void }) {
  const attention = status.state !== "synced";
  return (
    <button
      type="button"
      className={`mx-3 mb-2 flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11px] hover:bg-muted ${attention ? "bg-destructive-muted text-destructive" : "text-muted-foreground"}`}
      title={`${status.displayPath}${status.message ? `\n${status.message}` : ""}`}
      aria-label={`Tethered to ${status.fileName}: ${tetherStateText(status)}`}
      onClick={onOpen}
      data-tether-state={status.state}
    >
      {attention ? <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0" /> : <Link2 aria-hidden className="h-3.5 w-3.5 shrink-0" />}
      <span className="shrink-0 font-medium">{status.fileName}</span>
      <span className="min-w-0 truncate">· {tetherStateText(status)}</span>
    </button>
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
  /** The notebook's tethered .bib file, or null. */
  tether: TetherStatus | null;
  onTether: () => void;
  onSyncTether: () => void;
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
  /** Why a bibliography marker cannot be inserted, or null. */
  bibliographyBlocker: string | null;
  onInsertBibliography: () => void;
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
    ...(props.tether ? [
      { id: "tether", label: `Tethered to ${props.tether.fileName}…`, onSelect: props.onTether },
      { id: "tether-sync", label: "Sync the .bib file now", onSelect: props.onSyncTether },
    ] : [
      { id: "tether", label: "Tether to a .bib file…", onSelect: props.onTether },
    ]),
    { type: "separator" },
    { id: "copy-list", label: "Copy reference list", onSelect: props.onCopyList },
    { id: "export-list", label: "Export reference list…", submenu: BIBLIOGRAPHY_FORMATS.map((format) => ({
      id: `export-list:${format.id}`, label: format.label, onSelect: () => props.onExportList(format.id),
    })) },
    { id: "insert-bibliography", label: "Insert bibliography here", enabled: !props.bibliographyBlocker, onSelect: props.onInsertBibliography },
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
  tether,
  onTether,
  onSyncTether,
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
  bibliographyBlocker,
  onInsertBibliography,
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
      <button type="button" role="menuitem" className={item} title={tether ? tether.displayPath : "Keep this library and a .bib file in step, both ways"} onClick={act(onTether)}>
        <Link2 aria-hidden className="h-4 w-4" />
        <span className="min-w-0 flex-1 truncate">{tether ? `Tethered to ${tether.fileName}…` : "Tether to a .bib file…"}</span>
      </button>
      {tether ? (
        <button type="button" role="menuitem" className={item} onClick={act(onSyncTether)}>
          <RefreshCw aria-hidden className="h-4 w-4" /> Sync the .bib file now
        </button>
      ) : null}
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
      <button type="button" role="menuitem" className={item} disabled={Boolean(bibliographyBlocker)} title={bibliographyBlocker ?? "Place the generated bibliography at the cursor instead of at the end"} onClick={act(onInsertBibliography)}>
        <ScrollText aria-hidden className="h-4 w-4" /> Insert bibliography here
      </button>
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

/** Actions for several selected entries, above the list. */
function BulkActionsBar({ count, canCite, entries, knownTags, tagsOpen, onTagsOpen, onCite, onCopyCitation, onCopyFormatted, onTags, onReading, onConfirm, onDelete, onClear }: {
  count: number;
  canCite: boolean;
  entries: ReferenceEntry[];
  knownTags: string[];
  tagsOpen: boolean;
  onTagsOpen: (open: boolean) => void;
  onCite: () => void;
  onCopyCitation: (format: CitationCopyFormat) => void;
  onCopyFormatted: () => void;
  onTags: (add: string[], remove: string[]) => void;
  onReading: (reading: ReadingState | null) => void;
  onConfirm: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState("");
  const button = "libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg disabled:opacity-40";
  // Tags carried by any selected entry, with how many of them carry it.
  const present = libraryTags(entries);
  const unconfirmed = entries.filter((entry) => entry.status !== "confirmed").length;
  const allToRead = entries.every((entry) => entry.reading === "to-read");
  const allRead = entries.every((entry) => entry.reading === "read");

  function addTags() {
    const add = draft.split(",").map((tag) => tag.trim()).filter(Boolean);
    setDraft("");
    if (add.length) onTags(add, []);
  }

  return (
    <div className="libera-panel-card mx-3 mb-2 space-y-1.5 p-1.5" role="toolbar" aria-label={`${count} selected references`}>
      <div className="flex flex-wrap items-center gap-0.5">
        <span className="mr-auto px-1 text-[11px] font-semibold">{count} selected</span>
        <button type="button" className={button} aria-label="Cite the selection at the cursor" title={canCite ? "Cite all at the cursor as one citation (⌘/Ctrl+Enter)" : "Open a Markdown document to cite into it"} disabled={!canCite} onClick={onCite}><Quote aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} aria-label="Copy as one citation" title="Copy as [@a; @b]" onClick={() => onCopyCitation("pandoc")}><Copy aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} aria-label="Copy as a LaTeX citation" title={"Copy as \\cite{a,b}"} onClick={() => onCopyCitation("latex")}><Braces aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} aria-label="Copy formatted references" title="Copy formatted references (⌘/Ctrl+Shift+C)" onClick={onCopyFormatted}><ScrollText aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} aria-label="Edit tags of the selection" title="Add or remove tags" aria-expanded={tagsOpen} onClick={() => onTagsOpen(!tagsOpen)}><Tag aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} aria-label={allToRead ? "Remove from To read" : "Mark as To read"} title={allToRead ? "Remove from To read" : "Mark as To read"} aria-pressed={allToRead} onClick={() => onReading(allToRead ? null : "to-read")}><BookOpen aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} aria-label={allRead ? "Mark as unread" : "Mark as read"} title={allRead ? "Mark as unread" : "Mark as read"} aria-pressed={allRead} onClick={() => onReading(allRead ? null : "read")}><BookCheck aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} aria-label="Confirm the selection" title={unconfirmed ? `Mark ${unconfirmed} as confirmed` : "All are confirmed"} disabled={!unconfirmed} onClick={onConfirm}><Check aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} data-tone="destructive" aria-label="Delete the selection" title="Delete… (Delete)" onClick={onDelete}><Trash2 aria-hidden className="h-3.5 w-3.5" /></button>
        <button type="button" className={button} aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={onClear}><X aria-hidden className="h-3.5 w-3.5" /></button>
      </div>
      {tagsOpen ? (
        <div className="space-y-1.5 px-1 pb-0.5" role="group" aria-label="Tags of the selection">
          {present.length ? (
            <div className="flex flex-wrap gap-1">
              {present.map((item) => (
                <span key={item.tag} className="libera-reference-tag" title={`${item.count} of ${count} selected`}>
                  {item.tag}{item.count < count ? <span className="text-muted-foreground"> {item.count}/{count}</span> : null}
                  {item.count < count ? <button type="button" aria-label={`Add tag ${item.tag} to all selected`} title="Add to all selected" onClick={() => onTags([item.tag], [])}>+</button> : null}
                  <button type="button" aria-label={`Remove tag ${item.tag} from the selection`} onClick={() => onTags([], [item.tag])}><X aria-hidden className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          ) : null}
          <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); addTags(); }}>
            <input
              className="libera-panel-field h-7 min-w-0 flex-1 px-2 text-[12px]"
              aria-label="Tag to add to the selection"
              placeholder="Add a tag to all selected"
              list="libera-reference-bulk-tags"
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onTagsOpen(false); } }}
            />
            <button type="submit" className="libera-panel-button h-7 px-2.5" disabled={!draft.trim()}>Add</button>
          </form>
          <datalist id="libera-reference-bulk-tags">
            {knownTags.map((tag) => <option key={tag} value={tag} />)}
          </datalist>
        </div>
      ) : null}
    </div>
  );
}

