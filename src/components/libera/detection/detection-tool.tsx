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
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatBytesIn } from "@/components/libera/audio/media-format";
import { DEFAULT_LAYERS, DetectionCanvas, type CanvasMode, type DetectionLayers } from "@/components/libera/detection/detection-canvas";
import {
  DetectionNotReady,
  buildDetectionFile,
  cancelDetectionSetup,
  cropThumbnail,
  detectionErrorMessage,
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
  DetectionFileError,
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
  /** The photo a loaded file was made for. */
  loadedFor?: string;
};
type Snapshot = { detections: Detection[]; removed: RemovedDetection[] };
const HISTORY_LIMIT = 100;

const ORIGIN_BADGES: Record<DetectionOrigin, { symbol: string; className: string } | null> = {
  model: null,
  edited: { symbol: "✱", className: "border-amber-500/60 text-amber-700 dark:text-amber-300" },
  manual: { symbol: "✎", className: "border-violet-500/60 text-violet-700 dark:text-violet-300" },
};

function OriginBadge({ origin }: { origin: DetectionOrigin }) {
  const t = useTranslations("detection.detectionTool");
  const badge = ORIGIN_BADGES[origin];
  if (!badge) return null;
  return <span className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 text-[10px] font-medium leading-4 ${badge.className}`} title={origin === "edited" ? t("editedHint") : t("manualHint")}><span aria-hidden>{badge.symbol}</span>{origin === "edited" ? t("originEdited") : t("originManual")}</span>;
}

const TAG_HINT_KEYS = {
  "tag-box": "tagBoxHint",
  "tag-polygon": "tagPolygonHint",
  "tag-freeform": "tagFreeformHint",
  edit: "editHint",
} as const;

const DEVICE_KEYS = { cpu: "deviceCpu", mps: "deviceMps", cuda: "deviceCuda" } as const;

let promptCounter = 0;
function newPromptId() {
  promptCounter += 1;
  return `p${Date.now().toString(36)}${promptCounter}`;
}

function promptsKey(prompts: DetectionPrompt[]) {
  return JSON.stringify(prompts.map((prompt) => (prompt.type === "text" ? [prompt.id, prompt.text] : [prompt.id, prompt.boxes, prompt.reference?.length ?? 0])));
}

const PHASE_KEYS: Record<NonNullable<DetectionStatus["job"]>["phase"], "phaseRuntime" | "phasePython" | "phasePackages" | "phaseWeights"> = {
  runtime: "phaseRuntime",
  python: "phasePython",
  packages: "phasePackages",
  weights: "phaseWeights",
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
  const t = useTranslations("detection.detectionTool");
  const tCommon = useTranslations("common");
  const tClient = useTranslations("detection.detectionClient");
  const tResults = useTranslations("lib.detection.results");
  const format = useFormatter();
  const locale = useLocale();
  const fixed = (value: number, digits: number) => format.number(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
      setStatusError(statusFailure instanceof Error ? statusFailure.message : t("checkModelError"));
      return null;
    }
  }, [t]);

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

  const label = tagLabel.trim() || prompts[0]?.label || t("defaultObject");
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
      label: t("visualPromptDefaultLabel", { number: current.filter((prompt) => prompt.type === "visual").length + 1 }),
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
      if (kept.length) setNotice(t("keptObjects", { count: kept.length }));
      setMinConfidence(settings.confidence);
      setSelectedId(null);
      setMode("view");
      setTab("detections");
    } catch (failure) {
      photoRef.current = null;
      if (failure instanceof DetectionNotReady) void refreshStatus();
      setError(detectionErrorMessage(failure, tClient));
    } finally {
      setRunning(false);
    }
  }

  async function install() {
    setError("");
    try {
      setStatus(await startDetectionSetup(variant));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("downloadStartError"));
    }
  }

  async function exportJson() {
    if (!run) return;
    const file = buildDetectionFile({ imageName: name, imageSource: source, result: run, prompts, scale, displayConfidence: threshold, createdAt: new Date().toISOString() });
    const base = name.replace(/\.[^.]+$/, "");
    if (await saveTextFile(`${base}.detections.json`, `${JSON.stringify(file, null, 2)}\n`, t("detectionResultsFilter"), "json", "application/json")) setNotice(t("detectionsSaved"));
  }

  async function exportCsv() {
    if (!run) return;
    const base = name.replace(/\.[^.]+$/, "");
    if (await saveTextFile(`${base}.detections.csv`, detectionsCsv(visible, scale), "CSV", "csv", "text/csv")) setNotice(t("tableSaved"));
  }

  async function openFile(file: File) {
    setError("");
    try {
      const parsed = parseDetectionFile(JSON.parse(await file.text()), { prompt: (number) => tResults("promptLabel", { number }), object: tResults("defaultObjectLabel") });
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
        loadedFrom: file.name,
        loadedFor: parsed.image.name || undefined,
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
      setNotice(t("loadedDetections", { count: parsed.detections.length }));
    } catch (failure) {
      setError(failure instanceof SyntaxError ? t("notValidJson") : failure instanceof DetectionFileError ? tResults(failure.code, failure.values) : failure instanceof Error ? failure.message : t("couldNotOpen"));
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
    setNotice(t("undone"));
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
    setNotice(t("scaleSet", { perPixel: formatNumber(value / calibration.pixels), unit: calibration.unit }));
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
    !status.runtime && { label: t("runtimeRequirement"), bytes: status.sizes.runtime, approximate: true },
    !status.textEncoder && { label: t("textEncoderRequirement"), bytes: status.sizes.textEncoder, approximate: false },
    !status.variants[variant] && { label: t("modelWeights", { name: variantInfo?.name ?? "YOLOE-26" }), bytes: status.sizes.variants[variant], approximate: false },
  ].filter(Boolean) as Array<{ label: string; bytes: number; approximate: boolean }> : [];

  const sortHeader = (key: SortKey, label: string, className = "") => (
    <th className={`px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground ${className}`}>
      <button type="button" className="inline-flex items-center gap-0.5 hover:text-foreground" onClick={() => setSort((current) => ({ key, descending: current.key === key ? !current.descending : key !== "id" && key !== "label" }))}>
        {label}{sort.key === key ? (sort.descending ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  const tool = (
    <div role="dialog" aria-modal="true" aria-label={t("dialogLabel", { name })} data-libera-overlay="" className="fixed inset-0 z-[45] flex flex-col bg-background text-foreground">
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
        <ScanSearch aria-hidden className="h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="mr-auto min-w-0">
          <h2 className="truncate text-sm font-semibold">{t("title")}</h2>
          <p className="truncate text-xs text-muted-foreground" title={source ?? name}>{name}{natural ? ` · ${natural.width} × ${natural.height}` : ""}</p>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="max-sm:hidden">{t("modelLabel")}</span>
          <select className={field} value={variant} disabled={!settings} onChange={(event) => setSettings((current) => current && { ...current, variant: event.target.value as DetectionVariantId })}>
            {(status?.catalog ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>{status?.variants[entry.id] ? entry.name : t("optionDownload", { name: entry.name })}</option>
            ))}
          </select>
        </label>
        <button type="button" className={primary} disabled={!ready || !prompts.length || running || !settings} title={t("detectTitle")} onClick={() => void detect()}>
          {running ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Play aria-hidden className="h-3.5 w-3.5" />}
          {running ? t("detecting") : t("detect")}
        </button>
        <span className="mx-1 h-6 w-px bg-border" />
        <button type="button" className={iconButton} aria-label={t("openDetectionFile")} title={t("openDetectionFileTitle")} onClick={() => openRef.current?.click()}><FolderOpen className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label={t("saveDetectionFile")} title={t("saveDetectionFileTitle")} disabled={!run} onClick={() => void exportJson()}><FileJson className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label={t("saveTableCsv")} title={t("saveTableCsvTitle")} disabled={!run} onClick={() => void exportCsv()}><Download className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label={t("detectionSettings")} title={t("detectionSettingsTitle")} onClick={() => void window.liberaPreferences?.open("detection")}><Settings2 className="h-4 w-4" /></button>
        <button type="button" className={iconButton} aria-label={tCommon("close")} title={t("closeTitle")} onClick={onClose}><X className="h-4 w-4" /></button>
        <input ref={openRef} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void openFile(file); }} />
        <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) setReferenceFile(file); }} />
      </header>

      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-1 rounded-lg bg-black/70 p-1 backdrop-blur" role="toolbar" aria-label={t("canvasTools")}>
            <button type="button" className={toolButton(mode === "view")} aria-pressed={mode === "view"} title={t("inspectTitle")} onClick={() => changeMode("view")}><Hand aria-hidden className="h-3.5 w-3.5" />{t("inspect")}</button>
            <button type="button" className={toolButton(mode === "draw")} aria-pressed={mode === "draw"} title={t("drawExampleTitle")} onClick={() => startDrawing(null)}><SquareDashed aria-hidden className="h-3.5 w-3.5" />{t("drawExample")}</button>
            <button type="button" className={toolButton(mode === "calibrate")} aria-pressed={mode === "calibrate"} title={t("setScaleTitle")} onClick={() => changeMode("calibrate")}><Ruler aria-hidden className="h-3.5 w-3.5" />{t("setScale")}</button>
            <span className="mx-0.5 h-5 w-px bg-white/20" />
            <span className="px-1 text-[11px] text-white/60">{t("tag")}</span>
            <button type="button" className={toolButton(mode === "tag-box")} aria-pressed={mode === "tag-box"} aria-label={t("tagWithBox")} title={t("tagWithBoxTitle")} onClick={() => changeMode("tag-box")}><Square aria-hidden className="h-3.5 w-3.5" /></button>
            <button type="button" className={toolButton(mode === "tag-polygon")} aria-pressed={mode === "tag-polygon"} aria-label={t("tagWithPolygon")} title={t("tagWithPolygonTitle")} onClick={() => changeMode("tag-polygon")}><Pentagon aria-hidden className="h-3.5 w-3.5" /></button>
            <button type="button" className={toolButton(mode === "tag-freeform")} aria-pressed={mode === "tag-freeform"} aria-label={t("tagFreehand")} title={t("tagFreehandTitle")} onClick={() => changeMode("tag-freeform")}><PenLine aria-hidden className="h-3.5 w-3.5" /></button>
            <button type="button" className={toolButton(false)} aria-label={tCommon("undo")} title={t("undoTitle")} disabled={!history.length} onClick={undo}><Undo2 aria-hidden className="h-3.5 w-3.5" /></button>
            <span className="mx-0.5 h-5 w-px bg-white/20" />
            <div className="relative">
              <button type="button" className={toolButton(layersOpen)} aria-expanded={layersOpen} onClick={() => setLayersOpen((open) => !open)}><Layers aria-hidden className="h-3.5 w-3.5" />{t("layers")}</button>
              {layersOpen ? (
                <div className="absolute left-0 top-9 w-48 space-y-1 rounded-lg border border-border bg-card p-2 text-xs text-foreground shadow-lg">
                  {([["masks", t("layerMasks")], ["boxes", t("layerBoxes")], ["labels", t("layerLabels")], ["centroids", t("layerCentroids")], ["density", t("layerQuadratDensity")], ["examples", t("layerPromptExamples")]] as Array<[keyof DetectionLayers, string]>).map(([key, label]) => (
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
              <label htmlFor="detection-tag-label" className="text-white/70">{t("tagLabel")}</label>
              <input
                id="detection-tag-label"
                list="detection-labels"
                className="w-36 rounded border border-white/20 bg-black/40 px-1.5 py-0.5 text-white placeholder:text-white/40"
                placeholder={prompts[0]?.label ?? t("defaultObject")}
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
                ? drawTarget ? t("drawAnotherHint", { label: prompts.find((prompt) => prompt.id === drawTarget)?.label ?? t("thisPrompt") }) : t("drawHint")
                : mode === "calibrate" ? t("calibrateHint") : t("stopHint", { hint: t(TAG_HINT_KEYS[mode as keyof typeof TAG_HINT_KEYS]) })}
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
                <span className="font-medium text-foreground">{t("objectsCount", { visible: visible.length, total: run.detections.length })}</span>
                {provenance.edited || provenance.manual ? <span>{t("provenanceFooter", { edited: provenance.edited, manual: provenance.manual, removed: run.removed.length })}</span> : null}
                {run.model ? <span>{t("modelDetails", { name: run.model.name, framework: run.model.framework, device: run.model.device.toUpperCase(), imageSize: String(run.model.imageSize), confidence: String(run.model.confidence), iou: String(run.model.iou) })}</span> : <span>{t("taggedByHand")}</span>}
                {typeof run.timing.inferenceMs === "number" ? <span>{t("inferenceTime", { ms: Math.round(run.timing.inferenceMs as number) })}</span> : null}
                {run.createdAt ? <span>{format.dateTime(new Date(run.createdAt), { dateStyle: "medium", timeStyle: "short" })}</span> : null}
                {run.loadedFrom ? <span title={run.loadedFrom}>{t("fromFile", { file: run.loadedFrom, image: run.loadedFor ?? "none" })}</span> : null}
              </>
            ) : <span>{t("footerEmpty")}</span>}
            {scale.unit !== "px" ? <span>{t("scaleFooter", { perPixel: formatNumber(scale.perPixel), unit: scale.unit })}</span> : null}
          </footer>
          {notice ? <div role="status" className="absolute bottom-12 left-1/2 -translate-x-1/2 rounded-full bg-white px-4 py-2 text-sm text-black shadow-lg">{notice}</div> : null}
        </div>

        <aside className="flex min-h-0 w-[26rem] shrink-0 xl:w-[32rem] flex-col border-l border-border bg-background max-md:h-[45vh] max-md:w-full max-md:border-l-0 max-md:border-t">
          {status && !ready ? (
            <section className="m-3 space-y-2 rounded-lg border border-border bg-card p-3 text-xs" aria-label={t("downloadModelLabel")}>
              <p className="text-sm font-semibold">{t("downloadModel", { name: variantInfo?.name ?? "YOLOE-26" })}</p>
              {job?.running ? (
                <div className="space-y-1.5">
                  <p>{t(PHASE_KEYS[job.phase])}</p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.totalBytes ? Math.round((job.downloadedBytes / job.totalBytes) * 100) : undefined}>
                    {job.totalBytes ? (
                      <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.min(100, (job.downloadedBytes / job.totalBytes) * 100)}%` }} />
                    ) : <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />}
                  </div>
                  {job.totalBytes ? <p className="text-muted-foreground">{t("ofProgress", { downloaded: formatBytesIn(locale, job.downloadedBytes), total: formatBytesIn(locale, job.totalBytes) })}</p> : null}
                  <button type="button" className={button} onClick={() => void cancelDetectionSetup().then(setStatus, () => undefined)}>{tCommon("cancel")}</button>
                </div>
              ) : (
                <>
                  <p className="text-muted-foreground">{t("runsLocally")}</p>
                  <ul className="space-y-0.5">
                    {missing.map((item) => <li key={item.label} className="flex justify-between gap-2"><span>{item.label}</span><span className="tabular-nums text-muted-foreground">{item.approximate ? t("aboutSize", { size: formatBytesIn(locale, item.bytes) }) : formatBytesIn(locale, item.bytes)}</span></li>)}
                  </ul>
                  {job?.error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{job.error}</p> : null}
                  <p className="text-[11px] text-muted-foreground">{t("downloadSources", { directory: status.directory })}</p>
                  <button type="button" className={primary} onClick={() => void install()}><Download aria-hidden className="h-3.5 w-3.5" />{job?.error ? tCommon("tryAgain") : t("downloadAndInstall")}</button>
                </>
              )}
            </section>
          ) : null}
          {statusError ? <p role="alert" className="m-3 text-xs text-destructive">{statusError}</p> : null}
          {error ? <p role="alert" className="mx-3 mt-3 flex gap-1.5 whitespace-pre-wrap rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive"><AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />{error}</p> : null}
          {sizeMismatch ? <p className="mx-3 mt-3 flex gap-1.5 rounded-md bg-muted px-2.5 py-2 text-xs"><AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />{t("sizeMismatch", { runWidth: String(run?.width), runHeight: String(run?.height), width: String(natural?.width), height: String(natural?.height) })}</p> : null}
          {stale ? <p className="mx-3 mt-3 rounded-md bg-muted px-2.5 py-2 text-xs">{t("promptsChanged")}</p> : null}

          <div className="mt-2 flex border-b border-border px-3" role="tablist">
            {([["prompts", t("tabPrompts", { count: prompts.length })], ["detections", run ? t("tabDetectionsCount", { count: visible.length }) : t("tabDetections")], ["statistics", t("tabStatistics")]] as Array<[Tab, string]>).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium ${tab === key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {tab === "prompts" ? (
              <div className="space-y-4 p-3 text-xs">
                <section className="space-y-2">
                  <label htmlFor="detection-text-prompt" className="font-medium">{t("textPrompts")}</label>
                  <div className="flex gap-1.5">
                    <input
                      id="detection-text-prompt"
                      className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
                      placeholder={t("textPromptPlaceholder")}
                      value={textDraft}
                      maxLength={2000}
                      onChange={(event) => setTextDraft(event.target.value)}
                      onKeyDown={(event) => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); addTextPrompts(); } }}
                    />
                    <button type="button" className={button} disabled={!textDraft.trim()} onClick={addTextPrompts}><Plus aria-hidden className="h-3.5 w-3.5" />{tCommon("add")}</button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t("textPromptHint")}</p>
                </section>
                <section className="space-y-2">
                  <p className="font-medium">{t("visualPrompts")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className={button} onClick={() => startDrawing(null)}><Crosshair aria-hidden className="h-3.5 w-3.5" />{t("drawOnPhoto")}</button>
                    <button type="button" className={button} onClick={() => uploadRef.current?.click()}><ImageUp aria-hidden className="h-3.5 w-3.5" />{t("uploadReference")}</button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t("visualPromptHint")}</p>
                </section>

                <section className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">{t("promptsHeading")}</p>
                    {prompts.length ? <button type="button" className="text-[11px] text-muted-foreground hover:text-destructive" onClick={() => { setPrompts([]); setDrawTarget(null); }}>{t("removeAll")}</button> : null}
                  </div>
                  {!prompts.length ? <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-muted-foreground">{t("noPromptsYet")}</p> : null}
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
                            aria-label={t("promptLabel")}
                            className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm hover:border-input focus:border-input focus:bg-background"
                            value={prompt.label}
                            maxLength={prompt.type === "text" ? 300 : 80}
                            onChange={(event) => updatePrompt(prompt.id, { label: event.target.value })}
                          />
                          <p className="px-1 text-[11px] text-muted-foreground">
                            {t("promptDetail", {
                              kind: prompt.type === "text" ? "text" : prompt.source === "photo" ? "photo" : "reference",
                              examples: prompt.type === "visual" ? prompt.boxes.length : 0,
                              name: prompt.type === "visual" ? prompt.name ?? t("referenceImageFallback") : "",
                              found: run ? countsByPrompt.get(prompt.id) ?? 0 : 0,
                            })}
                          </p>
                        </div>
                        {prompt.type === "visual" && prompt.source === "photo" ? (
                          <button type="button" className={iconButton} aria-label={t("addExampleTo", { label: prompt.label })} title={t("drawAnotherExample")} onClick={() => startDrawing(prompt.id)}><Plus className="h-4 w-4" /></button>
                        ) : null}
                        <button type="button" className={`${iconButton} hover:text-destructive`} aria-label={t("removePromptLabel", { label: prompt.label })} title={t("removePrompt")} onClick={() => removePrompt(prompt.id)}><Trash2 className="h-4 w-4" /></button>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-muted-foreground">{t("promptsCountedTogether")}</p>
                </section>

                {settings ? (
                  <details className="rounded-md border border-border bg-card px-2.5 py-2">
                    <summary className="cursor-pointer font-medium">{t("runSettings")}</summary>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <label className="space-y-1"><span className="text-muted-foreground">{t("confidenceAtLeast")}</span>
                        <NumberField className={`${field} w-full`} min={0.01} max={0.99} step={0.01} value={settings.confidence} onCommit={(confidence) => setSettings({ ...settings, confidence })} />
                      </label>
                      <label className="space-y-1"><span className="text-muted-foreground">{t("iou")}</span>
                        <NumberField className={`${field} w-full`} min={0.05} max={0.95} step={0.05} value={settings.iou} onCommit={(iou) => setSettings({ ...settings, iou })} />
                      </label>
                      <label className="space-y-1"><span className="text-muted-foreground">{t("inferenceSize")}</span>
                        <select className={`${field} w-full`} value={settings.imageSize} onChange={(event) => setSettings({ ...settings, imageSize: Number(event.target.value) as 640 | 960 | 1280 })}>
                          <option value={640}>640 px</option><option value={960}>960 px</option><option value={1280}>1280 px</option>
                        </select>
                      </label>
                      <label className="space-y-1"><span className="text-muted-foreground">{t("maxDetections")}</span>
                        <NumberField className={`${field} w-full`} min={1} max={3000} step={1} value={settings.maxDetections} onCommit={(maxDetections) => setSettings({ ...settings, maxDetections: Math.round(maxDetections) })} />
                      </label>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{t("runsOnDevice", { device: t(DEVICE_KEYS[settings.device]) })}</p>
                  </details>
                ) : null}
              </div>
            ) : null}

            {tab === "detections" ? (
              run ? (
                <div className="text-xs">
                  <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-border bg-background px-3 py-2">
                    <label htmlFor="detection-min-confidence" className="shrink-0 text-muted-foreground">{t("confidenceFilter")}</label>
                    <input id="detection-min-confidence" type="range" className="min-w-0 flex-1" min={Math.min(run.model?.confidence || 0, 0.99)} max={0.99} step={0.01} value={threshold} onChange={(event) => setMinConfidence(Number(event.target.value))} />
                    <span className="w-9 text-right tabular-nums">{fixed(threshold, 2)}</span>
                  </div>
                  {visible.length ? (
                    <table className="w-full border-collapse">
                      <thead className="sticky top-[41px] bg-muted/90">
                        <tr>
                          {sortHeader("id", "#")}
                          {sortHeader("label", t("tableLabelHeader"))}
                          {sortHeader("confidence", t("conf"))}
                          <th className="px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground">{t("source")}</th>
                          {sortHeader("area", t("areaHeader", { unit: scale.unit }))}
                          <th className="px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground">{t("centroidHeader", { unit: scale.unit })}</th>
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
                            <td className="px-2 py-1 tabular-nums">{detection.origin === "manual" ? "–" : fixed(detection.confidence, 3)}</td>
                            <td className="px-2 py-1">{detection.origin === "model" ? <span className="text-muted-foreground">{t("modelSource")}</span> : <OriginBadge origin={detection.origin} />}</td>
                            <td className="px-2 py-1 tabular-nums">{formatNumber(detection.area * length * length)}</td>
                            <td className="px-2 py-1 tabular-nums">{formatNumber(detection.centroid[0] * length)}, {formatNumber(detection.centroid[1] * length)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <p className="p-4 text-muted-foreground">{t("nothingAtConfidence")}</p>}
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
                          aria-label={t("objectLabel")}
                          list="detection-labels"
                          className={`${field} min-w-0 flex-1`}
                          defaultValue={detection.label}
                          maxLength={80}
                          onBlur={(event) => relabel(detection.id, event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                        />
                        <button type="button" className={button} title={t("editOutlineTitle")} onClick={() => (editing?.id === detection.id ? changeMode("view") : startEditing(detection.id))}><Pencil aria-hidden className="h-3.5 w-3.5" />{editing?.id === detection.id ? tCommon("done") : t("editShape")}</button>
                        {detection.origin === "edited" && detection.original ? <button type="button" className={button} title={t("revertTitle")} onClick={() => revert(detection.id)}><RotateCcw aria-hidden className="h-3.5 w-3.5" />{t("revert")}</button> : null}
                        <button type="button" className={`${button} hover:text-destructive`} title={t("deleteTitle")} onClick={() => removeDetection(detection.id)}><Trash2 aria-hidden className="h-3.5 w-3.5" />{tCommon("delete")}</button>
                      </div>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                        <dt className="text-muted-foreground">{t("source")}</dt>
                        <dd className="flex flex-wrap items-center gap-1">
                          {detection.origin === "model" ? t("modelWithConfidence", { confidence: fixed(detection.confidence, 3) }) : <OriginBadge origin={detection.origin} />}
                          {detection.origin === "edited" && detection.original ? <span className="text-muted-foreground">{t("modelWas", { confidence: fixed(detection.original.confidence, 3), was: detection.original.label !== detection.label ? detection.original.label : "none" })}</span> : null}
                          {detection.editedAt ? <span className="text-muted-foreground">{format.dateTime(new Date(detection.editedAt), { dateStyle: "medium", timeStyle: "short" })}</span> : null}
                        </dd>
                        <dt className="text-muted-foreground">{t("boxPx")}</dt><dd className="tabular-nums">{detection.box.map((value) => Math.round(value)).join(", ")}</dd>
                        <dt className="text-muted-foreground">{t("area")}</dt><dd className="tabular-nums">{formatNumber(area)} {scale.unit}²</dd>
                        <dt className="text-muted-foreground">{t("eqDiameter")}</dt><dd className="tabular-nums">{formatNumber(2 * Math.sqrt(area / Math.PI))} {scale.unit}</dd>
                        <dt className="text-muted-foreground">{t("perimeter")}</dt><dd className="tabular-nums">{formatNumber(detection.perimeter * length)} {scale.unit}</dd>
                        <dt className="text-muted-foreground">{t("circularity")}</dt><dd className="tabular-nums">{detection.perimeter > 0 ? formatNumber(Math.min(1, (4 * Math.PI * detection.area) / detection.perimeter ** 2), 3) : "–"}</dd>
                        <dt className="text-muted-foreground">{t("outline")}</dt>
                        <dd className="tabular-nums">{detection.shape === "box" ? t("outlineBox") : detection.controlPoints ? t("outlineControlPoints", { count: detection.controlPoints.length, curve: detection.curve === "smooth" ? t("curveSmooth") : t("curveStraight") }) : t("outlineMask", { count: detection.polygon.length })}</dd>
                      </dl>
                      </div>
                    );
                  })() : null}
                </div>
              ) : <p className="p-4 text-xs text-muted-foreground">{t("noResults")}</p>
            ) : null}

            {tab === "statistics" ? (
              <div>
                <section className="space-y-2 border-b border-border p-3 text-xs" aria-label={t("scaleSectionLabel")}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{t("scale")}</span>
                    <span className="text-muted-foreground">{t("onePixelEquals")}</span>
                    <NumberField
                      label={t("lengthOfPixel")}
                      className={`${field} w-24`}
                      min={1e-12}
                      step="any"
                      disabled={scale.unit === "px"}
                      value={scale.unit === "px" ? 1 : scale.perPixel}
                      onCommit={(perPixel) => setScale({ ...scale, perPixel })}
                    />
                    <select aria-label={t("unitLabel")} className={field} value={scale.unit} onChange={(event) => setScale(event.target.value === "px" ? PIXEL_SCALE : { unit: event.target.value as LengthUnit, perPixel: scale.unit === "px" ? 1 : scale.perPixel })}>
                      {LENGTH_UNITS.map((unit) => <option key={unit} value={unit}>{unit === "px" ? t("pxUncalibrated") : unit}</option>)}
                    </select>
                    <button type="button" className={button} onClick={() => setMode("calibrate")}><Ruler aria-hidden className="h-3.5 w-3.5" />{t("measureScaleBar")}</button>
                  </div>
                  {calibration ? (
                    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-muted px-2 py-1.5">
                      <span>{t("calibrationLine", { pixels: fixed(calibration.pixels, 1) })}</span>
                      <input type="number" aria-label={t("scaleBarLength")} autoFocus className={`${field} w-20`} min={0} step="any" value={calibration.length} onChange={(event) => setCalibration({ ...calibration, length: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") applyCalibration(); }} />
                      <select aria-label={t("scaleBarUnit")} className={field} value={calibration.unit} onChange={(event) => setCalibration({ ...calibration, unit: event.target.value as LengthUnit })}>
                        {LENGTH_UNITS.filter((unit) => unit !== "px").map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                      </select>
                      <button type="button" className={primary} disabled={!(Number.parseFloat(calibration.length) > 0)} onClick={applyCalibration}>{tCommon("apply")}</button>
                      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setCalibration(null)}>{tCommon("cancel")}</button>
                    </div>
                  ) : null}
                </section>
                {run && statistics ? <DetectionStatisticsView statistics={statistics} detections={visible} scale={scale} /> : <p className="p-4 text-xs text-muted-foreground">{t("statisticsAfterRun")}</p>}
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
