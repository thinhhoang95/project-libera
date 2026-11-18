"use client";

import {
  AlertCircle,
  BookCheck,
  BookOpen,
  Braces,
  Copy,
  FileText,
  FileType2,
  Globe,
  Link2,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  Quote,
  RotateCw,
  ScrollText,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  authorYearLabel,
  entryTitle,
  entryVenue,
  fileBaseName,
  highlightSegments,
  readingLabel,
  statusLabel,
} from "@/components/libera/references/reference-display";
import { popupReferenceMenu, type ReferenceMenuItem } from "./native-reference-menu";
import { RetractionBadge } from "@/components/libera/references/retraction-badge";
import type { LatexCiteCommand } from "@/lib/references/latex-cite-syntax";
import type { ReferenceEntry, ReferenceStatus } from "@/lib/references/types";

// One library entry in the References panel list, its actions menu, and the
// red row for a key the active document cites that is not in the library.

/** Rows have a fixed height so long lists can be windowed. */
export const REFERENCE_ROW_HEIGHT = 74;

export const CITE_UNAVAILABLE = "Open a Markdown or LaTeX document and place the cursor to cite";
export const FIND_IN_FILE_LABEL = "Find citation in current file";
export const FIND_IN_FILE_UNAVAILABLE = "The open Markdown or LaTeX file does not cite this reference";

/** How Cite at cursor writes a citation: `[@key]` in Markdown, a `\cite` or `\citep` command in LaTeX. */
export type CiteSyntax = "markdown" | "latex";
export type { LatexCiteCommand };

/** Translates `references.referenceRow` messages (`useTranslations("references.referenceRow")`); English without it. */
export type RowTranslator = (key: string, values?: Record<string, string | number>) => string;

/** The Cite at cursor actions of a syntax: one in Markdown, `\cite` and `\citep` in LaTeX. */
export function citeActions(syntax: CiteSyntax, t?: RowTranslator): { command?: LatexCiteCommand; label: string }[] {
  return syntax === "latex"
    ? [{ command: "cite", label: t ? t("latexCiteAtCursor", { command: "\\cite" }) : "\\cite at cursor" }, { command: "citep", label: t ? t("latexCiteAtCursor", { command: "\\citep" }) : "\\citep at cursor" }]
    : [{ label: t ? t("citeAtCursor") : "Cite at cursor" }];
}

const hoverButton = "libera-sidebar-icon-button inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md disabled:opacity-40";

export function Highlighted({ text, words }: { text: string; words: string[] }) {
  const segments = highlightSegments(text, words);
  return (
    <>
      {segments.map((segment, index) => segment.match
        ? <mark key={index} className="libera-links-match">{segment.text}</mark>
        : <span key={index}>{segment.text}</span>)}
    </>
  );
}

export function StatusBadge({ status }: { status: ReferenceStatus | "duplicate" | "missing" }) {
  const t = useTranslations("references.referenceRow");
  const tDisplay = useTranslations("references.referenceDisplay");
  if (status === "confirmed") return null;
  const label = status === "duplicate" ? t("duplicate") : status === "missing" ? t("missing") : statusLabel(status, tDisplay);
  return <span className="libera-reference-badge" data-status={status}>{label}</span>;
}

export function AttachmentIcons({ entry }: { entry: ReferenceEntry }) {
  const t = useTranslations("references.referenceRow");
  const kinds = new Set(entry.attachments.map((attachment) => attachment.kind));
  return (
    <>
      {kinds.has("pdf") ? <span title={t("pdfAttached")} aria-label={t("pdfAttached")} className="libera-reference-attachment" data-kind="pdf"><FileType2 aria-hidden className="h-3.5 w-3.5" /></span> : null}
      {kinds.has("markdown") ? <span title={t("markdownNoteAttached")} aria-label={t("markdownNoteAttached")} className="libera-reference-attachment" data-kind="markdown"><FileText aria-hidden className="h-3.5 w-3.5" /></span> : null}
      {kinds.has("url") ? <span title={t("webLinkAttached")} aria-label={t("webLinkAttached")} className="libera-reference-attachment" data-kind="url"><Globe aria-hidden className="h-3.5 w-3.5" /></span> : null}
    </>
  );
}

type RowProps = {
  entry: ReferenceEntry;
  words: string[];
  selected: boolean;
  citedByActive: boolean;
  citingCount: number;
  duplicate: boolean;
  canCite: boolean;
  citeSyntax?: CiteSyntax;
  /** Part of a selection of several entries. */
  inSelection?: boolean;
  top?: number;
  /** A plain click opens the entry; Shift extends the selection and ⌘/Ctrl toggles it. */
  onOpen: (modifiers: { range: boolean; toggle: boolean }) => void;
  onTag?: (tag: string) => void;
  onCite: (command?: LatexCiteCommand) => void;
  onOpenAttachment: (path: string) => void;
  onMenu: (point: { x: number; y: number }) => void;
};

/** Rows show at most this many tags. */
const ROW_TAGS = 2;

export function ReadingBadge({ entry }: { entry: Pick<ReferenceEntry, "reading"> }) {
  const tDisplay = useTranslations("references.referenceDisplay");
  if (!entry.reading) return null;
  const label = readingLabel(entry.reading, tDisplay);
  return (
    <span className="libera-reference-reading shrink-0" data-reading={entry.reading} title={label} aria-label={label}>
      {entry.reading === "to-read" ? <BookOpen aria-hidden className="h-3.5 w-3.5" /> : <BookCheck aria-hidden className="h-3.5 w-3.5" />}
    </span>
  );
}

export function ReferenceRow({ entry, words, selected, inSelection, citedByActive, citingCount, duplicate, canCite, citeSyntax = "markdown", top, onOpen, onTag, onCite, onOpenAttachment, onMenu }: RowProps) {
  const t = useTranslations("references.referenceRow");
  const tDisplay = useTranslations("references.referenceDisplay");
  const pdf = entry.attachments.find((attachment) => attachment.kind === "pdf");
  const tags = entry.tags ?? [];
  const venue = entryVenue(entry.csl);
  const title = entryTitle(entry, tDisplay);
  const countLabel = t("citedByCount", { count: citingCount });
  return (
    <div
      id={`reference-row-${entry.id}`}
      role="option"
      aria-selected={selected || Boolean(inSelection)}
      data-entry-id={entry.id}
      data-cited={citedByActive || undefined}
      data-in-selection={inSelection || undefined}
      className="libera-reference-row group"
      style={{ height: REFERENCE_ROW_HEIGHT, ...(top !== undefined ? { position: "absolute", top, left: 0, right: 0 } : {}) }}
      onMouseDown={(event) => {
        // Shift-click selects a range, not text.
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => onOpen({ range: event.shiftKey, toggle: event.metaKey || event.ctrlKey })}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">
          <Highlighted text={authorYearLabel(entry.csl, tDisplay)} words={words} />
        </span>
        {citedByActive ? (
          <span className="shrink-0 text-muted-foreground" title={t("citedInOpenDocument")} aria-label={t("citedInOpenDocument")}>
            <Link2 aria-hidden className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <ReadingBadge entry={entry} />
        <StatusBadge status={entry.status} />
        <RetractionBadge status={entry.retraction} compact />
        {duplicate ? <StatusBadge status="duplicate" /> : null}
        {citingCount ? <span className="libera-backlink-count" title={countLabel} aria-label={countLabel}><Quote aria-hidden className="h-3 w-3" />{citingCount}</span> : null}
      </div>
      <div className="truncate text-[12px] leading-5" title={title}>
        <Highlighted text={title} words={words} />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-12 shrink-[3] truncate">
          {venue ? <><Highlighted text={venue} words={words} />{" · "}</> : null}
          <span className="font-mono"><Highlighted text={entry.key} words={words} /></span>
        </span>
        {tags.slice(0, ROW_TAGS).map((tag) => onTag ? (
          <button key={tag} type="button" className="libera-reference-tag-link" title={t("showTaggedTitle", { tag })} onClick={(event) => { event.stopPropagation(); onTag(tag); }}>
            #<Highlighted text={tag} words={words} />
          </button>
        ) : <span key={tag} className="libera-reference-tag-link">#{tag}</span>)}
        {tags.length > ROW_TAGS ? <span className="shrink-0" title={tags.slice(ROW_TAGS).join(", ")}>+{tags.length - ROW_TAGS}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 group-hover:hidden group-focus-within:hidden" data-selected={selected || undefined}>
          <AttachmentIcons entry={entry} />
        </span>
        <span className="libera-reference-row-actions ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
          {citeSyntax === "latex" ? citeActions("latex", t).map(({ command }) => (
            <button
              key={command}
              type="button"
              className={`${hoverButton} w-auto px-1 font-mono text-[10.5px]`}
              aria-label={t("latexCiteKeyAria", { command: `\\${command}`, key: entry.key })}
              title={canCite ? t("latexCiteTitle", { command: `\\${command}`, shortcut: command === "citep" ? "⌘/Ctrl+Shift+Enter" : "⌘/Ctrl+Enter" }) : t("citeUnavailable")}
              disabled={!canCite}
              onClick={(event) => { event.stopPropagation(); onCite(command); }}
            >
              {`\\${command}`}
            </button>
          )) : (
            <button
              type="button"
              className={hoverButton}
              aria-label={t("citeKeyAria", { key: entry.key })}
              title={canCite ? t("citeTitle") : t("citeUnavailable")}
              disabled={!canCite}
              onClick={(event) => { event.stopPropagation(); onCite(); }}
            >
              <Quote aria-hidden className="h-3.5 w-3.5" />
            </button>
          )}
          {pdf && pdf.kind === "pdf" ? (
            <button type="button" className={hoverButton} aria-label={t("openPdfOf", { key: entry.key })} title={t("openFileTitle", { name: fileBaseName(pdf.path) })} onClick={(event) => { event.stopPropagation(); onOpenAttachment(pdf.path); }}>
              <FileType2 aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            className={hoverButton}
            aria-label={t("actionsFor", { key: entry.key })}
            title={t("moreActions")}
            onClick={(event: ReactMouseEvent) => {
              event.stopPropagation();
              const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
              onMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <MoreHorizontal aria-hidden className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
    </div>
  );
}

/** A key the open document cites that no entry has, with a way to add it. */
export function MissingReferenceRow({ citationKey, onAdd }: { citationKey: string; onAdd: () => void }) {
  const t = useTranslations("references.referenceRow");
  return (
    <div role="option" aria-selected={false} className="libera-reference-row libera-reference-missing" data-missing-key={citationKey} style={{ height: REFERENCE_ROW_HEIGHT }}>
      <div className="flex min-w-0 items-center gap-1.5">
        <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-destructive">@{citationKey}</span>
        <StatusBadge status="missing" />
      </div>
      <div className="truncate text-[12px] leading-5 text-muted-foreground">{t("notInLibrary")}</div>
      <div className="flex items-center">
        <button type="button" className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline" onClick={onAdd}>
          <Plus aria-hidden className="h-3 w-3" /> {t("addToLibrary")}
        </button>
      </div>
    </div>
  );
}

export type ReferenceMenuAction =
  | "cite" | "citep" | "find-in-file" | "open-pdf" | "open-note" | "copy-key" | "copy-citation" | "copy-latex" | "copy-formatted"
  | "to-read" | "read" | "reresolve" | "edit" | "delete";

/** Menu labels of the reading actions: they toggle the flag. */
export function readingActionLabel(entry: Pick<ReferenceEntry, "reading">, action: "to-read" | "read", t?: RowTranslator) {
  if (action === "to-read") return entry.reading === "to-read" ? (t ? t("removeFromToRead") : "Remove from To read") : (t ? t("markAsToRead") : "Mark as To read");
  return entry.reading === "read" ? (t ? t("markAsUnread") : "Mark as unread") : (t ? t("markAsRead") : "Mark as read");
}

type MenuProps = {
  entry: ReferenceEntry;
  point: { x: number; y: number };
  canCite: boolean;
  citeSyntax?: CiteSyntax;
  /** The open Markdown or LaTeX file cites the entry, so Find citation in current file can go to it. */
  canFind?: boolean;
  citing: string[];
  onAction: (action: ReferenceMenuAction) => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
  /** For the native menu, which cannot call hooks: `useTranslations("references.referenceRow")` from the caller. */
  t?: RowTranslator;
};

export function openNativeReferenceActionsMenu({ point, ...props }: Omit<MenuProps, "onClose">) {
  return popupReferenceMenu(referenceActionsMenuItems(props), point);
}

/** A reference's actions, for its row's native menu and the macOS References menu. */
export function referenceActionsMenuItems({ entry, canCite, citeSyntax = "markdown", canFind = false, citing, onAction, onOpenPath, t }: Omit<MenuProps, "onClose" | "point">): ReferenceMenuItem[] {
  const tr = (key: string, english: string, values?: Record<string, string | number>) => t ? t(key, values) : english;
  const action = (id: ReferenceMenuAction, label: string, enabled = true): ReferenceMenuItem => ({ id, label, enabled, onSelect: () => onAction(id) });
  return [
    ...citeActions(citeSyntax, t).map(({ command, label }) => action(command === "citep" ? "citep" : "cite", label, canCite)),
    action("find-in-file", tr("findInFile", FIND_IN_FILE_LABEL), canFind),
    ...(entry.attachments.some((attachment) => attachment.kind === "pdf") ? [action("open-pdf", tr("openPdf", "Open PDF"))] : []),
    ...(entry.attachments.some((attachment) => attachment.kind === "markdown") ? [action("open-note", tr("openNote", "Open note"))] : []),
    action("copy-key", tr("copyKey", "Copy key")),
    action("copy-citation", tr("copyAs", `Copy as [@${entry.key}]`, { citation: `[@${entry.key}]` })),
    action("copy-latex", tr("copyAs", `Copy as \\cite{${entry.key}}`, { citation: `\\cite{${entry.key}}` })),
    action("copy-formatted", tr("copyFormatted", "Copy formatted reference")),
    { type: "separator" },
    action("to-read", readingActionLabel(entry, "to-read", t)),
    action("read", readingActionLabel(entry, "read", t)),
    { id: "citing", label: citing.length ? tr("citingDocumentsCount", `Citing documents (${citing.length})`, { count: citing.length }) : tr("notCitedYet", "Not cited yet"), enabled: citing.length > 0,
      ...(citing.length ? { submenu: citing.map((path, index) => ({ id: `citing:${index}`, label: fileBaseName(path), onSelect: () => onOpenPath(path) })) } : {}) },
    { type: "separator" },
    action("reresolve", tr("reresolveMenu", "Re-resolve…")),
    action("edit", tr("editMenu", "Edit…")),
    action("delete", tr("deleteMenu", "Delete…")),
  ];
}

function MenuItem({ icon, label, onClick, disabled, title, tone }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; title?: string; tone?: "destructive" }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] disabled:opacity-40 ${tone === "destructive" ? "text-destructive hover:bg-destructive-muted" : "hover:bg-muted"}`}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** The row's actions as a popover menu (hover button or right-click). */
export function ReferenceActionsMenu({ entry, point, canCite, citeSyntax = "markdown", canFind = false, citing, onAction, onOpenPath, onClose }: MenuProps) {
  const t = useTranslations("references.referenceRow");
  const menuRef = useRef<HTMLDivElement>(null);
  const [showCiting, setShowCiting] = useState(false);
  const pdf = entry.attachments.find((attachment) => attachment.kind === "pdf");
  const note = entry.attachments.find((attachment) => attachment.kind === "markdown");

  useEffect(() => {
    function close(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
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

  const act = (action: ReferenceMenuAction) => () => {
    onClose();
    onAction(action);
  };
  const left = typeof window !== "undefined" ? Math.min(point.x, Math.max(0, window.innerWidth - 240)) : point.x;

  const top = typeof window !== "undefined" ? Math.min(point.y, Math.max(0, window.innerHeight - 360)) : point.y;

  if (typeof document === "undefined") return null;
  // Portal to body: the panel clips/contains fixed descendants, which cut the menu off at the panel edge.
  return createPortal(
    <div ref={menuRef} role="menu" aria-label={t("actionsFor", { key: entry.key })} className="fixed z-50 w-56 rounded-lg border border-border bg-card p-1 shadow-lg" style={{ left, top }}>
      {citeActions(citeSyntax, t).map(({ command, label }) => (
        <MenuItem key={label} icon={<Quote aria-hidden className="h-4 w-4" />} label={label} disabled={!canCite} title={canCite ? undefined : t("citeUnavailable")} onClick={act(command === "citep" ? "citep" : "cite")} />
      ))}
      <MenuItem icon={<Search aria-hidden className="h-4 w-4" />} label={t("findInFile")} disabled={!canFind} title={canFind ? undefined : t("findInFileUnavailable")} onClick={act("find-in-file")} />
      {pdf ? <MenuItem icon={<FileType2 aria-hidden className="h-4 w-4" />} label={t("openPdf")} onClick={act("open-pdf")} /> : null}
      {note ? <MenuItem icon={<NotebookPen aria-hidden className="h-4 w-4" />} label={t("openNote")} onClick={act("open-note")} /> : null}
      <MenuItem icon={<Copy aria-hidden className="h-4 w-4" />} label={t("copyKey")} onClick={act("copy-key")} />
      <MenuItem icon={<Quote aria-hidden className="h-4 w-4" />} label={t("copyAs", { citation: `[@${entry.key}]` })} onClick={act("copy-citation")} />
      <MenuItem icon={<Braces aria-hidden className="h-4 w-4" />} label={t("copyAs", { citation: `\\cite{${entry.key}}` })} onClick={act("copy-latex")} />
      <MenuItem icon={<ScrollText aria-hidden className="h-4 w-4" />} label={t("copyFormatted")} onClick={act("copy-formatted")} />
      <div className="my-1 h-px bg-border" />
      <MenuItem icon={<BookOpen aria-hidden className="h-4 w-4" />} label={readingActionLabel(entry, "to-read", t)} onClick={act("to-read")} />
      <MenuItem icon={<BookCheck aria-hidden className="h-4 w-4" />} label={readingActionLabel(entry, "read", t)} onClick={act("read")} />
      <MenuItem
        icon={<Link2 aria-hidden className="h-4 w-4" />}
        label={citing.length ? t("citingDocumentsCount", { count: citing.length }) : t("notCitedYet")}
        disabled={!citing.length}
        onClick={() => setShowCiting((current) => !current)}
      />
      {showCiting ? (
        <ul className="max-h-48 overflow-auto py-1 pl-6" aria-label={t("citingDocumentsList")}>
          {citing.map((path) => (
            <li key={path}>
              <button type="button" role="menuitem" className="block w-full truncate rounded px-2 py-1 text-left text-[12px] hover:bg-muted" title={path} onClick={() => { onClose(); onOpenPath(path); }}>
                {fileBaseName(path)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="my-1 h-px bg-border" />
      <MenuItem icon={<RotateCw aria-hidden className="h-4 w-4" />} label={t("reresolveMenu")} onClick={act("reresolve")} />
      <MenuItem icon={<Pencil aria-hidden className="h-4 w-4" />} label={t("editMenu")} onClick={act("edit")} />
      <MenuItem icon={<Trash2 aria-hidden className="h-4 w-4" />} label={t("deleteMenu")} tone="destructive" onClick={act("delete")} />
    </div>,
    document.body,
  );
}
