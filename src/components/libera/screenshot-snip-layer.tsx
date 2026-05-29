"use client";

import { Loader2, X } from "lucide-react";
import type { PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { PdfAnnotationRect } from "@/lib/types";
import {
  clamp,
  normalizeRect,
  rectStyle,
  type AnnotationSurfaceSize,
} from "@/components/libera/text-annotation-layer";

type DraftSnip = {
  rect: PdfAnnotationRect;
  startX: number;
  startY: number;
};

type ScreenshotSnipLayerProps = {
  active: boolean;
  pageSize: AnnotationSurfaceSize;
  onCancel: () => void;
  onCapture: (rect: PdfAnnotationRect) => Promise<void>;
};

const MIN_SNIP_SIZE_PX = 6;

function rectFromPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
) {
  return normalizeRect({
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  });
}

function getPointerPosition(
  event: PointerEvent<HTMLElement>,
  bounds: DOMRect,
) {
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
  };
}

export function ScreenshotSnipLayer({
  active,
  pageSize,
  onCancel,
  onCapture,
}: ScreenshotSnipLayerProps) {
  const draftRef = useRef<DraftSnip | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [draftSnip, setDraftSnip] = useState<DraftSnip | null>(null);

  useEffect(() => {
    if (!active) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      onCancel();
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, onCancel]);

  if (!active) {
    return null;
  }

  function startSnip(event: PointerEvent<HTMLDivElement>) {
    if (capturing || event.button !== 0) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const start = getPointerPosition(event, bounds);
    const draft = {
      startX: start.x,
      startY: start.y,
      rect: {
        x: start.x,
        y: start.y,
        width: 0.001,
        height: 0.001,
      },
    };

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draftRef.current = draft;
    setDraftSnip(draft);
  }

  function updateSnip(event: PointerEvent<HTMLDivElement>) {
    if (!draftRef.current || capturing) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const current = getPointerPosition(event, bounds);
    const nextDraft = {
      ...draftRef.current,
      rect: rectFromPoints(
        draftRef.current.startX,
        draftRef.current.startY,
        current.x,
        current.y,
      ),
    };

    draftRef.current = nextDraft;
    setDraftSnip(nextDraft);
  }

  async function finishSnip(event: PointerEvent<HTMLDivElement>) {
    const draft = draftRef.current;

    if (!draft) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    draftRef.current = null;
    setDraftSnip(null);

    if (
      draft.rect.width * pageSize.width < MIN_SNIP_SIZE_PX ||
      draft.rect.height * pageSize.height < MIN_SNIP_SIZE_PX
    ) {
      return;
    }

    setCapturing(true);

    try {
      await onCapture(draft.rect);
    } finally {
      setCapturing(false);
    }
  }

  return (
    <div
      className="absolute inset-0 z-50 cursor-crosshair bg-zinc-950/5"
      onPointerCancel={finishSnip}
      onPointerDown={startSnip}
      onPointerMove={updateSnip}
      onPointerUp={finishSnip}
    >
      <button
        aria-label="Cancel snip"
        className="absolute right-2 top-2 z-20 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/50 bg-zinc-950/75 text-white shadow-sm hover:bg-zinc-900"
        type="button"
        title="Cancel snip"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onCancel}
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
      {draftSnip ? (
        <div
          className="absolute border-2 border-white bg-accent/20 shadow-[0_0_0_9999px_rgba(9,9,11,0.25)] ring-1 ring-accent"
          style={rectStyle(draftSnip.rect, pageSize)}
        />
      ) : null}
      {capturing ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/45 text-foreground">
          <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
        </div>
      ) : null}
    </div>
  );
}
