"use client";

import { AlertTriangle, Database, FolderOpen, Loader2 } from "lucide-react";
import { useState } from "react";
import { nudgeSearchStatus, refreshSearchStatus, searchIndexAction } from "@/components/libera/global-search/search-store";
import type { SearchIndexStatus } from "@/lib/global-search";

/** Only the desktop app can show files in Finder or pick an index file. */
export function canManageIndexFile() {
  return typeof window !== "undefined" && Boolean(window.liberaSearch);
}

/** Show the index file in Finder or Explorer. */
export async function revealSearchIndex(filePath: string) {
  return (await window.liberaSearch?.revealIndex(filePath)) ?? false;
}

function useIndexAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      nudgeSearchStatus();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The index could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}

/**
 * The first index is never built unasked: building reads every file and can
 * take hours with many PDFs and photos, and an index built before (copied
 * from another computer, say) can be used instead.
 */
export function IndexSetup({ status, compact = false }: { status: SearchIndexStatus; compact?: boolean }) {
  const { busy, error, run } = useIndexAction();
  const canChoose = canManageIndexFile();

  return (
    <div className={`libera-search-panel-card space-y-3 ${compact ? "p-3" : "p-4"}`}>
      <div className="flex items-start gap-3">
        <span className="libera-notebook-emoji flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#5b8def] text-white">
          <Database aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0 text-left">
          <p className="text-sm font-medium">No search index yet</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Building reads every note, PDF and photo once. It runs in the background and can take a while for a large library.
            {canChoose ? " If you already have an index for these notes, use it instead." : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={busy}
          onClick={() => void run(() => searchIndexAction("build"))}
        >
          {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Database aria-hidden className="h-4 w-4" />}
          Build index
        </button>
        {canChoose ? (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm hover:bg-muted disabled:opacity-50"
            disabled={busy}
            onClick={() => void run(async () => {
              const chosen = await window.liberaSearch?.useExistingIndex();
              if (chosen) await refreshSearchStatus(true);
            })}
          >
            <FolderOpen aria-hidden className="h-4 w-4" /> Use existing index…
          </button>
        ) : null}
      </div>
      <p className="truncate text-[11px] text-muted-foreground" title={status.indexPath}>Will be created at {status.indexPath}</p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** The index's vectors were made with other settings: say so, and offer to embed again. */
export function IndexMismatch({ status }: { status: SearchIndexStatus }) {
  const { busy, error, run } = useIndexAction();
  if (!status.mismatch) return null;

  return (
    <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed">
      <p className="flex items-start gap-2">
        <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span>
          {status.mismatch} Its vectors are not used with your current Search preferences, so only keyword search works.
          Switch back to those settings, or embed everything again.
        </span>
      </p>
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-input bg-card px-2.5 font-medium hover:bg-muted disabled:opacity-50"
        disabled={busy}
        onClick={() => void run(() => searchIndexAction("reembed"))}
      >
        {busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}
        Re-embed with current settings
      </button>
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}
