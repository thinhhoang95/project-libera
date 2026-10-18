"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { entryAuthorsYear } from "@/components/libera/references/citation-popup";
import { resolveReference, sessionWebSearchChoice } from "@/components/libera/references/reference-candidates";
import { fileBaseName, fileTitle } from "@/components/libera/references/reference-display";
import { withPageLabels } from "@/components/libera/references/pdf-page-labels";
import { applyReferenceOps, fetchReferenceLibrary } from "@/components/libera/references/use-reference-library";
import { buildPdfQuoteMarkdown, entryForAttachment, notebookOfPath, parsePdfQuoteSource, PDF_CITATION_MIME, type PdfQuoteSource } from "@/lib/references/pdf-quote";
import {
  REFERENCES_UPDATED_EVENT,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
  type ReferencesUpdatedDetail,
} from "@/lib/references/types";

// Quote and cite from a PDF, on the client (docs/references/plan.md §5 Phase
// 5). `resolvePdfQuote` turns a quote into Markdown for a target note:
//
// 1. The entry is the one that has the PDF as an attachment in the PDF's
//    notebook library. Without one, `PdfQuoteCiteHost` offers to add the PDF
//    to References (a compact confirmation over /api/references/resolve), then
//    continues with the new entry.
// 2. A note in another notebook cites the entry through its own library:
//    POST /api/references/copy copies it there first (or finds the same work),
//    and the citation uses the destination key.
// 3. The locator is the printed page (pdf-quote.ts).

// ---------------------------------------------------------------------------
// The host: the add-PDF confirmation and short notices
// ---------------------------------------------------------------------------

type AddRequest = { id: number; notebook: string; path: string; resolve: (entry: ReferenceEntry | null) => void };
type HostState = { add: AddRequest | null; notice: { id: number; message: string } | null };

let hostState: HostState = { add: null, notice: null };
let hostsMounted = 0;
let nextId = 1;
const listeners = new Set<() => void>();

function setHostState(patch: Partial<HostState>) {
  hostState = { ...hostState, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Ask to add the PDF at `path` to `notebook`'s References. Resolves with the
 * entry that now has it attached, or null when the user cancels (or no host
 * is mounted to ask).
 */
export function requestPdfReference(notebook: string, path: string): Promise<ReferenceEntry | null> {
  if (!hostsMounted) return Promise.resolve(null);
  hostState.add?.resolve(null);
  return new Promise((resolve) => setHostState({ add: { id: nextId++, notebook, path, resolve } }));
}

/** A short status line at the bottom of the window (copied to the clipboard, could not cite…). */
export function showPdfQuoteNotice(message: string) {
  setHostState({ notice: { id: nextId++, message } });
}

/** Tests: forget pending requests and notices. */
export function resetPdfQuoteCite() {
  hostState.add?.resolve(null);
  hostState = { add: null, notice: null };
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// Resolving a quote
// ---------------------------------------------------------------------------

export type ResolvedPdfQuote = { markdown: string; key: string; entry: ReferenceEntry };

async function errorText(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}

/** POST /api/references/copy: the key `key` (from `from`'s library) has in `to`'s, after copying the entry there when needed. */
export async function copyReferenceKey(from: string, to: string, key: string) {
  const response = await fetch("/api/references/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, keys: [key] }),
  });
  if (!response.ok) throw new Error(await errorText(response, "The reference could not be copied to the note's notebook."));
  const result = await response.json() as { keys?: Record<string, string>; destinationRevision?: number | null };
  const destinationKey = result.keys?.[key];
  if (!destinationKey) throw new Error("The reference could not be copied to the note's notebook.");
  if (typeof result.destinationRevision === "number" && typeof window !== "undefined") {
    // Other views of that library (the References panel, chips) reload it.
    window.dispatchEvent(new CustomEvent<ReferencesUpdatedDetail>(REFERENCES_UPDATED_EVENT, { detail: { notebook: to, revision: result.destinationRevision } }));
  }
  return destinationKey;
}

/**
 * The quote-and-cite Markdown for `source`, cited from a note in
 * `targetNotebook` (null: the PDF's own notebook). Null when the PDF has no
 * entry and the user did not add one.
 */
export async function resolvePdfQuote(source: PdfQuoteSource, targetNotebook: string | null): Promise<ResolvedPdfQuote | null> {
  const notebook = notebookOfPath(source.path);
  const library = await fetchReferenceLibrary(notebook);
  const entry = entryForAttachment(library, source.path) ?? await requestPdfReference(notebook, source.path);
  if (!entry) return null;
  const key = targetNotebook && targetNotebook !== notebook ? await copyReferenceKey(notebook, targetNotebook, entry.key) : entry.key;
  return { markdown: buildPdfQuoteMarkdown(withPageLabels(source), key, entry), key, entry };
}

// ---------------------------------------------------------------------------
// Dropping a quote into an editor
// ---------------------------------------------------------------------------

/** Whether a drag carries a PDF quote; dragover can read the types, not the data. */
export function hasPdfQuoteDrag(dataTransfer: DataTransfer | null | undefined) {
  return Boolean(dataTransfer && Array.from(dataTransfer.types ?? []).includes(PDF_CITATION_MIME));
}

/** The PDF quote a drop carries, or null. Read it during the drop event: its data is gone afterwards. */
export function pdfQuoteFromDrop(dataTransfer: DataTransfer | null | undefined) {
  if (!hasPdfQuoteDrag(dataTransfer)) return null;
  return parsePdfQuoteSource(dataTransfer!.getData(PDF_CITATION_MIME));
}

/**
 * The quote-and-cite Markdown for a quote dropped into a note of `notebook`
 * (the editor's reference notebook). Null when the user cancelled adding the
 * PDF to References, or when it failed (a notice says why).
 */
export async function droppedQuoteMarkdown(source: PdfQuoteSource, notebook: string | null) {
  try {
    return (await resolvePdfQuote(source, notebook))?.markdown ?? null;
  } catch (error) {
    showPdfQuoteNotice(error instanceof Error ? error.message : "Could not quote the PDF.");
    return null;
  }
}

// ---------------------------------------------------------------------------
// The add-PDF confirmation
// ---------------------------------------------------------------------------

type AddPhase =
  | { kind: "resolving" }
  | { kind: "preview"; candidate: ReferenceEntryInput; existing: ReferenceEntry | null; warnings: string[] }
  | { kind: "adding" }
  | { kind: "error"; message: string; candidate: ReferenceEntryInput };

function withAttachment(candidate: ReferenceEntryInput, path: string): ReferenceEntryInput {
  const attachments = candidate.attachments ?? [];
  if (attachments.some((attachment) => attachment.kind === "pdf" && attachment.path === path)) return candidate;
  return { ...candidate, attachments: [...attachments, { kind: "pdf", path }] };
}

/** The entry to add when the PDF cannot be looked up: its file name as the title, to complete later. */
export function unresolvedPdfEntry(path: string): ReferenceEntryInput {
  return { csl: { type: "article-journal", title: fileTitle(path) }, status: "unresolved", attachments: [{ kind: "pdf", path }] };
}

function addedEntry(before: ReferenceLibrary, after: ReferenceLibrary, path: string) {
  return Object.values(after.entries).find((entry) => !before.entries[entry.id]) ?? entryForAttachment(after, path);
}

function AddPdfDialog({ request, onDone }: { request: AddRequest; onDone: (entry: ReferenceEntry | null) => void }) {
  const [phase, setPhase] = useState<AddPhase>({ kind: "resolving" });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void (async () => {
      try {
        const [result, library] = await Promise.all([
          resolveReference({ notebook: request.notebook, path: request.path, webSearch: sessionWebSearchChoice() ?? false }, abort.signal),
          fetchReferenceLibrary(request.notebook),
        ]);
        if (abort.signal.aborted) return;
        const candidate = result.candidates[0];
        if (!candidate) {
          setPhase({ kind: "preview", candidate: unresolvedPdfEntry(request.path), existing: null, warnings: result.warnings.length ? result.warnings : ["Nothing was found for this PDF. It can be added with its file name as the title and completed later."] });
          return;
        }
        const duplicate = result.duplicates.find((item) => item.candidateIndex === 0);
        setPhase({ kind: "preview", candidate, existing: duplicate ? library.entries[duplicate.entryId] ?? null : null, warnings: result.warnings });
      } catch (error) {
        if (abort.signal.aborted) return;
        setPhase({ kind: "error", message: error instanceof Error ? error.message : "The PDF could not be looked up.", candidate: unresolvedPdfEntry(request.path) });
      }
    })();
    return () => abort.abort();
  }, [request]);

  const cancel = useCallback(() => {
    controller.current?.abort();
    onDone(null);
  }, [onDone]);

  async function add(candidate: ReferenceEntryInput, existing: ReferenceEntry | null) {
    setPhase({ kind: "adding" });
    try {
      const before = await fetchReferenceLibrary(request.notebook);
      const ops: ReferenceLibraryOp[] = existing
        ? [{ op: "attach", id: existing.id, attachment: { kind: "pdf", path: request.path } }]
        : [{ op: "add", entry: withAttachment(candidate, request.path) }];
      const after = await applyReferenceOps(request.notebook, ops);
      const entry = existing ? after.entries[existing.id] ?? null : addedEntry(before, after, request.path);
      if (!entry) throw new Error("The reference was not added.");
      onDone(entry);
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "The reference could not be added.", candidate });
    }
  }

  const name = fileBaseName(request.path);
  const shown = phase.kind === "preview" ? phase.existing ?? phase.candidate : phase.kind === "error" ? phase.candidate : null;
  const primary = phase.kind === "preview"
    ? { label: phase.existing ? `Attach to @${phase.existing.key} and cite` : "Add and cite", run: () => void add(phase.candidate, phase.existing) }
    : phase.kind === "error"
      ? { label: "Add with file name", run: () => void add(phase.candidate, null) }
      : null;

  return (
    <ModalDialog
      open
      title="Add this PDF to References"
      description={`${name} is not in this notebook's References yet. Add it to cite the quote.`}
      onClose={cancel}
      footer={
        <>
          <button type="button" className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" onClick={cancel}>Cancel</button>
          {primary ? (
            <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90" onClick={primary.run}>{primary.label}</button>
          ) : null}
        </>
      }
    >
      <div className="space-y-2 text-sm" aria-label="PDF reference" data-pdf-reference-dialog="">
        {phase.kind === "resolving" || phase.kind === "adding" ? (
          <p role="status" className="flex items-center gap-2 text-muted-foreground">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> {phase.kind === "resolving" ? `Looking up ${name}…` : "Adding…"}
          </p>
        ) : null}
        {phase.kind === "error" ? <p role="alert" className="rounded-lg bg-destructive-muted p-2.5 text-xs text-destructive">{phase.message}</p> : null}
        {shown ? (
          <div className="libera-panel-card p-2.5">
            <div className="font-medium text-foreground">{entryAuthorsYear(shown)}</div>
            <div className="text-xs text-muted-foreground">{typeof shown.csl.title === "string" && shown.csl.title.trim() ? shown.csl.title : "Untitled"}</div>
            {phase.kind === "preview" && phase.existing ? <div className="mt-1 text-xs text-muted-foreground">Already in References as <span className="font-mono">@{phase.existing.key}</span>; the PDF will be attached to it.</div> : null}
          </div>
        ) : null}
        {phase.kind === "preview" && phase.warnings.length ? (
          <ul className="text-xs text-muted-foreground">{phase.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        ) : null}
      </div>
    </ModalDialog>
  );
}

const NOTICE_MS = 4_000;

/** Mounted once by the app: shows the add-PDF confirmation and quote-and-cite notices. */
export function PdfQuoteCiteHost() {
  const state = useSyncExternalStore(subscribe, () => hostState, () => hostState);
  useEffect(() => {
    hostsMounted += 1;
    return () => {
      hostsMounted -= 1;
    };
  }, []);
  const notice = state.notice;
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      if (hostState.notice?.id === notice.id) setHostState({ notice: null });
    }, NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const request = state.add;
  const done = useCallback((entry: ReferenceEntry | null) => {
    if (!request) return;
    request.resolve(entry);
    if (hostState.add?.id === request.id) setHostState({ add: null });
  }, [request]);

  return (
    <>
      {request ? <AddPdfDialog key={request.id} request={request} onDone={done} /> : null}
      {notice ? (
        <div role="status" data-pdf-quote-notice="" className="fixed bottom-4 left-1/2 z-50 max-w-md -translate-x-1/2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground shadow-lg">
          {notice.message}
        </div>
      ) : null}
    </>
  );
}
