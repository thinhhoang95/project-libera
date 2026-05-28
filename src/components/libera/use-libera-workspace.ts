"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  LiberaFileNode,
  LiberaFilePayload,
  LiberaFolderNode,
  LiberaTree,
  LiberaTreeNode,
} from "@/lib/types";
import { apiRequest, emptyTree, encodeFilePath } from "@/components/libera/api-client";
import type {
  MarkdownImageSelection,
  NotebookDialogState,
  NotebookFormValues,
  NoteDialogState,
  NoteFormValues,
  OpenTab,
  SearchResult,
  WorkspaceConfirmDialogState,
  WorkspaceInputDialogState,
  WorkspaceInputDialogValues,
} from "@/components/libera/types";

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

function parentPathForFile(file: LiberaFileNode) {
  const parts = file.path.split("/");
  return parts.slice(0, -1).join("/") || file.notebook;
}

function imageAltText(name: string) {
  return name.replace(/\.[^.]+$/, "") || "image";
}

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
  const [busy, setBusy] = useState(false);
  const [aiFormatting, setAiFormatting] = useState(false);
  const [imageMarkdownConverting, setImageMarkdownConverting] = useState(false);
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const firstNotebook = tree.notebooks[0]?.name ?? "";
  const selectedNotebook = tree.notebooks.find(
    (notebook) => notebook.name === selectedNotebookName,
  );

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
    setTabs([]);
    setActiveTabId("");
    setSelectedNotebookName("");
  }

  function updateTab(tabId: string, updater: (tab: OpenTab) => OpenTab) {
    setTabs((currentTabs) =>
      currentTabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
    );
  }

  async function openFile(file: LiberaFileNode) {
    setWorkspaceError("");
    setSelectedNotebookName(file.notebook);

    if (tabs.some((tab) => tab.id === file.path)) {
      setActiveTabId(file.path);
      return;
    }

    try {
      const payload = await apiRequest<LiberaFilePayload>(
        `/api/files?path=${encodeURIComponent(file.path)}`,
      );
      const nextTab: OpenTab = {
        id: payload.file.path,
        file: payload.file,
        draft: payload.content ?? "",
        saved: payload.content ?? "",
        rawUrl: payload.rawUrl ?? `/api/files/raw/${encodeFilePath(payload.file.path)}`,
        status: "clean",
      };

      setTabs((currentTabs) => [...currentTabs, nextTab]);
      setActiveTabId(nextTab.id);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not open file.");
    }
  }

  function closeTab(tabId: string) {
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
  }

  function closeTabWithoutConfirm(tabId: string) {
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

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
  }

  function setActiveDraft(value: string) {
    if (!activeTab) {
      return;
    }

    updateTab(activeTab.id, (tab) => ({
      ...tab,
      draft: value,
      status: value === tab.saved ? "clean" : "dirty",
      error: undefined,
    }));
  }

  function insertMarkdown(before: string, after = "", placeholder = "text") {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const textarea = textareaRef.current;
    const draft = activeTab.draft;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const selectedText = draft.slice(start, end) || placeholder;
    const nextDraft = `${draft.slice(0, start)}${before}${selectedText}${after}${draft.slice(end)}`;
    const nextSelectionStart = start + before.length;
    const nextSelectionEnd = nextSelectionStart + selectedText.length;

    setActiveDraft(nextDraft);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    });
  }

  function insertMarkdownImageMarkup(insertion: string) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const draft = activeTab.draft;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? draft.length;
    const prefix = start > 0 && !draft.slice(0, start).endsWith("\n") ? "\n" : "";
    const suffix = draft.slice(end).startsWith("\n") ? "" : "\n";
    const nextDraft = `${draft.slice(0, start)}${prefix}${insertion}${suffix}${draft.slice(
      end,
    )}`;
    const nextSelectionStart = start + prefix.length;
    const nextSelectionEnd = nextSelectionStart + insertion.length;

    updateTab(tabId, (tab) => ({
      ...tab,
      draft: nextDraft,
      status: nextDraft === tab.saved ? "clean" : "dirty",
      error: undefined,
    }));

    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    });
  }

  async function insertMarkdownImage(file: File) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const formData = new FormData();
    formData.append("documentPath", activeTab.file.path);
    formData.append("file", file);

    updateTab(tabId, (tab) => ({ ...tab, error: undefined }));

    try {
      const payload = await apiRequest<{ markdown: string }>("/api/markdown-assets", {
        method: "POST",
        body: formData,
      });
      insertMarkdownImageMarkup(payload.markdown);
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

  async function formatSelectionWithAi(selection: { start: number; end: number }) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const draft = activeTab.draft;
    const selectedText = draft.slice(selection.start, selection.end);

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

      updateTab(tabId, (tab) => ({
        ...tab,
        draft: nextDraft,
        status: nextDraft === tab.saved ? "clean" : "dirty",
        error: undefined,
      }));

      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(selection.start, nextSelectionEnd);
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

  async function convertImageToMarkdownWithAi(image: MarkdownImageSelection) {
    if (!activeTab || activeTab.file.fileType !== "markdown") {
      return;
    }

    const tabId = activeTab.id;
    const draft = activeTab.draft;
    const imageMarkdown = draft.slice(image.start, image.end);

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

      updateTab(tabId, (tab) => ({
        ...tab,
        draft: nextDraft,
        status: nextDraft === tab.saved ? "clean" : "dirty",
        error: undefined,
      }));

      window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(image.start, nextSelectionEnd);
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

    updateTab(activeTab.id, (tab) => ({ ...tab, status: "saving", error: undefined }));

    try {
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: activeTab.file.path,
          content: activeTab.draft,
        }),
      });

      updateTab(activeTab.id, (tab) => ({
        ...tab,
        file: payload.file,
        saved: activeTab.draft,
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

  async function createMarkdownFromPrompt(notebook: string) {
    setWorkspaceError("");
    setSelectedNotebookName(notebook);
    setNoteDialog({ notebook });
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
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "POST",
        body: JSON.stringify({
          notebook: noteDialog.notebook,
          name,
          content: `# ${name.replace(/\.(md|markdown)$/i, "")}\n`,
        }),
      });
      await refreshTree(noteDialog.notebook);
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
      setTabs((currentTabs) =>
        currentTabs.map((currentTab) =>
          currentTab.file.path === file.path
            ? {
                ...currentTab,
                id: nextId,
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

      setTabs((currentTabs) =>
        currentTabs.map((currentTab) =>
          currentTab.file.path === file.path
            ? {
                ...currentTab,
                id: nextId,
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

  async function handleUploadChange() {
    const files = uploadInputRef.current?.files;

    if (!files?.length || !uploadNotebook) {
      return;
    }

    const formData = new FormData();
    formData.append("notebook", uploadNotebook);

    Array.from(files).forEach((file) => formData.append("files", file));

    try {
      const payload = await apiRequest<{ tree: LiberaTree }>("/api/uploads", {
        method: "POST",
        body: formData,
      });
      setTree(payload.tree);
      setExpanded((current) => new Set(current).add(uploadNotebook));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Upload failed.");
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

  function activateTab(tabId: string) {
    const tab = tabs.find((currentTab) => currentTab.id === tabId);

    if (tab) {
      setSelectedNotebookName(tab.file.notebook);
    }

    setActiveTabId(tabId);
  }

  return {
    authenticated,
    workspace: {
      activeTab,
      activeTabId,
      authError,
      aiFormatting,
      busy,
      expanded,
      firstNotebook,
      notebookDialog,
      notebookDialogSubmitting,
      noteDialog,
      noteDialogSubmitting,
      imageMarkdownConverting,
      password,
      query,
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
      copyFileFromPrompt,
      createFolderFromPrompt,
      createMarkdownFromPrompt,
      deleteFileFromPrompt,
      deleteFolderFromPrompt,
      deleteNotebookFromPrompt,
      downloadNotebook,
      convertImageToMarkdownWithAi,
      formatSelectionWithAi,
      handleLogin,
      handleLogout,
      handleUploadChange,
      insertExistingMarkdownImage,
      insertMarkdownImage,
      insertMarkdown,
      moveFileFromPrompt,
      moveFileToFolder,
      openFile,
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
      setPassword,
      setQuery,
      startUpload,
      submitNotebookDialog,
      submitNoteDialog,
      submitWorkspaceConfirmDialog,
      submitWorkspaceInputDialog,
      toggleNotebook,
    },
  };
}
