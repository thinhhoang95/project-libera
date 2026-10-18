"use client";

// "History…" in the file actions menu of a shared file, and the panel it
// opens. The menu only names the tab; the panel's target (document, project,
// role) comes from the tab's shared session in the registry.

import { useSyncExternalStore } from "react";
import { getSharedDocRegistry, type SharedDocRegistry } from "@/lib/collab/client/registry";
import { DocumentHistoryPanel, type HistoryTarget } from "./history-panel";

export { DiffView, DocumentHistoryPanel, RevisionView, revisionTitle, type HistoryTarget } from "./history-panel";
export { attributeUpdates, updateAuthor, type Attribution, type AttributedRange, type AttributionAuthor } from "./attribution";
export { contentUpdates, createHistoryApi, historyApi, type HistoryApi } from "./history-api";
export { startSessionEndRevisions, useSessionEndRevisions } from "./session-end";

export const HISTORY_MENU_ID = "history";

let target: HistoryTarget | null = null;
const listeners = new Set<() => void>();

function setTarget(next: HistoryTarget | null) {
  target = next;
  for (const listener of [...listeners]) listener();
}

/** The history panel's target for a tab, or null when the tab is not a shared document. */
export function historyTargetForTab(tabId: string, registry: SharedDocRegistry = getSharedDocRegistry()): HistoryTarget | null {
  const session = registry.sessionForTab(tabId);
  if (!session) return null;
  const meta = session.replica.getSnapshot().meta;
  return { docId: session.docId, projectId: session.resolved.projectId, path: session.resolved.path, role: meta?.role ?? session.resolved.role };
}

/** File actions menu entries for a tab: "History…" for shared files, nothing otherwise. */
export function historyMenuItems(tabId: string): { id: string; label: string }[] {
  return historyTargetForTab(tabId) ? [{ id: HISTORY_MENU_ID, label: "History…" }] : [];
}

/** Opens the history panel for a tab; false when the tab is not shared. */
export function openDocumentHistory(tabId: string): boolean {
  const next = historyTargetForTab(tabId);
  if (next) setTarget(next);
  return !!next;
}

export function closeDocumentHistory() {
  setTarget(null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Renders the open history panel (mounted once beside the file actions). */
export function DocumentHistoryHost() {
  const current = useSyncExternalStore(subscribe, () => target, () => null);
  if (!current) return null;
  return <DocumentHistoryPanel key={current.docId} target={current} onClose={closeDocumentHistory} />;
}
