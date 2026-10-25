"use client";

import { Save } from "lucide-react";
import { pendingSaves, useHasPendingSaves } from "./pending-saves";

/**
 * A viewer's Save: its file's unsaved annotations and ink (pending-saves.ts),
 * written when pressed, as a note's Save writes its text. Ctrl+S does the same
 * for the active tab. `status` reports the last save's outcome.
 */
export function SaveStatusButton({ path, status }: { path: string; status: "idle" | "saving" | "saved" | "error" }) {
  const unsaved = useHasPendingSaves(path);
  const label = status === "saving" ? "Saving" : unsaved ? "Unsaved changes" : status === "saved" ? "Saved" : status === "error" ? "Save failed" : "";
  return (
    <>
      <span className="mr-1 text-xs text-muted-foreground">{label}</span>
      {unsaved || status === "error" ? (
        <button
          type="button"
          className="mr-2 inline-flex h-8 items-center gap-1.5 rounded-lg border border-input px-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          title="Save annotations and ink (Ctrl+S)"
          disabled={status === "saving"}
          onClick={() => { void pendingSaves.save(path).catch(() => undefined); }}
        >
          <Save aria-hidden className="h-4 w-4" />
          Save
        </button>
      ) : null}
    </>
  );
}
