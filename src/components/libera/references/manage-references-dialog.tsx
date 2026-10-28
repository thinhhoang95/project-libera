"use client";

import { ArrowDown, ArrowUp, CircleCheck, Copy, Download, FileText, FileType2, Globe, Library, Loader2, Merge, RefreshCw, Tag, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import {
  authorsLabel,
  changedTags,
  chooseKeptEntry,
  citingPaths,
  CSL_TYPE_LABELS,
  dateYear,
  DUPLICATE_GROUP_LABELS,
  duplicateGroupKind,
  entryTitle,
  entryVenue,
  fieldLabel,
  fileBaseName,
  foldSearchText,
  formatFieldValue,
  fullAuthorList,
  libraryTags,
  STATUS_LABELS,
  tagChangeText,
  typeLabel,
  venueField,
} from "@/components/libera/references/reference-display";
import { buildReresolveOp, isAbortError, reresolveDiff, reresolveEntry } from "@/components/libera/references/reference-candidates";
import { userProvenance } from "@/components/libera/references/reference-edit-form";
import { isReferenceUndoShortcut } from "@/components/libera/references/use-reference-undo";
import type { CitingDocuments } from "@/components/libera/references/use-reference-citations";
import { mergeEntryFields } from "@/lib/references/dedupe";
import { CSL_ITEM_TYPES, type CslItemType, type ReferenceEntry, type ReferenceLibrary, type ReferenceLibraryOp } from "@/lib/references/types";

// The Manage references dialog: a sortable, filterable, multi-select table
// for bulk work, a Duplicates tab, and the merge and delete confirmations the
// References panel shares. Export goes through POST /api/references/export.

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = [
  { id: "bibtex", label: "BibTeX", extension: "bib" },
  { id: "biblatex", label: "BibLaTeX", extension: "bib" },
  { id: "csl-json", label: "CSL-JSON", extension: "json" },
  { id: "ris", label: "RIS", extension: "ris" },
] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number]["id"];

/** The file name in a Content-Disposition header, if any. */
export function contentDispositionFileName(header: string | null) {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Fall back to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  return plain ? (plain[2] ?? plain[1]).trim() : null;
}

/**
 * Export the library (or the entries in `ids`) and save it as a download,
 * like other downloads in the app: an anchor with a blob URL, which the
 * desktop app turns into its Save dialog.
 */
export async function exportReferences(request: { notebook: string; format: ExportFormat; ids?: string[] }) {
  const response = await fetch("/api/references/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    let message = "The references could not be exported.";
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Not JSON.
    }
    throw new Error(message);
  }
  const extension = EXPORT_FORMATS.find((format) => format.id === request.format)?.extension ?? "txt";
  const fileName = contentDispositionFileName(response.headers.get("Content-Disposition")) ?? `${request.notebook} references.${extension}`;
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  return fileName;
}

// ---------------------------------------------------------------------------
// Merge and delete confirmations
// ---------------------------------------------------------------------------

const cancelButton = "inline-flex items-center gap-1.5 rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted";
const primaryButton = "inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90";
const destructiveButton = "inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-sm font-medium text-white";
/** The bulk actions toolbar: a small outlined button with its icon. */
const toolbarButton = "inline-flex items-center gap-1 rounded-lg border border-input px-2.5 py-1 font-medium hover:bg-muted disabled:opacity-50";

/** What merging `others` into `keep` produces, field by field (a preview; the `merge` op does the real work). */
export function mergePreview(keep: ReferenceEntry, others: ReferenceEntry[]) {
  let merged = keep;
  for (const other of others) merged = mergeEntryFields(merged, other);
  const filled = Object.keys(merged.csl).filter((field) => keep.csl[field] === undefined);
  const aliases = [...new Set([...keep.aliases, ...others.flatMap((other) => [other.key, ...other.aliases])])]
    .filter((alias) => alias.toLowerCase() !== keep.key.toLowerCase());
  return { merged, filled, aliases };
}

type MergeDialogProps = {
  group: ReferenceEntry[] | null;
  onClose: () => void;
  onMerge: (keepId: string, mergeIds: string[]) => Promise<unknown>;
};

export function MergeReferencesDialog({ group, onClose, onMerge }: MergeDialogProps) {
  if (!group || group.length < 2) return null;
  return <MergeDialogBody key={group.map((entry) => entry.id).join(",")} group={group} onClose={onClose} onMerge={onMerge} />;
}

function MergeDialogBody({ group, onClose, onMerge }: { group: ReferenceEntry[]; onClose: () => void; onMerge: MergeDialogProps["onMerge"] }) {
  const [keepId, setKeepId] = useState(() => chooseKeptEntry(group).id);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const keep = group.find((entry) => entry.id === keepId) ?? group[0];
  const others = group.filter((entry) => entry.id !== keep.id);
  const preview = mergePreview(keep, others);
  const fields = Object.keys(preview.merged.csl).filter((field) => field !== "abstract");

  async function merge() {
    setBusy(true);
    setError("");
    try {
      await onMerge(keep.id, others.map((entry) => entry.id));
      onClose();
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : "The references could not be merged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      open
      title={`Merge ${group.length} references`}
      description="One entry is kept. The others' keys become its aliases, so documents citing them keep working, and fields it lacks are filled from them."
      panelClassName="max-w-xl"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={cancelButton} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryButton} disabled={busy} onClick={() => void merge()}><Merge aria-hidden className="h-4 w-4" /> Merge into {keep.key}</button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {error ? <div role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</div> : null}
        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Keep</legend>
          {group.map((entry) => (
            <label key={entry.id} className="flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-muted">
              <input type="radio" name="merge-keep" className="mt-1" checked={entry.id === keep.id} onChange={() => setKeepId(entry.id)} aria-label={`Keep ${entry.key}`} />
              <span className="min-w-0">
                <span className="font-mono text-xs">{entry.key}</span>
                <span className="block truncate text-xs text-muted-foreground">{authorsLabel(entry.csl) || "No author"} ({dateYear(entry.csl.issued) ?? "n.d."}) · {entryTitle(entry)} · {entryVenue(entry.csl) || typeLabel(entry.csl.type)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="space-y-1" aria-label="Merge preview">
          <p className="text-xs font-medium text-muted-foreground">Result</p>
          <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            {fields.map((field) => (
              <div key={field} className="contents" data-filled={preview.filled.includes(field) || undefined}>
                <dt className="text-muted-foreground">{fieldLabel(field)}</dt>
                <dd className={`break-words ${preview.filled.includes(field) ? "text-accent" : ""}`}>
                  {formatFieldValue(field, preview.merged.csl[field])}
                  {preview.filled.includes(field) ? <span className="ml-1 text-[10px]">(filled in)</span> : null}
                </dd>
              </div>
            ))}
            <dt className="text-muted-foreground">Aliases</dt>
            <dd className="font-mono" aria-label="Aliases after merge">{preview.aliases.join(", ") || "—"}</dd>
            <dt className="text-muted-foreground">Attachments</dt>
            <dd>{preview.merged.attachments.length ? preview.merged.attachments.map((attachment) => attachment.kind === "url" ? attachment.url : fileBaseName(attachment.path)).join(", ") : "—"}</dd>
          </dl>
        </div>
      </div>
    </ModalDialog>
  );
}

type DeleteDialogProps = {
  entries: ReferenceEntry[] | null;
  citing: (entry: ReferenceEntry) => string[];
  onClose: () => void;
  onDelete: (ids: string[]) => Promise<unknown>;
};

/** Confirms deleting entries, naming the documents that cite them. */
export function DeleteReferencesDialog({ entries, citing, onClose, onDelete }: DeleteDialogProps) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!entries?.length) return null;
  const cited = entries.map((entry) => ({ entry, paths: citing(entry) })).filter((item) => item.paths.length);

  async function remove() {
    if (!entries) return;
    setBusy(true);
    setError("");
    try {
      await onDelete(entries.map((entry) => entry.id));
      onClose();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "The references could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      open
      title={entries.length === 1 ? `Delete ${entries[0].key}?` : `Delete ${entries.length} references?`}
      description={cited.length ? "Documents still cite these keys. Their citations will show as missing until you add the references again." : "You can undo this from the References panel."}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={cancelButton} onClick={onClose}>Cancel</button>
          <button type="button" className={destructiveButton} disabled={busy} onClick={() => void remove()}><Trash2 aria-hidden className="h-4 w-4" /> Delete</button>
        </>
      }
    >
      {error ? <div role="alert" className="mb-2 rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{error}</div> : null}
      {cited.length ? (
        <ul className="space-y-2 text-sm" aria-label="Cited references">
          {cited.map(({ entry, paths }) => (
            <li key={entry.id}>
              <span className="font-mono text-xs">{entry.key}</span> is cited in:
              <ul className="ml-4 list-disc text-xs text-muted-foreground">
                {paths.map((path) => <li key={path}>{path}</li>)}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{entries.map((entry) => entry.key).join(", ")}</p>
      )}
    </ModalDialog>
  );
}

// ---------------------------------------------------------------------------
// Duplicate groups (the dialog's tab and the panel's filter)
// ---------------------------------------------------------------------------

export function DuplicateGroupsList({ groups, onMerge, onOpen }: { groups: ReferenceEntry[][]; onMerge: (group: ReferenceEntry[]) => void; onOpen?: (entry: ReferenceEntry) => void }) {
  if (!groups.length) return <p className="px-1 py-6 text-center text-sm text-muted-foreground">No duplicates found.</p>;
  return (
    <ul className="space-y-2" aria-label="Duplicate groups">
      {groups.map((group) => {
        const kind = duplicateGroupKind(group);
        const kept = chooseKeptEntry(group);
        return (
          <li key={group.map((entry) => entry.id).join(",")} className="libera-panel-card space-y-1 p-2" data-duplicate-kind={kind}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{DUPLICATE_GROUP_LABELS[kind]}</span>
              <button type="button" className="libera-panel-button h-6 px-2 text-[11px]" aria-label={`Merge ${group.map((entry) => entry.key).join(", ")}`} onClick={() => onMerge(group)}>
                <Merge aria-hidden className="h-3 w-3" /> Merge
              </button>
            </div>
            <ul className="space-y-0.5">
              {group.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="libera-notebook-row block w-full px-1.5 py-1 text-left text-[12px]" onClick={() => onOpen?.(entry)} disabled={!onOpen}>
                    <span className="font-mono text-[11px]">{entry.key}</span>
                    {entry.id === kept.id ? <span className="ml-1.5 text-[10px] text-accent">kept</span> : null}
                    <span className="block truncate text-muted-foreground">{authorsLabel(entry.csl) || "No author"} ({dateYear(entry.csl.issued) ?? "n.d."}) · {entryTitle(entry)}{entryVenue(entry.csl) ? ` · ${entryVenue(entry.csl)}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export type ManageColumn = "key" | "authors" | "year" | "title" | "venue" | "type" | "status" | "cited" | "attachment" | "updated";

export const MANAGE_COLUMNS: Array<{ id: ManageColumn; label: string; width: string }> = [
  { id: "key", label: "Key", width: "w-36" },
  { id: "authors", label: "Authors", width: "w-40" },
  { id: "year", label: "Year", width: "w-16" },
  { id: "title", label: "Title", width: "min-w-64" },
  { id: "venue", label: "Venue", width: "w-44" },
  { id: "type", label: "Type", width: "w-32" },
  { id: "status", label: "Status", width: "w-28" },
  { id: "cited", label: "Cited by", width: "w-20" },
  { id: "attachment", label: "Attachment", width: "w-24" },
  { id: "updated", label: "Updated", width: "w-28" },
];

const TABLE_ROW_HEIGHT = 34;
const WINDOW_THRESHOLD = 300;

type Row = { entry: ReferenceEntry; cited: number; text: Record<ManageColumn, string> };

function cellText(entry: ReferenceEntry, column: ManageColumn, cited: number): string {
  switch (column) {
    case "key": return entry.key;
    case "authors": return fullAuthorList(entry.csl);
    case "year": return String(dateYear(entry.csl.issued) ?? "");
    case "title": return entryTitle(entry);
    case "venue": return entryVenue(entry.csl);
    case "type": return typeLabel(entry.csl.type);
    case "status": return STATUS_LABELS[entry.status];
    case "cited": return String(cited);
    case "attachment": return [...new Set(entry.attachments.map((attachment) => attachment.kind === "pdf" ? "PDF" : attachment.kind === "markdown" ? "Markdown" : "URL"))].join(", ");
    case "updated": return entry.updatedAt.slice(0, 10);
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Rows sorted by a column; numbers and dates compare as such. */
export function sortManageRows(rows: Row[], column: ManageColumn, direction: "asc" | "desc") {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let order: number;
    if (column === "cited") order = a.cited - b.cited;
    else if (column === "year") order = (Number(a.text.year) || 0) - (Number(b.text.year) || 0);
    else if (column === "updated") order = a.entry.updatedAt.localeCompare(b.entry.updatedAt);
    else order = collator.compare(a.text[column], b.text[column]);
    return sign * order || collator.compare(a.entry.key, b.entry.key);
  });
}

type ManageProps = {
  open: boolean;
  notebook: string;
  library: ReferenceLibrary;
  citations: CitingDocuments;
  duplicateGroups: ReferenceEntry[][];
  apply: (ops: ReferenceLibraryOp[], label: string) => Promise<unknown>;
  undo: { canUndo: boolean; stale: boolean; label: string | null; run: () => Promise<unknown> };
  /** Let the model search the web when re-resolving. */
  webSearch?: boolean;
  /** An online lookup is starting (for the privacy notice). */
  onLookup?: () => void;
  /** Entries were merged into `keep`: their keys are its aliases now, and their citations can be rewritten. */
  onMerged?: (keep: ReferenceEntry, merged: ReferenceEntry[]) => void;
  /** Another dialog is open on top, which takes Escape and outside clicks. */
  blocked?: boolean;
  onClose: () => void;
};

/**
 * Re-resolve entries one after another: each is looked up, the resolved
 * values replace the others' (fields the user wrote become conflicts), and
 * the result is saved as its own change, so cancelling keeps what finished.
 * Entries the sources agree with are left alone.
 */
export async function reresolveSequentially(input: {
  notebook: string;
  entries: ReferenceEntry[];
  webSearch: boolean;
  signal: AbortSignal;
  current: (id: string) => ReferenceEntry | undefined;
  apply: (ops: ReferenceLibraryOp[], label: string) => Promise<unknown>;
  onProgress: (done: number, entry: ReferenceEntry) => void;
}) {
  const summary = { updated: 0, unchanged: 0, failed: [] as string[], cancelled: false };
  for (const [index, listed] of input.entries.entries()) {
    if (input.signal.aborted) break;
    const entry = input.current(listed.id) ?? listed;
    input.onProgress(index, entry);
    try {
      const { candidate } = await reresolveEntry(input.notebook, entry, input.webSearch, input.signal);
      const latest = input.current(entry.id) ?? entry;
      const rows = reresolveDiff(latest, candidate);
      if (!rows.length) {
        summary.unchanged += 1;
        continue;
      }
      await input.apply([buildReresolveOp(latest, candidate, rows.filter((row) => !row.userOwned).map((row) => row.field))], `Re-resolve ${entry.key}`);
      summary.updated += 1;
    } catch (error) {
      if (input.signal.aborted || isAbortError(error)) break;
      summary.failed.push(`${entry.key}: ${error instanceof Error ? error.message : "could not be looked up"}`);
    }
  }
  summary.cancelled = input.signal.aborted;
  return summary;
}

export function ManageReferencesDialog({ open, notebook, library, citations, duplicateGroups, apply, undo, webSearch = false, onLookup, onMerged, blocked = false, onClose }: ManageProps) {
  const [tab, setTab] = useState<"all" | "duplicates">("all");
  const [sort, setSort] = useState<{ column: ManageColumn; direction: "asc" | "desc" }>({ column: "authors", direction: "asc" });
  const [filters, setFilters] = useState<Partial<Record<ManageColumn, string>>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; column: "title" | "year" | "venue"; value: string } | null>(null);
  const [mergeGroup, setMergeGroup] = useState<ReferenceEntry[] | null>(null);
  const [deleting, setDeleting] = useState<ReferenceEntry[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [scroll, setScroll] = useState({ top: 0, height: 600 });
  const [bulk, setBulk] = useState<{ done: number; total: number; key: string } | null>(null);
  const bulkRef = useRef<AbortController | null>(null);
  const libraryRef = useRef(library);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    libraryRef.current = library;
  }, [library]);
  // Closing the dialog stops a re-resolve run.
  useEffect(() => {
    if (!open) bulkRef.current?.abort();
  }, [open]);
  useEffect(() => () => bulkRef.current?.abort(), []);

  async function reresolveSelected(entries: ReferenceEntry[]) {
    const controller = new AbortController();
    bulkRef.current = controller;
    setError("");
    setNotice("");
    onLookup?.();
    setBulk({ done: 0, total: entries.length, key: entries[0]?.key ?? "" });
    const summary = await reresolveSequentially({
      notebook,
      entries,
      webSearch,
      signal: controller.signal,
      current: (id) => libraryRef.current.entries[id],
      apply,
      onProgress: (done, entry) => setBulk({ done, total: entries.length, key: entry.key }),
    });
    if (bulkRef.current === controller) bulkRef.current = null;
    setBulk(null);
    const parts = [`${summary.updated} updated`, `${summary.unchanged} unchanged`];
    if (summary.failed.length) parts.push(`${summary.failed.length} failed`);
    setNotice(`${summary.cancelled ? "Re-resolve stopped" : "Re-resolved"}: ${parts.join(", ")}.`);
    if (summary.failed.length) setError(summary.failed.join("\n"));
  }

  const citingOf = (entry: ReferenceEntry) => citingPaths(entry, citations);

  const rows = useMemo<Row[]>(() => Object.values(library.entries).map((entry) => {
    const cited = citingPaths(entry, citations).length;
    const text = Object.fromEntries(MANAGE_COLUMNS.map((column) => [column.id, cellText(entry, column.id, cited)])) as Record<ManageColumn, string>;
    return { entry, cited, text };
  }), [library, citations]);

  const visibleRows = useMemo(() => {
    const active = Object.entries(filters).filter(([, value]) => value?.trim()).map(([column, value]) => [column as ManageColumn, foldSearchText(value!.trim())] as const);
    const filtered = active.length ? rows.filter((row) => active.every(([column, value]) => foldSearchText(row.text[column]).includes(value))) : rows;
    return sortManageRows(filtered, sort.column, sort.direction);
  }, [rows, filters, sort]);

  // Selection only counts entries that still exist.
  const selectedEntries = visibleRows.map((row) => row.entry).filter((entry) => selected.has(entry.id));
  const allSelected = visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.entry.id));

  async function run(ops: ReferenceLibraryOp[], label: string, message?: string) {
    if (!ops.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await apply(ops, label);
      if (message) setNotice(message);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  /** Add tags to, or remove them from, every selected entry that changes. */
  function tagSelected(selection: ReferenceEntry[], add: string[], remove: string[]) {
    const ops: ReferenceLibraryOp[] = [];
    for (const entry of selection) {
      const tags = changedTags(entry, add, remove);
      if (tags) ops.push({ op: "update", id: entry.id, tags });
    }
    const { label, message } = tagChangeText(ops.length, add, remove);
    return run(ops, label, message);
  }

  function toggleRow(id: string, event: { shiftKey: boolean }) {
    const ids = visibleRows.map((row) => row.entry.id);
    setSelected((current) => {
      const next = new Set(current);
      if (event.shiftKey && anchor && ids.includes(anchor)) {
        const [from, to] = [ids.indexOf(anchor), ids.indexOf(id)].sort((a, b) => a - b);
        const select = !current.has(id);
        for (const rangeId of ids.slice(from, to + 1)) {
          if (select) next.add(rangeId);
          else next.delete(rangeId);
        }
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  }

  function commitEdit() {
    if (!editing) return;
    const entry = library.entries[editing.id];
    const value = editing.value.trim();
    setEditing(null);
    if (!entry) return;
    const now = new Date().toISOString();
    if (editing.column === "title") {
      if (value === entryTitle(entry) || value === (entry.csl.title ?? "")) return;
      void run([value
        ? { op: "update", id: entry.id, csl: { title: value }, provenance: { title: userProvenance(now) } }
        : { op: "update", id: entry.id, removeFields: ["title"] }], `Edit title of ${entry.key}`);
    } else if (editing.column === "year") {
      if (value === String(dateYear(entry.csl.issued) ?? "")) return;
      if (value && !/^\d{1,4}$/.test(value)) {
        setError("The year must be a number, such as 2020.");
        return;
      }
      const rest = entry.csl.issued?.["date-parts"]?.[0]?.slice(1) ?? [];
      void run([value
        ? { op: "update", id: entry.id, csl: { issued: { "date-parts": [[Number(value), ...rest] as [number, number?, number?]] } }, provenance: { issued: userProvenance(now) } }
        : { op: "update", id: entry.id, removeFields: ["issued"] }], `Edit year of ${entry.key}`);
    } else {
      const field = venueField(entry.csl);
      if (value === entryVenue(entry.csl)) return;
      void run([value
        ? { op: "update", id: entry.id, csl: { [field]: value }, provenance: { [field]: userProvenance(now) } }
        : { op: "update", id: entry.id, removeFields: [field] }], `Edit venue of ${entry.key}`);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent) {
    if (isReferenceUndoShortcut({ ...event, target: event.target })) {
      event.preventDefault();
      if (undo.canUndo) void undo.run().catch((undoError: Error) => setError(undoError.message));
    }
  }

  const windowed = visibleRows.length > WINDOW_THRESHOLD;
  const first = windowed ? Math.max(0, Math.floor(scroll.top / TABLE_ROW_HEIGHT) - 10) : 0;
  const last = windowed ? Math.min(visibleRows.length, Math.ceil((scroll.top + scroll.height) / TABLE_ROW_HEIGHT) + 10) : visibleRows.length;
  const childOpen = Boolean(mergeGroup || deleting || blocked);

  function editableCell(row: Row, column: "title" | "year" | "venue") {
    if (editing?.id === row.entry.id && editing.column === column) {
      return (
        <input
          className="h-7 w-full px-1.5 text-xs"
          aria-label={`Edit ${column} of ${row.entry.key}`}
          autoFocus
          value={editing.value}
          onChange={(event) => setEditing({ ...editing, value: event.target.value })}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitEdit();
            else if (event.key === "Escape") {
              event.stopPropagation();
              event.nativeEvent.stopImmediatePropagation();
              setEditing(null);
            }
          }}
        />
      );
    }
    return (
      <button
        type="button"
        className="block w-full truncate rounded px-1 text-left hover:bg-muted"
        title={`${row.text[column]}\nDouble-click to edit`}
        aria-label={`${column} of ${row.entry.key}: ${row.text[column] || "empty"}`}
        onDoubleClick={() => setEditing({ id: row.entry.id, column, value: column === "title" ? (typeof row.entry.csl.title === "string" ? row.entry.csl.title : "") : row.text[column] })}
      >
        {row.text[column] || <span className="text-muted-foreground">—</span>}
      </button>
    );
  }

  return (
    <ModalDialog
      open={open}
      title="Manage references"
      description={`${Object.keys(library.entries).length} references in ${notebook}`}
      panelClassName="max-w-6xl"
      sectioned
      onClose={() => { if (!childOpen && !editing) onClose(); }}
    >
      <div className="flex min-h-0 flex-col gap-2" onKeyDown={onKeyDown} role="group" aria-label="References table">
        <div className="flex flex-wrap items-center gap-2">
          <div className="libera-links-tabs flex-1" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}><Library aria-hidden className="h-3.5 w-3.5" /> All references <span className="libera-links-count">{rows.length}</span></button>
            <button type="button" role="tab" aria-selected={tab === "duplicates"} onClick={() => setTab("duplicates")}><Copy aria-hidden className="h-3.5 w-3.5" /> Duplicates <span className="libera-links-count">{duplicateGroups.length}</span></button>
          </div>
          <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-input px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!undo.canUndo || busy} title={undo.stale ? "The last change was changed again elsewhere and cannot be undone" : undo.label ? `Undo ${undo.label} (⌘/Ctrl+Z)` : "Nothing to undo"} onClick={() => void undo.run().catch((undoError: Error) => setError(undoError.message))}>
            <Undo2 aria-hidden className="h-3.5 w-3.5" /> Undo
          </button>
        </div>
        {error ? <div role="alert" className="whitespace-pre-line rounded-lg bg-destructive-muted p-2 text-xs text-destructive">{error}</div> : null}
        {notice ? <div role="status" className="rounded-lg bg-muted p-2 text-xs">{notice}</div> : null}

        {tab === "duplicates" ? (
          <div className="max-h-[60vh] overflow-auto">
            <DuplicateGroupsList groups={duplicateGroups} onMerge={setMergeGroup} />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Bulk actions" role="toolbar">
              <span className="text-muted-foreground">{selectedEntries.length} selected</span>
              <button type="button" className={toolbarButton} disabled={selectedEntries.length < 2 || busy} onClick={() => setMergeGroup(selectedEntries)}><Merge aria-hidden className="h-3.5 w-3.5" /> Merge selected</button>
              <button type="button" className={toolbarButton} disabled={!selectedEntries.length || busy || Boolean(bulk)} title="Look the selected references up again" onClick={() => void reresolveSelected(selectedEntries)}><RefreshCw aria-hidden className="h-3.5 w-3.5" /> Re-resolve</button>
              <button type="button" className={toolbarButton} disabled={!selectedEntries.length || busy} onClick={() => void run(selectedEntries.filter((entry) => entry.status !== "confirmed").map((entry) => ({ op: "update", id: entry.id, status: "confirmed" })), `Confirm ${selectedEntries.length} references`, `${selectedEntries.length} marked confirmed.`)}><CircleCheck aria-hidden className="h-3.5 w-3.5" /> Mark confirmed</button>
              <select className="h-7 px-2 text-xs" aria-label="Change type of selected" disabled={!selectedEntries.length || busy} value="" onChange={(event) => {
                const type = event.target.value as CslItemType;
                if (type) void run(selectedEntries.filter((entry) => entry.csl.type !== type).map((entry) => ({ op: "update", id: entry.id, csl: { type } })), `Change type of ${selectedEntries.length} references`, `Type changed to ${CSL_TYPE_LABELS[type]}.`);
              }}>
                <option value="">Change type…</option>
                {[...CSL_ITEM_TYPES].sort((a, b) => CSL_TYPE_LABELS[a].localeCompare(CSL_TYPE_LABELS[b])).map((type) => <option key={type} value={type}>{CSL_TYPE_LABELS[type]}</option>)}
              </select>
              <form className="flex items-center gap-1" onSubmit={(event) => {
                event.preventDefault();
                const add = tagDraft.split(",").map((tag) => tag.trim()).filter(Boolean);
                if (!add.length) return;
                setTagDraft("");
                void tagSelected(selectedEntries, add, []);
              }}>
                <input className="h-7 w-28 rounded-lg border border-input bg-transparent px-2 text-xs" aria-label="Tag for selected" placeholder="Tag" list="manage-references-tags" disabled={!selectedEntries.length || busy} value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} />
                <button type="submit" className={toolbarButton} disabled={!selectedEntries.length || busy || !tagDraft.trim()}><Tag aria-hidden className="h-3.5 w-3.5" /> Add tag</button>
                <datalist id="manage-references-tags">
                  {libraryTags(Object.values(library.entries)).map((item) => <option key={item.tag} value={item.tag} />)}
                </datalist>
              </form>
              <select className="h-7 px-2 text-xs" aria-label="Remove tag from selected" disabled={!selectedEntries.some((entry) => entry.tags?.length) || busy} value="" onChange={(event) => {
                const tag = event.target.value;
                if (tag) void tagSelected(selectedEntries, [], [tag]);
              }}>
                <option value="">Remove tag…</option>
                {libraryTags(selectedEntries).map((item) => <option key={item.tag} value={item.tag}>{item.tag} ({item.count})</option>)}
              </select>
              <select className="h-7 px-2 text-xs" aria-label="Export selected" disabled={!selectedEntries.length || busy} value="" onChange={(event) => {
                const format = event.target.value as ExportFormat;
                if (!format) return;
                setError("");
                void exportReferences({ notebook, format, ids: selectedEntries.map((entry) => entry.id) })
                  .then((fileName) => setNotice(`Exported ${fileName}.`))
                  .catch((exportError: Error) => setError(exportError.message));
              }}>
                <option value="">Export selection…</option>
                {EXPORT_FORMATS.map((format) => <option key={format.id} value={format.id}>{format.label}</option>)}
              </select>
              <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-input px-2.5 py-1 font-medium text-destructive hover:bg-destructive-muted disabled:opacity-50" disabled={!selectedEntries.length || busy} onClick={() => setDeleting(selectedEntries)}><Trash2 aria-hidden className="h-3.5 w-3.5" /> Delete</button>
            </div>
            {bulk ? (
              <div className="flex items-center gap-2 rounded-lg bg-muted p-2 text-xs" role="status" aria-label="Re-resolve progress">
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                <span className="min-w-0 flex-1 truncate">Re-resolving {bulk.done + 1} of {bulk.total}… <span className="font-mono">{bulk.key}</span></span>
                <button type="button" className="inline-flex items-center gap-1 rounded-lg border border-input px-2 py-0.5 font-medium hover:bg-card" onClick={() => bulkRef.current?.abort()}><X aria-hidden className="h-3 w-3" /> Cancel</button>
              </div>
            ) : null}
            <div
              ref={scrollRef}
              className="max-h-[60vh] min-h-48 overflow-auto rounded-lg border border-border"
              onScroll={(event) => {
                const target = event.currentTarget;
                setScroll({ top: target.scrollTop, height: target.clientHeight || 600 });
              }}
            >
              <table className="libera-reference-table w-full border-collapse text-xs" aria-label="References" aria-rowcount={visibleRows.length}>
                <thead className="sticky top-0 z-10 bg-card">
                  <tr>
                    <th className="w-8 px-2 py-1.5">
                      <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(visibleRows.map((row) => row.entry.id)))} />
                    </th>
                    {MANAGE_COLUMNS.map((column) => (
                      <th key={column.id} className={`${column.width} whitespace-nowrap px-1.5 py-1.5 text-left font-medium`} aria-sort={sort.column === column.id ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className="inline-flex items-center gap-1 hover:text-accent" onClick={() => setSort((current) => ({ column: column.id, direction: current.column === column.id && current.direction === "asc" ? "desc" : "asc" }))}>
                          {column.label}
                          {sort.column === column.id ? (sort.direction === "asc" ? <ArrowUp aria-hidden className="h-3 w-3" /> : <ArrowDown aria-hidden className="h-3 w-3" />) : null}
                        </button>
                      </th>
                    ))}
                  </tr>
                  <tr>
                    <th />
                    {MANAGE_COLUMNS.map((column) => (
                      <th key={column.id} className="px-1 pb-1.5">
                        <input className="h-6 w-full px-1.5 text-[11px] font-normal" aria-label={`Filter ${column.label}`} placeholder="Filter" value={filters[column.id] ?? ""} onChange={(event) => setFilters((current) => ({ ...current, [column.id]: event.target.value }))} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {windowed && first > 0 ? <tr aria-hidden style={{ height: first * TABLE_ROW_HEIGHT }} /> : null}
                  {visibleRows.slice(first, last).map((row) => (
                    <tr
                      key={row.entry.id}
                      data-entry-id={row.entry.id}
                      aria-selected={selected.has(row.entry.id)}
                      className="libera-reference-table-row border-t border-border"
                      style={{ height: TABLE_ROW_HEIGHT }}
                      onClick={(event: ReactMouseEvent) => {
                        const target = event.target as HTMLElement;
                        if (target.closest("input, button, select")) return;
                        toggleRow(row.entry.id, event);
                      }}
                    >
                      <td className="px-2">
                        <input type="checkbox" aria-label={`Select ${row.entry.key}`} checked={selected.has(row.entry.id)} onChange={() => undefined} onClick={(event) => { event.stopPropagation(); toggleRow(row.entry.id, event); }} />
                      </td>
                      <td className="truncate px-1.5 font-mono" title={row.entry.aliases.length ? `Aliases: ${row.entry.aliases.join(", ")}` : undefined}>{row.entry.key}</td>
                      <td className="max-w-40 truncate px-1.5" title={row.text.authors}>{authorsLabel(row.entry.csl) || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-1.5">{editableCell(row, "year")}</td>
                      <td className="max-w-80 px-1.5">{editableCell(row, "title")}</td>
                      <td className="max-w-44 px-1.5">{editableCell(row, "venue")}</td>
                      <td className="truncate px-1.5">{row.text.type}</td>
                      <td className="px-1.5"><span className="libera-reference-badge" data-status={row.entry.status}>{row.text.status}</span></td>
                      <td className="px-1.5 tabular-nums" title={citingOf(row.entry).join("\n") || undefined}>{row.cited}</td>
                      <td className="px-1.5">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          {row.entry.attachments.some((attachment) => attachment.kind === "pdf") ? <FileType2 aria-label="PDF" className="h-3.5 w-3.5 text-[#d08178]" /> : null}
                          {row.entry.attachments.some((attachment) => attachment.kind === "markdown") ? <FileText aria-label="Markdown" className="h-3.5 w-3.5" /> : null}
                          {row.entry.attachments.some((attachment) => attachment.kind === "url") ? <Globe aria-label="URL" className="h-3.5 w-3.5" /> : null}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-1.5 tabular-nums text-muted-foreground">{row.text.updated}</td>
                    </tr>
                  ))}
                  {windowed && last < visibleRows.length ? <tr aria-hidden style={{ height: (visibleRows.length - last) * TABLE_ROW_HEIGHT }} /> : null}
                </tbody>
              </table>
              {!visibleRows.length ? <p className="p-6 text-center text-sm text-muted-foreground">No references match.</p> : null}
            </div>
            <p className="text-[11px] text-muted-foreground">Shift-click to select a range. Double-click a title, year or venue to correct it.</p>
            <div className="flex justify-end">
              <button type="button" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => {
                setError("");
                void exportReferences({ notebook, format: "bibtex" }).then((fileName) => setNotice(`Exported ${fileName}.`)).catch((exportError: Error) => setError(exportError.message));
              }}>
                <Download aria-hidden className="h-3.5 w-3.5" /> Export all as BibTeX
              </button>
            </div>
          </>
        )}
      </div>
      <MergeReferencesDialog
        group={mergeGroup}
        onClose={() => setMergeGroup(null)}
        onMerge={(keepId, mergeIds) => {
          const keep = library.entries[keepId];
          const merged = mergeIds.map((id) => library.entries[id]).filter(Boolean);
          return apply([{ op: "merge", keepId, mergeIds }], `Merge into ${keep?.key ?? "reference"}`).then(() => {
            setSelected(new Set());
            setNotice(`Merged ${mergeIds.length + 1} references.`);
            if (keep) onMerged?.(keep, merged);
          });
        }}
      />
      <DeleteReferencesDialog
        entries={deleting}
        citing={citingOf}
        onClose={() => setDeleting(null)}
        onDelete={(ids) => apply(ids.map((id) => ({ op: "delete", id })), `Delete ${ids.length} reference${ids.length === 1 ? "" : "s"}`).then(() => {
          setSelected(new Set());
          setNotice(`Deleted ${ids.length} reference${ids.length === 1 ? "" : "s"}.`);
        })}
      />
    </ModalDialog>
  );
}
