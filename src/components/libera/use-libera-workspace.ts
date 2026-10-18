"use client";
import { createMarkdownBoxInsertion, MARKDOWN_BOX_SHORTCUTS } from "@/lib/markdown-boxes";

import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isTextFileType } from "@/lib/types";
import type {
  LiberaFileNode,
  LiberaFilePayload,
  LiberaFolderNode,
  LiberaNotebookGroup,
  LiberaNotebookViewOptions,
  LiberaTree,
  LiberaTreeNode,
  PdfAnnotationsPayload,
} from "@/lib/types";
import { apiRequest, emptyTree, encodeFilePath } from "@/components/libera/api-client";
import { latestPdfAnnotations } from "@/components/libera/pdf-annotation-events";
import type {
  MarkdownFileLinkRange,
  MarkdownFileLinkSelection,
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
import { useMarkdownWindows } from "./use-markdown-windows";
import { useSavedWorkspaces } from "./use-saved-workspaces";
import { createDeferredSave, flushPendingState, registerStateFlusher } from "./deferred-save";
import { useCanvasLayout } from "./use-canvas-layout";
import { captureCanvasViewState } from "./canvas-view-state";
import { useGallery } from "./gallery-store";
import { createGalleryTab, isGalleryTab, reconcileGalleryTabs, type GalleryTabPlacement } from "./gallery-tabs";
import { focusedCanvasPane } from "@/lib/canvas-layout";
import type { GalleryPhoto } from "@/lib/image-generation";
import type { PhotoEdits } from "@/lib/photo-edits";
import type { ChatNotebookExport } from "./document-chat-export-dialog";
import { removeWorkspaceGroup, saveWorkspaceGroup, toggleWorkspaceStar, type WorkspaceFileChange } from "@/lib/workspaces";
import { replaceTextareaSelectionWithUndo } from "@/lib/textarea-editing";
import { findMarkdownBlockInsertionOffset, insertMarkdownBlock } from "@/lib/ai-write";
import {
  ensureDocumentOcrModel,
  readImageAsMarkdown,
  resolvePicturePlaceholders,
} from "@/components/libera/document-ocr/document-ocr-client";
import type { MathMarkerSettings } from "@/lib/math-markers";

// Snips are read at the model's own page scale (up to four 512 px tiles across).
const SNIP_MAX_EDGE = 2048;
import { readIncludeDocumentContext } from "./ai-document-context-preference";
import { latexDocumentTemplate } from "@/lib/latex/project";
import type { AiFeature, Provenance } from "@/lib/collab/protocol/actor";
import { useSharedTabs } from "@/lib/collab/bindings/react-shared-tabs";
import { applyTextToSession, applyTextToShared } from "@/lib/collab/client/apply-text";
import { getSharedDocRegistry, type SharedDocSession } from "@/lib/collab/client/registry";
import { isTabDirty, journalTab, mayTakeContentFromDisk, readTabDraft, type DraftWriteOptions } from "@/lib/collab/client/workspace";
import { aiSuggestionNotice, suggestAiOnSharedTab } from "@/lib/collab/client/suggestions-ai";
import type { SnapshotEdit } from "@/lib/collab/suggestions/model";

const TYPING: Provenance = { source: "typing" };
/** Module-level, so the close and unload callbacks need no extra hook dependency. Shared tabs are never dirty. */
const isSharedRegistryTab = (tabId: string) => getSharedDocRegistry().isSharedTab(tabId);
const PASTE: Provenance = { source: "paste" };

function collectFileSearchResults(
  nodes: LiberaTreeNode[],
  notebook: string,
  normalizedQuery: string,
  results: SearchResult[],
) {
  for (const node of nodes) {
    if (node.kind === "folder") {
      collectFileSearchResults(node.children, notebook, normalizedQuery, results);
      continue;
    }

    if (node.name.toLowerCase().includes(normalizedQuery)) {
      results.push({
        type: "file",
        notebook,
        file: node,
        label: node.path,
      });
    }
  }
}


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
      .trim() || "Untitled"
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
    "$template = \"default\"",
    "$fontsize = 21",
    "---",
    "$title = \"First Slide\"",
    "",
    "Start your slide content here.",
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
    image: patchViewState.image
      ? { ...currentViewState?.image, ...patchViewState.image }
      : currentViewState?.image,
    latex: patchViewState.latex
      ? { ...currentViewState?.latex, ...patchViewState.latex }
      : currentViewState?.latex,
    markdown: patchViewState.markdown
      ? { ...currentViewState?.markdown, ...patchViewState.markdown }
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

export function useLiberaWorkspace(initialAuthenticated: boolean) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [saveDraftTabId, setSaveDraftTabId] = useState<string | null>(null);
  const [saveDraftError, setSaveDraftError] = useState("");
  const [saveDraftSubmitting, setSaveDraftSubmitting] = useState(false);
  const savingDraftRef = useRef(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [tree, setTree] = useState<LiberaTree>(emptyTree);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  // The latest tabs, for work that finishes after a render, like reading a snip.
  const tabsRef = useRef<OpenTab[]>([]);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const [activeTabId, setActiveTabId] = useState("");
  const [selectedNotebookName, setSelectedNotebookName] = useState("");
  const notebookSelectionWriter = useMemo(() => createDeferredSave((body) => apiRequest("/api/preferences/last-notebook", {
    method: "PUT", body, keepalive: !window.liberaPersistence,
  }), (error) => setWorkspaceError(error instanceof Error ? error.message : "Could not remember the last notebook.")), []);
  const [query, setQuery] = useState("");
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
  const sharedTabIds = useSharedTabs(tabs, { onText: mirrorSharedText, onAttached: adoptPendingDraft });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const openingFilePathsRef = useRef<Set<string>>(new Set());
  const pendingOpenViewStateByPathRef = useRef<Record<string, OpenTabViewState | undefined>>({});
  const expandedRef = useRef<Set<string>>(new Set());
  const treeLoadedRef = useRef(false);
  const expansionWriter = useMemo(() => createDeferredSave((body) => apiRequest("/api/notebook-panel-expansion", {
    method: "PATCH", body, keepalive: !window.liberaPersistence,
  }), (error) => setWorkspaceError(error instanceof Error ? error.message : "Could not save notebook panel expansion state.")), []);
  useEffect(() => {
    const unregister = registerStateFlusher(() => Promise.all([notebookSelectionWriter.flush(), expansionWriter.flush()]));
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
    activeTabId, selectedNotebookName, expandedPaths: [...expanded], canvasLayout,
  }), [tabs, sharedTabIds, activeTabId, selectedNotebookName, expanded, canvasLayout]);
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
      canvas.restore(session.canvasLayout, session.tabs.map((tab) => tab.id), session.activeTabId);
      setSelectedNotebookName(session.selectedNotebookName);
      applyExpanded(new Set(session.expandedPaths));
      setQuery("");
      setScreenshotSnipSession(null);
      setSaveDraftTabId(null);
    },
  });
  const visibleTree = workspaceManager.visibleTree;
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

  const searchResults = useMemo<SearchResult[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return [];
    }

    const results: SearchResult[] = [];

    for (const notebook of visibleTree.notebooks) {
      if (notebook.name.toLowerCase().includes(normalizedQuery)) {
        results.push({
          type: "notebook",
          notebook: notebook.name,
          label: notebook.name,
        });
      }

      collectFileSearchResults(notebook.children, notebook.name, normalizedQuery, results);
    }

    return results.slice(0, 12);
  }, [query, visibleTree]);

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

  function workspaceFileRequest<T>(url: string, init: RequestInit, describe: (result: T) => WorkspaceFileChange) {
    return workspaceManager.runFileChange(() => apiRequest<T>(url, init), describe);
  }

  async function applyCompleteTree(nextTree: LiberaTree) {
    // Mutation responses use library visibility. Keep the full file tree so a
    // workspace can show archives independently without changing library settings.
    if (nextTree.archiveIncluded === false) {
      try { nextTree = await apiRequest<LiberaTree>("/api/tree?includeArchive=true"); }
      catch (error) { setWorkspaceError(error instanceof Error ? error.message : "Could not refresh archived files."); }
    }
    setTree(nextTree);
  }

  async function refreshTree(expandNotebook?: string) {
    const nextTree = await apiRequest<LiberaTree>("/api/tree?includeArchive=true");
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

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    refreshTree().catch((error: Error) => setWorkspaceError(error.message));
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || !selectedNotebookName) return;
    // Covers notebook homes, file opens, tab switches, and notebook renames.
    notebookSelectionWriter.schedule({ notebook: selectedNotebookName }, 5000);
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
      setWorkspaceError(error instanceof Error ? error.message : "Could not open the folder.");
      return null;
    }
  }

  async function openFileByPath(filePath: string, sourceTree: LiberaTree) {
    const file = sourceTree.notebooks
      .flatMap((notebook) => collectFiles(notebook.children))
      .find((candidate) => candidate.path === filePath);

    if (!file) {
      setWorkspaceError("That file is hidden in its folder, so Libera cannot open it.");
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
      setWorkspaceError(error instanceof Error ? error.message : "Could not remove the folder.");
    }
  }

  async function clearRecentDirectories() {
    try {
      await apiRequest("/api/directory", { method: "POST", body: JSON.stringify({ action: "clear-recent" }) });
      await window.liberaDirectory?.notifyChanged();
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not clear recent folders.");
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
    setBusy(true);
    setAuthError("");

    try {
      await apiRequest<{ authenticated: true }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setAuthenticated(true);
      setPassword("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    try { await workspaceManager.checkpoint(); await flushPendingState(); }
    catch { setWorkspaceError("Could not save your workspace. Please try signing out again."); return; }
    await apiRequest<{ authenticated: false }>("/api/auth/logout", {
      method: "POST",
    }).catch(() => null);
    setAuthenticated(false);
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
    applyTextToSession(session, draft, TYPING, tab.saved);
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
      const error = result.reason === "read-only" ? "This shared document is read-only for you." : "This shared document is still opening.";
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
      const pendingViewState = pendingOpenViewStateByPathRef.current[file.path];
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
      showOpenedTab(nextTab.id, placement);
      recordFileInteraction(payload.file);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not open file.");
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

  // Steps an image tab to another image in its folder, in place: the tab keeps
  // its position and panel instead of a new tab opening for every photo.
  function showImageInTab(tabId: string, file: LiberaFileNode) {
    if (file.fileType !== "image" || tabId === file.path) {
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
    const resolvedLink = resolveMarkdownFileLink(href, sourcePath, files);

    if (!resolvedLink) {
      return false;
    }

    await openFile(resolvedLink.file, {
      viewState: resolvedLink.metadata?.viewState,
    });
    return true;
  }

  const closeTabsWithoutConfirm = useCallback((tabIds: string[]) => {
    const closingTabIds = new Set(tabIds);

    if (!closingTabIds.size) {
      return;
    }

    const closingTabs = tabs.filter((currentTab) => closingTabIds.has(currentTab.id));

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
  const galleryContents = useGallery().contents;
  useEffect(() => {
    if (!galleryContents) return;
    const reconciled = reconcileGalleryTabs(tabs, galleryContents.photos);
    if (reconciled.tabs !== tabs) {
      const changed = new Map(reconciled.tabs.map((tab) => [tab.id, tab]));
      setTabs((currentTabs) => currentTabs.map((tab) => isGalleryTab(tab) ? changed.get(tab.id) ?? tab : tab));
    }
    if (reconciled.closedTabIds.length) closeTabsWithoutConfirm(reconciled.closedTabIds);
  }, [closeTabsWithoutConfirm, galleryContents, tabs]);

  const closeTab = useCallback((tabId: string) => {
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

    if (tab && !isSharedRegistryTab(tab.id) && getTabDraft(tab) !== tab.saved) {
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

    const dirtyTabCount = otherTabs.filter((currentTab) => !isSharedRegistryTab(currentTab.id) && getTabDraft(currentTab) !== currentTab.saved).length;
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
    if (!tab) throw new Error("The review document is no longer open.");
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
    const markdownSelectionStart = viewState.markdown?.selectionStart;
    const line =
      targetTab?.file.fileType === "markdown" &&
      typeof markdownSelectionStart === "number"
        ? lineForOffset(getTabDraft(targetTab), markdownSelectionStart)
        : viewState.markdown?.line ?? (selection.file.fileType === "markdown" ? 1 : undefined);

    return {
      fileType: selection.file.fileType,
      line,
      v: 1,
      viewState: {
        image:
          selection.file.fileType === "image"
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
                selectionEnd: viewState.markdown?.selectionEnd,
                selectionStart: viewState.markdown?.selectionStart,
                slideIndex: viewState.markdown?.slideIndex,
                zoom: viewState.markdown?.zoom,
              }
            : undefined,
        pdf:
          selection.file.fileType === "pdf"
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

    const destination = createMarkdownFileLinkDestination({
      metadata: createMarkdownFileLinkMetadata(selection),
      sourcePath: activeTab.file.path,
      targetPath: selection.file.path,
    });
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
        : `[${selection.file.name}](${destination})`;
    const nextDraft = `${draft.slice(0, start)}${replacement}${draft.slice(end)}`;
    const nextSelectionStart = hasLinkShell ? start : start + 1;
    const nextSelectionEnd = hasLinkShell
      ? start + destination.length
      : start + 1 + selection.file.name.length;

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
        reader.onerror = () => reject(new Error("Could not read image."));
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
        error: error instanceof Error ? error.message : "Could not insert image.",
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
        error: "Only image files can be inserted.",
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
        error: "Open an image or PDF tab before using the snipping tool.",
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

  function queueVisualInsertion(tabId: string, markdown: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPendingVisualInsertions((current) => ({ ...current, [tabId]: { id, markdown } }));
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
      if (!markdown.trim()) throw new Error("No text was found in the snip.");

      const selection = insertSnipMarkdown(session, markdown);
      returnToSnipTarget(session, selection);
    } catch (error) {
      if (controller.signal.aborted) return;
      updateTab(session.targetTabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : "Could not read the snip.",
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
        error: error instanceof Error ? error.message : "Could not insert screenshot.",
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

    setAiFormatting(true);
    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ formattedText: string }>("/api/ai-format", {
        method: "POST",
        body: JSON.stringify({ text: selectedText }),
      });
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
      updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : "AI formatting failed.",
      }));
    } finally {
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

    setAiFormatting(true);
    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ rewrittenText: string }>("/api/ai-rewrite", {
        method: "POST",
        body: JSON.stringify({
          text: selectedText,
          prompt,
          ...(readIncludeDocumentContext()
            ? { before: draft.slice(0, selection.start), after: draft.slice(selection.end) }
            : {}),
        }),
      });
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
      updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : "AI rewrite failed.",
      }));
    } finally {
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

    setAiFormatting(true);
    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ markdown: string }>("/api/ai-write", {
        method: "POST",
        body: JSON.stringify({
          prompt,
          ...(readIncludeDocumentContext() ? { before: draft.slice(0, position), after: draft.slice(position) } : {}),
        }),
      });
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
      updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : "Write with AI failed.",
      }));
    } finally {
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

    setImageMarkdownConverting(true);
    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ markdown: string }>("/api/ai-image-to-markdown", {
        method: "POST",
        body: JSON.stringify({
          documentPath: activeTab.file.path,
          imageSource: image.src,
          alt: image.alt,
        }),
      });
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
      updateTab(tabId, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : "AI image conversion failed.",
      }));
    } finally {
      setImageMarkdownConverting(false);
    }
  }

  function recoverReviewDraft(key: string, content: string) {
    if (!key.startsWith("draft:")) return;
    const id = key.slice(6);
    if (tabs.some((tab) => tab.id === id)) { setActiveTabId(id); return; }
    createUntitledFile("", undefined, { fileName: "Recovered review.md", content }, id);
  }

  function createUntitledFile(notebook = "", parentPath?: string, initial?: { fileName: string; content: string }, restoredId?: string) {
    const id = restoredId ?? `untitled-${crypto.randomUUID()}.md`;
    const now = new Date().toISOString();
    const tab: OpenTab = {
      id, untitled: true, saveDirectory: parentPath || notebook,
      file: { kind: "file", name: initial?.fileName ?? "Untitled.md", path: id, notebook: "",
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

  /** A new, empty Markdown file next to a PDF, named after it ("Paper.md", then "Paper (2).md", …). */
  async function createMarkdownBesidePdf(pdfPath: string): Promise<LiberaFileNode> {
    const parts = pdfPath.split("/");
    const directory = parts.slice(0, -1).join("/");
    const stem = (parts.at(-1) ?? "Document").replace(/\.pdf$/i, "") || "Document";

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

    throw new Error(`Could not find a free name for ${stem}.md.`);
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
      setSaveDraftError("Enter a file name without slashes.");
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
      setSaveDraftError(error instanceof Error ? error.message : "Save failed.");
    } finally {
      savingDraftRef.current = false;
      setSaveDraftSubmitting(false);
    }
  }

  async function saveActiveTab() {
    if (!activeTab || !isTextFileType(activeTab.file.fileType)) {
      return;
    }

    // Shared tabs have no Save: every edit is already on this device. Show
    // the status pill's detail instead (map §6).
    if (isSharedTab(activeTab.id)) {
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
        updateTab(activeTab.id, (tab) => ({ ...tab, status: "error", error: error instanceof Error ? error.message : "Save failed." }));
      } finally { savingDraftRef.current = false; }
      return;
    }

    if (activeTab.untitled) {
      setSaveDraftError("");
      setSaveDraftTabId(activeTab.id);
      return;
    }

    const draft = getTabDraft(activeTab);

    if (draft === activeTab.saved && activeTab.status !== "error") {
      return;
    }

    updateTab(activeTab.id, (tab) => ({ ...tab, status: "saving", error: undefined }));

    try {
      const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: activeTab.file.path,
          content: draft,
        }),
      }, (payload) => ({ paths: [payload.file.path] }));

      const latestDraft = getTabDraft(activeTab);
      updateTab(activeTab.id, (tab) => ({
        ...tab,
        file: payload.file,
        saved: draft,
        status: latestDraft === draft ? "clean" : "dirty",
      }));
      await refreshTree(activeTab.file.notebook);
    } catch (error) {
      updateTab(activeTab.id, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : "Save failed.",
      }));
    }
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

  async function submitNotebookDialog(values: NotebookFormValues) {
    if (!notebookDialog) {
      return;
    }

    const nextName = values.name.trim();

    if (!nextName) {
      setNotebookDialogError("Notebook name is required.");
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
        error instanceof Error ? error.message : "Could not save notebook.",
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
      setNotebookGroupDialogError("Group title is required.");
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
        error instanceof Error ? error.message : "Could not save group.",
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
      setWorkspaceError(error instanceof Error ? error.message : "Could not delete group.");
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
      setWorkspaceError(error instanceof Error ? error.message : "Could not update star.");
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
      setFileTagsDialogError(error instanceof Error ? error.message : "Could not save tags.");
    } finally {
      setFileTagsDialogSubmitting(false);
    }
  }

  async function deleteNotebookFromPrompt(notebook: string) {
    setWorkspaceConfirmDialog({ mode: "delete-notebook", notebook });
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
      setWorkspaceError(error instanceof Error ? error.message : "Could not delete notebook.");
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
      setWorkspaceError("Export to PDF is available in the Libera desktop app.");
      return;
    }

    try {
      await exporter({
        content: getTabDraft(tab),
        documentPath: tab.file.path,
        fileName: markdownPdfFileName(tab.file.name),
        title: markdownExportBaseName(tab.file.name),
      });
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "PDF export failed.");
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
            throw new Error("Could not read the PDF.");
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
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not export the annotated PDF.");
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

  async function submitNoteDialog(values: NoteFormValues) {
    if (!noteDialog) {
      return;
    }

    const requestedName = values.name.trim();

    if (!requestedName) {
      setNoteDialogError("Note name is required.");
      return;
    }

    const name =
      noteDialog.mode === "slides"
        ? ensureMarkdownSlidesName(requestedName)
        : noteDialog.mode === "latex" && !/\.(tex|bib|sty|cls)$/i.test(requestedName)
          ? `${requestedName.replace(/\.$/, "")}.tex`
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
      setNoteDialogError(error instanceof Error ? error.message : "Could not create note.");
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
      throw new Error(error instanceof Error ? error.message : "Could not create folder.");
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
      throw new Error(error instanceof Error ? error.message : "Could not copy file.");
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

  async function moveFileNode(
    file: LiberaFileNode,
    destinationNotebook: string,
    destinationName: string,
    options?: { skipDirtyCheck?: boolean },
  ) {
    const openTab = tabs.find((tab) => tab.file.path === file.path);

    if (openTab?.status === "dirty" && !options?.skipDirtyCheck) {
      setWorkspaceConfirmDialog({
        mode: "move-file-node",
        file,
        destinationNotebook,
        destinationName,
      });
      return;
    }

    try {
      const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          destinationNotebook,
          destinationName,
        }),
      }, (payload) => ({ paths: [payload.file.path], moved: { from: file.path, to: payload.file.path } }));
      const nextId = payload.file.path;
      if (openTab) {
        const draft = getTabDraft(openTab);

        forgetTabDraft(openTab.id);
        rememberTabDraft(nextId, draft);
      }
      setTabs((currentTabs) =>
        currentTabs.map((currentTab) =>
          currentTab.file.path === file.path
            ? {
                ...currentTab,
                id: nextId,
                draft: latestDraftByTabIdRef.current[nextId] ?? currentTab.draft,
                file: payload.file,
                rawUrl: payload.rawUrl ?? `/api/files/raw/${encodeFilePath(nextId)}`,
              }
            : currentTab,
        ),
      );
      setActiveTabId((current) => (current === file.path ? nextId : current));
      await refreshTree(payload.file.notebook);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not move file.");
    }
  }

  async function moveFileToFolder(
    file: LiberaFileNode,
    destinationPath: string,
    options?: { skipDirtyCheck?: boolean },
  ) {
    const normalizedDestination = destinationPath.trim();
    const openTab = tabs.find((tab) => tab.file.path === file.path);

    if (!normalizedDestination || normalizedDestination === parentPathForFile(file)) {
      return;
    }

    if (openTab?.status === "dirty" && !options?.skipDirtyCheck) {
      setWorkspaceConfirmDialog({
        mode: "move-file-folder",
        file,
        destinationPath: normalizedDestination,
      });
      return;
    }

    try {
      const payload = await workspaceFileRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          destinationDirectory: normalizedDestination,
        }),
      }, (payload) => ({ paths: [payload.file.path], moved: { from: file.path, to: payload.file.path } }));
      const nextId = payload.file.path;

      if (openTab) {
        const draft = getTabDraft(openTab);

        forgetTabDraft(openTab.id);
        rememberTabDraft(nextId, draft);
      }
      setTabs((currentTabs) =>
        currentTabs.map((currentTab) =>
          currentTab.file.path === file.path
            ? {
                ...currentTab,
                id: nextId,
                draft: latestDraftByTabIdRef.current[nextId] ?? currentTab.draft,
                file: payload.file,
                rawUrl: payload.rawUrl ?? `/api/files/raw/${encodeFilePath(nextId)}`,
              }
            : currentTab,
        ),
      );
      setActiveTabId((current) => (current === file.path ? nextId : current));
      await refreshTree(payload.file.notebook);
      updateExpanded((current) => {
        const next = new Set(current);
        next.add(normalizedDestination.split("/")[0] ?? normalizedDestination);
        next.add(normalizedDestination);
        return next;
      });
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not move file.");
    }
  }

  async function deleteFileFromPrompt(tab: OpenTab) {
    if (tab.untitled) { closeTab(tab.id); return; }
    await deleteFileNodeFromPrompt(tab.file);
  }

  async function deleteFileNodeFromPrompt(file: LiberaFileNode) {
    setWorkspaceConfirmDialog({ mode: "delete-file", file });
  }

  async function deleteFileNode(file: LiberaFileNode) {
    try {
      await workspaceFileRequest<LiberaTree>(`/api/files?path=${encodeURIComponent(file.path)}`, {
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
      setWorkspaceError(error instanceof Error ? error.message : "Could not delete file.");
    }
  }

  async function archiveFileNode(file: LiberaFileNode) {
    const openTab = tabs.find((tab) => tab.file.path === file.path);

    if (openTab?.status === "dirty") {
      setWorkspaceError("Save or close the file before archiving it.");
      return;
    }

    try {
      await workspaceFileRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          archive: true,
        }),
      }, (payload) => ({ moved: { from: file.path, to: payload.file.path } }));
      forgetTabDraft(file.path);
      setTabs((currentTabs) =>
        currentTabs.filter((currentTab) => currentTab.file.path !== file.path),
      );
      setActiveTabId((current) => (current === file.path ? "" : current));
      await refreshTree(file.notebook);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not archive file.");
    }
  }

  async function renameFolderFromPrompt(folder: LiberaFolderNode) {
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "rename-folder", folder });
  }

  async function renameFolder(folder: LiberaFolderNode, name: string) {
    const parentPath = folder.path.split("/").slice(0, -1).join("/");
    const nextPath = `${parentPath}/${name}`;

    try {
      const nextTree = await workspaceFileRequest<LiberaTree>("/api/folders", {
        method: "PATCH",
        body: JSON.stringify({
          path: folder.path,
          name,
        }),
      }, () => ({ moved: { from: folder.path, to: nextPath } }));
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
      setTabs((currentTabs) =>
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
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Could not rename folder.");
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
          setWorkspaceInputDialogError("Folder name is required.");
          return;
        }

        await createFolder(workspaceInputDialog.parentPath, name);
      }

      if (workspaceInputDialog.mode === "copy-file") {
        const destinationDirectory = values.destinationDirectory.trim();
        const destinationName = values.destinationName.trim();

        if (!destinationDirectory) {
          setWorkspaceInputDialogError("Destination path is required.");
          return;
        }

        if (!destinationName) {
          setWorkspaceInputDialogError("Copy file name is required.");
          return;
        }

        await copyFile(workspaceInputDialog.file, destinationDirectory, destinationName);
      }

      if (workspaceInputDialog.mode === "move-file") {
        const destinationDirectory = values.destinationDirectory.trim();

        if (!destinationDirectory) {
          setWorkspaceInputDialogError("Destination path is required.");
          return;
        }

        await moveFileToFolder(workspaceInputDialog.file, destinationDirectory);
      }

      if (workspaceInputDialog.mode === "rename-file") {
        const name = values.name.trim();

        if (!name) {
          setWorkspaceInputDialogError("File name is required.");
          return;
        }

        if (name !== workspaceInputDialog.file.name) {
          await moveFileNode(workspaceInputDialog.file, workspaceInputDialog.file.notebook, name);
        }
      }

      if (workspaceInputDialog.mode === "rename-folder") {
        const name = values.name.trim();

        if (!name) {
          setWorkspaceInputDialogError("Folder name is required.");
          return;
        }

        if (name !== workspaceInputDialog.folder.name) {
          await renameFolder(workspaceInputDialog.folder, name);
        }
      }

      setWorkspaceInputDialog(null);
    } catch (error) {
      setWorkspaceInputDialogError(
        error instanceof Error ? error.message : "Could not save changes.",
      );
    } finally {
      setWorkspaceInputDialogSubmitting(false);
    }
  }

  async function deleteFolderFromPrompt(folder: LiberaFolderNode) {
    setWorkspaceConfirmDialog({ mode: "delete-folder", folder });
  }

  async function deleteFolder(folder: LiberaFolderNode) {
    try {
      const nextTree = await workspaceFileRequest<LiberaTree>(
        `/api/folders?path=${encodeURIComponent(folder.path)}`,
        { method: "DELETE" },
        () => ({ removed: [folder.path] }),
      );
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
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not delete folder.");
    }
  }

  async function archiveFolderNode(folder: LiberaFolderNode) {
    const dirtyTabCount = tabs.filter(
      (tab) => isPathWithinPrefix(tab.file.path, folder.path) && tab.status === "dirty",
    ).length;

    if (dirtyTabCount > 0) {
      setWorkspaceError("Save or close files in the folder before archiving it.");
      return;
    }

    try {
      const nextTree = await workspaceFileRequest<LiberaTree & { moved: { from: string; to: string } }>("/api/folders", {
        method: "PATCH",
        body: JSON.stringify({
          path: folder.path,
          archive: true,
        }),
      }, (result) => ({ moved: result.moved, paths: [result.moved.to] }));
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
        if (isPathWithinPrefix(tab.file.path, folder.path)) {
          forgetTabDraft(tab.id);
        }
      });
      setTabs((currentTabs) =>
        currentTabs.filter((currentTab) => !isPathWithinPrefix(currentTab.file.path, folder.path)),
      );
      setActiveTabId((current) => (isPathWithinPrefix(current, folder.path) ? "" : current));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not archive folder.");
    }
  }

  async function submitWorkspaceConfirmDialog() {
    if (!workspaceConfirmDialog) {
      return;
    }

    setWorkspaceConfirmDialogSubmitting(true);

    try {
      if (workspaceConfirmDialog.mode === "close-tab") {
        closeTabWithoutConfirm(workspaceConfirmDialog.tabId);
      }

      if (workspaceConfirmDialog.mode === "close-tabs") {
        closeTabsWithoutConfirm(workspaceConfirmDialog.tabIds);
      }

      if (workspaceConfirmDialog.mode === "delete-file") {
        await deleteFileNode(workspaceConfirmDialog.file);
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
    if (!files.length) {
      return;
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
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Upload failed.");
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
    setQuery("");
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

    // Gallery photos belong to no notebook and stay out of recent files.
    if (tab && !isGalleryTab(tab)) {
      setSelectedNotebookName(tab.file.notebook);
      recordFileInteraction(tab.file);
    }

    setActiveTabId(tabId);
  }

  useEffect(() => {
    const openTabIds = new Set(tabs.map((tab) => tab.id));

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
  }, [activeTabId, tabs]);

  useEffect(() => {
    function activateShortcutTab(tabId: string) {
      const tab = tabs.find((currentTab) => currentTab.id === tabId);

      if (tab && !isGalleryTab(tab)) {
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
      if (!tabs.length) {
        return;
      }

      const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
      const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % tabs.length;

      activateShortcutTab(tabs[nextIndex].id);
    }

    function toggleRecentTab() {
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
  }, [activeTabId, tabs]);

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

      if (activeTabId) {
        closeTab(activeTabId);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeTabId, closeTab]);

  useEffect(() => {
    function protectUnsavedDrafts(event: BeforeUnloadEvent) {
      if (tabs.some((tab) => !isSharedRegistryTab(tab.id) && getTabDraft(tab) !== tab.saved)) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", protectUnsavedDrafts);
    return () => window.removeEventListener("beforeunload", protectUnsavedDrafts);
  }, [tabs]);

  return {
    authenticated,
    workspace: {
      createUntitledFile,
      saveDraftTab: tabs.find((tab) => tab.id === saveDraftTabId),
      saveDraftError,
      saveDraftSubmitting,
      closeSaveDraftDialog,
      submitSaveDraft,
      saveChatToNotebook,
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
      query,
      fileInteractions,
      files,
      recentFiles,
      screenshotSnipSession,
      pendingVisualInsertions,
      searchResults,
      selectedNotebook,
      selectedNotebookName,
      tabs,
      textareaRef,
      tree: visibleTree,
      fullTree: tree,
      canOpenDirectories,
      openDirectory,
      openFileFromDisk,
      closeDirectory,
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
      insertMarkdownFileLink,
      insertMarkdownFileLinkPlaceholder,
      insertExistingMarkdownImage,
      insertMarkdownImage,
      insertMarkdown,
      moveFileFromPrompt,
      moveFileToFolder,
      openFile,
      openGalleryPhoto,
      showImageInTab,
      saveEditedImageCopy,
      openMarkdownFileLink,
      openCreateNotebookDialog,
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
      refreshAfterAgentChanges,
      setActiveTabId: activateTab,
      setActiveTabViewState,
      setPassword,
      setQuery,
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
      openFileTagsDialog,
      closeFileTagsDialog,
      saveFileTags,
    },
  };
}
