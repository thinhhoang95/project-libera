"use client";

import { AlertTriangle, Bookmark, ChevronDown, ChevronRight, Highlighter, ListTree, Loader2, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { apiRequest } from "@/components/libera/api-client";
import { usePaletteCommands } from "@/components/libera/command-palette/commands";
import { SidebarNameTooltipButton } from "@/components/libera/sidebar-name-tooltip";
import type { OpenTab } from "@/components/libera/types";
import {
  PDF_OUTLINE_REQUEST_EVENT,
  PDF_OUTLINE_RUN_FINISHED_EVENT,
  PDF_OUTLINE_UPDATED_EVENT,
  currentOutlineEntryId,
  outlineErrors,
  visibleOutlineRows,
  type PdfOutlineEntry,
  type PdfOutlinePayload,
  type PdfOutlineRequestDetail,
  type PdfOutlineRunFinishedDetail,
  type PdfOutlineUpdatedDetail,
} from "@/lib/pdf-outline";
import type { LiberaFileNode } from "@/lib/types";

type OpenFile = (file: LiberaFileNode, options?: { viewState?: OpenTab["viewState"] }) => Promise<void>;

// Generation runs in the AI panel and outlives this view (switching to another
// left panel unmounts it), so the runs in progress are kept here, by PDF, as
// the Definitions tab keeps its own.
const runningRequests = new Map<string, string>();
const runListeners = new Set<() => void>();
let runVersion = 0;
let lastRunError: { path: string; message: string } | null = null;
const finishedRuns = new Set<string>();
/** What each PDF had when the view last read it, for the palette's wording. */
const knownOutlines = new Map<string, { embedded: number; generated: number }>();

function notifyRuns() {
  runVersion++;
  for (const listener of runListeners) listener();
}

let listeningForRuns = false;

/** Listens for the end of runs once, from the first view or request on. */
function listenForRuns() {
  if (listeningForRuns || typeof window === "undefined") return;
  listeningForRuns = true;
  window.addEventListener(PDF_OUTLINE_RUN_FINISHED_EVENT, (event) => {
    const { requestId, error } = (event as CustomEvent<PdfOutlineRunFinishedDetail>).detail ?? {};
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
  listenForRuns();
  useSyncExternalStore((listener) => {
    runListeners.add(listener);
    return () => { runListeners.delete(listener); };
  }, () => runVersion, () => 0);
  return { running: runningRequests.has(path), finished: finishedRuns.has(path), error: lastRunError?.path === path ? lastRunError.message : "" };
}

/** Asks the AI Agent to generate a PDF's outline; the AI panel starts the run. */
export function requestPdfOutline(path: string) {
  listenForRuns();
  const requestId = crypto.randomUUID();
  runningRequests.set(path, requestId);
  finishedRuns.delete(path);
  lastRunError = null;
  notifyRuns();
  window.dispatchEvent(new CustomEvent<PdfOutlineRequestDetail>(PDF_OUTLINE_REQUEST_EVENT, { detail: { path, requestId } }));
}

function isPdfTab(tab?: OpenTab | null): tab is OpenTab {
  return Boolean(tab && !tab.untitled && !tab.gallery && !tab.page && tab.file.fileType === "pdf");
}

/**
 * PDF commands for the command palette; renders nothing. `onShowOutlines`
 * opens the Outlines panel, `onShowAnnotations` the PDF's Annotations tab.
 */
export function PdfOutlinePaletteCommands({ activeTab, onShowOutlines, onShowAnnotations }: { activeTab?: OpenTab | null; onShowOutlines: () => void; onShowAnnotations: () => void }) {
  const t = useTranslations("pdfOutlinePanel");
  usePaletteCommands(null, () => {
    const group = t("paletteGroup");
    const pdf = isPdfTab(activeTab);
    const path = pdf ? activeTab.file.path : "";
    const running = Boolean(path && runningRequests.has(path));
    const known = path ? knownOutlines.get(path) : undefined;
    const unavailable = t("openPdf");
    return [
      {
        id: "pdf:generate-outline",
        title: running ? t("generatingPdfOutline") : known?.generated ? t("regeneratePdfOutline") : t("generatePdfOutline"),
        group,
        icon: known?.generated ? RefreshCw : Sparkles,
        detail: !pdf ? unavailable : known?.embedded ? t("hasBookmarks", { name: activeTab?.file.name ?? "" }) : t("agentReadsOutline", { name: activeTab?.file.name ?? "" }),
        keywords: "ai agent table of contents toc headings chapters sections bookmarks structure",
        disabled: !pdf || running || Boolean(known?.embedded),
        run: () => {
          onShowOutlines();
          requestPdfOutline(path);
        },
      },
      {
        id: "pdf:show-annotations",
        title: t("showAnnotations"),
        group,
        icon: Highlighter,
        detail: pdf ? undefined : unavailable,
        keywords: "highlights notes drawings shapes markup search",
        disabled: !pdf,
        run: onShowAnnotations,
      },
    ];
  });
  return null;
}

/**
 * A PDF's outline in the Outlines tab: its own bookmarks when it has them,
 * otherwise the outline the AI Agent generated (or the offer to generate one).
 */
export function PdfDocumentOutline({ activeTab, expansionLevel, onExpansionLevelChange, onOpenFile }: {
  activeTab: OpenTab;
  expansionLevel: number;
  onExpansionLevelChange: (level: number) => void;
  onOpenFile: OpenFile;
}) {
  const t = useTranslations("pdfOutlinePanel");
  const format = useFormatter();
  const path = activeTab.file.path;
  const [payload, setPayload] = useState<PdfOutlinePayload | null>(null);
  const [loadError, setLoadError] = useState("");
  /** What failed when the server gave no message of its own. */
  const [loadFailure, setLoadFailure] = useState<"" | "load" | "delete">("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [preferGenerated, setPreferGenerated] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const { running, finished, error: runError } = useRunningRequest(path);

  // Read on open, when the agent saves, and when its run ends.
  useEffect(() => {
    const controller = new AbortController();
    apiRequest<PdfOutlinePayload>(`/api/pdf-outline?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then((next) => {
        knownOutlines.set(path, { embedded: next.embedded.length, generated: next.generated?.entries.length ?? 0 });
        setPayload(next);
        setLoadError("");
        setLoadFailure("");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(error instanceof Error ? error.message : "");
        setLoadFailure(error instanceof Error ? "" : "load");
      });
    return () => controller.abort();
  }, [path, refreshKey, running]);

  useEffect(() => {
    function handleUpdated(event: Event) {
      if ((event as CustomEvent<PdfOutlineUpdatedDetail>).detail?.path === path) setRefreshKey((key) => key + 1);
    }
    window.addEventListener(PDF_OUTLINE_UPDATED_EVENT, handleUpdated);
    return () => window.removeEventListener(PDF_OUTLINE_UPDATED_EVENT, handleUpdated);
  }, [path]);

  const embedded = useMemo(() => payload?.embedded ?? [], [payload]);
  const generated = payload?.generated ?? null;
  const showingGenerated = Boolean(generated) && (!embedded.length || preferGenerated);
  const entries = useMemo(() => (showingGenerated ? generated?.entries : embedded) ?? [], [showingGenerated, generated, embedded]);
  const rows = useMemo(() => visibleOutlineRows(entries, { query, expansionLevel, expanded }), [entries, query, expansionLevel, expanded]);
  const currentEntryId = useMemo(() => currentOutlineEntryId(entries, activeTab.viewState?.pdf?.page), [entries, activeTab.viewState?.pdf?.page]);
  const problems = showingGenerated ? generated?.problems ?? [] : [];
  const errors = outlineErrors(problems);

  async function deleteOutline() {
    setDeleting(true);
    try {
      const next = await apiRequest<PdfOutlinePayload>(`/api/pdf-outline?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      knownOutlines.set(path, { embedded: next.embedded.length, generated: 0 });
      setPayload(next);
      setLoadError("");
      setLoadFailure("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "");
      setLoadFailure(error instanceof Error ? "" : "delete");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  async function navigate(entry: PdfOutlineEntry) {
    if (!entry.page) return;
    await onOpenFile(activeTab.file, { viewState: { pdf: { reveal: { page: entry.page, ...(entry.top !== undefined ? { top: entry.top } : {}), nonce: Date.now() } } } });
  }

  const shownError = loadError || (loadFailure === "load" ? t("loadOutlineFailed") : loadFailure === "delete" ? t("deleteOutlineFailed") : "");
  const SourceIcon = showingGenerated ? Sparkles : Bookmark;

  return (
    <section>
      {entries.length ? (
        <>
          <div className="relative mb-3">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label={t("searchOutlineLabel")}
              className="libera-panel-field libera-panel-field--search w-full"
              placeholder={t("searchOutline")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") setQuery("");
                else if (event.key === "Enter" && rows[0]) {
                  event.preventDefault();
                  void navigate(rows[0].entry);
                }
              }}
            />
            {query ? (
              <button
                aria-label={t("clearOutlineSearch")}
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
            <span>{t("expandTo")}</span>
            <span className="relative">
              <select
                aria-label={t("expansionLevel")}
                className="libera-panel-field libera-panel-field--compact pl-3 pr-8"
                value={expansionLevel}
                onChange={(event) => {
                  onExpansionLevelChange(Number(event.target.value));
                  setExpanded({});
                }}
              >
                {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>{t("level", { level })}</option>)}
              </select>
            </span>
          </label>
        </>
      ) : null}

      <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {entries.length ? <SourceIcon aria-hidden className="h-3.5 w-3.5" /> : <ListTree aria-hidden className="h-3.5 w-3.5" />}
        <span className="min-w-0 flex-1 truncate">{entries.length ? (showingGenerated ? t("aiOutline") : t("bookmarks")) : t("outline")}</span>
        {embedded.length && generated ? (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal hover:bg-muted hover:text-foreground"
            onClick={() => { setPreferGenerated((current) => !current); setExpanded({}); }}
          >
            {showingGenerated ? t("showBookmarks") : t("showAiOutline")}
          </button>
        ) : null}
        {showingGenerated && !running ? (
          confirmingDelete ? (
            <span className="flex items-center gap-1 normal-case tracking-normal">
              <button type="button" className="rounded px-1.5 py-0.5 font-medium text-destructive hover:bg-destructive-muted" disabled={deleting} onClick={() => void deleteOutline()}>
                {deleting ? t("deleting") : t("deleteOutline")}
              </button>
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => setConfirmingDelete(false)}>{t("cancel")}</button>
            </span>
          ) : (
            <>
              <button
                type="button"
                aria-label={t("regenerateOutlineButton")}
                title={t("regenerateWithAgent")}
                className="libera-sidebar-icon-button inline-flex h-6 w-6 items-center justify-center rounded"
                onClick={() => requestPdfOutline(path)}
              >
                <RefreshCw aria-hidden className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={t("deleteOutline")}
                title={t("deleteOutlineFile")}
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
          <span>{t("outliningInProgress")}</span>
        </p>
      ) : null}
      {runError ? <p role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive-muted px-3 py-2.5 text-xs text-destructive">{runError}</p> : null}
      {shownError ? <p role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive-muted px-3 py-2.5 text-xs text-destructive">{shownError}</p> : null}
      {showingGenerated && payload?.stale && !running ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-input px-3 py-2.5 text-xs text-muted-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {t("pdfChanged")}{" "}
            <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => requestPdfOutline(path)}>{t("regenerate")}</button>
          </span>
        </div>
      ) : null}
      {showingGenerated && problems.length && !running ? (
        <details className="mb-3 rounded-lg border border-input px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {errors.length
              ? t("structuralIssues", { count: errors.length })
              : t("verificationNotes", { count: problems.length })}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {problems.slice(0, 30).map((problem, index) => <li key={index}>{problem.message}</li>)}
          </ul>
        </details>
      ) : null}

      {!payload && !shownError ? (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">{t("loadingOutline")}</p>
      ) : !entries.length ? (
        running ? null : (
          <div className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
            {generated && !generated.entries.length ? (
              <p className="mb-2 font-medium text-foreground">{t("noHeadingsFound")}</p>
            ) : finished && !runError ? (
              <p className="mb-2 font-medium text-foreground">{t("finishedWithoutOutline")}</p>
            ) : null}
            <p>
              {payload?.embeddedError ? t("bookmarksUnreadable") : t("noBookmarks")}{" "}
              {t("outlineHint")}
            </p>
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-2 rounded-lg border border-input bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
              onClick={() => requestPdfOutline(path)}
            >
              <Sparkles aria-hidden className="h-4 w-4" />
              {generated ? t("regenerateOutlineButton") : t("generateOutlineButton")}
            </button>
          </div>
        )
      ) : rows.length ? (
        <div className="space-y-0.5" role="tree" aria-label={t("treeLabel", { source: showingGenerated ? "generated" : "bookmarks", name: activeTab.file.name })}>
          {rows.map(({ entry, hasChildren, expanded: isExpanded }) => {
            const isCurrent = entry.id === currentEntryId;
            return (
              <div key={entry.id} role="treeitem" aria-level={entry.level} aria-selected={isCurrent} aria-expanded={hasChildren ? isExpanded : undefined} className="flex items-start gap-0.5" style={{ paddingLeft: query ? 0 : `${(entry.level - 1) * 12}px` }}>
                {hasChildren ? (
                  <button
                    aria-label={isExpanded ? t("collapseEntry", { title: entry.title }) : t("expandEntry", { title: entry.title })}
                    aria-expanded={isExpanded}
                    className="libera-sidebar-icon-button mt-1 inline-flex h-6 w-5 shrink-0 items-center justify-center rounded"
                    type="button"
                    onClick={() => setExpanded((current) => ({ ...current, [entry.id]: !isExpanded }))}
                  >
                    {isExpanded ? <ChevronDown aria-hidden className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden className="h-3.5 w-3.5" />}
                  </button>
                ) : <span aria-hidden className="w-5 shrink-0" />}
                <SidebarNameTooltipButton
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${entry.page ? "" : "cursor-default opacity-60"}`}
                  style={isCurrent ? { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)" } : undefined}
                  aria-current={isCurrent ? "location" : undefined}
                  fullName={entry.unverified ? t("unverifiedEntry", { title: entry.title }) : entry.title}
                  type="button"
                  disabled={!entry.page}
                  onClick={() => void navigate(entry)}
                >
                  <span className={`min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] ${entry.level === 1 ? "font-medium" : ""} ${entry.unverified ? "italic text-muted-foreground" : ""}`}>{entry.title}</span>
                  {entry.page ? (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{t("pageLabel", { page: entry.page })}</span>
                  ) : null}
                </SidebarNameTooltipButton>
              </div>
            );
          })}
          {showingGenerated && generated?.generatedAt ? (
            <p className="px-1 pt-2 text-[11px] text-muted-foreground">
              {t("generatedLine", {
                date: format.dateTime(new Date(generated.generatedAt), { dateStyle: "medium", timeStyle: "short" }),
                model: generated.model || "none",
                amended: generated.updatedAt ? format.dateTime(new Date(generated.updatedAt), { dateStyle: "medium", timeStyle: "short" }) : "none",
              })}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">{t("noMatchingEntries")}</p>
      )}
    </section>
  );
}
