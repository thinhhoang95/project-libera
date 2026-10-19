"use client";

import {
  AlertTriangle,
  Crosshair,
  Download,
  FileJson,
  FolderOpen,
  Hand,
  ImageUp,
  PenLine,
  Pencil,
  Pentagon,
  Layers,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Ruler,
  ScanSearch,
  Settings2,
  Square,
  SquareDashed,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_LAYERS, DetectionCanvas, type CanvasMode, type DetectionLayers } from "@/components/libera/detection/detection-canvas";
import {
  DetectionNotReady,
  buildDetectionFile,
  cancelDetectionSetup,
  cropThumbnail,
  detectionsCsv,
  fetchDetectionStatus,
  loadImage,
  photoBlob,
  runDetection,
  saveTextFile,
  startDetectionSetup,
  variantReady,
  type DetectionRunResult,
  type DetectionRunSettings,
  type DetectionStatus,
  type DetectionVariantId,
} from "@/components/libera/detection/detection-client";
import { DetectionStatisticsView, formatNumber } from "@/components/libera/detection/detection-statistics";
import { ReferenceDialog } from "@/components/libera/detection/reference-dialog";
import { boxIou, editableGeometry, manualDetection, markEdited, withGeometry, type Geometry } from "@/lib/detection/geometry";
import {
  LENGTH_UNITS,
  PIXEL_SCALE,
  PROMPT_COLORS,
  computeStatistics,
  labelColors,
  measureDetection,
  parseDetectionFile,
  passesConfidence,
  type Box,
  type Detection,
  type DetectionModelInfo,
  type DetectionOrigin,
  type DetectionPrompt,
  type DetectionScale,
  type LengthUnit,
  type Point,
  type RemovedDetection,
  type VisualPrompt,
} from "@/lib/detection/results";

type Tab = "prompts" | "detections" | "statistics";
type SortKey = "id" | "label" | "confidence" | "area";
type RunState = Omit<DetectionRunResult, "model"> & {
  /** Null while every object was tagged by hand. */
  model: DetectionModelInfo | null;
  /** Model detections the user deleted. */
  removed: RemovedDetection[];
  createdAt: string;
  promptsKey: string;
  loadedFrom?: string;
};
type Snapshot = { detections: Detection[]; removed: RemovedDetection[] };
const HISTORY_LIMIT = 100;

const ORIGIN_BADGES: Record<DetectionOrigin, { label: string; symbol: string; className: string } | null> = {
  model: null,
  edited: { label: "Edited", symbol: "✱", className: "border-amber-500/60 text-amber-700 dark:text-amber-300" },
  manual: { label: "Manual", symbol: "✎", className: "border-violet-500/60 text-violet-700 dark:text-violet-300" },
};

function OriginBadge({ origin }: { origin: DetectionOrigin }) {
  const badge = ORIGIN_BADGES[origin];
  if (!badge) return null;
  return <span className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] font-medium leading-4 ${badge.className}`} title={origin === "edited" ? "Found by the model, then edited by hand" : "Tagged by hand"}><span aria-hidden>{badge.symbol}</span>{badge.label}</span>;
}

const TAG_HINTS: Partial<Record<CanvasMode, string>> = {
  "tag-box": "Drag a box around the object.",
  "tag-polygon": "Click to place points; click the first point, double-click or press Enter to close. Backspace removes the last point.",
  "tag-freeform": "Draw around the object; the outline is smoothed into a curve you can edit.",
  edit: "Drag points to reshape, a hollow point to add one, inside to move. Double-click a point or press Delete to remove it. Enter or click outside when done.",
};

let promptCounter = 0;
function newPromptId() {
  promptCounter += 1;
  return `p${Date.now().toString(36)}${promptCounter}`;
}

function promptsKey(prompts: DetectionPrompt[]) {
  return JSON.stringify(prompts.map((prompt) => (prompt.type === "text" ? [prompt.id, prompt.text] : [prompt.id, prompt.boxes, prompt.reference?.length ?? 0])));
}

function megabytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

const PHASES: Record<NonNullable<DetectionStatus["job"]>["phase"], string> = {
  runtime: "Downloading uv, the Python installer",
  python: "Installing a private Python 3.12",
  packages: "Installing PyTorch and Ultralytics. This takes a few minutes.",
  weights: "Downloading the model weights",
};

const iconButton = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40";
const button = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-40";
const primary = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40";
const field = "rounded-md border border-input bg-background px-2 py-1 text-xs";
const toolButton = (active: boolean) => `inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium ${active ? "bg-white text-black" : "text-white/85 hover:bg-white/10"}`;

/** A number input that applies its value, clamped, when it loses focus or on Enter, so typing “0.” is not undone. */
function NumberField({ value, min, max, step, className, label, disabled, onCommit }: {
  value: number;
  min: number;
  max?: number;
  step: number | "any";
  className: string;
  label?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  function commit() {
    if (draft === null) return;
    const number = Number.parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(number)) onCommit(Math.min(max ?? Infinity, Math.max(min, number)));
  }
  return (
    <input
      type="number"
      aria-label={label}
      className={className}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
    />
  );
}

/**
 * Detection and Segmentation with YOLOE-26: prompts by text, by examples drawn
 * on the photo or on a reference image; detections drawn over the photo,
 * listed, and summarized with counts, sizes and spatial statistics; saved to
 * and loaded from a JSON file.
 */
export function DetectionTool({ src, name, source, onClose }: {
  /** The photo's URL. */
  src: string;
  /** The photo's file name. */
  name: string;
  /** Where the photo lives, recorded in saved files (e.g. gallery/2026/photo.jpg). */
  source?: string;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<DetectionStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [settings, setSettings] = useState<DetectionRunSettings | null>(null);
  const [prompts, setPrompts] = useState<DetectionPrompt[]>([]);
  const [textDraft, setTextDraft] = useState("");
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("prompts");
  const [mode, setMode] = useState<CanvasMode>("view");
  const [drawTarget, setDrawTarget] = useState<string | null>(null);
  const [layers, setLayers] = useState<DetectionLayers>(DEFAULT_LAYERS);
  const [layersOpen, setLayersOpen] = useState(false);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [minConfidence, setMinConfidence] = useState(0);
  const [scale, setScale] = useState<DetectionScale>(PIXEL_SCALE);
  const [calibration, setCalibration] = useState<{ pixels: number; length: string; unit: LengthUnit } | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "id", descending: false });
  const [tagLabel, setTagLabel] = useState("");
  const [editing, setEditing] = useState<{ id: number; geometry: Geometry } | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const photoRef = useRef<Promise<Blob> | null>(null);
  const imageRef = useRef<Promise<HTMLImageElement> | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchDetectionStatus();
      setStatus(next);
      setStatusError("");
      setSettings((current) => current ?? next.preferences);
      return next;
    } catch (statusFailure) {
      setStatusError(statusFailure instanceof Error ? statusFailure.message : "Could not check the detection model.");
      return null;
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshStatus(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshStatus]);

  // Poll while a download or install runs on the server.
  const jobRunning = Boolean(status?.job?.running);
  useEffect(() => {
    if (!jobRunning) return;
    const timer = window.setInterval(() => void refreshStatus(), 800);
    return () => window.clearInterval(timer);
  }, [jobRunning, refreshStatus]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const photoImage = useCallback(() => {
    imageRef.current ??= loadImage(src);
    return imageRef.current;
  }, [src]);

  const label = tagLabel.trim() || prompts[0]?.label || "object";
  const colors = useMemo(() => labelColors(prompts, run?.detections ?? [], [label]), [prompts, run, label]);
  const variant = settings?.variant ?? status?.variant ?? "s";
  const variantInfo = status?.catalog.find((entry) => entry.id === variant);
  const needsText = prompts.some((prompt) => prompt.type === "text");
  const ready = variantReady(status, variant, needsText);
  const width = run?.width ?? natural?.width ?? 0;
  const height = run?.height ?? natural?.height ?? 0;
  const sizeMismatch = Boolean(run && natural && (Math.abs(run.width / run.height - natural.width / natural.height) > 0.01));
  const stale = Boolean(run && !run.loadedFrom && run.promptsKey !== promptsKey(prompts));
  const threshold = Math.max(minConfidence, 0);
  const visible = useMemo(() => (run?.detections ?? []).filter((detection) => passesConfidence(detection, threshold)), [run, threshold]);
  const knownLabels = useMemo(() => [...new Set([...prompts.map((prompt) => prompt.label), ...(run?.detections ?? []).map((detection) => detection.label)])], [prompts, run]);
  const statistics = useMemo(
    () => (run ? computeStatistics(run.detections, prompts, run.width, run.height, scale, threshold) : null),
    [run, prompts, scale, threshold],
  );
  const countsByPrompt = useMemo(() => {
    const counts = new Map<string, number>();
    for (const detection of visible) counts.set(detection.promptId, (counts.get(detection.promptId) ?? 0) + 1);
    return counts;
  }, [visible]);
  const sorted = useMemo(() => {
    const rows = [...visible];
    const direction = sort.descending ? -1 : 1;
    rows.sort((a, b) => {
      const value = sort.key === "label" ? a.label.localeCompare(b.label) : (a[sort.key] as number) - (b[sort.key] as number);
      return value * direction || a.id - b.id;
    });
    return rows;
  }, [visible, sort]);
  const examples = useMemo(() => prompts.flatMap((prompt) => (prompt.type === "visual" && prompt.source === "photo"
    ? prompt.boxes.map((box) => ({ box, color: prompt.color, label: prompt.label }))
    : [])), [prompts]);
  const length = scale.unit === "px" ? 1 : scale.perPixel;

  const nextColor = useCallback((current: DetectionPrompt[]) => {
    const used = new Set(current.map((prompt) => prompt.color));
    return PROMPT_COLORS.find((color) => !used.has(color)) ?? PROMPT_COLORS[current.length % PROMPT_COLORS.length];
  }, []);

  function addTextPrompts() {
    const texts = textDraft.split(/[,;\n]/).map((text) => text.trim()).filter(Boolean);
    if (!texts.length) return;
    setPrompts((current) => {
      const next = [...current];
      for (const text of texts) {
        if (next.some((prompt) => prompt.type === "text" && prompt.text.toLowerCase() === text.toLowerCase())) continue;
        next.push({ id: newPromptId(), type: "text", label: text.slice(0, 80), text: text.slice(0, 300), color: nextColor(next) });
      }
      return next;
    });
    setTextDraft("");
  }

  async function addExample(box: Box) {
    const rounded = box.map((value) => Math.round(value * 10) / 10) as Box;
    const target = drawTarget ? prompts.find((prompt) => prompt.id === drawTarget && prompt.type === "visual") : null;
    if (target) {
      setPrompts((current) => current.map((prompt) => (prompt.id === target.id && prompt.type === "visual" ? { ...prompt, boxes: [...prompt.boxes, rounded] } : prompt)));
      return;
    }
    const id = newPromptId();
    setPrompts((current) => [...current, {
      id,
      type: "visual",
      label: `object ${current.filter((prompt) => prompt.type === "visual").length + 1}`,
      color: nextColor(current),
      source: "photo",
      width,
      height,
      boxes: [rounded],
    }]);
    // Further boxes add examples to this prompt until drawing stops.
    setDrawTarget(id);
    try {
      const thumbnail = cropThumbnail(await photoImage(), rounded);
      setPrompts((current) => current.map((prompt) => (prompt.id === id && prompt.type === "visual" ? { ...prompt, thumbnail } : prompt)));
    } catch {
      // The prompt works without its thumbnail.
    }
  }

  function updatePrompt(id: string, change: Partial<DetectionPrompt>) {
    setPrompts((current) => current.map((prompt) => {
      if (prompt.id !== id) return prompt;
      const next = { ...prompt, ...change } as DetectionPrompt;
      // A text prompt's label is its text.
      if (next.type === "text" && typeof change.label === "string") next.text = change.label;
      return next;
    }));
  }

  function removePrompt(id: string) {
    setPrompts((current) => current.filter((prompt) => prompt.id !== id));
    if (drawTarget === id) setDrawTarget(null);
  }

  function startDrawing(target: string | null) {
    setDrawTarget(target);
    setMode("draw");
    setTab("prompts");
  }

  async function detect() {
    if (!settings || !prompts.length || running) return;
    if (!ready) return;
    setRunning(true);
    setError("");
    try {
      photoRef.current ??= photoBlob(src);
      const photo = await photoRef.current;
      const result = await runDetection(photo, prompts, settings);
      // Hand-tagged and edited objects survive a new run; model detections
      // they cover, and ones the user deleted, are not brought back.
      const kept = (run?.detections ?? []).filter((detection) => detection.origin !== "model");
      const removed = run?.removed ?? [];
      // An edited object also covers what the model first found for it.
      const fresh = result.detections.filter((detection) => !kept.some((other) => boxIou(other.box, detection.box) > 0.5 || (other.original && boxIou(other.original.box, detection.box) > 0.7))
        && !removed.some((other) => boxIou(other.box, detection.box) > 0.7));
      const detections = [...fresh, ...kept].map((detection, index) => ({ ...detection, id: index + 1 }));
      if (run?.detections.length) pushHistory(run);
      setRun({ ...result, detections, removed, createdAt: new Date().toISOString(), promptsKey: promptsKey(prompts) });
      setEditing(null);
      if (kept.length) setNotice(`Kept ${kept.length} hand-tagged and edited ${kept.length === 1 ? "object" : "objects"}`);
      setMinConfidence(settings.confidence);
      setSelectedId(null);
      setMode("view");
      setTab("detections");
    } catch (failure) {
      photoRef.current = null;
      if (failure instanceof DetectionNotReady) void refreshStatus();
      setError(failure instanceof Error ? failure.message : "Detection failed.");
    } finally {
      setRunning(false);
    }
  }

  async function install() {
    setError("");
    try {
      setStatus(await startDetectionSetup(variant));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not start the download.");
    }
  }

  async function exportJson() {
    if (!run) return;
    const file = buildDetectionFile({ imageName: name, imageSource: source, result: run, prompts, scale, displayConfidence: threshold, createdAt: new Date().toISOString() });
    const base = name.replace(/\.[^.]+$/, "");
    if (await saveTextFile(`${base}.detections.json`, `${JSON.stringify(file, null, 2)}\n`, "Detection results", "json", "application/json")) setNotice("Detections saved");
  }

  async function exportCsv() {
    if (!run) return;
    const base = name.replace(/\.[^.]+$/, "");
    if (await saveTextFile(`${base}.detections.csv`, detectionsCsv(visible, scale), "CSV", "csv", "text/csv")) setNotice("Table saved");
  }

  async function openFile(file: File) {
    setError("");
    try {
      const parsed = parseDetectionFile(JSON.parse(await file.text()));
      setPrompts(parsed.prompts);
      setScale(parsed.scale);
      setRun({
        width: parsed.image.width,
        height: parsed.image.height,
        detections: parsed.detections,
        model: parsed.model,
        removed: parsed.removedDetections,
        timing: parsed.timing ?? {},
        createdAt: parsed.createdAt,
        promptsKey: promptsKey(parsed.prompts),
        loadedFrom: `${file.name}${parsed.image.name ? ` (made for ${parsed.image.name})` : ""}`,
      });
      setMinConfidence(parsed.displayConfidence);
      const model = parsed.model;
      if (model) setSettings((current) => current && ({
        ...current,
        ...(["n", "s", "m", "l", "x"].includes(model.variant) ? { variant: model.variant as DetectionVariantId } : {}),
        ...(model.confidence ? { confidence: model.confidence } : {}),
        ...(model.iou ? { iou: model.iou } : {}),
        ...([640, 960, 1280].includes(model.imageSize) ? { imageSize: model.imageSize as 640 | 960 | 1280 } : {}),
        ...(model.maxDetections ? { maxDetections: model.maxDetections } : {}),
      }));
      setHistory([]);
      setEditing(null);
      setMode("view");
      setSelectedId(null);
      setTab("detections");
      setNotice(`Loaded ${parsed.detections.length} detections`);
    } catch (failure) {
      setError(failure instanceof SyntaxError ? "This file is not valid JSON." : failure instanceof Error ? failure.message : "Could not open this file.");
    }
  }

  function pushHistory(current: RunState) {
    setHistory((stack) => [...stack.slice(-(HISTORY_LIMIT - 1)), { detections: current.detections, removed: current.removed }]);
  }

  /** Change the detections, recording the previous state for Undo. A first hand tag starts a run without a model. */
  function changeDetections(change: (detections: Detection[], removed: RemovedDetection[]) => Snapshot) {
    const current: RunState = run ?? {
      width: natural?.width ?? 0,
      height: natural?.height ?? 0,
      detections: [],
      model: null,
      removed: [],
      timing: {},
      createdAt: new Date().toISOString(),
      promptsKey: promptsKey(prompts),
    };
    if (!current.width || !current.height) return;
    pushHistory(current);
    setRun({ ...current, ...change(current.detections, current.removed) });
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous || !run) return;
    setHistory((stack) => stack.slice(0, -1));
    setRun({ ...run, ...previous });
    // The outline being edited may have changed under the editor.
    setEditing(null);
    if (mode === "edit") setMode("view");
    setNotice("Undone");
  }

  function changeMode(next: CanvasMode) {
    setMode(next);
    if (next !== "draw") setDrawTarget(null);
    if (next !== "edit") setEditing(null);
  }

  function tag(geometry: Geometry) {
    const id = Math.max(0, ...(run?.detections ?? []).map((detection) => detection.id)) + 1;
    changeDetections((detections, removed) => ({ detections: [...detections, manualDetection(id, label, geometry)], removed }));
    setSelectedId(id);
    setTab("detections");
  }

  function startEditing(id: number) {
    const detection = run?.detections.find((entry) => entry.id === id);
    if (!detection) return;
    setEditing({ id, geometry: editableGeometry(detection) });
    setSelectedId(id);
    setMode("edit");
    setDrawTarget(null);
  }

  function editShape(geometry: Geometry, final: boolean) {
    if (!editing) return;
    setEditing({ id: editing.id, geometry });
    if (!final) return;
    const at = new Date().toISOString();
    changeDetections((detections, removed) => ({ detections: detections.map((detection) => (detection.id === editing.id ? withGeometry(detection, geometry, at) : detection)), removed }));
  }

  function relabel(id: number, next: string) {
    const value = next.trim();
    const detection = run?.detections.find((entry) => entry.id === id);
    if (!value || !detection || detection.label === value) return;
    const at = new Date().toISOString();
    changeDetections((detections, removed) => ({
      detections: detections.map((entry) => (entry.id === id ? { ...entry, label: value, ...markEdited(entry), editedAt: at } : entry)),
      removed,
    }));
  }

  function removeDetection(id: number) {
    const detection = run?.detections.find((entry) => entry.id === id);
    if (!detection) return;
    changeDetections((detections, removed) => ({
      detections: detections.filter((entry) => entry.id !== id),
      // A hand tag simply goes; what the model found is recorded as removed.
      removed: detection.origin === "manual" ? removed : [...removed, {
        id: detection.id,
        label: detection.original?.label ?? detection.label,
        confidence: detection.confidence,
        box: detection.original?.box ?? detection.box,
        origin: detection.origin,
        removedAt: new Date().toISOString(),
      }],
    }));
    if (editing?.id === id) changeMode("view");
    setSelectedId(null);
  }

  function revert(id: number) {
    changeDetections((detections, removed) => ({
      detections: detections.map((detection) => {
        if (detection.id !== id || !detection.original) return detection;
        const { original } = detection;
        return {
          id: detection.id,
          promptId: detection.promptId,
          label: original.label,
          confidence: original.confidence,
          box: original.box,
          polygon: original.polygon,
          ...measureDetection(original),
          origin: "model" as const,
          shape: original.polygon.length >= 3 ? "polygon" as const : "box" as const,
        };
      }),
      removed,
    }));
    if (editing?.id === id) changeMode("view");
  }

  function finishCalibration(line: [Point, Point]) {
    const pixels = Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]);
    setCalibration({ pixels, length: "", unit: scale.unit === "px" ? "µm" : scale.unit });
    setMode("view");
    setTab("statistics");
  }

  function applyCalibration() {
    if (!calibration) return;
    const value = Number.parseFloat(calibration.length);
    if (!Number.isFinite(value) || value <= 0 || calibration.pixels <= 0) return;
    setScale({ unit: calibration.unit, perPixel: value / calibration.pixels });
    setCalibration(null);
    setNotice(`Scale set: 1 px = ${formatNumber(value / calibration.pixels)} ${calibration.unit}`);
  }

  // Esc leaves drawing first, then closes the tool. The viewers under it
  // ignore keys while a dialog or [data-libera-overlay] is open.
  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      if (referenceFile || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (mode !== "view") changeMode("view"); else onClose();
      } else if ((event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        void detect();
      } else if (event.key === "Enter" && mode === "edit") {
        event.preventDefault();
        changeMode("view");
      } else if ((event.key === "z" || event.key === "Z") && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((event.key === "Delete" || event.key === "Backspace") && mode === "view" && selectedId !== null) {
        event.preventDefault();
        removeDetection(selectedId);
      }
    }
    window.addEventListener("keydown", keyDown);
    return () => window.removeEventListener("keydown", keyDown);
  });

  useEffect(() => {
    if (selectedId !== null) rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const provenance = {
    edited: run?.detections.filter((detection) => detection.origin === "edited").length ?? 0,
    manual: run?.detections.filter((detection) => detection.origin === "manual").length ?? 0,
  };
  const job = status?.job;
  const missing = status ? [
    !status.runtime && { label: "Python runtime with PyTorch and Ultralytics", bytes: status.sizes.runtime, approximate: true },
    !status.textEncoder && { label: "MobileCLIP2-B text encoder", bytes: status.sizes.textEncoder, approximate: false },
    !status.variants[variant] && { label: `${variantInfo?.name ?? "YOLOE-26"} weights`, bytes: status.sizes.variants[variant], approximate: false },
  ].filter(Boolean) as Array<{ label: string; bytes: number; approximate: boolean }> : [];

  const sortHeader = (key: SortKey, label: string, className = "") => (
    <th className={`px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground ${className}`}>
      <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={() => setSort((current) => ({ key, descending: current.key === key ? !current.descending : key !== "id" && key !== "label" }))}>
        {label}{sort.key === key ? (sort.descending ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  const tool = (
    <div role="dialog" aria-modal="true" aria-label={`Detection and Segmentation: ${name}`} data-libera-overlay="" className="fixed inset-0 z-[45] flex flex-col bg-background text-foreground">
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <ScanSearch aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-sm font-semibold">Detection and Segmentation</h2>
          <p className="truncate text-xs text-muted-foreground" title={source ?? name}>{name}{natural ? ` · ${natural.width} × ${natural.height}` : ""}</p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="max-sm:hidden">Model</span>
          <select className={field} value={variant} disabled={!settings} onChange={(event) => setSettings((current) => current && { ...current, variant: event.target.value as DetectionVariantId })}>
            {(status?.catalog ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}{status?.variants[entry.id] ? "" : " (download)"}</option>
            ))}
          </select>
        </label>
        <button type="button" className={primary} disabled={!ready || !prompts.length || running || !settings} title="Detect (⌘/Ctrl+Enter)" onClick={() => void detect()}>
          {running ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Play aria-hidden className="h-3.5 w-3.5" />}
          {running ? "Detecting…" : "Detect"}
        </button>
        <span className="mx-1 h-6 w-px bg-border" />
        <button type="button" className={iconButton} aria-label="Open detection file" title="Open a saved detection file (.json)" onClick={() => openRef.current?.click()}><FolderOpen className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label="Save detection file" title="Save detections, prompts and model details (.json)" disabled={!run} onClick={() => void exportJson()}><FileJson className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label="Save table as CSV" title="Save the detection table (.csv)" disabled={!run} onClick={() => void exportCsv()}><Download className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label="Detection settings" title="Preferences → Detection and Segmentation" onClick={() => void window.liberaPreferences?.open("detection")}><Settings2 className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label="Close" title="Close (Esc)" onClick={onClose}><X className="h-4 w-4" /></button>
        <input ref={openRef} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void openFile(file); }} />
        <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) setReferenceFile(file); }} />
      </header>

      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-1 rounded-lg bg-black/70 p-1 backdrop-blur" role="toolbar" aria-label="Canvas tools">
            <button type="button" className={toolButton(mode === "view")} aria-pressed={mode === "view"} title="Inspect: select objects; double-click one to edit its outline" onClick={() => changeMode("view")}><Hand aria-hidden className="h-3.5 w-3.5" />Inspect</button>
            <button type="button" className={toolButton(mode === "draw")} aria-pressed={mode === "draw"} title="Drag around an example of the object to find" onClick={() => startDrawing(null)}><SquareDashed aria-hidden className="h-3.5 w-3.5" />Draw example</button>
            <button type="button" className={toolButton(mode === "calibrate")} aria-pressed={mode === "calibrate"} title="Drag along a scale bar of known length" onClick={() => changeMode("calibrate")}><Ruler aria-hidden className="h-3.5 w-3.5" />Set scale</button>
            <span className="mx-0.5 h-5 w-px bg-white/20" />
            <span className="px-1 text-[11px] text-white/60">Tag</span>
            <button type="button" className={toolButton(mode === "tag-box")} aria-pressed={mode === "tag-box"} aria-label="Tag with a box" title="Tag an object by hand with a box" onClick={() => changeMode("tag-box")}><Square aria-hidden className="h-3.5 w-3.5" /></button>
            <button type="button" className={toolButton(mode === "tag-polygon")} aria-pressed={mode === "tag-polygon"} aria-label="Tag with a polygon" title="Tag an object by hand with a polygon" onClick={() => changeMode("tag-polygon")}><Pentagon aria-hidden className="h-3.5 w-3.5" /></button>
            <button type="button" className={toolButton(mode === "tag-freeform")} aria-pressed={mode === "tag-freeform"} aria-label="Tag freehand" title="Tag an object by hand, freehand with smoothing" onClick={() => changeMode("tag-freeform")}><PenLine aria-hidden className="h-3.5 w-3.5" /></button>
            <button type="button" className={toolButton(false)} aria-label="Undo" title="Undo (⌘/Ctrl+Z)" disabled={!history.length} onClick={undo}><Undo2 aria-hidden className="h-3.5 w-3.5" /></button>
            <span className="mx-0.5 h-5 w-px bg-white/20" />
            <div className="relative">
              <button type="button" className={toolButton(layersOpen)} aria-expanded={layersOpen} onClick={() => setLayersOpen((open) => !open)}><Layers aria-hidden className="h-3.5 w-3.5" />Layers</button>
              {layersOpen ? (
                <div className="absolute left-0 top-9 w-48 space-y-1 rounded-lg border border-border bg-card p-2 text-xs text-foreground shadow-lg">
                  {([["masks", "Masks"], ["boxes", "Boxes"], ["labels", "Labels"], ["centroids", "Centroids"], ["density", "Quadrat density"], ["examples", "Prompt examples"]] as Array<[keyof DetectionLayers, string]>).map(([key, label]) => (
                    <label key={key} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-muted">
                      <input type="checkbox" checked={layers[key]} onChange={(event) => setLayers((current) => ({ ...current, [key]: event.target.checked }))} />
                      {label}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {mode.startsWith("tag-") ? (
            <div className="absolute left-3 top-14 z-10 flex items-center gap-1.5 rounded-lg bg-black/70 px-2 py-1.5 text-xs text-white backdrop-blur">
              <span aria-hidden className="h-3 w-3 rounded-sm" style={{ background: colors.get(label) }} />
              <label htmlFor="detection-tag-label" className="text-white/70">Label</label>
              <input
                id="detection-tag-label"
                list="detection-labels"
                className="w-36 rounded border border-white/20 bg-black/40 px-1.5 py-0.5 text-white placeholder:text-white/40"
                placeholder={prompts[0]?.label ?? "object"}
                value={tagLabel}
                maxLength={80}
                onChange={(event) => setTagLabel(event.target.value)}
              />
            </div>
          ) : null}
          <datalist id="detection-labels">{knownLabels.map((entry) => <option key={entry} value={entry} />)}</datalist>
          {mode !== "view" ? (
            <div className={`pointer-events-none absolute left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-center text-xs text-white ${mode.startsWith("tag-") ? "top-24" : "top-14"}`}>
              {mode === "draw"
                ? drawTarget ? `Drag to add another example to “${prompts.find((prompt) => prompt.id === drawTarget)?.label ?? "this prompt"}”. Esc to stop.` : "Drag around an example of the object to find. Esc to stop."
                : mode === "calibrate" ? "Drag along a scale bar of known length. Esc to cancel." : `${TAG_HINTS[mode]} Esc to stop.`}
            </div>
          ) : null}
          <DetectionCanvas
            src={src}
            width={width}
            height={height}
            detections={visible}
            colors={colors}
            layers={layers}
            quadrats={statistics?.overall.quadrats ?? null}
            examples={examples}
            hoverId={hoverId}
            selectedId={selectedId}
            mode={mode}
            tagColor={colors.get(label)}
            editing={editing && { ...editing, color: colors.get(run?.detections.find((detection) => detection.id === editing.id)?.label ?? "") ?? "#ffffff" }}
            onNaturalSize={setNatural}
            onHover={setHoverId}
            onSelect={setSelectedId}
            onBox={(box) => void addExample(box)}
            onLine={finishCalibration}
            onTag={tag}
            onEditChange={editShape}
            onEditDone={() => changeMode("view")}
            onRequestEdit={startEditing}
          />
          <footer className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            {run ? (
              <>
                <span className="font-medium text-foreground">{visible.length} of {run.detections.length} objects</span>
                {provenance.edited || provenance.manual ? <span>{provenance.edited} edited · {provenance.manual} manual{run.removed.length ? ` · ${run.removed.length} removed` : ""}</span> : null}
                {run.model ? <span>{run.model.name} · {run.model.framework} · {run.model.device.toUpperCase()} · {run.model.imageSize} px · conf ≥ {run.model.confidence} · IoU {run.model.iou}</span> : <span>Tagged by hand</span>}
                {typeof run.timing.inferenceMs === "number" ? <span>{Math.round(run.timing.inferenceMs as number)} ms inference</span> : null}
                {run.createdAt ? <span>{new Date(run.createdAt).toLocaleString()}</span> : null}
                {run.loadedFrom ? <span title={run.loadedFrom}>From file {run.loadedFrom}</span> : null}
              </>
            ) : <span>Add prompts, then Detect. Scroll to zoom, double-click to fit.</span>}
            {scale.unit !== "px" ? <span>Scale 1 px = {formatNumber(scale.perPixel)} {scale.unit}</span> : null}
          </footer>
          {notice ? <div role="status" className="absolute bottom-12 left-1/2 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-sm text-black shadow-lg">{notice}</div> : null}
        </div>

        <aside className="flex min-h-0 w-[26rem] shrink-0 xl:w-[32rem] flex-col border-l border-border bg-background max-md:h-[45vh] max-md:w-full max-md:border-l-0 max-md:border-t">
          {status && !ready ? (
            <section className="m-3 space-y-2 rounded-lg border border-border bg-card p-3 text-xs" aria-label="Download the model">
              <p className="text-sm font-semibold">Download {variantInfo?.name ?? "YOLOE-26"}</p>
              {job?.running ? (
                <div className="space-y-1.5">
                  <p>{PHASES[job.phase]}</p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.totalBytes ? Math.round((job.downloadedBytes / job.totalBytes) * 100) : undefined}>
                    {job.totalBytes ? (
                      <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.min(100, (job.downloadedBytes / job.totalBytes) * 100)}%` }} />
                    ) : <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />}
                  </div>
                  {job.totalBytes ? <p className="text-muted-foreground">{megabytes(job.downloadedBytes)} of {megabytes(job.totalBytes)}</p> : null}
                  <button type="button" className={button} onClick={() => void cancelDetectionSetup().then(setStatus, () => undefined)}>Cancel</button>
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground">Runs on this computer; photos are not uploaded anywhere. Libera downloads:</p>
                  <ul className="space-y-0.5">
                    {missing.map((item) => <li key={item.label} className="flex justify-between gap-2"><span>{item.label}</span><span className="tabular-nums text-muted-foreground">{item.approximate ? "about " : ""}{megabytes(item.bytes)}</span></li>)}
                  </ul>
                  {job?.error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{job.error}</p> : null}
                  <p className="text-[11px] text-muted-foreground">From GitHub (Astral’s uv, Ultralytics) and PyPI, into {status.directory}. Ultralytics and the YOLOE-26 weights are AGPL-3.0.</p>
                  <button type="button" className={primary} onClick={() => void install()}><Download aria-hidden className="h-3.5 w-3.5" />{job?.error ? "Try again" : "Download and install"}</button>
                </>
              )}
            </section>
          ) : null}
          {statusError ? <p role="alert" className="m-3 text-xs text-destructive">{statusError}</p> : null}
          {error ? <p role="alert" className="mx-3 mt-3 flex gap-1.5 whitespace-pre-wrap rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"><AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />{error}</p> : null}
          {sizeMismatch ? <p className="mx-3 mt-3 flex gap-1.5 rounded-md bg-muted px-2.5 py-2 text-xs"><AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />This file was made for an image of {run?.width} × {run?.height}, not this photo’s {natural?.width} × {natural?.height}. The detections may not line up.</p> : null}
          {stale ? <p className="mx-3 mt-3 rounded-md bg-muted px-2.5 py-2 text-xs">The prompts changed since this run. Detect again to update the results.</p> : null}

          <div className="mt-2 flex border-b border-border px-3" role="tablist">
            {([["prompts", `Prompts (${prompts.length})`], ["detections", `Detections${run ? ` (${visible.length})` : ""}`], ["statistics", "Statistics"]] as Array<[Tab, string]>).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium ${tab === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "prompts" ? (
              <div className="space-y-4 p-3 text-xs">
                <section className="space-y-2">
                  <label htmlFor="detection-text-prompt" className="font-medium">Text prompts</label>
                  <div className="flex gap-1.5">
                    <input
                      id="detection-text-prompt"
                      className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                      placeholder="e.g. red blood cell, nucleus"
                      value={textDraft}
                      maxLength={2000}
                      onChange={(event) => setTextDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); addTextPrompts(); } }}
                    />
                    <button type="button" className={button} disabled={!textDraft.trim()} onClick={addTextPrompts}><Plus aria-hidden className="h-3.5 w-3.5" />Add</button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">Separate several with commas. Short noun phrases work best: “ripe tomato”, “stoma”, “pollen grain”.</p>
                </section>
                <section className="space-y-2">
                  <p className="font-medium">Visual prompts</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className={button} onClick={() => startDrawing(null)}><Crosshair aria-hidden className="h-3.5 w-3.5" />Draw on photo</button>
                    <button type="button" className={button} onClick={() => uploadRef.current?.click()}><ImageUp aria-hidden className="h-3.5 w-3.5" />Upload reference…</button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">Box one or more examples of an object; YOLOE finds others like them. Use a reference image when the photo has no clean example. Visual prompts often score lower than text: if nothing is found, lower the confidence in Run settings or add more examples.</p>
                </section>

                <section className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">Prompts</p>
                    {prompts.length ? <button type="button" className="text-[11px] text-muted-foreground hover:text-destructive" onClick={() => { setPrompts([]); setDrawTarget(null); }}>Remove all</button> : null}
                  </div>
                  {!prompts.length ? <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-muted-foreground">No prompts yet.</p> : null}
                  <ul className="space-y-1.5">
                    {prompts.map((prompt) => (
                      <li key={prompt.id} className={`flex items-center gap-2 rounded-md border bg-card p-1.5 ${drawTarget === prompt.id && mode === "draw" ? "border-primary" : "border-border"}`}>
                        <span aria-hidden className="h-8 w-1 shrink-0 rounded-full" style={{ background: prompt.color }} />
                        {prompt.type === "visual" && prompt.thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a data URL thumbnail
                          <img src={prompt.thumbnail} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
                        ) : (
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                            {prompt.type === "text" ? <Type aria-hidden className="h-4 w-4" /> : <SquareDashed aria-hidden className="h-4 w-4" />}
                          </span>
                        )}
                        <div className="min-w-0 flex-1">
                          <input
                            aria-label="Prompt label"
                            className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-input focus:border-input focus:bg-background"
                            value={prompt.label}
                            maxLength={prompt.type === "text" ? 300 : 80}
                            onChange={(event) => updatePrompt(prompt.id, { label: event.target.value })}
                          />
                          <p className="px-1 text-[11px] text-muted-foreground">
                            {prompt.type === "text" ? "Text" : prompt.source === "photo" ? `${prompt.boxes.length} ${prompt.boxes.length === 1 ? "example" : "examples"} on this photo` : `${prompt.boxes.length} ${prompt.boxes.length === 1 ? "example" : "examples"} in ${prompt.name ?? "a reference image"}`}
                            {run && countsByPrompt.has(prompt.id) ? ` · ${countsByPrompt.get(prompt.id)} found` : ""}
                          </p>
                        </div>
                        {prompt.type === "visual" && prompt.source === "photo" ? (
                          <button type="button" className={iconButton} aria-label={`Add an example to ${prompt.label}`} title="Draw another example" onClick={() => startDrawing(prompt.id)}><Plus className="h-4 w-4" /></button>
                        ) : null}
                        <button type="button" className={`${iconButton} hover:text-destructive`} aria-label={`Remove ${prompt.label}`} title="Remove prompt" onClick={() => removePrompt(prompt.id)}><Trash2 className="h-4 w-4" /></button>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-muted-foreground">Prompts with the same label are counted together.</p>
                </section>

                {settings ? (
                  <details className="rounded-md border border-border bg-card px-2.5 py-2">
                    <summary className="cursor-pointer font-medium">Run settings</summary>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="space-y-1"><span className="text-muted-foreground">Confidence ≥</span>
                        <NumberField className={`${field} w-full`} min={0.01} max={0.99} step={0.01} value={settings.confidence} onCommit={(confidence) => setSettings({ ...settings, confidence })} />
                      </label>
                      <label className="space-y-1"><span className="text-muted-foreground">IoU</span>
                        <NumberField className={`${field} w-full`} min={0.05} max={0.95} step={0.05} value={settings.iou} onCommit={(iou) => setSettings({ ...settings, iou })} />
                      </label>
                      <label className="space-y-1"><span className="text-muted-foreground">Inference size</span>
                        <select className={`${field} w-full`} value={settings.imageSize} onChange={(event) => setSettings({ ...settings, imageSize: Number(event.target.value) as 640 | 960 | 1280 })}>
                          <option value={640}>640 px</option><option value={960}>960 px</option><option value={1280}>1280 px</option>
                        </select>
                      </label>
                      <label className="space-y-1"><span className="text-muted-foreground">Max detections</span>
                        <NumberField className={`${field} w-full`} min={1} max={3000} step={1} value={settings.maxDetections} onCommit={(maxDetections) => setSettings({ ...settings, maxDetections: Math.round(maxDetections) })} />
                      </label>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">Runs on the {settings.device === "cpu" ? "CPU" : settings.device === "mps" ? "Apple GPU" : "NVIDIA GPU"}. Defaults come from Preferences.</p>
                  </details>
                ) : null}
              </div>
            ) : null}

            {tab === "detections" ? (
              run ? (
                <div className="text-xs">
                  <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-border bg-background px-3 py-2">
                    <label htmlFor="detection-min-confidence" className="shrink-0 text-muted-foreground">Confidence ≥</label>
                    <input id="detection-min-confidence" type="range" className="min-w-0 flex-1" min={Math.min(run.model?.confidence || 0, 0.99)} max={0.99} step={0.01} value={threshold} onChange={(event) => setMinConfidence(Number(event.target.value))} />
                    <span className="w-9 text-right tabular-nums">{threshold.toFixed(2)}</span>
                  </div>
                  {visible.length ? (
                    <table className="w-full border-collapse">
                      <thead className="sticky top-[41px] bg-muted/90">
                        <tr>
                          {sortHeader("id", "#")}
                          {sortHeader("label", "Label")}
                          {sortHeader("confidence", "Conf.")}
                          <th className="px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground">Source</th>
                          {sortHeader("area", `Area (${scale.unit}²)`)}
                          <th className="px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground">Centroid ({scale.unit})</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((detection: Detection) => (
                          <tr
                            key={detection.id}
                            ref={(element) => { if (element) rowRefs.current.set(detection.id, element); else rowRefs.current.delete(detection.id); }}
                            className={`cursor-pointer border-t border-border ${detection.id === selectedId ? "bg-primary/15" : detection.id === hoverId ? "bg-muted" : "hover:bg-muted/60"}`}
                            onPointerEnter={() => setHoverId(detection.id)}
                            onPointerLeave={() => setHoverId(null)}
                            onClick={() => setSelectedId(detection.id === selectedId ? null : detection.id)}
                            onDoubleClick={() => startEditing(detection.id)}
                          >
                            <td className="px-2 py-1 tabular-nums">{detection.id}</td>
                            <td className="px-2 py-1"><span className="flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colors.get(detection.label) ?? "#888888" }} />{detection.label}</span></td>
                            <td className="px-2 py-1 tabular-nums">{detection.origin === "manual" ? "–" : detection.confidence.toFixed(3)}</td>
                            <td className="px-2 py-1">{detection.origin === "model" ? <span className="text-muted-foreground">Model</span> : <OriginBadge origin={detection.origin} />}</td>
                            <td className="px-2 py-1 tabular-nums">{formatNumber(detection.area * length * length)}</td>
                            <td className="px-2 py-1 tabular-nums">{formatNumber(detection.centroid[0] * length)}, {formatNumber(detection.centroid[1] * length)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="p-4 text-muted-foreground">Nothing at this confidence.</p>}
                  {selectedId !== null ? (() => {
                    const detection = visible.find((entry) => entry.id === selectedId);
                    if (!detection) return null;
                    const area = detection.area * length * length;
                    return (
                      <div className="sticky bottom-0 space-y-2 border-t border-border bg-card px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">#{detection.id}</span>
                        <input
                          key={`${detection.id}-${detection.label}`}
                          aria-label="Object label"
                          list="detection-labels"
                          className={`${field} min-w-0 flex-1`}
                          defaultValue={detection.label}
                          maxLength={80}
                          onBlur={(event) => relabel(detection.id, event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                        />
                        <button type="button" className={button} title="Edit the outline (double-click the object)" onClick={() => (editing?.id === detection.id ? changeMode("view") : startEditing(detection.id))}><Pencil aria-hidden className="h-3.5 w-3.5" />{editing?.id === detection.id ? "Done" : "Edit shape"}</button>
                        {detection.origin === "edited" && detection.original ? <button type="button" className={button} title="Go back to what the model found" onClick={() => revert(detection.id)}><RotateCcw aria-hidden className="h-3.5 w-3.5" />Revert</button> : null}
                        <button type="button" className={`${button} hover:text-destructive`} title="Delete (Del)" onClick={() => removeDetection(detection.id)}><Trash2 aria-hidden className="h-3.5 w-3.5" />Delete</button>
                      </div>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <dt className="text-muted-foreground">Source</dt>
                        <dd className="flex flex-wrap items-center gap-1">
                          {detection.origin === "model" ? `Model, ${detection.confidence.toFixed(3)}` : <OriginBadge origin={detection.origin} />}
                          {detection.origin === "edited" && detection.original ? <span className="text-muted-foreground">model {detection.original.confidence.toFixed(3)}{detection.original.label !== detection.label ? `, was “${detection.original.label}”` : ""}</span> : null}
                          {detection.editedAt ? <span className="text-muted-foreground">{new Date(detection.editedAt).toLocaleString()}</span> : null}
                        </dd>
                        <dt className="text-muted-foreground">Box (px)</dt><dd className="tabular-nums">{detection.box.map((value) => Math.round(value)).join(", ")}</dd>
                        <dt className="text-muted-foreground">Area</dt><dd className="tabular-nums">{formatNumber(area)} {scale.unit}²</dd>
                        <dt className="text-muted-foreground">Eq. diameter</dt><dd className="tabular-nums">{formatNumber(2 * Math.sqrt(area / Math.PI))} {scale.unit}</dd>
                        <dt className="text-muted-foreground">Perimeter</dt><dd className="tabular-nums">{formatNumber(detection.perimeter * length)} {scale.unit}</dd>
                        <dt className="text-muted-foreground">Circularity</dt><dd className="tabular-nums">{detection.perimeter > 0 ? formatNumber(Math.min(1, (4 * Math.PI * detection.area) / detection.perimeter ** 2), 3) : "–"}</dd>
                        <dt className="text-muted-foreground">Outline</dt>
                        <dd className="tabular-nums">{detection.shape === "box" ? "box" : detection.controlPoints ? `${detection.controlPoints.length} control points, ${detection.curve === "smooth" ? "smooth curve" : "straight edges"}` : `mask, ${detection.polygon.length} vertices`}</dd>
                      </dl>
                      </div>
                    );
                  })() : null}
                </div>
              ) : <p className="p-4 text-xs text-muted-foreground">No results yet. Add prompts and press Detect, tag objects by hand with the Tag tools, or open a saved detection file.</p>
            ) : null}

            {tab === "statistics" ? (
              <div>
                <section className="space-y-2 border-b border-border p-3 text-xs" aria-label="Scale">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">Scale</span>
                    <span className="text-muted-foreground">1 px =</span>
                    <NumberField
                      label="Length of one pixel"
                      className={`${field} w-24`}
                      min={1e-12}
                      step="any"
                      disabled={scale.unit === "px"}
                      value={scale.unit === "px" ? 1 : scale.perPixel}
                      onCommit={(perPixel) => setScale({ ...scale, perPixel })}
                    />
                    <select aria-label="Unit" className={field} value={scale.unit} onChange={(event) => setScale(event.target.value === "px" ? PIXEL_SCALE : { unit: event.target.value as LengthUnit, perPixel: scale.unit === "px" ? 1 : scale.perPixel })}>
                      {LENGTH_UNITS.map((unit) => <option key={unit} value={unit}>{unit === "px" ? "px (uncalibrated)" : unit}</option>)}
                    </select>
                    <button type="button" className={button} onClick={() => setMode("calibrate")}><Ruler aria-hidden className="h-3.5 w-3.5" />Measure scale bar</button>
                  </div>
                  {calibration ? (
                    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted px-2 py-1.5">
                      <span>The line is {calibration.pixels.toFixed(1)} px long. It measures</span>
                      <input type="number" aria-label="Scale bar length" autoFocus className={`${field} w-20`} min={0} step="any" value={calibration.length} onChange={(event) => setCalibration({ ...calibration, length: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") applyCalibration(); }} />
                      <select aria-label="Scale bar unit" className={field} value={calibration.unit} onChange={(event) => setCalibration({ ...calibration, unit: event.target.value as LengthUnit })}>
                        {LENGTH_UNITS.filter((unit) => unit !== "px").map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                      </select>
                      <button type="button" className={primary} disabled={!(Number.parseFloat(calibration.length) > 0)} onClick={applyCalibration}>Apply</button>
                      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setCalibration(null)}>Cancel</button>
                    </div>
                  ) : null}
                </section>
                {run && statistics ? <DetectionStatisticsView statistics={statistics} detections={visible} scale={scale} /> : <p className="p-4 text-xs text-muted-foreground">Statistics appear after a run.</p>}
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      <ReferenceDialog
        file={referenceFile}
        color={nextColor(prompts)}
        onCancel={() => setReferenceFile(null)}
        onAdd={(prompt: Omit<VisualPrompt, "id">) => {
          setPrompts((current) => [...current, { ...prompt, id: newPromptId() }]);
          setReferenceFile(null);
        }}
      />
    </div>
  );

  return createPortal(tool, document.body);
}
