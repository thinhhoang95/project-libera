"use client";

import { AlertCircle, ArrowLeft, Check, FileUp, Loader2, Merge, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  authorYearLabel,
  entryTitle,
  fileTitle,
  INPUT_KIND_LABELS,
  titleMatchKey,
} from "@/components/libera/references/reference-display";
import { parseBibtex } from "@/lib/references/bibtex";
import { parseCslJson } from "@/lib/references/csl-json";
import { classifyReferenceInput, splitBibliography, type ReferenceInputKind } from "@/lib/references/identifiers";
import { parseRis } from "@/lib/references/ris";
import {
  REFERENCES_UPDATED_EVENT,
  type CslItemType,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceIdentifiers,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
  type ReferencesUpdatedDetail,
} from "@/lib/references/types";

// The Add box: one input for an identifier, BibTeX/RIS/CSL-JSON, a free-text
// reference or a whole pasted bibliography. Identifiers go through
// `resolveReferenceInput` and a confirmation step; formats go to the import
// route; free text opens the edit form. Also the helpers the panel uses for
// files dropped on it.

export type ImportFormat = "bibtex" | "ris" | "csl-json";

export type ImportResult = {
  library: ReferenceLibrary;
  added: string[];
  errors: { line: number; message: string }[];
  duplicates: { entryId: string; existingId: string; reason: string }[];
};

export type ResolveResult = {
  candidates: ReferenceEntryInput[];
  duplicates: { candidateIndex: number; entryId: string }[];
};

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON.
  }
  return fallback;
}

/** Tell this window's store and other windows that the server changed the library. */
export function announceLibraryChange(notebook: string, revision: number) {
  window.dispatchEvent(new CustomEvent<ReferencesUpdatedDetail>(REFERENCES_UPDATED_EVENT, { detail: { notebook, revision } }));
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("libera-references");
  channel.postMessage({ notebook, revision });
  channel.close();
}

/** POST /api/references/import, with pasted text or a library file. */
export async function importReferences(request: { notebook: string; format?: ImportFormat | "auto"; text?: string; path?: string }): Promise<ImportResult> {
  const body = request.path !== undefined
    ? { notebook: request.notebook, path: request.path }
    : { notebook: request.notebook, format: request.format ?? "auto", text: request.text ?? "" };
  const response = await fetch("/api/references/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "The references could not be imported."));
  const result = await response.json() as Partial<ImportResult> & { library: ReferenceLibrary };
  return { library: result.library, added: result.added ?? [], errors: result.errors ?? [], duplicates: result.duplicates ?? [] };
}

const IDENTIFIER_KINDS = new Set<ReferenceInputKind>(["doi", "arxiv", "isbn", "pmid", "pmcid", "url"]);

/** The CSL type and fields a bare identifier implies, before any lookup. */
export function identifierStub(kind: ReferenceInputKind, value: string): ReferenceEntryInput | null {
  const now = new Date().toISOString();
  const user = { source: "user" as const, confidence: 1, retrievedAt: now };
  const make = (type: CslItemType, field: string, fieldValue: string, identifiers: ReferenceIdentifiers): ReferenceEntryInput => ({
    csl: { type, [field]: fieldValue },
    identifiers,
    provenance: { [field]: user },
    status: "unresolved",
  });
  switch (kind) {
    case "doi": return make("article-journal", "DOI", value, { doi: value });
    case "arxiv": return make("article", "URL", `https://arxiv.org/abs/${value}`, { arxiv: value });
    case "isbn": return make("book", "ISBN", value, { isbn: [value] });
    case "pmid": return make("article-journal", "PMID", value, { pmid: value });
    case "pmcid": return make("article-journal", "PMCID", value, { pmcid: value });
    case "url": return make("webpage", "URL", value, {});
    default: return null;
  }
}

function sameIdentifier(entry: ReferenceEntry, candidate: ReferenceEntryInput) {
  const a = entry.identifiers;
  const b = candidate.identifiers ?? {};
  if (a.doi && a.doi === b.doi) return true;
  if (a.arxiv && a.arxiv === b.arxiv) return true;
  if (a.pmid && a.pmid === b.pmid) return true;
  if (a.pmcid && a.pmcid === b.pmcid) return true;
  if (a.isbn?.some((isbn) => b.isbn?.includes(isbn))) return true;
  const url = candidate.csl.URL;
  return typeof url === "string" && typeof entry.csl.URL === "string" && url === entry.csl.URL;
}

/**
 * Candidates for a pasted identifier, and which ones the library already has.
 * Today a candidate is the identifier alone, added as unresolved; the
 * resolution lane replaces this function with POST /api/references/resolve,
 * which returns the same shape.
 */
export async function resolveReferenceInput(input: string, context: { notebook: string; library: ReferenceLibrary | null }): Promise<ResolveResult> {
  const { kind, value } = classifyReferenceInput(input);
  const stub = value ? identifierStub(kind, value) : null;
  if (!stub) return { candidates: [], duplicates: [] };
  const duplicates = Object.values(context.library?.entries ?? {})
    .filter((entry) => sameIdentifier(entry, stub))
    .map((entry) => ({ candidateIndex: 0, entryId: entry.id }));
  return { candidates: [stub], duplicates };
}

/** Imported items whose key had to change (taken or invalid): source key → library key. */
export function renamedImportKeys(format: ImportFormat, text: string, added: ReferenceEntry[]) {
  let parsed: { input: ReferenceEntryInput; sourceKey: string }[] = [];
  try {
    parsed = (format === "bibtex" ? parseBibtex(text) : format === "ris" ? parseRis(text) : parseCslJson(text)).entries;
  } catch {
    return [];
  }
  const sourceByTitle = new Map<string, string>();
  for (const item of parsed) if (item.sourceKey) sourceByTitle.set(titleMatchKey(item.input.csl), item.sourceKey);
  const renamed: { from: string; to: string }[] = [];
  for (const entry of added) {
    const source = sourceByTitle.get(titleMatchKey(entry.csl));
    if (source && source !== entry.key) renamed.push({ from: source, to: entry.key });
  }
  return renamed;
}

// ---------------------------------------------------------------------------
// Dropped files
// ---------------------------------------------------------------------------

export const TREE_FILE_MIME = "application/x-libera-file-path";

/** The entry a dropped PDF or Markdown file creates: titled after the file, unresolved, with the file attached. */
export function droppedFileEntry(path: string): ReferenceEntryInput | null {
  const lower = path.toLowerCase();
  const kind = lower.endsWith(".pdf") ? "pdf" : lower.endsWith(".md") || lower.endsWith(".markdown") ? "markdown" : null;
  if (!kind) return null;
  return {
    csl: { type: kind === "pdf" ? "document" : "manuscript", title: fileTitle(path) },
    status: "unresolved",
    attachments: [{ kind, path }],
  };
}

/** The entry a file is already attached to. */
export function entryWithAttachment(library: ReferenceLibrary | null, path: string) {
  return Object.values(library?.entries ?? {}).find((entry) => entry.attachments.some((attachment) => attachment.kind !== "url" && attachment.path === path));
}

/** Reference files the import route reads from the library. */
export function isImportablePath(path: string) {
  return /\.(bib|ris|json)$/i.test(path);
}

// ---------------------------------------------------------------------------
// The box
// ---------------------------------------------------------------------------

type View =
  | { kind: "input" }
  | { kind: "candidates"; result: ResolveResult }
  | { kind: "imported"; result: ImportResult; renamed: { from: string; to: string }[]; existing: number }
  | { kind: "bibliography"; items: string[]; selected: boolean[] };

type BoxProps = {
  notebook: string;
  library: ReferenceLibrary | null;
  initialQuery?: string;
  apply: (ops: ReferenceLibraryOp[], label: string) => Promise<ReferenceLibrary>;
  record: (before: ReferenceLibrary, after: ReferenceLibrary, label: string, touched?: Iterable<string>) => void;
  onClose: () => void;
  onReveal: (entryId: string) => void;
  onEditNew: (initial: ReferenceEntryInput) => void;
  onMerge: (entryIds: string[]) => void;
};

export function AddReferenceBox({ notebook, library, initialQuery = "", apply, record, onClose, onReveal, onEditNew, onMerge }: BoxProps) {
  const [text, setText] = useState(initialQuery);
  const [view, setView] = useState<View>({ kind: "input" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const detected = useMemo(() => text.trim() ? classifyReferenceInput(text) : null, [text]);

  async function runImport(request: { format?: ImportFormat; text?: string; path?: string }, sourceText?: string) {
    const before = library;
    const result = await importReferences({ notebook, ...request });
    if (before) record(before, result.library, `Import ${result.added.length} reference${result.added.length === 1 ? "" : "s"}`, result.added);
    announceLibraryChange(notebook, result.library.revision);
    const added = result.added.map((id) => result.library.entries[id]).filter(Boolean);
    const renamed = request.format && sourceText ? renamedImportKeys(request.format, sourceText, added) : [];
    setView({ kind: "imported", result, renamed, existing: result.duplicates.filter((duplicate) => !result.added.includes(duplicate.entryId)).length });
  }

  async function submit() {
    const input = text.trim();
    if (!input || !detected) return;
    setError("");
    setBusy(true);
    try {
      if (detected.kind === "bibtex" || detected.kind === "ris" || detected.kind === "csl-json") {
        await runImport({ format: detected.kind, text: input }, input);
      } else if (IDENTIFIER_KINDS.has(detected.kind)) {
        setView({ kind: "candidates", result: await resolveReferenceInput(input, { notebook, library }) });
      } else if (detected.kind === "bibliography") {
        const items = splitBibliography(input);
        setView({ kind: "bibliography", items, selected: items.map(() => true) });
      } else {
        onEditNew({ csl: { type: "article-journal", note: input }, status: "needs-review" });
        onClose();
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "That could not be added.");
    } finally {
      setBusy(false);
    }
  }

  async function addEntries(entries: ReferenceEntryInput[], label: string) {
    setError("");
    setBusy(true);
    try {
      const before = new Set(Object.keys(library?.entries ?? {}));
      const after = await apply(entries.map((entry) => ({ op: "add", entry })), label);
      const added = Object.keys(after.entries).filter((id) => !before.has(id));
      setText("");
      setView({ kind: "input" });
      if (added.length === 1) onReveal(added[0]);
      onClose();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "The reference could not be added.");
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setError("");
    setBusy(true);
    try {
      const content = await file.text();
      const kind = classifyReferenceInput(content).kind;
      const format: ImportFormat | undefined = kind === "bibtex" || kind === "ris" || kind === "csl-json" ? kind : undefined;
      if (!format) throw new Error(`${file.name} is not BibTeX, RIS or CSL-JSON.`);
      await runImport({ format, text: content }, content);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "The file could not be imported.");
    } finally {
      setBusy(false);
    }
  }

  const entries = library?.entries ?? {};

  return (
    <div className="libera-panel-card mx-3 mb-2 space-y-2 p-2.5" role="group" aria-label="Add references">
      <div className="flex items-center gap-1">
        {view.kind !== "input" ? (
          <button type="button" className="libera-sidebar-icon-button inline-flex h-6 w-6 items-center justify-center rounded-md" aria-label="Back to the input" onClick={() => setView({ kind: "input" })}>
            <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <h3 className="flex-1 text-[12px] font-semibold">Add references</h3>
        <button type="button" className="libera-sidebar-icon-button inline-flex h-6 w-6 items-center justify-center rounded-md" aria-label="Close add box" onClick={onClose}>
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>

      {error ? <div role="alert" className="rounded-lg bg-destructive-muted p-2 text-[11px] text-destructive">{error}</div> : null}

      {view.kind === "input" ? (
        <>
          <textarea
            className="libera-panel-field block max-h-48 min-h-16 w-full resize-y px-2.5 py-2 font-mono text-[11px] leading-relaxed"
            aria-label="Reference to add"
            placeholder="DOI, arXiv ID, ISBN, PubMed ID, URL, BibTeX, RIS, CSL-JSON, a reference or a whole bibliography"
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !text.includes("\n")) && !event.shiftKey) {
                event.preventDefault();
                void submit();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                onClose();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" aria-live="polite">
              {detected ? <>Detected: <span className="font-medium text-foreground">{INPUT_KIND_LABELS[detected.kind]}</span>{detected.value ? <span className="font-mono"> {detected.value}</span> : null}</> : "Paste or type, or drop a PDF here"}
            </span>
            <button type="button" className="libera-panel-button h-7 px-2" title="Import a BibTeX, RIS or CSL-JSON file" onClick={() => fileInputRef.current?.click()}>
              <FileUp aria-hidden className="h-3.5 w-3.5" /> File
            </button>
            <button type="button" className="libera-panel-primary h-7 px-3 text-[12px]" disabled={!detected || busy} onClick={() => void submit()}>
              {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : detected && IDENTIFIER_KINDS.has(detected.kind) ? <Search aria-hidden className="h-3.5 w-3.5" /> : null}
              {!detected ? "Add" : detected.kind === "bibtex" || detected.kind === "ris" || detected.kind === "csl-json" ? "Import" : IDENTIFIER_KINDS.has(detected.kind) ? "Look up" : detected.kind === "bibliography" ? "Split" : "Fill in…"}
            </button>
          </div>
          <input ref={fileInputRef} type="file" hidden accept=".bib,.ris,.json,.txt" aria-label="Reference file to import" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }} />
        </>
      ) : view.kind === "candidates" ? (
        view.result.candidates.length ? (
          <div className="space-y-2" aria-label="Candidates">
            {view.result.candidates.map((candidate, index) => {
              const duplicates = view.result.duplicates.filter((duplicate) => duplicate.candidateIndex === index).map((duplicate) => entries[duplicate.entryId]).filter(Boolean);
              return (
                <div key={index} className="space-y-1.5 rounded-lg border border-input p-2 text-[12px]">
                  <p className="font-medium">{candidate.csl.title ? entryTitle({ csl: candidate.csl }) : "Not looked up yet"}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {candidate.csl.title ? authorYearLabel(candidate.csl) : <>Added as <span className="font-medium">unresolved</span> with {INPUT_KIND_LABELS[detected?.kind ?? "doi"]} <span className="font-mono">{detected?.value}</span>. Fill in the details or let a lookup complete it later.</>}
                  </p>
                  {duplicates.map((duplicate) => (
                    <p key={duplicate.id} className="flex items-center gap-1 text-[11px] text-destructive">
                      <AlertCircle aria-hidden className="h-3 w-3" /> Already in the library as <button type="button" className="font-mono underline" onClick={() => onReveal(duplicate.id)}>{duplicate.key}</button>
                    </p>
                  ))}
                  <div className="flex justify-end">
                    <button type="button" className="libera-panel-primary h-7 px-3 text-[12px]" disabled={busy} onClick={() => void addEntries([candidate], "Add reference")}>
                      <Check aria-hidden className="h-3.5 w-3.5" /> {duplicates.length ? "Add anyway" : "Add"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : <p className="text-[12px] text-muted-foreground">Nothing was found for this input.</p>
      ) : view.kind === "imported" ? (
        <div className="space-y-1.5 text-[12px]" aria-label="Import result">
          <p><span className="font-semibold">{view.result.added.length}</span> added{view.existing ? <>, <span className="font-semibold">{view.existing}</span> already in the library</> : null}.</p>
          {view.result.added.length ? (
            <ul className="max-h-28 space-y-0.5 overflow-auto">
              {view.result.added.map((id) => view.result.library.entries[id]).filter(Boolean).map((entry) => (
                <li key={entry.id}><button type="button" className="font-mono text-[11px] text-accent hover:underline" onClick={() => onReveal(entry.id)}>{entry.key}</button> <span className="text-[11px] text-muted-foreground">{entryTitle(entry)}</span></li>
              ))}
            </ul>
          ) : null}
          {view.renamed.length ? (
            <div>
              <p className="text-[11px] font-medium">Keys changed because they were taken or invalid:</p>
              <ul className="text-[11px] text-muted-foreground">
                {view.renamed.map((rename) => <li key={rename.from}><span className="font-mono">{rename.from}</span> → <span className="font-mono">{rename.to}</span></li>)}
              </ul>
            </div>
          ) : null}
          {view.result.duplicates.length ? (
            <div>
              <p className="text-[11px] font-medium">Possible duplicates:</p>
              <ul className="space-y-1">
                {view.result.duplicates.map((duplicate) => {
                  const added = view.result.library.entries[duplicate.entryId];
                  const existing = view.result.library.entries[duplicate.existingId];
                  const fuzzy = duplicate.reason === "fuzzy" && added && existing && view.result.added.includes(duplicate.entryId);
                  return (
                    <li key={`${duplicate.entryId}:${duplicate.existingId}`} className="flex items-center gap-1.5 text-[11px]">
                      <span className="min-w-0 flex-1 truncate">
                        {fuzzy ? <><span className="font-mono">{added.key}</span> looks like <span className="font-mono">{existing.key}</span></> : <>Skipped: same {duplicate.reason.toUpperCase()} as <span className="font-mono">{existing?.key ?? "an entry"}</span></>}
                      </span>
                      {fuzzy ? (
                        <button type="button" className="libera-panel-button h-6 px-2 text-[11px]" onClick={() => onMerge([existing.id, added.id])}>
                          <Merge aria-hidden className="h-3 w-3" /> Merge
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {view.result.errors.length ? (
            <div role="alert">
              <p className="text-[11px] font-medium text-destructive">{view.result.errors.length} problem{view.result.errors.length === 1 ? "" : "s"}:</p>
              <ul className="max-h-24 overflow-auto text-[11px] text-destructive">
                {view.result.errors.map((problem, index) => <li key={index}>Line {problem.line}: {problem.message}</li>)}
              </ul>
            </div>
          ) : null}
          <div className="flex justify-end">
            <button type="button" className="libera-panel-button h-7 px-3" onClick={() => { setText(""); setView({ kind: "input" }); onClose(); }}>Done</button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5" aria-label="Bibliography items">
          <p className="text-[11px] text-muted-foreground">Each item becomes an unresolved entry with its text in the note. Untick the ones you do not want.</p>
          <ul className="max-h-56 space-y-1 overflow-auto">
            {view.items.map((item, index) => (
              <li key={index}>
                <label className="flex items-start gap-2 text-[11px] leading-snug">
                  <input type="checkbox" className="mt-0.5" checked={view.selected[index]} aria-label={`Include item ${index + 1}`} onChange={(event) => setView({ ...view, selected: view.selected.map((value, position) => position === index ? event.target.checked : value) })} />
                  <span>{item}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button
              type="button"
              className="libera-panel-primary h-7 px-3 text-[12px]"
              disabled={busy || !view.selected.some(Boolean)}
              onClick={() => {
                const chosen = view.items.filter((_, index) => view.selected[index]);
                void addEntries(chosen.map((item) => ({ csl: { type: "document", note: item }, status: "unresolved" })), `Add ${chosen.length} references`);
              }}
            >
              Add {view.selected.filter(Boolean).length} reference{view.selected.filter(Boolean).length === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
