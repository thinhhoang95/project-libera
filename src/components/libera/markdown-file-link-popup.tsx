"use client";

import { useTranslations } from "next-intl";
import { FileAudio, FileText, Hash, Image as ImageIcon, PanelTop, ScrollText } from "lucide-react";
import type {
  MarkdownFileLinkSelection,
  OpenTab,
  OpenTabViewState,
} from "@/components/libera/types";
import { formatClock } from "@/lib/transcription/format";
import type { LiberaFileNode } from "@/lib/types";
import type { MarkdownHeadingAnchor } from "@/lib/markdown-heading-anchors";
import { isMarkdownSourceRange, markdownLinkQuoteLabel } from "@/lib/markdown-selection-links";
import { annotationLinkLabel, findRememberedAnnotation } from "@/lib/annotation-links";

/** A description of an open tab's current view, shown in the interface language by the popup. */
export type MarkdownFileLinkViewSubtitle = {
  key: "pdfViewSubtitle" | "imageViewSubtitle" | "audioPositionSubtitle" | "annotationSubtitle" | "highlightedTextSubtitle" | "markdownLineSubtitle" | "markdownViewSubtitle";
  values?: Record<string, string | number>;
};

export type MarkdownFileLinkPopupOption = {
  file: LiberaFileNode;
  id: string;
  source: "file" | "tab";
  /** The file's path (files only; tabs describe their view in `view`). */
  subtitle: string;
  view?: MarkdownFileLinkViewSubtitle;
  title: string;
  viewState?: OpenTabViewState;
};

export type MarkdownFileLinkPopupSection = {
  options: MarkdownFileLinkPopupOption[];
  kind: "recent" | "files" | "tabs";
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

  if (file.fileType === "audio") {
    return <FileAudio aria-hidden className="h-4 w-4" />;
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
    // Gallery photos live outside notebooks, so a note cannot link to them.
    .filter((tab) => tab.file.path !== activeFilePath && !tab.gallery && !tab.recording)
    .map((tab) => ({
      file: tab.file,
      id: `tab:${tab.id}`,
      source: "tab" as const,
      subtitle: "",
      view: currentViewSubtitle(tab),
      title: tab.file.name,
      viewState: tab.viewState,
    }));
  const sections: MarkdownFileLinkPopupSection[] = [];

  if (primaryOptions.length) {
    sections.push({
      kind: normalizedQuery ? "files" : "recent",
      options: primaryOptions,
    });
  }

  if (tabOptions.length) {
    sections.push({
      kind: "tabs",
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

function currentViewSubtitle(tab: OpenTab): MarkdownFileLinkViewSubtitle {
  const annotationId = tab.file.fileType === "pdf"
    ? tab.viewState?.pdf?.selectedAnnotationId
    : tab.file.fileType === "image" ? tab.viewState?.image?.selectedAnnotationId : undefined;

  if (annotationId) {
    const annotation = findRememberedAnnotation(tab.file.path, annotationId);
    return { key: "annotationSubtitle", values: { kind: annotation?.type === "highlight" ? "highlight" : "note", label: annotationLinkLabel(annotation, "") } };
  }

  if (tab.file.fileType === "pdf") {
    const scrollTop = Math.round(tab.viewState?.pdf?.scrollTop ?? 0);
    const zoom = Math.round((tab.viewState?.pdf?.zoom ?? 1) * 100);

    return { key: "pdfViewSubtitle", values: { zoom: zoom / 100, scrollTop } };
  }

  if (tab.file.fileType === "image") {
    const zoom = Math.round((tab.viewState?.image?.zoom ?? 1) * 100);

    return { key: "imageViewSubtitle", values: { zoom: zoom / 100 } };
  }

  if (tab.file.fileType === "audio") {
    return { key: "audioPositionSubtitle", values: { time: formatClock(tab.viewState?.audio?.currentTime ?? 0) } };
  }

  const highlighted = tab.viewState?.markdown?.linkSelection;

  if (isMarkdownSourceRange(highlighted, tab.draft)) {
    return { key: "highlightedTextSubtitle", values: { quote: markdownLinkQuoteLabel(tab.draft.slice(highlighted.start, highlighted.end)) } };
  }

  const line = tab.viewState?.markdown?.line;

  return typeof line === "number"
    ? { key: "markdownLineSubtitle", values: { line } }
    : { key: "markdownViewSubtitle" };
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
  const t = useTranslations("markdownFileLinkPopup");
  const subtitleOf = (option: MarkdownFileLinkPopupOption) => {
    const view = option.view;
    if (!view) return option.subtitle;
    const values = view.key === "annotationSubtitle" && !view.values?.label ? { ...view.values, label: t("selectedFallback") } : view.values;
    return t(view.key, values);
  };
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
        className="fixed z-40 w-80 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground shadow-xl"
        style={{ left: x, top: y }}
      >
        {t("noMatchingFiles")}
      </div>
    );
  }

  return (
    <div
      className="fixed z-40 max-h-96 w-96 max-w-[calc(100vw-1rem)] overflow-auto rounded-lg border border-border bg-card p-1 shadow-xl"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {indexedSections.map((section) => (
        <div key={section.kind} className="py-1">
          <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t(`${section.kind}Section`)}
          </div>
          {section.options.map(({ option, optionIndex }) => {
            const selected = optionIndex === activeIndex;

            return (
              <button
                key={option.id}
                className={`flex w-full min-w-0 items-center gap-2 rounded px-2.5 py-2 text-left ${
                  selected ? "bg-muted" : "hover:bg-muted"
                }`}
                type="button"
                onClick={() => onSelect(optionSelection(option))}
              >
                <span className="shrink-0 text-muted-foreground">{fileIcon(option.file)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {option.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {subtitleOf(option)}
                  </span>
                </span>
                {option.source === "tab" ? (
                  <PanelTop aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function MarkdownHeadingLinkPopup({
  activeIndex,
  headings,
  x,
  y,
  onSelect,
}: {
  activeIndex: number;
  headings: MarkdownHeadingAnchor[];
  x: number;
  y: number;
  onSelect: (heading: MarkdownHeadingAnchor) => void;
}) {
  const t = useTranslations("markdownFileLinkPopup");
  if (!headings.length) {
    return (
      <div
        className="fixed z-40 w-80 rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground shadow-xl"
        style={{ left: x, top: y }}
      >
        {t("noMatchingHeadings")}
      </div>
    );
  }

  return (
    <div
      className="fixed z-40 max-h-96 w-96 max-w-[calc(100vw-1rem)] overflow-auto rounded-lg border border-border bg-card p-1 shadow-xl"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="py-1">
        <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("headingsSection")}
        </div>
        {headings.map((heading, index) => (
          <button
            key={heading.offset}
            className={`flex w-full min-w-0 items-center gap-2 rounded px-2.5 py-2 text-left ${
              index === activeIndex ? "bg-muted" : "hover:bg-muted"
            }`}
            ref={index === activeIndex ? (element) => element?.scrollIntoView?.({ block: "nearest" }) : undefined}
            type="button"
            onClick={() => onSelect(heading)}
          >
            <span className="shrink-0 text-muted-foreground"><Hash aria-hidden className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1" style={{ paddingLeft: `${(heading.level - 1) * 0.5}rem` }}>
              <span className="block truncate text-sm font-medium text-foreground">
                {heading.text}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {t("headingSubtitle", { level: heading.level, line: heading.line, slug: heading.slug })}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
