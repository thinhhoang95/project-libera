// Remote carets and selections in the Visual editor.
//
// Presence uses the same awareness fields as y-codemirror.next
// (node_modules/y-codemirror.next/src/y-remote-selections.js), so Visual and
// CodeMirror users on the same Y.Text see each other:
//   cursor: { anchor, head }   Y.RelativePosition (JSON on the wire) in Y.Text
//   user:   { name, color, colorLight? }
// y-codemirror.next sets `cursor` to Y.RelativePosition objects created with
// `Y.createRelativePositionFromTypeIndex(ytext, index)` (assoc 0); awareness
// encodes them with JSON.stringify, so peers receive RelativePosition JSON.

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { RelativePositionJSON } from "../protocol/schema";

export interface AwarenessCursor {
  anchor: Y.RelativePosition | RelativePositionJSON;
  head: Y.RelativePosition | RelativePositionJSON;
}

export interface AwarenessUser {
  name?: string;
  color?: string;
  colorLight?: string;
}

/** What the cursor plugin needs from the bridge. */
export interface RemoteCursorSource {
  readonly ytext: Y.Text;
  readonly awareness: Awareness;
  /** Position in the editor's current document for a Y.Text offset, or null while unsynced. */
  sourceOffsetToPos(offset: number): number | null;
  /** True when positions can be resolved against the current document. */
  isSynced(): boolean;
  /** Fires after the bridge brought the document in step; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export const remoteCursorsKey = new PluginKey<DecorationSet>("liberaRemoteCursors");

/** Y.Text offset for a relative position (object or JSON), or null if it is not in `ytext`. */
export function relativePositionToSourceOffset(ytext: Y.Text, position: Y.RelativePosition | RelativePositionJSON | null | undefined): number | null {
  if (!position || !ytext.doc) return null;
  const relative = position instanceof Y.RelativePosition ? position : Y.createRelativePositionFromJSON(position);
  const absolute = Y.createAbsolutePositionFromRelativePosition(relative, ytext.doc);
  return absolute && absolute.type === ytext ? absolute.index : null;
}

/** The relative position y-codemirror.next would publish for a Y.Text offset. */
export function sourceOffsetToRelativePosition(ytext: Y.Text, offset: number, assoc = 0): Y.RelativePosition {
  return Y.createRelativePositionFromTypeIndex(ytext, offset, assoc);
}

/** Awareness `cursor` value in y-codemirror.next's format. */
export function awarenessCursor(ytext: Y.Text, anchor: number, head: number): AwarenessCursor {
  return { anchor: sourceOffsetToRelativePosition(ytext, anchor), head: sourceOffsetToRelativePosition(ytext, head) };
}

function sameCursor(a: AwarenessCursor | null | undefined, b: AwarenessCursor) {
  if (!a) return false;
  const toRelative = (value: AwarenessCursor["anchor"]) => value instanceof Y.RelativePosition ? value : Y.createRelativePositionFromJSON(value);
  return Y.compareRelativePositions(toRelative(a.anchor), toRelative(b.anchor)) && Y.compareRelativePositions(toRelative(a.head), toRelative(b.head));
}

/** Publishes a local selection (Y.Text offsets) unless awareness already has it. */
export function publishAwarenessCursor(awareness: Awareness, ytext: Y.Text, anchor: number, head: number) {
  const local = awareness.getLocalState();
  if (local == null) return;
  const cursor = awarenessCursor(ytext, anchor, head);
  if (!sameCursor(local.cursor as AwarenessCursor | null | undefined, cursor)) awareness.setLocalStateField("cursor", cursor);
}

// The caret widget must contain no text nodes: ProseMirror makes widgets
// non-editable, and a text node inside one (an earlier version held word
// joiners and the name label) is somewhere the browser can put the caret, for
// example on Ctrl+End when a collaborator's caret sits at the end of the
// document. Typing and arrow keys then went nowhere. The label is drawn by a
// pseudo-element from data-name instead.
const CARET_STYLE_ID = "libera-collab-caret-style";
const CARET_CSS = `
.libera-collab-caret{position:relative;display:inline-block;width:0;height:1.2em;vertical-align:text-bottom;margin:0 -1px;border-left:2px solid var(--libera-caret-color,#30bced);pointer-events:none;user-select:none}
.libera-collab-caret::after{content:attr(data-name);position:absolute;top:-1.4em;left:-2px;font-size:0.75em;line-height:1.2;padding:0 3px;border-radius:3px;white-space:nowrap;color:#fff;background-color:var(--libera-caret-color,#30bced)}
`;

function ensureCaretStyle(doc: Document) {
  if (doc.getElementById(CARET_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = CARET_STYLE_ID;
  style.textContent = CARET_CSS;
  doc.head.append(style);
}

function caretWidget(color: string, name: string) {
  return (view: { dom: HTMLElement }) => {
    const doc = view.dom.ownerDocument ?? document;
    ensureCaretStyle(doc);
    const caret = doc.createElement("span");
    caret.className = "libera-collab-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.setAttribute("contenteditable", "false");
    caret.dataset.name = name;
    caret.style.setProperty("--libera-caret-color", color);
    return caret;
  };
}

/** Decorations for every other client's caret and selection. */
export function remoteCursorDecorations(source: RemoteCursorSource, doc: ProseMirrorNode): DecorationSet {
  const { awareness, ytext } = source;
  const own = awareness.clientID;
  const size = doc.content.size;
  const clamp = (pos: number) => Math.max(0, Math.min(size, pos));
  const decorations: Decoration[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === own) return;
    const cursor = state.cursor as AwarenessCursor | null | undefined;
    if (!cursor?.anchor || !cursor.head) return;
    const anchorOffset = relativePositionToSourceOffset(ytext, cursor.anchor);
    const headOffset = relativePositionToSourceOffset(ytext, cursor.head);
    if (anchorOffset === null || headOffset === null) return;
    const anchor = source.sourceOffsetToPos(anchorOffset), head = source.sourceOffsetToPos(headOffset);
    if (anchor === null || head === null) return;
    const user = (state.user ?? {}) as AwarenessUser;
    const color = user.color ?? "#30bced";
    const name = user.name ?? "Anonymous";
    const colorLight = user.colorLight ?? `${color}33`;
    const from = clamp(Math.min(anchor, head)), to = clamp(Math.max(anchor, head));
    if (from < to) decorations.push(Decoration.inline(from, to, { class: "libera-collab-selection", style: `background-color: ${colorLight}` }, { clientId }));
    decorations.push(Decoration.widget(clamp(head), caretWidget(color, name), {
      key: `libera-collab-caret:${clientId}:${color}:${name}`,
      // Like y-codemirror.next, keep the caret outside the selection it ends.
      side: head - anchor > 0 ? -1 : 1,
      ignoreSelection: true,
    }));
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Renders remote carets and selections. Decorations are rebuilt when another
 * client's awareness changes or the bridge syncs, and mapped through local
 * transactions in between.
 */
export function createRemoteCursorPlugin(source: RemoteCursorSource): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: remoteCursorsKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const next = tr.getMeta(remoteCursorsKey);
        if (next instanceof DecorationSet) return next;
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: { decorations: (state) => remoteCursorsKey.getState(state) },
    view(view) {
      let scheduled = false;
      const refresh = () => {
        scheduled = false;
        if (view.isDestroyed || !source.isSynced()) return;
        const set = remoteCursorDecorations(source, view.state.doc);
        view.dispatch(view.state.tr.setMeta(remoteCursorsKey, set).setMeta("addToHistory", false));
      };
      const onAwareness = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        if ([...added, ...updated, ...removed].some((id) => id !== source.awareness.clientID)) refresh();
      };
      source.awareness.on("change", onAwareness);
      const unsubscribe = source.subscribe(refresh);
      // Not during plugin construction: the view is still being reconfigured.
      if (!scheduled) { scheduled = true; queueMicrotask(refresh); }
      return {
        destroy() {
          source.awareness.off("change", onAwareness);
          unsubscribe();
        },
      };
    },
  });
}
