"use client";

import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { useHostEvents } from "@/lib/collab/ui/hooks";

const fileName = (path: string) => path.split("/").pop() ?? path;

/**
 * Says when a file put in a shared notebook's folder went to `_archive`
 * instead of being shared. It stays until dismissed: nothing else shows that
 * the file left the folder.
 */
export function ArchivedFilesNotice() {
  const [paths, setPaths] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]);
  useHostEvents("file-archived", (event) => {
    setPaths((current) => (current.includes(event.path) ? current : [...current, event.path]));
    if (event.reason === "conflict-copy") setConflicts((current) => (current.includes(event.path) ? current : [...current, event.path]));
  });
  if (paths.length === 0) return null;
  const notebook = paths[0].split("/")[0];
  const subject = paths.length === 1 ? fileName(paths[0]) : `${paths.length} files`;
  const allConflicts = paths.every((item) => conflicts.includes(item));
  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-2xl border border-border bg-card px-4 py-2 text-sm shadow-lg"
    >
      <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {allConflicts
          ? <>{subject} moved to {notebook}/_archive because {paths.length === 1 ? "it looks like a sync conflict copy" : "they look like sync conflict copies"} of a shared file. Compare with the original and copy anything you need into it.</>
          : <>{subject} moved to {notebook}/_archive because {paths.length === 1 ? "it matches a file" : "they match files"} removed from this shared notebook, or {paths.length === 1 ? "looks like a sync conflict copy" : "look like sync conflict copies"}. To share {paths.length === 1 ? "it" : "them"} again, upload in Libera or use a new name.</>}
      </span>
      <button type="button" className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100" aria-label="Dismiss" onClick={() => { setPaths([]); setConflicts([]); }}>
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
