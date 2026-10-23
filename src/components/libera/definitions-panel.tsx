"use client";

import { AlertTriangle, BookA, ChevronDown, Loader2, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { usePaletteCommands } from "@/components/libera/command-palette/commands";
import { showOutlineView } from "@/components/libera/outline-view";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import type { OpenTab } from "@/components/libera/types";
import { normalizeChatResponseMarkdown } from "@/lib/document-chat";
import { combinedMacroScope, macroScopeKey, type MarkdownMacroScope } from "@/lib/markdown-macros";
import type { MathMarkerSettings } from "@/lib/math-markers";
import {
  DEFINITION_KIND_LABELS,
  DEFINITION_KINDS,
  DEFINITIONS_FILE_TYPES,
  DEFINITIONS_REQUEST_EVENT,
  DEFINITIONS_RUN_FINISHED_EVENT,
  DEFINITIONS_UPDATED_EVENT,
  filterDefinitions,
  findQuoteRange,
  offsetOfLine,
  type DefinitionEntry,
  type DefinitionKind,
  type DefinitionsPayload,
  type DefinitionsRequestDetail,
  type DefinitionsRunFinishedDetail,
  type DefinitionsUpdatedDetail,
} from "@/lib/definitions";
import type { LiberaFileNode } from "@/lib/types";

type DefinitionsPanelProps = {
  activeTab?: OpenTab;
  mathMarkers?: MathMarkerSettings;
  onOpenFile: (file: LiberaFileNode, options?: { viewState?: OpenTab["viewState"] }) => Promise<void>;
};

/** Cards rendered at first; more on request, so a long glossary stays quick. */
const PAGE_SIZE = 60;

// Generation runs in the AI panel and outlives this tab (switching to another
// left panel unmounts it), so the runs in progress are kept here, by document.
const runningRequests = new Map<string, string>();
const runListeners = new Set<() => void>();
let runVersion = 0;
let lastRunError: { path: string; message: string } | null = null;
/** The documents whose last run has ended, so an empty result can be explained. */
const finishedRuns = new Set<string>();
/** Cards each document had when the tab last read them, for the palette's wording. */
const knownCardCounts = new Map<string, number>();

function notifyRuns() {
  runVersion++;
  for (const listener of runListeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener(DEFINITIONS_RUN_FINISHED_EVENT, (event) => {
    const { requestId, error } = (event as CustomEvent<DefinitionsRunFinishedDetail>).detail ?? {};
    for (const [path, id] of runningRequests) {
      if (id !== requestId) continue;
      runningRequests.delete(path);
      finishedRuns.add(path);
      lastRunError = error ? { path, message: error } : null;
      notifyRuns();
    }
  });
}

function useRunningRequest(path: string) {
  useSyncExternalStore((listener) => {
    runListeners.add(listener);
    return () => { runListeners.delete(listener); };
  }, () => runVersion, () => 0);
  return { running: runningRequests.has(path), finished: finishedRuns.has(path), error: lastRunError?.path === path ? lastRunError.message : "" };
}

/** Asks the AI Agent to (re)generate a document's cards; the AI panel starts the run. */
export function requestDefinitions(path: string) {
  const requestId = crypto.randomUUID();
  runningRequests.set(path, requestId);
  finishedRuns.delete(path);
  lastRunError = null;
  notifyRuns();
  window.dispatchEvent(new CustomEvent<DefinitionsRequestDetail>(DEFINITIONS_REQUEST_EVENT, { detail: { path, requestId } }));
}

export function supportsDefinitions(tab?: OpenTab | null) {
  return Boolean(tab && !tab.untitled && !tab.gallery && DEFINITIONS_FILE_TYPES.some((type) => type === tab.file.fileType));
}

/**
 * Definitions commands for the command palette; renders nothing. `onShow`
 * opens the Outlines panel, which is then switched to its Definitions view.
 */
export function DefinitionsPaletteCommands({ activeTab, onShow }: { activeTab?: OpenTab | null; onShow: () => void }) {
  usePaletteCommands(null, () => {
    const group = "Definitions";
    const show = () => {
      onShow();
      showOutlineView("definitions");
    };
    const supported = supportsDefinitions(activeTab);
    const path = supported && activeTab ? activeTab.file.path : "";
    const running = Boolean(path && runningRequests.has(path));
    const hasCards = Boolean(path && knownCardCounts.get(path));
    const unavailable = activeTab?.untitled
      ? "Save this document to a notebook first"
      : "Open a Markdown, LaTeX or PDF document";
    return [
      {
        id: "definitions:generate",
        title: running ? "Generating definitions…" : hasCards ? "Regenerate definitions" : "Generate definitions",
        group,
        icon: hasCards ? RefreshCw : Sparkles,
        detail: !supported ? unavailable : `The AI Agent reads ${activeTab?.file.name} and saves its definitions, notation and conventions as cards${hasCards ? ", replacing the current ones" : ""}`,
        keywords: "ai agent extract notation symbols glossary conventions create cards outline",
        disabled: !supported || running,
        run: () => {
          show();
          requestDefinitions(path);
        },
      },
      {
        id: "definitions:show",
        title: "Show definitions",
        group,
        icon: BookA,
        detail: supported ? undefined : unavailable,
        keywords: "notation symbols glossary cards outline search",
        run: show,
      },
    ];
  });
  return null;
}

export function DefinitionsPanel({ activeTab, mathMarkers, onOpenFile }: DefinitionsPanelProps) {
  if (!activeTab || !supportsDefinitions(activeTab)) {
    return (
      <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
        {activeTab?.untitled
          ? "Save this document to a notebook to collect its definitions."
          : "Open a Markdown, LaTeX or PDF document to see its definitions and notation."}
      </p>
    );
  }

  return <DocumentDefinitions key={activeTab.file.path} activeTab={activeTab} mathMarkers={mathMarkers} onOpenFile={onOpenFile} />;
}

function DocumentDefinitions({ activeTab, mathMarkers, onOpenFile }: DefinitionsPanelProps & { activeTab: OpenTab }) {
  const path = activeTab.file.path;
  const [payload, setPayload] = useState<DefinitionsPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<DefinitionKind | "all">("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { running, finished, error: runError } = useRunningRequest(path);

  // Bumped when a run saves cards for this document, to read them again.
  const [refreshKey, setRefreshKey] = useState(0);

  // Read on open, when cards arrive while the agent reads, and when the run ends.
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<DefinitionsPayload>(`/api/definitions?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then((next) => {
        knownCardCounts.set(path, next.definitions?.entries.length ?? 0);
        setPayload(next);
        setLoadError("");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(error instanceof Error ? error.message : "Could not load the definitions.");
      });
    return () => controller.abort();
  }, [path, refreshKey, running]);

  useEffect(() => {
    function handleUpdated(event: Event) {
      if ((event as CustomEvent<DefinitionsUpdatedDetail>).detail?.path === path) setRefreshKey((key) => key + 1);
    }
    window.addEventListener(DEFINITIONS_UPDATED_EVENT, handleUpdated);
    return () => window.removeEventListener(DEFINITIONS_UPDATED_EVENT, handleUpdated);
  }, [path]);

  // Cards may use the note's Markdown macros, which are expanded when shown.
  const draft = activeTab.file.fileType === "markdown" ? activeTab.draft : "";
  const latestMacroScope = useMemo(() => draft ? combinedMacroScope([draft]) : null, [draft]);
  const macroKey = macroScopeKey(latestMacroScope);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the definitions, not on each keystroke's scope object.
  const macroScope = useMemo(() => latestMacroScope ?? undefined, [macroKey]);

  const entries = useMemo(() => payload?.definitions?.entries ?? [], [payload]);
  const filtered = useMemo(() => filterDefinitions(entries, query, kind), [entries, query, kind]);
  const counts = useMemo(() => {
    const result: Record<DefinitionKind, number> = { definition: 0, notation: 0, convention: 0 };
    for (const entry of entries) result[entry.kind]++;
    return result;
  }, [entries]);

  async function deleteCards() {
    setDeleting(true);
    try {
      setPayload(await apiRequest<DefinitionsPayload>(`/api/definitions?path=${encodeURIComponent(path)}`, { method: "DELETE" }));
      knownCardCounts.set(path, 0);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not delete the definitions.");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  async function revealEntry(entry: DefinitionEntry) {
    const nonce = Date.now();
    if (activeTab.file.fileType === "pdf") {
      if (!entry.page) return;
      await onOpenFile(activeTab.file, { viewState: { pdf: { reveal: { page: entry.page, ...(entry.quote ? { text: entry.quote } : {}), nonce } } } });
      return;
    }
    const content = activeTab.draft;
    const range = entry.quote ? findQuoteRange(content, entry.quote) : null;
    const start = range?.start ?? (entry.line ? offsetOfLine(content, entry.line) : null);
    if (start === null) return;
    const end = range?.end ?? start;
    const line = content.slice(0, start).split("\n").length;
    if (activeTab.file.fileType === "latex") {
      await onOpenFile(activeTab.file, { viewState: { latex: { revealLine: { line, nonce } } } });
    } else {
      await onOpenFile(activeTab.file, { viewState: { markdown: { line, reveal: { start, end, nonce } } } });
    }
  }

  const hasCards = entries.length > 0;
  const generatedAt = payload?.definitions?.generatedAt;

  return (
    <section>
      {hasCards ? (
        <>
          <div className="relative mb-3">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label="Search definitions and notation"
              className="libera-sidebar-search-input h-10 w-full rounded-xl border border-input bg-card px-9 text-sm outline-none transition focus:border-ring"
              placeholder="Search definitions"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") setQuery("");
                else if (event.key === "Enter" && filtered[0]) {
                  event.preventDefault();
                  void revealEntry(filtered[0]);
                }
              }}
            />
            {query ? (
              <button
                aria-label="Clear definition search"
                className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                type="button"
                onClick={() => setQuery("")}
                onMouseDown={(event) => event.preventDefault()}
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <label className="mb-3 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
            <span>Show</span>
            <span className="relative">
              <select
                aria-label="Definition kind"
                className="libera-sidebar-search-input h-8 appearance-none rounded-lg border border-input bg-card pl-3 pr-8 text-xs text-foreground outline-none transition hover:bg-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
                value={kind}
                onChange={(event) => { setKind(event.target.value as DefinitionKind | "all"); setLimit(PAGE_SIZE); }}
              >
                <option value="all">All ({entries.length})</option>
                {DEFINITION_KINDS.map((option) => (
                  <option key={option} value={option} disabled={!counts[option]}>{DEFINITION_KIND_LABELS[option]} ({counts[option]})</option>
                ))}
              </select>
              <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            </span>
          </label>
        </>
      ) : null}

      <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <BookA aria-hidden className="h-3.5 w-3.5" />
        <span className="min-w-0 flex-1 truncate">Definitions</span>
        {hasCards && !running ? (
          confirmingDelete ? (
            <span className="flex items-center gap-1 normal-case tracking-normal">
              <button type="button" className="rounded px-1.5 py-0.5 font-medium text-destructive hover:bg-destructive-muted" disabled={deleting} onClick={() => void deleteCards()}>
                {deleting ? "Deleting…" : "Delete cards"}
              </button>
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => setConfirmingDelete(false)}>Cancel</button>
            </span>
          ) : (
            <>
              <button
                type="button"
                aria-label="Regenerate definitions"
                title="Regenerate with the AI Agent"
                className="libera-sidebar-icon-button inline-flex h-6 w-6 items-center justify-center rounded"
                onClick={() => requestDefinitions(path)}
              >
                <RefreshCw aria-hidden className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="Delete definitions"
                title="Delete the definitions file"
                className="libera-sidebar-icon-button inline-flex h-6 w-6 items-center justify-center rounded"
                onClick={() => setConfirmingDelete(true)}
              >
                <Trash2 aria-hidden className="h-3.5 w-3.5" />
              </button>
            </>
          )
        ) : null}
      </div>

      {running ? (
        <p role="status" className="mb-3 flex items-start gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          <span>The AI Agent is reading the document. Cards appear here as they are saved; follow along in the AI panel.</span>
        </p>
      ) : null}
      {runError ? (
        <p role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive-muted px-3 py-2.5 text-xs text-destructive">{runError}</p>
      ) : null}
      {loadError ? (
        <p role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive-muted px-3 py-2.5 text-xs text-destructive">{loadError}</p>
      ) : null}
      {payload?.stale && hasCards && !running ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-input px-3 py-2.5 text-xs text-muted-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            The document changed since these cards were generated.{" "}
            <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => requestDefinitions(path)}>Regenerate</button>
          </span>
        </div>
      ) : null}

      {!payload && !loadError ? (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">Loading definitions.</p>
      ) : !hasCards ? (
        running ? null : (
          <div className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
            {finished && !runError ? (
              <p className="mb-2 font-medium text-foreground">The AI Agent finished without saving any cards. Its reply in the AI panel says why.</p>
            ) : null}
            <p>Collect the definitions, notation and conventions of this document as searchable cards. The AI Agent reads the whole document; the cards are saved beside it, and you can delete or regenerate them at any time.</p>
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-input bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
              onClick={() => requestDefinitions(path)}
            >
              <Sparkles aria-hidden className="h-4 w-4" />
              Generate definitions
            </button>
          </div>
        )
      ) : filtered.length ? (
        <div className="space-y-2">
          {filtered.slice(0, limit).map((entry) => (
            <DefinitionCard
              key={entry.id}
              entry={entry}
              mathMarkers={mathMarkers}
              macroScope={macroScope}
              documentPath={path}
              canReveal={activeTab.file.fileType === "pdf" ? Boolean(entry.page) : Boolean(entry.quote || entry.line)}
              onReveal={() => void revealEntry(entry)}
            />
          ))}
          {filtered.length > limit ? (
            <button type="button" className="w-full rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setLimit((current) => current + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, filtered.length - limit)} more of {filtered.length - limit}
            </button>
          ) : null}
          {generatedAt ? (
            <p className="px-1 pt-1 text-[11px] text-muted-foreground">
              Generated {new Date(generatedAt).toLocaleString()}{payload?.definitions?.model ? ` with ${payload.definitions.model}` : ""}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">No matching definitions.</p>
      )}
    </section>
  );
}

const DefinitionCard = memo(function DefinitionCard({ entry, mathMarkers, macroScope, documentPath, canReveal, onReveal }: {
  entry: DefinitionEntry;
  mathMarkers?: MathMarkerSettings;
  macroScope?: MarkdownMacroScope;
  documentPath: string;
  canReveal: boolean;
  onReveal: () => void;
}) {
  const term = useMemo(() => normalizeChatResponseMarkdown(entry.term, false, mathMarkers), [entry.term, mathMarkers]);
  const meaning = useMemo(() => normalizeChatResponseMarkdown(entry.meaning, false, mathMarkers), [entry.meaning, mathMarkers]);
  const where = entry.location ?? (entry.page ? `p. ${entry.page}` : entry.line ? `line ${entry.line}` : "");

  return (
    <article className="rounded-lg border border-border bg-card px-3 py-2.5 text-sm">
      <header className="mb-1 flex items-start gap-2">
        <div className="min-w-0 flex-1 font-semibold text-foreground">
          <MarkdownRenderer
            content={term}
            documentPath={documentPath}
            mathMarkers={mathMarkers}
            macroScope={macroScope}
            renderImages={false}
            baseFontSize={14}
            baseLineHeight={1.4}
            className="min-w-0 break-words [&_p]:my-0"
          />
        </div>
        <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          {DEFINITION_KIND_LABELS[entry.kind]}
        </span>
      </header>
      <MarkdownRenderer
        content={meaning}
        documentPath={documentPath}
        mathMarkers={mathMarkers}
        macroScope={macroScope}
        renderImages={false}
        baseFontSize={13}
        baseLineHeight={1.5}
        className="min-w-0 break-words text-muted-foreground [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
      />
      {where || entry.aliases?.length ? (
        <footer className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          {where ? (
            canReveal ? (
              <button type="button" className="rounded font-medium text-foreground underline-offset-2 hover:underline" title="Show where it is introduced" onClick={onReveal}>
                {where}
              </button>
            ) : <span>{where}</span>
          ) : null}
          {entry.aliases?.length ? <span className="min-w-0 truncate" title={entry.aliases.join(", ")}>{entry.aliases.join(" · ")}</span> : null}
        </footer>
      ) : null}
    </article>
  );
});
