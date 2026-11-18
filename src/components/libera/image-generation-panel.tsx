"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { FolderOpen, ImagePlus, Images, Loader2, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { apiRequest } from "@/components/libera/api-client";
import { AiPanelGlow } from "./ai-activity-ui";
import { createDeferredSave, registerStateFlusher, stateRequestKeepalive } from "./deferred-save";
import { applyGallery, refreshGallery, subscribeReusePrompt, subscribeReferenceRequests, useGallery } from "@/components/libera/gallery-store";
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  IMAGE_PARAMETER_LABELS,
  IMAGE_PARAMETER_ORDER,
  MAX_REFERENCE_IMAGE_EDGE,
  REFERENCE_IMAGE_TYPES,
  validParameterValues,
  type GalleryContents,
  type ImageGenerationDestination,
  type ImageGenerationModel,
  type ImageGenerationSettings,
  type ImageParameterDescriptor,
  type ImageParameterValues,
} from "@/lib/image-generation";
import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";

const PROMPT_STORAGE_KEY = "libera.imageGeneration.prompt";
const NEW_ALBUM = "\u0000new-album";
const label = "mb-1.5 block px-1 text-xs font-medium text-muted-foreground";
const field = "libera-panel-field h-9 w-full px-2.5 text-[13px]";
const section = "px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground";

type FolderOption = { path: string; label: string };
type ReferencePhoto = { id: string; name: string; dataUrl: string };
type T = ReturnType<typeof useTranslations>;

/** Photos sent as-is when they are already small; larger ones are scaled down first. */
const SEND_AS_IS_BYTES = 4 * 1024 * 1024;

function readAsDataUrl(blob: Blob, t: T) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(t("couldNotReadPhotoPlain")));
    reader.readAsDataURL(blob);
  });
}

async function prepareReference(blob: Blob, name: string, t: T): Promise<ReferencePhoto> {
  if (!blob.type.startsWith("image/")) throw new Error(t("notAnImage", { name }));
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { throw new Error(t("couldNotReadPhoto", { name })); }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (REFERENCE_IMAGE_TYPES.includes(blob.type) && longest <= MAX_REFERENCE_IMAGE_EDGE && blob.size <= SEND_AS_IS_BYTES) {
      return { id: crypto.randomUUID(), name, dataUrl: await readAsDataUrl(blob, t) };
    }
    const scale = Math.min(1, MAX_REFERENCE_IMAGE_EDGE / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Keep transparency for formats that may have it; photos compress better as JPEG.
    const type = blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
    return { id: crypto.randomUUID(), name, dataUrl: canvas.toDataURL(type, 0.9) };
  } finally {
    bitmap.close();
  }
}

/** Notebooks and their folders, as `Notebook / Folder` labels. */
export function folderOptions(tree: LiberaTree): FolderOption[] {
  const options: FolderOption[] = [];
  function visit(nodes: LiberaTreeNode[], trail: string) {
    for (const node of nodes) {
      if (node.kind !== "folder" || node.name === "_archive") continue;
      const nextTrail = `${trail} / ${node.name}`;
      options.push({ path: node.path, label: nextTrail });
      visit(node.children, nextTrail);
    }
  }
  for (const notebook of tree.notebooks) {
    options.push({ path: notebook.name, label: notebook.name });
    visit(notebook.children, notebook.name);
  }
  return options;
}

function readStoredPrompt() {
  try { return window.localStorage.getItem(PROMPT_STORAGE_KEY) ?? ""; } catch { return ""; }
}

function storePrompt(prompt: string) {
  try {
    if (readStoredPrompt() !== prompt) window.localStorage.setItem(PROMPT_STORAGE_KEY, prompt);
  } catch { /* storage unavailable */ }
}

/** Draws a small frame in the shape of an aspect ratio such as `16:9`. */
function RatioGlyph({ ratio }: { ratio: string }) {
  const [width, height] = ratio.split(":").map(Number);
  if (!width || !height) return <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] border border-dashed border-current" />;
  const scale = 14 / Math.max(width, height);
  return <span aria-hidden className="rounded-[2px] border-[1.5px] border-current" style={{ width: Math.max(4, width * scale), height: Math.max(4, height * scale) }} />;
}

function ParameterControl({ name, descriptor, value, disabled, onChange }: {
  name: string;
  descriptor: ImageParameterDescriptor;
  value: ImageParameterValues[string] | undefined;
  disabled: boolean;
  onChange: (value: ImageParameterValues[string] | undefined) => void;
}) {
  const t = useTranslations("imageGenerationPanel");
  const id = `image-generation-${name}`;
  const title = t.has(`parameter.${name}`) ? t(`parameter.${name}`) : IMAGE_PARAMETER_LABELS[name] ?? name;
  // Values come from the model; known words are translated, anything else (1K, png, …) is shown as given.
  const optionLabel = (option: string) => name === "output_format" ? option.toUpperCase() : t.has(`value.${option}`) ? t(`value.${option}`) : option;

  if (descriptor.type === "enum" && name === "aspect_ratio") {
    return <fieldset>
      <legend className={label}>{title}</legend>
      <div className="grid grid-cols-4 gap-1.5">
        {descriptor.values.map((ratio) => {
          const selected = value === ratio;
          return <button key={ratio} type="button" disabled={disabled} aria-pressed={selected} title={ratio === "auto" ? t("letModelDecide") : ratio}
            className="libera-panel-tile flex h-12 flex-col items-center justify-center gap-1 text-[11px]"
            onClick={() => onChange(selected ? undefined : ratio)}>
            <span className="flex h-4 items-center"><RatioGlyph ratio={ratio} /></span>
            {ratio === "auto" ? t("auto") : ratio}
          </button>;
        })}
      </div>
    </fieldset>;
  }

  if (descriptor.type === "enum") {
    return <div>
      <label className={label} htmlFor={id}>{title}</label>
      <select id={id} className={field} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">{t("modelDefault")}</option>
        {descriptor.values.map((option) => <option key={option} value={option}>{optionLabel(option)}</option>)}
      </select>
    </div>;
  }

  if (descriptor.type === "range") {
    if (descriptor.max <= descriptor.min) return null;
    const current = typeof value === "number" ? value : undefined;
    if (name === "output_compression") {
      return <div>
        <label className={label} htmlFor={id}>{title} <span className="font-normal">{current === undefined ? t("outputCompressionModelDefault") : `· ${current}`}</span></label>
        <input id={id} type="range" className="libera-panel-range w-full" disabled={disabled} min={descriptor.min} max={descriptor.max} value={current ?? descriptor.max}
          onChange={(event) => onChange(Number(event.target.value))} />
      </div>;
    }
    return <div>
      <label className={label} htmlFor={id}>{title}</label>
      <input id={id} type="number" inputMode="numeric" className={field} disabled={disabled} min={descriptor.min} max={descriptor.max} step={1} placeholder={String(descriptor.min)} value={current ?? ""}
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          onChange(Number.isFinite(next) ? Math.min(descriptor.max, Math.max(descriptor.min, Math.round(next))) : undefined);
        }} />
    </div>;
  }

  if (name === "seed") {
    return <div>
      <label className={label} htmlFor={id}>{title}</label>
      <input id={id} type="number" inputMode="numeric" className={field} disabled={disabled} min={0} step={1} placeholder={t("random")} value={typeof value === "number" ? value : ""}
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          onChange(Number.isFinite(next) && next >= 0 ? Math.round(next) : undefined);
        }} />
    </div>;
  }

  return null;
}

export function ImageGenerationPanel({ tree, onFilesSaved, onOpenFile }: {
  tree: LiberaTree;
  onFilesSaved: (files: LiberaFileNode[], tree: LiberaTree) => void;
  onOpenFile: (file: LiberaFileNode) => void;
}) {
  const t = useTranslations("imageGenerationPanel");
  const tc = useTranslations("common");
  const format = useFormatter();
  const gallery = useGallery();
  const [settings, setSettings] = useState<ImageGenerationSettings | null>(null);
  const [models, setModels] = useState<ImageGenerationModel[] | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [prompt, setPrompt] = useState(readStoredPrompt);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ files?: LiberaFileNode[]; photos?: string[]; cost?: number } | null>(null);
  const [newAlbum, setNewAlbum] = useState<string | null>(null);
  const [references, setReferences] = useState<ReferencePhoto[]>([]);
  const [addingReferences, setAddingReferences] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const latestPreferences = useRef({ settings, prompt });
  useLayoutEffect(() => { latestPreferences.current = { settings, prompt }; }, [settings, prompt]);
  const settingsWriter = useMemo(() => createDeferredSave(async (body) => {
    await apiRequest("/api/image-generation/settings", { method: "PUT", body, keepalive: stateRequestKeepalive(body) });
  }, () => setError(t("settingsSaveFailed"))), [t]);
  const flushSettings = useCallback(() => {
    const latest = latestPreferences.current;
    storePrompt(latest.prompt);
    if (latest.settings) settingsWriter.schedule(latest.settings);
    return settingsWriter.flush();
  }, [settingsWriter]);

  useEffect(() => {
    let disposed = false;
    void apiRequest<ImageGenerationSettings>("/api/image-generation/settings")
      .then((loaded) => { if (!disposed) { settingsWriter.markSaved(loaded); setSettings(loaded); } })
      .catch(() => {
        if (!disposed) {
          // Opening/closing after a failed read must not overwrite saved settings.
          settingsWriter.markSaved(DEFAULT_IMAGE_GENERATION_SETTINGS);
          setSettings(DEFAULT_IMAGE_GENERATION_SETTINGS);
        }
      });
    void apiRequest<{ models: ImageGenerationModel[] }>("/api/image-generation/models")
      .then(({ models: loaded }) => { if (!disposed) setModels([...loaded].sort((first, second) => first.name.localeCompare(second.name))); })
      .catch((failure: Error) => { if (!disposed) { setModels([]); setModelsError(failure.message); } });
    if (!gallery.contents) void refreshGallery();
    return () => { disposed = true; };
    // Load once when the tab opens; the gallery store is shared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addReferences(sources: Array<{ blob: Blob | Promise<Blob>; name: string }>) {
    if (!sources.length) return;
    setAddingReferences(true);
    setError("");
    const added: ReferencePhoto[] = [];
    const failures: string[] = [];
    for (const source of sources) {
      try { added.push(await prepareReference(await source.blob, source.name, t)); } catch (failure) {
        failures.push(failure instanceof Error ? failure.message : t("couldNotAddReference", { name: source.name }));
      }
    }
    setReferences((current) => [...current, ...added]);
    if (failures.length) setError(failures.join(" "));
    setAddingReferences(false);
  }

  useEffect(() => subscribeReferenceRequests((photos) => {
    void addReferences(photos.map((photo) => ({
      name: photo.name,
      blob: fetch(photo.url).then((response) => {
        if (!response.ok) throw new Error(t("couldNotLoadReference", { name: photo.name }));
        return response.blob();
      }),
    })));
    // Subscribed once; the language only changes with a restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useEffect(() => subscribeReusePrompt((next) => {
    setPrompt(next);
    storePrompt(next);
    promptRef.current?.focus();
  }), []);

  // Save on field commits, generation, and close, rather than typing or timers.
  useEffect(() => {
    const unregister = registerStateFlusher(flushSettings);
    return () => {
      unregister();
      void flushSettings().catch(() => undefined);
      abortRef.current?.abort();
    };
  }, [flushSettings]);

  function updateSettings(change: (current: ImageGenerationSettings) => ImageGenerationSettings) {
    setSettings((current) => (current ? change(current) : current));
  }

  const model = models?.find((entry) => entry.id === settings?.model);
  const params = settings ? settings.paramsByModel[settings.model] ?? {} : {};
  const folders = useMemo(() => folderOptions(tree), [tree]);
  const albums = gallery.contents?.albums ?? [];
  const destination = settings?.destination ?? DEFAULT_IMAGE_GENERATION_SETTINGS.destination;
  const folderMissing = destination.kind === "folder" && !folders.some((folder) => folder.path === destination.path);
  // Settings saved by the first version name the album instead of using its id.
  const destinationAlbum = destination.kind === "gallery" && destination.album
    ? albums.find((album) => album.id === destination.album) ?? albums.find((album) => album.name.toLowerCase() === destination.album.toLowerCase())
    : undefined;
  const albumMissing = destination.kind === "gallery" && Boolean(destination.album) && Boolean(gallery.contents) && !destinationAlbum;
  const referenceLimit = model?.references ?? { min: 0, max: 0 };
  const referencesFit = references.length >= referenceLimit.min && references.length <= referenceLimit.max;
  const ready = Boolean(settings && model && prompt.trim()) && referencesFit && !folderMissing && !generating && !addingReferences;

  function setParam(name: string, value: ImageParameterValues[string] | undefined) {
    updateSettings((current) => {
      const nextParams = { ...(current.paramsByModel[current.model] ?? {}) };
      if (value === undefined) delete nextParams[name];
      else nextParams[name] = value;
      return { ...current, paramsByModel: { ...current.paramsByModel, [current.model]: nextParams } };
    });
  }

  function setDestination(next: ImageGenerationDestination) {
    updateSettings((current) => ({ ...current, destination: next }));
  }

  async function generate() {
    if (!settings || !model || !ready) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setError("");
    setResult(null);
    try {
      void flushSettings().catch(() => undefined);
      const response = await apiRequest<{ files?: LiberaFileNode[]; photos?: string[]; cost?: number; tree?: LiberaTree }>("/api/image-generation", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          prompt: prompt.trim(),
          model: model.id,
          params: validParameterValues(model, params),
          destination,
          ...(references.length ? { references: references.map((reference) => reference.dataUrl) } : {}),
        }),
      });
      setResult(response);
      if (response.files && response.tree) onFilesSaved(response.files, response.tree);
      if (response.photos) await refreshGallery();
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("couldNotGenerate"));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
      void flushSettings().catch(() => undefined);
    }
  }

  async function createAlbumForDestination(name: string) {
    try {
      const response = await apiRequest<{ album: { id: string }; gallery: GalleryContents }>("/api/gallery/albums", { method: "POST", body: JSON.stringify({ name }) });
      applyGallery(response.gallery);
      setDestination({ kind: "gallery", album: response.album.id });
      setNewAlbum(null);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("couldNotCreateAlbum"));
    }
  }

  const parameterNames = model ? IMAGE_PARAMETER_ORDER.filter((name) => model.parameters[name]) : [];

  // The glow reaches into the tab panel's right padding so it spans the whole panel.
  return <div className="relative -mr-1.5 flex min-h-0 flex-1 flex-col overflow-hidden">
    <AiPanelGlow active={generating} />
    <div className="relative flex min-h-0 flex-1 flex-col pr-1.5">
      <div className="libera-notebook-heading flex items-center justify-between px-3 pb-2 pt-4">
        <h2 className="min-w-0 truncate text-sm font-semibold">{t("createImages")}</h2>
        <span className="inline-flex h-[29px] w-[29px] items-center justify-center text-muted-foreground"><Images aria-hidden className="h-4 w-4" /></span>
      </div>
      <form className={`min-h-0 flex-1 space-y-5 overflow-auto px-3 pb-4 pt-1 ${dragging ? "outline-2 -outline-offset-4 outline-dashed outline-[#457be6]/60" : ""}`}
        onSubmit={(event) => { event.preventDefault(); void generate(); }}
        onBlurCapture={() => { void flushSettings().catch(() => undefined); }}
        onPointerUp={(event) => {
          if (event.target instanceof HTMLInputElement && event.target.type === "range") void flushSettings().catch(() => undefined);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragging(false);
          void addReferences([...event.dataTransfer.files].map((file) => ({ blob: file, name: file.name })));
        }}>
        <div>
          <label className={label} htmlFor="image-generation-prompt">{t("prompt")}</label>
          <textarea id="image-generation-prompt" ref={promptRef} rows={5} placeholder={t("promptPlaceholder")}
            className="libera-panel-field w-full resize-y px-3 py-2.5 text-[13px] leading-relaxed"
            value={prompt}
            onChange={(event) => { setPrompt(event.target.value); }}
            onPaste={(event) => {
              const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
              if (!images.length) return;
              event.preventDefault();
              void addReferences(images.map((file, index) => ({ blob: file, name: file.name || t("pastedImage", { number: index + 1 }) })));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void generate();
              }
            }} />
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="px-1 text-xs font-medium text-muted-foreground" id="image-generation-references">{t("referencePhotos")}</span>
            {model && referenceLimit.max > 0 && <span className={`pr-1 text-[11px] tabular-nums ${referencesFit ? "text-muted-foreground" : "text-destructive"}`}>{t("referenceCount", { count: references.length, max: referenceLimit.max, min: referenceLimit.min })}</span>}
          </div>
          <div className="grid grid-cols-4 gap-1.5" role="group" aria-labelledby="image-generation-references">
            {references.map((reference) => <div key={reference.id} className="libera-panel-tile group/reference relative aspect-square overflow-hidden" title={reference.name}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local data URL preview */}
              <img src={reference.dataUrl} alt={reference.name} className="h-full w-full object-cover" />
              <button type="button" aria-label={t("removeReference", { name: reference.name })} disabled={generating}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition focus-visible:opacity-100 group-hover/reference:opacity-100"
                onClick={() => setReferences((current) => current.filter((item) => item.id !== reference.id))}>
                <X aria-hidden className="h-3 w-3" />
              </button>
            </div>)}
            {(referenceLimit.max === 0 || references.length < referenceLimit.max) && <button type="button" disabled={generating || addingReferences || (Boolean(model) && referenceLimit.max === 0)}
              title={model && referenceLimit.max === 0 ? t("modelNoReferences", { model: model.name }) : t("addPhotosTitle")}
              data-dashed="true" className="libera-panel-tile flex aspect-square flex-col items-center justify-center gap-1 text-[11px]"
              onClick={() => fileInputRef.current?.click()}>
              {addingReferences ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <ImagePlus aria-hidden className="h-4 w-4" />}
              {tc("add")}
            </button>}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" multiple hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              void addReferences(files.map((file) => ({ blob: file, name: file.name })));
            }} />
          <p className="mt-1.5 px-1 text-xs leading-relaxed text-muted-foreground">{model && referenceLimit.max === 0
            ? t("promptOnlyModel", { model: model.name })
            : references.length > referenceLimit.max
              ? t("modelTakesUpTo", { max: referenceLimit.max, count: references.length - referenceLimit.max })
              : t("uploadDropPaste")}</p>
        </div>

        <div>
          <label className={label} htmlFor="image-generation-model">{t("model")}</label>
          <select id="image-generation-model" className={field} disabled={!settings || !models?.length || generating} value={settings?.model ?? ""}
            onChange={(event) => updateSettings((current) => ({ ...current, model: event.target.value }))}>
            {settings && models && !model && <option value={settings.model}>{models.length ? t("modelUnavailable", { model: settings.model }) : settings.model}</option>}
            {models?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          {!models && <p className="mt-1.5 px-1 text-xs text-muted-foreground">{t("loadingModels")}</p>}
          {modelsError && <p role="alert" className="mt-1.5 px-1 text-xs text-destructive">{modelsError}</p>}
          {model?.description && <p className="mt-1.5 line-clamp-2 px-1 text-xs leading-relaxed text-muted-foreground" title={model.description}>{model.description}</p>}
        </div>

        {parameterNames.length > 0 && <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className={section}>{tc("settings")}</h3>
            {Object.keys(params).length > 0 && <button type="button" className="libera-sidebar-icon-button inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs" disabled={generating}
              onClick={() => updateSettings((current) => ({ ...current, paramsByModel: { ...current.paramsByModel, [current.model]: {} } }))}>
              <RotateCcw aria-hidden className="h-3 w-3" />{tc("reset")}
            </button>}
          </div>
          {parameterNames.map((name) => <ParameterControl key={`${model?.id}-${name}`} name={name} descriptor={model!.parameters[name]} value={params[name]} disabled={generating} onChange={(value) => setParam(name, value)} />)}
        </div>}

        <fieldset className="space-y-2">
          <legend className={label}>{t("saveTo")}</legend>
          <div className="libera-panel-segmented" role="group" aria-label={t("saveDestination")}>
            <button type="button" aria-pressed={destination.kind === "gallery"} disabled={generating}
              onClick={() => setDestination({ kind: "gallery", album: destination.kind === "gallery" ? destination.album : "" })}>{t("gallery")}</button>
            <button type="button" aria-pressed={destination.kind === "folder"} disabled={generating || !folders.length}
              onClick={() => setDestination({ kind: "folder", path: destination.kind === "folder" ? destination.path : folders[0]?.path ?? "" })}>{t("notebookFolder")}</button>
          </div>
          {destination.kind === "gallery" ? <>
            {newAlbum === null ? <select aria-label={t("album")} className={field} disabled={generating} value={destinationAlbum?.id ?? ""}
              onChange={(event) => {
                if (event.target.value === NEW_ALBUM) setNewAlbum("");
                else setDestination({ kind: "gallery", album: event.target.value });
              }}>
              <option value="">{t("photosNoAlbum")}</option>
              {albums.map((album) => <option key={album.id} value={album.id}>{album.name}</option>)}
              <option value={NEW_ALBUM}>{t("newAlbum")}</option>
            </select> : <div className="flex gap-1.5">
              <input autoFocus aria-label={t("newAlbumName")} maxLength={120} className={field} placeholder={t("albumName")} value={newAlbum}
                onChange={(event) => setNewAlbum(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); if (newAlbum.trim()) void createAlbumForDestination(newAlbum.trim()); }
                  if (event.key === "Escape") { event.preventDefault(); setNewAlbum(null); }
                }} />
              <button type="button" className="libera-panel-button shrink-0 px-3" disabled={!newAlbum.trim()} onClick={() => void createAlbumForDestination(newAlbum.trim())}>{t("create")}</button>
            </div>}
            {albumMissing && <p className="px-1 text-xs text-muted-foreground">{t("albumDeleted")}</p>}
          </> : <>
            <select aria-label={t("notebookFolder")} className={field} disabled={generating} value={folderMissing ? "" : destination.path}
              onChange={(event) => setDestination({ kind: "folder", path: event.target.value })}>
              {folderMissing && <option value="">{t("chooseFolder")}</option>}
              {folders.map((folder) => <option key={folder.path} value={folder.path}>{folder.label}</option>)}
            </select>
            <p className="px-1 text-xs leading-relaxed text-muted-foreground">{folderMissing ? t("folderUnavailable", { path: destination.path }) : t("imagesStayInNotebook")}</p>
          </>}
        </fieldset>

        {error && <div role="alert" className="rounded-lg bg-destructive-muted p-3 text-xs leading-relaxed text-destructive">{error}</div>}

        {generating ? <button type="button" className="libera-panel-button w-full gap-2 px-4 py-2.5 text-[13px]" onClick={() => abortRef.current?.abort()}>
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />{t("generating")} <span className="inline-flex items-center gap-1 text-muted-foreground"><Square aria-hidden className="h-3 w-3" />{tc("stop")}</span>
        </button> : <button type="submit" disabled={!ready} className="libera-panel-primary w-full px-4 py-2.5" title={t("generateTitle")}>
          <Sparkles aria-hidden className="h-4 w-4" />{t("generate")}
        </button>}

        {result && <div role="status" className="libera-panel-card p-3 text-xs leading-relaxed">
          {result.photos ? <p>{t("imagesSavedToGallery", { count: result.photos.length })}</p> : null}
          {result.files?.map((file) => <button key={file.path} type="button" className="flex w-full items-center gap-2 rounded-md py-1 text-left hover:text-[#457be6]" onClick={() => onOpenFile(file)}>
            <FolderOpen aria-hidden className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 truncate">{t("openFile", { name: file.name })}</span>
          </button>)}
          {typeof result.cost === "number" && <p className="mt-1 text-muted-foreground">{t("cost", { amount: format.number(result.cost, { style: "currency", currency: "USD", minimumFractionDigits: 3 }) })}</p>}
        </div>}
      </form>
    </div>
  </div>;
}
