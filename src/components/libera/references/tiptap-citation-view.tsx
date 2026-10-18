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
import { canBeNarrative, narrativeMayFollow, resolvedCitationOccurrences } from "@/lib/references/citation-syntax";
import { entryForKey } from "@/lib/references/format";
import { BUNDLED_CSL_STYLES, CITATION_LOCATOR_LABELS, type Citation, type CitationItem, type CitationLocatorLabel } from "@/lib/references/types";
import {
  CITATION_NODE_NAME, citationOfNode, citationRawForTrigger, createCitationSuggestion, exitCitationSuggestion,
  updateCitationNode, type CitationSuggestionState,
} from "@/lib/tiptap-citation";
import { setTiptapDocumentStyle, tiptapDocumentStyle, tiptapDocumentStyleValue } from "@/lib/tiptap-front-matter";
import { FormattedCitationHtml } from "./citation-chip";
import { CitationHoverCard } from "./citation-hover-card";
import { CitationPopup, citationPopupPosition, openCitationAttachment, type CitationPopupHandle } from "./citation-popup";
import {
  CitationDocumentContext,
  citationIndex,
  formattedCitation,
  useCitationDocument,
  referenceKeyResolver,
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
// the document's citations (debounced, per document, in the style its front
// matter names) and renders the popups.
//
// Narrative citations (`@key`, attr `narrative`) are citations only when the
// library knows the key. An unresolved one shows as the plain text it is;
// Backspace right after it turns it back into editable text (minus the last
// character), and its popover offers "Edit as text". The popover's Narrative
// toggle switches between `[@key]` and `@key`, and its Document style select
// writes `citation-style` into the document's front matter.

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
  /** Route popup keys, Enter-on-a-selected-citation and the key check to the layer; returns a disconnect. */
  connect: (handlers: { keyDown: (event: KeyboardEvent) => boolean; activate: (pos: number) => void; resolves?: () => ((key: string) => boolean) | null }) => () => void;
};

/** Whether a node is a narrative citation the library does not resolve (plain text, not a citation). */
function unresolvedNarrative(node: { attrs: Record<string, unknown> } | null | undefined, resolves: ((key: string) => boolean) | null) {
  if (!node?.attrs.narrative) return false;
  const key = /^@([^\s[]+)/.exec(String(node.attrs.raw ?? ""))?.[1];
  return !key || !resolves?.(key);
}

function createTiptapCitations(): TiptapCitations {
  let suggestion: CitationSuggestionState | null = null;
  const listeners = new Set<() => void>();
  const keyHandler: { current: ((event: KeyboardEvent) => boolean) | null } = { current: null };
  const activate: { current: ((pos: number) => void) | null } = { current: null };
  const resolver: { current: (() => ((key: string) => boolean) | null) | null } = { current: null };
  const suggestionExtension = createCitationSuggestion(() => ({
    onChange: (state) => {
      suggestion = state;
      for (const listener of listeners) listener();
    },
    onKeyDown: (event) => keyHandler.current?.(event) ?? false,
  }));
  // Enter on a selected citation opens its popover (keyboard access).
  // Backspace after an unresolved narrative `@word` edits it as the text it is.
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
        Backspace: ({ editor }) => {
          const { selection } = editor.state;
          const before = selection.empty ? selection.$from.nodeBefore : null;
          if (!before || before.type.name !== CITATION_NODE_NAME || !unresolvedNarrative(before, resolver.current?.() ?? null)) return false;
          const raw = String(before.attrs.raw ?? "");
          const from = selection.from - before.nodeSize;
          // A narrative token is at least `@k`, so some text always remains.
          editor.view.dispatch(editor.state.tr.replaceWith(from, selection.from, editor.schema.text(raw.slice(0, -1), before.marks)));
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
      resolver.current = handlers.resolves ?? null;
      return () => {
        if (keyHandler.current === handlers.keyDown) keyHandler.current = null;
        if (activate.current === handlers.activate) activate.current = null;
        if (resolver.current === handlers.resolves) resolver.current = null;
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

/** The document's citations, refreshed after a pause in typing and only when they change; and its own style. */
function useDocumentCitations(editor: Editor | null) {
  const [list, setList] = useState<DocumentCitationList>(() => editor ? tiptapDocumentCitations(editor) : EMPTY_LIST);
  const [style, setStyle] = useState<string | null>(() => editor ? tiptapDocumentStyle(editor.state.doc) : null);
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      timer = null;
      if (editor.isDestroyed) return;
      setStyle(tiptapDocumentStyle(editor.state.doc));
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
  return { list, style };
}

/** The list without narrative citations the library does not resolve (they render as text). */
function resolvedList(list: DocumentCitationList, resolves: ((key: string) => boolean) | null): DocumentCitationList {
  if (!list.citations.some((citation) => citation.narrative)) return list;
  const kept = resolvedCitationOccurrences(list.citations.map((citation, index) => ({ citation, index })), resolves);
  if (kept.length === list.citations.length) return list;
  const position = new Map(kept.map((entry, index) => [entry.index, index]));
  const byStart = new Map<number, number>();
  for (const [start, index] of list.byStart) {
    const next = position.get(index);
    if (next !== undefined) byStart.set(start, next);
  }
  return kept.length ? { citations: kept.map((entry) => entry.citation), bySourceId: new Map(), byStart } : EMPTY_LIST;
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
  // An unresolved narrative `@word` is text, not a citation: no chip, no hover card.
  const plainText = Boolean(node.attrs.narrative) && unresolvedNarrative(node, referenceKeyResolver(render));

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

  if (plainText) {
    return (
      <NodeViewWrapper
        as="span"
        className={`libera-citation-text${selected ? " libera-citation-selected" : ""}`}
        data-libera-citation={raw}
        data-libera-narrative=""
        title={editor.isEditable ? "Not in this notebook's references. Click to edit; Backspace edits it as text." : undefined}
        onMouseDown={(event: ReactMouseEvent) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={(event: ReactMouseEvent) => {
          event.preventDefault();
          const at = typeof getPos === "function" ? getPos() : undefined;
          if (at !== undefined && editor.isEditable) context?.openPopover(at);
        }}
      >
        {raw}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      ref={anchor}
      className={`libera-citation${unresolved ? " libera-citation-unresolved" : ""}${selected ? " libera-citation-selected" : ""}`}
      data-libera-citation={raw}
      data-libera-narrative={node.attrs.narrative ? "" : undefined}
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
  const [narrative, setNarrative] = useState(() => Boolean(node?.attrs.narrative));
  const narrativeRef = useRef(narrative);
  useLayoutEffect(() => { narrativeRef.current = narrative; }, [narrative]);
  const [documentStyle, setDocumentStyle] = useState(() => tiptapDocumentStyleValue(editor.state.doc));
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const place = usePlacement(editor, pos, element);
  const itemsRef = useRef(items);
  useLayoutEffect(() => { itemsRef.current = items; }, [items]);
  const id = useId();

  const apply = useCallback(() => updateCitationNode(editor, pos, { items: itemsRef.current, narrative: narrativeRef.current }), [editor, pos]);
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
  const narrativePossible = canBeNarrative({ items });
  const editAsText = () => {
    // The node's token becomes plain text (Backspace does the same from the keyboard).
    const current = editor.state.doc.nodeAt(pos);
    if (current?.type.name === CITATION_NODE_NAME) {
      editor.view.dispatch(editor.state.tr.replaceWith(pos, pos + current.nodeSize, editor.schema.text(String(current.attrs.raw ?? ""), current.marks)));
    }
    onClose();
    editor.commands.focus(undefined, { scrollIntoView: false });
  };
  const chooseStyle = (value: string) => {
    const style = value || null;
    // Keep this citation's edits; the style edit is separate (it changes the front matter).
    apply();
    setTiptapDocumentStyle(editor, style);
    setDocumentStyle(style);
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
      <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={narrativePossible ? undefined : "A narrative citation has one work, no prefix and no suppressed author."}>
          <input
            type="checkbox"
            data-field="narrative"
            checked={narrative && narrativePossible}
            disabled={!narrativePossible}
            onChange={(event) => setNarrative(event.target.checked)}
          />
          Narrative: in the text, Smith (2020)
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Document style
          <select
            aria-label="Document citation style"
            data-field="document-style"
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 py-1 text-xs text-foreground"
            value={documentStyle ?? ""}
            onChange={(event) => chooseStyle(event.target.value)}
          >
            <option value="">Notebook default</option>
            {BUNDLED_CSL_STYLES.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
            {documentStyle && !BUNDLED_CSL_STYLES.some((style) => style.id === documentStyle) ? <option value={documentStyle}>{documentStyle}</option> : null}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => search({ pos, mode: "add" })}>
          <Plus aria-hidden className="h-3.5 w-3.5" /> Add item
        </button>
        {node.attrs.narrative ? (
          <button type="button" data-field="edit-as-text" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted" onClick={editAsText}>
            Edit as text
          </button>
        ) : null}
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
  const documentCitations = useDocumentCitations(editor);
  const resolves = useMemo(() => referenceKeyResolver(render), [render]);
  const list = useMemo(() => resolvedList(documentCitations.list, resolves), [documentCitations.list, resolves]);
  const formatting = useFormattedCitations(render ? list.citations : null, documentCitations.style);
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
  const resolvesRef = useRef(resolves);
  useLayoutEffect(() => { resolvesRef.current = resolves; }, [resolves]);
  useLayoutEffect(() => citations.connect({
    keyDown: (event) => popupRef.current?.handleKey(event) ?? false,
    activate: (pos) => openPopover(pos),
    resolves: () => resolvesRef.current,
  }), [citations, openPopover]);

  const insert = useCallback((key: string, { locator, narrative }: { locator: boolean; narrative?: boolean }) => {
    const state = citations.getSuggestion();
    if (!state) return;
    const { trigger } = state;
    // Shift+Enter: the narrative form, `@key`, where it reads as one.
    const raw = citationRawForTrigger(trigger, key, { narrative });
    let at = trigger.range.from;
    // One undo step: the typed `@query` becomes the citation node.
    // No focus command: the editor has focus while typing, and a deferred focus would take it from the popover.
    editor.chain().command(({ tr, state: current }) => {
      closeHistory(tr);
      const marks = current.doc.resolve(trigger.range.from).marks().filter((mark) => !mark.type.spec.code);
      tr.replaceWith(trigger.range.from, trigger.range.to, current.schema.nodes[CITATION_NODE_NAME].create({ raw, narrative: raw.startsWith("@") }, null, marks));
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
            narrativeAllowed={!suggestion.trigger.insideCitation && narrativeMayFollow(suggestion.trigger.before)}
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
