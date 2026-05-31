"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LiberaFileNode,
  LiberaFilePayload,
  LiberaFolderNode,
  LiberaTree,
  LiberaTreeNode,
} from "@/lib/types";
import { apiRequest, emptyTree, encodeFilePath } from "@/components/libera/api-client";
import type {
  MarkdownFileLinkRange,
  MarkdownFileLinkSelection,
  MarkdownImageSelection,
  MarkdownScreenshotSnipSession,
  NotebookDialogState,
  NotebookFormValues,
  NoteDialogState,
  NoteFormValues,
  OpenTab,
  OpenTabViewState,
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

function imageAltText(name: string) {
  return name.replace(/\.[^.]+$/, "") || "image";
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
    markdown: patchViewState.markdown
      ? { ...currentViewState?.markdown, ...patchViewState.markdown }
      : currentViewState?.markdown,
    pdf: patchViewState.pdf
      ? { ...currentViewState?.pdf, ...patchViewState.pdf }
      : currentViewState?.pdf,
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

const FILE_INTERACTIONS_STORAGE_KEY = "libera.fileInteractions";

export function useLiberaWorkspace(initialAuthenticated: boolean) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [tree, setTree] = useState<LiberaTree>(emptyTree);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [selectedNotebookName, setSelectedNotebookName] = useState("");
  const [query, setQuery] = useState("");
  const [fileInteractions, setFileInteractions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [aiFormatting, setAiFormatting] = useState(false);
  const [imageMarkdownConverting, setImageMarkdownConverting] = useState(false);
  const [screenshotSnipSession, setScreenshotSnipSession] =
    useState<MarkdownScreenshotSnipSession | null>(null);
  const [notebookDialog, setNotebookDialog] = useState<NotebookDialogState | null>(null);
  const [notebookDialogSubmitting, setNotebookDialogSubmitting] = useState(false);
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
  const [workspaceError, setWorkspaceError] = useState("");
  const [uploadNotebook, setUploadNotebook] = useState("");
  const activeTabHistoryRef = useRef<string[]>([]);
  const latestDraftByTabIdRef = useRef<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const firstNotebook = tree.notebooks[0]?.name ?? "";
  const selectedNotebook = tree.notebooks.find(
    (notebook) => notebook.name === selectedNotebookName,
  );
  const files = useMemo(
    () => tree.notebooks.flatMap((notebook) => collectFiles(notebook.children)),
    [tree],
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

    for (const notebook of tree.notebooks) {
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
  }, [query, tree]);

  async function refreshTree(expandNotebook?: string) {
    const nextTree = await apiRequest<LiberaTree>("/api/tree");
    setTree(nextTree);
    setSelectedNotebookName((current) => {
      if (current && nextTree.notebooks.some((notebook) => notebook.name === current)) {
        return current;
      }

      return nextTree.notebooks[0]?.name ?? "";
    });
    setExpanded((current) => {
      const nextExpanded = new Set(current);

      if (!current.size) {
        nextTree.notebooks.forEach((notebook) => nextExpanded.add(notebook.name));
      }

      if (expandNotebook) {
        nextExpanded.add(expandNotebook);
      }

      return nextExpanded;
    });
    return nextTree;
  }

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    refreshTree().catch((error: Error) => setWorkspaceError(error.message));
  }, [authenticated]);

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
    await apiRequest<{ authenticated: false }>("/api/auth/logout", {
      method: "POST",
    }).catch(() => null);
    setAuthenticated(false);
    setTree(emptyTree());
    latestDraftByTabIdRef.current = {};
    setTabs([]);
    setActiveTabId("");
    setSelectedNotebookName("");
  }

  function updateTab(tabId: string, updater: (tab: OpenTab) => OpenTab) {
    setTabs((currentTabs) =>
      currentTabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
    );
  }

  function rememberTabDraft(tabId: string, draft: string) {
    latestDraftByTabIdRef.current[tabId] = draft;
  }

  function forgetTabDraft(tabId: string) {
    delete latestDraftByTabIdRef.current[tabId];
  }

  function getTabDraft(tab: OpenTab) {
    return latestDraftByTabIdRef.current[tab.id] ?? tab.draft;
  }

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

  async function openFile(
    file: LiberaFileNode,
    options: { viewState?: OpenTabViewState } = {},
  ) {
    setWorkspaceError("");
    setSelectedNotebookName(file.notebook);

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
      setActiveTabId(file.path);
      return;
    }

    try {
      const payload = await apiRequest<LiberaFilePayload>(
        `/api/files?path=${encodeURIComponent(file.path)}`,
      );
      const draft = payload.content ?? "";
      const nextTab: OpenTab = {
        id: payload.file.path,
        file: payload.file,
        draft,
        saved: draft,
        rawUrl: payload.rawUrl ?? `/api/files/raw/${encodeFilePath(payload.file.path)}`,
        status: "clean",
        viewState: options.viewState,
      };

      rememberTabDraft(nextTab.id, draft);
      setTabs((currentTabs) => [...currentTabs, nextTab]);
      setActiveTabId(nextTab.id);
      recordFileInteraction(payload.file);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not open file.");
    }
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

  const closeTabWithoutConfirm = useCallback((tabId: string) => {
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

    forgetTabDraft(tabId);
    setTabs((currentTabs) => currentTabs.filter((currentTab) => currentTab.id !== tabId));

    if (activeTabId === tabId) {
      const remainingTabs = tabs.filter((currentTab) => currentTab.id !== tabId);
      const nextActiveTab = remainingTabs.at(-1);
      setActiveTabId(nextActiveTab?.id ?? "");

      if (nextActiveTab) {
        setSelectedNotebookName(nextActiveTab.file.notebook);
      } else if (tab) {
        setSelectedNotebookName(tab.file.notebook);
      }
    }
  }, [activeTabId, tabs]);

  const closeTab = useCallback((tabId: string) => {
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

    if (tab?.status === "dirty") {
      setWorkspaceConfirmDialog({
        mode: "close-tab",
        tabId,
        fileName: tab.file.name,
      });
      return;
    }

    closeTabWithoutConfirm(tabId);
  }, [closeTabWithoutConfirm, tabs]);

  function setActiveDraft(value: string) {
    if (!activeTab) {
      return;
    }

    rememberTabDraft(activeTab.id, value);
    updateTab(activeTab.id, (tab) => ({
      ...tab,
      draft: value,
      status: value === tab.saved ? "clean" : "dirty",
      error: undefined,
    }));
  }

  function setActiveTabViewState(viewState: OpenTabViewState) {
    if (!activeTab) {
      return;
    }

    updateTab(activeTab.id, (tab) => {
      const nextViewState: OpenTabViewState = {
        ...tab.viewState,
        image: viewState.image
          ? { ...tab.viewState?.image, ...viewState.image }
          : tab.viewState?.image,
        markdown: viewState.markdown
          ? { ...tab.viewState?.markdown, ...viewState.markdown }
          : tab.viewState?.markdown,
        pdf: viewState.pdf
          ? { ...tab.viewState?.pdf, ...viewState.pdf }
          : tab.viewState?.pdf,
      };

      if (
        shallowEqualRecord(tab.viewState?.image, nextViewState.image) &&
        shallowEqualRecord(tab.viewState?.markdown, nextViewState.markdown) &&
        shallowEqualRecord(tab.viewState?.pdf, nextViewState.pdf)
      ) {
        return tab;
      }

      return {
        ...tab,
        viewState: nextViewState,
      };
    });
  }

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
    const draft = getTabDraft(activeTab);
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const selectedText = draft.slice(start, end) || placeholder;
    const nextDraft = `${draft.slice(0, start)}${before}${selectedText}${after}${draft.slice(end)}`;
    const nextSelectionStart = start + before.length;
    const nextSelectionEnd = nextSelectionStart + selectedText.length;

    setActiveDraft(nextDraft);
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
    const draft = getTabDraft(activeTab);
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const selectedText = draft.slice(start, end) || "link";
    const insertion = `[${selectedText}]()`;
    const nextDraft = `${draft.slice(0, start)}${insertion}${draft.slice(end)}`;
    const destinationOffset = start + selectedText.length + 3;

    setActiveDraft(nextDraft);
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
    const draft = getTabDraft(activeTab);
    const textarea = textareaRef.current;
    const scrollState = getMarkdownTextareaScrollState();
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
    const nextDraft =
      hasLinkShell && (destinationCloseIndex < 0 || destinationCloseIndex >= end)
        ? `${draft.slice(0, start)}${destination}${
            destinationCloseIndex < 0 ? ")" : ""
          }${draft.slice(end)}`
        : `${draft.slice(0, start)}[${selection.file.name}](${destination})${draft.slice(end)}`;
    const nextSelectionStart = hasLinkShell ? start : start + 1;
    const nextSelectionEnd = hasLinkShell
      ? start + destination.length
      : start + 1 + selection.file.name.length;

    setActiveDraft(nextDraft);
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

    rememberTabDraft(tabId, insertionState.nextDraft);
    updateTab(tabId, (tab) => ({
      ...tab,
      draft: insertionState.nextDraft,
      status: insertionState.nextDraft === tab.saved ? "clean" : "dirty",
      error: undefined,
    }));

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

  async function insertMarkdownImage(
    file: File,
    selection?: { start: number; end: number },
  ) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const scrollState = getMarkdownTextareaScrollState();
    const formData = new FormData();
    formData.append("documentPath", activeTab.file.path);
    formData.append("file", file);

    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ markdown: string }>("/api/markdown-assets", {
        method: "POST",
        body: formData,
      });
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

  function startScreenshotSnip() {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const sourceTab = findNearestScreenshotSourceTab(activeTab.id);

    if (!sourceTab) {
      updateTab(activeTab.id, (tab) => ({
        ...tab,
        status: "error",
        error: "Open an image or PDF tab before using the snipping tool.",
      }));
      return;
    }

    const textarea = textareaRef.current;
    const draft = getTabDraft(activeTab);
    const selectionStart = textarea?.selectionStart ?? draft.length;
    const selectionEnd = textarea?.selectionEnd ?? draft.length;

    setScreenshotSnipSession({
      scrollLeft: textarea?.scrollLeft ?? 0,
      scrollTop: textarea?.scrollTop ?? 0,
      selectionEnd,
      selectionStart,
      sourceTabId: sourceTab.id,
      targetTabId: activeTab.id,
    });
    setSelectedNotebookName(sourceTab.file.notebook);
    recordFileInteraction(sourceTab.file);
    setActiveTabId(sourceTab.id);
  }

  function cancelScreenshotSnip() {
    const session = screenshotSnipSession;

    if (!session) {
      return;
    }

    const targetTab = tabs.find((tab) => tab.id === session.targetTabId);

    setScreenshotSnipSession(null);

    if (!targetTab) {
      return;
    }

    setSelectedNotebookName(targetTab.file.notebook);
    recordFileInteraction(targetTab.file);
    setActiveTabId(targetTab.id);
    restoreMarkdownTextarea({
      scrollLeft: session.scrollLeft,
      scrollTop: session.scrollTop,
      selectionStart: session.selectionStart,
      selectionEnd: session.selectionEnd,
    });
  }

  async function completeScreenshotSnip(file: File) {
    const session = screenshotSnipSession;

    if (!session) {
      return;
    }

    const targetTab = tabs.find((tab) => tab.id === session.targetTabId);

    if (!targetTab || targetTab.file.fileType !== "markdown") {
      setScreenshotSnipSession(null);
      return;
    }

    const formData = new FormData();
    formData.append("documentPath", targetTab.file.path);
    formData.append("file", file);
    updateTab(targetTab.id, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ markdown: string }>("/api/markdown-assets", {
        method: "POST",
        body: formData,
      });
      const insertionState = insertMarkdownImageMarkupInTab(
        targetTab.id,
        payload.markdown,
        {
          start: session.selectionStart,
          end: session.selectionEnd,
        },
      );

      setScreenshotSnipSession(null);
      setSelectedNotebookName(targetTab.file.notebook);
      recordFileInteraction(targetTab.file);
      setActiveTabId(targetTab.id);

      if (insertionState) {
        restoreMarkdownTextarea({
          scrollLeft: session.scrollLeft,
          scrollTop: session.scrollTop,
          selectionStart: insertionState.nextSelectionStart,
          selectionEnd: insertionState.nextSelectionEnd,
        });
      }
    } catch (error) {
      setScreenshotSnipSession(null);
      updateTab(targetTab.id, (tab) => ({
        ...tab,
        status: "error",
        error: error instanceof Error ? error.message : "Could not insert screenshot.",
      }));
      setSelectedNotebookName(targetTab.file.notebook);
      recordFileInteraction(targetTab.file);
      setActiveTabId(targetTab.id);
      restoreMarkdownTextarea({
        scrollLeft: session.scrollLeft,
        scrollTop: session.scrollTop,
        selectionStart: session.selectionStart,
        selectionEnd: session.selectionEnd,
      });
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
      const nextSelectionEnd = selection.start + payload.formattedText.length;

      rememberTabDraft(tabId, nextDraft);
      updateTab(tabId, (tab) => ({
        ...tab,
        draft: nextDraft,
        status: nextDraft === tab.saved ? "clean" : "dirty",
        error: undefined,
      }));

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
        body: JSON.stringify({ text: selectedText, prompt }),
      });
      const nextDraft = `${draft.slice(0, selection.start)}${payload.rewrittenText}${draft.slice(
        selection.end,
      )}`;
      const nextSelectionEnd = selection.start + payload.rewrittenText.length;

      rememberTabDraft(tabId, nextDraft);
      updateTab(tabId, (tab) => ({
        ...tab,
        draft: nextDraft,
        status: nextDraft === tab.saved ? "clean" : "dirty",
        error: undefined,
      }));

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
      const nextSelectionEnd = image.start + payload.markdown.length;

      rememberTabDraft(tabId, nextDraft);
      updateTab(tabId, (tab) => ({
        ...tab,
        draft: nextDraft,
        status: nextDraft === tab.saved ? "clean" : "dirty",
        error: undefined,
      }));

      void apiRequest<{ deleted: boolean }>("/api/markdown-assets", {
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

  async function saveActiveTab() {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const draft = getTabDraft(activeTab);

    if (draft === activeTab.saved && activeTab.status !== "error") {
      return;
    }

    updateTab(activeTab.id, (tab) => ({ ...tab, status: "saving", error: undefined }));

    try {
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: activeTab.file.path,
          content: draft,
        }),
      });

      rememberTabDraft(activeTab.id, draft);
      updateTab(activeTab.id, (tab) => ({
        ...tab,
        file: payload.file,
        saved: draft,
        status: "clean",
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

  function openEditNotebookDialog(notebook: LiberaTree["notebooks"][number]) {
    setNotebookDialog({ mode: "edit", notebook });
  }

  function closeNotebookDialog() {
    setNotebookDialog(null);
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

    try {
      if (notebookDialog.mode === "create") {
        const nextTree = await apiRequest<LiberaTree>("/api/notebooks", {
          method: "POST",
          body: JSON.stringify(values),
        });
        setTree(nextTree);
        setSelectedNotebookName(nextName);
        setActiveTabId("");
        setExpanded((current) => new Set(current).add(nextName));
      } else {
        const previousName = notebookDialog.notebook.name;
        const nextTree = await apiRequest<LiberaTree>("/api/notebooks", {
          method: "PATCH",
          body: JSON.stringify({
            path: previousName,
            ...values,
          }),
        });
        setTree(nextTree);
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(previousName);
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

  async function deleteNotebookFromPrompt(notebook: string) {
    setWorkspaceConfirmDialog({ mode: "delete-notebook", notebook });
  }

  async function deleteNotebook(notebook: string) {
    try {
      const nextTree = await apiRequest<LiberaTree>(
        `/api/notebooks?path=${encodeURIComponent(notebook)}`,
        { method: "DELETE" },
      );
      setTree(nextTree);
      setSelectedNotebookName((current) =>
        current === notebook ? nextTree.notebooks[0]?.name ?? "" : current,
      );
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(notebook);
        return next;
      });
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
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      link.href = URL.createObjectURL(blob);
      window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
    } else {
      link.href = `/api/files/raw/${encodeFilePath(file.path)}`;
    }

    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function createMarkdownFromPrompt(notebook: string, parentPath?: string) {
    setWorkspaceError("");
    setSelectedNotebookName(notebook);
    setNoteDialog({ notebook, parentPath });
    if (parentPath) {
      setExpanded((current) => new Set(current).add(parentPath));
    }
  }

  async function submitNoteDialog(values: NoteFormValues) {
    if (!noteDialog) {
      return;
    }

    const name = values.name.trim();

    if (!name) {
      setNoteDialogError("Note name is required.");
      return;
    }

    setNoteDialogSubmitting(true);

    try {
      const parentPath = noteDialog.parentPath;
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "POST",
        body: JSON.stringify({
          notebook: noteDialog.notebook,
          parentPath,
          name,
          content: `# ${name.replace(/\.(md|markdown)$/i, "")}\n`,
        }),
      });
      await refreshTree(noteDialog.notebook);
      if (parentPath) {
        setExpanded((current) => new Set(current).add(parentPath));
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
      const nextTree = await apiRequest<LiberaTree>("/api/folders", {
        method: "POST",
        body: JSON.stringify({
          parentPath,
          name,
        }),
      });
      setTree(nextTree);
      setExpanded((current) => {
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
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          destinationDirectory,
          destinationName,
          copy: true,
        }),
      });
      await refreshTree(payload.file.notebook);
      setExpanded((current) => {
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
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "rename-file", file: tab.file });
  }

  async function renameFileNodeFromPrompt(file: LiberaFileNode) {
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "rename-file", file });
  }

  async function moveFileFromPrompt(tab: OpenTab) {
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
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          destinationNotebook,
          destinationName,
        }),
      });
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
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: file.path,
          destinationDirectory: normalizedDestination,
        }),
      });
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
      setExpanded((current) => {
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
    await deleteFileNodeFromPrompt(tab.file);
  }

  async function deleteFileNodeFromPrompt(file: LiberaFileNode) {
    setWorkspaceConfirmDialog({ mode: "delete-file", file });
  }

  async function deleteFileNode(file: LiberaFileNode) {
    try {
      await apiRequest<LiberaTree>(`/api/files?path=${encodeURIComponent(file.path)}`, {
        method: "DELETE",
      });
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

  async function renameFolderFromPrompt(folder: LiberaFolderNode) {
    setWorkspaceError("");
    setWorkspaceInputDialog({ mode: "rename-folder", folder });
  }

  async function renameFolder(folder: LiberaFolderNode, name: string) {
    const parentPath = folder.path.split("/").slice(0, -1).join("/");
    const nextPath = `${parentPath}/${name}`;

    try {
      const nextTree = await apiRequest<LiberaTree>("/api/folders", {
        method: "PATCH",
        body: JSON.stringify({
          path: folder.path,
          name,
        }),
      });
      setTree(nextTree);
      setExpanded((current) => {
        const next = new Set(current);

        if (next.delete(folder.path)) {
          next.add(nextPath);
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
      const nextTree = await apiRequest<LiberaTree>(
        `/api/folders?path=${encodeURIComponent(folder.path)}`,
        { method: "DELETE" },
      );
      setTree(nextTree);
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(folder.path);
        return next;
      });
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

  async function submitWorkspaceConfirmDialog() {
    if (!workspaceConfirmDialog) {
      return;
    }

    setWorkspaceConfirmDialogSubmitting(true);

    try {
      if (workspaceConfirmDialog.mode === "close-tab") {
        closeTabWithoutConfirm(workspaceConfirmDialog.tabId);
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
      const payload = await apiRequest<{ tree: LiberaTree }>("/api/uploads", {
        method: "POST",
        body: formData,
      });
      setTree(payload.tree);
      setExpanded((current) => {
        const next = new Set(current).add(notebook);

        if (destinationPath) {
          next.add(destinationPath);
        }

        return next;
      });
      setSelectedNotebookName(notebook);
      setWorkspaceError("");
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
    setExpanded((current) => new Set(current).add(result.notebook));

    if (result.type === "file") {
      openFile(result.file);
    } else {
      selectNotebook(result.notebook);
    }
  }

  function selectNotebook(notebook: string) {
    setSelectedNotebookName(notebook);
    setActiveTabId("");
    setExpanded((current) => new Set(current).add(notebook));
  }

  function toggleNotebook(notebook: string) {
    setExpanded((current) => {
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
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

    if (tab) {
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

      if (tab) {
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

  return {
    authenticated,
    workspace: {
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
      noteDialog,
      noteDialogSubmitting,
      imageMarkdownConverting,
      password,
      query,
      fileInteractions,
      files,
      recentFiles,
      screenshotSnipSession,
      searchResults,
      selectedNotebook,
      selectedNotebookName,
      tabs,
      textareaRef,
      tree,
      uploadInputRef,
      workspaceConfirmDialog,
      workspaceConfirmDialogSubmitting,
      workspaceInputDialog,
      workspaceInputDialogSubmitting,
      workspaceError,
      closeTab,
      closeNotebookDialog,
      closeNoteDialog,
      closeWorkspaceConfirmDialog,
      closeWorkspaceInputDialog,
      cancelScreenshotSnip,
      completeScreenshotSnip,
      copyFileFromPrompt,
      createFolderFromPrompt,
      createMarkdownFromPrompt,
      deleteFileFromPrompt,
      deleteFolderFromPrompt,
      downloadFile,
      deleteNotebookFromPrompt,
      downloadNotebook,
      convertImageToMarkdownWithAi,
      formatSelectionWithAi,
      rewriteSelectionWithAi,
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
      openMarkdownFileLink,
      openCreateNotebookDialog,
      openEditNotebookDialog,
      deleteFileNodeFromPrompt,
      renameFolderFromPrompt,
      renameFileNodeFromPrompt,
      renameFileFromPrompt,
      saveActiveTab,
      selectSearchResult,
      selectNotebook,
      setActiveDraft,
      setActiveTabId: activateTab,
      setActiveTabViewState,
      setPassword,
      setQuery,
      startScreenshotSnip,
      swapTabs,
      startUpload,
      submitNotebookDialog,
      submitNoteDialog,
      submitWorkspaceConfirmDialog,
      submitWorkspaceInputDialog,
      toggleNotebook,
    },
  };
}
