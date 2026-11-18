"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  AudioLines,
  BookMarked,
  Code2,
  Download,
  FileText,
  FileType2,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  ImagePlus,
  Images,
  Lightbulb,
  Loader2,
  MessageCircleQuestion,
  ScanSearch,
  Search,
  Settings2,
  Sigma,
  Sparkles,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { openLocalModelDialog } from "@/components/libera/local-models/local-model-client";
import { GalleryPhotoPicker } from "@/components/libera/gallery-photo-picker";
import { IndexMismatch, IndexSetup } from "@/components/libera/global-search/index-setup";
import { LibraryImagePicker } from "@/components/libera/global-search/library-image-picker";
import { SearchPreview, clearSearchPreviewCache } from "@/components/libera/global-search/search-preview";
import {
  SearchQueryInput,
  imageFileToDataUrl,
  type SearchQueryInputHandle,
} from "@/components/libera/global-search/search-query-input";
import {
  SearchResults,
  searchEntries,
  type SearchEntry,
  type SearchSelection,
} from "@/components/libera/global-search/search-results";
import {
  onSearchRequest,
  rememberSearch,
  useSearchStatusPolling,
  useSearchStore,
} from "@/components/libera/global-search/search-store";
import {
  searchQueryPlainText,
  type SearchFileKind,
  type SearchImageRef,
  type SearchIndexStatus,
  type SearchQueryPart,
  type SearchResponse,
} from "@/lib/global-search";
import type { MathMarkerSettings } from "@/lib/math-markers";
import type { LiberaFileNode } from "@/lib/types";

type KindFilter = "all" | SearchFileKind;

// Each kind keeps its color in the chip and when selected.
const KIND_FILTERS: Array<{ id: KindFilter; icon: LucideIcon; color: string }> = [
  { id: "all", icon: Layers, color: "#7a8299" },
  { id: "markdown", icon: FileText, color: "#5b8def" },
  { id: "pdf", icon: FileType2, color: "#d08178" },
  { id: "latex", icon: Sigma, color: "#8b7fd1" },
  { id: "text", icon: Code2, color: "#3fa7b5" },
  { id: "image", icon: ImageIcon, color: "#4caa85" },
  { id: "audio", icon: AudioLines, color: "#e0a03c" },
  { id: "reference", icon: BookMarked, color: "#b07cc6" },
];

// Their texts and labels are messages (`example.<id>.text` / `.label`): a query in the interface language.
const EXAMPLES: Array<{ id: "question" | "photos" | "idea"; icon: LucideIcon; color: string }> = [
  { id: "question", icon: MessageCircleQuestion, color: "#5b8def" },
  { id: "photos", icon: Images, color: "#4caa85" },
  { id: "idea", icon: Lightbulb, color: "#8b7fd1" },
];

const AUTO_SEARCH_DELAY_MS = 350;
const menuItem = "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted";

// The page unmounts while another left-panel tab is open; come back to the same search.
const session = {
  parts: [] as SearchQueryPart[],
  response: null as SearchResponse | null,
  selection: null as SearchSelection | null,
  kind: "all" as KindFilter,
  scroll: 0,
};

const noSubscribe = () => () => {};
const platformModifier = () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl");

function hasQuery(parts: SearchQueryPart[]) {
  return parts.some((part) => part.type === "image" || part.text.trim());
}

function hasImages(parts: SearchQueryPart[]) {
  return parts.some((part) => part.type === "image");
}

const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

function relativeTimeFormat(locale: string) {
  let format = relativeTimeFormats.get(locale);
  if (!format) relativeTimeFormats.set(locale, (format = new Intl.RelativeTimeFormat(locale, { numeric: "always" })));
  return format;
}

/** The `globalSearch.searchView` translator; the status words below take it so they also run outside React. */
export type SearchTranslator = ReturnType<typeof useTranslations<"globalSearch.searchView">>;

/** "in 40 minutes", "in 3 hours", "in 2 days": a schedule read at a glance. */
export function timeUntil(iso: string, now: number, t: SearchTranslator, locale: string) {
  const ms = Date.parse(iso) - now;
  const relative = relativeTimeFormat(locale);
  if (!Number.isFinite(ms) || ms < 60_000) return t("inOneMinute");
  if (ms < 3_600_000) return relative.format(Math.ceil(ms / 60_000), "minute");
  if (ms < 86_400_000) return relative.format(Math.max(1, Math.round(ms / 3_600_000)), "hour");
  return relative.format(Math.round(ms / 86_400_000), "day");
}

export function statusSummary(status: SearchIndexStatus | null, now: number, t: SearchTranslator, locale: string) {
  if (!status) return { busy: false, text: t("checkingIndexStatus") };
  if (status.state === "scanning") return { busy: true, text: status.total ? t("scanningFiles", { done: status.done, total: status.total }) : t("lookingForChanges") };
  if (status.state === "embedding") {
    return { busy: true, text: status.model.state === "loading" ? t("loadingModel") : t("indexingPassages", { done: status.done, total: status.total }) };
  }
  if (status.state === "paused") return { busy: false, text: t("indexingPaused") };
  if (status.state === "error") return { busy: false, text: t("indexingStopped") };
  if (!status.exists) return { busy: false, text: t("noIndexYet") };
  if (status.mismatch) return { busy: false, text: t("filesVectorsNeedReembed", { files: status.files }) };
  if (status.embeddingDeferred === "battery") return { busy: false, text: t("waitingForPowerAdapter") };
  if (status.embeddingDeferred === "power-unknown") return { busy: false, text: t("waitingForPowerStatus") };
  if (status.embeddingDeferred === "interval") {
    return {
      busy: false,
      text: status.nextEmbeddingAt
        ? t("filesIndexedEmbeddings", { files: status.files, when: timeUntil(status.nextEmbeddingAt, now, t, locale) })
        : t("filesIndexedEmbeddingsScheduled", { files: status.files }),
    };
  }
  const pending = status.model.configured ? status.chunks - status.embeddedChunks : 0;
  return {
    busy: false,
    text: pending > 0 && status.model.state !== "error"
      ? t("filesIndexedWaiting", { files: status.files, pending })
      : t("filesIndexed", { files: status.files }),
  };
}

/** The line under the summary when nothing is running. */
export function scheduleSummary(status: SearchIndexStatus | null, now: number, t: SearchTranslator, locale: string) {
  if (!status) return t("connecting");
  if (status.state === "paused") return t("updateOnceOrResume");
  if (status.backgroundIndexing === false) return t("updatesOnlyRequested");
  if (status.nextKeywordUpdateAt) return t("nextKeywordUpdate", { when: timeUntil(status.nextKeywordUpdateAt, now, t, locale) });
  if (status.embeddingDeferred) return t("keywordIndexUpToDate");
  return t("upToDateAsFilesChange");
}

/** The index status in words, for the Search page's left panel. */
export function useIndexStatusText() {
  const t = useTranslations("globalSearch.searchView");
  const locale = useLocale();
  return {
    summary: (status: SearchIndexStatus | null, now = Date.now()) => statusSummary(status, now, t, locale),
    schedule: (status: SearchIndexStatus | null, now = Date.now()) => scheduleSummary(status, now, t, locale),
  };
}

export function SearchView({
  files,
  scope,
  includeArchive,
  mathMarkers,
  focusRequest,
  onOpenResult,
  onClose,
  onOpenPreferences,
}: {
  files: LiberaFileNode[];
  scope?: string[];
  includeArchive: boolean;
  mathMarkers?: MathMarkerSettings;
  focusRequest: number;
  onOpenResult: (entry: SearchEntry, placement: "tab" | "right") => void;
  onClose: () => void;
  onOpenPreferences?: () => void;
}) {
  const t = useTranslations("globalSearch.searchView");
  useSearchStatusPolling();
  const { status } = useSearchStore();
  const inputRef = useRef<SearchQueryInputHandle>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [parts, setParts] = useState<SearchQueryPart[]>(session.parts);
  const [response, setResponse] = useState<SearchResponse | null>(session.response);
  const [selection, setSelection] = useState<SearchSelection | null>(session.selection);
  const [kind, setKind] = useState<KindFilter>(session.kind);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [picker, setPicker] = useState<"gallery" | "library" | null>(null);

  useEffect(() => {
    session.parts = parts;
    session.response = response;
    session.selection = selection;
    session.kind = kind;
  }, [kind, parts, response, selection]);

  const results = useMemo(() => response?.results ?? [], [response]);
  const entries = useMemo(() => searchEntries(results, kind === "image"), [kind, results]);
  const selectedEntry = useMemo(() => {
    if (!selection) return null;
    const result = results.find((item) => item.key === selection.key);
    return result ? { result, hit: Math.min(selection.hit, result.hits.length - 1) } : null;
  }, [results, selection]);

  const runSearch = useCallback(async (query: SearchQueryPart[], options: { remember?: boolean; kind?: KindFilter } = {}) => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
    const filter = options.kind ?? kind;
    const id = ++searchSeq.current;

    if (!hasQuery(query)) {
      setResponse(null);
      setSelection(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const next = await apiRequest<SearchResponse>("/api/search", {
        method: "POST",
        body: JSON.stringify({ parts: query, kinds: filter === "all" ? undefined : [filter], scope, includeArchive }),
      });
      if (id !== searchSeq.current) return;
      clearSearchPreviewCache();
      setResponse(next);
      // Start at the best match, which is not always the first image in the strip.
      const best = next.results[0];
      setSelection(best ? { key: best.key, hit: 0 } : null);
      resultsRef.current?.scrollTo({ top: 0 });
      if (options.remember) rememberSearch(query);
    } catch (searchError) {
      if (id === searchSeq.current) setError(searchError instanceof Error ? searchError.message : t("searchFailed"));
    } finally {
      if (id === searchSeq.current) setLoading(false);
    }
  }, [includeArchive, kind, scope, t]);

  // Put the restored query back in the box.
  useEffect(() => {
    if (session.parts.length) inputRef.current?.setParts(session.parts);
    const frame = requestAnimationFrame(() => {
      resultsRef.current?.scrollTo({ top: session.scroll });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusRequest]);

  // A recent search picked in the left panel.
  useEffect(() => onSearchRequest((next) => {
    inputRef.current?.setParts(next);
    setParts(next);
    void runSearch(next, { remember: true });
    inputRef.current?.focus();
  }), [runSearch]);

  useEffect(() => () => {
    if (autoTimer.current) clearTimeout(autoTimer.current);
  }, []);

  function handleChange(next: SearchQueryPart[]) {
    setParts(next);
    if (autoTimer.current) clearTimeout(autoTimer.current);
    // Words search as you type; images are slower to embed, so they wait for Enter.
    if (!hasImages(next) && searchQueryPlainText(next).length >= 2) {
      autoTimer.current = setTimeout(() => void runSearch(next), AUTO_SEARCH_DELAY_MS);
    } else if (!hasQuery(next)) {
      void runSearch(next);
    }
  }

  function changeKind(next: KindFilter) {
    setKind(next);
    if (hasQuery(parts)) void runSearch(parts, { kind: next });
  }

  function findSimilar(image: SearchImageRef) {
    const next: SearchQueryPart[] = [{ type: "image", image }];
    inputRef.current?.setParts(next);
    setParts(next);
    setKind("image");
    void runSearch(next, { remember: true, kind: "image" });
  }

  function addImages(images: SearchImageRef[]) {
    images.forEach((image) => inputRef.current?.insertImage(image));
  }

  function moveSelection(delta: number) {
    if (!entries.length) return;
    const index = selectedEntry ? entries.findIndex((entry) => entry.result.key === selectedEntry.result.key && entry.hit === selectedEntry.hit) : -1;
    const next = entries[Math.max(0, Math.min(entries.length - 1, index + delta))];
    setSelection({ key: next.result.key, hit: next.hit });
  }

  function openSelected(placement: "tab" | "right") {
    if (selectedEntry) {
      rememberSearch(parts);
      onOpenResult({ ...selectedEntry, terms: response?.terms }, placement);
    }
  }

  const modelOff = status && !status.model.configured;
  const visionOff = status && status.model.configured && !status.model.vision;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <header className="libera-window-drag-region flex min-h-14 items-center gap-2 border-b border-border px-4 py-2">
        <ScanSearch aria-hidden className="h-4 w-4 text-accent" />
        <h2 className="mr-auto text-sm font-semibold">{t("searchHeading")}</h2>
      </header>

      <div className="border-b border-border px-4 pb-3 pt-4">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-start gap-2 rounded-2xl border border-input bg-card px-3 py-2 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
            <Search aria-hidden className="mt-1.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <SearchQueryInput
              ref={inputRef}
              placeholder={t("searchPlaceholder")}
              onChange={handleChange}
              onSubmit={() => void runSearch(inputRef.current?.getParts() ?? parts, { remember: true })}
              onArrowDown={() => {
                if (!entries.length) return;
                resultsRef.current?.focus();
                if (!selection) setSelection({ key: entries[0].result.key, hit: entries[0].hit });
              }}
              onEscape={() => {
                if (hasQuery(inputRef.current?.getParts() ?? [])) inputRef.current?.clear();
                else onClose();
              }}
              onImageAdded={() => {
                const current = inputRef.current?.getParts() ?? [];
                void runSearch(current, { remember: true });
              }}
              onError={setError}
            />
            <div className="relative shrink-0">
              <button
                type="button"
                className="libera-sidebar-icon-button inline-flex h-7 w-7 items-center justify-center rounded-lg"
                aria-label={t("addImageLabel")}
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                title={t("searchWithImageTitle")}
                onClick={() => setAddMenuOpen((open) => !open)}
              >
                <ImagePlus aria-hidden className="h-4 w-4" />
              </button>
              {addMenuOpen ? (
                <>
                  <div className="fixed inset-0 z-40" aria-hidden onClick={() => setAddMenuOpen(false)} />
                  <div role="menu" className="absolute right-0 top-9 z-50 w-56 rounded-xl border border-border bg-card p-1 shadow-lg">
                    <button role="menuitem" type="button" className={menuItem} onClick={() => { setAddMenuOpen(false); uploadRef.current?.click(); }}>
                      <Upload aria-hidden className="h-4 w-4 text-muted-foreground" /> {t("fromComputer")}
                    </button>
                    <button role="menuitem" type="button" className={menuItem} onClick={() => { setAddMenuOpen(false); setPicker("gallery"); }}>
                      <Images aria-hidden className="h-4 w-4 text-muted-foreground" /> {t("fromGallery")}
                    </button>
                    <button role="menuitem" type="button" className={menuItem} onClick={() => { setAddMenuOpen(false); setPicker("library"); }}>
                      <FolderOpen aria-hidden className="h-4 w-4 text-muted-foreground" /> {t("fromNotebooks")}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <input
              ref={uploadRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={async (event) => {
                const chosen = [...(event.target.files ?? [])];
                event.target.value = "";
                for (const file of chosen) {
                  try {
                    inputRef.current?.insertImage({ kind: "upload", name: file.name, dataUrl: await imageFileToDataUrl(file) });
                  } catch {
                    setError(t("couldNotReadNamed", { name: file.name }));
                  }
                }
              }}
            />
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {KIND_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                aria-pressed={kind === filter.id}
                className={`inline-flex items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-xs font-medium transition ${kind === filter.id ? "text-white shadow-sm" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                style={kind === filter.id ? { backgroundColor: filter.color } : undefined}
                onClick={() => changeKind(filter.id)}
              >
                <filter.icon aria-hidden className="h-3.5 w-3.5" style={kind === filter.id ? undefined : { color: filter.color }} />
                {t(`kind.${filter.id}`)}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              {loading ? <><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> {t("searching")}</>
                : response ? <>
                  {t("resultsCount", { count: response.results.length })}
                  <span aria-hidden>·</span>
                  <span title={t(`mode.${response.mode}Title`)}>
                    {t(`mode.${response.mode}`)}
                  </span>
                  <span aria-hidden>·</span>
                  {t("tookMs", { ms: response.tookMs })}
                </> : null}
            </span>
          </div>

          {error || response?.warning ? (
            <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
              <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="mr-auto">{error || response?.warning}</span>
              {modelOff ? (
                <button type="button" className="shrink-0 font-medium underline" onClick={() => openLocalModelDialog("search")}>{t("downloadModel")}</button>
              ) : onOpenPreferences && visionOff ? (
                <button type="button" className="shrink-0 font-medium underline" onClick={onOpenPreferences}>{t("openPreferences")}</button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {response && hasQuery(parts) ? (
        results.length ? (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(340px,1fr)_minmax(0,1.2fr)]">
            <div
              ref={resultsRef}
              tabIndex={0}
              aria-label={t("resultsRegionLabel")}
              className="min-h-0 overflow-y-auto px-4 pt-3 outline-none"
              onScroll={(event) => { session.scroll = event.currentTarget.scrollTop; }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const index = selectedEntry ? entries.findIndex((entry) => entry.result.key === selectedEntry.result.key && entry.hit === selectedEntry.hit) : -1;
                  if (event.key === "ArrowUp" && index <= 0) inputRef.current?.focus();
                  else moveSelection(event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  openSelected(event.metaKey || event.ctrlKey ? "right" : "tab");
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  inputRef.current?.focus();
                }
              }}
            >
              <SearchResults
                results={results}
                terms={response.terms}
                imagesAsGrid={kind === "image"}
                selection={selection}
                onSelect={(next) => {
                  setSelection(next);
                  resultsRef.current?.focus({ preventScroll: true });
                }}
                onOpen={(entry, placement) => {
                  rememberSearch(parts);
                  onOpenResult({ ...entry, terms: response.terms }, placement);
                }}
              />
            </div>
            <aside className="hidden min-h-0 border-l border-border bg-card/40 lg:flex lg:flex-col" aria-label={t("previewLabel")}>
              <SearchPreview
                entry={selectedEntry}
                terms={response.terms}
                mathMarkers={mathMarkers}
                onOpen={(entry, placement) => {
                  rememberSearch(parts);
                  onOpenResult({ ...entry, terms: response.terms }, placement);
                }}
                onFindSimilar={findSimilar}
              />
            </aside>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm font-medium">{t("nothingFound")}</p>
            <p className="max-w-md text-sm text-muted-foreground">
              {kind !== "all" ? t("tryAll") : t("tryOtherWords")}
            </p>
          </div>
        )
      ) : (
        <SearchWelcome
          status={status}
          onExample={(example) => {
            const next: SearchQueryPart[] = [{ type: "text", text: example }];
            inputRef.current?.setParts(next);
            setParts(next);
            void runSearch(next, { remember: true });
          }}
          onOpenPreferences={onOpenPreferences}
        />
      )}

      <GalleryPhotoPicker
        open={picker === "gallery"}
        onClose={() => setPicker(null)}
        onInsert={(photos) => {
          setPicker(null);
          addImages(photos.map((photo) => ({ kind: "gallery", id: photo.id, path: photo.path, name: photo.name })));
        }}
      />
      <LibraryImagePicker
        open={picker === "library"}
        files={files}
        onClose={() => setPicker(null)}
        onPick={(file) => {
          setPicker(null);
          addImages([{ kind: "file", path: file.path, name: file.name }]);
        }}
      />
    </div>
  );
}

function SearchWelcome({
  status,
  onExample,
  onOpenPreferences,
}: {
  status: SearchIndexStatus | null;
  onExample: (example: string) => void;
  onOpenPreferences?: () => void;
}) {
  const t = useTranslations("globalSearch.searchView");
  const mod = useSyncExternalStore(noSubscribe, platformModifier, () => "Ctrl");
  const working = status?.state === "scanning" || status?.state === "embedding";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-10 pt-12">
      <div className="w-full max-w-2xl">
        <div className="libera-search-hero text-center">
          <span className="libera-notebook-emoji libera-search-hero-icon mx-auto flex h-14 w-14 items-center justify-center rounded-2xl text-white">
            <ScanSearch aria-hidden className="h-6 w-6" />
          </span>
          <h3 className="mt-5 text-xl font-semibold tracking-tight">{t("searchEverything")}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {t("searchEverythingBody")}
          </p>
        </div>

        <h4 className="mb-2 mt-9 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("tryAsking")}</h4>
        <div className="grid gap-2 sm:grid-cols-3">
          {EXAMPLES.map(({ id, icon: Icon, color }) => (
            <button
              key={id}
              type="button"
              className="libera-search-example group flex flex-col items-start gap-3 rounded-xl p-3 text-left"
              onClick={() => onExample(t(`example.${id}.text`))}
            >
              <span className="flex w-full items-center justify-between">
                <span className="libera-notebook-emoji flex h-7 w-7 items-center justify-center rounded-lg text-white" style={{ backgroundColor: color }}>
                  <Icon aria-hidden className="h-3.5 w-3.5" />
                </span>
                <ArrowUpRight aria-hidden className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </span>
              <span>
                <span className="block text-[11px] font-medium text-muted-foreground">{t(`example.${id}.label`)}</span>
                <span className="mt-0.5 block text-sm leading-snug">{t("exampleQuote", { text: t(`example.${id}.text`) })}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 px-1 text-xs text-muted-foreground">
          {t.rich("mixWordsAndPictures", { chip: (chunks) => <span className="libera-search-inline-chip">{chunks}</span> })}
        </p>

        {status && !status.exists && !working ? (
          <div className="mt-8"><IndexSetup status={status} /></div>
        ) : null}
        {status?.mismatch ? <div className="mt-8"><IndexMismatch status={status} /></div> : null}

        {status && !status.model.configured ? (
          <div className="libera-search-notice mt-8 flex gap-3 rounded-xl p-4 text-sm" data-tone="warning">
            <Sparkles aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0">
              <p className="font-medium">{t("turnOnSearchByMeaning")}</p>
              <p className="mt-1 leading-relaxed text-muted-foreground">
                {t("turnOnSearchBody")}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90" onClick={() => openLocalModelDialog("search")}>
                  <Download aria-hidden className="h-4 w-4" /> {t("downloadModel")}
                </button>
                {onOpenPreferences ? (
                  <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={onOpenPreferences}>
                    <Settings2 aria-hidden className="h-4 w-4" /> {t("chooseOtherWeights")}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : status?.model.error ? (
          <div className="libera-search-notice mt-8 flex gap-3 rounded-xl p-4 text-sm" data-tone="error">
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="font-medium text-destructive">{t("modelLoadError")}</p>
              <p className="mt-1 break-words text-muted-foreground">{status.model.error}</p>
            </div>
          </div>
        ) : null}

        <div className="mt-10 flex flex-col items-center gap-4 border-t border-border pt-6">
          <p role="status" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span aria-hidden className="libera-search-status-dot" data-tone={working ? "busy" : status ? "ready" : "idle"} />
            {status ? (
              <span>
                {t.rich("indexStats", {
                  files: status.files,
                  passages: status.chunks,
                  images: status.images,
                  working: working ? "yes" : "no",
                  n: (chunks) => <strong className="font-semibold tabular-nums text-foreground">{chunks}</strong>,
                })}
              </span>
            ) : (
              <span>{t("checkingIndex")}</span>
            )}
          </p>
          <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label={t("keyboardShortcuts")}>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">↑</kbd><kbd className="libera-kbd">↓</kbd> {t("shortcutMove")}</li>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">↵</kbd> {t("shortcutOpen")}</li>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">{mod}{mod === "⌘" ? "" : "+"}↵</kbd> {t("shortcutOpenRight")}</li>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">Esc</kbd> {t("shortcutClear")}</li>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">“ ”</kbd> {t("shortcutExactPhrase")}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
