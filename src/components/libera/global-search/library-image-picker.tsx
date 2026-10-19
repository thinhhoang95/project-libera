"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { encodeFilePath } from "@/components/libera/api-client";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { LiberaFileNode } from "@/lib/types";

const MAX_SHOWN = 240;

/** Pick an image from the notebooks to search with. */
export function LibraryImagePicker({
  open,
  files,
  onClose,
  onPick,
}: {
  open: boolean;
  files: LiberaFileNode[];
  onClose: () => void;
  onPick: (file: LiberaFileNode) => void;
}) {
  const [filter, setFilter] = useState("");
  const images = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return files
      .filter((file) => file.fileType === "image" && (!needle || file.path.toLowerCase().includes(needle)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [files, filter]);

  return (
    <ModalDialog open={open} title="Search with an image from your notebooks" panelClassName="max-w-3xl" onClose={onClose}>
      <div className="relative mb-3">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          value={filter}
          placeholder="Filter by name or folder"
          className="h-9 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-sm outline-none focus:border-ring"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {images.length ? (
        <div className="grid max-h-[55vh] grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 overflow-y-auto pr-1">
          {images.slice(0, MAX_SHOWN).map((file) => (
            <button
              key={file.path}
              type="button"
              title={file.path}
              className="group overflow-hidden rounded-lg border border-border text-left hover:border-accent"
              onClick={() => onPick(file)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- local files served by the app */}
              <img src={`/api/files/raw/${encodeFilePath(file.path)}`} alt="" loading="lazy" decoding="async" className="aspect-square w-full bg-muted object-cover" />
              <span className="block truncate px-1.5 py-1 text-[11px]">{file.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-muted-foreground">{filter ? "No images match." : "There are no images in your notebooks."}</p>
      )}
      {images.length > MAX_SHOWN ? <p className="mt-2 text-xs text-muted-foreground">Showing {MAX_SHOWN} of {images.length}. Filter to narrow the list.</p> : null}
    </ModalDialog>
  );
}
