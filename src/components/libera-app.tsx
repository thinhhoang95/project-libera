"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import type { ApiError, LiberaFileNode, LiberaFilePayload, LiberaTree } from "@/lib/types";

type OpenTab = {
  id: string;
  file: LiberaFileNode;
  draft: string;
  saved: string;
  rawUrl?: string;
  status: "clean" | "dirty" | "saving" | "error";
  error?: string;
};

type SearchResult =
  | { type: "notebook"; notebook: string; label: string }
  | { type: "file"; notebook: string; file: LiberaFileNode; label: string };

type LiberaAppProps = {
  initialAuthenticated: boolean;
};

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Partial<ApiError>;

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed.");
  }

  return payload as T;
}

function encodeFilePath(filePath: string) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function emptyTree(): LiberaTree {
  return {
    root: "",
    notebooks: [],
  };
}

function fileTypeLabel(fileType: LiberaFileNode["fileType"]) {
  if (fileType === "markdown") {
    return "MD";
  }

  if (fileType === "image") {
    return "IMG";
  }

  return "PDF";
}

export function LiberaApp({ initialAuthenticated }: LiberaAppProps) {
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [tree, setTree] = useState<LiberaTree>(emptyTree);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [uploadNotebook, setUploadNotebook] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const firstNotebook = tree.notebooks[0]?.name ?? "";

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

      for (const file of notebook.children) {
        if (file.name.toLowerCase().includes(normalizedQuery)) {
          results.push({
            type: "file",
            notebook: notebook.name,
            file,
            label: `${notebook.name}/${file.name}`,
          });
        }
      }
    }

    return results.slice(0, 12);
  }, [query, tree]);

  async function refreshTree(expandNotebook?: string) {
    const nextTree = await apiRequest<LiberaTree>("/api/tree");
    setTree(nextTree);
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
  }

  function updateTab(tabId: string, updater: (tab: OpenTab) => OpenTab) {
    setTabs((currentTabs) =>
      currentTabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
    );
  }

  async function openFile(file: LiberaFileNode) {
    setWorkspaceError("");

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

    if (tab?.status === "dirty" && !window.confirm(`Close ${tab.file.name} without saving?`)) {
      return;
    }

    setTabs((currentTabs) => currentTabs.filter((currentTab) => currentTab.id !== tabId));

    if (activeTabId === tabId) {
      const remainingTabs = tabs.filter((currentTab) => currentTab.id !== tabId);
      setActiveTabId(remainingTabs.at(-1)?.id ?? "");
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

  async function createNotebookFromPrompt() {
    const name = window.prompt("Notebook name");

    if (!name) {
      return;
    }

    try {
      const nextTree = await apiRequest<LiberaTree>("/api/notebooks", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setTree(nextTree);
      setExpanded((current) => new Set(current).add(name.trim()));
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not create notebook.");
    }
  }

  async function renameNotebookFromPrompt(notebook: string) {
    const name = window.prompt("New notebook name", notebook);

    if (!name || name === notebook) {
      return;
    }

    try {
      const nextTree = await apiRequest<LiberaTree>("/api/notebooks", {
        method: "PATCH",
        body: JSON.stringify({ path: notebook, name }),
      });
      setTree(nextTree);
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(notebook);
        next.add(name.trim());
        return next;
      });
      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.file.notebook === notebook
            ? {
                ...tab,
                id: `${name.trim()}/${tab.file.name}`,
                file: {
                  ...tab.file,
                  notebook: name.trim(),
                  path: `${name.trim()}/${tab.file.name}`,
                },
                rawUrl: `/api/files/raw/${encodeFilePath(`${name.trim()}/${tab.file.name}`)}`,
              }
            : tab,
        ),
      );
      setActiveTabId((current) =>
        current.startsWith(`${notebook}/`) ? `${name.trim()}/${current.split("/")[1]}` : current,
      );
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not rename notebook.");
    }
  }

  async function deleteNotebookFromPrompt(notebook: string) {
    if (!window.confirm(`Delete notebook "${notebook}" and all files inside it?`)) {
      return;
    }

    try {
      const nextTree = await apiRequest<LiberaTree>(
        `/api/notebooks?path=${encodeURIComponent(notebook)}`,
        { method: "DELETE" },
      );
      setTree(nextTree);
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

  async function createMarkdownFromPrompt(notebook: string) {
    const name = window.prompt("Markdown file name", "Untitled.md");

    if (!name) {
      return;
    }

    try {
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "POST",
        body: JSON.stringify({
          notebook,
          name,
          content: `# ${name.replace(/\.(md|markdown)$/i, "")}\n`,
        }),
      });
      await refreshTree(notebook);
      await openFile(payload.file);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not create note.");
    }
  }

  async function renameFileFromPrompt(tab: OpenTab) {
    const name = window.prompt("New file name", tab.file.name);

    if (!name || name === tab.file.name) {
      return;
    }

    await moveActiveFile(tab, tab.file.notebook, name);
  }

  async function moveFileFromPrompt(tab: OpenTab) {
    const notebook = window.prompt("Destination notebook", tab.file.notebook);

    if (!notebook || notebook === tab.file.notebook) {
      return;
    }

    await moveActiveFile(tab, notebook, tab.file.name);
  }

  async function moveActiveFile(tab: OpenTab, destinationNotebook: string, destinationName: string) {
    if (tab.status === "dirty" && !window.confirm("Move this file without saving edits first?")) {
      return;
    }

    try {
      const payload = await apiRequest<LiberaFilePayload>("/api/files", {
        method: "PATCH",
        body: JSON.stringify({
          path: tab.file.path,
          destinationNotebook,
          destinationName,
        }),
      });
      const nextId = payload.file.path;
      setTabs((currentTabs) =>
        currentTabs.map((currentTab) =>
          currentTab.id === tab.id
            ? {
                ...currentTab,
                id: nextId,
                file: payload.file,
                rawUrl: payload.rawUrl ?? `/api/files/raw/${encodeFilePath(nextId)}`,
              }
            : currentTab,
        ),
      );
      setActiveTabId(nextId);
      await refreshTree(payload.file.notebook);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not move file.");
    }
  }

  async function deleteFileFromPrompt(tab: OpenTab) {
    if (!window.confirm(`Delete "${tab.file.name}"?`)) {
      return;
    }

    try {
      await apiRequest<LiberaTree>(`/api/files?path=${encodeURIComponent(tab.file.path)}`, {
        method: "DELETE",
      });
      closeTab(tab.id);
      await refreshTree(tab.file.notebook);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not delete file.");
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

  if (!authenticated) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-6 py-10 text-zinc-950">
        <section className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-medium text-zinc-500">Libera</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sign in</h1>
          <form className="mt-6 space-y-4" onSubmit={handleLogin}>
            <label className="block text-sm font-medium text-zinc-700" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="h-11 w-full rounded-md border border-zinc-300 px-3 text-sm outline-none transition focus:border-zinc-950"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
            {authError ? <p className="text-sm text-red-600">{authError}</p> : null}
            <button
              className="h-11 w-full rounded-md bg-zinc-950 px-4 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
              disabled={busy}
            >
              {busy ? "Signing in" : "Sign in"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-zinc-100 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-5 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-medium text-zinc-500">Libera</p>
            <h1 className="text-xl font-semibold tracking-tight">Liberal notetaking app</h1>
          </div>
          <div className="relative flex w-full max-w-xl items-center gap-2">
            <input
              className="h-10 w-full rounded-md border border-zinc-300 px-3 text-sm outline-none transition focus:border-zinc-950"
              placeholder="Search notebooks and files"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {searchResults.length ? (
              <div className="absolute left-0 right-0 top-11 z-20 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
                {searchResults.map((result) => (
                  <button
                    key={`${result.type}:${result.label}`}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-100"
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setExpanded((current) => new Set(current).add(result.notebook));

                      if (result.type === "file") {
                        openFile(result.file);
                      }
                    }}
                  >
                    <span>{result.label}</span>
                    <span className="text-xs uppercase text-zinc-500">{result.type}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <button
              className="h-10 rounded-md border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50"
              type="button"
              onClick={handleLogout}
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[320px_1fr]">
        <aside className="border-b border-zinc-200 bg-white lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
              Notebooks
            </h2>
            <button
              className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs font-medium hover:bg-zinc-50"
              type="button"
              onClick={createNotebookFromPrompt}
            >
              New
            </button>
          </div>

          <input
            ref={uploadInputRef}
            className="hidden"
            type="file"
            multiple
            accept=".md,.markdown,.png,.jpg,.jpeg,.gif,.webp,.pdf"
            onChange={handleUploadChange}
          />

          <div className="max-h-[40vh] overflow-auto px-3 py-3 lg:max-h-[calc(100vh-116px)]">
            {!tree.notebooks.length ? (
              <div className="rounded-md border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
                No notebooks yet.
              </div>
            ) : null}

            <div className="space-y-2">
              {tree.notebooks.map((notebook) => {
                const isExpanded = expanded.has(notebook.name);

                return (
                  <section key={notebook.name} className="rounded-md border border-zinc-200">
                    <div className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2">
                      <button
                        className="h-7 w-7 rounded text-sm hover:bg-zinc-100"
                        type="button"
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(notebook.name)) {
                              next.delete(notebook.name);
                            } else {
                              next.add(notebook.name);
                            }
                            return next;
                          })
                        }
                      >
                        {isExpanded ? "-" : "+"}
                      </button>
                      <button
                        className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                        type="button"
                        onClick={() => setExpanded((current) => new Set(current).add(notebook.name))}
                      >
                        {notebook.name}
                      </button>
                    </div>
                    {isExpanded ? (
                      <div className="px-2 py-2">
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          <button
                            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50"
                            type="button"
                            onClick={() => createMarkdownFromPrompt(notebook.name)}
                          >
                            New note
                          </button>
                          <button
                            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50"
                            type="button"
                            onClick={() => startUpload(notebook.name)}
                          >
                            Upload
                          </button>
                          <button
                            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-50"
                            type="button"
                            onClick={() => renameNotebookFromPrompt(notebook.name)}
                          >
                            Rename
                          </button>
                          <button
                            className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                            type="button"
                            onClick={() => deleteNotebookFromPrompt(notebook.name)}
                          >
                            Delete
                          </button>
                        </div>

                        <div className="space-y-1">
                          {notebook.children.map((file) => (
                            <button
                              key={file.path}
                              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-100 ${
                                activeTabId === file.path ? "bg-zinc-100" : ""
                              }`}
                              type="button"
                              onClick={() => openFile(file)}
                            >
                              <span className="w-9 shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-center text-[10px] font-semibold text-zinc-700">
                                {fileTypeLabel(file.fileType)}
                              </span>
                              <span className="min-w-0 truncate">{file.name}</span>
                            </button>
                          ))}
                          {!notebook.children.length ? (
                            <p className="px-2 py-2 text-sm text-zinc-500">No files.</p>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="min-w-0">
          <div className="border-b border-zinc-200 bg-white">
            <div className="flex min-h-12 items-center gap-2 overflow-x-auto px-3 py-2">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`flex max-w-64 items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                    activeTabId === tab.id
                      ? "border-zinc-950 bg-zinc-950 text-white"
                      : "border-zinc-200 bg-white hover:bg-zinc-50"
                  }`}
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <span className="truncate">{tab.file.name}</span>
                  {tab.status === "dirty" ? <span aria-label="Unsaved">*</span> : null}
                  <span
                    className="ml-1 rounded px-1 hover:bg-black/10"
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeTab(tab.id);
                      }
                    }}
                  >
                    x
                  </span>
                </button>
              ))}
            </div>
          </div>

          {workspaceError ? (
            <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {workspaceError}
            </div>
          ) : null}

          {!activeTab ? (
            <div className="flex min-h-[calc(100vh-120px)] items-center justify-center px-6">
              <div className="max-w-md text-center">
                <h2 className="text-xl font-semibold tracking-tight">Open a file to begin</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-500">
                  Create a notebook, add Markdown notes, or upload images and PDFs from the
                  explorer.
                </p>
                {firstNotebook ? (
                  <button
                    className="mt-5 rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
                    type="button"
                    onClick={() => createMarkdownFromPrompt(firstNotebook)}
                  >
                    New note in {firstNotebook}
                  </button>
                ) : (
                  <button
                    className="mt-5 rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
                    type="button"
                    onClick={createNotebookFromPrompt}
                  >
                    Create notebook
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex min-h-[calc(100vh-120px)] flex-col">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{activeTab.file.path}</p>
                  <p className="text-xs text-zinc-500">
                    {activeTab.file.fileType.toUpperCase()} · {activeTab.status}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeTab.file.fileType === "markdown" ? (
                    <button
                      className="rounded-md bg-zinc-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
                      type="button"
                      disabled={activeTab.status === "saving" || activeTab.status === "clean"}
                      onClick={saveActiveTab}
                    >
                      Save
                    </button>
                  ) : null}
                  <button
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
                    type="button"
                    onClick={() => renameFileFromPrompt(activeTab)}
                  >
                    Rename
                  </button>
                  <button
                    className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
                    type="button"
                    onClick={() => moveFileFromPrompt(activeTab)}
                  >
                    Move
                  </button>
                  <button
                    className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                    type="button"
                    onClick={() => deleteFileFromPrompt(activeTab)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {activeTab.error ? (
                <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
                  {activeTab.error}
                </div>
              ) : null}

              {activeTab.file.fileType === "markdown" ? (
                <>
                  <div className="flex flex-wrap gap-2 border-b border-zinc-200 bg-white px-4 py-2">
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("**", "**")}>
                      Bold
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("_", "_")}>
                      Italic
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("<u>", "</u>")}>
                      Underline
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("# ", "", "Heading")}>
                      H1
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("## ", "", "Heading")}>
                      H2
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("- ", "", "List item")}>
                      List
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("[", "](https://)", "link")}>
                      Link
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("![", "](image-url)", "alt")}>
                      Image
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("`", "`", "code")}>
                      Code
                    </button>
                    <button className="toolbar-button" type="button" onClick={() => insertMarkdown("$$\n", "\n$$", "x = y")}>
                      Math
                    </button>
                  </div>

                  <div className="grid min-h-0 flex-1 lg:grid-cols-2">
                    <textarea
                      ref={textareaRef}
                      className="min-h-[50vh] resize-none border-b border-zinc-200 bg-white p-5 font-mono text-sm leading-6 outline-none lg:min-h-0 lg:border-b-0 lg:border-r"
                      value={activeTab.draft}
                      onChange={(event) => setActiveDraft(event.target.value)}
                      spellCheck={false}
                    />
                    <article className="overflow-auto bg-white p-6">
                      <MarkdownRenderer content={activeTab.draft} />
                    </article>
                  </div>
                </>
              ) : activeTab.file.fileType === "image" ? (
                <div className="flex flex-1 items-center justify-center overflow-auto bg-zinc-200 p-6">
                  {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated local file URLs should not use Next image optimization. */}
                  <img
                    className="max-h-[calc(100vh-180px)] max-w-full rounded-md bg-white object-contain shadow-sm"
                    src={activeTab.rawUrl}
                    alt={activeTab.file.name}
                  />
                </div>
              ) : (
                <iframe
                  className="min-h-[calc(100vh-172px)] flex-1 bg-white"
                  src={activeTab.rawUrl}
                  title={activeTab.file.name}
                />
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
