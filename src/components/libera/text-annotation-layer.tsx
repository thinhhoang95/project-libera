"use client";

import { GripHorizontal, PencilLine, X } from "lucide-react";
import type { CSSProperties, PointerEvent, MouseEvent as ReactMouseEvent, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  PdfNoteEditor,
  type NoteCaret,
  type PdfNoteEditorHandle,
} from "@/components/libera/pdf-note-editor";
import { renderAnnotationMarkdown } from "@/lib/pdf-annotation-markdown";
import { DEFAULT_PDF_TEXT_COLOR, pdfTextFontStack } from "@/lib/pdf-annotation-style";
import type { PdfAnnotationRect, PdfTextAnnotation } from "@/lib/types";

export const DEFAULT_TEXT_ANNOTATION_FONT_SIZE = 10;
export const MIN_TEXT_ANNOTATION_FONT_SIZE = 4;
export const MAX_TEXT_ANNOTATION_FONT_SIZE = 72;
const MIN_TEXT_BOX_WIDTH = 0.03;
const MIN_TEXT_BOX_HEIGHT = 0.02;
const NOTE_LINE_HEIGHT = 1.35;
// Pointer travel (px) before a press on a note becomes a move instead of a click.
const DRAG_THRESHOLD_PX = 3;
/** Marks annotation chrome that must not count as "clicked outside". */
export const ANNOTATION_UI_SELECTOR = "[data-pdf-annotation-id], [data-pdf-annotation-ui]";

export type AnnotationSurfaceSize = {
  width: number;
  height: number;
};

type DraftTextBox = {
  startX: number;
  startY: number;
  rect: PdfAnnotationRect;
};

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

type Gesture = {
  caret: NoteCaret;
  handle?: ResizeHandle;
  id: string;
  mode: "move" | "resize";
  moved: boolean;
  startClient: { x: number; y: number };
  startRect: PdfAnnotationRect;
  wasSelected: boolean;
};

type TextAnnotationLayerProps = {
  annotations: PdfTextAnnotation[];
  /** Resolves relative image paths inside Markdown notes. */
  documentPath?: string;
  drawing: boolean;
  interactive: boolean;
  /** Font size (unscaled) used to size a note placed with a single click. */
  newAnnotationFontSize?: number;
  pageSize: AnnotationSurfaceSize;
  selectedAnnotationId: string;
  textScale?: number;
  /** Returns the new annotation's id so it opens straight into editing. */
  onAddAnnotation: (rect: PdfAnnotationRect) => string | void;
  onDeleteAnnotation: (id: string) => void;
  /** Called when a drawn note is placed, so the host can return to its select tool. */
  onExitTextEditing: () => void;
  onSelectAnnotation: (annotation: PdfTextAnnotation) => void;
  onUpdateAnnotation: (id: string, patch: Partial<PdfTextAnnotation>) => void;
};

type NoteHandlers = {
  beginGesture: (
    event: PointerEvent<HTMLElement>,
    annotation: PdfTextAnnotation,
    mode: Gesture["mode"],
    handle?: ResizeHandle,
  ) => void;
  endGesture: (event: PointerEvent<HTMLElement>) => void;
  moveGesture: (event: PointerEvent<HTMLElement>) => void;
  startEditing: (id: string, caret?: NoteCaret) => void;
  stopEditing: () => void;
  updateText: (id: string, markdown: string) => void;
};

const RESIZE_HANDLES: { handle: ResizeHandle; label: string }[] = [
  { handle: "nw", label: "Resize text annotation from top left" },
  { handle: "n", label: "Resize text annotation from top" },
  { handle: "ne", label: "Resize text annotation from top right" },
  { handle: "e", label: "Resize text annotation from right" },
  { handle: "se", label: "Resize text annotation from bottom right" },
  { handle: "s", label: "Resize text annotation from bottom" },
  { handle: "sw", label: "Resize text annotation from bottom left" },
  { handle: "w", label: "Resize text annotation from left" },
];

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function createAnnotationId() {
  return globalThis.crypto?.randomUUID?.() ?? `annotation-${Date.now()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeRect(rect: PdfAnnotationRect): PdfAnnotationRect {
  const x = clamp(rect.x, 0, 0.999);
  const y = clamp(rect.y, 0, 0.999);
  const width = clamp(rect.width, 0.001, 1 - x);
  const height = clamp(rect.height, 0.001, 1 - y);

  return {
    x,
    y,
    width,
    height,
  };
}

export function rectStyle(rect: PdfAnnotationRect, size: AnnotationSurfaceSize) {
  return {
    left: `${rect.x * size.width}px`,
    top: `${rect.y * size.height}px`,
    width: `${rect.width * size.width}px`,
    height: `${rect.height * size.height}px`,
  };
}

function rectFromPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): PdfAnnotationRect {
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
): { x: number; y: number } {
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
  };
}

function moveRect(
  rect: PdfAnnotationRect,
  deltaX: number,
  deltaY: number,
): PdfAnnotationRect {
  return {
    x: clamp(rect.x + deltaX, 0, 1 - rect.width),
    y: clamp(rect.y + deltaY, 0, 1 - rect.height),
    width: rect.width,
    height: rect.height,
  };
}

function resizeRect(
  rect: PdfAnnotationRect,
  handle: ResizeHandle,
  deltaX: number,
  deltaY: number,
): PdfAnnotationRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes("w")) {
    left = clamp(rect.x + deltaX, 0, right - MIN_TEXT_BOX_WIDTH);
  }

  if (handle.includes("e")) {
    right = clamp(rect.x + rect.width + deltaX, left + MIN_TEXT_BOX_WIDTH, 1);
  }

  if (handle.includes("n")) {
    top = clamp(rect.y + deltaY, 0, bottom - MIN_TEXT_BOX_HEIGHT);
  }

  if (handle.includes("s")) {
    bottom = clamp(rect.y + rect.height + deltaY, top + MIN_TEXT_BOX_HEIGHT, 1);
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/**
 * One shared observer flags notes whose Markdown is taller than their box.
 * It writes a data attribute straight to the DOM: detecting overflow never
 * re-renders React, and observer callbacks arrive after layout, batched.
 */
let overflowObserver: ResizeObserver | null = null;

function updateOverflow(notes: Iterable<HTMLElement>) {
  const measured: [HTMLElement, boolean][] = [];

  for (const note of notes) {
    const body = note.querySelector<HTMLElement>(".pdf-note-body");

    if (body) {
      measured.push([note, body.scrollHeight > body.clientHeight + 1]);
    }
  }

  // Read everything first, then write, so the checks share one layout.
  for (const [note, overflowing] of measured) {
    note.toggleAttribute("data-overflowing", overflowing);
  }
}

function observeNoteOverflow(note: HTMLElement) {
  if (typeof ResizeObserver === "undefined") {
    return () => undefined;
  }

  overflowObserver ??= new ResizeObserver((entries) => {
    const notes = new Set<HTMLElement>();

    for (const entry of entries) {
      const note = entry.target.closest<HTMLElement>(".pdf-note");

      if (note) {
        notes.add(note);
      }
    }

    updateOverflow(notes);
  });

  const targets = [note.querySelector(".pdf-note-body"), note.querySelector(".pdf-note-content")]
    .filter((target): target is Element => Boolean(target));

  targets.forEach((target) => overflowObserver?.observe(target));

  return () => targets.forEach((target) => overflowObserver?.unobserve(target));
}

function noteTypography(annotation: PdfTextAnnotation, textScale: number): CSSProperties {
  return {
    color: annotation.color ?? DEFAULT_PDF_TEXT_COLOR,
    fontFamily: pdfTextFontStack(annotation.fontFamily),
    fontSize: `${annotation.fontSize * textScale}px`,
    lineHeight: NOTE_LINE_HEIGHT,
  };
}

const NoteMarkdown = memo(function NoteMarkdown({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderAnnotationMarkdown(markdown), [markdown]);

  return <div className="pdf-note-content" dangerouslySetInnerHTML={{ __html: html }} />;
});

const TextAnnotationNote = memo(function TextAnnotationNote({
  annotation,
  documentPath,
  editing,
  editCaret,
  editorHandleRef,
  handlers,
  interactive,
  pageSize,
  rect,
  selected,
  textScale,
}: {
  annotation: PdfTextAnnotation;
  documentPath: string;
  editing: boolean;
  editCaret?: NoteCaret;
  editorHandleRef: RefObject<PdfNoteEditorHandle | null>;
  handlers: NoteHandlers;
  interactive: boolean;
  pageSize: AnnotationSurfaceSize;
  rect: PdfAnnotationRect;
  selected: boolean;
  textScale: number;
}) {
  const noteRef = useRef<HTMLDivElement>(null);

  // Re-attach when the content element is swapped (resting HTML ↔ editor).
  useLayoutEffect(() => {
    const note = noteRef.current;

    return note ? observeNoteOverflow(note) : undefined;
  }, [editing]);

  const updateText = useCallback(
    (markdown: string) => handlers.updateText(annotation.id, markdown),
    [annotation.id, handlers],
  );

  function handleResizePointerDown(event: PointerEvent<HTMLElement>, handle: ResizeHandle) {
    event.stopPropagation();
    handlers.beginGesture(event, annotation, "resize", handle);
  }

  return (
    <div
      ref={noteRef}
      className="pdf-note"
      data-editing={editing || undefined}
      data-empty={!annotation.text.trim() || undefined}
      data-interactive={interactive || undefined}
      data-pdf-annotation-id={annotation.id}
      data-selected={selected || undefined}
      style={{ ...rectStyle(rect, pageSize), ...noteTypography(annotation, textScale) }}
      onPointerDown={(event) => {
        if (!editing) {
          handlers.beginGesture(event, annotation, "move");
        }
      }}
      onPointerMove={handlers.moveGesture}
      onPointerUp={handlers.endGesture}
      onPointerCancel={handlers.endGesture}
      onDoubleClick={(event) => {
        if (interactive && !editing) {
          handlers.startEditing(annotation.id, { x: event.clientX, y: event.clientY });
        }
      }}
    >
      <div className="pdf-note-body">
        {editing ? (
          <PdfNoteEditor
            caret={editCaret}
            documentPath={documentPath}
            handleRef={editorHandleRef}
            initialMarkdown={annotation.text}
            onChange={updateText}
            onEscape={handlers.stopEditing}
          />
        ) : (
          <NoteMarkdown markdown={annotation.text} />
        )}
      </div>

      {selected && interactive ? (
        <>
          <button
            aria-label="Move text annotation"
            className="pdf-note-grip"
            data-pdf-annotation-ui
            title="Drag to move"
            type="button"
            onPointerDown={(event) => {
              event.stopPropagation();
              handlers.beginGesture(event, annotation, "move");
            }}
          >
            <GripHorizontal aria-hidden className="h-3 w-3" />
          </button>
          {RESIZE_HANDLES.map(({ handle, label }) => (
            <button
              key={handle}
              aria-label={label}
              className="pdf-note-handle"
              data-handle={handle}
              title={label}
              type="button"
              onPointerDown={(event) => handleResizePointerDown(event, handle)}
            />
          ))}
        </>
      ) : null}
    </div>
  );
});

function NoteReader({
  annotation,
  pageSize,
  textScale,
  onClose,
  onEdit,
}: {
  annotation: PdfTextAnnotation;
  pageSize: AnnotationSurfaceSize;
  textScale: number;
  onClose: () => void;
  onEdit: () => void;
}) {
  const margin = 8;
  const left = annotation.rect.x * pageSize.width;
  const width = Math.min(
    Math.max(annotation.rect.width * pageSize.width, 280),
    Math.max(160, pageSize.width - margin * 2),
  );
  const clampedLeft = clamp(left, margin, Math.max(margin, pageSize.width - width - margin));
  const top = clamp(
    annotation.rect.y * pageSize.height,
    margin,
    Math.max(margin, pageSize.height - 220),
  );
  const typography = noteTypography(annotation, textScale);

  return (
    <div
      className="pdf-note-reader"
      data-pdf-annotation-ui
      role="dialog"
      aria-label="Text annotation"
      style={{ left: clampedLeft, top, width, maxHeight: Math.max(160, pageSize.height - top - margin) }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={onEdit}
    >
      <div className="pdf-note-reader-actions">
        <button type="button" aria-label="Edit note" title="Edit note" onClick={onEdit}>
          <PencilLine aria-hidden className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label="Collapse note" title="Collapse (Esc)" onClick={onClose}>
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="pdf-note-reader-body"
        style={{
          color: typography.color,
          fontFamily: typography.fontFamily,
          // Comfortable reading size even for tiny margin notes.
          fontSize: `${Math.max(annotation.fontSize * textScale, 13)}px`,
          lineHeight: 1.5,
        }}
      >
        <NoteMarkdown markdown={annotation.text} />
      </div>
    </div>
  );
}

export function TextAnnotationLayer({
  annotations,
  documentPath = "",
  drawing,
  interactive,
  newAnnotationFontSize = DEFAULT_TEXT_ANNOTATION_FONT_SIZE,
  pageSize,
  selectedAnnotationId,
  textScale = 1,
  onAddAnnotation,
  onDeleteAnnotation,
  onExitTextEditing,
  onSelectAnnotation,
  onUpdateAnnotation,
}: TextAnnotationLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<DraftTextBox | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const editorHandleRef = useRef<PdfNoteEditorHandle | null>(null);
  const [draftTextBox, setDraftTextBox] = useState<DraftTextBox | null>(null);
  const [editing, setEditing] = useState<{ caret?: NoteCaret; id: string } | null>(null);
  const [expandedId, setExpandedId] = useState("");
  // Rect of the note being dragged; committed to the host only on release so
  // a drag re-renders this layer instead of the whole viewer.
  const [transient, setTransient] = useState<{ id: string; rect: PdfAnnotationRect } | null>(null);
  const transientRef = useRef<{ id: string; rect: PdfAnnotationRect } | null>(null);
  const latestRef = useRef({
    annotations,
    editing,
    interactive,
    onDeleteAnnotation,
    onSelectAnnotation,
    onUpdateAnnotation,
    selectedAnnotationId,
  });

  useLayoutEffect(() => {
    latestRef.current = {
      annotations,
      editing,
      interactive,
      onDeleteAnnotation,
      onSelectAnnotation,
      onUpdateAnnotation,
      selectedAnnotationId,
    };
  });

  const handlers = useMemo<NoteHandlers>(() => {
    function findAnnotation(id: string) {
      return latestRef.current.annotations.find((annotation) => annotation.id === id);
    }

    function stopEditing() {
      const current = latestRef.current.editing;

      if (!current) {
        return;
      }

      const annotation = findAnnotation(current.id);
      const markdown = editorHandleRef.current?.getMarkdown() ?? annotation?.text ?? "";

      if (annotation) {
        // A note left empty is discarded, like an abandoned text box.
        if (!markdown.trim()) {
          latestRef.current.onDeleteAnnotation(annotation.id);
        } else if (markdown !== annotation.text) {
          latestRef.current.onUpdateAnnotation(annotation.id, { text: markdown });
        }
      }

      setEditing(null);
    }

    return {
      beginGesture(event, annotation, mode, handle) {
        if (!latestRef.current.interactive || event.button !== 0 || !layerRef.current) {
          return;
        }

        const wasSelected = latestRef.current.selectedAnnotationId === annotation.id;

        event.currentTarget.setPointerCapture(event.pointerId);
        gestureRef.current = {
          caret: { x: event.clientX, y: event.clientY },
          handle,
          id: annotation.id,
          mode,
          moved: false,
          startClient: { x: event.clientX, y: event.clientY },
          startRect: annotation.rect,
          wasSelected,
        };

        if (!wasSelected) {
          latestRef.current.onSelectAnnotation(annotation);
        }
      },
      moveGesture(event) {
        const gesture = gestureRef.current;
        const layer = layerRef.current;

        if (!gesture || !layer) {
          return;
        }

        const dx = event.clientX - gesture.startClient.x;
        const dy = event.clientY - gesture.startClient.y;

        if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
          return;
        }

        gesture.moved = true;
        const bounds = layer.getBoundingClientRect();
        const deltaX = bounds.width ? dx / bounds.width : 0;
        const deltaY = bounds.height ? dy / bounds.height : 0;

        transientRef.current = {
          id: gesture.id,
          rect:
            gesture.mode === "move"
              ? moveRect(gesture.startRect, deltaX, deltaY)
              : resizeRect(gesture.startRect, gesture.handle ?? "se", deltaX, deltaY),
        };
        setTransient(transientRef.current);
      },
      endGesture(event) {
        const gesture = gestureRef.current;

        if (!gesture) {
          return;
        }

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }

        gestureRef.current = null;

        if (gesture.moved) {
          const moved = transientRef.current;

          transientRef.current = null;
          setTransient(null);

          if (moved?.id === gesture.id) {
            latestRef.current.onUpdateAnnotation(gesture.id, { rect: moved.rect });
          }

          return;
        }

        if (gesture.mode !== "move" || event.type === "pointercancel") {
          return;
        }

        // A plain click: first click selects (and opens a clipped note for
        // reading), clicking a selected note starts typing where it landed.
        const note = event.currentTarget.closest<HTMLElement>(".pdf-note");

        if (gesture.wasSelected && latestRef.current.editing?.id !== gesture.id) {
          setExpandedId("");
          setEditing({ caret: gesture.caret, id: gesture.id });
        } else if (note?.hasAttribute("data-overflowing")) {
          setExpandedId(gesture.id);
        }
      },
      startEditing(id, caret) {
        setExpandedId("");
        setEditing({ caret, id });
      },
      stopEditing,
      updateText(id, markdown) {
        const annotation = findAnnotation(id);

        if (annotation && annotation.text !== markdown) {
          latestRef.current.onUpdateAnnotation(id, { text: markdown });
        }
      },
    };
  }, []);

  // Selecting something else, or switching to a non-interactive tool, ends
  // editing and closes the reader — "click elsewhere" and Esc both route here
  // through the host's selection.
  useEffect(() => {
    if (editing && (!interactive || selectedAnnotationId !== editing.id)) {
      handlers.stopEditing();
    }
  }, [editing, handlers, interactive, selectedAnnotationId]);

  const [expandedFor, setExpandedFor] = useState(selectedAnnotationId);

  if (expandedFor !== selectedAnnotationId) {
    setExpandedFor(selectedAnnotationId);

    if (expandedId && expandedId !== selectedAnnotationId) {
      setExpandedId("");
    }
  }

  const expandedAnnotation =
    interactive && expandedId && !editing
      ? annotations.find((annotation) => annotation.id === expandedId)
      : undefined;

  useEffect(() => {
    if (!expandedAnnotation) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Collapse first; the next Esc clears the selection in the host.
        event.preventDefault();
        setExpandedId("");
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [expandedAnnotation]);

  function startTextBox(event: PointerEvent<HTMLDivElement>) {
    if (!drawing || event.button !== 0) {
      return;
    }

    event.preventDefault();
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

    event.currentTarget.setPointerCapture(event.pointerId);
    draftRef.current = draft;
    setDraftTextBox(draft);
  }

  function updateTextBox(event: PointerEvent<HTMLDivElement>) {
    if (!draftRef.current) {
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
    setDraftTextBox(nextDraft);
  }

  function finishTextBox(event: PointerEvent<HTMLDivElement>) {
    const draft = draftRef.current;

    if (!draft) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    draftRef.current = null;
    setDraftTextBox(null);

    if (event.type === "pointercancel") {
      return;
    }

    const widthPx = draft.rect.width * pageSize.width;
    const heightPx = draft.rect.height * pageSize.height;
    let rect = draft.rect;

    if (widthPx < 12 || heightPx < 8) {
      // A click places a comfortable three-line note at the pointer.
      const lineHeight = newAnnotationFontSize * textScale * NOTE_LINE_HEIGHT;
      const width = pageSize.width ? Math.max(0.12, 220 * textScale / pageSize.width) : 0.3;
      const height = pageSize.height ? (lineHeight * 3 + 6) / pageSize.height : 0.06;

      rect = normalizeRect({
        x: clamp(draft.startX, 0, 1 - Math.min(width, 1)),
        y: clamp(draft.startY - (lineHeight * 0.6) / Math.max(pageSize.height, 1), 0, 1 - Math.min(height, 1)),
        width: Math.min(width, 1),
        height: Math.min(height, 1),
      });
    }

    const id = onAddAnnotation(rect);

    if (id) {
      setExpandedId("");
      setEditing({ id });
    }

    onExitTextEditing();
  }

  return (
    <>
      <div
        className={`absolute inset-0 z-20 ${
          drawing ? "pdf-note-draw-surface" : "pointer-events-none"
        }`}
        onPointerCancel={finishTextBox}
        onPointerDown={startTextBox}
        onPointerMove={updateTextBox}
        onPointerUp={finishTextBox}
      >
        {draftTextBox ? (
          <div className="pdf-note-draft" style={rectStyle(draftTextBox.rect, pageSize)} />
        ) : null}
      </div>

      <div ref={layerRef} className="pointer-events-none absolute inset-0 z-30">
        {annotations.map((annotation) => (
          <TextAnnotationNote
            key={annotation.id}
            annotation={annotation}
            documentPath={documentPath}
            editing={editing?.id === annotation.id}
            editCaret={editing?.id === annotation.id ? editing.caret : undefined}
            editorHandleRef={editorHandleRef}
            handlers={handlers}
            interactive={interactive}
            pageSize={pageSize}
            rect={transient?.id === annotation.id ? transient.rect : annotation.rect}
            selected={selectedAnnotationId === annotation.id}
            textScale={textScale}
          />
        ))}

        {expandedAnnotation ? (
          <NoteReader
            annotation={expandedAnnotation}
            pageSize={pageSize}
            textScale={textScale}
            onClose={() => setExpandedId("")}
            onEdit={() => handlers.startEditing(expandedAnnotation.id)}
          />
        ) : null}
      </div>
    </>
  );
}

/** Prevents a toolbar press from stealing focus from the note being edited. */
export function keepEditorFocus(event: ReactMouseEvent<HTMLElement>) {
  if ((event.target as HTMLElement).closest("button")) {
    event.preventDefault();
  }
}
