"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useReferenceLibrary } from "./use-reference-library";
import { citationEntriesForDocument, entryForKey, isBundledCslStyle, libraryEntriesByKey, loadCslStyle, type FormattedCitationDocument } from "@/lib/references/format";
import { formatCitationDocumentAsync } from "@/lib/references/format-client";
import { resolvedCitationOccurrences, scanCitations } from "@/lib/references/citation-syntax";
import type { MathMarkerSettings } from "@/lib/math-markers";
import { normalizeMarkdownHighlightDelimiters } from "@/lib/markdown-highlights";
import type { PreviewCitation } from "@/lib/markdown-preview-patch";
import {
  DEFAULT_CSL_STYLE,
  type Citation,
  type CitationItem,
  type CitationLocatorLabel,
  type ReferenceAttachment,
  type ReferenceEntry,
  type ReferenceLibrary,
} from "@/lib/references/types";

// The "Reference render context" contract (docs/references/lanes.md): what a
// rendered Markdown document needs to show formatted citations. The provider
// loads the notebook's library and, once something in it has citations, its
// CSL style. Components that render citations call useReferenceRender();
// without a provider (chat, review comments, agent activity) they show the
// raw token as a chip.
//
// Formatting is per document: MarkdownRenderer lists its citations in order
// (from the preview worker, or by scanning the source), formats them all at
// once (format-client.ts, off the main thread, cached by signature) and
// hands each chip its text through CitationDocumentContext. Slides share one
// CitationScope so a deck numbers its citations once.
//
// A document can name its own style in its front matter (`citation-style:`,
// references/document-style.ts). useFormattedCitations takes that setting;
// the provider loads and caches each style a document asks for, and falls
// back to the notebook's style when one cannot be loaded.

export type ReferenceAttachmentLocator = {
  label: CitationLocatorLabel;
  locator: string;
  /** The first page number, when the label is page. */
  page?: number;
};

export type ReferenceRenderValue = {
  notebook: string | null;
  library: ReferenceLibrary | null;
  /** The style's CSL XML, once something asked for it (see useFormattedCitations). */
  styleXml: string | null;
  locale: string;
  /** Every entry by key and by alias. */
  entriesByKey: Record<string, ReferenceEntry>;
  onOpenAttachment?: (attachment: ReferenceAttachment, locator?: ReferenceAttachmentLocator) => void;
};

type ReferenceRenderStatus = {
  libraryPending: boolean;
  stylePending: boolean;
  styleHash: string | null;
  requestStyle: () => void;
  /** Styles documents asked for (`citation-style`), by setting, once loaded. */
  documentStyles: Record<string, LoadedStyle>;
  requestDocumentStyle: (setting: string) => void;
};

const ReferenceRenderContext = createContext<ReferenceRenderValue | null>(null);
const ReferenceRenderStatusContext = createContext<ReferenceRenderStatus | null>(null);

/** The surrounding reference render context, or null (render citations as raw chips). */
export function useReferenceRender() {
  return useContext(ReferenceRenderContext);
}

/** Render citations below this point as raw chips (e.g. Markdown notes inside a hover card). */
export function WithoutReferenceRender({ children }: { children: ReactNode }) {
  return <ReferenceRenderContext.Provider value={null}>{children}</ReferenceRenderContext.Provider>;
}

/** The notebook a document belongs to: the first segment of its library path. */
export function referenceNotebookForPath(path: string | null | undefined) {
  const notebook = (path ?? "").replace(/^\/+/, "").split("/")[0];
  return notebook || null;
}

/** The attachment locator of a citation item: its locator and label, and the page when the label is page. */
export function attachmentLocator(item: Pick<CitationItem, "locator" | "label">): ReferenceAttachmentLocator | undefined {
  if (!item.locator) return undefined;
  const label = item.label ?? "page";
  const page = label === "page" ? Number(/\d+/.exec(item.locator)?.[0]) : NaN;
  return { label, locator: item.locator, ...(Number.isFinite(page) && page > 0 ? { page } : {}) };
}

function hashText(text: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** Read a notebook's custom `.csl` style through the file API: a library-relative path, or one relative to the notebook. */
export async function readCustomStyle(notebook: string | null, path: string) {
  const candidates = [path, ...(notebook && !path.startsWith(`${notebook}/`) ? [`${notebook}/${path}`] : [])];
  for (const candidate of candidates) {
    try {
      const response = await fetch(`/api/files?path=${encodeURIComponent(candidate)}`, { cache: "no-store" });
      if (!response.ok) continue;
      const { content } = await response.json() as { content?: string };
      if (typeof content === "string" && content.trim().startsWith("<")) return content.trim();
    } catch {
      // Try the next location; the default style is used when none works.
    }
  }
  return null;
}

/** The loaded style for a library setting; `xml` is null when it could not be loaded. */
type LoadedStyle = { setting: string; xml: string | null; hash: string | null };
const NO_STYLES: Record<string, LoadedStyle> = {};

export function ReferenceRenderProvider({
  notebook,
  children,
  onOpenAttachment,
}: {
  notebook: string | null;
  children?: ReactNode;
  onOpenAttachment?: ReferenceRenderValue["onOpenAttachment"];
}) {
  const { library, loading, error } = useReferenceLibrary(notebook);
  const [styleWanted, setStyleWanted] = useState(false);
  const [style, setStyle] = useState<LoadedStyle | null>(null);
  const setting = library ? library.style || DEFAULT_CSL_STYLE : null;

  useEffect(() => {
    if (!styleWanted || setting === null) return;
    let cancelled = false;
    void (async () => {
      let xml: string | null = null;
      if (!isBundledCslStyle(setting) && /\.csl$/i.test(setting)) xml = await readCustomStyle(notebook, setting);
      xml ??= await loadCslStyle(setting);
      if (!cancelled) setStyle({ setting, xml, hash: hashText(xml) });
    })().catch(() => {
      // The bundled styles failed to load (a broken chunk): citations stay raw.
      if (!cancelled) setStyle({ setting, xml: null, hash: null });
    });
    return () => {
      cancelled = true;
    };
  }, [styleWanted, setting, notebook]);

  const requestStyle = useCallback(() => setStyleWanted(true), []);
  const current = style && style.setting === setting ? style : null;

  // Per-document styles, loaded once per notebook and setting.
  const [documentStyles, setDocumentStyles] = useState<{ notebook: string | null; styles: Record<string, LoadedStyle> }>({ notebook, styles: {} });
  const requested = useRef<{ notebook: string | null; settings: Set<string> }>({ notebook, settings: new Set() });
  const requestDocumentStyle = useCallback((wanted: string) => {
    if (requested.current.notebook !== notebook) requested.current = { notebook, settings: new Set() };
    if (requested.current.settings.has(wanted)) return;
    requested.current.settings.add(wanted);
    void (async () => {
      let xml: string | null = null;
      try {
        if (isBundledCslStyle(wanted)) xml = await loadCslStyle(wanted);
        else if (/\.csl$/i.test(wanted)) xml = await readCustomStyle(notebook, wanted);
      } catch {
        xml = null;
      }
      const loaded: LoadedStyle = { setting: wanted, xml, hash: xml ? hashText(xml) : null };
      setDocumentStyles((state) => state.notebook === notebook
        ? { notebook, styles: { ...state.styles, [wanted]: loaded } }
        : { notebook, styles: { [wanted]: loaded } });
    })();
  }, [notebook]);
  const loadedDocumentStyles = documentStyles.notebook === notebook ? documentStyles.styles : NO_STYLES;
  const entriesByKey = useMemo(() => libraryEntriesByKey(library), [library]);
  const value = useMemo<ReferenceRenderValue>(() => ({
    notebook,
    library,
    styleXml: current?.xml ?? null,
    locale: "en-US",
    entriesByKey,
    onOpenAttachment,
  }), [notebook, library, current, entriesByKey, onOpenAttachment]);
  const status = useMemo<ReferenceRenderStatus>(() => ({
    libraryPending: Boolean(notebook) && !library && loading && !error,
    stylePending: styleWanted && setting !== null && !current,
    styleHash: current?.hash ?? null,
    requestStyle,
    documentStyles: loadedDocumentStyles,
    requestDocumentStyle,
  }), [notebook, library, loading, error, styleWanted, setting, current, requestStyle, loadedDocumentStyles, requestDocumentStyle]);

  return (
    <ReferenceRenderContext.Provider value={value}>
      <ReferenceRenderStatusContext.Provider value={status}>{children}</ReferenceRenderStatusContext.Provider>
    </ReferenceRenderContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Formatting one document
// ---------------------------------------------------------------------------

export type CitationFormatting = {
  /** The latest result, possibly for an earlier citation list; `raws` says which. */
  result: FormattedCitationDocument | null;
  raws: string[];
  /** Waiting for the library, the style or the formatter. */
  pending: boolean;
};

const NO_FORMATTING: CitationFormatting = { result: null, raws: [], pending: false };

/**
 * Format a document's citations (in document order) with the surrounding
 * provider's library and style. `documentStyle` is the document's own style
 * setting (`citation-style` in its front matter), if any. Typing that leaves
 * the citations alone keeps the signature, so nothing is formatted or posted
 * again.
 */
export function useFormattedCitations(citations: readonly Citation[] | null, documentStyle?: string | null): CitationFormatting {
  const render = useReferenceRender();
  const status = useContext(ReferenceRenderStatusContext);
  const active = Boolean(render && status && citations?.length);
  const requestStyle = status?.requestStyle;
  const notebookSetting = render?.library ? render.library.style || DEFAULT_CSL_STYLE : null;
  const override = documentStyle && notebookSetting !== null && documentStyle !== notebookSetting ? documentStyle : null;
  const requestDocumentStyle = status?.requestDocumentStyle;
  useEffect(() => {
    if (!active) return;
    requestStyle?.();
    if (override) requestDocumentStyle?.(override);
  }, [active, requestStyle, override, requestDocumentStyle]);

  const raws = useMemo(() => citations?.map((citation) => citation.raw) ?? [], [citations]);
  const library = render?.library ?? null;
  // A document style that could not be loaded falls back to the notebook's.
  const loadedOverride = override ? status?.documentStyles[override] : undefined;
  const useOverride = Boolean(loadedOverride?.xml);
  const styleXml = useOverride ? loadedOverride!.xml : render?.styleXml ?? null;
  const styleHash = useOverride ? loadedOverride!.hash : status?.styleHash ?? null;
  const overridePending = Boolean(override && !loadedOverride);
  const signature = active && library && styleXml && styleHash && !overridePending
    ? [render!.notebook ?? "", library.revision, styleHash, render!.locale, raws.join("\u0001")].join("\u0000")
    : null;
  const notebook = render?.notebook ?? null;
  const [state, setState] = useState<{ signature: string; notebook: string | null; result: FormattedCitationDocument | null; raws: string[] } | null>(null);

  useEffect(() => {
    if (!signature || !citations || !library || !styleXml || !render) return;
    let cancelled = false;
    const keys = new Set(citations.flatMap((citation) => citation.items.map((item) => item.key)));
    const input = { citations: [...citations], entries: citationEntriesForDocument(library, keys), style: styleXml, locale: render.locale };
    formatCitationDocumentAsync(signature, input).then(
      (result) => {
        if (!cancelled) setState({ signature, notebook, result, raws });
      },
      (error: unknown) => {
        console.warn("Could not format citations:", error);
        if (!cancelled) setState({ signature, notebook, result: null, raws });
      },
    );
    return () => {
      cancelled = true;
    };
    // The signature covers the citations, the library revision and the style.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const pending = active && Boolean(status?.libraryPending || status?.stylePending || overridePending || (signature && state?.signature !== signature));
  // While a new result is on its way the previous one stays (chips check that
  // their token still matches); without a library or style there is none.
  const current = active && (signature || pending) && state?.notebook === notebook ? state : null;
  const result = current?.result ?? null;
  const resultRaws = current?.raws ?? NO_FORMATTING.raws;
  // A stable object while nothing changes, so chips in reused preview blocks do not re-render.
  return useMemo(() => result || pending ? { result, raws: resultRaws, pending } : NO_FORMATTING, [result, resultRaws, pending]);
}

// ---------------------------------------------------------------------------
// The document a citation chip belongs to
// ---------------------------------------------------------------------------

export type DocumentCitationList = {
  citations: Citation[];
  /** Index by preview source id (worker previews). */
  bySourceId: Map<string, number>;
  /** Index by source offset (synchronous rendering). */
  byStart: Map<number, number>;
};

const EMPTY_LIST: DocumentCitationList = { citations: [], bySourceId: new Map(), byStart: new Map() };

/** Whether a key resolves in a render context's library (null while there is no library: nothing resolves). */
export function referenceKeyResolver(render: Pick<ReferenceRenderValue, "library" | "entriesByKey"> | null) {
  if (!render?.library) return null;
  const { entriesByKey } = render;
  return (key: string) => Boolean(entryForKey(entriesByKey, key));
}

/**
 * The citations of a Markdown source, in order, as the preview renders them.
 * Narrative candidates count only when `resolves` knows their key (see
 * citation-syntax.ts): an unresolved `@word` renders as text.
 */
export function documentCitationsFromSource(source: string, mathMarkers?: MathMarkerSettings, resolves?: ((key: string) => boolean) | null): DocumentCitationList {
  if (!source.includes("@")) return EMPTY_LIST;
  const occurrences = resolvedCitationOccurrences(scanCitations(source, { mathMarkers }), resolves);
  if (!occurrences.length) return EMPTY_LIST;
  return {
    citations: occurrences.map((occurrence) => occurrence.citation),
    bySourceId: new Map(),
    byStart: new Map(occurrences.map((occurrence, index) => [occurrence.start, index])),
  };
}

/** The citations the preview worker found, in order (narrative ones only when they resolve). */
export function documentCitationsFromPreview(found: readonly PreviewCitation[], resolves?: ((key: string) => boolean) | null): DocumentCitationList {
  const citations = resolvedCitationOccurrences(found, resolves);
  if (!citations.length) return EMPTY_LIST;
  return {
    citations: citations.map((entry) => entry.citation),
    bySourceId: new Map(citations.map((entry, index) => [entry.sourceId, index])),
    byStart: new Map(citations.map((entry, index) => [entry.start, index])),
  };
}

export type CitationDocumentValue = {
  list: DocumentCitationList;
  /** This document's first index in the formatted result (slides share one result). */
  offset: number;
  formatting: CitationFormatting;
  /** Whether a bibliography appended at the end renders (not in slides, which place it with the marker). */
  appendedBibliography: boolean;
};

export const CitationDocumentContext = createContext<CitationDocumentValue | null>(null);

export function useCitationDocument() {
  return useContext(CitationDocumentContext);
}

/** The index of a rendered citation in its document, or -1. */
export function citationIndex(document: CitationDocumentValue, raw: string, sourceId?: string, start?: number) {
  const { list } = document;
  let index = sourceId ? list.bySourceId.get(sourceId) : undefined;
  if (index === undefined && start !== undefined) index = list.byStart.get(start);
  if (index === undefined || list.citations[index]?.raw !== raw) index = list.citations.findIndex((citation) => citation.raw === raw);
  return index;
}

/** The formatted HTML for a rendered citation, or null while there is none for exactly this citation. */
export function formattedCitation(document: CitationDocumentValue, index: number, raw: string) {
  if (index < 0) return null;
  const position = document.offset + index;
  const { result, raws } = document.formatting;
  return result && raws[position] === raw ? result.citations[position] ?? null : null;
}

// ---------------------------------------------------------------------------
// Slides: one formatting scope for several rendered documents
// ---------------------------------------------------------------------------

type CitationScopeValue = { formatting: CitationFormatting; offsets: number[] };
const CitationScopeContext = createContext<CitationScopeValue | null>(null);

export function useCitationScope() {
  return useContext(CitationScopeContext);
}

/**
 * Format several Markdown sources (a deck's slides) as one document, so
 * numbering and disambiguation run across all of them. A MarkdownRenderer
 * inside names its source with `citationScopeIndex`.
 */
export function CitationScope({ sources, mathMarkers, documentStyle, children }: {
  sources: string[];
  mathMarkers?: MathMarkerSettings;
  /** The deck's own style setting (`citation-style`), if any. */
  documentStyle?: string | null;
  children?: ReactNode;
}) {
  const render = useReferenceRender();
  const lists = useMemo(() => {
    if (!render) return [];
    const resolves = referenceKeyResolver(render);
    return sources.map((source) => documentCitationsFromSource(normalizeMarkdownHighlightDelimiters(source), mathMarkers, resolves));
  }, [render, sources, mathMarkers]);
  const citations = useMemo(() => lists.flatMap((list) => list.citations), [lists]);
  const formatting = useFormattedCitations(render ? citations : null, documentStyle);
  const value = useMemo<CitationScopeValue>(() => {
    const offsets: number[] = [];
    let offset = 0;
    for (const list of lists) {
      offsets.push(offset);
      offset += list.citations.length;
    }
    return { formatting, offsets };
  }, [lists, formatting]);
  return <CitationScopeContext.Provider value={value}>{children}</CitationScopeContext.Provider>;
}

// ---------------------------------------------------------------------------
// Waiting for formatting (PDF export)
// ---------------------------------------------------------------------------

/** Set on a rendered document while its citations wait for the library, the style or formatting. */
export const REFERENCES_PENDING_ATTRIBUTE = "data-references-pending";

/** Resolve once no rendered document under `root` is waiting for citation formatting (or after `timeoutMs`). */
export function waitForReferencesReady(root: HTMLElement, timeoutMs = 20000) {
  const selector = `[${REFERENCES_PENDING_ATTRIBUTE}]`;
  if (!root.matches(selector) && !root.querySelector(selector)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      if (!root.matches(selector) && !root.querySelector(selector)) finish();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: [REFERENCES_PENDING_ATTRIBUTE] });
    const timer = setTimeout(finish, timeoutMs);
  });
}
