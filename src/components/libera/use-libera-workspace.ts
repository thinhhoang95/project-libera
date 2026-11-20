"use client";
import { createMarkdownBoxInsertion, MARKDOWN_BOX_SHORTCUTS } from "@/lib/markdown-boxes";
import { shiftMarkdownListItems, type ListIndentDirection } from "@/lib/markdown-list-indent";

import { useStableHandlers } from "@/components/libera/use-stable-handlers";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isTextFileType } from "@/lib/types";
import { TEXT_FILE_NAMES } from "@/lib/storage/constants";
import { isMarkdownSlidesPath } from "@/lib/markdown-slides";
import { isLatexCitingPath, latexCitation, type LatexCiteCommand } from "@/lib/references/latex-cite-syntax";
import { getLatexEditor } from "@/components/libera/latex/latex-editor-registry";
import type {
  LiberaFileMovePayload,
  LiberaFileNode,
  LiberaFilePayload,
  LiberaFolderMovePayload,
  LiberaFolderNode,
  LiberaLinkRewrites,
  LiberaMoveStep,
  LiberaNotebookGroup,
  LiberaNotebookNode,
  LiberaNotebookViewOptions,
  LiberaTree,
  LiberaTreeNode,
  PdfAnnotationsPayload,
} from "@/lib/types";
import { apiRequest, committedMove, emptyTree, encodeFilePath, sharedCommitted, type CommittedMove } from "@/components/libera/api-client";
import { monitorSessionExpiration } from "./session-expiration";
import { pendingSaves } from "@/components/libera/pending-saves";
import { createSaveQueue, linkRewriteByPath, pathsUnderMovedFolder, planRetargets, reconcileMovedText, rewriteOpenText, saveBase } from "./tab-retarget";
import { moveTextRewrite } from "@/lib/move-rewrites";
import { pythonSidecarHref } from "@/lib/python/sidecar";
import { latestPdfAnnotations } from "@/components/libera/pdf-annotation-events";
import type {
  MarkdownFileLinkRange,
  MarkdownFileLinkSelection,
  MarkdownSelectionLinkOption,
  MarkdownImageSelection,
  MarkdownScreenshotSnipMode,
  MarkdownScreenshotSnipSession,
  NotebookDialogState,
  NotebookFormValues,
  NotebookGroupDialogState,
  NotebookGroupFormValues,
  NoteDialogState,
  NoteFormValues,
  OpenTab,
  OpenTabViewState,
  PendingVisualInsertion,
  SearchResult,
  WorkspaceConfirmDialogState,
  WorkspaceInputDialogState,
  WorkspaceInputDialogValues,
} from "@/components/libera/types";
import {
  createMarkdownFileLinkDestination,
  resolveMarkdownFileLink,
  type MarkdownFileLinkMetadata,
} from "@/lib/markdown-file-links";
import { applyFileMetadata, mergeTree, type FileMetadataResult } from "@/lib/tree-merge";
import { findMarkdownHeadingAnchor } from "@/lib/markdown-heading-anchors";
import { annotationLinkLabel, findRememberedAnnotation } from "@/lib/annotation-links";
import {
  createMarkdownLinkQuote,
  isMarkdownSourceRange,
  markdownLinkQuoteLabel,
  resolveMarkdownLinkQuote,
} from "@/lib/markdown-selection-links";
import { MARKDOWN_OUTLINE_NAVIGATE_EVENT, type MarkdownOutlineNavigateDetail } from "@/lib/markdown-outline-navigation";
import { scrollTextareaToOffset } from "@/lib/textarea-position";
import { useMarkdownWindows } from "./use-markdown-windows";
import { useSavedWorkspaces } from "./use-saved-workspaces";
import { createDeferredSave, flushPendingState, registerStateFlusher } from "./deferred-save";
import { useCanvasLayout } from "./use-canvas-layout";
import { captureCanvasViewState } from "./canvas-view-state";
import { mergeSourceScrollState } from "@/lib/markdown-source-scroll";
import { useGalleryContents } from "./gallery-store";
import { createGalleryTab, galleryTabKey, isGalleryTab, reconcileGalleryTabs, type GalleryTabPlacement } from "./gallery-tabs";
import { createRecordingTab, isRecordingTab, recordingTabId } from "./recording/recording-tabs";
import { createPageTab, isPageTab, type PageKind } from "./page-tabs";
import { focusedCanvasPane } from "@/lib/canvas-layout";
import type { GalleryPhoto } from "@/lib/image-generation";
import type { PhotoEdits } from "@/lib/photo-edits";
import type { ChatNotebookExport } from "./document-chat-export-dialog";
import { flushSync } from "react-dom";
import {
  readClosedViewStates, rememberClosedViewStates, remapClosedViewStates, removeWorkspaceGroup, saveWorkspaceGroup, toggleWorkspaceStar,
  withinPath, type ClosedViewStates, type WorkspaceFileChange,
} from "@/lib/workspaces";
import type { MigrationRequest, MigrationResult } from "@/lib/storage/migration";
import type { BatchDeleteResult, BatchMoveResult } from "@/lib/storage/batch-files";
import type { MigrationPreset } from "./notebook-migration-dialog";
import { REPAIR_MOVED_EVENT } from "./notebook-integrity-dialog";
import { splitDropDestination } from "./drop-target";
import { missingTabIds, unsavedNamesUnder } from "./tab-presence";
import { movesFromRepairMessage, REPAIR_CHANNEL_NAME } from "./repair-channel";
import type { ReferenceMoveResult } from "@/lib/references/moves";
import { remapDocumentHeadingNumbering } from "./heading-numbering-state";
import { agentReviewStore } from "@/lib/agent-review/store";
import { replaceTextareaSelectionWithUndo } from "@/lib/textarea-editing";
import { findMarkdownBlockInsertionOffset, insertMarkdownBlock } from "@/lib/ai-write";
import { beginAiActivity } from "@/lib/ai-activity";
import { resolvePdfQuote, showPdfQuoteNotice } from "@/components/libera/references/pdf-quote-cite";
import { parsePdfQuoteSource, PDF_QUOTE_CITE_EVENT, quoteBlockInsertion, type PdfQuoteCiteDetail, type PdfQuoteSource } from "@/lib/references/pdf-quote";
import { MARKDOWN_TABLE_FIRST_HEADER, markdownTable } from "@/lib/markdown-table";
import {
  ensureDocumentOcrModel,
  readImageAsMarkdown,
  resolvePicturePlaceholders,
} from "@/components/libera/document-ocr/document-ocr-client";
import type { MathMarkerSettings } from "@/lib/math-markers";

// Snips are read at the model's own page scale (up to four 512 px tiles across).
const SNIP_MAX_EDGE = 2048;
import { readIncludeDocumentContext } from "./ai-document-context-preference";
import { aiTaskRequestOptions } from "./ai-model-picker";
import { aiEditThreadFor, recordAiEditTurn, type AiEditThreadResult } from "./ai-edit-thread";
import { latexDocumentTemplate } from "@/lib/latex/project";
import type { AiFeature, Provenance } from "@/lib/collab/protocol/actor";
import { useSharedTabs } from "@/lib/collab/bindings/react-shared-tabs";
import { adoptPendingSharedDraft, applyTextToShared } from "@/lib/collab/client/apply-text";
import { getSharedDocRegistry, type SharedDocSession } from "@/lib/collab/client/registry";
import { isTabDirty, journalTab, mayTakeContentFromDisk, readTabDraft, type DraftWriteOptions } from "@/lib/collab/client/workspace";
import { aiSuggestionNotice, suggestAiOnSharedTab } from "@/lib/collab/client/suggestions-ai";
import { subscribeHostEvents } from "@/lib/collab/ui/bridge";
import { isIdentityConflict, notebooksToRefresh, replaceNotebook, subscribeSharedTreeChanges, withBackoff, type FileMove, type RefreshScope } from "@/lib/collab/ui/tree-changes";
import type { SnapshotEdit } from "@/lib/collab/suggestions/model";
import { rewriteCitationKeys } from "@/lib/references/citation-syntax";
import { useTranslations } from "next-intl";
import { DEFAULT_UNTITLED_NAME, RECOVERED_REVIEW_NAME } from "./default-names";
import { announceReferenceLibraryChange } from "@/lib/references/import";
import { referenceMoveSummary, type ReferenceMoveNoticeState } from "./references/reference-move-notice";
import { createSidebarSearchStore } from "./sidebar-search-store";
import { useWhereWasITracker, whereWasITracker } from "./where-was-i-tracker";
import { textVersion } from "@/lib/text-version";

const TYPING: Provenance = { source: "typing" };
/** Module-level, so the close and unload callbacks need no extra hook dependency. Shared tabs are never dirty. */
const isSharedRegistryTab = (tabId: string) => getSharedDocRegistry().isSharedTab(tabId);
const PASTE: Provenance = { source: "paste" };

function subscribeToNothing() {
  return () => undefined;
}

function collectFiles(nodes: LiberaTreeNode[], results: LiberaFileNode[] = []) {
  for (const node of nodes) {
    if (node.kind === "folder") {
      collectFiles(node.children, results);
      continue;
    }

    results.push(node);
  }

  return results;
}

function parentPathForFile(file: LiberaFileNode) {
  const parts = file.path.split("/");
  return parts.slice(0, -1).join("/") || file.notebook;
}

function isPathWithinPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function imageAltText(name: string) {
  return name.replace(/\.[^.]+$/, "") || "image";
}

function markdownExportBaseName(name: string) {
  return name.replace(/\.(?:md|markdown)$/i, "") || "document";
}

function markdownPdfFileName(name: string) {
  return `${markdownExportBaseName(name)}.pdf`;
}

function annotatedPdfFileName(name: string) {
  return `${name.replace(/\.pdf$/i, "")} (annotated).pdf`;
}

function markdownTitleFromName(name: string) {
  return (
    name
      .replace(/\.slides\.(md|markdown)$/i, "")
      .replace(/\.(md|markdown)$/i, "")
      .trim() || DEFAULT_UNTITLED_NAME
  );
}

function ensureMarkdownSlidesName(name: string) {
  if (/\.slides\.(md|markdown)$/i.test(name)) {
    return name;
  }

  if (/\.markdown$/i.test(name)) {
    return name.replace(/\.markdown$/i, ".slides.markdown");
  }

  if (/\.md$/i.test(name)) {
    return name.replace(/\.md$/i, ".slides.md");
  }

  if (/\.slides$/i.test(name)) {
    return `${name}.md`;
  }

  return `${name}.slides.md`;
}

function createMarkdownNoteContent(name: string) {
  return `# ${markdownTitleFromName(name)}\n`;
}

function createMarkdownSlidesContent(name: string) {
  const title = markdownTitleFromName(name);

  return [
    `$title = ${JSON.stringify(title)}`,
    "$subtitle = \"\"",
    "$author = []",
    "$affiliation = []",
    "$date = \"\"",
    "$theme = \"light\"",
    "---",
    "## First slide",
    "",
    "Start your slide content here.",
    "",
    "--",
    "",
    "- A line with only -- reveals what follows on the next click",
    "",
    "???",
    "Speaker notes: only you see these, in speaker view (press S while presenting).",
    "",
  ].join("\n");
}

function clampTextOffset(value: number, textLength: number) {
  return Math.max(0, Math.min(value, textLength));
}

function lineForOffset(value: string, offset: number) {
  return value.slice(0, clampTextOffset(offset, value.length)).split("\n").length;
}

function shallowEqualRecord(
  left: object | undefined,
  right: object | undefined,
) {
  const leftRecord = (left ?? {}) as Record<string, unknown>;
  const rightRecord = (right ?? {}) as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => leftRecord[key] === rightRecord[key]);
}

function mergeOpenTabViewState(
  currentViewState: OpenTabViewState | undefined,
  patchViewState: OpenTabViewState,
): OpenTabViewState {
  return {
    ...currentViewState,
    audio: patchViewState.audio
      ? { ...currentViewState?.audio, ...patchViewState.audio }
      : currentViewState?.audio,
    image: patchViewState.image
      ? { ...currentViewState?.image, ...patchViewState.image }
      : currentViewState?.image,
    latex: patchViewState.latex
      ? { ...currentViewState?.latex, ...patchViewState.latex }
      : currentViewState?.latex,
    markdown: patchViewState.markdown
      ? mergeSourceScrollState(currentViewState?.markdown, patchViewState.markdown)
      : currentViewState?.markdown,
    pdf: patchViewState.pdf
      ? { ...currentViewState?.pdf, ...patchViewState.pdf }
      : currentViewState?.pdf,
    text: patchViewState.text
      ? { ...currentViewState?.text, ...patchViewState.text }
      : currentViewState?.text,
  };
}

function createMarkdownImageInsertion(
  draft: string,
  insertion: string,
  selection: { start: number; end: number },
) {
  const start = clampTextOffset(selection.start, draft.length);
  const end = clampTextOffset(Math.max(selection.start, selection.end), draft.length);
  const prefix = start > 0 && !draft.slice(0, start).endsWith("\n") ? "\n" : "";
  const suffix = draft.slice(end).startsWith("\n") ? "" : "\n";
  const nextDraft = `${draft.slice(0, start)}${prefix}${insertion}${suffix}${draft.slice(
    end,
  )}`;
  const nextSelectionStart = start + prefix.length;

  return {
    nextDraft,
    nextSelectionEnd: nextSelectionStart + insertion.length,
    nextSelectionStart,
  };
}

function collectExpandablePanelPaths(tree: LiberaTree) {
  const paths = new Set<string>();

  function collect(nodes: LiberaTreeNode[]) {
    for (const node of nodes) {
      if (node.kind !== "folder") {
        continue;
      }

      paths.add(node.path);
      collect(node.children);
    }
  }

  for (const notebook of tree.notebooks) {
    paths.add(notebook.name);
    collect(notebook.children);
  }

  return paths;
}

function setsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) {
    return false;
  }

  for (const item of left) {
    if (!right.has(item)) {
      return false;
    }
  }

  return true;
}

const FILE_INTERACTIONS_STORAGE_KEY = "libera.fileInteractions";
// Switching windows back and forth should not walk the whole library each time.
const FOCUS_TREE_REFRESH_INTERVAL_MS = 5000;

export function useLiberaWorkspace(initialAuthenticated: boolean) {
  const t = useTranslations("useLiberaWorkspace");
  // Messages are read from callbacks, effects and timers that outlive a render: always through the latest translator.
  const tRef = useRef(t);
  useLayoutEffect(() => { tRef.current = t; });
  // The references part of a move's notice, when it shares the notice with the links (reportMoveOutcome).
  const tReferences = useTranslations("references.referenceMoveNotice");
  const tReferencesRef = useRef(tReferences);
  useLayoutEffect(() => { tReferencesRef.current = tReferences; });
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const sessionEndedRef = useRef(false);
  const sessionCleanupRef = useRef<AbortController | null>(null);
  const [saveDraftTabId, setSaveDraftTabId] = useState<string | null>(null);
  const [saveDraftError, setSaveDraftError] = useState("");
  const [saveDraftSubmitting, setSaveDraftSubmitting] = useState(false);
  const savingDraftRef = useRef(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [tree, setTree] = useState<LiberaTree>(emptyTree);
  const appliedTreeRef = useRef<LiberaTree | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  // The latest tabs, for work that finishes after a render, like reading a snip.
  const tabsRef = useRef<OpenTab[]>([]);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  /**
   * Changes the tab list and the ref that mirrors it together, so work that
   * follows in the same tick (a second retarget, a save that waited for the
   * first) sees the change before React renders it. `change` must be pure.
   */
  function changeTabsNow(change: (current: OpenTab[]) => OpenTab[]) {
    tabsRef.current = change(tabsRef.current);
    setTabs(change);
  }
  // Text saves, one at a time per file (saveTabText).
  const saveQueueRef = useRef(createSaveQueue());
  const [activeTabId, setActiveTabId] = useState("");
  // Where closed files were left, saved with the workspace so reopening one returns there.
  const [closedViewStates, setClosedViewStates] = useState<ClosedViewStates>({});
  const closedViewStatesRef = useRef(closedViewStates);
  useLayoutEffect(() => {
    closedViewStatesRef.current = closedViewStates;
  }, [closedViewStates]);
  const [selectedNotebookName, setSelectedNotebookName] = useState("");
  const notebookSelectionWriter = useMemo(() => createDeferredSave((body) => apiRequest("/api/preferences/last-notebook", {
    method: "PUT", body, keepalive: !window.liberaPersistence,
  }), (error) => setWorkspaceError(error instanceof Error ? error.message : tRef.current("rememberNotebookError"))), []);
  const [sidebarSearch] = useState(createSidebarSearchStore);
  const [fileInteractions, setFileInteractions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [aiFormatting, setAiFormatting] = useState(false);
  const [imageMarkdownConverting, setImageMarkdownConverting] = useState(false);
  const [screenshotSnipSession, setScreenshotSnipSession] =
    useState<MarkdownScreenshotSnipSession | null>(null);
  const [pendingVisualInsertions, setPendingVisualInsertions] = useState<Record<string, PendingVisualInsertion>>({});
  const snipAbortRef = useRef<AbortController | null>(null);
  const snipDraftAtStartRef = useRef<string | null>(null);
  const [notebookDialog, setNotebookDialog] = useState<NotebookDialogState | null>(null);
  const [notebookDialogSubmitting, setNotebookDialogSubmitting] = useState(false);
  const [notebookGroupDialog, setNotebookGroupDialog] =
    useState<NotebookGroupDialogState | null>(null);
  const [notebookGroupDialogSubmitting, setNotebookGroupDialogSubmitting] =
    useState(false);
  const [noteDialog, setNoteDialog] = useState<NoteDialogState | null>(null);
  const [noteDialogSubmitting, setNoteDialogSubmitting] = useState(false);
  const [workspaceInputDialog, setWorkspaceInputDialog] =
    useState<WorkspaceInputDialogState | null>(null);
  const [workspaceInputDialogSubmitting, setWorkspaceInputDialogSubmitting] =
    useState(false);
  const [workspaceConfirmDialog, setWorkspaceConfirmDialog] =
    useState<WorkspaceConfirmDialogState | null>(null);
  const [workspaceConfirmDialogSubmitting, setWorkspaceConfirmDialogSubmitting] =
    useState(false);
  const [fileTagsDialogFile, setFileTagsDialogFile] = useState<LiberaFileNode | null>(null);
  const [fileTagsDialogSubmitting, setFileTagsDialogSubmitting] = useState(false);
  const [fileTagsDialogError, setFileTagsDialogError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [referenceMoveNotice, setReferenceMoveNotice] = useState<ReferenceMoveNoticeState | null>(null);
  const [uploadNotebook, setUploadNotebook] = useState("");
  const activeTabHistoryRef = useRef<string[]>([]);
  const latestDraftByTabIdRef = useRef<Record<string, string>>({});
  const editorDraftReadersRef = useRef(new Map<string, () => string>());
  const registerEditorDraft = useCallback((tabId: string, read: () => string) => {
    editorDraftReadersRef.current.set(tabId, read);
    return () => {
      if (editorDraftReadersRef.current.get(tabId) === read) editorDraftReadersRef.current.delete(tabId);
    };
  }, []);
  // Shared documents (plan M1.4/M1.6): the replica of a shared tab lives in
  // the registry for as long as the tab is open; its text is the tab's draft.
  const sharedRegistry = getSharedDocRegistry();
  // Register the recap before shared attachment effects can report a baseline.
  useWhereWasITracker(tabs, (tabId) => sharedRegistry.isSharedTab(tabId), getTabDraft, tree.notebooks);
  const sharedTabIds = useSharedTabs(tabs, {
    enabled: authenticated,
    onText: mirrorSharedText,
    onAttached: (tabId, session) => {
      // The recap's baseline is the shared text before a pending draft is applied.
      const ytext = session.replica.ytext;
      whereWasITracker.sharedAttached(tabId, ytext.toString(), () => ytext.toString());
      adoptPendingDraft(tabId, session);
    },
    onEdit: (tabId, local) => whereWasITracker.sharedEdited(tabId, local),
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const openingFilePathsRef = useRef<Set<string>>(new Set());
  const pendingOpenViewStateByPathRef = useRef<Record<string, OpenTabViewState | undefined>>({});
  const expandedRef = useRef<Set<string>>(new Set());
  const treeLoadedRef = useRef(false);
  const expansionWriter = useMemo(() => createDeferredSave((body) => apiRequest("/api/notebook-panel-expansion", {
    method: "PATCH", body, keepalive: !window.liberaPersistence,
  }), (error) => setWorkspaceError(error instanceof Error ? error.message : tRef.current("savePanelExpansionError"))), []);
  useEffect(() => {
    // The session restores the selection; this fallback must not hold up closing.
    const unregister = registerStateFlusher(() => Promise.all([notebookSelectionWriter.flush().catch(() => undefined), expansionWriter.flush()]));
    return () => {
      unregister();
      void Promise.all([notebookSelectionWriter.flush(), expansionWriter.flush()]).catch(() => undefined);
    };
  }, [notebookSelectionWriter, expansionWriter]);

  const canvas = useCanvasLayout({ tabs, activeTabId, activateTab });
  const canvasLayout = canvas.layout;
  // Shared tabs keep their place in the session but not their text: the
  // host's SQLite is their journal (journalTab).
  const workspaceSession = useMemo(() => ({
    tabs: tabs.map((tab) => journalTab(tab, (tabId) => sharedTabIds.has(tabId))),
    activeTabId, selectedNotebookName, expandedPaths: [...expanded], canvasLayout, closedViewStates,
  }), [tabs, sharedTabIds, activeTabId, selectedNotebookName, expanded, canvasLayout, closedViewStates]);
  const workspaceManager = useSavedWorkspaces({
    authenticated, tree, refreshTree, session: workspaceSession,
    readDraft: (tab) => (sharedRegistry.isSharedTab(tab.id) ? tab.saved : getTabDraft(tab)),
    isSharedPath: (path) => !!sharedRegistry.cachedResolution(path),
    onError: setWorkspaceError,
    applySession: (session) => {
      latestDraftByTabIdRef.current = Object.fromEntries(session.tabs.map((tab) => [tab.id, tab.draft]));
      activeTabHistoryRef.current = [];
      setTabs(session.tabs);
      setActiveTabId(session.activeTabId);
      const closed = readClosedViewStates(session.closedViewStates);
      closedViewStatesRef.current = closed;
      setClosedViewStates(closed);
      canvas.restore(session.canvasLayout, session.tabs.map((tab) => tab.id), session.activeTabId);
      setSelectedNotebookName(session.selectedNotebookName);
      applyExpanded(new Set(session.expandedPaths));
      sidebarSearch.reset();
      setScreenshotSnipSession(null);
      setSaveDraftTabId(null);
    },
  });
  const visibleTree = workspaceManager.visibleTree;
  const expireSessionRef = useRef(expireSession);
  useLayoutEffect(() => { expireSessionRef.current = expireSession; });
  useEffect(() => {
    if (!authenticated) return;
    return monitorSessionExpiration(() => expireSessionRef.current());
  }, [authenticated]);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const firstNotebook = visibleTree.notebooks[0]?.name ?? "";
  const selectedNotebook = visibleTree.notebooks.find(
    (notebook) => notebook.name === selectedNotebookName,
  ) ?? visibleTree.notebooks[0];
  const files = useMemo(
    () => visibleTree.notebooks.flatMap((notebook) => collectFiles(notebook.children)),
    [visibleTree],
  );
  const recentFiles = useMemo(() => {
    const interactionTime = (file: LiberaFileNode) =>
      new Date(fileInteractions[file.path] ?? file.updatedAt).getTime();

    return [...files]
      .sort((left, right) => interactionTime(right) - interactionTime(left))
      .slice(0, 12);
  }, [fileInteractions, files]);
  const canStartScreenshotSnip =
    activeTab?.file.fileType === "markdown" &&
    tabs.some((tab) => tab.file.fileType === "image" || tab.file.fileType === "pdf");

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      try {
        const savedInteractions = JSON.parse(
          window.localStorage.getItem(FILE_INTERACTIONS_STORAGE_KEY) ?? "{}",
        ) as unknown;

        if (savedInteractions && typeof savedInteractions === "object") {
          setFileInteractions(savedInteractions as Record<string, string>);
        }
      } catch {
        setFileInteractions({});
      }
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  function persistNotebookPanelExpansion(nextExpanded: Set<string>) {
    if (workspaceManager.activeWorkspace) return;
    expansionWriter.schedule({ expandedPaths: [...nextExpanded] }, 5000);
  }

  function applyExpanded(nextExpanded: Set<string>, options?: { persist?: boolean }) {
    if (setsEqual(expandedRef.current, nextExpanded)) {
      return;
    }

    expandedRef.current = nextExpanded;
    setExpanded(nextExpanded);

    if (options?.persist) {
      persistNotebookPanelExpansion(nextExpanded);
    }
  }

  function updateExpanded(
    updater: (current: Set<string>) => Set<string>,
    options: { persist?: boolean } = { persist: true },
  ) {
    applyExpanded(updater(new Set(expandedRef.current)), options);
  }

  function reconcileExpandedWithTree(
    nextTree: LiberaTree,
    options?: { expandPaths?: string[]; persist?: boolean },
  ) {
    const validPaths = collectExpandablePanelPaths(workspaceManager.organizeTree(nextTree));
    const sourceExpanded = treeLoadedRef.current
      ? expandedRef.current
      : new Set(
          nextTree.notebookPanelExpandedPaths ??
            nextTree.notebooks.map((notebook) => notebook.name),
        );
    const nextExpanded = new Set(
      [...sourceExpanded].filter((expandedPath) => validPaths.has(expandedPath)),
    );

    for (const expandPath of options?.expandPaths ?? []) {
      if (validPaths.has(expandPath)) {
        nextExpanded.add(expandPath);
      }
    }

    treeLoadedRef.current = true;
    applyExpanded(nextExpanded, { persist: options?.persist });
  }

  function workspaceFileRequest<T>(url: string, init: RequestInit, describe: (result: T) => WorkspaceFileChange, onPersistFailed?: (error: Error) => void) {
    return workspaceManager.runFileChange(() => apiRequest<T>(url, init), describe, onPersistFailed);
  }

  async function applyCompleteTree(nextTree: LiberaTree) {
    // Mutation responses use library visibility. Keep the full file tree so a
    // workspace can show archives independently without changing library settings.
    if (nextTree.archiveIncluded === false) {
      try { nextTree = await apiRequest<LiberaTree>("/api/tree?includeArchive=true"); }
      catch (error) { setWorkspaceError(error instanceof Error ? error.message : tRef.current("refreshArchivedError")); }
    }
    // Keep the objects of everything unchanged, so the sidebar re-renders only what differs.
    const shown = mergeTree(appliedTreeRef.current, nextTree);
    appliedTreeRef.current = shown;
    setTree(shown);
  }

  /**
   * Shared working-copy writes: read only those files' metadata and patch it
   * into the shown tree. Anything that read cannot settle reads the whole tree.
   */
  async function refreshFiles(paths: string[]) {
    const shown = appliedTreeRef.current;
    if (shown) {
      const { files } = await apiRequest<{ files: FileMetadataResult[] }>("/api/tree/files", {
        method: "POST", body: JSON.stringify({ paths }),
      });
      // A tree applied meanwhile is newer than the one this read was matched to.
      const current = appliedTreeRef.current;
      const patched = current ? applyFileMetadata(current, files) : null;
      if (patched) {
        if (patched !== current) { appliedTreeRef.current = patched; setTree(patched); }
        return;
      }
    }
    await refreshTree(undefined, { onlyIfChanged: true });
  }

  /**
   * `onlyIfChanged` drops a result that matches the shown tree. If another tree
   * was applied meanwhile it may be older than this one, so fetch again (twice
   * at most) rather than keep it.
   */
  async function refreshTree(expandNotebook?: string, options?: { onlyIfChanged?: boolean; maintain?: boolean }) {
    // A background check may skip sidecar upkeep the server did recently; loads and focus returns do it.
    const url = options?.onlyIfChanged && !options.maintain
      ? "/api/tree?includeArchive=true&maintenance=throttled" : "/api/tree?includeArchive=true";
    let treeAtStart = appliedTreeRef.current;
    let nextTree = await apiRequest<LiberaTree>(url);
    if (options?.onlyIfChanged) {
      for (let retries = 0; appliedTreeRef.current !== treeAtStart && retries < 2; retries++) {
        treeAtStart = appliedTreeRef.current;
        nextTree = await apiRequest<LiberaTree>(url);
      }
      if (appliedTreeRef.current !== treeAtStart) return appliedTreeRef.current ?? nextTree;
      // The same content gives back the shown tree itself: nothing is applied.
      nextTree = mergeTree(treeAtStart, nextTree);
      if (nextTree === treeAtStart) return nextTree;
    }
    await applyCompleteTree(nextTree);
    setSelectedNotebookName((current) => {
      if (current && nextTree.notebooks.some((notebook) => notebook.name === current)) {
        return current;
      }

      const remembered = nextTree.notebooks.find((notebook) => notebook.name === nextTree.lastNotebookName);
      return remembered?.name ?? nextTree.notebooks[0]?.name ?? "";
    });
    reconcileExpandedWithTree(nextTree, {
      expandPaths: expandNotebook ? [expandNotebook] : [],
      persist: Boolean(expandNotebook),
    });
    return nextTree;
  }

  /**
   * What a shared edit refreshes: only the notebooks it touched that this
   * window shows, each read alone (archive included) and without the library-wide
   * sidecar upkeep. A notebook this window has never seen means the library
   * changed shape, so everything is read.
   */
  async function refreshNotebooks(scope: RefreshScope) {
    const names = notebooksToRefresh(scope, appliedTreeRef.current);
    if (!names) { await refreshTree(undefined, { onlyIfChanged: true }); return; }
    for (const name of names) {
      const { notebook } = await apiRequest<{ notebook: LiberaNotebookNode | null }>(`/api/tree?notebook=${encodeURIComponent(name)}&includeArchive=true`);
      // Gone since the event: the shape changed after all.
      if (!notebook) { await refreshTree(undefined, { onlyIfChanged: true }); return; }
      const shown = appliedTreeRef.current;
      if (!shown) continue;
      const merged = replaceNotebook(shown, notebook);
      if (JSON.stringify(merged.notebooks) === JSON.stringify(shown.notebooks)) continue;
      appliedTreeRef.current = merged;
      setTree(merged);
    }
  }

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    refreshTree().catch((error: Error) => setWorkspaceError(error.message));
  }, [authenticated]);

  // Files added in Finder or another app raise no event here (only shared
  // notebooks are watched), so read the library again when the window returns.
  const latestFocusRefresh = useRef(refreshTree);
  /**
   * After a refresh from disk, a tab whose file is no longer in the tree (moved or deleted
   * by a sync client or Finder) says so on the tab, as a failed save does. Its text stays in
   * the editor and a save is refused, not recreated at the old path (updateMarkdownFile, 409).
   * The note clears again if the file comes back.
   */
  function markMissingTabs(shown: LiberaTree) {
    const message = tRef.current("fileGoneOnDiskError");
    setTabs((current) => {
      const missing = missingTabIds(current, shown);
      let changed = false;
      const next = current.map((tab) => {
        if (missing.has(tab.id) && !tab.error && tab.status !== "saving") { changed = true; return { ...tab, error: message }; }
        if (!missing.has(tab.id) && tab.error === message && tab.status !== "error") { changed = true; return { ...tab, error: undefined }; }
        return tab;
      });
      return changed ? next : current;
    });
  }
  const latestMarkMissing = useRef(markMissingTabs);
  useLayoutEffect(() => {
    latestFocusRefresh.current = refreshTree;
    latestMarkMissing.current = markMissingTabs;
  });
  useEffect(() => {
    if (!authenticated) return;
    let running = false;
    let lastStartedAt = Date.now();
    const onReturn = () => {
      if (document.visibilityState !== "visible" || running ||
          Date.now() - lastStartedAt < FOCUS_TREE_REFRESH_INTERVAL_MS) return;
      running = true;
      lastStartedAt = Date.now();
      // A failed background check is not worth an error banner; the next one retries.
      void latestFocusRefresh.current(undefined, { onlyIfChanged: true, maintain: true })
        .then((shown) => latestMarkMissing.current(shown))
        .catch(() => undefined)
        .finally(() => { running = false; });
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !selectedNotebookName) return;
    // Covers notebook homes, file opens, tab switches, and notebook renames.
    // The maximum wait matches, so later selections join this write.
    notebookSelectionWriter.schedule({ notebook: selectedNotebookName }, 60_000, 60_000);
  }, [authenticated, selectedNotebookName, notebookSelectionWriter]);

  type DirectoryActionResult = { changed?: boolean; filePath?: string; name?: string };

  // Linked folders sit next to notebooks, so opening or removing one only
  // changes the tree; the session and open tabs carry on.
  async function linkDirectory(request: () => Promise<DirectoryActionResult>) {
    setWorkspaceError("");

    try {
      // A newly linked folder joins the active workspace like a new notebook.
      const result = await workspaceManager.runFileChange(request, (linked) =>
        linked.changed && linked.name ? { paths: [linked.name] } : {},
      );
      const nextTree = await refreshTree(result.name);
      if (result.changed) await window.liberaDirectory?.notifyChanged().catch(() => undefined);
      return { result, nextTree };
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("openFolderError"));
      return null;
    }
  }

  async function openFileByPath(filePath: string, sourceTree: LiberaTree) {
    const file = sourceTree.notebooks
      .flatMap((notebook) => collectFiles(notebook.children))
      .find((candidate) => candidate.path === filePath);

    if (!file) {
      setWorkspaceError(tRef.current("hiddenFileError"));
      return;
    }

    await openFile(file);
  }

  function showLinkedFolder(name: string) {
    setSelectedNotebookName(name);
    setActiveTabId("");
    updateExpanded((current) => new Set(current).add(name));
  }

  async function openDirectory(directoryPath?: string) {
    const chosenPath = directoryPath ?? await window.liberaDirectory?.chooseFolder();
    if (!chosenPath) return;
    const linked = tree.notebooks.find((notebook) => notebook.folder?.path === chosenPath);
    if (linked) {
      showLinkedFolder(linked.name);
      return;
    }
    const opened = await linkDirectory(() => apiRequest<DirectoryActionResult>("/api/directory", {
      method: "POST", body: JSON.stringify({ action: "open", path: chosenPath }),
    }));
    if (opened?.result.name) showLinkedFolder(opened.result.name);
  }

  async function openFileFromDisk(filePath?: string) {
    const chosenPath = filePath ?? await window.liberaDirectory?.chooseFile();
    if (!chosenPath) return;
    const opened = await linkDirectory(() => apiRequest<DirectoryActionResult>("/api/directory", {
      method: "POST", body: JSON.stringify({ action: "open-file", path: chosenPath }),
    }));
    if (opened?.result.filePath) await openFileByPath(opened.result.filePath, opened.nextTree);
  }

  function closeDirectory(name: string) {
    const dirtyTabCount = tabs.filter((tab) =>
      tab.file.notebook === name && isTabDirty(tab, isSharedTab, getTabDraft),
    ).length;

    if (dirtyTabCount) {
      setWorkspaceConfirmDialog({ mode: "remove-folder", notebook: name, dirtyTabCount });
      return;
    }

    void removeLinkedFolder(name);
  }

  /** Remove a linked folder from the library. Files on disk are left alone. */
  async function removeLinkedFolder(name: string) {
    try {
      await apiRequest("/api/directory", {
        method: "POST", body: JSON.stringify({ action: "close", name }),
      });
      const nextTree = await refreshTree();
      setSelectedNotebookName((current) =>
        current === name ? nextTree.notebooks[0]?.name ?? "" : current,
      );
      tabs.forEach((tab) => {
        if (tab.file.notebook === name) {
          forgetTabDraft(tab.id);
        }
      });
      setTabs((currentTabs) => currentTabs.filter((tab) => tab.file.notebook !== name));
      setActiveTabId((current) => (current.startsWith(`${name}/`) ? "" : current));
      await window.liberaDirectory?.notifyChanged().catch(() => undefined);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("removeFolderError"));
    }
  }

  async function clearRecentDirectories() {
    try {
      await apiRequest("/api/directory", { method: "POST", body: JSON.stringify({ action: "clear-recent" }) });
      await window.liberaDirectory?.notifyChanged();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("clearRecentError"));
    }
  }

  // Folder pickers need the desktop app; the server-rendered page has none.
  const canOpenDirectories = useSyncExternalStore(
    subscribeToNothing,
    () => Boolean(window.liberaDirectory),
    () => false,
  );
  const directoryCommandRef = useRef<(command: LiberaDirectoryCommand) => void>(() => undefined);
  useLayoutEffect(() => {
    directoryCommandRef.current = (command) => {
      if (command.type === "open-directory") void openDirectory(command.path);
      else if (command.type === "open-file") void openFileFromDisk(command.path);
      else if (command.type === "close-directory") closeDirectory(command.name);
      else void clearRecentDirectories();
    };
  });

  useEffect(() => {
    if (!authenticated) return;
    return window.liberaDirectory?.onCommand((command) => directoryCommandRef.current(command));
  }, [authenticated]);

  // Keep the native File menu in step with the context this page loaded.
  useEffect(() => {
    if (authenticated && tree.root) void window.liberaDirectory?.notifyChanged().catch(() => undefined);
  }, [authenticated, tree.root]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A slow response from expiry cleanup must not clear the new login cookie.
    sessionCleanupRef.current?.abort();
    sessionCleanupRef.current = null;
    setBusy(true);
    setAuthError("");

    try {
      await apiRequest<{ authenticated: true }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      sessionEndedRef.current = false;
      setAuthenticated(true);
      setPassword("");
      // The desktop app opens this user's sign-in screen at the next start.
      void window.liberaProfiles?.signedIn().catch(() => {});
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : tRef.current("loginFailedError"));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (sessionEndedRef.current) return;
    try { await workspaceManager.checkpoint(); await flushPendingState(); }
    catch {
      if (!sessionEndedRef.current) setWorkspaceError(tRef.current("saveWorkspaceSignOutError"));
      return;
    }
    if (sessionEndedRef.current) return;
    await window.liberaProfiles?.signedOut().catch(() => undefined);
    await apiRequest<{ authenticated: false }>("/api/auth/logout", {
      method: "POST",
    }).catch(() => null);
    clearSignedInWorkspace();
  }

  function expireSession() {
    if (sessionEndedRef.current) return;
    sessionEndedRef.current = true;
    try { workspaceManager.checkpointLocally(); }
    catch { /* A recovery failure must not keep an expired session open. */ }
    clearSignedInWorkspace();
    setAuthError(tRef.current("sessionExpiredError"));
    // Neither native bookkeeping nor a server request may delay the lock screen.
    void window.liberaProfiles?.signedOut().catch(() => undefined);
    const cleanup = new AbortController();
    sessionCleanupRef.current = cleanup;
    void apiRequest("/api/auth/logout", { method: "POST", signal: cleanup.signal })
      .catch(() => undefined)
      .finally(() => { if (sessionCleanupRef.current === cleanup) sessionCleanupRef.current = null; });
  }

  function clearSignedInWorkspace() {
    sessionEndedRef.current = true;
    setAuthenticated(false);
    setBusy(false);
    setPassword("");
    setWorkspaceError("");
    setTree(emptyTree());
    latestDraftByTabIdRef.current = {};
    setTabs([]);
    setActiveTabId("");
    setSelectedNotebookName("");
    expandedRef.current = new Set();
    treeLoadedRef.current = false;
    setExpanded(new Set());
  }

  function updateTab(tabId: string, updater: (tab: OpenTab) => OpenTab) {
    setTabs((currentTabs) => {
      const index = currentTabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return currentTabs;
      const next = updater(currentTabs[index]);
      if (next === currentTabs[index]) return currentTabs;
      return currentTabs.map((tab, i) => i === index ? next : tab);
    });
  }

  function rememberTabDraft(tabId: string, draft: string) {
    latestDraftByTabIdRef.current[tabId] = draft;
  }

  function forgetTabDraft(tabId: string) {
    delete latestDraftByTabIdRef.current[tabId];
  }

  function getTabDraft(tab: OpenTab) {
    // A shared tab's draft is the shared text: AI context, compile staging,
    // links, export and review snapshots all read the live document.
    return readTabDraft(tab, {
      sharedText: (tabId) => getSharedDocRegistry().readTabText(tabId),
      editorDraft: (tabId) => editorDraftReadersRef.current.get(tabId)?.(),
      latestDraft: (tabId) => latestDraftByTabIdRef.current[tabId],
    });
  }

  /** True while a tab's content belongs to a shared document (also while it opens). */
  function isSharedTab(tabId: string) {
    return sharedRegistry.isSharedTab(tabId);
  }

  /** The shared text reached the tab: it is both draft and saved, so the tab is never dirty. */
  function mirrorSharedText(tabId: string, text: string) {
    rememberTabDraft(tabId, text);
    updateTab(tabId, (tab) => (tab.draft === text && tab.saved === text && tab.status === "clean" && !tab.error
      ? tab
      : { ...tab, draft: text, saved: text, status: "clean", error: undefined }));
  }

  /**
   * A tab that was edited before it turned out to be shared (opened before
   * the collaboration status arrived) keeps those edits: they are applied to
   * the shared document as edits from the text they started from.
   */
  function adoptPendingDraft(tabId: string, session: SharedDocSession) {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    const draft = latestDraftByTabIdRef.current[tabId];
    if (!tab || draft === undefined || draft === tab.saved) return;
    adoptPendingSharedDraft(session, draft, tab.saved, (content) => {
      createUntitledFile("", undefined, { fileName: `${tab.file.name}.recovered.md`, content });
      setWorkspaceError(tRef.current("recoveredDraftError"));
    });
  }

  /**
   * Programmatic writes to a shared tab: minimal edits on the Y.Text with the
   * feature's provenance, rebased from the text the caller started from.
   * Returns false for tabs that are not (yet) shared, which then take the
   * regular draft path.
   */
  function writeSharedDraft(tabId: string, value: string, options: DraftWriteOptions = {}) {
    if (!sharedRegistry.sessionForTab(tabId)) return false;
    const base = options.base ?? latestDraftByTabIdRef.current[tabId];
    const result = applyTextToShared({ id: tabId }, value, options.provenance ?? TYPING, { base, registry: sharedRegistry });
    if (result.applied) {
      mirrorSharedText(tabId, sharedRegistry.readTabText(tabId) ?? value);
    } else if (result.reason === "read-only" || result.reason === "not-ready") {
      const error = result.reason === "read-only" ? tRef.current("readOnlyDocumentError") : tRef.current("stillOpeningError");
      updateTab(tabId, (tab) => ({ ...tab, error }));
    }
    return true;
  }

  /**
   * AI results on a shared tab become AI suggestions on the overlay (plan
   * M3.4) instead of edits: the text stays as it is until someone with
   * editor rights accepts them. `edit` is in offsets of `base`, the text the
   * AI was given, and is mapped onto the live text (a concurrent edit makes
   * it conflicted, not lost). Returns false for tabs that are not (yet)
   * shared, which then take the regular draft path.
   */
  function suggestSharedAi(tabId: string, base: string, edit: SnapshotEdit, feature: AiFeature) {
    const result = suggestAiOnSharedTab(sharedRegistry, tabId, base, edit, feature);
    if (!result) return false;
    const notice = aiSuggestionNotice(result);
    updateTab(tabId, (tab) => ({ ...tab, error: notice ?? undefined }));
    return true;
  }

  const duplicateMarkdown = useMarkdownWindows(tabs, getTabDraft, setWorkspaceError);

  function recordFileInteraction(file: LiberaFileNode) {
    const interactedAt = new Date().toISOString();

    setFileInteractions((current) => {
      const nextInteractions = {
        ...current,
        [file.path]: interactedAt,
      };

      window.localStorage.setItem(
        FILE_INTERACTIONS_STORAGE_KEY,
        JSON.stringify(nextInteractions),
      );

      return nextInteractions;
    });
  }

  function rememberPendingOpenViewState(
    filePath: string,
    viewState: OpenTabViewState | undefined,
  ) {
    if (!viewState) {
      return;
    }

    pendingOpenViewStateByPathRef.current[filePath] = mergeOpenTabViewState(
      pendingOpenViewStateByPathRef.current[filePath],
      viewState,
    );
  }

  // Shows a tab in the focused panel, or in a new panel beside it.
  function showOpenedTab(tabId: string, placement: GalleryTabPlacement) {
    const focusedTabId = focusedCanvasPane(canvas.layout)?.tabId;
    // An empty panel, or one already showing the tab, has nothing to split from.
    if (placement === "tab" || !focusedTabId || focusedTabId === tabId) {
      setActiveTabId(tabId);
      return;
    }
    canvas.splitPane(canvas.layout.focusedPaneId, placement, tabId);
  }

  async function openFile(
    file: LiberaFileNode,
    options: { viewState?: OpenTabViewState; placement?: GalleryTabPlacement } = {},
  ) {
    setWorkspaceError("");
    setSelectedNotebookName(file.notebook);
    const placement = options.placement ?? "tab";

    const existingTab = tabs.find((tab) => tab.id === file.path);

    if (existingTab) {
      if (options.viewState) {
        updateTab(file.path, (tab) => ({
          ...tab,
          viewState: mergeOpenTabViewState(tab.viewState, options.viewState ?? {}),
        }));

        if (existingTab.id === activeTabId && options.viewState.markdown) {
          restoreMarkdownTextarea({
            scrollLeft: options.viewState.markdown.editorScrollLeft,
            scrollTop: options.viewState.markdown.editorScrollTop,
            selectionStart: options.viewState.markdown.selectionStart ?? 0,
            selectionEnd: options.viewState.markdown.selectionEnd ?? 0,
          });
        }
      }

      recordFileInteraction(file);
      showOpenedTab(file.path, placement);
      return;
    }

    rememberPendingOpenViewState(file.path, options.viewState);

    if (openingFilePathsRef.current.has(file.path)) {
      recordFileInteraction(file);
      return;
    }

    openingFilePathsRef.current.add(file.path);
    const workspaceEpoch = workspaceManager.epoch.current;

    try {
      const payload = await apiRequest<LiberaFilePayload>(
        `/api/files?path=${encodeURIComponent(file.path)}`,
      );
      if (workspaceEpoch !== workspaceManager.epoch.current) return;
      const draft = payload.content ?? "";
      const requestedViewState = pendingOpenViewStateByPathRef.current[file.path];
      // A reopened file returns to where it was left; a request to reveal a passage still wins.
      const closedViewState = closedViewStatesRef.current[payload.file.path]?.viewState;
      const pendingViewState = closedViewState
        ? mergeOpenTabViewState(closedViewState, requestedViewState ?? {})
        : requestedViewState;
      const nextTab: OpenTab = {
        id: payload.file.path,
        file: payload.file,
        draft,
        saved: draft,
        rawUrl: payload.rawUrl ?? `/api/files/raw/${encodeFilePath(payload.file.path)}`,
        status: "clean",
        viewState: pendingViewState,
      };

      setTabs((currentTabs) => {
        const currentTab = currentTabs.find((tab) => tab.id === nextTab.id);

        if (currentTab) {
          if (!pendingViewState) {
            return currentTabs;
          }

          return currentTabs.map((tab) =>
            tab.id === nextTab.id
              ? {
                  ...tab,
                  viewState: mergeOpenTabViewState(tab.viewState, pendingViewState),
                }
              : tab,
          );
        }

        rememberTabDraft(nextTab.id, draft);
        return [...currentTabs, nextTab];
      });
      if (closedViewState) {
        setClosedViewStates((current) => {
          if (!current[payload.file.path]) return current;
          const rest = { ...current };
          delete rest[payload.file.path];
          return rest;
        });
      }
      showOpenedTab(nextTab.id, placement);
      recordFileInteraction(payload.file);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("openFileError"));
    } finally {
      openingFilePathsRef.current.delete(file.path);
      delete pendingOpenViewStateByPathRef.current[file.path];
    }
  }

  // Opens a gallery photo as a read-only image tab, in the focused panel or in a
  // new panel to its right or below, like a notebook image.
  function openGalleryPhoto(photo: GalleryPhoto, placement: GalleryTabPlacement = "tab") {
    setWorkspaceError("");
    const tab = createGalleryTab(photo);
    setTabs((currentTabs) => currentTabs.some((currentTab) => currentTab.id === tab.id)
      ? currentTabs
      : [...currentTabs, tab]);

    const focusedTabId = focusedCanvasPane(canvas.layout)?.tabId;
    // An empty panel, or one already showing the photo, has nothing to split from.
    if (placement === "tab" || !focusedTabId || focusedTabId === tab.id) {
      setActiveTabId(tab.id);
      return;
    }

    canvas.splitPane(canvas.layout.focusedPaneId, placement, tab.id);
  }

  /** Opens an app page such as Spending in its own tab, or brings its tab to the front. */
  function openPageTab(kind: PageKind) {
    setWorkspaceError("");
    const tab = createPageTab(kind);
    setTabs((currentTabs) => currentTabs.some((currentTab) => currentTab.id === tab.id) ? currentTabs : [...currentTabs, tab]);
    setActiveTabId(tab.id);
  }

  /** Opens the tab of a recording in progress, or brings it to the front. */
  function openRecordingTab(recordingId: string, name: string, notebook: string) {
    setWorkspaceError("");
    const tab = createRecordingTab(recordingId, name, notebook);
    setTabs((currentTabs) => currentTabs.some((currentTab) => currentTab.id === tab.id) ? currentTabs : [...currentTabs, tab]);
    setActiveTabId(tab.id);
  }

  function renameRecordingTab(recordingId: string, name: string) {
    const tabId = recordingTabId(recordingId);
    if (!tabs.some((tab) => tab.id === tabId && tab.file.name !== name)) return;
    updateTab(tabId, (tab) => ({ ...tab, file: { ...tab.file, name } }));
  }

  /** The recording was saved: its tab becomes the saved voice memo, in place. */
  async function replaceRecordingTab(recordingId: string, path: string) {
    const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`);
    const tabId = recordingTabId(recordingId);
    if (tabs.some((tab) => tab.id === tabId)) showImageInTab(tabId, payload.file);
    else await openFile(payload.file);
  }

  function closeRecordingTab(recordingId: string) {
    const tabId = recordingTabId(recordingId);
    if (tabs.some((tab) => tab.id === tabId)) closeTabWithoutConfirm(tabId);
  }

  // Steps an image or recording tab to another one in its folder, in place: the
  // tab keeps its position and panel instead of a new tab opening for each.
  function showImageInTab(tabId: string, file: LiberaFileNode) {
    if ((file.fileType !== "image" && file.fileType !== "audio") || tabId === file.path) {
      return;
    }

    if (tabs.some((tab) => tab.id === file.path) || !tabs.some((tab) => tab.id === tabId)) {
      void openFile(file);
      return;
    }

    forgetTabDraft(tabId);
    rememberTabDraft(file.path, "");
    updateTab(tabId, () => ({
      id: file.path,
      file,
      draft: "",
      saved: "",
      rawUrl: `/api/files/raw/${encodeFilePath(file.path)}`,
      status: "clean",
    }));
    setActiveTabId((current) => (current === tabId ? file.path : current));
  }

  /** Saves edits to a notebook image as a copy beside it, and opens the copy. */
  async function saveEditedImageCopy(sourcePath: string, edits: PhotoEdits) {
    const result = await workspaceFileRequest<{ file: LiberaFileNode; tree: LiberaTree }>(
      "/api/files/edit-image",
      { method: "POST", body: JSON.stringify({ path: sourcePath, edits }) },
      (payload) => ({ paths: [payload.file.path] }),
    );
    await applyCompleteTree(result.tree);
    await openFile(result.file);
  }

  async function openMarkdownFileLink(sourcePath: string, href: string) {
    if (href.startsWith("#")) {
      const sourceTab = tabs.find((tab) => tab.file.path === sourcePath);

      if (!sourceTab || sourceTab.file.fileType !== "markdown") {
        return false;
      }

      const markdown =
        sourceTab.id === activeTabId && textareaRef.current
          ? textareaRef.current.value
          : getTabDraft(sourceTab);

      return openMarkdownHeading(sourceTab.file, markdown, href);
    }

    // A note's Python sidecar is in its assets folder, which the file tree leaves out.
    if (href === pythonSidecarHref(sourcePath)) {
      const sidecar = await apiRequest<{ path: string }>(`/api/python/run?document=${encodeURIComponent(sourcePath)}`).catch(() => null);
      if (!sidecar) return false;
      const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(sidecar.path)}`).catch(() => null);
      if (!payload) return false;
      await openFile(payload.file);
      return true;
    }

    const resolvedLink = resolveMarkdownFileLink(href, sourcePath, files);

    if (!resolvedLink) {
      return false;
    }

    const quote = resolvedLink.metadata?.quote;

    if ((resolvedLink.headingFragment || quote) && resolvedLink.file.fileType === "markdown") {
      const markdown = await readMarkdownForLink(resolvedLink.file);

      if (resolvedLink.headingFragment && await openMarkdownHeading(resolvedLink.file, markdown, resolvedLink.headingFragment)) {
        return true;
      }

      const range = quote
        ? resolveMarkdownLinkQuote(markdown, quote, resolvedLink.metadata?.viewState?.markdown?.selectionStart)
        : null;

      if (range) {
        await revealMarkdownRange(resolvedLink.file, markdown, range.start, range.end);
        return true;
      }
    }

    const time = resolvedLink.file.fileType === "audio" ? resolvedLink.metadata?.viewState?.audio?.currentTime : undefined;
    await openFile(resolvedLink.file, {
      // A link to a moment in a recording plays it from there.
      viewState: time !== undefined
        ? { audio: { currentTime: time, reveal: { seconds: time, nonce: Date.now() } } }
        : withAnnotationReveal(resolvedLink.metadata?.viewState),
    });
    return true;
  }

  // An annotation link (one without a saved view) asks the PDF or image viewer
  // to show its annotation, instead of restoring the tab's own scroll or pan.
  function withAnnotationReveal(viewState: OpenTabViewState | undefined): OpenTabViewState | undefined {
    const pdf = viewState?.pdf;
    const image = viewState?.image;

    if (pdf?.selectedAnnotationId && pdf.scrollTop === undefined) {
      return { ...viewState, pdf: { ...pdf, revealSelectedAnnotation: true } };
    }

    if (image?.selectedAnnotationId && image.panX === undefined) {
      return { ...viewState, image: { ...image, revealSelectedAnnotation: true } };
    }

    return viewState;
  }

  async function readMarkdownForLink(file: LiberaFileNode) {
    const openTab = tabs.find((tab) => tab.id === file.path);

    if (openTab) {
      return openTab.id === activeTabId && textareaRef.current
        ? textareaRef.current.value
        : getTabDraft(openTab);
    }

    try {
      const payload = await apiRequest<LiberaFilePayload>(
        `/api/files?path=${encodeURIComponent(file.path)}`,
      );
      return payload.content ?? "";
    } catch {
      return "";
    }
  }

  // Opens a Markdown file at the heading a `#fragment` names.
  async function openMarkdownHeading(file: LiberaFileNode, markdown: string, fragment: string) {
    const heading = findMarkdownHeadingAnchor(markdown, fragment);

    if (!heading) {
      return false;
    }

    await revealMarkdownRange(file, markdown, heading.offset);
    return true;
  }

  // Opens a Markdown file at a source offset, or with a source range selected,
  // in the source editor or the visual editor, whichever shows the document.
  async function revealMarkdownRange(file: LiberaFileNode, markdown: string, start: number, end?: number) {
    await openFile(file, {
      viewState: {
        markdown: {
          line: lineForOffset(markdown, start),
          selectionEnd: end ?? start,
          selectionStart: start,
        },
      },
    });

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;

        if (textarea && textarea.value === markdown) {
          textarea.focus();
          textarea.setSelectionRange(start, end ?? start);
          scrollTextareaToOffset(textarea, start, { block: end === undefined ? "start" : "center" });
          return;
        }

        window.dispatchEvent(new CustomEvent<MarkdownOutlineNavigateDetail>(MARKDOWN_OUTLINE_NAVIGATE_EVENT, {
          detail: { documentPath: file.path, end, markdown, offset: start },
        }));
      });
    });
  }

  /** Unsaved text, ink or annotations (pending-saves.ts). A save that failed leaves the text unsaved too. */
  function tabUnsaved(tab: OpenTab) {
    return tab.status === "dirty" || tab.status === "error" || pendingSaves.isDirty(tab.file.path);
  }

  /** Close without saving: unsaved ink and annotations are dropped, with their recovery copy. */
  function discardPendingSaves(tabIds: string[]) {
    for (const tab of tabs) if (tabIds.includes(tab.id)) pendingSaves.discard(tab.file.path);
  }

  const closeTabsWithoutConfirm = useCallback((tabIds: string[], options: { remember?: boolean } = {}) => {
    const closingTabIds = new Set(tabIds);

    if (!closingTabIds.size) {
      return;
    }

    const closingTabs = tabs.filter((currentTab) => closingTabIds.has(currentTab.id));

    if (options.remember !== false) {
      // Read the mounted viewers' latest scroll and selection, which they
      // report only after a short pause, before their tabs go away.
      flushSync(captureCanvasViewState);
      const latestClosing = tabsRef.current.filter((currentTab) => closingTabIds.has(currentTab.id));
      setClosedViewStates((current) => rememberClosedViewStates(current, latestClosing));
    }

    closingTabs.forEach((tab) => forgetTabDraft(tab.id));
    setTabs((currentTabs) =>
      currentTabs.filter((currentTab) => !closingTabIds.has(currentTab.id)),
    );

    if (closingTabIds.has(activeTabId)) {
      const remainingTabs = tabs.filter((currentTab) => !closingTabIds.has(currentTab.id));
      const splitNeighbourTabId = canvas.nextActiveTabAfterClosing(closingTabIds);
      const nextActiveTab =
        remainingTabs.find((currentTab) => currentTab.id === splitNeighbourTabId) ?? remainingTabs.at(-1);
      const activeClosingTab = closingTabs.find((tab) => tab.id === activeTabId);
      const fallbackTab = activeClosingTab ?? closingTabs.at(-1);

      setActiveTabId(nextActiveTab?.id ?? "");

      const notebookTab = nextActiveTab ?? fallbackTab;
      if (notebookTab && !isGalleryTab(notebookTab)) {
        setSelectedNotebookName(notebookTab.file.notebook);
      }
    }
  }, [activeTabId, canvas, tabs]);

  const closeTabWithoutConfirm = useCallback((tabId: string) => {
    closeTabsWithoutConfirm([tabId]);
  }, [closeTabsWithoutConfirm]);

  // The gallery store is shared with the gallery view, so moves into albums,
  // edits and deletions there reach open photo tabs here.
  // It listens only while a photo tab is open, and reconciles when the catalog
  // or the set of photo tabs changes, not for drafts or view state.
  const openGalleryKey = galleryTabKey(tabs);
  const galleryContents = useGalleryContents(openGalleryKey !== "");
  const closeTabsWithoutConfirmRef = useRef(closeTabsWithoutConfirm);
  useEffect(() => {
    closeTabsWithoutConfirmRef.current = closeTabsWithoutConfirm;
  }, [closeTabsWithoutConfirm]);
  useEffect(() => {
    if (!galleryContents || !openGalleryKey) return;
    const reconciled = reconcileGalleryTabs(tabsRef.current, galleryContents.photos);
    if (reconciled.tabs !== tabsRef.current) {
      const changed = new Map(reconciled.tabs.map((tab) => [tab.id, tab]));
      setTabs((currentTabs) => currentTabs.map((tab) => isGalleryTab(tab) ? changed.get(tab.id) ?? tab : tab));
    }
    // Called from an effect, and photos that were deleted have no place to keep.
    if (reconciled.closedTabIds.length) closeTabsWithoutConfirmRef.current(reconciled.closedTabIds, { remember: false });
  }, [galleryContents, openGalleryKey]);

  const closeTab = useCallback((tabId: string) => {
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

    if (tab && ((!isSharedRegistryTab(tab.id) && getTabDraft(tab) !== tab.saved) || pendingSaves.isDirty(tab.file.path))) {
      setWorkspaceConfirmDialog({
        mode: "close-tab",
        tabId,
        fileName: tab.file.name,
      });
      return;
    }

    closeTabWithoutConfirm(tabId);
  }, [closeTabWithoutConfirm, tabs]);

  const closeOtherTabs = useCallback((tabId: string) => {
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

    if (!tab) {
      return;
    }

    const otherTabs = tabs.filter((currentTab) => currentTab.id !== tabId);

    if (!otherTabs.length) {
      return;
    }

    const dirtyTabCount = otherTabs.filter((currentTab) => (!isSharedRegistryTab(currentTab.id) && getTabDraft(currentTab) !== currentTab.saved) || pendingSaves.isDirty(currentTab.file.path)).length;
    const otherTabIds = otherTabs.map((currentTab) => currentTab.id);

    if (dirtyTabCount > 0) {
      setWorkspaceConfirmDialog({
        mode: "close-tabs",
        tabIds: otherTabIds,
        tabCount: otherTabs.length,
        dirtyTabCount,
      });
      return;
    }

    closeTabsWithoutConfirm(otherTabIds);
  }, [closeTabsWithoutConfirm, tabs]);

  function getReviewDraft(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) throw new Error(tRef.current("reviewDocumentClosedError"));
    return tabId === activeTabId && textareaRef.current ? textareaRef.current.value : getTabDraft(tab);
  }

  function applyReviewDraft(tabId: string, before: string, after: string) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || getReviewDraft(tabId) !== before) return false;
    if (sharedRegistry.sessionForTab(tabId)) {
      const result = applyTextToShared(tab, after, { source: "ai", feature: "agentic-review" }, { base: before, registry: sharedRegistry });
      if (!result.applied && result.reason !== "unchanged") return false;
      mirrorSharedText(tabId, sharedRegistry.readTabText(tabId) ?? after);
      return true;
    }
    rememberTabDraft(tabId, after);
    updateTab(tabId, (current) => ({ ...current, draft: after, status: after === current.saved ? "clean" : "dirty", error: undefined }));
    return true;
  }

  /** The live draft of an open text tab, or null when the file is not open. */
  function readOpenTabDraft(path: string) {
    const tab = tabs.find((item) => item.id === path && !item.untitled);
    return tab && isTextFileType(tab.file.fileType) ? getReviewDraft(path) : null;
  }

  /**
   * Shows a file the AI agent changed on disk in its open tab. The tab follows
   * the new content unless the user typed since `baseline` (the draft the agent
   * started from); then their draft stays and only the saved copy moves on.
   */
  async function syncTabFromDisk(path: string, baseline?: string): Promise<{ content: string; keptDraft: boolean } | null> {
    // The host owns a shared file's disk copy; the tab follows the Y.Text.
    if (!mayTakeContentFromDisk(path, isSharedTab)) return null;
    if (readOpenTabDraft(path) === null) return null;
    const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`);
    const content = payload.content ?? "";
    const draft = readOpenTabDraft(path);
    if (draft === null || !mayTakeContentFromDisk(path, isSharedTab)) return null;
    const follow = baseline === undefined || draft === baseline || draft === content;
    if (follow) rememberTabDraft(path, content);
    updateTab(path, (current) => ({
      ...current, file: payload.file, saved: content, draft: follow ? content : current.draft,
      status: (follow ? content : draft) === content ? "clean" : "dirty", error: undefined,
    }));
    return { content, keptDraft: !follow };
  }

  /** After an agent change is undone, put the tab back as it was: the restored file, and any unsaved draft the agent started from. */
  function restoreTabAfterUndo(path: string, result: { status: "restored" | "deleted"; content?: string; draft?: string }) {
    const tab = tabs.find((item) => item.id === path && !item.untitled);
    if (!tab || !mayTakeContentFromDisk(tab.id, isSharedTab)) return;
    const draft = getTabDraft(tab);
    const untouched = draft === tab.saved;
    if (result.status === "deleted") {
      if (untouched) closeTabsWithoutConfirm([path]);
      return;
    }
    const saved = result.content ?? "";
    const next = untouched ? result.draft ?? saved : draft;
    if (untouched) rememberTabDraft(path, next);
    updateTab(path, (current) => ({ ...current, saved, draft: untouched ? next : current.draft, status: next === saved ? "clean" : "dirty", error: undefined }));
  }

  /**
   * Manual review rejected the agent's changes and wrote the file's baseline
   * to disk. The baseline already holds the user's own edits made while
   * reviewing, so the tab takes it as both draft and saved copy.
   */
  function replaceTabFromDisk(path: string, content: string, expectedDraft?: string | null) {
    const tab = tabs.find((item) => item.id === path && !item.untitled);
    if (!tab || !mayTakeContentFromDisk(tab.id, isSharedTab)) return;
    const draft = readOpenTabDraft(path);
    const follow = expectedDraft === undefined || draft === expectedDraft || draft === content;
    if (follow) rememberTabDraft(path, content);
    updateTab(path, (current) => ({ ...current, saved: content, draft: follow ? content : draft ?? current.draft,
      status: (follow ? content : draft) === content ? "clean" : "dirty", error: undefined }));
  }

  /**
   * A citation key rewrite reaching an open tab (Update citations in the
   * References panel): the live draft gets the same rewrite, and the saved
   * copy too when the file on disk was rewritten. Returns the draft before and
   * after, for undo, or null when the file is not open as an editable tab.
   */
  function applyCitationRewriteToTab(path: string, map: Record<string, string>, options: { savedRewritten: boolean }) {
    const tab = tabsRef.current.find((item) => item.id === path && !item.untitled);
    if (!tab || !isTextFileType(tab.file.fileType) || !mayTakeContentFromDisk(path, isSharedTab)) return null;
    const keys = new Map(Object.entries(map));
    const before = getTabDraft(tab);
    const after = rewriteCitationKeys(before, keys).text;
    const saved = options.savedRewritten ? rewriteCitationKeys(tab.saved, keys).text : tab.saved;
    rememberTabDraft(path, after);
    updateTab(path, (current) => ({ ...current, saved, draft: after, status: after === saved ? "clean" : "dirty", error: undefined }));
    return { before, after };
  }

  /**
   * Undo of a citation rewrite in an open tab: the draft goes back unless it
   * was edited since, and the saved copy is reloaded when the file was restored.
   */
  async function revertCitationRewriteInTab(path: string, change: { before: string; after: string }, options: { refreshSaved: boolean }) {
    if (readOpenTabDraft(path) === null || !mayTakeContentFromDisk(path, isSharedTab)) return;
    let saved: string | undefined;
    if (options.refreshSaved) {
      const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(path)}`);
      saved = payload.content ?? "";
    }
    const tab = tabsRef.current.find((item) => item.id === path && !item.untitled);
    if (!tab) return;
    const current = getTabDraft(tab);
    const draft = current === change.after ? change.before : current;
    rememberTabDraft(path, draft);
    updateTab(path, (item) => {
      const nextSaved = saved ?? item.saved;
      return { ...item, saved: nextSaved, draft, status: draft === nextSaved ? "clean" : "dirty", error: undefined };
    });
  }

  /**
   * The text of a tab whose file moved (tab-retarget.ts reconcileMovedText).
   * A move may have rewritten the note itself: image URLs (into another
   * notebook), paths to follow what moved, citation keys, in that order, as
   * the server did (move-rewrites.ts moveTextRewrite). The saved copy is then
   * the server's content and the draft gets the same rewrites. Otherwise the
   * text now at the destination is compared with the tab's baseline, so a
   * note moved and edited outside the app reloads when clean and keeps its
   * edits, with a conflict, when dirty.
   */
  function movedTabText(tab: OpenTab, draft: string, payload: LiberaFileMovePayload) {
    if (!isTextFileType(tab.file.fileType) || !mayTakeContentFromDisk(tab.id, isSharedTab)) return null;
    const rewrite = moveTextRewrite(payload.file.path, {
      imageSources: payload.imageSources,
      paths: payload.links?.rewritten.find((item) => item.path === payload.file.path)?.rewrite,
      citationKeys: payload.references?.drafts.find((item) => item.path === payload.file.path)?.map,
    });
    return reconcileMovedText({ saved: tab.saved, draft, fetched: payload.content, rewrite });
  }

  /**
   * What the app does once the server says a file moved, whichever way it was moved
   * (Move…, rename, drag and drop, archive, one file of a selection): open tabs follow
   * it, open files whose links the move rewrote get the same rewrite on their draft and
   * save baseline, and the notices say what changed with it. The caller refreshes the
   * tree (once for a batch). A batch reports once per file, as before.
   */
  function followFileMove(fromPath: string, payload: LiberaFileMovePayload) {
    retargetOpenTab(fromPath, payload);
    applyLinkRewritesToTabs(payload.links, [payload.file.path]);
    reportMoveOutcome({ references: payload.references, notebook: payload.file.notebook, links: payload.links, unfinished: payload.unfinished });
  }

  /**
   * What saved workspaces learn from a move of one file: where it went, and
   * the text rewrites of the moved file (images, paths, citation keys) and of
   * the files whose links followed it, for their tabs saved and unsaved.
   */
  function moveFileChange(from: string, payload: LiberaFileMovePayload): WorkspaceFileChange {
    const to = payload.file.path;
    const own = moveTextRewrite(to, {
      imageSources: payload.imageSources,
      paths: payload.links?.rewritten.find((item) => item.path === to)?.rewrite,
      citationKeys: payload.references?.drafts.find((item) => item.path === to)?.map,
    });
    const others = linkRewriteByPath(payload.links);
    const rewrite = own || others ? (path: string, text: string) => path === to ? own?.(text) ?? text : others?.(path, text) ?? text : undefined;
    return { moved: { from, to }, ...(rewrite ? { rewrite } : {}) };
  }

  /**
   * A move whose request failed after the file moved (the error body carries
   * `moved` and `unfinished`): the tab follows the file anyway, saved workspaces
   * learn the move, and the notice lists what did not follow.
   */
  async function followCommittedMove(file: LiberaFileNode, committed: CommittedMove) {
    const { from, to } = committed.moved;
    const rewrite = linkRewriteByPath(committed.links);
    await workspaceManager.runFileChange(async () => committed, () => ({ paths: [to], moved: { from, to }, ...(rewrite ? { rewrite } : {}) })).catch(() => undefined);
    const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(to)}`).catch(() => null)
      ?? { file: { ...file, path: to, name: to.split("/").at(-1)!, notebook: to.split("/")[0] } };
    followFileMove(from, { ...payload, moved: committed.moved, unfinished: committed.unfinished, ...(committed.links ? { links: committed.links } : {}) });
    await refreshTree().catch(() => undefined);
  }

  /**
   * Files whose links a move rewrote on disk and that are open here (by their
   * path now): the draft and the save baseline get the same rewrite
   * (tab-retarget.ts rewriteOpenText), so unsaved edits stay and the next save
   * meets the text on disk. `skip`: files whose tab followed the move with the
   * rewrite already (movedTabText).
   */
  function applyLinkRewritesToTabs(links: LiberaLinkRewrites | undefined, skip: readonly string[] = []) {
    const rewrite = linkRewriteByPath(links);
    if (!rewrite) return;
    for (const { path } of links!.rewritten) {
      if (skip.includes(path)) continue;
      const tab = tabsRef.current.find((item) => item.id === path && !item.untitled);
      if (!tab || !isTextFileType(tab.file.fileType) || !mayTakeContentFromDisk(path, isSharedTab)) continue;
      const next = rewriteOpenText({ saved: tab.saved, draft: getTabDraft(tab), conflict: tab.diskConflict?.text }, (text) => rewrite(path, text));
      rememberTabDraft(path, next.draft);
      updateTab(path, (current) => ({
        ...current, saved: next.saved, draft: next.draft,
        ...(current.diskConflict ? { diskConflict: { text: next.conflict ?? null } } : { status: next.draft === next.saved ? "clean" as const : "dirty" as const, error: undefined }),
      }));
    }
  }

  /**
   * One notice for what a move did besides moving: the references it copied,
   * "Updated links in N notes", and as a warning what could not follow (links
   * left as written, notebooks not read in full, steps that did not finish).
   */
  function reportMoveOutcome({ references, notebook, links, unfinished }: { references?: ReferenceMoveResult | null; notebook: string; links?: LiberaLinkRewrites; unfinished?: LiberaMoveStep[] }) {
    const t = tRef.current;
    const parts: string[] = [];
    let warning = false;
    if (references) {
      if (references.destinationRevision !== null) announceReferenceLibraryChange(notebook, references.destinationRevision);
      const summary = referenceMoveSummary(references, notebook);
      const values = summary?.values;
      // Alone, the notice translates itself; beside the links it is translated here.
      if (summary && !links?.rewritten.length && !links?.skipped.length && !links?.unchecked.length && !unfinished?.length) { setReferenceMoveNotice({ id: Date.now(), ...summary }); return; }
      if (summary) parts.push(!values ? summary.text : values.error !== undefined ? tReferencesRef.current("movedCopyFailed", { destination: values.destination, error: values.error }) : tReferencesRef.current("summary", values));
      warning ||= summary?.tone === "warning";
    }
    const updated = new Set(links?.rewritten.map((item) => item.path)).size;
    if (updated) parts.push(t("movedLinksUpdated", { count: updated }));
    if (links?.skipped.length) {
      warning = true;
      const shown = links.skipped.slice(0, 3).map((item) => t("movedLinkSkipped", { written: item.written, path: item.path, reason: t(`movedLinkReasons.${item.reason}`) })).join("; ");
      parts.push(t("movedLinksNotUpdated", { count: links.skipped.length, links: links.skipped.length > 3 ? `${shown}; …` : shown }));
    }
    if (links?.unchecked.length) {
      warning = true;
      parts.push(t("movedLinksUnchecked", { notebooks: links.unchecked.join(", ") }));
    }
    if (unfinished?.length) {
      warning = true;
      parts.push(t("moveUnfinishedNotice", { steps: [...new Set(unfinished.map((item) => t(`moveSteps.${item.step}`)))].join(", ") }));
    }
    if (parts.length) setReferenceMoveNotice({ id: Date.now(), tone: warning ? "warning" : "info", text: parts.join(" · ") });
  }

  const dismissReferenceMoveNotice = useCallback(() => setReferenceMoveNotice(null), []);

  /** Files the agent created join the active workspace, like files created in the app. */
  async function refreshAfterAgentChanges(createdPaths: string[]) {
    if (createdPaths.length) {
      await workspaceManager.runFileChange(async () => createdPaths, (paths) => ({ paths })).catch(() => undefined);
    }
    await refreshTree().catch((error: Error) => setWorkspaceError(error.message));
  }

  function setActiveDraft(value: string, options?: DraftWriteOptions) {
    if (activeTab) {
      setTabDraft(activeTab.id, value, options);
    }
  }

  // Split panes edit their own tab; targeting it by id keeps a background pane
  // from ever writing into whichever tab happens to be active.
  function setTabDraft(tabId: string, value: string, options?: DraftWriteOptions) {
    // Never a whole-text replacement on a shared tab.
    if (writeSharedDraft(tabId, value, options)) return;
    rememberTabDraft(tabId, value);
    updateTab(tabId, (tab) => ({
      ...tab,
      draft: value,
      status: value === tab.saved ? "clean" : "dirty",
      error: undefined,
    }));
  }

  const setActiveTabViewState = useCallback(
    (viewState: OpenTabViewState, tabId?: string) => {
      const targetTabId = tabId ?? activeTabId;
      if (viewState.markdown?.editorMode !== undefined) captureCanvasViewState();

      if (!targetTabId) {
        return;
      }

      updateTab(targetTabId, (tab) => {
        const nextViewState: OpenTabViewState = {
          ...tab.viewState,
          image: viewState.image
            ? { ...tab.viewState?.image, ...viewState.image }
            : tab.viewState?.image,
          latex: viewState.latex
            ? { ...tab.viewState?.latex, ...viewState.latex }
            : tab.viewState?.latex,
          markdown: viewState.markdown
            ? { ...tab.viewState?.markdown, ...viewState.markdown }
            : tab.viewState?.markdown,
          pdf: viewState.pdf
            ? { ...tab.viewState?.pdf, ...viewState.pdf }
            : tab.viewState?.pdf,
          text: viewState.text
            ? { ...tab.viewState?.text, ...viewState.text }
            : tab.viewState?.text,
        };

        if (
          shallowEqualRecord(tab.viewState?.image, nextViewState.image) &&
          shallowEqualRecord(tab.viewState?.latex, nextViewState.latex) &&
          shallowEqualRecord(tab.viewState?.markdown, nextViewState.markdown) &&
          shallowEqualRecord(tab.viewState?.pdf, nextViewState.pdf) &&
          shallowEqualRecord(tab.viewState?.text, nextViewState.text)
        ) {
          return tab;
        }

        return {
          ...tab,
          viewState: nextViewState,
        };
      });
    },
    [activeTabId],
  );

  function restoreMarkdownTextarea(options: {
    scrollLeft?: number;
    scrollTop?: number;
    selectionEnd: number;
    selectionStart: number;
  }) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;

        if (!textarea) {
          return;
        }

        textarea.focus();
        textarea.setSelectionRange(options.selectionStart, options.selectionEnd);

        if (typeof options.scrollTop === "number") {
          textarea.scrollTop = options.scrollTop;
        }

        if (typeof options.scrollLeft === "number") {
          textarea.scrollLeft = options.scrollLeft;
        }
      });
    });
  }

  function getMarkdownTextareaScrollState() {
    const textarea = textareaRef.current;

    return {
      scrollLeft: textarea?.scrollLeft,
      scrollTop: textarea?.scrollTop,
    };
  }

  function insertMarkdown(before: string, after = "", placeholder = "text") {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const textarea = textareaRef.current;
    const scrollState = getMarkdownTextareaScrollState();
    const draft = textarea?.value ?? getTabDraft(activeTab);
    let start = textarea?.selectionStart ?? draft.length;
    let end = textarea?.selectionEnd ?? draft.length;
    const selectedText = draft.slice(start, end) || placeholder;
    let replacement = `${before}${selectedText}${after}`;
    let nextSelectionStart = start + before.length;
    let nextSelectionEnd = nextSelectionStart + selectedText.length;
    const boxMarker = new RegExp(`^([${MARKDOWN_BOX_SHORTCUTS}]?)> $`, "i").exec(before);
    if (boxMarker && !after) {
      const box = createMarkdownBoxInsertion(draft, start, end, boxMarker[1], placeholder);
      start = box.selectionStart;
      end = box.selectionEnd;
      replacement = box.replacement;
      nextSelectionStart = box.nextSelectionStart;
      nextSelectionEnd = box.nextSelectionEnd;
    }
    const nextDraft = `${draft.slice(0, start)}${replacement}${draft.slice(end)}`;

    if (
      textarea &&
      replaceTextareaSelectionWithUndo(textarea, {
        ...scrollState,
        nextSelectionEnd,
        nextSelectionStart,
        replacement,
        selectionEnd: end,
        selectionStart: start,
      })
    ) {
      restoreMarkdownTextarea({
        ...scrollState,
        selectionStart: nextSelectionStart,
        selectionEnd: nextSelectionEnd,
      });
      return;
    }

    setActiveDraft(nextDraft, { base: draft });
    restoreMarkdownTextarea({
      ...scrollState,
      selectionStart: nextSelectionStart,
      selectionEnd: nextSelectionEnd,
    });
  }

  /** The toolbar's Indent / Outdent list item buttons in the Source editor. */
  function shiftMarkdownList(direction: ListIndentDirection) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const textarea = textareaRef.current;
    const scrollState = getMarkdownTextareaScrollState();
    const draft = textarea?.value ?? getTabDraft(activeTab);
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const result = shiftMarkdownListItems(draft, start, end, direction);

    if (!result) {
      textarea?.focus();
      return;
    }

    const selection = { selectionStart: result.nextStart, selectionEnd: result.nextEnd };

    if (
      textarea &&
      replaceTextareaSelectionWithUndo(textarea, {
        ...scrollState,
        ...result.changed,
        nextSelectionStart: result.nextStart,
        nextSelectionEnd: result.nextEnd,
      })
    ) {
      restoreMarkdownTextarea({ ...scrollState, ...selection });
      return;
    }

    setActiveDraft(result.nextValue, { base: draft });
    restoreMarkdownTextarea({ ...scrollState, ...selection });
  }

  /**
   * Cites `key` (or several keys, as one citation `[@a; @b]`) at the caret of
   * the active Markdown editor, in the source or the visual editor; in a
   * LaTeX source, as `\cite{a,b}` or `\citep{a,b}`, replacing the selection.
   */
  function insertCitation(key: string | string[], command: LatexCiteCommand = "cite") {
    if (!activeTab) return false;
    const keys = typeof key === "string" ? [key] : key;
    if (!keys.length) return false;
    if (activeTab.file.fileType === "latex" && isLatexCitingPath(activeTab.file.name)) {
      const view = getLatexEditor(activeTab.id)?.view;
      if (!view || view.state.readOnly) return false;
      const citation = latexCitation(keys, command);
      if (!citation) {
        setWorkspaceError(tRef.current("citationKeysLatexError"));
        return false;
      }
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: citation }, selection: { anchor: from + citation.length }, scrollIntoView: true, userEvent: "input" });
      view.focus();
      return true;
    }
    if (activeTab.file.fileType !== "markdown") return false;
    const citation = `[${keys.map((item) => `@${item}`).join("; ")}]`;
    const visual = (activeTab.viewState?.markdown?.editorMode ?? "visual") === "visual" && !isMarkdownSlidesPath(activeTab.file.path);
    if (visual) queueVisualInsertion(activeTab.id, citation, { inline: true });
    else insertMarkdown(citation, "", "");
    return true;
  }

  /** Places the generated bibliography: a `:::bibliography` marker as its own block after the caret's paragraph. */
  function insertBibliographyMarker() {
    if (!activeTab || activeTab.file.fileType !== "markdown") return false;
    const marker = ":::bibliography\n:::";
    const visual = (activeTab.viewState?.markdown?.editorMode ?? "visual") === "visual" && !isMarkdownSlidesPath(activeTab.file.path);
    if (visual) {
      queueVisualInsertion(activeTab.id, marker);
      return true;
    }
    const textarea = textareaRef.current;
    const scrollState = getMarkdownTextareaScrollState();
    const draft = textarea?.value ?? getTabDraft(activeTab);
    const position = findMarkdownBlockInsertionOffset(draft, textarea?.selectionEnd ?? draft.length);
    const insertion = insertMarkdownBlock(draft, position, marker);
    const replacement = insertion.value.slice(position, position + insertion.value.length - draft.length);
    const caret = position + replacement.length;
    if (
      textarea &&
      replaceTextareaSelectionWithUndo(textarea, {
        ...scrollState,
        nextSelectionEnd: caret,
        nextSelectionStart: caret,
        replacement,
        selectionEnd: position,
        selectionStart: position,
      })
    ) {
      restoreMarkdownTextarea({ ...scrollState, selectionStart: caret, selectionEnd: caret });
      return true;
    }
    setActiveDraft(insertion.value);
    restoreMarkdownTextarea({ ...scrollState, selectionStart: caret, selectionEnd: caret });
    return true;
  }

  /** Insert an empty table as its own block after the caret's paragraph, with
   * the first column name selected so typing replaces it. */
  function insertMarkdownTable(rows: number, columns: number) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const textarea = textareaRef.current;
    const scrollState = getMarkdownTextareaScrollState();
    const draft = textarea?.value ?? getTabDraft(activeTab);
    const position = findMarkdownBlockInsertionOffset(draft, textarea?.selectionEnd ?? draft.length);
    const insertion = insertMarkdownBlock(draft, position, markdownTable(rows, columns));
    const replacement = insertion.value.slice(position, position + insertion.value.length - draft.length);
    const nextSelectionStart = insertion.start + 2;
    const nextSelectionEnd = nextSelectionStart + MARKDOWN_TABLE_FIRST_HEADER.length;

    if (
      textarea &&
      replaceTextareaSelectionWithUndo(textarea, {
        ...scrollState,
        nextSelectionEnd,
        nextSelectionStart,
        replacement,
        selectionEnd: position,
        selectionStart: position,
      })
    ) {
      restoreMarkdownTextarea({
        ...scrollState,
        selectionStart: nextSelectionStart,
        selectionEnd: nextSelectionEnd,
      });
      return;
    }

    setActiveDraft(insertion.value);
    restoreMarkdownTextarea({
      ...scrollState,
      selectionStart: nextSelectionStart,
      selectionEnd: nextSelectionEnd,
    });
  }

  function insertMarkdownFileLinkPlaceholder() {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const textarea = textareaRef.current;
    const scrollState = getMarkdownTextareaScrollState();
    const draft = textarea?.value ?? getTabDraft(activeTab);
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const selectedText = draft.slice(start, end) || "link";
    const insertion = `[${selectedText}]()`;
    const nextDraft = `${draft.slice(0, start)}${insertion}${draft.slice(end)}`;
    const destinationOffset = start + selectedText.length + 3;

    if (
      textarea &&
      replaceTextareaSelectionWithUndo(textarea, {
        ...scrollState,
        nextSelectionEnd: destinationOffset,
        nextSelectionStart: destinationOffset,
        replacement: insertion,
        selectionEnd: end,
        selectionStart: start,
      })
    ) {
      restoreMarkdownTextarea({
        ...scrollState,
        selectionStart: destinationOffset,
        selectionEnd: destinationOffset,
      });
      return;
    }

    setActiveDraft(nextDraft, { base: draft });
    restoreMarkdownTextarea({
      ...scrollState,
      selectionStart: destinationOffset,
      selectionEnd: destinationOffset,
    });
  }

  /** The passage highlighted in a Markdown tab's source or visual editor. */
  function markdownTabHighlight(tab: OpenTab, viewState = tab.viewState) {
    if (tab.file.fileType !== "markdown" || isGalleryTab(tab)) {
      return null;
    }

    const markdown = getTabDraft(tab);
    const range = viewState?.markdown?.linkSelection;

    if (!isMarkdownSourceRange(range, markdown)) {
      return null;
    }

    const quote = createMarkdownLinkQuote(markdown, range);

    return { label: markdownLinkQuoteLabel(quote.text), quote, range };
  }

  /** The annotation selected in a PDF or image tab, which a link can point to. */
  function annotationTabHighlight(tab: OpenTab, viewState = tab.viewState) {
    if (isGalleryTab(tab)) {
      return null;
    }

    const fileType = tab.file.fileType;
    const id = fileType === "pdf"
      ? viewState?.pdf?.selectedAnnotationId
      : fileType === "image" ? viewState?.image?.selectedAnnotationId : undefined;

    if (!id) {
      return null;
    }

    const annotation = findRememberedAnnotation(tab.file.path, id);
    const kind = annotation?.type === "highlight" ? "highlight" : annotation ? "note" : "annotation";

    return { id, kind, label: annotationLinkLabel(annotation, tRef.current("selectedLabel", { kind })) };
  }

  /** "Link to the highlighted text / selected annotation in <tab>" choices for the link dialogs. */
  function listMarkdownSelectionLinks(sourcePath: string): MarkdownSelectionLinkOption[] {
    return tabs.flatMap((tab) => {
      if (tab.file.path === sourcePath) {
        return [];
      }

      const highlighted = markdownTabHighlight(tab) ?? annotationTabHighlight(tab);

      if (!highlighted?.label) {
        return [];
      }

      return [{
        href: createMarkdownFileLinkDestination({
          metadata: createMarkdownFileLinkMetadata({ file: tab.file, source: "tab", tabId: tab.id, viewState: tab.viewState }),
          sourcePath,
          targetPath: tab.file.path,
        }),
        id: tab.id,
        label: highlighted.label,
        tabName: tab.file.name,
        title: "kind" in highlighted
          ? tRef.current("linkToKindTitle", { kind: highlighted.kind, name: tab.file.name })
          : tRef.current("linkToHighlightTitle", { name: tab.file.name }),
      }];
    });
  }

  function createMarkdownFileLinkMetadata(
    selection: MarkdownFileLinkSelection,
  ): MarkdownFileLinkMetadata | undefined {
    if (selection.source !== "tab") {
      return undefined;
    }

    const targetTab = tabs.find(
      (tab) => tab.id === selection.tabId || tab.file.path === selection.file.path,
    );
    const viewState = selection.viewState ?? targetTab?.viewState ?? {};
    const highlighted = targetTab ? markdownTabHighlight(targetTab, viewState) : null;
    const annotation = targetTab ? annotationTabHighlight(targetTab, viewState) : null;
    const markdownSelectionStart = highlighted?.range.start ?? viewState.markdown?.selectionStart;
    const line =
      targetTab?.file.fileType === "markdown" &&
      typeof markdownSelectionStart === "number"
        ? lineForOffset(getTabDraft(targetTab), markdownSelectionStart)
        : viewState.markdown?.line ?? (selection.file.fileType === "markdown" ? 1 : undefined);

    return {
      fileType: selection.file.fileType,
      line,
      quote: highlighted?.quote,
      v: 1,
      viewState: {
        audio:
          selection.file.fileType === "audio"
            ? { currentTime: viewState.audio?.currentTime }
            : undefined,
        // An annotation link carries no pan, zoom or scroll: the target tab
        // keeps its own and shows the annotation (see withAnnotationReveal).
        image:
          selection.file.fileType === "image" && annotation
            ? { selectedAnnotationId: annotation.id }
            : selection.file.fileType === "image"
            ? {
                fontSize: viewState.image?.fontSize,
                panX: viewState.image?.panX ?? 0,
                panY: viewState.image?.panY ?? 0,
                selectedAnnotationId: viewState.image?.selectedAnnotationId,
                tool: viewState.image?.tool,
                zoom: viewState.image?.zoom ?? 1,
              }
            : undefined,
        markdown:
          selection.file.fileType === "markdown"
            ? {
                editorScrollLeft: viewState.markdown?.editorScrollLeft ?? 0,
                editorScrollTop: viewState.markdown?.editorScrollTop ?? 0,
                line,
                previewScrollLeft: viewState.markdown?.previewScrollLeft ?? 0,
                previewScrollTop: viewState.markdown?.previewScrollTop ?? 0,
                selectionEnd: highlighted?.range.end ?? viewState.markdown?.selectionEnd,
                selectionStart: highlighted?.range.start ?? viewState.markdown?.selectionStart,
                slideIndex: viewState.markdown?.slideIndex,
                zoom: viewState.markdown?.zoom,
              }
            : undefined,
        pdf:
          selection.file.fileType === "pdf" && annotation
            ? { selectedAnnotationId: annotation.id }
            : selection.file.fileType === "pdf"
            ? {
                fontSize: viewState.pdf?.fontSize,
                scrollLeft: viewState.pdf?.scrollLeft ?? 0,
                scrollTop: viewState.pdf?.scrollTop ?? 0,
                selectedAnnotationId: viewState.pdf?.selectedAnnotationId,
                tool: viewState.pdf?.tool,
                zoom: viewState.pdf?.zoom ?? 1,
              }
            : undefined,
      },
    };
  }

  function insertMarkdownFileLink(
    selection: MarkdownFileLinkSelection,
    range?: MarkdownFileLinkRange,
  ) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const metadata = createMarkdownFileLinkMetadata(selection);
    const destination = createMarkdownFileLinkDestination({
      metadata,
      sourcePath: activeTab.file.path,
      targetPath: selection.file.path,
    });
    const linkedTab = selection.source === "tab"
      ? tabs.find((tab) => tab.id === selection.tabId || tab.file.path === selection.file.path)
      : undefined;
    const annotationLabel = linkedTab
      ? annotationTabHighlight(linkedTab, selection.viewState ?? linkedTab.viewState)?.label
      : undefined;
    const label = ((metadata?.quote && markdownLinkQuoteLabel(metadata.quote.text)) || annotationLabel || selection.file.name)
      .replace(/[\[\]\\]/g, "\\$&");
    const textarea = textareaRef.current;
    const scrollState = getMarkdownTextareaScrollState();
    const draft = textarea?.value ?? getTabDraft(activeTab);
    const start = clampTextOffset(
      range?.start ?? textarea?.selectionStart ?? draft.length,
      draft.length,
    );
    const end = clampTextOffset(
      Math.max(start, range?.end ?? textarea?.selectionEnd ?? draft.length),
      draft.length,
    );
    const destinationCloseIndex = draft.indexOf(")", start);
    const hasLinkShell = start >= 2 && draft.slice(start - 2, start) === "](";
    const replacement =
      hasLinkShell && (destinationCloseIndex < 0 || destinationCloseIndex >= end)
        ? `${destination}${destinationCloseIndex < 0 ? ")" : ""}`
        : `[${label}](${destination})`;
    const nextDraft = `${draft.slice(0, start)}${replacement}${draft.slice(end)}`;
    const nextSelectionStart = hasLinkShell ? start : start + 1;
    const nextSelectionEnd = hasLinkShell
      ? start + destination.length
      : start + 1 + label.length;

    if (
      textarea &&
      replaceTextareaSelectionWithUndo(textarea, {
        ...scrollState,
        nextSelectionEnd,
        nextSelectionStart,
        replacement,
        selectionEnd: end,
        selectionStart: start,
      })
    ) {
      restoreMarkdownTextarea({
        ...scrollState,
        selectionStart: nextSelectionStart,
        selectionEnd: nextSelectionEnd,
      });
      return;
    }

    setActiveDraft(nextDraft, { base: draft });
    restoreMarkdownTextarea({
      ...scrollState,
      selectionStart: nextSelectionStart,
      selectionEnd: nextSelectionEnd,
    });
  }

  function insertMarkdownImageMarkupInTab(
    tabId: string,
    insertion: string,
    selection?: { start: number; end: number },
  ) {
    const targetTab = tabs.find((tab) => tab.id === tabId);

    if (!targetTab || targetTab.file.fileType !== "markdown") {
      return null;
    }

    const textarea = tabId === activeTabId ? textareaRef.current : null;
    const targetDraft = getTabDraft(targetTab);
    const insertionState = createMarkdownImageInsertion(
      targetDraft,
      insertion,
      selection ?? {
        start: textarea?.selectionStart ?? targetDraft.length,
        end: textarea?.selectionEnd ?? targetDraft.length,
      },
    );

    if (!writeSharedDraft(tabId, insertionState.nextDraft, { provenance: PASTE, base: targetDraft })) {
      rememberTabDraft(tabId, insertionState.nextDraft);
      updateTab(tabId, (tab) => ({
        ...tab,
        draft: insertionState.nextDraft,
        status: insertionState.nextDraft === tab.saved ? "clean" : "dirty",
        error: undefined,
      }));
    }

    return insertionState;
  }

  function insertMarkdownImageMarkup(insertion: string) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const insertionState = insertMarkdownImageMarkupInTab(activeTab.id, insertion);

    if (!insertionState) {
      return;
    }

    const scrollState = getMarkdownTextareaScrollState();

    restoreMarkdownTextarea({
      ...scrollState,
      selectionStart: insertionState.nextSelectionStart,
      selectionEnd: insertionState.nextSelectionEnd,
    });
  }

  async function imageMarkdownForTab(tab: OpenTab, file: File) {
    if (tab.untitled) {
      const source = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(tRef.current("readImageError")));
        reader.readAsDataURL(file);
      });
      return { markdown: `![${imageAltText(file.name)}](${source})` };
    }
    const formData = new FormData();
    formData.append("documentPath", tab.file.path);
    formData.append("file", file);
    return apiRequest<{ markdown: string }>("/api/markdown-assets", { method: "POST", body: formData });
  }

  async function insertMarkdownImage(
    file: File,
    selection?: { start: number; end: number },
  ) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const scrollState = getMarkdownTextareaScrollState();

    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await imageMarkdownForTab(activeTab, file);
      const insertionState = insertMarkdownImageMarkupInTab(
        tabId,
        payload.markdown,
        selection,
      );

      if (insertionState && tabId === activeTabId) {
        restoreMarkdownTextarea({
          ...scrollState,
          selectionStart: insertionState.nextSelectionStart,
          selectionEnd: insertionState.nextSelectionEnd,
        });
      }
    } catch (error) {
      updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : tRef.current("insertImageError"),
      }));
    }
  }

  async function insertExistingMarkdownImage(file: LiberaFileNode) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    if (file.fileType !== "image") {
      updateTab(activeTab.id, (tab) => ({
        ...tab,
        status: "error",
        error: tRef.current("onlyImagesError"),
      }));
      return;
    }

    const rawUrl = `/api/files/raw/${encodeFilePath(file.path)}`;
    insertMarkdownImageMarkup(`![${imageAltText(file.name)}](${rawUrl})`);
  }

  function findNearestScreenshotSourceTab(markdownTabId: string) {
    const markdownIndex = tabs.findIndex((tab) => tab.id === markdownTabId);

    if (markdownIndex < 0) {
      return undefined;
    }

    return tabs
      .map((tab, index) => ({ index, tab }))
      .filter(({ tab }) => tab.file.fileType === "image" || tab.file.fileType === "pdf")
      .sort((left, right) => {
        const leftDistance = Math.abs(left.index - markdownIndex);
        const rightDistance = Math.abs(right.index - markdownIndex);

        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }

        return right.index - left.index;
      })[0]?.tab;
  }

  /**
   * Snip from the nearest image or PDF tab. "image" inserts a picture;
   * "markdown" reads the snip with the local PDF reading model. The visual
   * editor passes `editor: "visual"`: it keeps its own selection, so the
   * result is queued for it to insert when it shows again.
   */
  async function startScreenshotSnip(
    mode: MarkdownScreenshotSnipMode = "image",
    editor: "source" | "visual" = "source",
  ) {
    const targetTab = activeTab;

    if (!targetTab || targetTab.file.fileType !== "markdown" || screenshotSnipSession?.converting) {
      return;
    }

    const sourceTab = findNearestScreenshotSourceTab(targetTab.id);

    if (!sourceTab) {
      updateTab(targetTab.id, (tab) => ({
        ...tab,
        status: "error",
        error: tRef.current("openImageOrPdfError"),
      }));
      return;
    }

    const textarea = editor === "source" ? textareaRef.current : null;
    const draft = getTabDraft(targetTab);
    const selectionStart = textarea?.selectionStart ?? draft.length;
    const selectionEnd = textarea?.selectionEnd ?? draft.length;
    const scrollLeft = textarea?.scrollLeft ?? 0;
    const scrollTop = textarea?.scrollTop ?? 0;

    // Set the model up before the user snips, not after.
    if (mode === "markdown" && !(await ensureDocumentOcrModel())) {
      return;
    }

    snipDraftAtStartRef.current = draft;
    setScreenshotSnipSession({
      scrollLeft,
      scrollTop,
      selectionEnd,
      selectionStart,
      sourceTabId: sourceTab.id,
      targetTabId: targetTab.id,
      mode,
      editor,
    });
    setSelectedNotebookName(sourceTab.file.notebook);
    recordFileInteraction(sourceTab.file);
    setActiveTabId(sourceTab.id);
  }

  function returnToSnipTarget(session: MarkdownScreenshotSnipSession, selection?: { start: number; end: number }) {
    const targetTab = tabsRef.current.find((tab) => tab.id === session.targetTabId);

    setScreenshotSnipSession(null);
    snipDraftAtStartRef.current = null;

    if (!targetTab) {
      return;
    }

    setSelectedNotebookName(targetTab.file.notebook);
    recordFileInteraction(targetTab.file);
    setActiveTabId(targetTab.id);

    if (session.editor === "source") {
      restoreMarkdownTextarea({
        scrollLeft: session.scrollLeft,
        scrollTop: session.scrollTop,
        selectionStart: selection?.start ?? session.selectionStart,
        selectionEnd: selection?.end ?? session.selectionEnd,
      });
    }
  }

  function cancelScreenshotSnip() {
    const session = screenshotSnipSession;

    if (!session) {
      return;
    }

    snipAbortRef.current?.abort();
    snipAbortRef.current = null;
    returnToSnipTarget(session);
  }

  function queueVisualInsertion(tabId: string, markdown: string, options?: { inline?: boolean }) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPendingVisualInsertions((current) => ({ ...current, [tabId]: { id, markdown, ...(options?.inline ? { inline: true } : {}) } }));
  }

  function finishVisualInsertion(tabId: string, id: string) {
    setPendingVisualInsertions((current) => {
      if (current[tabId]?.id !== id) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
  }

  /** Insert Markdown where the snip started, or at the end if the note changed meanwhile. */
  function insertSnipMarkdown(session: MarkdownScreenshotSnipSession, markdown: string) {
    if (session.editor === "visual") {
      queueVisualInsertion(session.targetTabId, markdown);
      return undefined;
    }

    const targetTab = tabsRef.current.find((tab) => tab.id === session.targetTabId);
    if (!targetTab) return undefined;

    const draft = getTabDraft(targetTab);
    const unchanged = snipDraftAtStartRef.current === null || snipDraftAtStartRef.current === draft;
    const position = unchanged ? Math.min(session.selectionEnd, draft.length) : draft.length;
    const insertion = insertMarkdownBlock(draft, position, markdown);

    if (!writeSharedDraft(targetTab.id, insertion.value, { provenance: PASTE, base: draft })) {
      rememberTabDraft(targetTab.id, insertion.value);
      updateTab(targetTab.id, (tab) => ({
        ...tab,
        draft: insertion.value,
        status: insertion.value === tab.saved ? "clean" : "dirty",
        error: undefined,
      }));
    }
    return { start: insertion.start, end: insertion.end };
  }

  /**
   * Quote and cite from a PDF (references/pdf-quote-cite.tsx) into the most
   * recently active Markdown tab, as a block after its caret's paragraph, in the source or
   * the visual editor. With no Markdown tab open, the Markdown goes to the
   * clipboard instead.
   */
  function quoteTargetTab() {
    const open = new Map(tabsRef.current.map((tab) => [tab.id, tab]));
    for (const id of [activeTabId, ...activeTabHistoryRef.current]) {
      const tab = id ? open.get(id) : undefined;
      if (tab?.file.fileType === "markdown" && !isGalleryTab(tab)) return tab;
    }
    return undefined;
  }

  function insertQuoteIntoTab(tabId: string, markdown: string) {
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab || tab.file.fileType !== "markdown") return false;
    const visual = (tab.viewState?.markdown?.editorMode ?? "visual") === "visual" && !isMarkdownSlidesPath(tab.file.path);
    if (visual) {
      queueVisualInsertion(tab.id, markdown);
      return true;
    }
    const draft = getTabDraft(tab);
    const caret = tab.id === activeTabId && textareaRef.current ? textareaRef.current.selectionEnd : tab.viewState?.markdown?.selectionEnd ?? draft.length;
    const insertion = quoteBlockInsertion(draft, caret, markdown);
    const written = writeSharedDraft(tab.id, insertion.value, { provenance: PASTE, base: draft });
    if (!written) rememberTabDraft(tab.id, insertion.value);
    updateTab(tab.id, (current) => ({
      ...current,
      ...(written ? {} : { draft: insertion.value, status: insertion.value === current.saved ? "clean" as const : "dirty" as const, error: undefined }),
      viewState: { ...current.viewState, markdown: { ...current.viewState?.markdown, selectionStart: insertion.caret, selectionEnd: insertion.caret } },
    }));
    return true;
  }

  async function quotePdfIntoNote(source: PdfQuoteSource) {
    const target = quoteTargetTab();
    try {
      const resolved = await resolvePdfQuote(source, target && !target.untitled ? target.file.notebook : null);
      if (!resolved) return;
      if (target && insertQuoteIntoTab(target.id, resolved.markdown)) {
        showPdfQuoteNotice(tRef.current("quotedIntoNotice", { name: target.file.name }));
        return;
      }
      await navigator.clipboard.writeText(resolved.markdown);
      showPdfQuoteNotice(tRef.current("noNoteQuoteNotice"));
    } catch (error) {
      showPdfQuoteNotice(error instanceof Error ? error.message : tRef.current("quotePdfError"));
    }
  }
  const quotePdfIntoNoteRef = useRef(quotePdfIntoNote);
  useLayoutEffect(() => {
    quotePdfIntoNoteRef.current = quotePdfIntoNote;
  });
  useEffect(() => {
    function handleQuote(event: Event) {
      const source = parsePdfQuoteSource((event as CustomEvent<PdfQuoteCiteDetail>).detail);
      if (source) void quotePdfIntoNoteRef.current(source);
    }
    window.addEventListener(PDF_QUOTE_CITE_EVENT, handleQuote);
    return () => window.removeEventListener(PDF_QUOTE_CITE_EVENT, handleQuote);
  }, []);

  /** Read a snip with the local model. Runs after the snip layer closes, with a Cancel button meanwhile. */
  async function readSnipAsMarkdown(session: MarkdownScreenshotSnipSession, file: File, mathMarkers?: MathMarkerSettings) {
    const targetTab = tabsRef.current.find((tab) => tab.id === session.targetTabId);
    if (!targetTab) {
      returnToSnipTarget(session);
      return;
    }

    const controller = new AbortController();
    snipAbortRef.current = controller;
    setScreenshotSnipSession({ ...session, converting: { startedAt: Date.now() } });

    try {
      const result = await readImageAsMarkdown(file, { mathMarkers, maxEdge: SNIP_MAX_EDGE, signal: controller.signal });
      let markdown = result.markdown;

      if (result.pictures.length) {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        markdown = await resolvePicturePlaceholders(markdown, result.pictures, canvas, async (image, index) => {
          const payload = await imageMarkdownForTab(
            targetTab,
            new File([image], `${file.name.replace(/\.png$/i, "")}-figure-${index + 1}.png`, { type: "image/png" }),
          );
          return /\]\(([^)\s]+)\)/.exec(payload.markdown)?.[1] ?? "";
        });
      }

      if (controller.signal.aborted) return;
      if (!markdown.trim()) throw new Error(tRef.current("noSnipTextError"));

      const selection = insertSnipMarkdown(session, markdown);
      returnToSnipTarget(session, selection);
    } catch (error) {
      if (controller.signal.aborted) return;
      updateTab(session.targetTabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : tRef.current("readSnipError"),
      }));
      returnToSnipTarget(session);
    } finally {
      if (snipAbortRef.current === controller) snipAbortRef.current = null;
    }
  }

  async function completeScreenshotSnip(file: File, mathMarkers?: MathMarkerSettings) {
    const session = screenshotSnipSession;

    if (!session || session.converting) {
      return;
    }

    const targetTab = tabs.find((tab) => tab.id === session.targetTabId);

    if (!targetTab || targetTab.file.fileType !== "markdown") {
      setScreenshotSnipSession(null);
      return;
    }

    updateTab(targetTab.id, (tab) => ({ ...tab, error: undefined }));

    if (session.mode === "markdown") {
      // Not awaited: the snip layer closes now and a progress card takes over.
      void readSnipAsMarkdown(session, file, mathMarkers);
      return;
    }

    try {
      const payload = await imageMarkdownForTab(targetTab, file);

      if (session.editor === "visual") {
        queueVisualInsertion(targetTab.id, payload.markdown);
        returnToSnipTarget(session);
        return;
      }

      const insertionState = insertMarkdownImageMarkupInTab(
        targetTab.id,
        payload.markdown,
        {
          start: session.selectionStart,
          end: session.selectionEnd,
        },
      );

      returnToSnipTarget(
        session,
        insertionState
          ? { start: insertionState.nextSelectionStart, end: insertionState.nextSelectionEnd }
          : undefined,
      );
    } catch (error) {
      updateTab(targetTab.id, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : tRef.current("insertScreenshotError"),
      }));
      returnToSnipTarget(session);
    }
  }

  async function formatSelectionWithAi(selection: { start: number; end: number }) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const draft = getTabDraft(activeTab);
    const selectedText = draft.slice(selection.start, selection.end);
    const scrollState = getMarkdownTextareaScrollState();

    if (!selectedText.trim()) {
      return;
    }

    const controller = new AbortController();
    const endActivity = beginAiActivity({ action: "format", cancel: () => controller.abort() });
    setAiFormatting(true);
    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ formattedText: string }>("/api/ai-format", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ text: selectedText, ...aiTaskRequestOptions("formatting") }),
      });
      if (controller.signal.aborted) return;
      const nextDraft = `${draft.slice(0, selection.start)}${payload.formattedText}${draft.slice(
        selection.end,
      )}`;
      const suggested = suggestSharedAi(tabId, draft, { start: selection.start, end: selection.end, before: selectedText, after: payload.formattedText }, "format");
      // A suggestion leaves the text as it is, so the selection stays on it.
      const nextSelectionEnd = suggested ? selection.end : selection.start + payload.formattedText.length;

      if (!suggested) {
        rememberTabDraft(tabId, nextDraft);
        updateTab(tabId, (tab) => ({
          ...tab,
          draft: nextDraft,
          status: nextDraft === tab.saved ? "clean" : "dirty",
          error: undefined,
        }));
      }

      restoreMarkdownTextarea({
        ...scrollState,
        selectionStart: selection.start,
        selectionEnd: nextSelectionEnd,
      });
    } catch (error) {
      if (!controller.signal.aborted) updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : tRef.current("aiFormatError"),
      }));
    } finally {
      endActivity();
      setAiFormatting(false);
    }
  }

  async function rewriteSelectionWithAi(
    selection: { start: number; end: number },
    prompt: string,
  ) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const draft = getTabDraft(activeTab);
    const selectedText = draft.slice(selection.start, selection.end);
    const scrollState = getMarkdownTextareaScrollState();

    if (!selectedText.trim() || !prompt.trim()) {
      return;
    }

    const controller = new AbortController();
    const endActivity = beginAiActivity({ action: "rewrite", cancel: () => controller.abort() });
    setAiFormatting(true);
    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const includeDocument = readIncludeDocumentContext();
      const thread = aiEditThreadFor(activeTab.file.path, includeDocument);
      const payload = await apiRequest<{ rewrittenText: string; thread?: AiEditThreadResult }>("/api/ai-rewrite", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          ...aiTaskRequestOptions("rewrite"),
          text: selectedText,
          prompt,
          ...(includeDocument
            ? { before: draft.slice(0, selection.start), after: draft.slice(selection.end) }
            : {}),
          thread,
        }),
      });
      if (controller.signal.aborted) return;
      recordAiEditTurn(activeTab.file.path, includeDocument, thread, payload.thread);
      const nextDraft = `${draft.slice(0, selection.start)}${payload.rewrittenText}${draft.slice(
        selection.end,
      )}`;
      const suggested = suggestSharedAi(tabId, draft, { start: selection.start, end: selection.end, before: selectedText, after: payload.rewrittenText }, "rewrite");
      const nextSelectionEnd = suggested ? selection.end : selection.start + payload.rewrittenText.length;

      if (!suggested) {
        rememberTabDraft(tabId, nextDraft);
        updateTab(tabId, (tab) => ({
          ...tab,
          draft: nextDraft,
          status: nextDraft === tab.saved ? "clean" : "dirty",
          error: undefined,
        }));
      }

      restoreMarkdownTextarea({
        ...scrollState,
        selectionStart: selection.start,
        selectionEnd: nextSelectionEnd,
      });
    } catch (error) {
      if (!controller.signal.aborted) updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : tRef.current("aiRewriteError"),
      }));
    } finally {
      endActivity();
      setAiFormatting(false);
    }
  }

  async function writeWithAiAt(offset: number, prompt: string) {
    if (!activeTab || activeTab.file.fileType !== "markdown" || !prompt.trim()) {
      return;
    }

    const tabId = activeTab.id;
    const draft = getTabDraft(activeTab);
    const position = findMarkdownBlockInsertionOffset(draft, offset);
    const scrollState = getMarkdownTextareaScrollState();

    const controller = new AbortController();
    const endActivity = beginAiActivity({ action: "write", cancel: () => controller.abort() });
    setAiFormatting(true);
    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const includeDocument = readIncludeDocumentContext();
      const thread = aiEditThreadFor(activeTab.file.path, includeDocument);
      const payload = await apiRequest<{ markdown: string; thread?: AiEditThreadResult }>("/api/ai-write", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          ...aiTaskRequestOptions("write"),
          prompt,
          ...(includeDocument ? { before: draft.slice(0, position), after: draft.slice(position) } : {}),
          thread,
        }),
      });
      if (controller.signal.aborted) return;
      recordAiEditTurn(activeTab.file.path, includeDocument, thread, payload.thread);
      const insertion = insertMarkdownBlock(draft, position, payload.markdown);
      const suggested = suggestSharedAi(tabId, draft, {
        start: position,
        end: position,
        before: "",
        after: insertion.value.slice(position, position + insertion.value.length - draft.length),
      }, "write");

      if (!suggested) {
        rememberTabDraft(tabId, insertion.value);
        updateTab(tabId, (tab) => ({
          ...tab,
          draft: insertion.value,
          status: insertion.value === tab.saved ? "clean" : "dirty",
          error: undefined,
        }));
      }

      restoreMarkdownTextarea({
        ...scrollState,
        selectionStart: suggested ? position : insertion.start,
        selectionEnd: suggested ? position : insertion.end,
      });
    } catch (error) {
      if (!controller.signal.aborted) updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : tRef.current("writeWithAiError"),
      }));
    } finally {
      endActivity();
      setAiFormatting(false);
    }
  }

  async function convertImageToMarkdownWithAi(image: MarkdownImageSelection) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const draft = getTabDraft(activeTab);
    const imageMarkdown = draft.slice(image.start, image.end);
    const scrollState = getMarkdownTextareaScrollState();

    if (!imageMarkdown.trim()) {
      return;
    }

    const controller = new AbortController();
    const endActivity = beginAiActivity({ action: "image", cancel: () => controller.abort() });
    setImageMarkdownConverting(true);
    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ markdown: string }>("/api/ai-image-to-markdown", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          documentPath: activeTab.file.path,
          imageSource: image.src,
          alt: image.alt,
        }),
      });
      if (controller.signal.aborted) return;
      const nextDraft = `${draft.slice(0, image.start)}${payload.markdown}${draft.slice(
        image.end,
      )}`;
      const suggested = suggestSharedAi(tabId, draft, { start: image.start, end: image.end, before: imageMarkdown, after: payload.markdown }, "image-to-markdown");
      const nextSelectionEnd = suggested ? image.end : image.start + payload.markdown.length;

      if (!suggested) {
        rememberTabDraft(tabId, nextDraft);
        updateTab(tabId, (tab) => ({
          ...tab,
          draft: nextDraft,
          status: nextDraft === tab.saved ? "clean" : "dirty",
          error: undefined,
        }));
      }

      // A pending suggestion still shows the image (and Reject keeps it), so
      // its asset stays.
      if (!suggested) void apiRequest<{ deleted: boolean }>("/api/markdown-assets", {
        method: "DELETE",
        body: JSON.stringify({
          documentPath: activeTab.file.path,
          imageSource: image.src,
          nextMarkdown: nextDraft,
        }),
      })
        .then((cleanup) => {
          if (cleanup.deleted) {
            void refreshTree(activeTab.file.notebook);
          }
        })
        .catch(() => undefined);

      restoreMarkdownTextarea({
        ...scrollState,
        selectionStart: image.start,
        selectionEnd: nextSelectionEnd,
      });
    } catch (error) {
      if (!controller.signal.aborted) updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : tRef.current("aiImageError"),
      }));
    } finally {
      endActivity();
      setImageMarkdownConverting(false);
    }
  }

  function recoverReviewDraft(key: string, content: string) {
    if (!key.startsWith("draft:")) return;
    const id = key.slice(6);
    if (tabs.some((tab) => tab.id === id)) { setActiveTabId(id); return; }
    createUntitledFile("", undefined, { fileName: RECOVERED_REVIEW_NAME, content }, id);
  }

  function createUntitledFile(notebook = "", parentPath?: string, initial?: { fileName: string; content: string }, restoredId?: string) {
    const id = restoredId ?? `untitled-${crypto.randomUUID()}.md`;
    const now = new Date().toISOString();
    const tab: OpenTab = {
      id, untitled: true, saveDirectory: parentPath || notebook,
      file: { kind: "file", name: initial?.fileName ?? `${DEFAULT_UNTITLED_NAME}.md`, path: id, notebook: "",
        fileType: "markdown", createdAt: now, updatedAt: now, size: 0 },
      draft: initial?.content ?? "", saved: "", status: initial?.content ? "dirty" : "clean",
    };
    rememberTabDraft(id, tab.draft);
    setTabs((current) => [...current, tab]);
    setActiveTabId(id);
    setWorkspaceError("");
  }

  function closeSaveDraftDialog() {
    if (!savingDraftRef.current) setSaveDraftTabId(null);
  }

  /** A new, empty Markdown file next to a PDF or recording, named after it ("Paper.md", then "Paper (2).md", …). */
  async function createMarkdownBesidePdf(pdfPath: string): Promise<LiberaFileNode> {
    const parts = pdfPath.split("/");
    const directory = parts.slice(0, -1).join("/");
    const stem = (parts.at(-1) ?? "Document").replace(/\.[^./]+$/, "") || "Document";

    for (let copy = 1; copy <= 50; copy += 1) {
      const name = copy === 1 ? `${stem}.md` : `${stem} (${copy}).md`;
      try {
        const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
          method: "POST",
          body: JSON.stringify({ notebook: directory.split("/")[0], parentPath: directory, name, content: "" }),
        }, (result) => ({ paths: [result.file.path] }));
        await refreshTree(payload.file.notebook);
        return payload.file;
      } catch (error) {
        if (!(error instanceof Error && /already exists/i.test(error.message))) throw error;
      }
    }

    throw new Error(tRef.current("freeNameError", { stem }));
  }

  /** Save converted Markdown into a file that is not open for editing. */
  async function writeConvertedMarkdown(path: string, content: string) {
    await workspaceFileRequest<LiberaFilePayload>("/api/files", {
      method: "PATCH",
      body: JSON.stringify({ path, content }),
    }, () => ({ paths: [path] }));
  }

  async function saveChatToNotebook({ directory, fileName, content }: ChatNotebookExport) {
    const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
      method: "POST",
      body: JSON.stringify({ notebook: directory.split("/")[0], parentPath: directory, name: fileName, content }),
    }, (result) => ({ paths: [result.file.path] }));
    await refreshTree(payload.file.notebook);
  }

  async function submitSaveDraft(name: string, directory: string) {
    const tab = tabs.find((item) => item.id === saveDraftTabId);
    if (!tab || savingDraftRef.current) return;
    const requestedName = name.trim();
    if (!requestedName || /[\\/]/.test(requestedName) || requestedName === "." || requestedName === "..") {
      setSaveDraftError(tRef.current("enterFileNameError"));
      return;
    }
    const fileName = /\.(md|markdown)$/i.test(requestedName) ? requestedName : `${requestedName}.md`;
    savingDraftRef.current = true;
    setSaveDraftSubmitting(true);
    setSaveDraftError("");
    const draft = getTabDraft(tab);
    try {
      if (!directory) {
        const exporter = window.liberaExport?.saveMarkdownFile;
        let savedFileName = fileName;
        let standaloneSaveId: string | undefined;
        if (exporter) {
          const result = await exporter({ content: draft, fileName });
          standaloneSaveId = result.saveId;
          savedFileName = result.fileName ?? fileName;
          if (result.canceled) return;
        } else {
          downloadFile({ ...tab.file, name: fileName }, draft);
        }
        const latestDraft = getTabDraft(tab);
        updateTab(tab.id, (current) => ({ ...current,
          standaloneSaveId, file: { ...current.file, name: savedFileName }, saved: draft,
          status: latestDraft === draft ? "clean" : "dirty" }));
      } else {
        const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
          method: "POST",
          body: JSON.stringify({ notebook: directory.split("/")[0], parentPath: directory, name: fileName, content: draft }),
        }, (payload) => ({ paths: [payload.file.path] }));
        const latestDraft = getTabDraft(tab);
        await apiRequest("/api/markdown-reviews", { method: "POST", body: JSON.stringify({ action: "migrate-path", from: tab.standaloneSaveId ? `standalone:${tab.standaloneSaveId}` : `draft:${tab.id}`, to: payload.file.path, snapshot: latestDraft }) });
        rememberTabDraft(payload.file.path, latestDraft);
        updateTab(tab.id, (current) => ({ ...current, id: payload.file.path,
          file: payload.file, untitled: false, standaloneSaveId: undefined, draft: latestDraft, saved: draft,
          status: latestDraft === draft ? "clean" : "dirty", error: undefined }));
        forgetTabDraft(tab.id);
        setActiveTabId((current) => current === tab.id ? payload.file.path : current);
        setSelectedNotebookName(payload.file.notebook);
        await refreshTree(payload.file.notebook);
        updateExpanded((current) => new Set(current).add(payload.file.notebook).add(directory));
      }
      setSaveDraftTabId(null);
    } catch (error) {
      setSaveDraftError(error instanceof Error ? error.message : tRef.current("saveFailedError"));
    } finally {
      savingDraftRef.current = false;
      setSaveDraftSubmitting(false);
    }
  }

  /** Writes a tab's unsaved ink and annotations (pending-saves.ts); reports a failure on the tab. */
  async function savePendingFor(tab: OpenTab) {
    try {
      await pendingSaves.save(tab.file.path);
    } catch (error) {
      updateTab(tab.id, (current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : tRef.current("saveFailedError") }));
    }
  }

  async function saveActiveTab() {
    if (!activeTab) {
      return;
    }

    // PDFs, images and the like: their annotations and ink are all there is to save.
    if (!isTextFileType(activeTab.file.fileType)) {
      await savePendingFor(activeTab);
      // A live PDF answers this, by its path: it has no shared tab.
      sharedRegistry.revealStatus(activeTab.file.path);
      return;
    }

    // Shared tabs have no Save for their text: every edit is already on this
    // device. Their ink blocks still save. Show the status pill's detail (map §6).
    if (isSharedTab(activeTab.id)) {
      await savePendingFor(activeTab);
      sharedRegistry.revealStatus(activeTab.id);
      return;
    }

    if (activeTab.standaloneSaveId && window.liberaExport?.saveMarkdownFile) {
      if (savingDraftRef.current) return;
      savingDraftRef.current = true;
      const draft = getTabDraft(activeTab);
      updateTab(activeTab.id, (tab) => ({ ...tab, status: "saving", error: undefined }));
      try {
        const result = await window.liberaExport.saveMarkdownFile({ content: draft, fileName: activeTab.file.name, saveId: activeTab.standaloneSaveId });
        const latestDraft = getTabDraft(activeTab);
        updateTab(activeTab.id, (tab) => ({ ...tab,
          saved: result.canceled ? tab.saved : draft,
          status: latestDraft === (result.canceled ? tab.saved : draft) ? "clean" : "dirty" }));
      } catch (error) {
        updateTab(activeTab.id, (tab) => ({ ...tab, status: "error", error: error instanceof Error ? error.message : tRef.current("saveFailedError") }));
      } finally { savingDraftRef.current = false; }
      return;
    }

    if (activeTab.untitled) {
      setSaveDraftError("");
      setSaveDraftTabId(activeTab.id);
      return;
    }

    const outcome = await saveTabText(activeTab.id);
    if (outcome === "ask") {
      // The disk has other text than this tab opened: replacing it is the person's decision.
      setWorkspaceConfirmDialog({ mode: "replace-disk-version", tabId: activeTab.id, fileName: activeTab.file.name });
      return;
    }
    if (outcome === "conflict" || outcome === "failed") return;
    // The text is saved (or was); a note's ink blocks and their renderings go with it.
    await savePendingFor(activeTab);
    if (outcome === "saved") await refreshTree(activeTab.file.notebook);
  }

  /**
   * Writes a text tab with the version of the text it last loaded or saved: the
   * server refuses (409) to replace a file that is another version or is gone.
   * The draft stays in the editor. A conflict keeps the tab's own baseline and
   * records what is on disk (`diskConflict`); the next Save then returns "ask"
   * until the person decides (`replaceDisk`), and writes against that disk text only then.
   * Saves of one file run one after another, each looking at the tab again, so a
   * Save all that finds one running waits for it instead of racing it.
   */
  function saveTabText(tabId: string, options: { replaceDisk?: boolean } = {}): Promise<"saved" | "unchanged" | "ask" | "conflict" | "failed"> {
    return saveQueueRef.current.run(tabId, async () => {
      const tab = tabsRef.current.find((item) => item.id === tabId && !item.untitled);
      if (!tab) return "unchanged";
      const draft = getTabDraft(tab);
      if (draft === tab.saved && tab.status !== "error") return "unchanged";
      const basis = saveBase(tab, !!options.replaceDisk);
      if ("ask" in basis) return "ask";
      const patch = (change: (current: OpenTab) => OpenTab) => changeTabsNow((all) => all.map((item) => item.id === tabId ? change(item) : item));
      patch((current) => ({ ...current, status: "saving", error: undefined }));
      try {
        const baseVersion = await textVersion(basis.base);
        const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
          method: "PATCH",
          body: JSON.stringify({ path: tab.file.path, content: draft, baseVersion }),
        }, (payload) => ({ paths: [payload.file.path] }));
        const latestDraft = getTabDraft(tab);
        patch((current) => ({ ...current, file: payload.file, saved: draft, diskConflict: undefined, status: latestDraft === draft ? "clean" : "dirty" }));
        return "saved";
      } catch (error) {
        if ((error as { status?: number }).status === 409) {
          const onDisk = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(tab.file.path)}`).then(
            (payload) => ({ text: payload.content ?? "" }),
            (readError: { status?: number }) => (readError.status === 404 ? { text: null } : undefined),
          );
          if (onDisk) {
            // Not adopted as the baseline: the tab still describes the text it opened, until the person decides.
            patch((current) => ({
              ...current,
              status: "error",
              diskConflict: { text: onDisk.text },
              error: tRef.current(onDisk.text === null ? "fileGoneOnDiskError" : "fileChangedOnDiskError"),
            }));
            return "conflict";
          }
        }
        patch((current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : tRef.current("saveFailedError") }));
        return "failed";
      }
    });
  }

  function openCreateNotebookDialog() {
    setNotebookDialog({ mode: "create" });
  }

  function openCreateNotebookGroupDialog() {
    setNotebookGroupDialog({ mode: "create" });
  }

  function openEditNotebookDialog(notebook: LiberaTree["notebooks"][number]) {
    setNotebookDialog({ mode: "edit", notebook });
  }

  function openEditNotebookGroupDialog(group: LiberaNotebookGroup) {
    setNotebookGroupDialog({ mode: "edit", group });
  }

  function closeNotebookDialog() {
    setNotebookDialog(null);
  }

  function closeNotebookGroupDialog() {
    setNotebookGroupDialog(null);
  }

  function closeNoteDialog() {
    setNoteDialog(null);
  }

  function closeWorkspaceInputDialog() {
    setWorkspaceInputDialog(null);
  }

  function closeWorkspaceConfirmDialog() {
    setWorkspaceConfirmDialog(null);
  }

  function setNotebookDialogError(error: string) {
    setNotebookDialog((current) => (current ? { ...current, error } : current));
  }

  function setNotebookGroupDialogError(error: string) {
    setNotebookGroupDialog((current) => (current ? { ...current, error } : current));
  }

  function setNoteDialogError(error: string) {
    setNoteDialog((current) => (current ? { ...current, error } : current));
  }

  function setWorkspaceInputDialogError(error: string) {
    setWorkspaceInputDialog((current) => (current ? { ...current, error } : current));
  }

  /** Copies an illustration into a notebook as its cover; null goes back to a random one. */
  async function changeNotebookIllustration(notebook: string, illustration: string | null) {
    const nextTree = await apiRequest<LiberaTree>("/api/notebooks/illustration", {
      method: "PUT",
      body: JSON.stringify({ notebook, illustration }),
    });
    await applyCompleteTree(nextTree);
  }

  async function submitNotebookDialog(values: NotebookFormValues) {
    if (!notebookDialog) {
      return;
    }

    const nextName = values.name.trim();

    if (!nextName) {
      setNotebookDialogError(tRef.current("notebookNameRequired"));
      return;
    }

    setNotebookDialogSubmitting(true);
    const workspaceActive = Boolean(workspaceManager.activeWorkspace);
    // Workspace group assignments live in the workspace snapshot, not notebook metadata.
    const notebookValues = workspaceActive ? { ...values, groupId: undefined } : values;
    const notebookGroup = workspaceActive ? { notebook: nextName, groupId: values.groupId || null } : undefined;

    try {
      if (notebookDialog.mode === "create") {
        const nextTree = await workspaceFileRequest<LiberaTree>("/api/notebooks", {
          method: "POST",
          body: JSON.stringify(notebookValues),
        }, () => ({ paths: [nextName], notebookGroup }));
        await applyCompleteTree(nextTree);
        setSelectedNotebookName(nextName);
        setActiveTabId("");
        updateExpanded((current) => new Set(current).add(nextName));
      } else {
        const previousName = notebookDialog.notebook.name;
        const nextTree = await workspaceFileRequest<LiberaTree>("/api/notebooks", {
          method: "PATCH",
          body: JSON.stringify({
            path: previousName,
            ...notebookValues,
          }),
        }, () => ({ moved: { from: previousName, to: nextName }, notebookGroup }));
        pendingSaves.moveUnsaved(previousName, nextName, { prefix: true });
        await applyCompleteTree(nextTree);
        // The File menu lists linked folders by name.
        if (notebookDialog.notebook.folder && previousName !== nextName) {
          void window.liberaDirectory?.notifyChanged().catch(() => undefined);
        }
        updateExpanded((current) => {
          const next = new Set<string>();

          for (const expandedPath of current) {
            if (expandedPath === previousName) {
              next.add(nextName);
            } else if (expandedPath.startsWith(`${previousName}/`)) {
              next.add(`${nextName}/${expandedPath.slice(previousName.length + 1)}`);
            } else {
              next.add(expandedPath);
            }
          }

          next.add(nextName);
          return next;
        });
        setSelectedNotebookName((current) =>
          current === previousName ? nextName : current,
        );
        tabs.forEach((tab) => {
          if (tab.file.notebook !== previousName) {
            return;
          }

          const suffix = tab.file.path.slice(previousName.length + 1);
          const nextPath = `${nextName}/${suffix}`;
          const draft = getTabDraft(tab);

          forgetTabDraft(tab.id);
          rememberTabDraft(nextPath, draft);
        });
        setTabs((currentTabs) =>
          currentTabs.map((tab) => {
            if (tab.file.notebook !== previousName) {
              return tab;
            }

            const suffix = tab.file.path.slice(previousName.length + 1);
            const nextPath = `${nextName}/${suffix}`;

            return {
              ...tab,
              id: nextPath,
              draft: latestDraftByTabIdRef.current[nextPath] ?? tab.draft,
              file: {
                ...tab.file,
                notebook: nextName,
                path: nextPath,
              },
              rawUrl: `/api/files/raw/${encodeFilePath(nextPath)}`,
            };
          }),
        );
        setActiveTabId((current) =>
          current.startsWith(`${previousName}/`)
            ? `${nextName}/${current.slice(previousName.length + 1)}`
            : current,
        );
      }

      setNotebookDialog(null);
    } catch (error) {
      setNotebookDialogError(
        error instanceof Error ? error.message : tRef.current("notebookSaveError"),
      );
    } finally {
      setNotebookDialogSubmitting(false);
    }
  }

  async function submitNotebookGroupDialog(values: NotebookGroupFormValues) {
    if (!notebookGroupDialog) {
      return;
    }

    const title = values.title.trim();

    if (!title) {
      setNotebookGroupDialogError(tRef.current("groupTitleRequired"));
      return;
    }

    setNotebookGroupDialogSubmitting(true);

    try {
      if (workspaceManager.activeWorkspace) {
        const now = new Date().toISOString();
        const group = notebookGroupDialog.mode === "edit" ? notebookGroupDialog.group : { id: crypto.randomUUID(), createdAt: now };
        await workspaceManager.updateView((view) => saveWorkspaceGroup(view, { ...group, title, description: values.description.trim(), updatedAt: now }, values.notebookNames));
      } else {
        const nextTree = await apiRequest<LiberaTree>("/api/notebook-groups", {
          method: notebookGroupDialog.mode === "create" ? "POST" : "PATCH",
          body: JSON.stringify({
            id:
              notebookGroupDialog.mode === "edit"
                ? notebookGroupDialog.group.id
                : undefined,
            title,
            description: values.description,
            notebookNames: values.notebookNames,
          }),
        });

        await applyCompleteTree(nextTree);
      }
      setNotebookGroupDialog(null);
      updateExpanded((current) => {
        const next = new Set(current);
        values.notebookNames.forEach((notebookName) => next.add(notebookName));
        return next;
      });
    } catch (error) {
      setNotebookGroupDialogError(
        error instanceof Error ? error.message : tRef.current("groupSaveError"),
      );
    } finally {
      setNotebookGroupDialogSubmitting(false);
    }
  }

  async function deleteNotebookGroup(group: LiberaNotebookGroup) {
    setWorkspaceError("");

    try {
      if (workspaceManager.activeWorkspace) {
        await workspaceManager.updateView((view) => removeWorkspaceGroup(view, group.id));
        return;
      }
      const nextTree = await apiRequest<LiberaTree>(
        `/api/notebook-groups?id=${encodeURIComponent(group.id)}`,
        { method: "DELETE" },
      );
      await applyCompleteTree(nextTree);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("deleteGroupError"));
    }
  }

  async function updateNotebookViewOptions(
    viewOptions: LiberaNotebookViewOptions,
  ) {
    if (workspaceManager.activeWorkspace) {
      await workspaceManager.updateView((view) => ({ ...view, notebookViewOptions: viewOptions }));
      return;
    }
    const nextTree = await apiRequest<LiberaTree>("/api/notebook-view-options", {
      method: "PATCH",
      body: JSON.stringify(viewOptions),
    });

    await applyCompleteTree(nextTree);
  }

  async function toggleFileStar(file: LiberaFileNode, starred: boolean) {
    setWorkspaceError("");

    try {
      if (workspaceManager.activeWorkspace) {
        await workspaceManager.updateView((view) =>
          toggleWorkspaceStar(view, workspaceManager.organizedTree.starredFilePaths, file.path, starred),
        );
        return;
      }

      const nextTree = await apiRequest<LiberaTree>("/api/starred-files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          starred,
        }),
      });

      await applyCompleteTree(nextTree);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("updateStarError"));
    }
  }

  function openFileTagsDialog(file: LiberaFileNode) {
    setFileTagsDialogError("");
    setFileTagsDialogFile(file);
  }

  function closeFileTagsDialog() {
    if (!fileTagsDialogSubmitting) setFileTagsDialogFile(null);
  }

  async function saveFileTags(tags: string[]) {
    if (!fileTagsDialogFile) return;
    setFileTagsDialogSubmitting(true);
    setFileTagsDialogError("");

    try {
      const nextTree = await apiRequest<LiberaTree>("/api/file-tags", {
        method: "PATCH",
        body: JSON.stringify({ path: fileTagsDialogFile.path, tags }),
      });

      await applyCompleteTree(nextTree);
      setFileTagsDialogFile(null);
    } catch (error) {
      setFileTagsDialogError(error instanceof Error ? error.message : tRef.current("saveTagsError"));
    } finally {
      setFileTagsDialogSubmitting(false);
    }
  }

  async function deleteNotebookFromPrompt(notebook: string) {
    setWorkspaceConfirmDialog({ mode: "delete-notebook", notebook, unsavedNames: unsavedNamesUnder(tabs, notebook, tabUnsaved) });
  }

  async function deleteNotebook(notebook: string) {
    try {
      const nextTree = await workspaceFileRequest<LiberaTree>(
        `/api/notebooks?path=${encodeURIComponent(notebook)}`,
        { method: "DELETE" },
        () => ({ removed: [notebook] }),
      );
      await applyCompleteTree(nextTree);
      setSelectedNotebookName((current) =>
        current === notebook ? nextTree.notebooks[0]?.name ?? "" : current,
      );
      updateExpanded((current) =>
        new Set(
          [...current].filter(
            (expandedPath) =>
              expandedPath !== notebook && !expandedPath.startsWith(`${notebook}/`),
          ),
        ),
      );
      tabs.forEach((tab) => {
        if (tab.file.notebook === notebook) {
          forgetTabDraft(tab.id);
        }
      });
      setTabs((currentTabs) =>
        currentTabs.filter((tab) => tab.file.notebook !== notebook),
      );
      setActiveTabId((current) => (current.startsWith(`${notebook}/`) ? "" : current));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("deleteNotebookError"));
    }
  }

  function downloadNotebook(notebook: string) {
    const link = document.createElement("a");
    link.href = `/api/notebooks/download?path=${encodeURIComponent(notebook)}`;
    link.download = `${notebook}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
  }

  function downloadFile(file: LiberaFileNode, content?: string) {
    const link = document.createElement("a");
    const hasDraftContent = typeof content === "string";

    if (hasDraftContent) {
      const blob = new Blob([content], { type: file.fileType === "latex" ? "text/x-tex;charset=utf-8" : file.fileType === "text" ? "text/plain;charset=utf-8" : "text/markdown;charset=utf-8" });
      link.href = URL.createObjectURL(blob);
      window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
    } else {
      const galleryTab = tabs.find((tab) => isGalleryTab(tab) && tab.file.path === file.path);
      link.href = galleryTab?.rawUrl ?? `/api/files/raw/${encodeFilePath(file.path)}`;
    }

    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function downloadMarkdownPdf(tab: OpenTab) {
    setWorkspaceError("");

    if (tab.file.fileType !== "markdown") {
      return;
    }

    const exporter = window.liberaExport?.exportMarkdownPdf;

    if (!exporter) {
      setWorkspaceError(tRef.current("pdfExportUnavailable"));
      return;
    }

    try {
      await exporter({
        content: getTabDraft(tab),
        documentPath: tab.file.path,
        fileName: markdownPdfFileName(tab.file.name),
        kind: isMarkdownSlidesPath(tab.file.path) ? "slides" : "document",
        title: markdownExportBaseName(tab.file.name),
      });
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("pdfExportFailed"));
    }
  }

  /** Saves a copy of a PDF with its annotations drawn into the pages. */
  async function downloadAnnotatedPdf(tab: OpenTab, mathMarkers?: MathMarkerSettings) {
    setWorkspaceError("");

    if (tab.file.fileType !== "pdf") {
      return;
    }

    try {
      const source = tab.rawUrl ?? `/api/files/raw/${encodeFilePath(tab.file.path)}`;
      const [bytes, annotations, { burnPdfAnnotations }, { createPdfNoteRenderer }] = await Promise.all([
        fetch(source).then(async (response) => {
          if (!response.ok) {
            throw new Error(tRef.current("readPdfError"));
          }

          return response.arrayBuffer();
        }),
        latestPdfAnnotations(tab.file.path) ??
          apiRequest<PdfAnnotationsPayload>(`/api/pdf-annotations?path=${encodeURIComponent(tab.file.path)}`)
            .then((payload) => payload.annotations),
        // The PDF writer is only needed here, so it loads on first use.
        import("@/lib/pdf-annotation-export"),
        import("@/components/libera/pdf-note-raster"),
      ]);
      const burned = await burnPdfAnnotations(bytes, annotations, {
        renderNote: createPdfNoteRenderer(mathMarkers),
      });
      const link = document.createElement("a");

      link.href = URL.createObjectURL(new Blob([burned as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
      link.download = annotatedPdfFileName(tab.file.name);
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      if (annotations.some((annotation) => annotation.type === "space")) {
        // Until export can make pages taller (docs/create-space-plan.md, phase 2).
        setWorkspaceError(tRef.current("pdfWithoutSpacesNotice"));
      }
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("exportAnnotatedPdfError"));
    }
  }

  async function createMarkdownFromPrompt(notebook: string, parentPath?: string) {
    createUntitledFile(notebook, parentPath);
  }

  async function createMarkdownSlidesFromPrompt(notebook: string) {
    setWorkspaceError("");
    setSelectedNotebookName(notebook);
    setNoteDialog({ mode: "slides", notebook });
  }

  async function createLatexFromPrompt(notebook: string, parentPath?: string) {
    setWorkspaceError("");
    setSelectedNotebookName(notebook);
    setNoteDialog({ mode: "latex", notebook, parentPath });
  }

  async function createTextFileFromPrompt(notebook: string, parentPath?: string) {
    setWorkspaceError("");
    setSelectedNotebookName(notebook);
    setNoteDialog({ mode: "text", notebook, parentPath });
  }

  async function submitNoteDialog(values: NoteFormValues) {
    if (!noteDialog) {
      return;
    }

    const requestedName = values.name.trim();

    if (!requestedName) {
      setNoteDialogError(tRef.current("noteNameRequired"));
      return;
    }

    const name =
      noteDialog.mode === "slides"
        ? ensureMarkdownSlidesName(requestedName)
        : noteDialog.mode === "latex" && !/\.(tex|bib|sty|cls)$/i.test(requestedName)
          ? `${requestedName.replace(/\.$/, "")}.tex`
          // A text file keeps the extension it was given; a bare name (other than Makefile, LICENSE…) becomes .txt.
          : noteDialog.mode === "text" && !/\.[^.]+$/.test(requestedName) && !TEXT_FILE_NAMES.has(requestedName.toLowerCase())
            ? `${requestedName.replace(/\.$/, "")}.txt`
            : requestedName;

    setNoteDialogSubmitting(true);

    try {
      const parentPath = noteDialog.parentPath;
      const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
        method: "POST",
        body: JSON.stringify({
          notebook: noteDialog.notebook,
          parentPath,
          name,
          content:
            noteDialog.mode === "slides"
              ? createMarkdownSlidesContent(name)
              : noteDialog.mode === "latex"
                ? /\.tex$/i.test(name) ? latexDocumentTemplate(name.replace(/\.tex$/i, "")) : ""
                : noteDialog.mode === "text"
                  ? ""
                  : createMarkdownNoteContent(name),
        }),
      }, (payload) => ({ paths: [payload.file.path] }));
      await refreshTree(noteDialog.notebook);
      if (parentPath) {
        updateExpanded((current) => new Set(current).add(parentPath));
      }
      setNoteDialog(null);
      await openFile(payload.file);
    } catch (error) {
      setNoteDialogError(error instanceof Error ? error.message : tRef.current("createNoteError"));
    } finally {
      setNoteDialogSubmitting(false);
    }
  }

  async function createFolderFromPrompt(parentPath: string) {
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "create-folder", parentPath });
  }

  async function createFolder(parentPath: string, name: string) {
    try {
      const nextTree = await workspaceFileRequest<LiberaTree>("/api/folders", {
        method: "POST",
        body: JSON.stringify({
          parentPath,
          name,
        }),
      }, () => ({ paths: [`${parentPath}/${name.trim()}`] }));
      await applyCompleteTree(nextTree);
      updateExpanded((current) => {
        const next = new Set(current);
        next.add(parentPath.split("/")[0] ?? parentPath);
        next.add(parentPath);
        return next;
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : tRef.current("createFolderError"));
    }
  }

  async function copyFileFromPrompt(file: LiberaFileNode) {
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "copy-file", file });
  }

  async function copyFile(
    file: LiberaFileNode,
    destinationDirectory: string,
    destinationName: string,
  ) {
    try {
      const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          destinationDirectory,
          destinationName,
          copy: true,
        }),
      }, (payload) => ({ paths: [payload.file.path] }));
      await refreshTree(payload.file.notebook);
      updateExpanded((current) => {
        const next = new Set(current);
        next.add(destinationDirectory.split("/")[0] ?? destinationDirectory);
        next.add(destinationDirectory);
        return next;
      });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : tRef.current("copyFileError"));
    }
  }

  async function renameFileFromPrompt(tab: OpenTab) {
    if (tab.untitled) { setSaveDraftError(""); setSaveDraftTabId(tab.id); return; }
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "rename-file", file: tab.file });
  }

  async function renameFileNodeFromPrompt(file: LiberaFileNode) {
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "rename-file", file });
  }

  async function moveFileFromPrompt(tab: OpenTab) {
    if (tab.untitled) { setSaveDraftError(""); setSaveDraftTabId(tab.id); return; }
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "move-file", file: tab.file });
  }

  /**
   * Points the open tab of `fromPath` (if any) at the file now at `payload`.
   * A move into another notebook may have renamed citation keys; the tab's
   * saved copy and draft follow (movedTabText).
   */
  function retargetOpenTab(fromPath: string, payload: LiberaFilePayload | LiberaFileMovePayload) {
    retargetOpenTabs([{ from: fromPath, payload }]);
  }

  /**
   * Retargets the tabs of several files that moved together (one host event).
   * Each tab is matched on its path as it was before any move, so a swap swaps
   * and two files never end up under one name; unsaved ink and annotations
   * follow the same pairs. Tabs, drafts and unsaved state all come from one
   * snapshot of the current tabs (tabsRef, kept ahead of the render by changeTabsNow).
   * A destination that is already open in another tab is resolved first
   * (tab-retarget.ts planRetargets): the tabs merge when no work is lost, and otherwise
   * the moved file's tab stays on its old path with its draft, marked, for the person to sort out.
   */
  function retargetOpenTabs(items: { from: string; payload: LiberaFilePayload | LiberaFileMovePayload }[]) {
    const snapshot = tabsRef.current;
    const isFileTab = (tab: OpenTab) => !isGalleryTab(tab) && !isRecordingTab(tab) && !isPageTab(tab) && !tab.untitled;
    const drafts = new Map(snapshot.map((tab) => [tab.file.path, getTabDraft(tab)]));
    const decisions = planRetargets(
      snapshot.map((tab) => ({ path: tab.file.path, draft: drafts.get(tab.file.path)!, saved: tab.saved, status: tab.status, inkDirty: pendingSaves.isDirty(tab.file.path), file: isFileTab(tab) })),
      items.map(({ from, payload }) => ({ from, to: payload.file.path, inkCollision: pendingSaves.collides(from, payload.file.path) })),
    );
    const decided = new Map(decisions.map((decision) => [decision.from, decision]));
    // Moves whose file has no open tab still carry their unsaved state along.
    const byFrom = new Map(items.filter((item) => decided.get(item.from)?.kind !== "keep").map((item) => [item.from, item.payload]));
    const merged = new Set(decisions.filter((decision) => decision.kind === "merge").map((decision) => decision.from));
    const kept = new Map(decisions.flatMap((decision) => decision.kind === "keep" ? [[decision.from, decision.to] as const] : []));
    pendingSaves.moveUnsavedMany(items.filter((item) => byFrom.has(item.from)).map(({ from, payload }) => ({ from, to: payload.file.path, sources: "imageSources" in payload ? payload.imageSources : undefined })));
    const texts = new Map<string, NonNullable<ReturnType<typeof movedTabText>>>();
    const nextDrafts = new Map<string, string>();
    for (const openTab of snapshot) {
      const payload = byFrom.get(openTab.file.path);
      if (!payload || merged.has(openTab.file.path)) continue;
      const draft = drafts.get(openTab.file.path)!;
      const moved = movedTabText(openTab, draft, payload);
      if (moved) texts.set(openTab.file.path, moved);
      nextDrafts.set(payload.file.path, moved?.draft ?? draft);
    }
    // Forget every old draft before remembering any new one: a swap reuses the names.
    for (const openTab of snapshot) if (byFrom.has(openTab.file.path)) forgetTabDraft(openTab.id);
    for (const [nextId, draft] of nextDrafts) rememberTabDraft(nextId, draft);
    const keptError = (to: string) => tRef.current("fileMovedOntoOpenTabError", { path: to });
    const apply = (currentTabs: OpenTab[]) =>
      currentTabs.flatMap((currentTab) => {
        const from = currentTab.file.path;
        if (merged.has(from)) return [];
        const keptTo = kept.get(from);
        if (keptTo !== undefined) return [{ ...currentTab, status: "error" as const, error: keptError(keptTo) }];
        const payload = byFrom.get(from);
        if (!payload) return [currentTab];
        const nextId = payload.file.path;
        const moved = texts.get(from);
        return [{
          ...currentTab,
          id: nextId,
          draft: moved?.draft ?? latestDraftByTabIdRef.current[nextId] ?? currentTab.draft,
          file: payload.file,
          rawUrl: payload.rawUrl ?? `/api/files/raw/${encodeFilePath(nextId)}`,
          ...(moved ? {
            saved: moved.saved,
            diskConflict: moved.conflict === null ? undefined : { text: moved.conflict },
            status: moved.conflict !== null ? "error" as const : moved.draft === moved.saved ? "clean" as const : "dirty" as const,
            error: moved.conflict !== null ? tRef.current("fileChangedOnDiskError") : undefined,
          } : {}),
        }];
      });
    changeTabsNow(apply);
    setActiveTabId((current) => {
      const decision = decided.get(current);
      return decision?.kind === "merge" ? decision.to : byFrom.get(current)?.file.path ?? current;
    });
    setClosedViewStates((current) => remapClosedViewStates(current, (path) => byFrom.get(path)?.file.path ?? path));
  }

  // Shared working-copy writes can change links without changing the file layout.
  // Refresh for both host event types, and follow open tabs whose file moved.
  const latestTreeChange = useRef({ refreshNotebooks, refreshFiles, retargetOpenTabs });
  useLayoutEffect(() => {
    latestTreeChange.current = { refreshNotebooks, refreshFiles, retargetOpenTabs };
  });
  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    // Moves run strictly in the order they happened, each after the previous fetch settled.
    let movesDone: Promise<void> = Promise.resolve();
    // Tabs follow their files first, but a move lookup that hangs must not freeze the file list.
    const afterMoves = async () => {
      await Promise.race([movesDone, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      return active;
    };
    const stop = subscribeSharedTreeChanges(
      subscribeHostEvents,
      async (scope: RefreshScope) => {
        if (!await afterMoves()) return;
        // Only the notebooks the events touched, and only those this window shows; an identical result is not applied, so nothing re-renders.
        try { await latestTreeChange.current.refreshNotebooks(scope); }
        catch (error) { setWorkspaceError(error instanceof Error ? error.message : tRef.current("refreshTreeError")); }
      },
      (moves: FileMove[]) => {
        movesDone = movesDone.then(async () => {
          // All destinations are looked up first, then every tab is retargeted in one step.
          // A lookup that fails while the cloud is still delivering the file is retried a few times.
          const found = await Promise.all(moves.map(async (move) => {
            try {
              const payload = await withBackoff(() => apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(move.to)}`));
              return { from: move.from, payload };
            } catch {
              // The file is gone; one failed move must not stop the others.
              return null;
            }
          }));
          if (!active) return;
          const items = found.filter((item): item is { from: string; payload: LiberaFilePayload } => item !== null);
          if (items.length) latestTreeChange.current.retargetOpenTabs(items);
        });
      },
      undefined,
      async (paths) => {
        if (!await afterMoves()) return;
        try { await latestTreeChange.current.refreshFiles(paths); }
        catch (error) { setWorkspaceError(error instanceof Error ? error.message : tRef.current("refreshTreeError")); }
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, [authenticated]);

  async function moveFileNode(
    file: LiberaFileNode,
    destinationNotebook: string,
    destinationName: string,
    options?: { skipDirtyCheck?: boolean },
  ) {
    const openTab = tabs.find((tab) => tab.file.path === file.path);

    if (openTab && tabUnsaved(openTab) && !options?.skipDirtyCheck) {
      setWorkspaceConfirmDialog({
        mode: "move-file-node",
        file,
        destinationNotebook,
        destinationName,
      });
      return;
    }

    try {
      const payload = await workspaceFileRequest<LiberaFileMovePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          destinationNotebook,
          destinationName,
          fileId: file.fileId,
        }),
      }, (payload) => ({ paths: [payload.file.path], ...moveFileChange(file.path, payload) }));
      followFileMove(file.path, payload);
      await refreshTree(payload.file.notebook);
    } catch (error) {
      // The file moved, but the request failed after it: follow it anyway and say what did not.
      const committed = committedMove(error);
      if (committed) { await followCommittedMove(file, committed); return; }
      setWorkspaceError(isIdentityConflict(error) ? tRef.current("fileChangedUnderYouError") : error instanceof Error ? error.message : tRef.current("moveFileError"));
      // A failed move leaves the disk as it was, but never trust the tree to say so: show what is there.
      await refreshTree().catch(() => undefined);
    }
  }

  async function moveFileToFolder(
    file: LiberaFileNode,
    destinationPath: string,
    options?: { skipDirtyCheck?: boolean },
  ) {
    // Used as given: tree paths are exact (" Drafts" is not "Drafts"), and the typed
    // Move dialog trims its own input before calling.
    const normalizedDestination = destinationPath;
    const openTab = tabs.find((tab) => tab.file.path === file.path);

    if (!normalizedDestination || normalizedDestination === parentPathForFile(file)) {
      return;
    }

    // To another notebook, a file moves as a migration of one file: reviewed, crash-safe, and
    // followed by everything it has (storage/migration.ts). The dialog saves unsaved tabs itself,
    // so this comes before the unsaved-draft question. Within its notebook it moves directly.
    const { notebook: destinationNotebook, folder } = splitDropDestination(normalizedDestination);
    if (destinationNotebook && destinationNotebook !== file.notebook) {
      openMigrationDialog(file.notebook, { paths: [file.path], destination: destinationNotebook, folder, flat: true });
      return;
    }

    if (openTab && tabUnsaved(openTab) && !options?.skipDirtyCheck) {
      setWorkspaceConfirmDialog({
        mode: "move-file-folder",
        file,
        destinationPath: normalizedDestination,
      });
      return;
    }

    try {
      const payload = await workspaceFileRequest<LiberaFileMovePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          destinationDirectory: normalizedDestination,
          fileId: file.fileId,
        }),
      }, (payload) => ({ paths: [payload.file.path], ...moveFileChange(file.path, payload) }));
      followFileMove(file.path, payload);
      await refreshTree(payload.file.notebook);
      updateExpanded((current) => {
        const next = new Set(current);
        next.add(normalizedDestination.split("/")[0] ?? normalizedDestination);
        next.add(normalizedDestination);
        return next;
      });
    } catch (error) {
      // The file moved, but the request failed after it: follow it anyway and say what did not.
      const committed = committedMove(error);
      if (committed) { await followCommittedMove(file, committed); return; }
      setWorkspaceError(isIdentityConflict(error) ? tRef.current("fileChangedUnderYouError") : error instanceof Error ? error.message : tRef.current("moveFileError"));
      // A failed move leaves the disk as it was, but never trust the tree to say so: show what is there.
      await refreshTree().catch(() => undefined);
    }
  }

  // ---- Several files at once (the selection in the notebook rail; storage/batch-files.ts) ----

  /** The open files among `files` with unsaved edits, by name. */
  function unsavedNamesAmong(files: LiberaFileNode[]) {
    return files.flatMap((file) => unsavedNamesUnder(tabs, file.path, tabUnsaved));
  }

  async function moveFilesFromPrompt(files: LiberaFileNode[]) {
    if (!files.length) return;
    setWorkspaceError("");
    setWorkspaceInputDialog(files.length === 1 ? { mode: "move-file", file: files[0] } : { mode: "move-files", files });
  }

  /**
   * Moves the files to one destination. To another notebook they go through the
   * migration dialog with every path preset; within the notebook the server checks
   * the whole batch first and moves them one by one, and each moved file is followed
   * by the same step as a single move (followFileMove). The tree is read once at the end.
   */
  async function moveFilesToFolder(
    files: LiberaFileNode[],
    destinationPath: string,
    options?: { skipDirtyCheck?: boolean },
  ) {
    if (files.length === 1) return moveFileToFolder(files[0], destinationPath, options);
    if (!files.length || !destinationPath) return;
    const { notebook: destinationNotebook, folder } = splitDropDestination(destinationPath);
    if (destinationNotebook && destinationNotebook !== files[0].notebook) {
      openMigrationDialog(files[0].notebook, { paths: files.map((file) => file.path), destination: destinationNotebook, folder, flat: true });
      return;
    }
    // Files already in the folder have nothing to do, as for a single move.
    const moving = files.filter((file) => parentPathForFile(file) !== destinationPath);
    if (!moving.length) return;
    const unsavedNames = unsavedNamesAmong(moving);
    if (unsavedNames.length && !options?.skipDirtyCheck) {
      setWorkspaceConfirmDialog({ mode: "move-files-folder", files: moving, destinationPath, unsavedNames });
      return;
    }

    try {
      const result = await workspaceFileRequest<BatchMoveResult>("/api/files/batch", {
        method: "POST",
        body: JSON.stringify({
          action: "move",
          items: moving.map((file) => ({ path: file.path, fileId: file.fileId })),
          destinationDirectory: destinationPath,
        }),
      }, (result) => {
        // Saved workspaces get the batch's link rewrites too, for the notes it rewrote, moved or not.
        const others = linkRewriteByPath(result.links);
        return {
          paths: result.moved.map((item) => item.to),
          moved: result.moved.map(({ from, to }) => ({ from, to })),
          ...(others ? { rewrite: (path: string, text: string) => others(path, text) ?? text } : {}),
        };
      });
      // Each moved file's payload carries its own rewrite, for its tab; the batch's one links step rewrote the rest,
      // which open notes get once here (the moved files' tabs already have theirs).
      for (const item of result.moved) if (item.payload) followFileMove(item.from, item.payload);
      applyLinkRewritesToTabs(result.links, result.moved.map((item) => item.to));
      if (result.links || result.unfinished) reportMoveOutcome({ notebook: files[0].notebook, links: result.links, unfinished: result.unfinished });
      if (result.failed) {
        setWorkspaceError(tRef.current("batchMovePartialError", {
          moved: result.moved.length, total: moving.length, name: result.failed.path.split("/").at(-1) ?? result.failed.path, message: result.failed.error,
        }));
      }
      await refreshTree(files[0].notebook);
      updateExpanded((current) => {
        const next = new Set(current);
        next.add(destinationPath.split("/")[0] ?? destinationPath);
        next.add(destinationPath);
        return next;
      });
    } catch (error) {
      // A refused batch changed nothing; the server's message says which file and why.
      setWorkspaceError(isIdentityConflict(error) ? tRef.current("fileChangedUnderYouError") : error instanceof Error ? error.message : tRef.current("moveFileError"));
      await refreshTree().catch(() => undefined);
    }
  }

  async function deleteFileNodesFromPrompt(files: LiberaFileNode[]) {
    if (!files.length) return;
    if (files.length === 1) { await deleteFileNodeFromPrompt(files[0]); return; }
    setWorkspaceConfirmDialog({ mode: "delete-files", files, unsavedNames: unsavedNamesAmong(files) });
  }

  /** Deletes the files one by one on the server; tabs close and drafts are forgotten for each that went, as for a single delete. */
  async function deleteFileNodes(files: LiberaFileNode[]) {
    try {
      const result = await workspaceFileRequest<BatchDeleteResult>("/api/files/batch", {
        method: "POST",
        body: JSON.stringify({ action: "delete", items: files.map((file) => ({ path: file.path, fileId: file.fileId })) }),
      }, (result) => ({ removed: result.deleted }));
      const deleted = new Set(result.deleted);
      tabs.forEach((tab) => { if (deleted.has(tab.file.path)) forgetTabDraft(tab.id); });
      setTabs((currentTabs) => currentTabs.filter((currentTab) => !deleted.has(currentTab.file.path)));
      setActiveTabId((current) => (deleted.has(current) ? "" : current));
      if (result.failed.length) {
        const shown = result.failed.slice(0, 3).map((item) => `${item.path.split("/").at(-1)} (${item.error})`).join("; ");
        setWorkspaceError(tRef.current("batchDeletePartialError", { deleted: result.deleted.length, total: files.length, failures: result.failed.length > 3 ? `${shown}; …` : shown }));
      }
      await refreshTree(files[0].notebook);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("deleteFileError"));
      await refreshTree().catch(() => undefined);
    }
  }

  // ---- Notebook migration (notebook-migration-dialog.tsx, storage/migration.ts) ----

  /** The source notebook the migration dialog opens on; null while it is closed. */
  const [migrationDialogSource, setMigrationDialogSource] = useState<string | null>(null);
  /** A migration prepared elsewhere (Move… to another notebook): the dialog opens on its review. */
  const [migrationPreset, setMigrationPreset] = useState<MigrationPreset | null>(null);

  function openMigrationDialog(notebook?: string, preset?: MigrationPreset) {
    setMigrationPreset(preset ?? null);
    setMigrationDialogSource(notebook ?? selectedNotebookName ?? "");
  }

  function closeMigrationDialog() {
    setMigrationDialogSource(null);
    setMigrationPreset(null);
  }

  /** Open files at or under `paths` with unsaved text, ink or annotations. */
  function unsavedTabsUnder(paths: string[]) {
    // A failed or running save, or a draft that differs from the saved text, counts as unsaved too.
    const unsaved = (tab: OpenTab) => tabUnsaved(tab) || tab.status === "error" || tab.status === "saving" ||
      (isTextFileType(tab.file.fileType) && getTabDraft(tab) !== tab.saved);
    return tabs.filter((tab) => !isGalleryTab(tab) && !isRecordingTab(tab) && !isPageTab(tab) && !tab.untitled &&
      paths.some((path) => tab.file.path === path || tab.file.path.startsWith(`${path}/`)) && unsaved(tab));
  }

  /**
   * Saves those files with the same guarded save as Save (saveTabText), so the migration moves
   * what the user sees and never replaces text that changed on disk meanwhile: that stops the migration.
   */
  async function saveTabsBeforeMigration(paths: string[]) {
    for (const tab of unsavedTabsUnder(paths)) {
      if (isTextFileType(tab.file.fileType) && !isSharedTab(tab.id)) {
        const outcome = await saveTabText(tab.id);
        if (outcome === "ask" || outcome === "conflict" || outcome === "failed") {
          const message = tabsRef.current.find((item) => item.id === tab.id)?.error ?? tRef.current("saveFailedError");
          throw new Error(tRef.current("saveNamedFileError", { name: tab.file.name, message }));
        }
      }
      await pendingSaves.save(tab.file.path);
    }
  }

  /**
   * The rewrites the migration made (image paths of moved notes, then paths in
   * any file that followed the moves, then citation keys: the server's order,
   * move-rewrites.ts moveTextRewrite), for texts it did not see.
   */
  function migrationRewrite(result: MigrationResult) {
    const images = new Map(result.moved.flatMap((move) => move.imageSources ? [[move.to, move.imageSources] as const] : []));
    const keys = new Map((result.references?.drafts ?? []).map((draft) => [draft.path, draft.map]));
    const paths = new Map((result.links?.rewritten ?? []).map((item) => [item.path, item.rewrite]));
    if (!images.size && !keys.size && !paths.size) return undefined;
    return (path: string, text: string) =>
      moveTextRewrite(path, { imageSources: images.get(path), paths: paths.get(path), citationKeys: keys.get(path) })?.(text) ?? text;
  }

  function migrationFileChange(result: MigrationResult): WorkspaceFileChange {
    const rewrite = migrationRewrite(result);
    // A workspace group chosen for the new notebook comes back with the result, also after an interruption.
    const notebookGroup = result.createdNotebook && result.workspaceGroup && workspaceManager.activeWorkspace ? result.workspaceGroup : undefined;
    return {
      paths: [...(result.createdNotebook ? [result.destination] : []), ...result.moved.map((move) => move.to)],
      // One mapping: a file's own move (a renamed file) wins over its folder's.
      moved: [...result.folders, ...result.moved.map(({ from, to }) => ({ from, to }))],
      ...(rewrite ? { rewrite } : {}),
      ...(notebookGroup ? { notebookGroup } : {}),
    };
  }

  /** Review decisions not yet sent for files under `paths` reach the server before they move. */
  async function flushReviewsUnder(paths: string[]) {
    const under = agentReviewStore.list().map((file) => file.path).filter((path) => paths.some((selected) => path === selected || path.startsWith(`${selected}/`)));
    if (under.length) await agentReviewStore.flush(under);
  }

  /**
   * The app follows a migration's result, then tells the server it did, which
   * then forgets the result. A failure here leaves the result on the server,
   * so the next migration dialog applies it again; the files have moved either way.
   * `persistFailure`: the saved workspaces could not be written with the moved
   * paths (runFileChange keeps going on that); the journal is then not
   * acknowledged, and the result is replayed.
   */
  async function settleMigrationResult(result: MigrationResult, persistFailure: { error: Error | null }) {
    try {
      await applyMigrationResult(result);
      // Other windows of the app have their own tabs and state to follow.
      migrationChannelRef.current?.postMessage(result);
      // Tabs, expanded folders and the like follow through the normal checkpoint: write it now, so the acknowledgement below means it is on disk.
      if (!persistFailure.error) await workspaceManager.checkpoint();
      if (persistFailure.error) throw persistFailure.error;
      if (result.state === "done") await apiRequest("/api/notebooks/migrate", { method: "POST", body: JSON.stringify({ action: "acknowledge", id: result.id }) });
    } catch (error) {
      setWorkspaceError(tRef.current("movedButNotUpdatedError", { message: error instanceof Error ? error.message : String(error) }));
    }
    void agentReviewStore.refresh();
  }

  /** A finished migration whose result never reached this window (the app quit, the response was lost). */
  async function applyUnacknowledgedMigration(result: MigrationResult) {
    const persistFailure: { error: Error | null } = { error: null };
    await workspaceManager.runFileChange(async () => result, (value) => migrationFileChange(value), (error) => { persistFailure.error = error; });
    await settleMigrationResult(result, persistFailure);
  }

  /** Runs a reviewed migration. Throws when nothing moved (the plan changed, a blocker); a partial run returns `interrupted`. */
  async function runNotebookMigration(request: MigrationRequest, token: string) {
    const create = request.destination.create;
    // Workspace group assignments live in the workspace snapshot, not notebook metadata:
    // the server keeps the choice with the migration and returns it with the result.
    const body = create && workspaceManager.activeWorkspace
      ? { ...request, destination: { ...request.destination, create: { ...create, groupId: null, workspaceGroupId: create.groupId ?? null } } }
      : request;
    await flushReviewsUnder(request.paths);
    const persistFailure: { error: Error | null } = { error: null };
    const result = await workspaceFileRequest<MigrationResult>("/api/notebooks/migrate", {
      method: "POST",
      body: JSON.stringify({ action: "run", request: body, token }),
    }, (value) => migrationFileChange(value), (error) => { persistFailure.error = error; });
    await settleMigrationResult(result, persistFailure);
    return result;
  }

  async function resumeNotebookMigration(id: string, mode: "continue" | "stop") {
    const persistFailure: { error: Error | null } = { error: null };
    const result = await workspaceFileRequest<MigrationResult>("/api/notebooks/migrate", {
      method: "POST",
      body: JSON.stringify({ action: "resume", id, mode }),
    }, (value) => migrationFileChange(value), (error) => { persistFailure.error = error; });
    await settleMigrationResult(result, persistFailure);
    return result;
  }

  /** Everything in the app that knows the moved files by path follows them. */
  async function applyMigrationResult(result: MigrationResult) {
    const moves = new Map(result.moved.map((move) => [move.from, move.to]));
    const isOpen = (path: string) => tabsRef.current.find((tab) => !isGalleryTab(tab) && !isRecordingTab(tab) && !isPageTab(tab) && tab.file.path === path);
    const open = result.moved.filter((move) => isOpen(move.from));
    for (const move of result.moved) if (!isOpen(move.from)) pendingSaves.moveUnsaved(move.from, move.to, { sources: move.imageSources });
    // The open files as they are now (images and citation keys may have been rewritten), a few at a time.
    const payloads: (LiberaFilePayload | null)[] = [];
    for (let start = 0; start < open.length; start += 4) {
      payloads.push(...await Promise.all(open.slice(start, start + 4).map((move) =>
        apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(move.to)}`).catch(() => null))));
    }
    // Then every tab follows in one go, so the editor re-renders once (and a swap is seen as one).
    const followers: { from: string; payload: LiberaFileMovePayload }[] = [];
    open.forEach((move, index) => {
      const maps = { ...(move.imageSources ? { imageSources: move.imageSources } : {}), ...(result.references ? { references: result.references } : {}), ...(result.links ? { links: result.links } : {}) };
      const tab = isOpen(move.from);
      // Not readable now: the tab still follows, and its text gets the same rewrites the file got.
      const payload = payloads[index] ?? (tab ? { file: { ...tab.file, path: move.to, name: move.to.split("/").at(-1)!, notebook: move.to.split("/")[0] } } : null);
      if (payload) followers.push({ from: move.from, payload: { ...payload, ...maps } });
    });
    if (followers.length) retargetOpenTabs(followers);
    // Open files that stayed (in any notebook) and whose links followed the moves get the same rewrite.
    applyLinkRewritesToTabs(result.links, followers.map((follower) => follower.payload.file.path));
    setFileInteractions((current) => {
      if (!Object.keys(current).some((path) => moves.has(path))) return current;
      const next = Object.fromEntries(Object.entries(current).map(([path, at]) => [moves.get(path) ?? path, at]));
      try { window.localStorage.setItem(FILE_INTERACTIONS_STORAGE_KEY, JSON.stringify(next)); } catch { /* Storage unavailable. */ }
      return next;
    });
    remapDocumentHeadingNumbering(moves);
    reportMoveOutcome({ references: result.references, notebook: result.destination, links: result.links });
    // Expanded folders follow before the refresh, which drops paths that no longer exist.
    updateExpanded((current) => {
      const next = new Set<string>();
      for (const expandedPath of current) {
        const folder = result.folders.find((item) => expandedPath === item.from || expandedPath.startsWith(`${item.from}/`));
        next.add(folder ? `${folder.to}${expandedPath.slice(folder.from.length)}` : expandedPath);
      }
      next.add(result.destination);
      return next;
    });
    await refreshTree(result.destination);
    if (result.moved.length) setSelectedNotebookName(result.destination);
  }

  /**
   * Try to fix gave the records of files moved outside the app to the files
   * now in place: open tabs, saved workspaces and unsaved editor state that
   * know the old paths follow, as after a migration (applyMigrationResult).
   */
  async function applyRepairMoves(moved: ReadonlyArray<{ from: string; to: string }>) {
    if (!moved.length) return;
    const pairs = moved.map(({ from, to }) => ({ from, to }));
    const moves = new Map(pairs.map((move) => [move.from, move.to]));
    await workspaceManager.runFileChange(async () => pairs, () => ({ paths: pairs.map((move) => move.to), moved: pairs }));
    const isOpen = (path: string) => tabsRef.current.find((tab) => !isGalleryTab(tab) && !isRecordingTab(tab) && !isPageTab(tab) && tab.file.path === path);
    const open = pairs.filter((move) => isOpen(move.from));
    for (const move of pairs) if (!isOpen(move.from)) pendingSaves.moveUnsaved(move.from, move.to);
    const payloads = await Promise.all(open.map((move) => apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(move.to)}`).catch(() => null)));
    // One batch: the destination text is reconciled with each tab, and a destination already open in another tab is resolved.
    const followers: { from: string; payload: LiberaFilePayload }[] = [];
    open.forEach((move, index) => {
      const tab = isOpen(move.from);
      const payload = payloads[index] ?? (tab ? { file: { ...tab.file, path: move.to, name: move.to.split("/").at(-1)!, notebook: move.to.split("/")[0] } } : null);
      if (payload) followers.push({ from: move.from, payload });
    });
    if (followers.length) retargetOpenTabs(followers);
    setFileInteractions((current) => {
      if (!Object.keys(current).some((path) => moves.has(path))) return current;
      const next = Object.fromEntries(Object.entries(current).map(([path, at]) => [moves.get(path) ?? path, at]));
      try { window.localStorage.setItem(FILE_INTERACTIONS_STORAGE_KEY, JSON.stringify(next)); } catch { /* Storage unavailable. */ }
      return next;
    });
    remapDocumentHeadingNumbering(moves);
  }

  const latestRepairApply = useRef(applyRepairMoves);
  useLayoutEffect(() => {
    latestRepairApply.current = applyRepairMoves;
  });
  useEffect(() => {
    if (!authenticated) return;
    const onRepaired = (event: Event) => {
      const moves = (event as CustomEvent<{ moves?: Array<{ from: string; to: string }> }>).detail?.moves;
      if (Array.isArray(moves)) void latestRepairApply.current(moves).catch((error: Error) => setWorkspaceError(error.message));
    };
    window.addEventListener(REPAIR_MOVED_EVENT, onRepaired);
    // Another window ran Try to fix: its tabs and drafts follow too (the window event is local).
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(REPAIR_CHANNEL_NAME);
    if (channel) channel.onmessage = (event: MessageEvent) => {
      const moves = movesFromRepairMessage(event.data);
      if (moves) void latestRepairApply.current(moves).catch((error: Error) => setWorkspaceError(error.message));
    };
    return () => {
      window.removeEventListener(REPAIR_MOVED_EVENT, onRepaired);
      channel?.close();
    };
  }, [authenticated]);

  // Another window ran a migration: this window's tabs and state follow it.
  const migrationChannelRef = useRef<BroadcastChannel | null>(null);
  /**
   * This window follows a migration another window ran: its saved workspaces
   * (not only its tabs) get the new paths. There is no confirmation back to
   * the other window. A failure to apply it falls back to the server's list of
   * unacknowledged migrations (the other window may not have acknowledged yet),
   * and the tree is refreshed from disk either way, so no stale path is shown.
   */
  async function followMigrationFromOtherWindow(result: MigrationResult) {
    try {
      await workspaceManager.runFileChange(async () => result, (value) => migrationFileChange(value));
      await applyMigrationResult(result);
    } catch (error) {
      setWorkspaceError(tRef.current("movedButNotUpdatedError", { message: error instanceof Error ? error.message : String(error) }));
      try {
        const { unacknowledged } = await apiRequest<{ unacknowledged: MigrationResult[] }>("/api/notebooks/migrate");
        for (const pending of unacknowledged) {
          await workspaceManager.runFileChange(async () => pending, (value) => migrationFileChange(value));
          await applyMigrationResult(pending);
        }
      } catch { /* Left to the next launch or the Migration dialog, which replay unacknowledged results. */ }
      await refreshTree().catch(() => undefined);
    }
  }
  const latestMigrationApply = useRef(followMigrationFromOtherWindow);
  useLayoutEffect(() => {
    latestMigrationApply.current = followMigrationFromOtherWindow;
  });
  useEffect(() => {
    if (!authenticated || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("libera-notebook-migration");
    migrationChannelRef.current = channel;
    channel.onmessage = (event: MessageEvent<MigrationResult>) => {
      const result = event.data;
      if (result && typeof result.id === "string" && Array.isArray(result.moved)) {
        void latestMigrationApply.current(result).catch((error: Error) => setWorkspaceError(error.message));
      }
    };
    return () => {
      channel.close();
      if (migrationChannelRef.current === channel) migrationChannelRef.current = null;
    };
  }, [authenticated]);

  async function deleteFileFromPrompt(tab: OpenTab) {
    if (tab.untitled) { closeTab(tab.id); return; }
    await deleteFileNodeFromPrompt(tab.file);
  }

  async function deleteFileNodeFromPrompt(file: LiberaFileNode) {
    setWorkspaceConfirmDialog({ mode: "delete-file", file, unsavedNames: unsavedNamesUnder(tabs, file.path, tabUnsaved) });
  }

  async function deleteFileNode(file: LiberaFileNode) {
    try {
      await workspaceFileRequest<LiberaTree>(`/api/files?path=${encodeURIComponent(file.path)}${file.fileId ? `&fileId=${encodeURIComponent(file.fileId)}` : ""}`, {
        method: "DELETE",
      }, () => ({ removed: [file.path] }));
      tabs.forEach((tab) => {
        if (tab.file.path === file.path) {
          forgetTabDraft(tab.id);
        }
      });
      setTabs((currentTabs) =>
        currentTabs.filter((currentTab) => currentTab.file.path !== file.path),
      );
      setActiveTabId((current) => (current === file.path ? "" : current));
      await refreshTree(file.notebook);
    } catch (error) {
      // A shared file the host deleted although a step after it failed: it is gone (tab closed, saved workspaces told); the message says what stayed.
      if (sharedCommitted(error)) {
        await workspaceManager.runFileChange(async () => undefined, () => ({ removed: [file.path] })).catch(() => undefined);
        forgetTabDraft(file.path);
        setTabs((currentTabs) => currentTabs.filter((currentTab) => currentTab.file.path !== file.path));
        setActiveTabId((current) => (current === file.path ? "" : current));
        await refreshTree(file.notebook).catch(() => undefined);
        setWorkspaceError(error instanceof Error ? error.message : tRef.current("deleteFileError"));
        return;
      }
      setWorkspaceError(isIdentityConflict(error) ? tRef.current("fileChangedUnderYouError") : error instanceof Error ? error.message : tRef.current("deleteFileError"));
      // The path now belongs to another file: show what is there instead of the stale list.
      if (isIdentityConflict(error)) await refreshTree().catch(() => undefined);
    }
  }

  async function archiveFileNode(file: LiberaFileNode) {
    const openTab = tabs.find((tab) => tab.file.path === file.path);

    if (openTab && tabUnsaved(openTab)) {
      setWorkspaceError(tRef.current("archiveBeforeSaveError"));
      return;
    }

    try {
      const payload = await workspaceFileRequest<LiberaFileMovePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          archive: true,
          fileId: file.fileId,
        }),
      }, (payload) => moveFileChange(file.path, payload));
      // The tab follows the archived file with whatever was typed while the request ran; links that pointed at it follow too.
      followFileMove(file.path, payload);
      await refreshTree(file.notebook);
    } catch (error) {
      const committed = committedMove(error);
      if (committed) { await followCommittedMove(file, committed); return; }
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("archiveFileError"));
    }
  }

  async function renameFolderFromPrompt(folder: LiberaFolderNode) {
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "rename-folder", folder });
  }

  async function renameFolder(folder: LiberaFolderNode, name: string) {
    const parentPath = folder.path.split("/").slice(0, -1).join("/");
    const nextPath = `${parentPath}/${name}`;

    // Set when the host renamed the folder but a step after it failed: the rename stands, and this says what stayed behind.
    let stayedBehind = "";
    try {
      const nextTree = await workspaceFileRequest<LiberaFolderMovePayload>("/api/folders", {
        method: "PATCH",
        body: JSON.stringify({
          path: folder.path,
          name,
        }),
      }, (result) => {
        const rewrite = linkRewriteByPath(result.links);
        return { moved: { from: folder.path, to: nextPath }, ...(rewrite ? { rewrite } : {}) };
      }).catch(async (error): Promise<LiberaFolderMovePayload> => {
        if (!sharedCommitted(error)) throw error;
        stayedBehind = error instanceof Error ? error.message : tRef.current("renameFolderError");
        await workspaceManager.runFileChange(async () => undefined, () => ({ paths: [nextPath], moved: { from: folder.path, to: nextPath } })).catch(() => undefined);
        return apiRequest<LiberaTree>("/api/tree?includeArchive=true");
      });
      pendingSaves.moveUnsaved(folder.path, nextPath, { prefix: true });
      await applyCompleteTree(nextTree);
      updateExpanded((current) => {
        const next = new Set<string>();

        for (const expandedPath of current) {
          if (expandedPath === folder.path) {
            next.add(nextPath);
          } else if (expandedPath.startsWith(`${folder.path}/`)) {
            next.add(`${nextPath}/${expandedPath.slice(folder.path.length + 1)}`);
          } else {
            next.add(expandedPath);
          }
        }

        next.add(parentPath);
        return next;
      });
      tabs.forEach((tab) => {
        if (!tab.file.path.startsWith(`${folder.path}/`)) {
          return;
        }

        const suffix = tab.file.path.slice(folder.path.length + 1);
        const updatedPath = `${nextPath}/${suffix}`;
        const draft = getTabDraft(tab);

        forgetTabDraft(tab.id);
        rememberTabDraft(updatedPath, draft);
      });
      // At once (tabsRef too): the link rewrites below find the tabs by their new paths.
      changeTabsNow((currentTabs) =>
        currentTabs.map((tab) => {
          if (!tab.file.path.startsWith(`${folder.path}/`)) {
            return tab;
          }

          const suffix = tab.file.path.slice(folder.path.length + 1);
          const updatedPath = `${nextPath}/${suffix}`;

          return {
            ...tab,
            id: updatedPath,
            draft: latestDraftByTabIdRef.current[updatedPath] ?? tab.draft,
            file: {
              ...tab.file,
              path: updatedPath,
            },
            rawUrl: `/api/files/raw/${encodeFilePath(updatedPath)}`,
          };
        }),
      );
      setActiveTabId((current) =>
        current.startsWith(`${folder.path}/`)
          ? `${nextPath}/${current.slice(folder.path.length + 1)}`
          : current,
      );
      setClosedViewStates((current) => remapClosedViewStates(current, (path) =>
        withinPath(path, folder.path) ? `${nextPath}${path.slice(folder.path.length)}` : path));
      // Open files whose links followed the folder, inside it or not, get the same rewrite; the notice says so.
      applyLinkRewritesToTabs(nextTree.links);
      reportMoveOutcome({ notebook: folder.path.split("/")[0], links: nextTree.links, unfinished: nextTree.unfinished });
      if (stayedBehind) setWorkspaceError(stayedBehind);
    } catch (error) {
      // Show what is on disk now, whatever the failure left.
      await refreshTree().catch(() => undefined);
      throw new Error(error instanceof Error ? error.message : tRef.current("renameFolderError"));
    }
  }

  async function submitWorkspaceInputDialog(values: WorkspaceInputDialogValues) {
    if (!workspaceInputDialog) {
      return;
    }

    setWorkspaceInputDialogSubmitting(true);

    try {
      if (workspaceInputDialog.mode === "create-folder") {
        const name = values.name.trim();

        if (!name) {
          setWorkspaceInputDialogError(tRef.current("folderNameRequired"));
          return;
        }

        await createFolder(workspaceInputDialog.parentPath, name);
      }

      if (workspaceInputDialog.mode === "copy-file") {
        const destinationDirectory = values.destinationDirectory.trim();
        const destinationName = values.destinationName.trim();

        if (!destinationDirectory) {
          setWorkspaceInputDialogError(tRef.current("destinationPathRequired"));
          return;
        }

        if (!destinationName) {
          setWorkspaceInputDialogError(tRef.current("copyFileNameRequired"));
          return;
        }

        await copyFile(workspaceInputDialog.file, destinationDirectory, destinationName);
      }

      if (workspaceInputDialog.mode === "move-file") {
        const destinationDirectory = values.destinationDirectory.trim();

        if (!destinationDirectory) {
          setWorkspaceInputDialogError(tRef.current("destinationPathRequired"));
          return;
        }

        // A destination in another notebook opens the migration dialog (moveFileToFolder routes it).
        await moveFileToFolder(workspaceInputDialog.file, destinationDirectory);
      }

      if (workspaceInputDialog.mode === "move-files") {
        const destinationDirectory = values.destinationDirectory.trim();

        if (!destinationDirectory) {
          setWorkspaceInputDialogError(tRef.current("destinationPathRequired"));
          return;
        }

        await moveFilesToFolder(workspaceInputDialog.files, destinationDirectory);
      }

      if (workspaceInputDialog.mode === "rename-file") {
        const name = values.name.trim();

        if (!name) {
          setWorkspaceInputDialogError(tRef.current("fileNameRequired"));
          return;
        }

        if (name !== workspaceInputDialog.file.name) {
          await moveFileNode(workspaceInputDialog.file, workspaceInputDialog.file.notebook, name);
        }
      }

      if (workspaceInputDialog.mode === "rename-folder") {
        const name = values.name.trim();

        if (!name) {
          setWorkspaceInputDialogError(tRef.current("folderNameRequired"));
          return;
        }

        if (name !== workspaceInputDialog.folder.name) {
          await renameFolder(workspaceInputDialog.folder, name);
        }
      }

      setWorkspaceInputDialog(null);
    } catch (error) {
      setWorkspaceInputDialogError(
        error instanceof Error ? error.message : tRef.current("saveChangesError"),
      );
    } finally {
      setWorkspaceInputDialogSubmitting(false);
    }
  }

  async function deleteFolderFromPrompt(folder: LiberaFolderNode) {
    setWorkspaceConfirmDialog({ mode: "delete-folder", folder, unsavedNames: unsavedNamesUnder(tabs, folder.path, tabUnsaved) });
  }

  async function deleteFolder(folder: LiberaFolderNode) {
    // Set when the host deleted the folder but a step after it failed: it is gone, and this says what stayed behind.
    let stayedBehind = "";
    try {
      const nextTree = await workspaceFileRequest<LiberaTree>(
        `/api/folders?path=${encodeURIComponent(folder.path)}`,
        { method: "DELETE" },
        () => ({ removed: [folder.path] }),
      ).catch(async (error): Promise<LiberaTree> => {
        if (!sharedCommitted(error)) throw error;
        stayedBehind = error instanceof Error ? error.message : tRef.current("deleteFolderError");
        await workspaceManager.runFileChange(async () => undefined, () => ({ removed: [folder.path] })).catch(() => undefined);
        return apiRequest<LiberaTree>("/api/tree?includeArchive=true");
      });
      await applyCompleteTree(nextTree);
      updateExpanded((current) =>
        new Set(
          [...current].filter(
            (expandedPath) =>
              expandedPath !== folder.path && !expandedPath.startsWith(`${folder.path}/`),
          ),
        ),
      );
      tabs.forEach((tab) => {
        if (tab.file.path.startsWith(`${folder.path}/`)) {
          forgetTabDraft(tab.id);
        }
      });
      setTabs((currentTabs) =>
        currentTabs.filter((currentTab) => !currentTab.file.path.startsWith(`${folder.path}/`)),
      );
      setActiveTabId((current) => (current.startsWith(`${folder.path}/`) ? "" : current));
      if (stayedBehind) setWorkspaceError(stayedBehind);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("deleteFolderError"));
    }
  }

  async function archiveFolderNode(folder: LiberaFolderNode) {
    const dirtyTabCount = tabs.filter(
      (tab) => isPathWithinPrefix(tab.file.path, folder.path) && tabUnsaved(tab),
    ).length;

    if (dirtyTabCount > 0) {
      setWorkspaceError(tRef.current("archiveFolderBeforeSaveError"));
      return;
    }

    try {
      const nextTree = await workspaceFileRequest<LiberaFolderMovePayload & { moved: { from: string; to: string } }>("/api/folders", {
        method: "PATCH",
        body: JSON.stringify({
          path: folder.path,
          archive: true,
        }),
      }, (result) => {
        const rewrite = linkRewriteByPath(result.links);
        return { moved: result.moved, paths: [result.moved.to], ...(rewrite ? { rewrite } : {}) };
      });
      await applyCompleteTree(nextTree);
      updateExpanded((current) =>
        new Set(
          [...current].filter(
            (expandedPath) =>
              expandedPath !== folder.path && !expandedPath.startsWith(`${folder.path}/`),
          ),
        ),
      );
      // Open files follow the folder into the archive, each with its current text and what was typed meanwhile.
      const archived = pathsUnderMovedFolder(
        tabsRef.current.filter((tab) => !isGalleryTab(tab) && !isRecordingTab(tab) && !isPageTab(tab) && !tab.untitled).map((tab) => tab.file.path),
        nextTree.moved,
      );
      const followers = await Promise.all(archived.map(async (move) => {
        const tab = tabsRef.current.find((item) => item.file.path === move.from);
        const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(move.to)}`).catch(() => null)
          ?? { file: { ...tab!.file, path: move.to, name: move.to.split("/").at(-1)!, notebook: move.to.split("/")[0] } };
        // Its text as the server left it, and the links the move rewrote in it, for what the tab holds (movedTabText).
        return { from: move.from, payload: { ...payload, ...(nextTree.links ? { links: nextTree.links } : {}) } };
      }));
      if (followers.length) retargetOpenTabs(followers);
      // Unsaved state of files that are not open follows the folder as well.
      pendingSaves.moveUnsaved(folder.path, nextTree.moved.to, { prefix: true });
      // Open files elsewhere whose links followed the folder get the same rewrite; the notice says so.
      applyLinkRewritesToTabs(nextTree.links, followers.map((follower) => follower.payload.file.path));
      reportMoveOutcome({ notebook: folder.path.split("/")[0], links: nextTree.links, unfinished: nextTree.unfinished });
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("archiveFolderError"));
    }
  }

  async function submitWorkspaceConfirmDialog() {
    if (!workspaceConfirmDialog) {
      return;
    }

    setWorkspaceConfirmDialogSubmitting(true);

    try {
      if (workspaceConfirmDialog.mode === "close-tab") {
        discardPendingSaves([workspaceConfirmDialog.tabId]);
        closeTabWithoutConfirm(workspaceConfirmDialog.tabId);
      }

      if (workspaceConfirmDialog.mode === "close-tabs") {
        discardPendingSaves(workspaceConfirmDialog.tabIds);
        closeTabsWithoutConfirm(workspaceConfirmDialog.tabIds);
      }

      if (workspaceConfirmDialog.mode === "delete-file") {
        await deleteFileNode(workspaceConfirmDialog.file);
      }

      if (workspaceConfirmDialog.mode === "delete-files") {
        await deleteFileNodes(workspaceConfirmDialog.files);
      }

      if (workspaceConfirmDialog.mode === "move-files-folder") {
        await moveFilesToFolder(workspaceConfirmDialog.files, workspaceConfirmDialog.destinationPath, { skipDirtyCheck: true });
      }

      if (workspaceConfirmDialog.mode === "delete-folder") {
        await deleteFolder(workspaceConfirmDialog.folder);
      }

      if (workspaceConfirmDialog.mode === "delete-notebook") {
        await deleteNotebook(workspaceConfirmDialog.notebook);
      }

      if (workspaceConfirmDialog.mode === "remove-folder") {
        await removeLinkedFolder(workspaceConfirmDialog.notebook);
      }

      if (workspaceConfirmDialog.mode === "move-file-node") {
        await moveFileNode(
          workspaceConfirmDialog.file,
          workspaceConfirmDialog.destinationNotebook,
          workspaceConfirmDialog.destinationName,
          { skipDirtyCheck: true },
        );
      }

      if (workspaceConfirmDialog.mode === "replace-disk-version") {
        const outcome = await saveTabText(workspaceConfirmDialog.tabId, { replaceDisk: true });
        if (outcome === "saved") {
          const tab = tabsRef.current.find((item) => item.id === workspaceConfirmDialog.tabId);
          if (tab) {
            await savePendingFor(tab);
            await refreshTree(tab.file.notebook);
          }
        }
      }

      if (workspaceConfirmDialog.mode === "move-file-folder") {
        await moveFileToFolder(
          workspaceConfirmDialog.file,
          workspaceConfirmDialog.destinationPath,
          { skipDirtyCheck: true },
        );
      }

      setWorkspaceConfirmDialog(null);
    } finally {
      setWorkspaceConfirmDialogSubmitting(false);
    }
  }

  function startUpload(notebook: string) {
    setUploadNotebook(notebook);

    if (uploadInputRef.current) {
      uploadInputRef.current.value = "";
      uploadInputRef.current.click();
    }
  }

  async function uploadFilesToNotebook(
    notebook: string,
    files: File[],
    destinationPath?: string,
  ) {
    await uploadFiles(notebook, files, destinationPath);
  }

  /** Uploads files into a notebook folder (the root by default) and resolves to the uploaded files. */
  async function uploadFiles(
    notebook: string,
    files: File[],
    destinationPath?: string,
    options?: { throwOnError?: boolean },
  ): Promise<LiberaFileNode[]> {
    if (!files.length) {
      return [];
    }

    const formData = new FormData();
    formData.append("notebook", notebook);

    if (destinationPath) {
      formData.append("destinationPath", destinationPath);
    }

    files.forEach((file) => formData.append("files", file));

    try {
      const payload = await workspaceFileRequest<{ tree: LiberaTree; uploaded: LiberaFileNode[]; error?: string }>("/api/uploads", {
        method: "POST",
        body: formData,
      }, (payload) => ({ paths: payload.uploaded.map((file) => file.path) }));
      await applyCompleteTree(payload.tree);
      updateExpanded((current) => {
        const next = new Set(current).add(notebook);

        if (destinationPath) {
          next.add(destinationPath);
        }

        return next;
      });
      setSelectedNotebookName(notebook);
      if (payload.error) setWorkspaceError(payload.error);
      return payload.uploaded;
    } catch (error) {
      if (options?.throwOnError) throw error;
      setWorkspaceError(error instanceof Error ? error.message : tRef.current("uploadFailedError"));
      return [];
    }
  }

  async function handleUploadChange() {
    const files = uploadInputRef.current?.files;

    if (!files?.length || !uploadNotebook) {
      return;
    }

    await uploadFilesToNotebook(uploadNotebook, Array.from(files));

    if (uploadInputRef.current) {
      uploadInputRef.current.value = "";
    }
  }

  function selectSearchResult(result: SearchResult) {
    sidebarSearch.reset();
    updateExpanded((current) => new Set(current).add(result.notebook));

    if (result.type === "file") {
      openFile(result.file);
    } else {
      selectNotebook(result.notebook);
    }
  }

  function selectNotebook(notebook: string) {
    setSelectedNotebookName(notebook);
    setActiveTabId("");
    updateExpanded((current) => new Set(current).add(notebook));
  }

  function toggleNotebook(notebook: string) {
    updateExpanded((current) => {
      const next = new Set(current);
      if (next.has(notebook)) {
        next.delete(notebook);
      } else {
        next.add(notebook);
      }
      return next;
    });
  }

  function swapTabs(sourceTabId: string, targetTabId: string) {
    if (sourceTabId === targetTabId) {
      return;
    }

    setTabs((currentTabs) => {
      const sourceIndex = currentTabs.findIndex((tab) => tab.id === sourceTabId);
      const targetIndex = currentTabs.findIndex((tab) => tab.id === targetTabId);

      if (sourceIndex < 0 || targetIndex < 0) {
        return currentTabs;
      }

      const nextTabs = [...currentTabs];
      [nextTabs[sourceIndex], nextTabs[targetIndex]] = [
        nextTabs[targetIndex],
        nextTabs[sourceIndex],
      ];
      return nextTabs;
    });
  }

  function activateTab(tabId: string) {
    if (tabId !== activeTabId) captureCanvasViewState();
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

    // Gallery photos, recordings in progress and app pages belong to no notebook file and stay out of recent files.
    if (tab && !isGalleryTab(tab) && !isRecordingTab(tab) && !isPageTab(tab)) {
      setSelectedNotebookName(tab.file.notebook);
      recordFileInteraction(tab.file);
    }

    setActiveTabId(tabId);
  }

  // The tab ids joined: effects that only follow which tabs are open key on this,
  // so a draft, caret or scroll publication does not rerun them.
  const tabIdsKey = useMemo(() => JSON.stringify(tabs.map((tab) => tab.id)), [tabs]);

  useEffect(() => {
    const openTabIds = new Set<string>(JSON.parse(tabIdsKey));

    activeTabHistoryRef.current = activeTabHistoryRef.current.filter((tabId) =>
      openTabIds.has(tabId),
    );

    if (!activeTabId || !openTabIds.has(activeTabId)) {
      return;
    }

    activeTabHistoryRef.current = [
      activeTabId,
      ...activeTabHistoryRef.current.filter((tabId) => tabId !== activeTabId),
    ];
  }, [activeTabId, tabIdsKey]);

  // The window listeners below stay installed; they read the latest tabs and
  // handlers from here instead of being removed and added on every publication.
  const latestShortcutState = useRef({ tabs, activeTabId, closeTab });
  useLayoutEffect(() => {
    latestShortcutState.current = { tabs, activeTabId, closeTab };
  });

  useEffect(() => {
    function activateShortcutTab(tabId: string) {
      const tab = latestShortcutState.current.tabs.find((currentTab) => currentTab.id === tabId);

      if (tab && !isGalleryTab(tab) && !isRecordingTab(tab) && !isPageTab(tab)) {
        const interactedAt = new Date().toISOString();

        setSelectedNotebookName(tab.file.notebook);
        setFileInteractions((current) => {
          const nextInteractions = {
            ...current,
            [tab.file.path]: interactedAt,
          };

          window.localStorage.setItem(
            FILE_INTERACTIONS_STORAGE_KEY,
            JSON.stringify(nextInteractions),
          );

          return nextInteractions;
        });
      }

      setActiveTabId(tabId);
    }

    function cycleOrderedTab() {
      const { tabs, activeTabId } = latestShortcutState.current;

      if (!tabs.length) {
        return;
      }

      const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
      const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % tabs.length;

      activateShortcutTab(tabs[nextIndex].id);
    }

    function toggleRecentTab() {
      const { tabs, activeTabId } = latestShortcutState.current;
      const openTabIds = new Set(tabs.map((tab) => tab.id));
      const recentTabId = activeTabHistoryRef.current.find(
        (tabId) => tabId !== activeTabId && openTabIds.has(tabId),
      );

      if (recentTabId) {
        activateShortcutTab(recentTabId);
        return;
      }

      cycleOrderedTab();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.key !== "Tab") {
        return;
      }

      event.preventDefault();

      if (event.shiftKey) {
        cycleOrderedTab();
      } else {
        toggleRecentTab();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "w"
      ) {
        return;
      }

      event.preventDefault();

      const { activeTabId, closeTab } = latestShortcutState.current;

      if (activeTabId) {
        closeTab(activeTabId);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    function protectUnsavedDrafts(event: BeforeUnloadEvent) {
      const { tabs } = latestShortcutState.current;
      if (tabs.some((tab) => !isSharedRegistryTab(tab.id) && getTabDraft(tab) !== tab.saved) || pendingSaves.anyDirty(tabs.map((tab) => tab.file.path)) || getSharedDocRegistry().unconfirmedDocumentCount() > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", protectUnsavedDrafts);
    return () => window.removeEventListener("beforeunload", protectUnsavedDrafts);
  }, []);

  // Every draft publication and view-state report re-renders the shell, and the
  // functions above are new on each render. These forward to the latest ones
  // under an identity that never changes, so memoized children are not woken.
  // Left out: functions someone calls while rendering (unsavedTabsUnder), the
  // review provider's draft readers and the agent bridge.
  const stable = useStableHandlers({
    createUntitledFile,
    closeSaveDraftDialog,
    submitSaveDraft,
    saveChatToNotebook,
    openDirectory,
    openFileFromDisk,
    closeDirectory,
    closeOtherTabs,
    closeTab,
    closeNotebookDialog,
    closeNotebookGroupDialog,
    closeNoteDialog,
    closeWorkspaceConfirmDialog,
    closeWorkspaceInputDialog,
    archiveFileNode,
    archiveFolderNode,
    cancelScreenshotSnip,
    completeScreenshotSnip,
    finishVisualInsertion,
    createMarkdownBesidePdf,
    writeConvertedMarkdown,
    copyFileFromPrompt,
    createFolderFromPrompt,
    createMarkdownFromPrompt,
    createMarkdownSlidesFromPrompt,
    createLatexFromPrompt,
    createTextFileFromPrompt,
    deleteFileFromPrompt,
    deleteFolderFromPrompt,
    deleteNotebookGroup,
    downloadAnnotatedPdf,
    downloadFile,
    downloadMarkdownPdf,
    duplicateMarkdown,
    deleteNotebookFromPrompt,
    downloadNotebook,
    convertImageToMarkdownWithAi,
    formatSelectionWithAi,
    rewriteSelectionWithAi,
    writeWithAiAt,
    refreshTree,
    handleLogin,
    handleLogout,
    handleUploadChange,
    uploadFilesToNotebook,
    uploadFiles,
    insertMarkdownFileLink,
    insertMarkdownFileLinkPlaceholder,
    insertExistingMarkdownImage,
    insertMarkdownImage,
    insertMarkdown,
    shiftMarkdownList,
    insertCitation,
    insertBibliographyMarker,
    insertMarkdownTable,
    moveFileFromPrompt,
    moveFileToFolder,
    moveFilesToFolder,
    moveFilesFromPrompt,
    deleteFileNodesFromPrompt,
    openFile,
    openGalleryPhoto,
    openRecordingTab,
    openPageTab,
    renameRecordingTab,
    replaceRecordingTab,
    closeRecordingTab,
    showImageInTab,
    saveEditedImageCopy,
    openMarkdownFileLink,
    listMarkdownSelectionLinks,
    openCreateNotebookDialog,
    openMigrationDialog,
    closeMigrationDialog,
    saveTabsBeforeMigration,
    runNotebookMigration,
    resumeNotebookMigration,
    applyUnacknowledgedMigration,
    openCreateNotebookGroupDialog,
    openEditNotebookDialog,
    openEditNotebookGroupDialog,
    deleteFileNodeFromPrompt,
    renameFolderFromPrompt,
    renameFileNodeFromPrompt,
    renameFileFromPrompt,
    saveActiveTab,
    selectSearchResult,
    selectNotebook,
    setActiveDraft,
    setTabDraft,
    applyCitationRewriteToTab,
    revertCitationRewriteInTab,
    setActiveTabId: activateTab,
    startScreenshotSnip,
    swapTabs,
    startUpload,
    submitNotebookDialog,
    submitNotebookGroupDialog,
    submitNoteDialog,
    submitWorkspaceConfirmDialog,
    submitWorkspaceInputDialog,
    toggleFileStar,
    toggleNotebook,
    updateNotebookViewOptions,
    changeNotebookIllustration,
    openFileTagsDialog,
    closeFileTagsDialog,
    saveFileTags,
  });

  return {
    authenticated,
    workspace: {
      ...stable,
      saveDraftTab: tabs.find((tab) => tab.id === saveDraftTabId),
      saveDraftError,
      saveDraftSubmitting,
      activeTab,
      activeTabId,
      authError,
      aiFormatting,
      busy,
      canStartScreenshotSnip,
      expanded,
      firstNotebook,
      notebookDialog,
      notebookDialogSubmitting,
      notebookGroupDialog,
      notebookGroupDialogSubmitting,
      noteDialog,
      noteDialogSubmitting,
      imageMarkdownConverting,
      password,
      sidebarSearch,
      fileInteractions,
      files,
      recentFiles,
      screenshotSnipSession,
      pendingVisualInsertions,
      selectedNotebook,
      selectedNotebookName,
      tabs,
      textareaRef,
      tree: visibleTree,
      fullTree: tree,
      canOpenDirectories,
      workspaceManager,
      uploadInputRef,
      workspaceConfirmDialog,
      workspaceConfirmDialogSubmitting,
      workspaceInputDialog,
      workspaceInputDialogSubmitting,
      fileTagsDialog: fileTagsDialogFile
        ? { file: fileTagsDialogFile, error: fileTagsDialogError, submitting: fileTagsDialogSubmitting }
        : null,
      workspaceError,
      referenceMoveNotice,
      dismissReferenceMoveNotice,
      activeMarkdownDraft: activeTab?.file.fileType === "markdown" ? activeTab.draft : null,
      migrationDialogSource,
      migrationPreset,
      unsavedTabsUnder,
      isSharedTab,
      sharedTabIds,
      canvas,
      registerEditorDraft,
      getReviewDraft,
      recoverReviewDraft,
      applyReviewDraft,
      readOpenTabDraft,
      syncTabFromDisk,
      restoreTabAfterUndo,
      replaceTabFromDisk,
      refreshAfterAgentChanges,
      setActiveTabViewState,
      setPassword,
    },
  };
}
