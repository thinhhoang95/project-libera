"use client";

import { BookOpen, Loader2, Plus } from "lucide-react";
import {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type Ref, type RefObject,
} from "react";
import { entryForKey } from "@/lib/references/format";
import { classifyReferenceInput } from "@/lib/references/identifiers";
import {
  buildReferenceSuggestionIndex, noteRecentCitation, recentCitationKeys, referenceYear,
  type ReferenceSuggestion,
} from "@/lib/references/reference-suggestions";
import {
  REFERENCES_ADD_REQUEST_EVENT,
  type Citation,
  type CslItem,
  type ReferenceEntry,
  type ReferenceEntryInput,
  type ReferenceIdentifiers,
  type ReferenceLibrary,
  type ReferencesAddRequestDetail,
} from "@/lib/references/types";
import { CitationHoverCard } from "./citation-hover-card";
import {
  attachmentLocator,
  useFormattedCitations,
  useReferenceRender,
  type CitationDocumentValue,
  type ReferenceRenderValue,
} from "./reference-render-context";
import { useReferenceLibrary } from "./use-reference-library";

// The `@` citation popup (plan.md §1.3 "Typing @"), shared by the textarea,
// CodeMirror and Visual editors. It looks and behaves like the file-link
// popup (markdown-file-link-popup.tsx): a fixed card at the caret that keeps
// the editor focused, driven by the editor's own keydown handler through
// `handleKey`. Rows are library entries ranked by reference-suggestions.ts,
// then footer rows: Add reference from an identifier (resolve, preview, Add &
// cite, or an unresolved stub when the lookup fails) and Open References.
// Enter cites in brackets (`[@key]`); Shift+Enter cites in the text, the
// narrative form (`@key`), where the editor allows it (`narrativeAllowed`).
//
// The editors also share the hover card for citations in their text
// (`EditorCitationHover`) and Ctrl/Cmd+click to open a cited attachment.

export const CITATION_POPUP_WIDTH = 384;
export const CITATION_POPUP_HEIGHT = 384;

/** The popup's top-left corner for a caret point, kept inside the viewport like the file-link popup. */
export function citationPopupPosition(point: { x: number; y: number }) {
  const width = Math.min(CITATION_POPUP_WIDTH, window.innerWidth - 16);
  return {
    x: Math.max(8, Math.min(point.x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(point.y + 6, window.innerHeight - CITATION_POPUP_HEIGHT - 8)),
  };
}

export type CitationPopupKey = { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };

export type CitationPopupHandle = {
  /** Handle a key pressed in the editor while the popup is open; true when the popup used it. */
  handleKey: (event: CitationPopupKey) => boolean;
};

export type CitationPopupProps = {
  /** Key characters typed after `@`. Ignored with `searchInput`, which has its own query. */
  query: string;
  x: number;
  y: number;
  /** Keys cited in the document, in order (boosted, and listed first for an empty query). */
  citedKeys?: readonly string[];
  /** Show a search field (adding or swapping an item from the Visual editor's citation popover). */
  searchInput?: boolean;
  /** Shift+Enter inserts a narrative citation (`@key`); the footer says so. False inside brackets. */
  narrativeAllowed?: boolean;
  /** `narrative`: Shift+Enter chose the narrative form. */
  onInsert: (key: string, options: { locator: boolean; narrative?: boolean }) => void;
  onClose: () => void;
  ref?: Ref<CitationPopupHandle>;
};

// ---------------------------------------------------------------------------
// Entry text
// ---------------------------------------------------------------------------

function familyName(csl: CslItem) {
  const name = csl.author?.[0] ?? csl.editor?.[0];
  return name ? [name["non-dropping-particle"], name.family ?? name.literal].filter(Boolean).join(" ") : "";
}

/** `Smith (2020)`, `Smith & Lee (2020)`, `Smith et al. (2020)`. */
export function entryAuthorsYear(entry: Pick<ReferenceEntry, "csl">) {
  const csl = entry.csl;
  const people = csl.author?.length ? csl.author : csl.editor ?? [];
  const first = familyName(csl);
  const second = people[1] ? [people[1]["non-dropping-particle"], people[1].family ?? people[1].literal].filter(Boolean).join(" ") : "";
  const authors = !first ? "" : people.length > 2 ? `${first} et al.` : second ? `${first} & ${second}` : first;
  const year = referenceYear(csl);
  return [authors || "Unknown author", year ? `(${year})` : ""].filter(Boolean).join(" ");
}

function entryTitle(entry: Pick<ReferenceEntry, "csl">) {
  return typeof entry.csl.title === "string" && entry.csl.title.trim() ? entry.csl.title : "Untitled";
}

function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  ranges.forEach(([start, end], index) => {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<mark key={index} className="rounded-sm bg-transparent font-semibold text-foreground">{text.slice(start, end)}</mark>);
    last = end;
  });
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Ranges of `suggestion` moved into `line`, when the matched text appears in it. */
function rangesIn(line: string, suggestion: ReferenceSuggestion) {
  if (!suggestion.highlights.length) return [];
  const at = line.indexOf(suggestion.matchedText);
  if (at < 0) return [];
  return suggestion.highlights.map(([start, end]): [number, number] => [at + start, at + end]);
}

function StatusBadge({ status }: { status: ReferenceEntry["status"] }) {
  if (status === "confirmed") return null;
  const unresolved = status === "unresolved";
  return (
    <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${unresolved ? "bg-destructive-muted text-destructive" : "bg-muted text-muted-foreground"}`}>
      {unresolved ? "Unresolved" : "Needs review"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Adding a reference from an identifier
// ---------------------------------------------------------------------------

type ResolveResponse = { candidates?: ReferenceEntryInput[]; duplicates?: Array<{ candidateIndex: number; entryId: string }> };

type AddState =
  | { phase: "idle" }
  | { phase: "resolving"; input: string }
  | { phase: "preview"; input: string; candidate: ReferenceEntryInput; existing: ReferenceEntry | null }
  | { phase: "adding"; input: string }
  | { phase: "error"; input: string; message: string };

const IDENTIFIER_KINDS = new Set(["doi", "arxiv", "isbn", "pmid", "pmcid", "url"]);

/** The identifier a query names, or null. Bare numbers of up to four digits read as years, not PubMed IDs. */
export function citationQueryIdentifier(query: string) {
  if (!query.trim()) return null;
  const classified = classifyReferenceInput(query);
  if (!IDENTIFIER_KINDS.has(classified.kind) || !classified.value) return null;
  if (classified.kind === "pmid" && /^\d{1,4}$/.test(query.trim())) return null;
  return { kind: classified.kind as "doi" | "arxiv" | "isbn" | "pmid" | "pmcid" | "url", value: classified.value };
}

/** An `unresolved` entry holding just the identifier, for when it cannot be looked up. */
export function unresolvedStubEntry(identifier: NonNullable<ReturnType<typeof citationQueryIdentifier>>): ReferenceEntryInput {
  const identifiers: ReferenceIdentifiers = {};
  const csl: CslItem = { type: identifier.kind === "isbn" ? "book" : identifier.kind === "url" ? "webpage" : "article-journal" };
  if (identifier.kind === "doi") { identifiers.doi = identifier.value; csl.DOI = identifier.value; }
  else if (identifier.kind === "arxiv") identifiers.arxiv = identifier.value;
  else if (identifier.kind === "isbn") { identifiers.isbn = [identifier.value]; csl.ISBN = identifier.value; }
  else if (identifier.kind === "pmid") { identifiers.pmid = identifier.value; csl.PMID = identifier.value; }
  else if (identifier.kind === "pmcid") { identifiers.pmcid = identifier.value; csl.PMCID = identifier.value; }
  else csl.URL = identifier.value;
  return {
    csl,
    identifiers,
    status: "unresolved",
    attachments: identifier.kind === "url" ? [{ kind: "url", url: identifier.value }] : [],
  };
}

/** The entry `apply` added: the one whose id the previous library did not have. */
function addedEntry(before: ReferenceLibrary | null, after: ReferenceLibrary) {
  const known = new Set(Object.keys(before?.entries ?? {}));
  return Object.values(after.entries).find((entry) => !known.has(entry.id)) ?? null;
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

type Row =
  | { kind: "entry"; id: string; suggestion: ReferenceSuggestion }
  | { kind: "add"; id: "add"; input: string }
  | { kind: "confirm"; id: "confirm" }
  | { kind: "open"; id: "open" };

export function CitationPopup({ query: typedQuery, x, y, citedKeys, searchInput = false, narrativeAllowed = false, onInsert, onClose, ref }: CitationPopupProps) {
  const render = useReferenceRender();
  const notebook = render?.notebook ?? null;
  const library = render?.library ?? null;
  const { apply, loading } = useReferenceLibrary(notebook);
  const [searchQuery, setSearchQuery] = useState("");
  const query = searchInput ? searchQuery : typedQuery;
  const [active, setActive] = useState(0);
  const [add, setAdd] = useState<AddState>({ phase: "idle" });
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const [prevQuery, setPrevQuery] = useState(query);
  if (prevQuery !== query) {
    // A new query starts at the first row and drops a finished lookup for the old one.
    setPrevQuery(query);
    setActive(0);
    setAdd({ phase: "idle" });
  }

  const suggestions = useMemo(() => {
    if (!library) return [];
    return buildReferenceSuggestionIndex(library).search(query.trim(), { citedKeys: citedKeys ? [...citedKeys] : [], recentKeys: recentCitationKeys() });
  }, [library, query, citedKeys]);
  const identifier = useMemo(() => citationQueryIdentifier(query), [query]);

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = suggestions.map((suggestion) => ({ kind: "entry", id: `entry:${suggestion.entry.id}`, suggestion }));
    if (notebook && identifier) {
      if (add.phase === "preview") list.push({ kind: "confirm", id: "confirm" });
      else list.push({ kind: "add", id: "add", input: identifier.value });
    }
    if (notebook) list.push({ kind: "open", id: "open" });
    return list;
  }, [suggestions, notebook, identifier, add.phase]);
  const selected = rows.length ? Math.min(active, rows.length - 1) : 0;

  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  useEffect(() => {
    if (searchInput) inputRef.current?.focus();
  }, [searchInput]);
  useEffect(() => () => { request.current += 1; }, []);

  const insert = useCallback((key: string, locator: boolean, narrative = false) => {
    noteRecentCitation(key);
    onInsert(key, narrative ? { locator, narrative } : { locator });
  }, [onInsert]);

  const addAndCite = useCallback(async (entry: ReferenceEntryInput, locator: boolean, narrative = false) => {
    const before = library;
    const id = ++request.current;
    setAdd({ phase: "adding", input: identifier?.value ?? query });
    try {
      const after = await apply([{ op: "add", entry }]);
      if (id !== request.current) return;
      const added = addedEntry(before, after);
      if (!added) throw new Error("The reference was not added.");
      insert(added.key, locator, narrative);
    } catch (error) {
      if (id === request.current) setAdd({ phase: "error", input: identifier?.value ?? query, message: error instanceof Error ? error.message : "Could not add the reference." });
    }
  }, [apply, identifier, insert, library, query]);

  const resolve = useCallback(async () => {
    if (!notebook || !identifier) return;
    const id = ++request.current;
    setAdd({ phase: "resolving", input: identifier.value });
    let response: ResolveResponse | null = null;
    try {
      const result = await fetch("/api/references/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebook, input: identifier.value }),
      });
      if (result.ok) response = await result.json() as ResolveResponse;
    } catch {
      response = null;
    }
    if (id !== request.current) return;
    const candidate = response?.candidates?.[0];
    if (!candidate) {
      // The lookup failed: keep the identifier as an unresolved entry and cite it.
      await addAndCite(unresolvedStubEntry(identifier), false);
      return;
    }
    const duplicate = response?.duplicates?.find((item) => item.candidateIndex === 0);
    const existing = duplicate ? library?.entries[duplicate.entryId] ?? null : null;
    setAdd({ phase: "preview", input: identifier.value, candidate, existing });
  }, [addAndCite, identifier, library, notebook]);

  const choose = useCallback((row: Row | undefined, locator: boolean, narrative = false) => {
    if (!row) return;
    if (row.kind === "entry") insert(row.suggestion.key, locator, narrative);
    else if (row.kind === "add") void resolve();
    else if (row.kind === "confirm" && add.phase === "preview") {
      if (add.existing) insert(add.existing.key, locator, narrative);
      else void addAndCite(add.candidate, locator, narrative);
    } else if (row.kind === "open" && notebook) {
      window.dispatchEvent(new CustomEvent<ReferencesAddRequestDetail>(REFERENCES_ADD_REQUEST_EVENT, { detail: { notebook, query } }));
      onClose();
    }
  }, [add, addAndCite, insert, notebook, onClose, query, resolve]);

  const handleKey = useCallback((event: CitationPopupKey) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return false;
    switch (event.key) {
      case "Escape":
        onClose();
        return true;
      case "ArrowDown":
        if (rows.length) setActive((selected + 1) % rows.length);
        return true;
      case "ArrowUp":
        if (rows.length) setActive((selected - 1 + rows.length) % rows.length);
        return true;
      case "Enter":
        if (!rows.length) return false;
        // Shift+Enter: the narrative form, `@key`.
        choose(rows[selected], false, narrativeAllowed && Boolean(event.shiftKey));
        return true;
      case "Tab":
        if (!rows.length || event.shiftKey) return false;
        choose(rows[selected], rows[selected].kind === "entry" || rows[selected].kind === "confirm");
        return true;
      default:
        return false;
    }
  }, [choose, narrativeAllowed, onClose, rows, selected]);
  useImperativeHandle(ref, () => ({ handleKey }), [handleKey]);

  const busy = add.phase === "resolving" || add.phase === "adding";
  let empty: string | null = null;
  if (!notebook || (!library && !loading)) empty = "No library for this notebook";
  else if (!library) empty = "Loading references…";
  else if (!suggestions.length) empty = query.trim() ? "No matches" : "No references yet";

  return (
    <div
      role="listbox"
      aria-label="Cite a reference"
      className="fixed z-40 flex max-h-96 w-96 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
      data-citation-popup=""
      style={{ left: x, top: y }}
      onMouseDown={(event) => { if (event.target !== inputRef.current) event.preventDefault(); }}
    >
      {searchInput ? (
        <input
          ref={inputRef}
          aria-label="Search references"
          className="m-1 h-8 shrink-0 rounded border border-border bg-background px-2 text-sm outline-none"
          placeholder="Search references"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (handleKey(event)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        />
      ) : null}
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-1">
        {empty ? <div className="px-2.5 py-2 text-sm text-muted-foreground">{empty}</div> : null}
        {rows.map((row, index) => {
          const isActive = index === selected;
          const rowClass = `flex w-full min-w-0 items-start gap-2 rounded px-2.5 py-2 text-left ${isActive ? "bg-muted" : "hover:bg-muted"}`;
          const common = {
            role: "option" as const,
            "aria-selected": isActive,
            "data-row-index": index,
            className: rowClass,
            type: "button" as const,
            onMouseEnter: () => setActive(index),
            onClick: (event: { shiftKey: boolean }) => choose(row, false, narrativeAllowed && event.shiftKey),
          };
          if (row.kind === "entry") {
            const { suggestion } = row;
            const authors = entryAuthorsYear(suggestion.entry);
            const title = entryTitle(suggestion.entry);
            return (
              <button key={row.id} {...common} data-citation-key={suggestion.key}>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      <Highlighted text={authors} ranges={suggestion.matchedField === "author" || suggestion.matchedField === "year" ? rangesIn(authors, suggestion) : []} />
                    </span>
                    <StatusBadge status={suggestion.entry.status} />
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                      @<Highlighted text={suggestion.key} ranges={suggestion.matchedField === "key" && suggestion.matchedText === suggestion.key ? suggestion.highlights : []} />
                    </span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    <Highlighted text={title} ranges={suggestion.matchedField === "title" ? rangesIn(title, suggestion) : []} />
                  </span>
                  {suggestion.matchedField === "key" && suggestion.matchedText !== suggestion.key ? (
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      alias @<Highlighted text={suggestion.matchedText} ranges={suggestion.highlights} />
                    </span>
                  ) : null}
                </span>
              </button>
            );
          }
          if (row.kind === "add") {
            return (
              <button key={row.id} {...common} disabled={busy} aria-disabled={busy} className={`${rowClass} border-t border-border`}>
                {busy ? <Loader2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : <Plus aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {add.phase === "resolving" ? `Looking up “${row.input}”…` : add.phase === "adding" ? `Adding “${row.input}”…` : `Add reference from “${row.input}”`}
                  </span>
                  {add.phase === "error" ? <span role="alert" className="block truncate text-xs text-destructive">{add.message}</span> : null}
                </span>
              </button>
            );
          }
          if (row.kind === "confirm" && add.phase === "preview") {
            const candidate = add.existing ?? { csl: add.candidate.csl };
            return (
              <button key={row.id} {...common} className={`${rowClass} border-t border-border`} data-citation-confirm="">
                <Plus aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{entryAuthorsYear(candidate)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{entryTitle(candidate)}</span>
                  <span className="mt-1 inline-block rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                    {add.existing ? `Already in library: cite @${add.existing.key}` : "Add & cite"}
                  </span>
                </span>
              </button>
            );
          }
          return (
            <button key={row.id} {...common} className={`${rowClass} ${row.kind === "open" && !identifier ? "border-t border-border" : ""}`}>
              <BookOpen aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">Open References</span>
            </button>
          );
        })}
      </div>
      {narrativeAllowed && suggestions.length ? (
        <div className="shrink-0 border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground" data-citation-popup-hint="">
          <kbd className="font-sans">Enter</kbd> cites [@key] · <kbd className="font-sans">Shift+Enter</kbd> cites in the text, @key
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Citations in editor text: hover card and Ctrl/Cmd+click
// ---------------------------------------------------------------------------

/**
 * Open the first attachment of the first cited work that has one (a PDF
 * before a Markdown note), at the item's locator. Returns false when there is
 * nothing to open.
 */
export function openCitationAttachment(render: ReferenceRenderValue | null, citation: Pick<Citation, "items">) {
  const open = render?.onOpenAttachment;
  if (!render || !open) return false;
  for (const item of citation.items) {
    const entry = entryForKey(render.entriesByKey, item.key);
    const attachment = entry?.attachments.find((candidate) => candidate.kind === "pdf") ??
      entry?.attachments.find((candidate) => candidate.kind === "markdown");
    if (!attachment) continue;
    open(attachment, attachmentLocator(item));
    return true;
  }
  return false;
}

/** Whether every key of a citation is in the library; null while there is no library. */
export function citationResolved(render: ReferenceRenderValue | null, citation: Pick<Citation, "items">) {
  if (!render?.library) return null;
  return citation.items.every((item) => entryForKey(render.entriesByKey, item.key));
}

const EMPTY_DOCUMENT_LIST = { citations: [] as Citation[], bySourceId: new Map<string, number>(), byStart: new Map<number, number>() };

/**
 * A one-citation document for a hover card in a source editor: it formats the
 * hovered citation only, so the card can show each work's formatted reference
 * without formatting the whole document on every edit.
 */
export function useSingleCitationDocument(citation: Citation | null): CitationDocumentValue | null {
  const citations = useMemo(() => citation ? [citation] : null, [citation]);
  const formatting = useFormattedCitations(citations);
  return useMemo(() => citation ? {
    list: { ...EMPTY_DOCUMENT_LIST, citations: [citation] },
    offset: 0,
    formatting,
    appendedBibliography: false,
  } : null, [citation, formatting]);
}

export type EditorCitationHoverTarget = {
  citation: Citation;
  /** The citation's box on screen (viewport coordinates). */
  rect: () => DOMRect | null;
};

/**
 * The hover card for a citation in a source editor, anchored to a rectangle
 * rather than an element. `target` comes from the editor's mouse handling;
 * the card stays open while the pointer is on it.
 */
export function EditorCitationHover({ target, onClose, onPointerEnter, onPointerLeave }: {
  target: EditorCitationHoverTarget;
  onClose: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const document = useSingleCitationDocument(target.citation);
  const anchor = useMemo<RefObject<HTMLElement | null>>(() => ({
    current: {
      getBoundingClientRect: () => target.rect() ?? new DOMRect(-1000, -1000, 0, 0),
      contains: () => false,
    } as unknown as HTMLElement,
  }), [target]);
  return (
    <CitationHoverCard
      id="libera-editor-citation-card"
      anchor={anchor}
      citation={target.citation}
      document={document}
      pinned={false}
      onClose={onClose}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    />
  );
}

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 200;

/**
 * Hover timing for `EditorCitationHover`: `show` after the pointer rests on a
 * citation, `hide` after it leaves both the citation and the card.
 */
export function useEditorCitationHover() {
  const [target, setTarget] = useState<EditorCitationHoverTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = useRef<EditorCitationHoverTarget | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const show = useCallback((next: EditorCitationHoverTarget | null) => {
    if (next && current.current?.citation.raw === next.citation.raw) {
      clearTimeout(timer.current);
      return;
    }
    clearTimeout(timer.current);
    if (!next) {
      if (!current.current) return;
      timer.current = setTimeout(() => { current.current = null; setTarget(null); }, HOVER_CLOSE_MS);
      return;
    }
    timer.current = setTimeout(() => { current.current = next; setTarget(next); }, HOVER_OPEN_MS);
  }, []);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    current.current = null;
    setTarget(null);
  }, []);
  const keep = useCallback(() => clearTimeout(timer.current), []);
  const element = target ? <EditorCitationHover target={target} onClose={close} onPointerEnter={keep} onPointerLeave={() => show(null)} /> : null;
  return { target, show, close, element };
}
