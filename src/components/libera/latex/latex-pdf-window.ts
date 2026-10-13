"use client";

import { useSyncExternalStore } from "react";
import type { SynctexTextHint } from "@/lib/latex/synctex-text";
import { getLatexBuild, subscribeLatexBuild } from "./latex-build-store";
import type { PdfHighlightRequest } from "./latex-pdf-preview";

/* The compiled PDF of a main file can move into its own window (handy on a
 * second monitor). Builds still run in the main window; a BroadcastChannel per
 * main file carries each finished build and SyncTeX highlights to the PDF
 * window, and carries clicks and recompile requests back. */

const CHANNEL_PREFIX = "libera-latex-pdf";
const CLOSED_POLL_MS = 1000;

/** What the PDF window needs from a build entry; the log stays in the main window. */
export type LatexPdfWindowBuild = {
  compiling: boolean;
  buildId: string | null;
  version: number;
  requestError: string;
  status: "success" | "error" | "failure" | null;
  durationMs: number | null;
};

export type LatexPdfInverseSync = { page: number; x: number; y: number; hint?: SynctexTextHint };

export type LatexPdfWindowMessage =
  | { type: "build"; build: LatexPdfWindowBuild }
  | { type: "highlight"; highlight: PdfHighlightRequest }
  | { type: "hello" }
  | { type: "inverse-sync"; location: LatexPdfInverseSync }
  | { type: "compile" }
  | { type: "closed" };

export type LatexPdfWindowHandlers = {
  onInverseSync: (location: LatexPdfInverseSync) => void;
  onCompile: () => void;
};

export function latexPdfChannelName(rootPath: string) {
  return `${CHANNEL_PREFIX}:${rootPath}`;
}

export function latexPdfWindowBuild(rootPath: string): LatexPdfWindowBuild {
  const entry = getLatexBuild(rootPath);
  return {
    compiling: entry.compiling,
    buildId: entry.buildId,
    version: entry.version,
    requestError: entry.requestError,
    status: entry.result?.status ?? null,
    durationMs: entry.result?.durationMs ?? null,
  };
}

type OpenWindow = { child: Window; channel: BroadcastChannel; dispose: () => void };

const openWindows = new Map<string, OpenWindow>();
const handlers = new Map<string, LatexPdfWindowHandlers>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function closeEntry(rootPath: string) {
  const open = openWindows.get(rootPath);
  if (!open) return;
  openWindows.delete(rootPath);
  open.dispose();
  notify();
}

/** Opens (or focuses) the PDF window for `rootPath`. Returns false when the pop-up was blocked. */
export function openLatexPdfWindow(rootPath: string) {
  const existing = openWindows.get(rootPath);
  if (existing && !existing.child.closed) {
    existing.child.focus();
    return true;
  }
  if (existing) closeEntry(rootPath);
  if (typeof BroadcastChannel === "undefined") return false;

  const child = window.open(`/latex-pdf-window?path=${encodeURIComponent(rootPath)}`, "_blank", "popup,width=900,height=1000");
  if (!child) return false;

  const channel = new BroadcastChannel(latexPdfChannelName(rootPath));
  const sendBuild = () => channel.postMessage({ type: "build", build: latexPdfWindowBuild(rootPath) } satisfies LatexPdfWindowMessage);
  channel.addEventListener("message", (event: MessageEvent<LatexPdfWindowMessage>) => {
    const message = event.data;
    if (message?.type === "hello") sendBuild();
    else if (message?.type === "inverse-sync") handlers.get(rootPath)?.onInverseSync(message.location);
    else if (message?.type === "compile") handlers.get(rootPath)?.onCompile();
    // A reload also sends "closed", so confirm the window is really gone.
    else if (message?.type === "closed") setTimeout(() => { if (child.closed) closeEntry(rootPath); }, 150);
  });
  const unsubscribe = subscribeLatexBuild(rootPath, sendBuild);
  // "closed" is sent on pagehide; polling also catches windows that die without it.
  const poll = setInterval(() => { if (child.closed) closeEntry(rootPath); }, CLOSED_POLL_MS);
  // The PDF window has nothing to show once the window that compiles is gone.
  window.addEventListener("pagehide", closeAllOnUnload);

  openWindows.set(rootPath, {
    child,
    channel,
    dispose: () => {
      clearInterval(poll);
      unsubscribe();
      channel.close();
    },
  });
  notify();
  return true;
}

function closeAllOnUnload() {
  for (const rootPath of [...openWindows.keys()]) closeLatexPdfWindow(rootPath);
}

export function closeLatexPdfWindow(rootPath: string) {
  const open = openWindows.get(rootPath);
  if (!open) return;
  if (!open.child.closed) open.child.close();
  closeEntry(rootPath);
}

export function sendLatexPdfHighlight(rootPath: string, highlight: PdfHighlightRequest) {
  openWindows.get(rootPath)?.channel.postMessage({ type: "highlight", highlight } satisfies LatexPdfWindowMessage);
}

/** Lets the workspace showing `rootPath` answer clicks and recompile requests from its PDF window. */
export function registerLatexPdfWindowHandlers(rootPath: string, next: LatexPdfWindowHandlers) {
  handlers.set(rootPath, next);
  return () => { if (handlers.get(rootPath) === next) handlers.delete(rootPath); };
}

export function useLatexPdfWindowOpen(rootPath: string) {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => openWindows.has(rootPath),
    () => false,
  );
}
