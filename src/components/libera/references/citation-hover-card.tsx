"use client";

import { useEffect, useLayoutEffect, useState, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { entryForKey } from "@/lib/references/format";
import { titleSimilarity } from "@/lib/references/dedupe";
import { retractionBadgeState, retractionDescription } from "@/lib/references/retraction";
import {
  REFERENCES_ADD_REQUEST_EVENT,
  REFERENCES_REVEAL_EVENT,
  type Citation,
  type CitationItem,
  type CslItem,
  type ReferenceAttachment,
  type ReferenceEntry,
  type ReferencesAddRequestDetail,
  type ReferencesRevealDetail,
} from "@/lib/references/types";
import { attachmentLocator, useReferenceRender, WithoutReferenceRender, type CitationDocumentValue } from "./reference-render-context";
import { FormattedCitationHtml } from "./citation-chip";
import { RetractionBadge } from "./retraction-badge";

// The card a citation chip opens on hover or keyboard focus, and pins on
// click (plan.md §1.3): per cited work, the formatted reference, abstract and
// notes, attachments (Open PDF at the cited page), the number of the user's
// highlights on the PDF and of documents citing the work, and Show in
// References. For an unresolved key it lists close matches in the library
// and offers Add to library. Positioned in a portal, inside the viewport, as
// the app's other popovers are.

const MARGIN = 8;
const GAP = 6;
const CACHE_MS = 30_000;

// ---------------------------------------------------------------------------
// Close matches for unresolved keys
// ---------------------------------------------------------------------------

function editDistance(a: string, b: string) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function keySimilarity(a: string, b: string) {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const length = Math.max(left.length, right.length);
  return length ? 1 - editDistance(left, right) / length : 0;
}

/** A key's words: `smith2020sparse` → "smith 2020 sparse". */
export function citationKeyWords(key: string) {
  return key
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .replace(/([\p{Ll}])(\p{Lu})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function entryYear(csl: CslItem) {
  const year = csl.issued?.["date-parts"]?.[0]?.[0];
  return typeof year === "number" ? String(year) : (/\b\d{4}\b/.exec(csl.issued?.literal ?? csl.issued?.raw ?? "")?.[0] ?? "");
}

function firstAuthor(csl: CslItem) {
  const name = csl.author?.[0] ?? csl.editor?.[0];
  return name?.family ?? name?.literal ?? "";
}

/**
 * Up to `limit` library entries close to an unresolved key: by key (and
 * alias) similarity, and by titleSimilarity between the key's words and the
 * entry's title, or its first author, year and title.
 */
export function closeReferenceMatches(key: string, entries: ReferenceEntry[], limit = 3) {
  const words = citationKeyWords(key);
  return entries
    .map((entry) => {
      const title = typeof entry.csl.title === "string" ? entry.csl.title : "";
      const score = Math.max(
        keySimilarity(key, entry.key),
        ...(entry.aliases ?? []).map((alias) => keySimilarity(key, alias)),
        titleSimilarity(words, title),
        titleSimilarity(words, `${firstAuthor(entry.csl)} ${entryYear(entry.csl)} ${title}`),
      );
      return { entry, score };
    })
    .filter((match) => match.score >= 0.4)
    .sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key))
    .slice(0, limit)
    .map((match) => match.entry);
}

// ---------------------------------------------------------------------------
// Highlights and citing documents
// ---------------------------------------------------------------------------

type Cached<T> = { at: number; value: Promise<T> };
const highlightCounts = new Map<string, Cached<number | null>>();
const citationIndexes = new Map<string, Cached<Record<string, string[]> | null>>();

function cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The number of highlights the user made on a PDF, or null when unknown. */
function fetchHighlightCount(path: string) {
  return cached(highlightCounts, path, async () => {
    try {
      const response = await fetch(`/api/pdf-annotations?path=${encodeURIComponent(path)}`, { cache: "no-store" });
      if (!response.ok) return null;
      const { annotations } = await response.json() as { annotations?: Array<{ type?: string }> };
      return Array.isArray(annotations) ? annotations.filter((annotation) => annotation.type === "highlight").length : null;
    } catch {
      return null;
    }
  });
}

/** The notebook's citation index by key (interop lane), or null when it is unavailable. */
function fetchCitingDocuments(notebook: string) {
  return cached(citationIndexes, notebook, async () => {
    try {
      const response = await fetch(`/api/references/citations?notebook=${encodeURIComponent(notebook)}`, { cache: "no-store" });
      if (!response.ok) return null;
      const { byKey } = await response.json() as { byKey?: Record<string, string[]> };
      return byKey && typeof byKey === "object" ? byKey : null;
    } catch {
      return null;
    }
  });
}

/** Drop cached highlight counts and citation indexes (tests). */
export function resetCitationHoverCardCache() {
  highlightCounts.clear();
  citationIndexes.clear();
}

function useAsync<T>(load: (() => Promise<T>) | null, key: string): T | undefined {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    void load().then((value) => {
      if (!cancelled) setState({ key, value });
    });
    return () => {
      cancelled = true;
    };
    // `key` identifies the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state?.key === key ? state.value : undefined;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function plainReference(entry: ReferenceEntry) {
  const csl = entry.csl;
  const author = firstAuthor(csl);
  const others = (csl.author?.length ?? 0) > 1 ? " et al." : "";
  const year = entryYear(csl);
  return [author ? `${author}${others}` : "", year ? `(${year})` : "", typeof csl.title === "string" ? csl.title : ""].filter(Boolean).join(" ");
}

function PdfHighlights({ path }: { path: string }) {
  const count = useAsync(() => fetchHighlightCount(path), path);
  if (count === undefined || count === null) return null;
  return <span className="citation-card-meta">{count === 1 ? "1 highlight" : `${count} highlights`}</span>;
}

function AttachmentRow({ attachment, item }: { attachment: ReferenceAttachment; item: CitationItem }) {
  const render = useReferenceRender();
  const open = render?.onOpenAttachment;
  if (attachment.kind === "url") {
    if (!/^https?:\/\//i.test(attachment.url)) return null;
    return (
      <li className="citation-card-attachment">
        <a href={attachment.url} target="_blank" rel="noopener noreferrer" className="citation-card-link">Open link</a>
      </li>
    );
  }
  const locator = attachmentLocator(item);
  const label = attachment.kind === "pdf"
    ? locator?.page ? `Open PDF at p. ${locator.page}` : "Open PDF"
    : `Open ${fileName(attachment.path)}`;
  return (
    <li className="citation-card-attachment">
      <button
        type="button"
        className="citation-card-button"
        disabled={!open}
        title={attachment.path}
        onClick={() => open?.(attachment, locator)}
      >
        {label}
      </button>
      {attachment.kind === "pdf" ? <PdfHighlights path={attachment.path} /> : null}
    </li>
  );
}

function CitingDocuments({ entry, notebook }: { entry: ReferenceEntry; notebook: string }) {
  const byKey = useAsync(() => fetchCitingDocuments(notebook), notebook);
  if (!byKey) return null;
  const paths = new Set([entry.key, ...(entry.aliases ?? [])].flatMap((key) => Array.isArray(byKey[key]) ? byKey[key] : []));
  return <p className="citation-card-meta">{paths.size === 1 ? "Cited in 1 document" : `Cited in ${paths.size} documents`}</p>;
}

function CardMarkdown({ label, markdown }: { label: string; markdown: string }) {
  return (
    <div className="citation-card-markdown">
      <p className="citation-card-label">{label}</p>
      <WithoutReferenceRender>
        <MarkdownRenderer content={markdown} baseFontSize={13} baseLineHeight={1.5} renderImages={false} />
      </WithoutReferenceRender>
    </div>
  );
}

function reveal(detail: ReferencesRevealDetail) {
  window.dispatchEvent(new CustomEvent<ReferencesRevealDetail>(REFERENCES_REVEAL_EVENT, { detail }));
}

function ResolvedItem({ item, entry, document }: { item: CitationItem; entry: ReferenceEntry; document: CitationDocumentValue | null }) {
  const render = useReferenceRender();
  const notebook = render?.notebook ?? null;
  const formatted = document?.formatting.result?.bibliographyEntries[entry.id];
  const abstract = typeof entry.csl.abstract === "string" ? entry.csl.abstract.trim() : "";
  const notes = entry.notes?.trim() ?? "";
  const attachments = entry.attachments.filter((attachment) => attachment.kind !== "url" || /^https?:\/\//i.test(attachment.url));
  return (
    <section className="citation-card-item">
      <div className="citation-card-reference">{formatted ? <FormattedCitationHtml html={formatted} /> : plainReference(entry)}</div>
      {retractionBadgeState(entry.retraction) ? (
        <p className="citation-card-retraction">
          <RetractionBadge status={entry.retraction} />
          <span className="citation-card-meta">{retractionDescription(entry.retraction)}</span>
        </p>
      ) : null}
      <p className="citation-card-key">@{entry.key}{item.key !== entry.key ? ` (cited as @${item.key})` : ""}</p>
      {abstract ? <CardMarkdown label="Abstract" markdown={abstract} /> : null}
      {notes ? <CardMarkdown label="Notes" markdown={notes} /> : null}
      {attachments.length ? (
        <ul className="citation-card-attachments">
          {attachments.map((attachment, index) => <AttachmentRow key={index} attachment={attachment} item={item} />)}
        </ul>
      ) : null}
      {notebook ? <CitingDocuments entry={entry} notebook={notebook} /> : null}
      {notebook ? (
        <button type="button" className="citation-card-button" onClick={() => reveal({ notebook, entryId: entry.id, key: entry.key })}>
          Show in References
        </button>
      ) : null}
    </section>
  );
}

function UnresolvedItem({ item }: { item: CitationItem }) {
  const render = useReferenceRender();
  const notebook = render?.notebook ?? null;
  const library = render?.library ?? null;
  const matches = library ? closeReferenceMatches(item.key, Object.values(library.entries)) : [];
  return (
    <section className="citation-card-item">
      <p className="citation-card-unresolved">Not in this notebook&apos;s references</p>
      <p className="citation-card-key">@{item.key}</p>
      {matches.length ? (
        <div>
          <p className="citation-card-label">Close matches</p>
          <ul className="citation-card-matches">
            {matches.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="citation-card-match" disabled={!notebook} onClick={() => notebook && reveal({ notebook, entryId: entry.id, key: entry.key })}>
                  <span className="citation-card-match-key">@{entry.key}</span>
                  <span className="citation-card-match-title">{plainReference(entry)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notebook ? (
        <button
          type="button"
          className="citation-card-button"
          onClick={() => window.dispatchEvent(new CustomEvent<ReferencesAddRequestDetail>(REFERENCES_ADD_REQUEST_EVENT, { detail: { notebook, query: item.key } }))}
        >
          Add to library…
        </button>
      ) : null}
    </section>
  );
}

type Position = { left: number; top: number };

export function CitationHoverCard({
  ref,
  id,
  anchor,
  citation,
  document: citationDocument,
  pinned,
  autoFocus,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: {
  ref?: Ref<HTMLDivElement>;
  id: string;
  anchor: RefObject<HTMLElement | null>;
  citation: Citation;
  document: CitationDocumentValue | null;
  pinned: boolean;
  autoFocus?: boolean;
  onClose: (returnFocus?: boolean) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const render = useReferenceRender();
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);

  // Below the chip, or above it when there is no room; always in the viewport.
  useLayoutEffect(() => {
    if (!card) return;
    const place = () => {
      const target = anchor.current;
      if (!target) return;
      const bounds = target.getBoundingClientRect();
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const left = Math.max(MARGIN, Math.min(bounds.left, viewportWidth - width - MARGIN));
      let top = bounds.bottom + GAP;
      if (top + height > viewportHeight - MARGIN && bounds.top - GAP - height >= MARGIN) top = bounds.top - GAP - height;
      top = Math.max(MARGIN, Math.min(top, viewportHeight - height - MARGIN));
      setPosition((current) => current && current.left === left && current.top === top ? current : { left, top });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(card);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [card, anchor]);

  useEffect(() => {
    if (autoFocus && card) card.querySelector<HTMLElement>("button:not([disabled]), a[href]")?.focus();
  }, [autoFocus, card]);

  // Esc closes the card wherever focus is; focus returns to the chip when it was in the card.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose(Boolean(card?.contains(window.document.activeElement)));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [card, onClose]);

  // A pinned card closes on a click outside it and its chip.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (card?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    window.document.addEventListener("pointerdown", onPointerDown, true);
    return () => window.document.removeEventListener("pointerdown", onPointerDown, true);
  }, [pinned, card, anchor, onClose]);

  if (!render || typeof window === "undefined") return null;
  const setRefs = (element: HTMLDivElement | null) => {
    setCard(element);
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  };
  const seen = new Set<string>();
  const items: ReactNode[] = [];
  citation.items.forEach((item, index) => {
    const entry = entryForKey(render.entriesByKey, item.key);
    if (entry) {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      items.push(<ResolvedItem key={index} item={item} entry={entry} document={citationDocument} />);
    } else if (render.library) {
      items.push(<UnresolvedItem key={index} item={item} />);
    }
  });
  if (!items.length) items.push(<p key="loading" className="citation-card-meta">{render.library ? "No cited works." : "Loading references…"}</p>);

  return createPortal(
    <div
      ref={setRefs}
      id={id}
      role="dialog"
      aria-label="Citation details"
      className="citation-hover-card"
      data-pinned={pinned ? "true" : undefined}
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: "hidden" }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {items}
    </div>,
    window.document.body,
  );
}
