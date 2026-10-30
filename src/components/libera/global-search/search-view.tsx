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
const KIND_FILTERS: Array<{ id: KindFilter; label: string; icon: LucideIcon; color: string }> = [
  { id: "all", label: "All", icon: Layers, color: "#7a8299" },
  { id: "markdown", label: "Notes", icon: FileText, color: "#5b8def" },
  { id: "pdf", label: "PDFs", icon: FileType2, color: "#d08178" },
  { id: "latex", label: "LaTeX", icon: Sigma, color: "#8b7fd1" },
  { id: "text", label: "Text & code", icon: Code2, color: "#3fa7b5" },
  { id: "image", label: "Images", icon: ImageIcon, color: "#4caa85" },
  { id: "audio", label: "Voice memos", icon: AudioLines, color: "#e0a03c" },
  { id: "reference", label: "References", icon: BookMarked, color: "#b07cc6" },
];

const EXAMPLES: Array<{ text: string; label: string; icon: LucideIcon; color: string }> = [
  { text: "how did I set up the experiment?", label: "Ask a question", icon: MessageCircleQuestion, color: "#5b8def" },
  { text: "photos of mountains at sunset", label: "Describe a photo", icon: Images, color: "#4caa85" },
  { text: "the proof that uses induction", label: "Recall an idea", icon: Lightbulb, color: "#8b7fd1" },
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

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "always" });

/** "in 40 minutes", "in 3 hours", "in 2 days": a schedule read at a glance. */
export function timeUntil(iso: string, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms < 60_000) return "in under a minute";
  if (ms < 3_600_000) return relativeTime.format(Math.ceil(ms / 60_000), "minute");
  if (ms < 86_400_000) return relativeTime.format(Math.max(1, Math.round(ms / 3_600_000)), "hour");
  return relativeTime.format(Math.round(ms / 86_400_000), "day");
}

export function statusSummary(status: SearchIndexStatus | null, now = Date.now()) {
  if (!status) return { busy: false, text: "Checking the index…" };
  if (status.state === "scanning") return { busy: true, text: status.total ? `Scanning ${status.done} of ${status.total} files` : "Looking for changes…" };
  if (status.state === "embedding") {
    return { busy: true, text: status.model.state === "loading" ? "Loading EmbeddingGemma 2…" : `Indexing ${status.done} of ${status.total} passages` };
  }
  if (status.state === "paused") return { busy: false, text: "Indexing paused" };
  if (status.state === "error") return { busy: false, text: "Indexing stopped" };
  if (!status.exists) return { busy: false, text: "No index yet" };
  if (status.mismatch) return { busy: false, text: `${status.files.toLocaleString()} files · vectors need re-embedding` };
  if (status.embeddingDeferred === "battery") return { busy: false, text: "Embeddings waiting for power adapter" };
  if (status.embeddingDeferred === "power-unknown") return { busy: false, text: "Embeddings waiting for power status" };
  if (status.embeddingDeferred === "interval") {
    return { busy: false, text: `${status.files.toLocaleString()} files indexed · embeddings ${status.nextEmbeddingAt ? timeUntil(status.nextEmbeddingAt, now) : "scheduled"}` };
  }
  const pending = status.model.configured ? status.chunks - status.embeddedChunks : 0;
  return {
    busy: false,
    text: `${status.files.toLocaleString()} files indexed${pending > 0 && status.model.state !== "error" ? ` · ${pending.toLocaleString()} waiting` : ""}`,
  };
}

/** The line under the summary when nothing is running. */
export function scheduleSummary(status: SearchIndexStatus | null, now = Date.now()) {
  if (!status) return "Connecting…";
  if (status.state === "paused") return "Update once or resume indexing";
  if (status.backgroundIndexing === false) return "Updates only when requested";
  if (status.nextKeywordUpdateAt) return `Next keyword update ${timeUntil(status.nextKeywordUpdateAt, now)}`;
  if (status.embeddingDeferred) return "Keyword index up to date";
  return "Up to date as files change";
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
      if (id === searchSeq.current) setError(searchError instanceof Error ? searchError.message : "Search failed.");
    } finally {
      if (id === searchSeq.current) setLoading(false);
    }
  }, [includeArchive, kind, scope]);

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

  const summary = statusSummary(status);
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
        <h2 className="mr-auto text-sm font-semibold">Search</h2>
        <span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {summary.busy ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}
          {summary.text}
        </span>
      </header>

      <div className="border-b border-border px-4 pb-3 pt-4">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-start gap-2 rounded-2xl border border-input bg-card px-3 py-2 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
            <Search aria-hidden className="mt-1.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <SearchQueryInput
              ref={inputRef}
              placeholder="Search notes, PDFs, LaTeX, code and images — paste or drop an image to search with it"
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
                aria-label="Add an image to the search"
                aria-haspopup="menu"
                aria-expanded={addMenuOpen}
                title="Search with an image"
                onClick={() => setAddMenuOpen((open) => !open)}
              >
                <ImagePlus aria-hidden className="h-4 w-4" />
              </button>
              {addMenuOpen ? (
                <>
                  <div className="fixed inset-0 z-40" aria-hidden onClick={() => setAddMenuOpen(false)} />
                  <div role="menu" className="absolute right-0 top-9 z-50 w-56 rounded-xl border border-border bg-card p-1 shadow-lg">
                    <button role="menuitem" type="button" className={menuItem} onClick={() => { setAddMenuOpen(false); uploadRef.current?.click(); }}>
                      <Upload aria-hidden className="h-4 w-4 text-muted-foreground" /> From your computer…
                    </button>
                    <button role="menuitem" type="button" className={menuItem} onClick={() => { setAddMenuOpen(false); setPicker("gallery"); }}>
                      <Images aria-hidden className="h-4 w-4 text-muted-foreground" /> From the Image Gallery…
                    </button>
                    <button role="menuitem" type="button" className={menuItem} onClick={() => { setAddMenuOpen(false); setPicker("library"); }}>
                      <FolderOpen aria-hidden className="h-4 w-4 text-muted-foreground" /> From your notebooks…
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
                    setError(`Could not read ${file.name}.`);
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
                {filter.label}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              {loading ? <><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> Searching…</>
                : response ? <>
                  {response.results.length} {response.results.length === 1 ? "result" : "results"}
                  <span aria-hidden>·</span>
                  <span title={response.mode === "hybrid" ? "Meaning and exact words" : response.mode === "semantic" ? "By meaning" : "Exact words"}>
                    {response.mode === "hybrid" ? "Semantic + keyword" : response.mode === "semantic" ? "Semantic" : "Keyword"}
                  </span>
                  <span aria-hidden>·</span>
                  {response.tookMs} ms
                </> : null}
            </span>
          </div>

          {error || response?.warning ? (
            <div role="alert" className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground">
              <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="mr-auto">{error || response?.warning}</span>
              {modelOff ? (
                <button type="button" className="shrink-0 font-medium underline" onClick={() => openLocalModelDialog("search")}>Download model</button>
              ) : onOpenPreferences && visionOff ? (
                <button type="button" className="shrink-0 font-medium underline" onClick={onOpenPreferences}>Open Preferences</button>
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
              aria-label="Search results; use the arrow keys to move and Enter to open"
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
            <aside className="hidden min-h-0 border-l border-border bg-card/40 lg:flex lg:flex-col" aria-label="Preview">
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
            <p className="text-sm font-medium">Nothing found</p>
            <p className="max-w-md text-sm text-muted-foreground">
              {kind !== "all" ? "Try All instead of one kind of file, or describe what you remember in other words." : "Try other words, or describe what the passage is about rather than its exact wording."}
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
  const mod = useSyncExternalStore(noSubscribe, platformModifier, () => "Ctrl");
  const working = status?.state === "scanning" || status?.state === "embedding";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-10 pt-12">
      <div className="w-full max-w-2xl">
        <div className="libera-search-hero text-center">
          <span className="libera-notebook-emoji libera-search-hero-icon mx-auto flex h-14 w-14 items-center justify-center rounded-2xl text-white">
            <ScanSearch aria-hidden className="h-6 w-6" />
          </span>
          <h3 className="mt-5 text-xl font-semibold tracking-tight">Search everything by meaning</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            Describe what you remember in your own words. Results open right at the passage, page or line, and an image finds photos that look alike.
          </p>
        </div>

        <h4 className="mb-2 mt-9 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Try asking</h4>
        <div className="grid gap-2 sm:grid-cols-3">
          {EXAMPLES.map(({ text, label, icon: Icon, color }) => (
            <button
              key={text}
              type="button"
              className="libera-search-example group flex flex-col items-start gap-3 rounded-xl p-3 text-left"
              onClick={() => onExample(text)}
            >
              <span className="flex w-full items-center justify-between">
                <span className="libera-notebook-emoji flex h-7 w-7 items-center justify-center rounded-lg text-white" style={{ backgroundColor: color }}>
                  <Icon aria-hidden className="h-3.5 w-3.5" />
                </span>
                <ArrowUpRight aria-hidden className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </span>
              <span>
                <span className="block text-[11px] font-medium text-muted-foreground">{label}</span>
                <span className="mt-0.5 block text-sm leading-snug">“{text}”</span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 px-1 text-xs text-muted-foreground">
          Mix words and pictures, like “photos like <span className="libera-search-inline-chip">image</span> but in winter”.
        </p>

        {status && !status.exists && !working ? (
          <div className="mt-8"><IndexSetup status={status} /></div>
        ) : null}
        {status?.mismatch ? <div className="mt-8"><IndexMismatch status={status} /></div> : null}

        {status && !status.model.configured ? (
          <div className="libera-search-notice mt-8 flex gap-3 rounded-xl p-4 text-sm" data-tone="warning">
            <Sparkles aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0">
              <p className="font-medium">Turn on search by meaning</p>
              <p className="mt-1 leading-relaxed text-muted-foreground">
                Keyword search already works. Download Google’s EmbeddingGemma 2 to search by meaning and with images.
                It runs on this computer; nothing is sent anywhere.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90" onClick={() => openLocalModelDialog("search")}>
                  <Download aria-hidden className="h-4 w-4" /> Download model
                </button>
                {onOpenPreferences ? (
                  <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted" onClick={onOpenPreferences}>
                    <Settings2 aria-hidden className="h-4 w-4" /> Choose other weights
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : status?.model.error ? (
          <div className="libera-search-notice mt-8 flex gap-3 rounded-xl p-4 text-sm" data-tone="error">
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="font-medium text-destructive">The embedding model could not be loaded</p>
              <p className="mt-1 break-words text-muted-foreground">{status.model.error}</p>
            </div>
          </div>
        ) : null}

        <div className="mt-10 flex flex-col items-center gap-4 border-t border-border pt-6">
          <p role="status" className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span aria-hidden className="libera-search-status-dot" data-tone={working ? "busy" : status ? "ready" : "idle"} />
            {status ? (
              <>
                <span><strong className="font-semibold tabular-nums text-foreground">{status.files.toLocaleString()}</strong> files</span>
                <span aria-hidden>·</span>
                <span><strong className="font-semibold tabular-nums text-foreground">{status.chunks.toLocaleString()}</strong> passages</span>
                <span aria-hidden>·</span>
                <span><strong className="font-semibold tabular-nums text-foreground">{status.images.toLocaleString()}</strong> images</span>
                <span>{working ? "indexing…" : "indexed"}</span>
              </>
            ) : (
              <span>Checking the index…</span>
            )}
          </p>
          <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Keyboard shortcuts">
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">↑</kbd><kbd className="libera-kbd">↓</kbd> Move</li>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">↵</kbd> Open</li>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">{mod}{mod === "⌘" ? "" : "+"}↵</kbd> Open to the right</li>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">Esc</kbd> Clear</li>
            <li className="flex items-center gap-1.5"><kbd className="libera-kbd">“ ”</kbd> Exact phrase</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
