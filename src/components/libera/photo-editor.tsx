"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Crop, FlipHorizontal2, FlipVertical2, Loader2, RotateCcw, RotateCcwSquare, RotateCwSquare, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { apiRequest } from "@/components/libera/api-client";
import { galleryRawUrl, type GalleryContents, type GalleryPhoto } from "@/lib/image-generation";
import {
  ADJUSTMENT_CONTROLS,
  CROP_ASPECTS,
  FILTER_PRESETS,
  NO_ADJUSTMENTS,
  NO_EDITS,
  VIGNETTE_START,
  colorMatrix,
  cropPixels,
  flipCrop,
  hasEdits,
  orientedSize,
  rotateCropClockwise,
  rotateCropCounterClockwise,
  toneCurve,
  vignetteOpacity,
  type CropRect,
  type PhotoAdjustments,
  type PhotoEdits,
} from "@/lib/photo-edits";

type EditorTab = "crop" | "adjust" | "filters";
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** The preview is drawn at most this large; saving always uses the full photo. */
const PREVIEW_EDGE = 2400;
const MIN_CROP = 0.04;
const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };
const panelButton = "inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10 disabled:opacity-40";

function safeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function sameAdjustments(first: PhotoAdjustments, second: PhotoAdjustments) {
  return ADJUSTMENT_CONTROLS.every((control) => first[control.key] === second[control.key]);
}

/** The editor's preview filter: the same tone curve and color matrix the server applies. */
function AdjustmentFilter({ id, adjustments }: { id: string; adjustments: PhotoAdjustments }) {
  const { slope, intercept } = toneCurve(adjustments);
  const matrix = colorMatrix(adjustments);
  const values = [...matrix[0], 0, 0, ...matrix[1], 0, 0, ...matrix[2], 0, 0, 0, 0, 0, 1, 0].map((value) => value.toFixed(5)).join(" ");
  return <filter id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
    <feComponentTransfer>
      <feFuncR type="linear" slope={slope} intercept={intercept} />
      <feFuncG type="linear" slope={slope} intercept={intercept} />
      <feFuncB type="linear" slope={slope} intercept={intercept} />
    </feComponentTransfer>
    <feColorMatrix type="matrix" values={values} />
  </filter>;
}

function vignetteStyle(adjustments: PhotoAdjustments): CSSProperties | undefined {
  const opacity = vignetteOpacity(adjustments);
  if (!opacity) return undefined;
  return { background: `radial-gradient(ellipse 70.71% 70.71% at 50% 50%, rgba(0,0,0,0) ${VIGNETTE_START * 100}%, rgba(0,0,0,${opacity.toFixed(3)}) 100%)` };
}

/** Largest centered crop with a normalized width/height ratio. */
function fitAspect(normalizedRatio: number): CropRect {
  let width = Math.min(1, normalizedRatio);
  let height = width / normalizedRatio;
  if (height > 1) { height = 1; width = normalizedRatio; }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

function CropOverlay({ crop, ratio, onChange }: { crop: CropRect; ratio: number | null; onChange: (crop: CropRect) => void }) {
  const dragRef = useRef<{ handle: Handle; start: CropRect; x: number; y: number; bounds: DOMRect } | null>(null);
  const handles: Handle[] = ratio ? ["nw", "ne", "sw", "se"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  function begin(handle: Handle, event: ReactPointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.closest("[data-crop-frame]")?.getBoundingClientRect();
    if (!bounds || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { handle, start: crop, x: event.clientX, y: event.clientY, bounds };
  }

  function move(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.x) / drag.bounds.width;
    const dy = (event.clientY - drag.y) / drag.bounds.height;
    const { start, handle } = drag;
    if (handle === "move") {
      onChange({ ...start, x: Math.min(1 - start.width, Math.max(0, start.x + dx)), y: Math.min(1 - start.height, Math.max(0, start.y + dy)) });
      return;
    }
    if (ratio) {
      const signX = handle.includes("e") ? 1 : -1;
      const signY = handle.includes("s") ? 1 : -1;
      const anchorX = signX > 0 ? start.x : start.x + start.width;
      const anchorY = signY > 0 ? start.y : start.y + start.height;
      const maxWidth = Math.min(signX > 0 ? 1 - anchorX : anchorX, (signY > 0 ? 1 - anchorY : anchorY) * ratio);
      let width = Math.max(start.width + signX * dx, (start.height + signY * dy) * ratio);
      width = Math.min(maxWidth, Math.max(MIN_CROP, width));
      const height = width / ratio;
      onChange({ x: signX > 0 ? anchorX : anchorX - width, y: signY > 0 ? anchorY : anchorY - height, width, height });
      return;
    }
    let { x, y, width, height } = start;
    if (handle.includes("w")) { x = Math.min(start.x + start.width - MIN_CROP, Math.max(0, start.x + dx)); width = start.x + start.width - x; }
    if (handle.includes("e")) width = Math.min(1 - start.x, Math.max(MIN_CROP, start.width + dx));
    if (handle.includes("n")) { y = Math.min(start.y + start.height - MIN_CROP, Math.max(0, start.y + dy)); height = start.y + start.height - y; }
    if (handle.includes("s")) height = Math.min(1 - start.y, Math.max(MIN_CROP, start.height + dy));
    onChange({ x, y, width, height });
  }

  const handlePosition: Record<Exclude<Handle, "move">, string> = {
    nw: "-left-1.5 -top-1.5 cursor-nwse-resize", ne: "-right-1.5 -top-1.5 cursor-nesw-resize",
    sw: "-bottom-1.5 -left-1.5 cursor-nesw-resize", se: "-bottom-1.5 -right-1.5 cursor-nwse-resize",
    n: "-top-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize", s: "-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize",
    e: "-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize", w: "-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize",
  };

  return <div className="absolute inset-0 overflow-hidden" data-crop-frame>
    <div role="group" aria-label="Crop area" className="absolute cursor-move touch-none border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
      style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
      onPointerDown={(event) => begin("move", event)} onPointerMove={move} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }}>
      <div aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
        {Array.from({ length: 9 }, (_, index) => <span key={index} className="border-white/30 [&:not(:nth-child(3n))]:border-r [&:nth-child(-n+6)]:border-b" />)}
      </div>
      {handles.map((handle) => <span key={handle} aria-hidden className={`absolute h-3 w-3 touch-none rounded-sm border border-black/30 bg-white ${handlePosition[handle as Exclude<Handle, "move">]}`}
        onPointerDown={(event) => begin(handle, event)} onPointerMove={move} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} />)}
    </div>
  </div>;
}

export function PhotoEditor({ photo, onCancel, onSaved }: {
  photo: GalleryPhoto;
  onCancel: () => void;
  onSaved: (result: { id: string; gallery: GalleryContents }, mode: "replace" | "copy") => void;
}) {
  const filterId = `libera-photo-${safeId(useId())}`;
  const [edits, setEdits] = useState<PhotoEdits>(NO_EDITS);
  const [tab, setTab] = useState<EditorTab>("crop");
  const [aspectId, setAspectId] = useState("free");
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [saving, setSaving] = useState<"replace" | "copy" | null>(null);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const presetCanvasesRef = useRef<Array<HTMLCanvasElement | null>>([]);
  const dirty = hasEdits(edits);

  useEffect(() => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => setSource(image);
    image.onerror = () => setError("Could not open the photo for editing.");
    image.src = galleryRawUrl(photo);
  }, [photo]);

  // The photo turned and flipped, at preview size. Adjustments are applied by the filter.
  const oriented = useMemo(() => {
    if (!source) return null;
    const scale = Math.min(1, PREVIEW_EDGE / Math.max(source.naturalWidth, source.naturalHeight));
    const width = Math.round(source.naturalWidth * scale);
    const height = Math.round(source.naturalHeight * scale);
    const size = orientedSize(width, height, edits.rotate);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.translate(size.width / 2, size.height / 2);
    context.scale(edits.flipH ? -1 : 1, edits.flipV ? -1 : 1);
    context.rotate((edits.rotate * Math.PI) / 180);
    context.drawImage(source, -width / 2, -height / 2, width, height);
    return canvas;
  }, [source, edits.rotate, edits.flipH, edits.flipV]);

  const showCrop = tab === "crop";
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !oriented) return;
    const region = showCrop ? cropPixels(null, oriented.width, oriented.height) : cropPixels(edits.crop, oriented.width, oriented.height);
    canvas.width = region.width;
    canvas.height = region.height;
    canvas.getContext("2d")?.drawImage(oriented, region.left, region.top, region.width, region.height, 0, 0, region.width, region.height);
    // Filter previews show the cropped photo through each preset.
    const scale = 160 / Math.max(region.width, region.height);
    for (const preview of presetCanvasesRef.current) {
      if (!preview) continue;
      preview.width = Math.max(1, Math.round(region.width * scale));
      preview.height = Math.max(1, Math.round(region.height * scale));
      preview.getContext("2d")?.drawImage(canvas, 0, 0, preview.width, preview.height);
    }
  }, [oriented, edits.crop, showCrop, tab]);

  const aspect = CROP_ASPECTS.find((entry) => entry.id === aspectId) ?? CROP_ASPECTS[0];
  const normalizedRatio = oriented && aspect.ratio !== null
    ? (aspect.ratio === "original" ? oriented.width / oriented.height : aspect.ratio) * (oriented.height / oriented.width)
    : null;

  function chooseAspect(id: string) {
    setAspectId(id);
    const next = CROP_ASPECTS.find((entry) => entry.id === id);
    if (!next || next.ratio === null || !oriented) return;
    const pixelRatio = next.ratio === "original" ? oriented.width / oriented.height : next.ratio;
    const crop = fitAspect(pixelRatio * (oriented.height / oriented.width));
    setEdits((current) => ({ ...current, crop: crop.width > 0.9999 && crop.height > 0.9999 ? null : crop }));
  }

  function turn(direction: "left" | "right") {
    // A locked shape would no longer match once the photo turns on its side.
    setAspectId("free");
    setEdits((current) => ({
      ...current,
      rotate: ((current.rotate + (direction === "right" ? 90 : 270)) % 360) as PhotoEdits["rotate"],
      crop: direction === "right" ? rotateCropClockwise(current.crop) : rotateCropCounterClockwise(current.crop),
    }));
  }

  function flip(axis: "horizontal" | "vertical") {
    setEdits((current) => ({
      ...current,
      flipH: axis === "horizontal" ? !current.flipH : current.flipH,
      flipV: axis === "vertical" ? !current.flipV : current.flipV,
      crop: flipCrop(current.crop, axis),
    }));
  }

  async function save(mode: "replace" | "copy") {
    setSaving(mode);
    setError("");
    try {
      const result = await apiRequest<{ id: string; gallery: GalleryContents }>("/api/gallery/photos/edit", { method: "POST", body: JSON.stringify({ id: photo.id, edits, mode }) });
      onSaved(result, mode);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the photo.");
      setSaving(null);
    }
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
      if (event.key === "Escape" && !dirty && !saving) { event.preventDefault(); onCancel(); }
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && dirty && !saving) { event.preventDefault(); void save("replace"); }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // `save` reads the latest edits through this effect's dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving, edits, onCancel]);

  const tabs: Array<{ id: EditorTab; label: string; icon: typeof Crop }> = [
    { id: "crop", label: "Crop & rotate", icon: Crop },
    { id: "adjust", label: "Adjust", icon: SlidersHorizontal },
    { id: "filters", label: "Filters", icon: Sparkles },
  ];
  const activePreset = FILTER_PRESETS.find((preset) => sameAdjustments(preset.adjustments, edits));

  return <div className="flex min-h-0 flex-1 flex-col">
    <svg aria-hidden width="0" height="0" className="absolute">
      <AdjustmentFilter id={filterId} adjustments={edits} />
      {FILTER_PRESETS.map((preset) => <AdjustmentFilter key={preset.id} id={`${filterId}-${preset.id}`} adjustments={preset.adjustments} />)}
    </svg>
    <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
      <button className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm hover:bg-white/10" disabled={Boolean(saving)} onClick={onCancel}><X className="h-4 w-4" />Cancel</button>
      <h2 className="mr-auto truncate text-sm font-medium">Edit photo</h2>
      <button className={panelButton} disabled={!dirty || Boolean(saving)} onClick={() => { setEdits(NO_EDITS); setAspectId("free"); }}><RotateCcw className="h-4 w-4" />Reset</button>
      <button className={panelButton} disabled={!dirty || Boolean(saving)} onClick={() => void save("copy")}>{saving === "copy" && <Loader2 className="h-4 w-4 animate-spin" />}Save as copy</button>
      <button className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-40" disabled={!dirty || Boolean(saving)} title="Save (⌘S). The original is kept so you can revert." onClick={() => void save("replace")}>
        {saving === "replace" && <Loader2 className="h-4 w-4 animate-spin" />}Save
      </button>
    </header>
    {error && <div role="alert" className="border-b border-red-400/30 bg-red-500/15 px-4 py-2 text-sm text-red-200">{error}</div>}
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 items-center justify-center p-8">
        {!source && !error && <Loader2 aria-label="Loading photo" className="h-6 w-6 animate-spin text-white/60" />}
        <div className={`relative inline-block max-h-full max-w-full ${source ? "" : "hidden"}`}>
          <canvas ref={canvasRef} className="block max-h-[calc(100vh-10rem)] max-w-full" style={{ filter: `url(#${filterId})` }} />
          {!showCrop && <div aria-hidden className="pointer-events-none absolute inset-0" style={vignetteStyle(edits)} />}
          {showCrop && source && <CropOverlay crop={edits.crop ?? FULL_CROP} ratio={normalizedRatio}
            onChange={(crop) => setEdits((current) => ({ ...current, crop: crop.width > 0.9999 && crop.height > 0.9999 ? null : crop }))} />}
        </div>
      </div>
      <aside className="flex w-80 shrink-0 flex-col border-l border-white/10">
        <div role="tablist" aria-label="Editing tools" className="grid grid-cols-3 gap-1 border-b border-white/10 p-2">
          {tabs.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={tab === id}
            className={`flex flex-col items-center gap-1 rounded-lg px-2 py-2 text-[11px] ${tab === id ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`}
            onClick={() => setTab(id)}><Icon className="h-4 w-4" />{label}</button>)}
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
          {tab === "crop" && <>
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-white/50">Rotate & flip</h3>
              <div className="grid grid-cols-4 gap-2">
                <button className={panelButton} aria-label="Rotate left" title="Rotate left" onClick={() => turn("left")}><RotateCcwSquare className="h-4 w-4" /></button>
                <button className={panelButton} aria-label="Rotate right" title="Rotate right" onClick={() => turn("right")}><RotateCwSquare className="h-4 w-4" /></button>
                <button className={panelButton} aria-label="Flip horizontally" title="Flip horizontally" aria-pressed={edits.flipH} onClick={() => flip("horizontal")}><FlipHorizontal2 className="h-4 w-4" /></button>
                <button className={panelButton} aria-label="Flip vertically" title="Flip vertically" aria-pressed={edits.flipV} onClick={() => flip("vertical")}><FlipVertical2 className="h-4 w-4" /></button>
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-white/50">Aspect ratio</h3>
              <div className="grid grid-cols-3 gap-2">
                {CROP_ASPECTS.map((entry) => <button key={entry.id} aria-pressed={aspectId === entry.id}
                  className={`rounded-lg border px-2 py-1.5 text-xs ${aspectId === entry.id ? "border-white bg-white/15" : "border-white/15 text-white/70 hover:bg-white/10"}`}
                  onClick={() => chooseAspect(entry.id)}>{entry.label}</button>)}
              </div>
            </div>
            <button className={`${panelButton} w-full`} disabled={!edits.crop} onClick={() => { setAspectId("free"); setEdits((current) => ({ ...current, crop: null })); }}>Clear crop</button>
            <p className="text-xs leading-relaxed text-white/50">Drag the frame to move it and its corners to resize. Adjustments show after you leave this tab.</p>
          </>}
          {tab === "adjust" && <>
            {ADJUSTMENT_CONTROLS.map((control) => <div key={control.key}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <label htmlFor={`${filterId}-${control.key}`}>{control.label}</label>
                <button className="min-w-8 rounded px-1 text-right text-xs tabular-nums text-white/60 hover:text-white" title="Reset" onClick={() => setEdits((current) => ({ ...current, [control.key]: 0 }))}>{edits[control.key] > 0 && control.min < 0 ? "+" : ""}{edits[control.key]}</button>
              </div>
              <input id={`${filterId}-${control.key}`} type="range" min={control.min} max={control.max} step={1} value={edits[control.key]} className="w-full accent-white"
                onDoubleClick={() => setEdits((current) => ({ ...current, [control.key]: 0 }))}
                onChange={(event) => { const value = Number(event.target.value); setEdits((current) => ({ ...current, [control.key]: value })); }} />
            </div>)}
            <button className={`${panelButton} w-full`} disabled={sameAdjustments(edits, NO_ADJUSTMENTS)} onClick={() => setEdits((current) => ({ ...current, ...NO_ADJUSTMENTS }))}>Reset adjustments</button>
          </>}
          {tab === "filters" && <div className="grid grid-cols-2 gap-3">
            {FILTER_PRESETS.map((preset, position) => <button key={preset.id} aria-pressed={activePreset?.id === preset.id} className="group text-left" onClick={() => setEdits((current) => ({ ...current, ...preset.adjustments }))}>
              <span className={`relative block aspect-square overflow-hidden rounded-lg ring-2 ${activePreset?.id === preset.id ? "ring-white" : "ring-transparent group-hover:ring-white/40"}`}>
                <canvas ref={(element) => { presetCanvasesRef.current[position] = element; }} aria-hidden className="h-full w-full object-cover" style={{ filter: `url(#${filterId}-${preset.id})` }} />
                <span aria-hidden className="absolute inset-0" style={vignetteStyle(preset.adjustments)} />
              </span>
              <span className="mt-1 block text-xs text-white/80">{preset.label}</span>
            </button>)}
          </div>}
        </div>
      </aside>
    </div>
  </div>;
}
