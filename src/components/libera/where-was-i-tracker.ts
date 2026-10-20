"use client";

import { useEffect, useRef } from "react";
import { registerStateFlusher, stateRequestKeepalive } from "./deferred-save";
import type { OpenTab } from "./types";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";
import {
  encodeKnownFiles,
  rankRecapFiles,
  summarizeTextChange,
  type RecapFileEntry,
  type RecapSessionUpdate,
} from "@/lib/where-was-i";

// Where Was I (docs/features/where-was-i.md): this window's session, kept in
// memory. Nothing is written while you type. The record of a notebook is
// written when an edited file closes and when the app quits (the state flush
// that already runs before Libera exits), and only when it changed since the
// last write.
//
// New files are noticed from the library tree at those same moments: a file
// whose creation date falls inside the session was added in it, whether it
// was opened or not (an upload, a saved recording, an agent's file).

const SESSION_STORAGE_KEY = "libera.whereWasI.session";
const TEXT_FILE_TYPES = new Set(["markdown", "latex", "text"]);

type Tracked = {
  notebook: string;
  path: string;
  name: string;
  fileType: string;
  /** The text when the file opened (or when its shared document attached); null when not diffed. */
  baseline: string | null;
  /** Shared text before the debounced tab mirror catches up. */
  sharedText?: string;
  /** Added to the notebook during this session. */
  created: boolean;
  shared: boolean;
  editedByYou: boolean;
  editedByOthers: boolean;
};

function createSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A reload of the window (signing in again, a crash recovery) stays in the
// same session; quitting the app ends it.
function readSession() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "null") as { id?: string; startedAt?: string } | null;
    if (stored?.id && stored.startedAt) return { id: stored.id, startedAt: stored.startedAt };
  } catch { /* A new session. */ }
  const session = { id: createSessionId(), startedAt: new Date().toISOString() };
  try { sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session)); } catch { /* Kept in memory only. */ }
  return session;
}

function isTrackableTab(tab: OpenTab) {
  return !tab.gallery && !tab.recording && !tab.untitled && !!tab.file.notebook && tab.file.path.startsWith(`${tab.file.notebook}/`);
}

function notebookFiles(nodes: LiberaTreeNode[], files: LiberaFileNode[] = []) {
  for (const node of nodes) {
    if (node.kind === "folder") notebookFiles(node.children, files);
    else files.push(node);
  }
  return files;
}

function mergeEntries(previous: RecapFileEntry | undefined, next: RecapFileEntry): RecapFileEntry {
  if (!previous) return next;
  const added = (previous.added ?? 0) + (next.added ?? 0);
  const removed = (previous.removed ?? 0) + (next.removed ?? 0);
  const crops = [...(previous.crops ?? []), ...(next.crops ?? [])].slice(-2);
  const by = previous.edited && next.edited && previous.by !== next.by ? "mixed" : next.edited ? next.by : previous.by;
  return {
    ...next,
    edited: previous.edited || next.edited,
    ...(previous.created || next.created ? { created: true } : {}),
    ...(previous.unopened && next.unopened ? { unopened: true } : { unopened: undefined }),
    ...(added ? { added } : {}),
    ...(removed ? { removed } : {}),
    ...(crops.length ? { crops } : {}),
    ...(by ? { by } : {}),
  };
}

export class WhereWasITracker {
  private session: { id: string; startedAt: string } | null = null;
  private open = new Map<string, Tracked>();
  /** Files closed in this session, per notebook and path. */
  private closed = new Map<string, Map<string, RecapFileEntry>>();
  /** The last body written per notebook, so an unchanged record is not written again. */
  private written = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();
  private previousTabs = new Map<string, OpenTab>();
  private readLibrary: () => readonly LiberaNotebookNode[] = () => [];

  /** Where the tracker reads the library tree when it writes. */
  setLibrary(read: () => readonly LiberaNotebookNode[]) {
    this.readLibrary = read;
  }

  private get startedAt() {
    this.session ??= readSession();
    return this.session.startedAt;
  }

  get sessionId() {
    this.session ??= readSession();
    return this.session.id;
  }

  /** Paths opened in this session, so the home does not list them as changed while you were away. */
  touchedPaths(notebook: string) {
    const paths = new Set<string>();
    for (const tracked of this.open.values()) if (tracked.notebook === notebook) paths.add(`${notebook}/${tracked.path}`);
    for (const path of this.closed.get(notebook)?.keys() ?? []) paths.add(`${notebook}/${path}`);
    return paths;
  }

  /** Follows the open tabs: new tabs start tracking, closed tabs are recorded. */
  syncTabs(tabs: readonly OpenTab[], isShared: (tabId: string) => boolean) {
    const current = new Map<string, OpenTab>();
    for (const tab of tabs) {
      if (!isTrackableTab(tab)) continue;
      current.set(tab.id, tab);
      if (this.open.has(tab.id)) continue;
      const shared = isShared(tab.id);
      this.open.set(tab.id, {
        notebook: tab.file.notebook,
        path: tab.file.path.slice(tab.file.notebook.length + 1),
        name: tab.file.name,
        fileType: tab.file.fileType,
        // A shared tab's text arrives when its document attaches.
        baseline: TEXT_FILE_TYPES.has(tab.file.fileType) && !shared ? tab.saved : null,
        created: tab.file.createdAt >= this.startedAt,
        shared,
        editedByYou: false,
        editedByOthers: false,
      });
    }
    const notebooksWithEdits = new Set<string>();
    for (const [tabId, tracked] of this.open) {
      if (current.has(tabId)) continue;
      this.open.delete(tabId);
      // A closed tab's saved text is what reached the disk; discarded drafts do not count.
      const entry = this.recordClosed(tracked, tracked.sharedText ?? this.previousTabs.get(tabId)?.saved ?? null);
      if (entry.edited) notebooksWithEdits.add(tracked.notebook);
    }
    this.previousTabs = current;
    // Closing an edited file is a natural checkpoint. Viewed files wait for the quit.
    if (notebooksWithEdits.size) void this.write(notebooksWithEdits).catch(() => undefined);
  }

  /** A shared tab's document attached: its text is where the session's changes start. */
  sharedAttached(tabId: string, text: string) {
    const tracked = this.open.get(tabId);
    if (!tracked) return;
    if (!tracked.shared || tracked.baseline === null) {
      tracked.baseline = TEXT_FILE_TYPES.has(tracked.fileType) ? text : null;
    }
    tracked.shared = true;
    tracked.sharedText = text;
  }

  /** A shared document changed, by this window (`local`) or by someone else. */
  sharedEdited(tabId: string, local: boolean, text: string) {
    const tracked = this.open.get(tabId);
    if (!tracked) return;
    tracked.sharedText = text;
    if (local) tracked.editedByYou = true;
    else tracked.editedByOthers = true;
  }

  private entryFor(tracked: Tracked, text: string | null): RecapFileEntry {
    const change = tracked.baseline !== null && text !== null ? summarizeTextChange(tracked.baseline, text) : null;
    const by = !tracked.shared || !tracked.editedByOthers ? "you" : tracked.editedByYou ? "mixed" : "others";
    return {
      path: tracked.path,
      name: tracked.name,
      fileType: tracked.fileType,
      lastAt: new Date().toISOString(),
      edited: !!change,
      ...(tracked.created ? { created: true } : {}),
      ...(change ?? {}),
      ...(change ? { by } : {}),
    };
  }

  private recordClosed(tracked: Tracked, text: string | null) {
    const notebook = this.closed.get(tracked.notebook) ?? new Map<string, RecapFileEntry>();
    this.closed.set(tracked.notebook, notebook);
    const entry = mergeEntries(notebook.get(tracked.path), this.entryFor(tracked, text));
    notebook.set(tracked.path, entry);
    return entry;
  }

  /** The notebook's files in the library tree, by path inside the notebook. */
  private libraryFiles(notebook: string) {
    const node = this.readLibrary().find((item) => item.name === notebook);
    if (!node) return null;
    return new Map(notebookFiles(node.children)
      .filter((file) => file.path.startsWith(`${notebook}/`))
      .map((file) => [file.path.slice(notebook.length + 1), file]));
  }

  /** Notebooks that gained files during this session. */
  private notebooksWithNewFiles() {
    return this.readLibrary()
      .filter((node) => notebookFiles(node.children).some((file) => file.createdAt >= this.startedAt))
      .map((node) => node.name);
  }

  /**
   * The notebook's record now: closed files, the files still open, and files
   * added during the session that were never opened.
   */
  private snapshot(notebook: string, readText?: (tabId: string) => string | null) {
    const entries = new Map(this.closed.get(notebook) ?? []);
    for (const [tabId, tracked] of this.open) {
      if (tracked.notebook !== notebook) continue;
      const text = tracked.sharedText ?? (readText ? readText(tabId) : this.previousTabs.get(tabId)?.saved ?? null);
      entries.set(tracked.path, mergeEntries(entries.get(tracked.path), this.entryFor(tracked, text)));
    }
    const library = this.libraryFiles(notebook);
    for (const [path, file] of library ?? []) {
      if (file.createdAt < this.startedAt) continue;
      const entry = entries.get(path);
      if (entry) entries.set(path, { ...entry, created: true });
      else entries.set(path, { path, name: file.name, fileType: file.fileType, lastAt: file.createdAt, edited: false, created: true, unopened: true });
    }
    // Dropped files (deleted or renamed since) are left to the home, which skips them.
    // A linked folder's tree stops at an entry limit; a partial list would call the rest new.
    const complete = !this.readLibrary().find((item) => item.name === notebook)?.folder?.truncated;
    return { files: rankRecapFiles([...entries.values()]), knownFiles: library && complete ? encodeKnownFiles(library.keys()) : null };
  }

  private write(notebooks: Iterable<string>, readText?: (tabId: string) => string | null): Promise<void> {
    // Capture now, then send in order. A close checkpoint may still be in
    // flight when quit captures newer text from the remaining editors.
    const captured = [...notebooks].map((notebook) => ({ notebook, ...this.snapshot(notebook, readText) }));
    const task = this.writing.catch(() => undefined).then(() => this.writeCaptured(captured));
    this.writing = task;
    return task;
  }

  private async writeCaptured(captured: { notebook: string; files: RecapFileEntry[]; knownFiles: string | null }[]) {
    const update: RecapSessionUpdate = { sessionId: this.sessionId, startedAt: this.session!.startedAt, notebooks: {} };
    const bodies = new Map<string, string>();
    for (const { notebook, files, knownFiles } of captured) {
      // lastAt changes on every snapshot; compare the record without it.
      const body = JSON.stringify([files.map((file) => ({ ...file, lastAt: "" })), knownFiles]);
      if (!files.length || this.written.get(notebook) === body) continue;
      update.notebooks[notebook] = files;
      (update.knownFiles ??= {})[notebook] = knownFiles;
      bodies.set(notebook, body);
    }
    if (!bodies.size) return;
    const body = JSON.stringify(update);
    const response = await fetch("/api/where-was-i", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: stateRequestKeepalive(body),
    });
    if (!response.ok) throw new Error("Could not record the session.");
    // An opt-out is a successful request, but no record was written. Retain
    // the ability to save this snapshot if recording is enabled again.
    const result = await response.json() as { recorded?: boolean };
    if (result.recorded === false) return;
    for (const [notebook, written] of bodies) this.written.set(notebook, written);
  }

  /** Before the app quits: records every notebook touched in this session, open files and new files included. */
  flush(readText: (tabId: string) => string | null) {
    const notebooks = new Set([
      ...this.closed.keys(),
      ...[...this.open.values()].map((tracked) => tracked.notebook),
      ...this.notebooksWithNewFiles(),
    ]);
    // A failure must not keep Libera from quitting: the recap is a convenience.
    return this.write(notebooks, readText).catch(() => undefined);
  }
}

export const whereWasITracker = new WhereWasITracker();

/** Feeds the tracker from the workspace's tabs and records the session before the app quits. */
export function useWhereWasITracker(
  tabs: readonly OpenTab[],
  isShared: (tabId: string) => boolean,
  readText: (tab: OpenTab) => string,
  library: readonly LiberaNotebookNode[],
) {
  const latest = useRef({ tabs, isShared, readText, library });
  useEffect(() => { latest.current = { tabs, isShared, readText, library }; });
  useEffect(() => { whereWasITracker.setLibrary(() => latest.current.library); }, []);
  useEffect(() => { whereWasITracker.syncTabs(tabs, latest.current.isShared); }, [tabs]);
  useEffect(() => registerStateFlusher(() => whereWasITracker.flush((tabId) => {
    const tab = latest.current.tabs.find((item) => item.id === tabId);
    return tab ? latest.current.readText(tab) : null;
  })), []);
}
