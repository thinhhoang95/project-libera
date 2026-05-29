"use client";

import { FileText, Image as ImageIcon, PanelTop, ScrollText } from "lucide-react";
import type {
  MarkdownFileLinkSelection,
  OpenTab,
  OpenTabViewState,
} from "@/components/libera/types";
import type { LiberaFileNode } from "@/lib/types";

export type MarkdownFileLinkPopupOption = {
  file: LiberaFileNode;
  id: string;
  source: "file" | "tab";
  subtitle: string;
  title: string;
  viewState?: OpenTabViewState;
};

export type MarkdownFileLinkPopupSection = {
  options: MarkdownFileLinkPopupOption[];
  title: string;
};

type MarkdownFileLinkPopupProps = {
  activeIndex: number;
  sections: MarkdownFileLinkPopupSection[];
  x: number;
  y: number;
  onSelect: (selection: MarkdownFileLinkSelection) => void;
};

function fileIcon(file: LiberaFileNode) {
  if (file.fileType === "image") {
    return <ImageIcon aria-hidden className="h-4 w-4" />;
  }

  if (file.fileType === "pdf") {
    return <ScrollText aria-hidden className="h-4 w-4" />;
  }

  return <FileText aria-hidden className="h-4 w-4" />;
}

function optionSelection(option: MarkdownFileLinkPopupOption): MarkdownFileLinkSelection {
  return {
    file: option.file,
    source: option.source,
    tabId: option.source === "tab" ? option.id.replace(/^tab:/, "") : undefined,
    viewState: option.viewState,
  };
}

export function buildMarkdownFileLinkSections({
  activeFilePath,
  files,
  openTabs,
  query,
  recentFiles,
}: {
  activeFilePath?: string;
  files: LiberaFileNode[];
  openTabs: OpenTab[];
  query: string;
  recentFiles: LiberaFileNode[];
}): MarkdownFileLinkPopupSection[] {
  const normalizedQuery = query.trim().toLowerCase();
  const openTabByPath = new Map(openTabs.map((tab) => [tab.file.path, tab]));
  const candidateFiles = files.filter((file) => file.path !== activeFilePath);
  const primaryFiles = normalizedQuery
    ? candidateFiles
        .filter((file) =>
          `${file.name}\n${file.path}`.toLowerCase().includes(normalizedQuery),
        )
        .sort((left, right) => scoreFile(right, normalizedQuery) - scoreFile(left, normalizedQuery))
        .slice(0, 8)
    : (recentFiles.length ? recentFiles : candidateFiles)
        .filter((file) => file.path !== activeFilePath)
        .slice(0, 8);
  const primaryOptions = primaryFiles.map((file) => {
    const openTab = openTabByPath.get(file.path);

    return {
      file,
      id: `file:${file.path}`,
      source: "file" as const,
      subtitle: file.path,
      title: file.name,
      viewState: openTab?.viewState,
    };
  });
  const tabOptions = openTabs
    .filter((tab) => tab.file.path !== activeFilePath)
    .map((tab) => ({
      file: tab.file,
      id: `tab:${tab.id}`,
      source: "tab" as const,
      subtitle: currentViewSubtitle(tab),
      title: tab.file.name,
      viewState: tab.viewState,
    }));
  const sections: MarkdownFileLinkPopupSection[] = [];

  if (primaryOptions.length) {
    sections.push({
      title: normalizedQuery ? "Files" : "Recent files",
      options: primaryOptions,
    });
  }

  if (tabOptions.length) {
    sections.push({
      title: "Open tabs",
      options: tabOptions,
    });
  }

  return sections;
}

function scoreFile(file: LiberaFileNode, query: string) {
  const name = file.name.toLowerCase();
  const path = file.path.toLowerCase();
  let score = 0;

  if (name === query) {
    score += 100;
  }

  if (name.startsWith(query)) {
    score += 50;
  }

  if (path.includes(query)) {
    score += 10;
  }

  return score;
}

function currentViewSubtitle(tab: OpenTab) {
  if (tab.file.fileType === "pdf") {
    const scrollTop = Math.round(tab.viewState?.pdf?.scrollTop ?? 0);
    const zoom = Math.round((tab.viewState?.pdf?.zoom ?? 1) * 100);

    return `Current PDF view · ${zoom}% · y ${scrollTop}`;
  }

  if (tab.file.fileType === "image") {
    const zoom = Math.round((tab.viewState?.image?.zoom ?? 1) * 100);

    return `Current image view · ${zoom}%`;
  }

  const line = tab.viewState?.markdown?.line;

  return typeof line === "number"
    ? `Current Markdown view · line ${line}`
    : "Current Markdown view";
}

export function flattenMarkdownFileLinkSections(
  sections: MarkdownFileLinkPopupSection[],
) {
  return sections.flatMap((section) => section.options);
}

export function MarkdownFileLinkPopup({
  activeIndex,
  sections,
  x,
  y,
  onSelect,
}: MarkdownFileLinkPopupProps) {
  const indexedSections = sections.map((section, sectionIndex) => {
    const offset = sections
      .slice(0, sectionIndex)
      .reduce((count, currentSection) => count + currentSection.options.length, 0);

    return {
      ...section,
      options: section.options.map((option, optionIndex) => ({
        option,
        optionIndex: offset + optionIndex,
      })),
    };
  });

  if (!sections.length) {
    return (
      <div
        className="fixed z-40 w-80 rounded-md border border-zinc-200 bg-white p-3 text-sm text-zinc-500 shadow-xl"
        style={{ left: x, top: y }}
      >
        No matching files
      </div>
    );
  }

  return (
    <div
      className="fixed z-40 max-h-96 w-96 max-w-[calc(100vw-1rem)] overflow-auto rounded-md border border-zinc-200 bg-white p-1 shadow-xl"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {indexedSections.map((section) => (
        <div key={section.title} className="py-1">
          <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            {section.title}
          </div>
          {section.options.map(({ option, optionIndex }) => {
            const selected = optionIndex === activeIndex;

            return (
              <button
                key={option.id}
                className={`flex w-full min-w-0 items-center gap-2 rounded px-2.5 py-2 text-left ${
                  selected ? "bg-zinc-100" : "hover:bg-zinc-50"
                }`}
                type="button"
                onClick={() => onSelect(optionSelection(option))}
              >
                <span className="shrink-0 text-zinc-500">{fileIcon(option.file)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-900">
                    {option.title}
                  </span>
                  <span className="block truncate text-xs text-zinc-500">
                    {option.subtitle}
                  </span>
                </span>
                {option.source === "tab" ? (
                  <PanelTop aria-hidden className="h-4 w-4 shrink-0 text-zinc-400" />
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
