"use client";

import { Extension, type Editor, type NodeViewRenderer } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection } from "@tiptap/pm/state";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { Plus, Replace, Trash2, X } from "lucide-react";
import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { entryForKey } from "@/lib/references/format";
import { CITATION_LOCATOR_LABELS, type Citation, type CitationItem, type CitationLocatorLabel } from "@/lib/references/types";
import {
  CITATION_NODE_NAME, citationOfNode, citationRawForTrigger, createCitationSuggestion, exitCitationSuggestion,
  updateCitationNode, type CitationSuggestionState,
} from "@/lib/tiptap-citation";
import { FormattedCitationHtml } from "./citation-chip";
import { CitationHoverCard } from "./citation-hover-card";
import { CitationPopup, citationPopupPosition, openCitationAttachment, type CitationPopupHandle } from "./citation-popup";
import {
  CitationDocumentContext,
  citationIndex,
  formattedCitation,
  useCitationDocument,
  useFormattedCitations,
  useReferenceRender,
  type CitationDocumentValue,
  type DocumentCitationList,
} from "./reference-render-context";

// The Visual editor's citations: the node view (formatted text from the
// document's citations, the raw token while formatting is pending, red when
// unresolved, the shared hover card), the popover that edits a citation's
// items, and the `@` popup through @tiptap/suggestion (tiptap-citation.ts).
//
// The editor creates one controller with `useTiptapCitations`, adds its
// extensions, and wraps its content in `TiptapCitationLayer`, which formats
// the document's citations (debounced, per document) and renders the popups.

const LIST_DELAY_MS = 300;
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 200;

type PopoverState = { pos: number; focusLocator: boolean };
type SearchState = { pos: number; mode: "add" } | { pos: number; mode: "swap"; item: number };

type CitationEditorValue = {
  openPopover: (pos: number, focusLocator?: boolean) => void;
  /** The node whose popover is open, so its hover card stays closed. */
  popoverPos: number | null;
};

const CitationEditorContext = createContext<CitationEditorValue | null>(null);

// ---------------------------------------------------------------------------
// Controller: extensions plus the `@` suggestion state
// ---------------------------------------------------------------------------

export type TiptapCitations = {
  nodeView: NodeViewRenderer;
  extensions: Extension[];
  /** The `@` suggestion while it is open. */
  subscribe: (listener: () => void) => () => void;
  getSuggestion: () => CitationSuggestionState | null;
  /** Route popup keys and Enter-on-a-selected-citation to the layer; returns a disconnect. */
  connect: (handlers: { keyDown: (event: KeyboardEvent) => boolean; activate: (pos: number) => void }) => () => void;
};

function createTiptapCitations(): TiptapCitations {
  let suggestion: CitationSuggestionState | null = null;
  const listeners = new Set<() => void>();
  const keyHandler: { current: ((event: KeyboardEvent) => boolean) | null } = { current: null };
  const activate: { current: ((pos: number) => void) | null } = { current: null };
  const suggestionExtension = createCitationSuggestion(() => ({
    onChange: (state) => {
      suggestion = state;
      for (const listener of listeners) listener();
    },
    onKeyDown: (event) => keyHandler.current?.(event) ?? false,
  }));
  // Enter on a selected citation opens its popover (keyboard access).
  const keys = Extension.create({
    name: "liberaCitationKeys",
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          const { selection } = editor.state;
          if (!(selection instanceof NodeSelection) || selection.node.type.name !== CITATION_NODE_NAME || !activate.current) return false;
          activate.current(selection.from);
          return true;
        },
      };
    },
  });
  return {
    nodeView: ReactNodeViewRenderer(CitationNodeView, { as: "span", className: "libera-citation-node" }),
    extensions: [suggestionExtension, keys],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSuggestion: () => suggestion,
    connect: (handlers) => {
      keyHandler.current = handlers.keyDown;
      activate.current = handlers.activate;
      return () => {
        if (keyHandler.current === handlers.keyDown) keyHandler.current = null;
        if (activate.current === handlers.activate) activate.current = null;
      };
    },
  };
}

/** One controller per editor component (stable across renders). */
export function useTiptapCitations() {
  const [citations] = useState(createTiptapCitations);
  return citations;
}

// ---------------------------------------------------------------------------
// The document's citations
// ---------------------------------------------------------------------------

const EMPTY_LIST: DocumentCitationList = { citations: [], bySourceId: new Map(), byStart: new Map() };

/** The citation nodes of a document, in order, indexed by position. */
export function tiptapDocumentCitations(editor: Editor): DocumentCitationList {
  const citations: Citation[] = [];
  const byStart = new Map<number, number>();
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== CITATION_NODE_NAME) return node.inlineContent || !node.isTextblock;
    byStart.set(pos, citations.length);
    citations.push(citationOfNode(node));
    return false;
  });
  return citations.length ? { citations, bySourceId: new Map(), byStart } : EMPTY_LIST;
}

/** The document's citations, refreshed after a pause in typing and only when they change. */
function useDocumentCitations(editor: Editor | null) {
  const [list, setList] = useState<DocumentCitationList>(() => editor ? tiptapDocumentCitations(editor) : EMPTY_LIST);
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      timer = null;
      if (editor.isDestroyed) return;
      const next = tiptapDocumentCitations(editor);
      setList((current) => {
        if (current.citations.length === next.citations.length && current.citations.every((citation, index) => citation.raw === next.citations[index].raw)) {
          const moved = [...next.byStart].some(([pos, index]) => current.byStart.get(pos) !== index);
          return moved ? next : current;
        }
        return next;
      });
    };
    refresh();
    const onUpdate = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(refresh, LIST_DELAY_MS);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (timer !== null) clearTimeout(timer);
    };
  }, [editor]);
  return list;
}

// ---------------------------------------------------------------------------
// Node view
// ---------------------------------------------------------------------------

function CitationNodeView({ node, getPos, editor, selected }: ReactNodeViewProps) {
  const render = useReferenceRender();
  const document = useCitationDocument();
  const context = useContext(CitationEditorContext);
  const raw = String(node.attrs.raw ?? "");
  const citation = useMemo(() => citationOfNode(node), [node]);
  const anchor = useRef<HTMLSpanElement>(null);
  const cardId = useId();
  const [card, setCard] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const pos = typeof getPos === "function" ? getPos() : undefined;
  const index = document ? citationIndex(document, raw, undefined, pos) : -1;
  const html = document ? formattedCitation(document, index, raw) : null;
  const unresolved = Boolean(render?.library) && citation.items.some((item) => !entryForKey(render!.entriesByKey, item.key));
  const editing = context?.popoverPos !== null && context?.popoverPos === pos;

  const scheduleOpen = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCard(true), HOVER_OPEN_MS);
  };
  const scheduleClose = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCard(false), HOVER_CLOSE_MS);
  };
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setCard(false);
  }, []);

  return (
    <NodeViewWrapper
      as="span"
      ref={anchor}
      className={`libera-citation${unresolved ? " libera-citation-unresolved" : ""}${selected ? " libera-citation-selected" : ""}`}
      data-libera-citation={raw}
      data-formatted={html ? "true" : undefined}
      role="button"
      aria-haspopup="dialog"
      aria-describedby={card ? cardId : undefined}
      title={render ? undefined : raw}
      onMouseEnter={render ? scheduleOpen : undefined}
      onMouseLeave={render ? scheduleClose : undefined}
      onMouseDown={(event: ReactMouseEvent) => {
        // Keep ProseMirror from starting a drag or a node selection under the popover.
        if (event.button === 0) event.preventDefault();
      }}
      onClick={(event: ReactMouseEvent) => {
        event.preventDefault();
        close();
        const at = typeof getPos === "function" ? getPos() : undefined;
        if (at === undefined) return;
        if (event.metaKey || event.ctrlKey) {
          openCitationAttachment(render, citation);
          return;
        }
        if (!editor.isEditable) return;
        context?.openPopover(at);
      }}
    >
      {html ? <FormattedCitationHtml html={html} /> : raw}
      {card && render && !editing ? (
        <CitationHoverCard
          id={cardId}
          anchor={anchor}
          citation={citation}
          document={document}
          pinned={false}
          onClose={close}
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={scheduleClose}
        />
      ) : null}
    </NodeViewWrapper>
  );
}

// ---------------------------------------------------------------------------
// Popover: edit a citation's items
// ---------------------------------------------------------------------------

const LABEL_NAMES: Partial<Record<CitationLocatorLabel, string>> = { "sub-verbo": "sub verbo", "article-locator": "article", "title-locator": "title" };

function nodeRect(editor: Editor, pos: number) {
  const dom = editor.view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
}

function usePlacement(editor: Editor, pos: number, element: HTMLElement | null) {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const update = () => {
      const rect = nodeRect(editor, pos);
      if (!rect) return;
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8 && rect.top - 6 - height >= 8) top = rect.top - 6 - height;
      setPlace((current) => current && current.left === left && current.top === top ? current : { left, top });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [editor, pos, element]);
  return place;
}

export function CitationEditPopover({ editor, pos, focusLocator, onClose, onSearch }: {
  editor: Editor;
  pos: number;
  focusLocator?: boolean;
  onClose: () => void;
  /** Open the search popup to add an item or swap one item's work (after the draft was applied). */
  onSearch: (search: SearchState) => void;
}) {
  const node = editor.state.doc.nodeAt(pos);
  const [items, setItems] = useState<CitationItem[]>(() => node && node.type.name === CITATION_NODE_NAME ? citationOfNode(node).items.map((item) => ({ ...item })) : []);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const place = usePlacement(editor, pos, element);
  const itemsRef = useRef(items);
  useLayoutEffect(() => { itemsRef.current = items; }, [items]);
  const id = useId();

  const apply = useCallback(() => updateCitationNode(editor, pos, { items: itemsRef.current }), [editor, pos]);
  const finish = useCallback((save: boolean) => {
    if (save) apply();
    onClose();
    editor.commands.focus(undefined, { scrollIntoView: false });
  }, [apply, editor, onClose]);

  useEffect(() => {
    if (!element) return;
    const target = focusLocator
      ? element.querySelector<HTMLElement>("[data-field='locator']")
      : element.querySelector<HTMLElement>("input, select, button");
    target?.focus();
    // Focus only once, when the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element]);

  // A click outside keeps the edits and closes the popover.
  useEffect(() => {
    if (!element) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (element.contains(target) || (target instanceof Element && target.closest("[data-citation-popup]"))) return;
      finish(true);
    };
    window.document.addEventListener("pointerdown", onPointerDown, true);
    return () => window.document.removeEventListener("pointerdown", onPointerDown, true);
  }, [element, finish]);

  if (!node || node.type.name !== CITATION_NODE_NAME || typeof window === "undefined") return null;
  const change = (index: number, patch: Partial<CitationItem>) => setItems((current) => current.map((item, at) => {
    if (at !== index) return item;
    const next: CitationItem = { ...item, ...patch };
    for (const field of ["prefix", "suffix", "locator"] as const) if (!next[field]?.trim()) delete next[field];
    if (!next.locator) delete next.label;
    if (!next.suppressAuthor) delete next.suppressAuthor;
    return next;
  }));
  const search = (state: SearchState) => {
    apply();
    onSearch(state);
  };

  return createPortal(
    <div
      ref={setElement}
      role="dialog"
      aria-label="Edit citation"
      aria-describedby={`${id}-help`}
      data-citation-popover=""
      className="fixed z-40 flex max-h-[min(32rem,calc(100vh-16px))] w-[min(26rem,calc(100vw-16px))] flex-col gap-2 overflow-auto rounded-lg border border-border bg-card p-3 text-sm shadow-xl"
      style={place ?? { left: 0, top: 0, visibility: "hidden" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        } else if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT" && (event.target as HTMLInputElement).type !== "checkbox") {
          event.preventDefault();
          finish(true);
        }
      }}
    >
      <p id={`${id}-help`} className="sr-only">Enter saves, Escape cancels.</p>
      {items.map((item, index) => (
        <fieldset key={index} className="flex flex-col gap-1.5 rounded-md border border-border p-2" data-citation-item={index}>
          <legend className="px-1 font-mono text-xs text-muted-foreground">@{item.key}</legend>
          <div className="flex items-center gap-1.5">
            <select
              aria-label={`Locator type for @${item.key}`}
              className="rounded-md border border-border bg-card px-1.5 py-1 text-xs"
              value={item.label ?? "page"}
              onChange={(event) => change(index, { label: event.target.value as CitationLocatorLabel })}
            >
              {CITATION_LOCATOR_LABELS.map((label) => <option key={label} value={label}>{LABEL_NAMES[label] ?? label}</option>)}
            </select>
            <input
              aria-label={`Locator for @${item.key}`}
              data-field={index === items.length - 1 ? "locator" : undefined}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
              placeholder="e.g. 12-14"
              value={item.locator ?? ""}
              onChange={(event) => change(index, { locator: event.target.value, label: item.label ?? "page" })}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <input aria-label={`Prefix for @${item.key}`} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs" placeholder="Prefix (see)" value={item.prefix ?? ""} onChange={(event) => change(index, { prefix: event.target.value })} />
            <input aria-label={`Suffix for @${item.key}`} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs" placeholder="Suffix" value={item.suffix ?? ""} onChange={(event) => change(index, { suffix: event.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={Boolean(item.suppressAuthor)} onChange={(event) => change(index, { suppressAuthor: event.target.checked })} />
              Suppress author
            </label>
            <button type="button" className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-muted" onClick={() => search({ pos, mode: "swap", item: index })}>
              <Replace aria-hidden className="h-3.5 w-3.5" /> Swap work
            </button>
            <button
              type="button"
              aria-label={`Remove @${item.key}`}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-destructive hover:bg-destructive-muted"
              onClick={() => {
                const next = items.filter((_, at) => at !== index);
                setItems(next);
                itemsRef.current = next;
                if (!next.length) finish(true);
              }}
            >
              <Trash2 aria-hidden className="h-3.5 w-3.5" /> Remove
            </button>
          </div>
        </fieldset>
      ))}
      <div className="flex items-center gap-2">
        <button type="button" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => search({ pos, mode: "add" })}>
          <Plus aria-hidden className="h-3.5 w-3.5" /> Add item
        </button>
        <button type="button" className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted" onClick={() => finish(false)}>
          <X aria-hidden className="h-3.5 w-3.5" /> Cancel
        </button>
        <button type="button" className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground" onClick={() => finish(true)}>Done</button>
      </div>
    </div>,
    window.document.body,
  );
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/** Formats the document's citations for its node views and renders the `@` popup, the popover and the search popup. */
export function TiptapCitationLayer({ editor, citations, children }: { editor: Editor; citations: TiptapCitations; children?: ReactNode }) {
  const render = useReferenceRender();
  const list = useDocumentCitations(editor);
  const formatting = useFormattedCitations(render ? list.citations : null);
  const document = useMemo<CitationDocumentValue>(() => ({ list, offset: 0, formatting, appendedBibliography: false }), [list, formatting]);
  const citedKeys = useMemo(() => [...new Set(list.citations.flatMap((citation) => citation.items.map((item) => item.key)))], [list]);
  const suggestion = useSyncExternalStore(citations.subscribe, citations.getSuggestion, () => null);
  const popupRef = useRef<CitationPopupHandle>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);

  const openPopover = useCallback((pos: number, focusLocator = false) => {
    setSearch(null);
    setPopover({ pos, focusLocator });
  }, []);
  useLayoutEffect(() => citations.connect({
    keyDown: (event) => popupRef.current?.handleKey(event) ?? false,
    activate: (pos) => openPopover(pos),
  }), [citations, openPopover]);

  const insert = useCallback((key: string, { locator, pageLocator }: { locator: boolean; pageLocator?: string }) => {
    const state = citations.getSuggestion();
    if (!state) return;
    const { trigger } = state;
    const raw = citationRawForTrigger(trigger, key, pageLocator);
    let at = trigger.range.from;
    // One undo step: the typed `@query` becomes the citation node.
    // No focus command: the editor has focus while typing, and a deferred focus would take it from the popover.
    editor.chain().command(({ tr, state: current }) => {
      closeHistory(tr);
      const marks = current.doc.resolve(trigger.range.from).marks().filter((mark) => !mark.type.spec.code);
      tr.replaceWith(trigger.range.from, trigger.range.to, current.schema.nodes[CITATION_NODE_NAME].create({ raw }, null, marks));
      at = trigger.range.from;
      return true;
    }).run();
    exitCitationSuggestion(editor);
    // Tab: edit the new citation's locator.
    if (locator) openPopover(at, true);
  }, [citations, editor, openPopover]);

  const choose = useCallback((key: string) => {
    if (!search) return;
    const node = editor.state.doc.nodeAt(search.pos);
    if (!node || node.type.name !== CITATION_NODE_NAME) return;
    const items = citationOfNode(node).items.map((item) => ({ ...item }));
    if (search.mode === "add") items.push({ key });
    else if (items[search.item]) items[search.item] = { ...items[search.item], key };
    updateCitationNode(editor, search.pos, { items });
    setSearch(null);
    setPopover({ pos: search.pos, focusLocator: false });
  }, [editor, search]);

  const suggestionRect = suggestion?.clientRect?.() ?? null;
  const popupPoint = suggestionRect ? citationPopupPosition({ x: suggestionRect.left, y: suggestionRect.bottom }) : null;
  const searchRect = search ? nodeRect(editor, search.pos) : null;
  const searchPoint = searchRect ? citationPopupPosition({ x: searchRect.left, y: searchRect.bottom }) : null;
  const popoverNode = popover ? editor.state.doc.nodeAt(popover.pos) : null;

  const value = useMemo<CitationEditorValue>(() => ({ openPopover, popoverPos: popover?.pos ?? null }), [openPopover, popover]);
  return (
    <CitationEditorContext.Provider value={value}>
      <CitationDocumentContext.Provider value={document}>
        {children}
        {suggestion && popupPoint ? (
          <CitationPopup
            ref={popupRef}
            query={suggestion.trigger.query}
            citedKeys={citedKeys}
            x={popupPoint.x}
            y={popupPoint.y}
            onInsert={insert}
            onClose={() => exitCitationSuggestion(editor)}
          />
        ) : null}
        {popover && popoverNode && !search ? (
          <CitationEditPopover
            key={`${popover.pos}:${String(popoverNode.attrs.raw)}`}
            editor={editor}
            pos={popover.pos}
            focusLocator={popover.focusLocator}
            onClose={() => setPopover(null)}
            onSearch={(state) => setSearch(state)}
          />
        ) : null}
        {search && searchPoint ? (
          <CitationPopup
            searchInput
            query=""
            citedKeys={citedKeys}
            x={searchPoint.x}
            y={searchPoint.y}
            onInsert={(key) => choose(key)}
            onClose={() => {
              setSearch(null);
              setPopover({ pos: search.pos, focusLocator: false });
            }}
          />
        ) : null}
      </CitationDocumentContext.Provider>
    </CitationEditorContext.Provider>
  );
}
