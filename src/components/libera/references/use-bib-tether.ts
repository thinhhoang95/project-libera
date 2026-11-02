"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TetherPreview, TetherStatus } from "@/lib/references/bib-tether-types";
import type { ReferenceServerEvent } from "@/lib/references/library-events";
import { REFERENCES_UPDATED_EVENT, type ReferencesUpdatedDetail } from "@/lib/references/types";

// A notebook's tethered .bib file (lib/references/bib-tether.ts), for the
// References panel: its status, its actions, and live updates. While the
// notebook is tethered the window listens to /api/references/events, so a
// change that arrives through the file (an external editor, a collaborator)
// reloads the library at once; a check runs when the window regains
// focus, for changes the server's file watcher could not see. One stream
// stays open for the panel, including when another window may tether it.

/** Focus checks closer together than this are skipped. */
const CHECK_INTERVAL_MS = 5_000;

export type BibTetherRequest =
  | { action: "tether"; path: string; prefer: "library" | "file"; create?: boolean }
  | { action: "untether" | "sync" | "check" | "recreate" }
  | { action: "resolve"; choice: "apply" | "restore"; token: string };

class TetherRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/references/bib-tether", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new TetherRequestError(result.error ?? "The .bib file could not be synced.", response.status);
  return result;
}

export function previewBibTether(notebook: string, path: string) {
  return post<{ preview: TetherPreview }>({ notebook, action: "preview", path }).then((result) => result.preview);
}

/** A sync may have changed the library on the server: windows showing an older revision reload it. */
function announceRevision(notebook: string, status: TetherStatus | null) {
  if (typeof status?.libraryRevision !== "number") return;
  window.dispatchEvent(new CustomEvent<ReferencesUpdatedDetail>(REFERENCES_UPDATED_EVENT, { detail: { notebook, revision: status.libraryRevision } }));
}

export function useBibTether(notebook: string | null) {
  const version = useRef(0);
  const [state, setState] = useState<{ notebook: string | null; status: TetherStatus | null; loaded: boolean; error: string | null }>({ notebook: null, status: null, loaded: false, error: null });
  const status = state.notebook === notebook ? state.status : null;
  const loaded = state.notebook === notebook && state.loaded;

  useEffect(() => {
    if (!notebook) return;
    let cancelled = false;
    const requestVersion = ++version.current;
    void fetch(`/api/references/bib-tether?notebook=${encodeURIComponent(notebook)}`, { cache: "no-store" })
      .then(async (response) => {
        // No tether route (an older server, or a test without one) means no tether, not a failure to show.
        if (response.status === 404) return { tether: null };
        const result = await response.json() as { tether: TetherStatus | null; error?: string };
        if (!response.ok) throw new Error(result.error ?? "Could not read the .bib tether status.");
        return result;
      })
      .then((result) => {
        if (cancelled || requestVersion !== version.current) return;
        setState({ notebook, status: result.tether, loaded: true, error: null });
        announceRevision(notebook, result.tether);
      })
      .catch((error: unknown) => {
        if (!cancelled && requestVersion === version.current) setState({ notebook, status: null, loaded: true, error: error instanceof Error ? error.message : "Could not read the .bib tether status." });
      });
    return () => { cancelled = true; };
  }, [notebook]);

  const run = useCallback(async (request: BibTetherRequest) => {
    if (!notebook) throw new Error("Open a notebook first.");
    const requestVersion = ++version.current;
    try {
      const result = await post<{ tether: TetherStatus | null }>({ notebook, ...request });
      if (requestVersion === version.current) setState({ notebook, status: result.tether, loaded: true, error: null });
      announceRevision(notebook, result.tether);
      return result.tether;
    } catch (error) {
      // A background check that finds no tether route is the same as finding no tether.
      if (request.action === "check" && error instanceof TetherRequestError && error.status === 404) {
        if (requestVersion === version.current) setState({ notebook, status: null, loaded: true, error: null });
        return null;
      }
      if (requestVersion === version.current) setState((current) => ({ ...current, notebook, loaded: true, error: error instanceof Error ? error.message : "The .bib file could not be synced." }));
      throw error;
    }
  }, [notebook]);

  // Opening and reconnecting the stream catches events missed before subscription.
  useEffect(() => {
    if (!notebook || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/references/events?notebook=${encodeURIComponent(notebook)}`);
    const parse = (message: Event) => {
      try { return JSON.parse((message as MessageEvent<string>).data) as ReferenceServerEvent; } catch { return null; }
    };
    source.addEventListener("open", () => {
      // Catch up with changes made before subscription or during a disconnect.
      void run({ action: "check" }).catch(() => undefined);
    });
    source.addEventListener("library", (message) => {
      const event = parse(message);
      if (event?.type !== "library" || event.notebook !== notebook) return;
      window.dispatchEvent(new CustomEvent<ReferencesUpdatedDetail>(REFERENCES_UPDATED_EVENT, { detail: { notebook, revision: event.revision } }));
    });
    source.addEventListener("tether", (message) => {
      const event = parse(message);
      if (event?.type !== "tether" || event.notebook !== notebook) return;
      version.current += 1;
      setState({ notebook, status: event.status, loaded: true, error: null });
      announceRevision(notebook, event.status);
    });
    return () => source.close();
  }, [notebook, run]);

  // A check when the window comes back, for changes a file watcher can miss (network shares, sleep).
  useEffect(() => {
    if (!notebook) return;
    let last = 0;
    const onReturn = () => {
      if (document.visibilityState === "hidden" || Date.now() - last < CHECK_INTERVAL_MS) return;
      last = Date.now();
      void run({ action: "check" }).catch(() => undefined);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [notebook, run]);

  return { status, loaded, run, error: state.notebook === notebook ? state.error : null };
}

/** "Synced 2 min ago", "Waiting for you", … for the panel's status line. */
export function tetherStateText(status: TetherStatus, now = Date.now()) {
  switch (status.state) {
    case "paused": return `${status.pendingDeletion?.count ?? "Some"} removed from the file: waiting for you`;
    case "missing": return "File not found: paused";
    case "error": return "Not synced: see details";
    default: {
      if (!status.lastSyncedAt) return "Synced";
      const minutes = Math.round((now - Date.parse(status.lastSyncedAt)) / 60_000);
      const ago = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 60 * 24 ? `${Math.round(minutes / 60)} h ago` : new Date(status.lastSyncedAt).toLocaleDateString();
      return `Synced${status.watching ? "" : " (checked on focus)"} · last change ${ago}`;
    }
  }
}
