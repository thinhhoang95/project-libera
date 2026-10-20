"use client";

import { Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import {
  cancelLocalModelDownload,
  fetchLocalModelStatus,
  getLocalModelGate,
  settleLocalModelGate,
  startLocalModelDownload,
  subscribeLocalModelGate,
  type LocalModelId,
  type LocalModelStatus,
} from "@/components/libera/local-models/local-model-client";

const CLOSED = { model: null };

const COPY: Record<LocalModelId, { title: string; description: string; offer: string }> = {
  search: {
    title: "Search model",
    description: "Finds notes, PDFs and images by meaning on this computer.",
    offer: "Libera uses Google’s EmbeddingGemma 2 (Apache-2.0), with its vision encoder for photos. Download it from Hugging Face? Indexing starts once it arrives; keyword search works meanwhile.",
  },
  reading: {
    title: "PDF reading model",
    description: "Reads PDF pages and snips into Markdown on this computer.",
    offer: "Libera uses IBM’s granite-docling-258M (Apache-2.0). Download it from Hugging Face? It runs on the CPU; a full page takes one to three minutes.",
  },
  "read-aloud": {
    title: "Read Aloud voice",
    description: "Reads text aloud on this computer, without sending it anywhere.",
    offer: "Libera uses Kokoro 82M (Apache-2.0), 53 voices in eight languages. Download it from Hugging Face? Or switch Read Aloud to OpenRouter in Preferences.",
  },
};

function megabytes(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * Offers a local model's download when a feature needs it and shows its
 * progress. The download goes into Libera's application data, or the folder
 * chosen in Preferences. Mounted once for the whole app.
 */
export function LocalModelDialog() {
  const gate = useSyncExternalStore(subscribeLocalModelGate, getLocalModelGate, () => CLOSED);
  const model = gate.model;
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!model) return;
    try {
      const next = await fetchLocalModelStatus(model);
      setStatus(next);
      setError("");
      if (next.state === "ready") settleLocalModelGate(true);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Could not check the model.");
    }
  }, [model]);

  // Poll while open: the download runs on the server, and Preferences can
  // change the folder while this dialog waits.
  const current = status?.id === model ? status : null;
  useEffect(() => {
    if (!model) return;
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), current?.state === "downloading" ? 700 : 2000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [model, refresh, current?.state]);

  async function act(work: (id: LocalModelId) => Promise<LocalModelStatus>) {
    if (!model) return;
    setBusy(true);
    setError("");
    try {
      setStatus(await work(model));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  }

  const close = () => settleLocalModelGate(false);
  const state = current?.state;
  const copy = COPY[model ?? "reading"];
  const progress = current && current.totalBytes ? Math.min(1, current.downloadedBytes / current.totalBytes) : 0;
  const buttonClass = "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
  const primaryClass = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40";

  let footer = null;
  if (state === "missing" || state === "error") {
    footer = (
      <button type="button" className={primaryClass} disabled={busy} onClick={() => void act(startLocalModelDownload)}>
        {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Download aria-hidden className="h-4 w-4" />}
        {state === "error" ? "Try again" : `Download (${megabytes(current?.totalBytes ?? 0)})`}
      </button>
    );
  } else if (state === "downloading") {
    footer = (
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void act(cancelLocalModelDownload)}>
        Cancel download
      </button>
    );
  }

  return (
    <ModalDialog open={Boolean(model)} title={copy.title} description={copy.description} onClose={close} footer={footer}>
      <div className="space-y-3 text-sm leading-relaxed">
        {!current && !error ? (
          <p className="flex items-center gap-2 text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Checking…</p>
        ) : null}
        {state === "missing" ? <p>{copy.offer}</p> : null}
        {state === "downloading" ? (
          <div className="space-y-1.5">
            <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <div className="h-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {megabytes(current?.downloadedBytes ?? 0)} of {megabytes(current?.totalBytes ?? 0)}. Closing this dialog keeps the download going.
            </p>
          </div>
        ) : null}
        {state === "error" ? <p role="alert" className="text-destructive">{current?.error}</p> : null}
        {current?.directory ? (
          <p className="truncate text-[11px] text-muted-foreground" title={current.directory}>Folder: {current.directory}</p>
        ) : null}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
    </ModalDialog>
  );
}
