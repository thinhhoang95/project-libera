"use client";

import {
  AlertCircle,
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
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  authorYearLabel,
  entryTitle,
  entryVenue,
  fileBaseName,
  highlightSegments,
  STATUS_LABELS,
} from "@/components/libera/references/reference-display";
import type { ReferenceEntry, ReferenceStatus } from "@/lib/references/types";

// One library entry in the References panel list, its actions menu, and the
// red row for a key the active document cites that is not in the library.

/** Rows have a fixed height so long lists can be windowed. */
export const REFERENCE_ROW_HEIGHT = 74;

export const CITE_UNAVAILABLE = "Open a Markdown document and place the cursor to cite";

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
  if (status === "confirmed") return null;
  const label = status === "duplicate" ? "Duplicate" : status === "missing" ? "Missing" : STATUS_LABELS[status];
  return <span className="libera-reference-badge" data-status={status}>{label}</span>;
}

export function AttachmentIcons({ entry }: { entry: ReferenceEntry }) {
  const kinds = new Set(entry.attachments.map((attachment) => attachment.kind));
  return (
    <>
      {kinds.has("pdf") ? <span title="PDF attached" aria-label="PDF attached" className="libera-reference-attachment" data-kind="pdf"><FileType2 aria-hidden className="h-3.5 w-3.5" /></span> : null}
      {kinds.has("markdown") ? <span title="Markdown note attached" aria-label="Markdown note attached" className="libera-reference-attachment" data-kind="markdown"><FileText aria-hidden className="h-3.5 w-3.5" /></span> : null}
      {kinds.has("url") ? <span title="Web link attached" aria-label="Web link attached" className="libera-reference-attachment" data-kind="url"><Globe aria-hidden className="h-3.5 w-3.5" /></span> : null}
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
  top?: number;
  onOpen: () => void;
  onCite: () => void;
  onOpenAttachment: (path: string) => void;
  onMenu: (point: { x: number; y: number }) => void;
};

export function ReferenceRow({ entry, words, selected, citedByActive, citingCount, duplicate, canCite, top, onOpen, onCite, onOpenAttachment, onMenu }: RowProps) {
  const pdf = entry.attachments.find((attachment) => attachment.kind === "pdf");
  const venue = entryVenue(entry.csl);
  const countLabel = `Cited by ${citingCount} document${citingCount === 1 ? "" : "s"}`;
  return (
    <div
      id={`reference-row-${entry.id}`}
      role="option"
      aria-selected={selected}
      data-entry-id={entry.id}
      data-cited={citedByActive || undefined}
      className="libera-reference-row group"
      style={{ height: REFERENCE_ROW_HEIGHT, ...(top !== undefined ? { position: "absolute", top, left: 0, right: 0 } : {}) }}
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">
          <Highlighted text={authorYearLabel(entry.csl)} words={words} />
        </span>
        {citedByActive ? (
          <span className="shrink-0 text-accent" title="Cited in the open document" aria-label="Cited in the open document">
            <Link2 aria-hidden className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <StatusBadge status={entry.status} />
        {duplicate ? <StatusBadge status="duplicate" /> : null}
        {citingCount ? <span className="libera-backlink-count" title={countLabel} aria-label={countLabel}><Quote aria-hidden className="h-3 w-3" />{citingCount}</span> : null}
      </div>
      <div className="truncate text-[12px] leading-5" title={entryTitle(entry)}>
        <Highlighted text={entryTitle(entry)} words={words} />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {venue ? <><Highlighted text={venue} words={words} />{" · "}</> : null}
          <span className="font-mono"><Highlighted text={entry.key} words={words} /></span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 group-hover:hidden group-focus-within:hidden" data-selected={selected || undefined}>
          <AttachmentIcons entry={entry} />
        </span>
        <span className="libera-reference-row-actions ml-auto hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
          <button
            type="button"
            className={hoverButton}
            aria-label={`Cite ${entry.key} at cursor`}
            title={canCite ? "Cite at cursor (⌘/Ctrl+Enter)" : CITE_UNAVAILABLE}
            disabled={!canCite}
            onClick={(event) => { event.stopPropagation(); onCite(); }}
          >
            <Quote aria-hidden className="h-3.5 w-3.5" />
          </button>
          {pdf && pdf.kind === "pdf" ? (
            <button type="button" className={hoverButton} aria-label={`Open PDF of ${entry.key}`} title={`Open ${fileBaseName(pdf.path)}`} onClick={(event) => { event.stopPropagation(); onOpenAttachment(pdf.path); }}>
              <FileType2 aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            className={hoverButton}
            aria-label={`Actions for ${entry.key}`}
            title="More actions"
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
  return (
    <div role="option" aria-selected={false} className="libera-reference-row libera-reference-missing" data-missing-key={citationKey} style={{ height: REFERENCE_ROW_HEIGHT }}>
      <div className="flex min-w-0 items-center gap-1.5">
        <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-destructive">@{citationKey}</span>
        <StatusBadge status="missing" />
      </div>
      <div className="truncate text-[12px] leading-5 text-muted-foreground">Cited in this document but not in the library</div>
      <div className="flex items-center">
        <button type="button" className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline" onClick={onAdd}>
          <Plus aria-hidden className="h-3 w-3" /> Add to library…
        </button>
      </div>
    </div>
  );
}

export type ReferenceMenuAction =
  | "cite" | "open-pdf" | "open-note" | "copy-key" | "copy-formatted" | "reresolve" | "edit" | "delete";

type MenuProps = {
  entry: ReferenceEntry;
  point: { x: number; y: number };
  canCite: boolean;
  citing: string[];
  onAction: (action: ReferenceMenuAction) => void;
  onOpenPath: (path: string) => void;
  onClose: () => void;
};

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
export function ReferenceActionsMenu({ entry, point, canCite, citing, onAction, onOpenPath, onClose }: MenuProps) {
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

  return (
    <div ref={menuRef} role="menu" aria-label={`Actions for ${entry.key}`} className="fixed z-50 w-56 rounded-lg border border-border bg-card p-1 shadow-lg" style={{ left, top: point.y }}>
      <MenuItem icon={<Quote aria-hidden className="h-4 w-4" />} label="Cite at cursor" disabled={!canCite} title={canCite ? undefined : CITE_UNAVAILABLE} onClick={act("cite")} />
      {pdf ? <MenuItem icon={<FileType2 aria-hidden className="h-4 w-4" />} label="Open PDF" onClick={act("open-pdf")} /> : null}
      {note ? <MenuItem icon={<NotebookPen aria-hidden className="h-4 w-4" />} label="Open note" onClick={act("open-note")} /> : null}
      <MenuItem icon={<Copy aria-hidden className="h-4 w-4" />} label="Copy key" onClick={act("copy-key")} />
      <MenuItem icon={<ScrollText aria-hidden className="h-4 w-4" />} label="Copy formatted reference" onClick={act("copy-formatted")} />
      <MenuItem
        icon={<Link2 aria-hidden className="h-4 w-4" />}
        label={citing.length ? `Citing documents (${citing.length})` : "Not cited yet"}
        disabled={!citing.length}
        onClick={() => setShowCiting((current) => !current)}
      />
      {showCiting ? (
        <ul className="max-h-48 overflow-auto py-1 pl-6" aria-label="Citing documents">
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
      <MenuItem icon={<RotateCw aria-hidden className="h-4 w-4" />} label="Re-resolve…" onClick={act("reresolve")} />
      <MenuItem icon={<Pencil aria-hidden className="h-4 w-4" />} label="Edit…" onClick={act("edit")} />
      <MenuItem icon={<Trash2 aria-hidden className="h-4 w-4" />} label="Delete…" tone="destructive" onClick={act("delete")} />
    </div>
  );
}
