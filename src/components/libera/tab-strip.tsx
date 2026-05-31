"use client";

import { useEffect, useRef, useState } from "react";
import {
  Download,
  FileDown,
  FileText,
  MoveRight,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type { OpenTab } from "@/components/libera/types";

type TabStripProps = {
  activeTab?: OpenTab;
  activeTabId: string;
  notebookColors: Record<string, string>;
  tabs: OpenTab[];
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDeleteFile: (tab: OpenTab) => Promise<void>;
  onDownloadFile: (file: OpenTab["file"], content?: string) => void;
  onDownloadMarkdownPdf: (tab: OpenTab) => Promise<void>;
  onMoveFile: (tab: OpenTab) => Promise<void>;
  onRenameFile: (tab: OpenTab) => Promise<void>;
  onSave: () => Promise<void>;
  onSwapTabs: (sourceTabId: string, targetTabId: string) => void;
};

type ActiveFileActionsProps = Pick<
  TabStripProps,
  | "activeTab"
  | "onDeleteFile"
  | "onDownloadFile"
  | "onDownloadMarkdownPdf"
  | "onMoveFile"
  | "onRenameFile"
  | "onSave"
>;

function readableTextColor(backgroundColor: string) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(backgroundColor);

  if (!match) {
    return "#ffffff";
  }

  const [, redHex, greenHex, blueHex] = match;
  const red = Number.parseInt(redHex, 16);
  const green = Number.parseInt(greenHex, 16);
  const blue = Number.parseInt(blueHex, 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

  return luminance > 0.58 ? "#18181b" : "#ffffff";
}

export function TabStrip({
  activeTab,
  activeTabId,
  notebookColors,
  tabs,
  onActivateTab,
  onCloseTab,
  onDeleteFile,
  onDownloadFile,
  onDownloadMarkdownPdf,
  onMoveFile,
  onRenameFile,
  onSave,
  onSwapTabs,
}: TabStripProps) {
  const [draggingTabId, setDraggingTabId] = useState("");
  const [dragOverTabId, setDragOverTabId] = useState("");

  function clearDragState() {
    setDraggingTabId("");
    setDragOverTabId("");
  }

  return (
    <div className="border-b border-border bg-card shadow-sm">
      <div className="flex min-h-12 items-center gap-2 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          {tabs.map((tab) => {
            const tabColor = notebookColors[tab.file.notebook] ?? "#64748b";
            const textColor = readableTextColor(tabColor);
            const isActive = activeTabId === tab.id;
            const isDragging = draggingTabId === tab.id;
            const isDragTarget = dragOverTabId === tab.id && draggingTabId !== tab.id;

            return (
              <button
                key={tab.id}
                className={`flex max-w-64 shrink-0 cursor-grab items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition active:cursor-grabbing ${
                  isActive
                    ? "shadow-sm ring-2 ring-foreground/20"
                    : "opacity-85 hover:opacity-100"
                } ${
                  isDragTarget
                    ? "outline outline-2 outline-offset-2 outline-foreground/30"
                    : ""
                } ${isDragging ? "opacity-50" : ""}`}
                draggable
                data-tab-id={tab.id}
                aria-label={`Open ${tab.file.name}`}
                aria-describedby={isDragTarget ? `${tab.id}-drop-target` : undefined}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-libera-tab-id", tab.id);
                  setDraggingTabId(tab.id);
                }}
                onDragOver={(event) => {
                  if (!draggingTabId || draggingTabId === tab.id) {
                    return;
                  }

                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverTabId(tab.id);
                }}
                onDragLeave={() => {
                  setDragOverTabId((current) => (current === tab.id ? "" : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceTabId =
                    event.dataTransfer.getData("application/x-libera-tab-id") ||
                    draggingTabId;

                  if (sourceTabId && sourceTabId !== tab.id) {
                    onSwapTabs(sourceTabId, tab.id);
                  }

                  clearDragState();
                }}
                onDragEnd={clearDragState}
                style={{
                  backgroundColor: tabColor,
                  borderColor: tabColor,
                  color: textColor,
                }}
                type="button"
                onClick={() => onActivateTab(tab.id)}
              >
                <span className="truncate">{tab.file.name}</span>
                {isDragTarget ? (
                  <span id={`${tab.id}-drop-target`} className="sr-only">
                    Drop to swap tabs
                  </span>
                ) : null}
                {tab.status === "dirty" ? <span aria-label="Unsaved">*</span> : null}
                <span
                  className="ml-1 rounded p-0.5 hover:bg-black/10"
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${tab.file.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }
                  }}
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                </span>
              </button>
            );
          })}
        </div>
        <ActiveFileActions
          activeTab={activeTab}
          onDeleteFile={onDeleteFile}
          onDownloadFile={onDownloadFile}
          onDownloadMarkdownPdf={onDownloadMarkdownPdf}
          onMoveFile={onMoveFile}
          onRenameFile={onRenameFile}
          onSave={onSave}
        />
      </div>
    </div>
  );
}

function ActiveFileActions({
  activeTab,
  onDeleteFile,
  onDownloadFile,
  onDownloadMarkdownPdf,
  onMoveFile,
  onRenameFile,
  onSave,
}: ActiveFileActionsProps) {
  const [downloadMenuTabId, setDownloadMenuTabId] = useState<string | null>(null);
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  const downloadMenuOpen = Boolean(activeTab && downloadMenuTabId === activeTab.id);

  useEffect(() => {
    if (!downloadMenuOpen) {
      return;
    }

    function closeOnPointerDown(event: PointerEvent) {
      if (!downloadMenuRef.current?.contains(event.target as Node)) {
        setDownloadMenuTabId(null);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDownloadMenuTabId(null);
      }
    }

    function closeMenu() {
      setDownloadMenuTabId(null);
    }

    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);

    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [downloadMenuOpen]);

  if (!activeTab) {
    return null;
  }

  const isMarkdown = activeTab.file.fileType === "markdown";
  const downloadContent = isMarkdown ? activeTab.draft : undefined;

  return (
    <div className="flex shrink-0 items-center gap-1 border-l border-border pl-2">
      {isMarkdown ? (
        <button
          aria-label="Save"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          disabled={activeTab.status === "saving" || activeTab.status === "clean"}
          title="Save"
          type="button"
          onClick={onSave}
        >
          <Save aria-hidden className="h-4 w-4" />
        </button>
      ) : null}
      {isMarkdown ? (
        <div ref={downloadMenuRef} className="relative">
          <button
            aria-expanded={downloadMenuOpen}
            aria-haspopup="menu"
            aria-label="Download"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            title="Download"
            type="button"
            onClick={() =>
              setDownloadMenuTabId((current) =>
                current === activeTab.id ? null : activeTab.id,
              )
            }
          >
            <Download aria-hidden className="h-4 w-4" />
          </button>
          {downloadMenuOpen ? (
            <div
              className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-card py-1 text-sm shadow-lg"
              role="menu"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-muted"
                type="button"
                role="menuitem"
                onClick={() => {
                  setDownloadMenuTabId(null);
                  onDownloadFile(activeTab.file, downloadContent);
                }}
              >
                <FileText aria-hidden className="h-4 w-4 text-muted-foreground" />
                Markdown file
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-muted"
                type="button"
                role="menuitem"
                onClick={() => {
                  setDownloadMenuTabId(null);
                  void onDownloadMarkdownPdf(activeTab);
                }}
              >
                <FileDown aria-hidden className="h-4 w-4 text-muted-foreground" />
                PDF file
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <button
          aria-label="Download"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          title="Download"
          type="button"
          onClick={() => onDownloadFile(activeTab.file)}
        >
          <Download aria-hidden className="h-4 w-4" />
        </button>
      )}
      <button
        aria-label="Rename"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        title="Rename"
        type="button"
        onClick={() => onRenameFile(activeTab)}
      >
        <Pencil aria-hidden className="h-4 w-4" />
      </button>
      <button
        aria-label="Move"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-accent/10 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        title="Move"
        type="button"
        onClick={() => onMoveFile(activeTab)}
      >
        <MoveRight aria-hidden className="h-4 w-4" />
      </button>
      <button
        aria-label="Delete"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
        title="Delete"
        type="button"
        onClick={() => onDeleteFile(activeTab)}
      >
        <Trash2 aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
