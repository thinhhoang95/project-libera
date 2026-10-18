"use client";

import { ArrowLeft, FileUp, Globe, Loader2, Merge, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandidateList,
  isAbortError,
  resolveReference,
  type ResolveResponse,
} from "@/components/libera/references/reference-candidates";
import {
  entryTitle,
  fileBaseName,
  fileTitle,
  INPUT_KIND_LABELS,
  titleMatchKey,
} from "@/components/libera/references/reference-display";
import { parseBibtex } from "@/lib/references/bibtex";
import { parseCslJson } from "@/lib/references/csl-json";
import { classifyReferenceInput, splitBibliography } from "@/lib/references/identifiers";
import { parseRis } from "@/lib/references/ris";
import {
  REFERENCES_UPDATED_EVENT,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceLibrary,
  type ReferenceLibraryOp,
  type ReferencesUpdatedDetail,
} from "@/lib/references/types";

// The Add box: one input for an identifier, BibTeX/RIS/CSL-JSON, a free-text
// reference or a whole pasted bibliography. BibTeX, RIS and CSL-JSON go to
// the import route; everything else is looked up through POST
// /api/references/resolve and confirmed on candidate cards
// (reference-candidates.tsx). A PDF or Markdown file dropped on the panel is
// resolved the same way by its path. Also the helpers the panel uses for
// files dropped on it.

export type ImportFormat = "bibtex" | "ris" | "csl-json";

export type ImportResult = {
  library: ReferenceLibrary;
  added: string[];
  errors: { line: number; message: string }[];
  duplicates: { entryId: string; existingId: string; reason: string }[];
  /** Keys that had to change (taken or invalid), when the server reports them. */
  renamedKeys?: { sourceKey: string; key: string }[];
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
  return {
    library: result.library,
    added: result.added ?? [],
    errors: result.errors ?? [],
    duplicates: result.duplicates ?? [],
    ...(Array.isArray(result.renamedKeys) ? { renamedKeys: result.renamedKeys } : {}),
  };
}

/**
 * Imported items whose key had to change (taken or invalid): source key →
 * library key, inferred by matching titles. Only used when the import route
 * does not report `renamedKeys`.
 */
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

type Rename = { from: string; to: string };

/** The keys an import renamed: the server's `renamedKeys`, else inferred from the source text. */
export function importRenames(result: ImportResult, format: ImportFormat | undefined, sourceText: string | undefined): Rename[] {
  if (result.renamedKeys) return result.renamedKeys.map(({ sourceKey, key }) => ({ from: sourceKey, to: key }));
  if (!format || !sourceText) return [];
  const added = result.added.map((id) => result.library.entries[id]).filter(Boolean);
  return renamedImportKeys(format, sourceText, added);
}

// ---------------------------------------------------------------------------
// Dropped files
// ---------------------------------------------------------------------------

export const TREE_FILE_MIME = "application/x-libera-file-path";

/** The entry a dropped PDF or Markdown file creates when it cannot be resolved: titled after the file, unresolved, with the file attached. */
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
  | { kind: "candidates"; result: ResolveResponse }
  | { kind: "imported"; result: ImportResult; renamed: Rename[]; existing: number };

const FORMAT_KINDS = new Set(["bibtex", "ris", "csl-json"]);

type BoxProps = {
  notebook: string;
  library: ReferenceLibrary | null;
  initialQuery?: string;
  /** A dropped PDF or Markdown file to resolve right away. */
  initialPath?: string;
  /** Let the model search the web for this session's lookups. */
  webSearch: boolean;
  /** Whether the user chose the web-search setting (the preference cannot be read in the panel, so it starts off). */
  webSearchChosen: boolean;
  onWebSearchChange: (webSearch: boolean) => void;
  apply: (ops: ReferenceLibraryOp[], label: string) => Promise<ReferenceLibrary>;
  record: (before: ReferenceLibrary, after: ReferenceLibrary, label: string, touched?: Iterable<string>) => void;
  onClose: () => void;
  onReveal: (entryId: string) => void;
  onEditNew: (initial: ReferenceEntryInput, extraOps?: ReferenceLibraryOp[]) => void;
  onMerge: (entryIds: string[]) => void;
  /** An online lookup is starting (for the privacy notice). */
  onLookup?: () => void;
  onNotice?: (notice: { tone: "info" | "error"; text: string }) => void;
};

export function AddReferenceBox({
  notebook,
  library,
  initialQuery = "",
  initialPath,
  webSearch,
  webSearchChosen,
  onWebSearchChange,
  apply,
  record,
  onClose,
  onReveal,
  onEditNew,
  onMerge,
  onLookup,
  onNotice,
}: BoxProps) {
  const [text, setText] = useState(initialQuery);
  const [view, setView] = useState<View>({ kind: "input" });
  const [busy, setBusy] = useState(false);
  const [lookup, setLookup] = useState<string | null>(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const detected = useMemo(() => text.trim() ? classifyReferenceInput(text) : null, [text]);
  const isFormat = Boolean(detected && FORMAT_KINDS.has(detected.kind));

  // A lookup in flight is cancelled when the box closes.
  useEffect(() => () => controllerRef.current?.abort(), []);

  function cancelLookup() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setLookup(null);
  }

  async function commit(ops: ReferenceLibraryOp[], label: string, revealId?: string) {
    setError("");
    setBusy(true);
    try {
      const before = new Set(Object.keys(library?.entries ?? {}));
      const after = await apply(ops, label);
      const added = Object.keys(after.entries).filter((id) => !before.has(id));
      setText("");
      setView({ kind: "input" });
      const target = revealId ?? (added.length === 1 ? added[0] : undefined);
      if (target) onReveal(target);
      onClose();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "The reference could not be added.");
    } finally {
      setBusy(false);
    }
  }

  /** A dropped file that could not be resolved still gets an entry: titled after the file, unresolved, with the file attached. */
  async function addUnresolvedFile(path: string, reason: string) {
    const entry = droppedFileEntry(path);
    if (!entry) {
      setError(reason);
      return;
    }
    await commit([{ op: "add", entry }], `Add ${fileBaseName(path)}`);
    onNotice?.({ tone: "error", text: `${fileBaseName(path)} could not be looked up (${reason.replace(/\.$/, "")}). It was added as an unresolved entry with the file attached.` });
  }

  async function resolve(request: { input: string } | { path: string }, label: string) {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setError("");
    setLookup(label);
    onLookup?.();
    try {
      const result = await resolveReference({ notebook, ...request, webSearch }, controller.signal);
      if (controller.signal.aborted) return;
      controllerRef.current = null;
      setLookup(null);
      if ("path" in request && !result.candidates.length && !result.updates.length) {
        await addUnresolvedFile(request.path, result.warnings[0] ?? "nothing was found");
        return;
      }
      setView({ kind: "candidates", result });
    } catch (lookupError) {
      if (controller.signal.aborted || isAbortError(lookupError)) return;
      controllerRef.current = null;
      setLookup(null);
      const message = lookupError instanceof Error ? lookupError.message : "The reference could not be looked up.";
      if ("path" in request) await addUnresolvedFile(request.path, message);
      else setError(message);
    }
  }

  // A dropped file is resolved as soon as the box opens.
  useEffect(() => {
    if (!initialPath) return;
    // Starting the request shows its progress line at once.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void resolve({ path: initialPath }, `Reading ${fileBaseName(initialPath)}…`);
    // resolve() sets the controller before it awaits; unmounting (or Strict Mode's rehearsal) aborts this lookup.
    const controller = controllerRef.current;
    return () => controller?.abort();
    // Once per dropped file; resolve reads the current props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  async function runImport(request: { format?: ImportFormat; text?: string; path?: string }, sourceText?: string) {
    const before = library;
    const result = await importReferences({ notebook, ...request });
    if (before) record(before, result.library, `Import ${result.added.length} reference${result.added.length === 1 ? "" : "s"}`, result.added);
    announceLibraryChange(notebook, result.library.revision);
    const renamed = importRenames(result, request.format, sourceText);
    setView({ kind: "imported", result, renamed, existing: result.duplicates.filter((duplicate) => !result.added.includes(duplicate.entryId)).length });
  }

  async function submit() {
    const input = text.trim();
    if (!input || !detected) return;
    setError("");
    if (!isFormat) {
      const label = detected.kind === "bibliography" ? `Looking up ${splitBibliography(input).length} references…` : "Looking up…";
      await resolve({ input }, label);
      return;
    }
    setBusy(true);
    try {
      await runImport({ format: detected.kind as ImportFormat, text: input }, input);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "That could not be added.");
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
            onChange={(event) => {
              // New input cancels a lookup in flight.
              if (controllerRef.current) cancelLookup();
              setText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey || !text.includes("\n")) && !event.shiftKey) {
                event.preventDefault();
                void submit();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                if (lookup) cancelLookup();
                else onClose();
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
            <button type="button" className="libera-panel-primary h-7 px-3 text-[12px]" disabled={!detected || busy || Boolean(lookup)} onClick={() => void submit()}>
              {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : detected && !isFormat ? <Search aria-hidden className="h-3.5 w-3.5" /> : null}
              {!detected ? "Add" : isFormat ? "Import" : detected.kind === "bibliography" ? "Look up all" : "Look up"}
            </button>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title="Let the AI search the web when the catalogues have no match">
            <input type="checkbox" checked={webSearch} onChange={(event) => onWebSearchChange(event.target.checked)} />
            <Globe aria-hidden className="h-3 w-3 shrink-0" />
            <span className="shrink-0">Search the web</span>
            {!webSearchChosen ? <span className="min-w-0 truncate" aria-label="Web search default">· off: your Preferences default can&apos;t be read here</span> : null}
          </label>
          {lookup ? (
            <div className="flex items-center gap-2 text-[11px]" role="status" aria-label="Lookup progress">
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{lookup}</span>
              <button type="button" className="libera-panel-button h-6 px-2 text-[11px]" onClick={cancelLookup}>Cancel</button>
            </div>
          ) : null}
          <input ref={fileInputRef} type="file" hidden accept=".bib,.ris,.json,.txt" aria-label="Reference file to import" onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }} />
        </>
      ) : view.kind === "candidates" ? (
        library ? (
          <CandidateList
            notebook={notebook}
            library={library}
            result={view.result}
            busy={busy}
            onCommit={commit}
            onEdit={(candidate, extraOps) => {
              onEditNew(candidate, extraOps);
              onClose();
            }}
            onReveal={onReveal}
          />
        ) : null
      ) : (
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
              <ul className="text-[11px] text-muted-foreground" aria-label="Renamed keys">
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
      )}
    </div>
  );
}
