import { getCodeMirrorTextareaAdapter } from "@/lib/markdown-codemirror/textarea-adapter";
import {
  applyTextareaScrollAnchor, readTextareaScrollAnchor, type EditorScrollState, type ReflowScrollAnchor,
} from "@/lib/reflow-scroll-anchor";

const highlightLayers = new WeakMap<HTMLTextAreaElement, () => HTMLElement | null>();

/** The classic editor's line layer, which is what its text can be measured through. */
export function registerTextareaHighlightLayer(textarea: HTMLTextAreaElement, layer: () => HTMLElement | null) {
  highlightLayers.set(textarea, layer);
  return () => { highlightLayers.delete(textarea); };
}

/** The text at the top of whichever source editor is behind the textarea ref. */
export function readSourceScrollAnchor(textarea: HTMLTextAreaElement): ReflowScrollAnchor | null {
  const adapter = getCodeMirrorTextareaAdapter(textarea);
  if (adapter) return adapter.readScrollAnchor();
  const layer = highlightLayers.get(textarea);
  return layer ? readTextareaScrollAnchor(textarea, layer) : null;
}

/** False when the editor cannot place the text yet; the caller falls back to pixels. */
export function restoreSourceScrollAnchor(textarea: HTMLTextAreaElement, anchor: ReflowScrollAnchor) {
  const adapter = getCodeMirrorTextareaAdapter(textarea);
  if (adapter) {
    adapter.restoreScrollAnchor(anchor);
    return true;
  }
  const layer = highlightLayers.get(textarea);
  return layer ? applyTextareaScrollAnchor(textarea, layer, anchor) : false;
}

/** A pixel position from outside the editor (a followed link) replaces the text
 * position saved for the tab, which would otherwise win on restore. */
export function mergeSourceScrollState<State extends EditorScrollState>(current: State | undefined, patch: State): State {
  const merged = { ...current, ...patch };
  if (patch.editorScrollTop === undefined || patch.editorScrollPos !== undefined) return merged;
  return { ...merged, editorScrollOffset: undefined, editorScrollPos: undefined };
}
