"use client";

import { createPortal } from "react-dom";
import { InkSurface } from "./ink-surface";
import { InkToolbar } from "./ink-toolbar";
import { useInkDocument } from "./use-ink-document";
import { useInkTools } from "./use-ink-tools";

/*
 * Ink on a notebook image (docs/ink-plan.md, "Notebook images"): one chunk,
 * `image`, in the image's own pixels (EXIF upright, as the browser shows it),
 * over the image inside the viewer's zoomed frame. It takes input only while
 * the viewer's Draw tool is on; the toolbox goes in the viewer's toolbar.
 */

export function ImageInkLayer({ filePath, naturalSize, drawing, zoom, toolbarSlot, onPan }: {
  filePath: string;
  naturalSize: { width: number; height: number };
  /** The viewer's Draw tool is on. */
  drawing: boolean;
  zoom: number;
  /** Where the toolbox goes while drawing. */
  toolbarSlot: HTMLElement | null;
  onPan: (dx: number, dy: number) => void;
}) {
  const ink = useInkDocument({ path: filePath, chunk: "image", frame: { unit: "px", width: naturalSize.width, height: naturalSize.height } });
  const tools = useInkTools();
  return (
    <>
      {ink.loaded ? (
        <InkSurface
          frame={ink.frame}
          viewSize={naturalSize}
          zoom={zoom}
          strokes={ink.strokes}
          tools={tools}
          enabled={drawing}
          mouseDraws={drawing}
          onChange={ink.change}
          onPan={onPan}
          // Away from Draw, presses go to the viewer (pan, notes) as before.
          style={{ pointerEvents: drawing ? "auto" : "none" }}
        />
      ) : null}
      {drawing && toolbarSlot ? createPortal(<InkToolbar canUndo={ink.canUndo} canRedo={ink.canRedo} onUndo={ink.undo} onRedo={ink.redo} />, toolbarSlot) : null}
      {drawing && ink.error ? <p className="libera-ink-image-error" role="status">{ink.error}</p> : null}
    </>
  );
}
