"use client";

import { ExternalLink, FileQuestion, Network, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { FileTypeIcon } from "@/components/libera/file-type";
import { ModalDialog } from "@/components/libera/modal-dialog";
import {
  createMarkdownFileLinkDestination,
  isExternalMarkdownLink,
  isLikelyWorkspaceMarkdownLink,
  resolveMarkdownFileLink,
} from "@/lib/markdown-file-links";
import { extractMarkdownLinkOccurrences, type MarkdownLinkOccurrence } from "@/lib/markdown-link-occurrences";
import type { LiberaFileNode, LiberaFilePayload } from "@/lib/types";

type LinkDirection = "backlinks" | "forward";

export type NoteLinkGroup = {
  key: string;
  kind: "file" | "external" | "missing";
  title: string;
  /** The folder path of a file group; empty for links outside the library (see `note`). */
  subtitle: string;
  /** Why a non-file group has no path: a web link, a library link to a missing file, or any other link. */
  note?: "web" | "missing" | "other";
  file?: LiberaFileNode;
  /** Opens the group's file or URL from the current note. */
  href: string;
  items: Array<MarkdownLinkOccurrence & { openHref: string }>;
};

const BACKLINK_READ_CONCURRENCY = 6;

function fileSubtitle(file: LiberaFileNode) {
  return file.path.split("/").slice(0, -1).join(" / ");
}

/** Links in the current note, grouped by destination in first-seen order. */
export function forwardLinkGroups(content: string, documentPath: string, files: LiberaFileNode[]): NoteLinkGroup[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const groups = new Map<string, NoteLinkGroup>();
  for (const occurrence of extractMarkdownLinkOccurrences(content)) {
    const file = resolveMarkdownFileLink(occurrence.href, documentPath, filesByPath)?.file;
    if (file?.path === documentPath || occurrence.href.startsWith("#")) continue;
    const group: Omit<NoteLinkGroup, "items"> = file
      ? { key: `file:${file.path}`, kind: "file", title: file.name, subtitle: fileSubtitle(file), file, href: occurrence.href }
      : isExternalMarkdownLink(occurrence.href)
        ? { key: `url:${occurrence.href}`, kind: "external", title: occurrence.href.replace(/^https?:\/\//, ""), subtitle: "", note: "web", href: occurrence.href }
        : { key: `missing:${occurrence.href}`, kind: "missing", title: occurrence.href,
            subtitle: "", note: isLikelyWorkspaceMarkdownLink(occurrence.href) ? "missing" : "other", href: occurrence.href };
    const existing = groups.get(group.key) ?? { ...group, items: [] };
    existing.items.push({ ...occurrence, openHref: occurrence.href });
    groups.set(group.key, existing);
  }
  return [...groups.values()];
}

/** Notes whose saved Markdown links to this file, with each link's excerpt. */
export function backlinkGroups(
  documentPath: string,
  files: LiberaFileNode[],
  contents: ReadonlyMap<string, string>,
): NoteLinkGroup[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const groups: NoteLinkGroup[] = [];
  for (const [sourcePath, content] of contents) {
    const source = filesByPath.get(sourcePath);
    if (!source) continue;
    const items = extractMarkdownLinkOccurrences(content)
      .filter((occurrence) => resolveMarkdownFileLink(occurrence.href, sourcePath, filesByPath)?.file.path === documentPath)
      .map((occurrence) => ({
        ...occurrence,
        // Opens the source note at the line that holds the link.
        openHref: createMarkdownFileLinkDestination({
          sourcePath: documentPath, targetPath: sourcePath,
          metadata: { v: 1, fileType: "markdown", viewState: { markdown: { line: occurrence.line } } },
        }),
      }));
    if (!items.length) continue;
    groups.push({
      key: `file:${sourcePath}`, kind: "file", title: source.name, subtitle: fileSubtitle(source), file: source,
      href: createMarkdownFileLinkDestination({ sourcePath: documentPath, targetPath: sourcePath }), items,
    });
  }
  return groups.sort((left, right) => left.title.localeCompare(right.title));
}

/** Keeps groups and occurrences matching every search word. */
export function filterLinkGroups(groups: NoteLinkGroup[], query: string): NoteLinkGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  const matches = (text: string) => words.every((word) => text.includes(word));
  return groups.flatMap((group) => {
    const groupText = `${group.title} ${group.subtitle} ${group.href}`.toLowerCase();
    const items = group.items.filter(({ excerpt, href }) =>
      matches(`${groupText} ${href} ${excerpt.before}${excerpt.text}${excerpt.after}`.toLowerCase()));
    return items.length ? [{ ...group, items }] : [];
  });
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return <>{text.split(pattern).map((part, index) => index % 2 ? <mark key={index} className="libera-links-match">{part}</mark> : part)}</>;
}

function GroupIcon({ group }: { group: NoteLinkGroup }) {
  if (group.file) return <FileTypeIcon fileType={group.file.fileType} name={group.file.name} />;
  if (group.kind === "external") return <ExternalLink aria-hidden className="h-4 w-4" />;
  return <FileQuestion aria-hidden className="h-4 w-4" />;
}

export function NoteLinksButton({
  className,
  documentPath,
  files,
  getContent,
  onOpenLink,
}: {
  className: string;
  documentPath: string;
  files: LiberaFileNode[];
  /** Reads the note's current draft, so unsaved links are listed too. */
  getContent: () => string;
  onOpenLink: (href: string) => Promise<boolean> | void;
}) {
  const t = useTranslations("noteLinksDialog");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={t("linksButton")}
        title={t("linksButton")}
        className={className}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(true)}
      >
        <Network aria-hidden className="h-4 w-4" />
      </button>
      {open ? (
        <NoteLinksDialog
          documentPath={documentPath}
          files={files}
          content={getContent()}
          onClose={() => setOpen(false)}
          onOpenLink={(href) => {
            setOpen(false);
            if (isExternalMarkdownLink(href)) window.open(href, "_blank", "noopener,noreferrer");
            else void onOpenLink(href);
          }}
        />
      ) : null}
    </>
  );
}

export function NoteLinksDialog({
  content,
  documentPath,
  files,
  onClose,
  onOpenLink,
}: {
  content: string;
  documentPath: string;
  files: LiberaFileNode[];
  onClose: () => void;
  onOpenLink: (href: string) => void;
}) {
  const t = useTranslations("noteLinksDialog");
  const [query, setQuery] = useState("");
  const [backlinkContents, setBacklinkContents] = useState<Map<string, string> | null>(null);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const sourcePaths = useMemo(
    () => files.filter((file) => file.path !== documentPath && file.linkedFilePaths?.includes(documentPath)).map((file) => file.path),
    [documentPath, files],
  );
  const forward = useMemo(() => forwardLinkGroups(content, documentPath, files), [content, documentPath, files]);
  const backlinks = useMemo(
    () => backlinkContents ? backlinkGroups(documentPath, files, backlinkContents) : [],
    [backlinkContents, documentPath, files],
  );
  const [direction, setDirection] = useState<LinkDirection>(sourcePaths.length ? "backlinks" : "forward");

  useEffect(() => {
    let cancelled = false;
    async function readSources() {
      const contents = new Map<string, string>();
      const queue = [...sourcePaths];
      let unreadable = 0;
      async function worker() {
        for (let sourcePath = queue.shift(); sourcePath; sourcePath = queue.shift()) {
          try {
            const payload = await apiRequest<LiberaFilePayload>(`/api/files?path=${encodeURIComponent(sourcePath)}`);
            contents.set(sourcePath, payload.content ?? "");
          } catch {
            unreadable += 1;
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(BACKLINK_READ_CONCURRENCY, queue.length) }, worker));
      if (cancelled) return;
      if (unreadable) setError(t("linkingNotesUnreadable", { count: unreadable }));
      setBacklinkContents(contents);
    }
    void readSources();
    return () => {
      cancelled = true;
    };
  }, [sourcePaths, t]);

  const visibleBacklinks = useMemo(() => filterLinkGroups(backlinks, query), [backlinks, query]);
  const visibleForward = useMemo(() => filterLinkGroups(forward, query), [forward, query]);
  const groups = direction === "backlinks" ? visibleBacklinks : visibleForward;
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const count = (list: NoteLinkGroup[]) => list.reduce((total, group) => total + group.items.length, 0);
  const selectedIndex = Math.min(activeIndex, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, direction]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) setActiveIndex((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (event.key === "Enter" && items[selectedIndex]) {
      event.preventDefault();
      onOpenLink(items[selectedIndex].openHref);
    } else if (event.key === "Tab" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      setDirection((current) => current === "backlinks" ? "forward" : "backlinks");
      setActiveIndex(0);
    }
  }

  let itemIndex = -1;
  let body: ReactNode;
  if (direction === "backlinks" && !backlinkContents) {
    body = <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("readingLinkingNotes")}</p>;
  } else if (!groups.length) {
    body = (
      <p className="px-3 py-6 text-center text-sm text-muted-foreground">
        {query ? t("noLinksMatch")
          : direction === "backlinks" ? t("noBacklinks") : t("noForwardLinks")}
      </p>
    );
  } else {
    body = groups.map((group) => (
      <section key={group.key} className="libera-links-group">
        <button type="button" className="libera-links-group-header" title={group.kind === "file" ? t("openGroup", { title: group.title }) : group.href} onClick={() => onOpenLink(group.href)}>
          <span className="libera-tree-file-icon shrink-0" data-type={group.file?.fileType}><GroupIcon group={group} /></span>
          <span className="min-w-0 flex-1 truncate font-medium"><Highlighted text={group.title} query={query} /></span>
          <span className="min-w-0 max-w-[45%] shrink truncate text-xs text-muted-foreground">{group.note ? t(`note.${group.note}`) : group.subtitle}</span>
          <span className="libera-links-count">{group.items.length}</span>
        </button>
        <ul>
          {group.items.map((item) => {
            itemIndex += 1;
            const index = itemIndex;
            return (
              <li key={`${item.line}-${index}`}>
                <button
                  type="button"
                  className="libera-links-item"
                  data-active={index === selectedIndex}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => onOpenLink(item.openHref)}
                >
                  <span className="libera-links-line">{t("lineLabel", { line: item.line })}</span>
                  <span className="min-w-0 flex-1">
                    <Highlighted text={item.excerpt.before} query={query} />
                    <span className="libera-links-anchor"><Highlighted text={item.excerpt.text} query={query} /></span>
                    <Highlighted text={item.excerpt.after} query={query} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    ));
  }

  return (
    <ModalDialog open title={t("title")} description={t("description")} panelClassName="max-w-2xl" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2">
          <Search aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            aria-label={t("searchLinks")}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div role="tablist" aria-label={t("linkDirection")} className="libera-links-tabs">
          {([["backlinks", t("backlinks"), visibleBacklinks], ["forward", t("forwardLinks"), visibleForward]] as const).map(([value, label, list]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={direction === value}
              onClick={() => {
                setDirection(value);
                setActiveIndex(0);
              }}
            >
              {label}
              <span className="libera-links-count">{value === "backlinks" && !backlinkContents ? "…" : count(list)}</span>
            </button>
          ))}
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div ref={listRef} role="tabpanel" className="libera-links-list">{body}</div>
        <p className="text-xs text-muted-foreground">{t("keyboardHint")}</p>
      </div>
    </ModalDialog>
  );
}
