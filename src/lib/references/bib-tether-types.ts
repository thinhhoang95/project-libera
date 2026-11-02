// Types of a tethered .bib file shared by the server (bib-tether.ts), the
// route and the References panel. Pure types only.

import type { TetherConflict } from "./bib-tether-merge";

export type TetherState =
  /** Both sides agree. */
  | "synced"
  /** Waiting for the user: many entries left the file at once. */
  | "paused"
  /** The file is gone, or its folder or drive is unavailable. Nothing is deleted; the tether resumes when it is back. */
  | "missing"
  /** The last sync failed (unreadable file, write refused, …). It is retried on the next change. */
  | "error";

export type TetherChangeCounts = {
  /** Into the library from the file. */
  toLibrary: { added: number; updated: number; deleted: number };
  /** Into the file from the library. */
  toFile: { added: number; updated: number; deleted: number };
  conflicts: TetherConflict[];
  kept: string[];
};

export type TetherStatus = {
  /** As chosen: an absolute path, or library-relative ("Notebook/refs.bib") inside the library. */
  displayPath: string;
  fileName: string;
  /** The file is in this notebook or another library folder (it then follows moves made in Libera). */
  insideLibrary: boolean;
  dialect: "bibtex" | "biblatex";
  state: TetherState;
  message?: string;
  tetheredAt: string;
  lastSyncedAt?: string;
  /** The last sync that changed something. */
  lastChange?: TetherChangeCounts & { at: string };
  /** Deletions from the file waiting for the user. */
  pendingDeletion?: { count: number; keys: string[]; token: string };
  warnings: string[];
  /** Changes to the file are noticed as they happen. False: only when Libera checks (on focus, or Sync now). */
  watching: boolean;
  /** Entries the file and the library share. */
  entries: number;
  /** The library revision the last sync left; a window showing an older one reloads. */
  libraryRevision?: number;
};

/** What tethering would do, shown before the user confirms. */
export type TetherPreview = {
  displayPath: string;
  fileName: string;
  exists: boolean;
  dialect: "bibtex" | "biblatex";
  fileEntries: number;
  libraryEntries: number;
  /** Entries only in the file, which come into the library. */
  toLibrary: number;
  /** Entries only in the library, which are written to the file. */
  toFile: number;
  /** Entries in both whose fields differ; `prefer` decides them. */
  differing: number;
  warnings: string[];
};
