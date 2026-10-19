"use client";

import { Download, FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import {
  cancelDocumentOcrModelDownload,
  fetchDocumentOcrModelStatus,
  getDocumentOcrGate,
  settleDocumentOcrGate,
  startDocumentOcrModelDownload,
  subscribeDocumentOcrGate,
  type DocumentOcrModelStatus,
} from "@/components/libera/document-ocr/document-ocr-client";

const CLOSED = { open: false };

function megabytes(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Sets up the PDF reading model when a feature needs it: points to
 * Preferences → Search when no folder is chosen, offers the download into the
 * chosen folder, and shows its progress. Mounted once for the whole app.
 */
export function DocumentOcrModelDialog() {
  const gate = useSyncExternalStore(subscribeDocumentOcrGate, getDocumentOcrGate, () => CLOSED);
  const [status, setStatus] = useState<DocumentOcrModelStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDocumentOcrModelStatus();
      setStatus(next);
      setError("");
      if (next.state === "ready") settleDocumentOcrGate(true);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Could not check the PDF reading model.");
    }
  }, []);

  // Poll while open: the download runs on the server, and the folder can be
  // chosen in Preferences while this dialog waits.
  useEffect(() => {
    if (!gate.open) return;
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), status?.state === "downloading" ? 700 : 2000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [gate.open, refresh, status?.state]);

  async function act(work: () => Promise<DocumentOcrModelStatus>) {
    setBusy(true);
    setError("");
    try {
      setStatus(await work());
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  const close = () => settleDocumentOcrGate(false);
  const state = status?.state;
  const canOpenPreferences = typeof window !== "undefined" && Boolean(window.liberaPreferences);
  const progress = status && status.totalBytes ? Math.min(1, status.downloadedBytes / status.totalBytes) : 0;
  const buttonClass = "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
  const primaryClass = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40";

  let footer = null;
  if (state === "unconfigured" && canOpenPreferences) {
    footer = (
      <button type="button" className={primaryClass} onClick={() => void window.liberaPreferences?.open("search")}>
        <FolderOpen aria-hidden className="h-4 w-4" /> Open Preferences
      </button>
    );
  } else if (state === "missing" || state === "error") {
    footer = (
      <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(startDocumentOcrModelDownload)}>
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Download aria-hidden className="h-4 w-4" />}
        {state === "error" ? "Try again" : `Download (${megabytes(status?.totalBytes ?? 0)})`}
      </button>
    );
  } else if (state === "downloading") {
    footer = (
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(cancelDocumentOcrModelDownload)}>
        Cancel download
      </button>
    );
  }

  return (
    <ModalDialog
      open={gate.open}
      title="PDF reading model"
      description="Reads PDF pages and snips into Markdown on this computer."
      onClose={close}
      footer={footer}
    >
      <div className="space-y-3 text-sm leading-relaxed">
        {!status && !error ? (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Checking…</p>
        ) : null}
        {state === "unconfigured" ? (
          <p>
            Choose a folder for the model in Preferences → Search, under PDF reading model.
            {canOpenPreferences ? "" : " Set LIBERA_READING_MODEL_DIR on the server."} This dialog continues once the folder is saved.
          </p>
        ) : null}
        {state === "missing" ? (
          <p>
            Libera uses IBM’s granite-docling-258M (Apache-2.0). Download it from Hugging Face into your model folder?
            It runs on the CPU; a full page takes one to three minutes.
          </p>
        ) : null}
        {state === "downloading" ? (
          <div className="space-y-1.5">
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <div className="h-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {megabytes(status?.downloadedBytes ?? 0)} of {megabytes(status?.totalBytes ?? 0)}. Closing this dialog keeps the download going.
            </p>
          </div>
        ) : null}
        {state === "error" ? <p role="alert" className="text-destructive">{status?.error}</p> : null}
        {status?.directory && state !== "unconfigured" ? (
          <p className="truncate text-[11px] text-muted-foreground" title={status.directory}>Folder: {status.directory}</p>
        ) : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
    </ModalDialog>
  );
}
