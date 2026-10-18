import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, hoverTooltip, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Citation, CitationOccurrence } from "@/lib/references/types";
import { CITATION_SYNC_SCAN_LIMIT, liberaCitationAt, liberaCitations, liberaMathMarkers } from "./libera-syntax";

/* Citations in the CodeMirror Source editor (plan.md §4.2 "Source editors").
 *
 * Every `[@key …]` token found by the shared scanner (libera-syntax.ts →
 * citation-syntax.ts) is drawn as a subtle chip with its keys emphasized;
 * keys the notebook's library does not know are underlined red. The library
 * comes from the React component through `setCitationLibrary`. A narrative
 * citation (`@key` in prose) is drawn, hovered and clicked only when the
 * library knows its key: an unknown `@word` is plain text, never red. Hovering a
 * citation opens a tooltip whose content the component renders (the shared
 * citation card), and Ctrl/Cmd+click opens the cited attachment.
 *
 * The document is scanned once per version: scrolling, hovering and library
 * changes reuse the scan. A large document is rescanned after a pause in
 * typing, its chips mapped through the edits meanwhile. */

/** Keys (and aliases) in the notebook's library; null while there is no library. */
export type CitationLibraryKeys = { has(key: string): boolean } | null;

export const setCitationLibrary = StateEffect.define<CitationLibraryKeys>();

export const citationLibraryField = StateField.define<CitationLibraryKeys>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setCitationLibrary)) return effect.value;
    return value;
  },
});

export type CitationEditorHandlers = {
  /** Render the hover card for `citation` into `dom`; returns a cleanup run when the tooltip closes. */
  hover?: (dom: HTMLElement, citation: Citation) => (() => void) | void;
  /** Ctrl/Cmd+click: open the cited attachment. True when something was opened. */
  open?: (citation: Citation) => boolean;
};

export const citationEditorHandlers = Facet.define<CitationEditorHandlers, CitationEditorHandlers>({
  combine: (values) => values.at(-1) ?? {},
});

/** A rescan of a large document after typing paused. */
const rescanCitations = StateEffect.define<null>();
const RESCAN_DELAY_MS = 300;

/** UTF-16 ranges of each item's key (without `@`) inside a citation token. */
export function citationKeyRanges(occurrence: CitationOccurrence) {
  const ranges: Array<{ key: string; from: number; to: number }> = [];
  let cursor = 0;
  for (const item of occurrence.citation.items) {
    const at = occurrence.citation.raw.indexOf(`@${item.key}`, cursor);
    if (at < 0) continue;
    const from = occurrence.start + at + 1;
    ranges.push({ key: item.key, from, to: from + item.key.length });
    cursor = at + 1 + item.key.length;
  }
  return ranges;
}

const chip = Decoration.mark({ class: "cm-libera-citation" });
const unresolvedChip = Decoration.mark({ class: "cm-libera-citation cm-libera-citation-unresolved" });
const keyMark = Decoration.mark({ class: "cm-libera-citation-key" });
const unresolvedKeyMark = Decoration.mark({ class: "cm-libera-citation-key cm-libera-citation-key-unresolved", attributes: { title: "Not in this notebook's references" } });

/** Whether an occurrence is a citation given the library: narrative ones only when their key resolves. */
export function citationShown(occurrence: CitationOccurrence, library: CitationLibraryKeys) {
  return !occurrence.citation.narrative || Boolean(library && occurrence.citation.items.every((item) => library.has(item.key)));
}

/** Chip and key decorations for every citation in the document. */
export function buildCitationDecorations(state: EditorState, citations: readonly CitationOccurrence[]): DecorationSet {
  const library = state.field(citationLibraryField, false) ?? null;
  const ranges: Range<Decoration>[] = [];
  for (const occurrence of citations) {
    if (!citationShown(occurrence, library)) continue;
    const keys = citationKeyRanges(occurrence);
    const unresolved = library ? keys.filter((range) => !library.has(range.key)) : [];
    ranges.push((unresolved.length ? unresolvedChip : chip).range(occurrence.start, occurrence.end));
    for (const range of keys) ranges.push((unresolved.includes(range) ? unresolvedKeyMark : keyMark).range(range.from, range.to));
  }
  return Decoration.set(ranges, true);
}

class CitationDecorationPlugin {
  decorations: DecorationSet;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private view: EditorView) {
    this.decorations = this.build(view.state) ?? Decoration.none;
  }

  /** The current decorations, or null when a large document waits for its scan. */
  private build(state: EditorState, compute = state.doc.length <= CITATION_SYNC_SCAN_LIMIT) {
    const citations = liberaCitations(state, { compute });
    if (!citations) {
      this.schedule();
      return null;
    }
    return buildCitationDecorations(state, citations);
  }

  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      liberaCitations(this.view.state);
      this.view.dispatch({ effects: rescanCitations.of(null) });
    }, RESCAN_DELAY_MS);
  }

  update(update: ViewUpdate) {
    const libraryChanged = update.startState.field(citationLibraryField, false) !== update.state.field(citationLibraryField, false);
    const markersChanged = update.startState.facet(liberaMathMarkers) !== update.state.facet(liberaMathMarkers);
    const rescanned = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(rescanCitations)));
    if (!update.docChanged && !libraryChanged && !markersChanged && !rescanned) return;
    const next = this.build(update.state);
    this.decorations = next ?? this.decorations.map(update.changes);
  }

  destroy() {
    if (this.timer !== null) clearTimeout(this.timer);
  }
}

const citationDecorationPlugin = ViewPlugin.fromClass(CitationDecorationPlugin, {
  decorations: (plugin) => plugin.decorations,
});

/** The citation at a pointer position: `pos` is the nearest caret position, so the
 * character before it counts too (the pointer on a token's last character). */
function citationNear(state: EditorState, pos: number, side: number) {
  const library = state.field(citationLibraryField, false) ?? null;
  const at = (offset: number) => {
    const found = liberaCitationAt(state, offset);
    return found && citationShown(found, library) ? found : null;
  };
  return at(side < 0 && pos > 0 ? pos - 1 : pos) ?? (pos > 0 ? at(pos - 1) : null);
}

/** The hover tooltip for the citation at `pos`, or null (exported for tests). */
export function citationHoverSource(view: EditorView, pos: number, side: -1 | 1) {
  const handlers = view.state.facet(citationEditorHandlers);
  if (!handlers.hover) return null;
  const occurrence = citationNear(view.state, pos, side);
  if (!occurrence) return null;
  return {
    pos: occurrence.start,
    end: occurrence.end,
    above: false,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-libera-citation-card citation-hover-card";
      dom.setAttribute("role", "dialog");
      dom.setAttribute("aria-label", "Citation details");
      const cleanup = handlers.hover?.(dom, occurrence.citation);
      return { dom, destroy: () => cleanup?.() };
    },
  };
}

const citationHover = hoverTooltip(citationHoverSource, { hoverTime: 250 });

/** Ctrl/Cmd+click at `pos`: open the attachment of the citation there. True when something opened. */
export function openCitationAt(view: EditorView, pos: number) {
  const open = view.state.facet(citationEditorHandlers).open;
  const occurrence = open ? citationNear(view.state, pos, 1) : null;
  return Boolean(occurrence && open!(occurrence.citation));
}

const citationClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
    let pos: number | null = null;
    try {
      pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    } catch {
      pos = null;
    }
    if (pos === null || !openCitationAt(view, pos)) return false;
    event.preventDefault();
    return true;
  },
});

const citationTheme = EditorView.baseTheme({
  ".cm-libera-citation": {
    background: "color-mix(in srgb, var(--muted) 85%, transparent)",
    borderRadius: "3px",
    boxShadow: "0 0 0 1px color-mix(in srgb, var(--border) 70%, transparent)",
  },
  ".cm-libera-citation-key": { color: "var(--latex-command)", fontWeight: "600" },
  ".cm-libera-citation-key-unresolved": {
    color: "var(--destructive)",
    textDecoration: "underline wavy var(--destructive)",
    textUnderlineOffset: "3px",
  },
  // The shared card (.citation-hover-card) inside CodeMirror's tooltip box.
  ".cm-tooltip .cm-libera-citation-card": {
    position: "static",
    boxShadow: "none",
    border: "none",
    maxHeight: "min(24rem, 60vh)",
  },
  ".cm-tooltip:has(> .cm-libera-citation-card)": {
    borderRadius: "0.75rem",
    boxShadow: "0 12px 40px #0003",
    overflow: "hidden",
  },
});

/** Citation chips, hover tooltips and Ctrl/Cmd+click for the Markdown Source editor. */
export function citationDecorations(): Extension {
  return [citationLibraryField, citationDecorationPlugin, citationHover, citationClick, citationTheme];
}
