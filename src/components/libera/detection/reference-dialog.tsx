"use client";

import { Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { DEFAULT_LAYERS, DetectionCanvas } from "@/components/libera/detection/detection-canvas";
import { cropThumbnail, downscaleReference, loadImage } from "@/components/libera/detection/detection-client";
import type { Box, VisualPrompt } from "@/lib/detection/results";

const EMPTY_COLORS = new Map<string, string>();

/**
 * Turns an uploaded image into a visual prompt: draw one or more boxes around
 * examples of the object, or use the whole image when it shows just the object.
 */
export function ReferenceDialog({ file, color, onCancel, onAdd }: {
  file: File | null;
  color: string;
  onCancel: () => void;
  onAdd: (prompt: Omit<VisualPrompt, "id">) => void;
}) {
  const [reference, setReference] = useState<{ dataUrl: string; width: number; height: number; image: HTMLImageElement } | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file) return;
    let canceled = false;
    const url = URL.createObjectURL(file);
    loadImage(url).then(async (original) => {
      const scaled = downscaleReference(original);
      const image = await loadImage(scaled.dataUrl);
      if (canceled) return;
      setReference({ ...scaled, image });
      setBoxes([]);
      setLabel(file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 60));
      setError("");
    }, () => !canceled && setError("Could not read this image. Use a JPEG, PNG or WebP file.")).finally(() => URL.revokeObjectURL(url));
    return () => { canceled = true; };
  }, [file]);

  function add(useWholeImage: boolean) {
    if (!reference || !file) return;
    const chosen: Box[] = useWholeImage ? [[0, 0, reference.width, reference.height]] : boxes;
    if (!chosen.length) return;
    onAdd({
      type: "visual",
      label: label.trim() || "reference",
      color,
      source: "upload",
      name: file.name,
      width: reference.width,
      height: reference.height,
      boxes: chosen,
      thumbnail: cropThumbnail(reference.image, chosen[0]),
      reference: reference.dataUrl,
    });
  }

  const buttonClass = "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted disabled:opacity-40";
  const primaryClass = "inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40";

  return (
    <ModalDialog
      open={Boolean(file)}
      title="Reference image"
      description="Draw a box around each example of the object to find. More examples make a steadier prompt."
      panelClassName="max-w-3xl"
      onClose={onCancel}
      footer={(
        <>
          <button type="button" className={buttonClass} disabled={!reference} onClick={() => add(true)}>Use whole image</button>
          <button type="button" className={primaryClass} disabled={!boxes.length} onClick={() => add(false)}>
            Add prompt{boxes.length ? ` (${boxes.length} ${boxes.length === 1 ? "example" : "examples"})` : ""}
          </button>
        </>
      )}
    >
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <label className="flex-1 space-y-1 text-sm">
            <span className="text-xs text-muted-foreground">Label</span>
            <input className="w-full rounded-md border border-input bg-background px-2.5 py-1.5" value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <button type="button" className={buttonClass} disabled={!boxes.length} onClick={() => setBoxes((current) => current.slice(0, -1))}>
            <Undo2 aria-hidden className="h-4 w-4" /> Undo box
          </button>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex h-[55vh] overflow-hidden rounded-lg border border-border">
          {reference ? (
            <DetectionCanvas
              src={reference.dataUrl}
              width={reference.width}
              height={reference.height}
              detections={[]}
              colors={EMPTY_COLORS}
              layers={DEFAULT_LAYERS}
              quadrats={null}
              examples={boxes.map((box, index) => ({ box, color, label: `${index + 1}` }))}
              hoverId={null}
              selectedId={null}
              mode="draw"
              onNaturalSize={() => undefined}
              onHover={() => undefined}
              onSelect={() => undefined}
              onBox={(box) => setBoxes((current) => [...current, box])}
              onLine={() => undefined}
            />
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
}
