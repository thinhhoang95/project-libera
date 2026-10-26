"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Download, Layers, Save, X } from "lucide-react";
import { photoViewMatrix, photoViewSize } from "@/lib/ink/frame";
import type { GalleryContents } from "@/lib/image-generation";
import { apiRequest } from "../api-client";
import { pendingSaves, useHasPendingSaves } from "../pending-saves";
import { downloadImage } from "../image-save";
import { InkSurface } from "./ink-surface";
import { InkToolbar } from "./ink-toolbar";
import type { InkMatrix } from "./ink-renderer";
import { inkSavePath, useInkDocument } from "./use-ink-document";
import { useInkTools } from "./use-ink-tools";

/*
 * Ink on a gallery photo (docs/ink-plan.md, "Gallery photos"). Strokes are
 * kept on the photo as first inked, and drawn through the photo's view (the
 * turns and crop of edits since) over the file shown today. The layer sits on
 * the photo's measured box in the viewer, so the viewer's zoom is its size.
 *
 * It takes input only in the viewer's Draw mode, and is written only on Save
 * (pending-saves.ts). When the photo changed outside Libera, the ink is dimmed
 * until the reader keeps or discards it.
 */

const IDENTITY: InkMatrix = [1, 0, 0, 1, 0, 0];

const halt = (event: { stopPropagation: () => void }) => event.stopPropagation();

export function PhotoInkLayer({ photoId, version, drawing, toolbarSlot, onPan, onEdited }: {
  photoId: string;
  /** Changes when the photo's file does (an edit, a revert), to reload its view. */
  version: string;
  drawing: boolean;
  toolbarSlot: HTMLElement | null;
  onPan: (dx: number, dy: number) => void;
  /** The ink was drawn into the photo: the gallery changed. */
  onEdited: (gallery: GalleryContents) => void;
}) {
  const ink = useInkDocument({ path: photoId, chunk: "photo", frame: { unit: "px", width: 1, height: 1 }, photoId });
  const tools = useInkTools();
  const [busy, setBusy] = useState(false);
  const [confirmFlatten, setConfirmFlatten] = useState(false);
  const unsaved = useHasPendingSaves(inkSavePath({ path: photoId, photoId }));
  const { reload } = ink;

  // An edit or revert changed the file under the ink: fetch the new view.
  useEffect(() => { void reload(); }, [version, reload]);

  const photo = ink.photo;
  const matrix = useMemo<InkMatrix>(() => {
    if (!photo) return IDENTITY;
    // Each bake rounds its crop to whole pixels: scale the last fraction away, as the export does.
    const size = photoViewSize(photo.original, photo.view);
    const [a, b, c, d, e, f] = photoViewMatrix(photo.original, photo.view);
    const sx = photo.viewSize.width / size.width;
    const sy = photo.viewSize.height / size.height;
    return [a * sx, b * sy, c * sx, d * sy, e * sx, f * sy];
  }, [photo]);

  const resolve = async (action: "keep" | "discard") => {
    setBusy(true);
    try {
      await apiRequest("/api/gallery/photos/ink", { method: "POST", body: JSON.stringify({ id: photoId, action }) });
      if (action === "discard") pendingSaves.discard(inkSavePath({ path: photoId, photoId }));
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const flatten = async () => {
    setBusy(true);
    try {
      await ink.save();
      const result = await apiRequest<{ gallery: GalleryContents }>("/api/gallery/photos/ink", { method: "POST", body: JSON.stringify({ id: photoId, action: "flatten" }) });
      setConfirmFlatten(false);
      onEdited(result.gallery);
    } finally {
      setBusy(false);
    }
  };

  const hasInk = ink.strokes.length > 0;
  return (
    <>
      {ink.loaded && photo ? (
        <InkSurface
          frame={ink.frame}
          viewSize={photo.viewSize}
          matrix={matrix}
          strokes={ink.strokes}
          tools={tools}
          enabled={drawing && !photo.changed}
          mouseDraws={drawing}
          onChange={ink.change}
          onPan={onPan}
          className={photo.changed ? "is-stale" : undefined}
          style={{ pointerEvents: drawing ? "auto" : "none" }}
        />
      ) : null}
      {photo?.changed && hasInk ? (
        <div className="libera-photo-ink-notice" role="alert">
          <span>This photo changed outside Libera since it was drawn on. The ink may no longer line up.</span>
          <button type="button" disabled={busy} onClick={() => void resolve("keep")}>Keep ink</button>
          <button type="button" disabled={busy} onClick={() => void resolve("discard")}>Discard ink</button>
        </div>
      ) : null}
      {drawing && toolbarSlot ? createPortal(
        // React bubbles portal events to the zoomable stage, which would pan or zoom the photo.
        <span className="libera-photo-ink-tools" onPointerDown={halt} onPointerMove={halt} onPointerUp={halt} onPointerCancel={halt} onDoubleClick={halt}>
          <InkToolbar canUndo={ink.canUndo} canRedo={ink.canRedo} onUndo={ink.undo} onRedo={ink.redo} />
          <span className="libera-photo-ink-actions" role="group" aria-label="Save ink">
            <button type="button" className="libera-photo-ink-action is-primary" disabled={!unsaved || busy} title="Save the ink (Ctrl+S)" onClick={() => { void ink.save().catch(() => undefined); }}>
              {unsaved ? <Save aria-hidden className="h-3.5 w-3.5" /> : <Check aria-hidden className="h-3.5 w-3.5" />}
              {unsaved ? "Save" : "Saved"}
            </button>
            <button type="button" className="libera-photo-ink-action" disabled={!hasInk || busy} title="Save the ink, then download a copy of the photo with the ink drawn on it"
              onClick={() => { void ink.save().then(() => downloadImage({ name: "photo-with-ink", src: `/api/gallery/photos/ink/export?id=${encodeURIComponent(photoId)}` }), () => undefined); }}>
              <Download aria-hidden className="h-3.5 w-3.5" />
              Save with ink
            </button>
            {confirmFlatten ? (
              <>
                <button type="button" className="libera-photo-ink-action is-danger" disabled={busy} onClick={() => void flatten()}>
                  <Layers aria-hidden className="h-3.5 w-3.5" />
                  Draw into photo
                </button>
                <button type="button" className="libera-photo-ink-action" disabled={busy} onClick={() => setConfirmFlatten(false)}>
                  <X aria-hidden className="h-3.5 w-3.5" />
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="libera-photo-ink-action" disabled={!hasInk || busy || photo?.changed} title="Draw the ink into the photo itself; Revert in Info brings back the photo without it"
                onClick={() => setConfirmFlatten(true)}>
                <Layers aria-hidden className="h-3.5 w-3.5" />
                Flatten…
              </button>
            )}
          </span>
        </span>,
        toolbarSlot,
      ) : null}
      {drawing && ink.error ? <p className="libera-photo-ink-error" role="status">{ink.error}</p> : null}
    </>
  );
}
