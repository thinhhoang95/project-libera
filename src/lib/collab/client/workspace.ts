// How shared tabs fit the workspace's save model (plan M1.6, map §6).
//
// A shared tab's edits are committed to the host's SQLite as they happen, so
// the tab is never "dirty": no dot, no Save, nothing for the updater to wait
// for, nothing for the session journal to recover. The host also owns the
// file on disk, so a shared tab never takes its content from disk either.
// These helpers keep those rules in one place for the workspace hook, the app
// shell and the tests.

import type { MarkdownSourceEditorKind } from "@/lib/markdown-preferences";
import type { Provenance } from "../protocol/actor";
import { isTextFileType, type LiberaFileType } from "@/lib/types";

interface TabLike {
  id: string;
  draft: string;
  saved: string;
  status?: string;
  untitled?: boolean;
  gallery?: unknown;
  standaloneSaveId?: string;
  file: { path: string; notebook: string; fileType: LiberaFileType };
}

export type IsSharedTab = (tabId: string) => boolean;

/**
 * Which Markdown Source editor a tab gets. The Classic textarea cannot carry
 * a CRDT binding, so shared tabs always get the CodeMirror editor.
 */
export function sourceEditorKind(preference: MarkdownSourceEditorKind, shared: boolean): MarkdownSourceEditorKind {
  return shared ? "codemirror" : preference;
}

/**
 * `getTabDraft` for any tab: the live shared text when the tab is a shared
 * document that has attached, else the editor's live draft, else the last
 * known one.
 */
export function readTabDraft<T extends TabLike>(tab: T, sources: { sharedText(tabId: string): string | null; editorDraft(tabId: string): string | undefined; latestDraft(tabId: string): string | undefined }): string {
  const shared = sources.sharedText(tab.id);
  if (shared !== null) return shared;
  return sources.editorDraft(tab.id) ?? sources.latestDraft(tab.id) ?? tab.draft;
}

/** Whether a tab could be a shared document: a text file of a shared notebook. */
export function isShareableTab(tab: TabLike, sharedNotebooks: ReadonlySet<string>): boolean {
  return !tab.untitled && !tab.gallery && !tab.standaloneSaveId && isTextFileType(tab.file.fileType) && sharedNotebooks.has(tab.file.notebook);
}

/** Unsaved changes that Save (or closing) must deal with. Never true for shared tabs. */
export function isTabDirty<T extends TabLike>(tab: T, isShared: IsSharedTab, readDraft: (tab: T) => string = (item) => item.draft): boolean {
  return !isShared(tab.id) && readDraft(tab) !== tab.saved;
}

/** The count the updater waits on before installing (electron/updater.cjs). */
export function dirtyDocumentCount(tabs: readonly TabLike[], isShared: IsSharedTab): number {
  return tabs.filter((tab) => isTextFileType(tab.file.fileType) && isTabDirty(tab, isShared)).length;
}

/**
 * The tab as the session draft journal and the `workspaces:checkpoint`
 * recovery file store it. A shared tab keeps its place in the session but not
 * its text: the host's SQLite is its journal, and a recovered copy of shared
 * text would be stale the moment anyone else typed.
 */
export function journalTab<T extends TabLike>(tab: T, isShared: IsSharedTab): T {
  return isShared(tab.id) ? { ...tab, draft: "", saved: "", status: "clean", error: undefined } : tab;
}

/** Whether a tab may take its content from disk (agent sync, undo restore, session restore). */
export function mayTakeContentFromDisk(tabId: string, isShared: IsSharedTab): boolean {
  return !isShared(tabId);
}

/** How a programmatic draft write describes itself, for shared tabs (ignored on others). */
export interface DraftWriteOptions {
  /** Defaults to typing. */
  provenance?: Provenance;
  /** The draft the new text was derived from, when the caller read it earlier. */
  base?: string;
}
