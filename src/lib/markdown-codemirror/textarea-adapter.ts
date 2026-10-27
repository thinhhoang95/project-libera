import type { EditorView } from "@codemirror/view";

/* The workspace drives the Markdown Source editor through a textarea ref:
 * toolbar insertions, the outline, slides, snipping, Global Search reveals,
 * scroll sync with the preview and view-state capture all read `value`,
 * `selectionStart`, `scrollTop` … and call `replaceTextareaSelectionWithUndo`
 * or the `textarea-position` helpers. This adapter implements that same
 * surface on a CodeMirror view, so every one of those callers works with either
 * editor without knowing which one is mounted.
 *
 * The module imports CodeMirror types only. `textarea-editing.ts` and
 * `textarea-position.ts` (both in the main bundle) consult it, and the editor
 * itself is loaded on demand.
 *
 * The adapter exists before the view does: the editor chunk loads after the
 * workspace has already copied the pane's ref, and the workspace restores
 * selection and scroll in an animation frame that can run before the view is
 * created. Until a view attaches, the adapter reports the initial text and
 * keeps the requested selection, scroll and listeners, then applies them. */

export type TextareaLikeEdit = {
  nextSelectionEnd: number;
  nextSelectionStart: number;
  replacement: string;
  scrollLeft?: number;
  scrollTop?: number;
  selectionEnd: number;
  selectionStart: number;
};

export type SourceOffsetRange = { start: number; end: number };
export type SourceScrollBlock = "center" | "start";

/** What the adapter needs from the editor module that it cannot do with view
 * instance methods alone (these use CodeMirror's runtime exports). */
export type CodeMirrorAdapterDriver = {
  /** Applies a toolbar-style edit as one undo step. */
  applyEdit: (edit: TextareaLikeEdit) => void;
  /** Applies a whole-text value as a minimal change. */
  applyValue: (value: string) => void;
  /** Scrolls a position into view, `margin` pixels below the top for "start". */
  scrollIntoView: (pos: number, block: SourceScrollBlock, margin?: number) => void;
};

type ListenerEntry = {
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
  type: string;
};

const adapters = new WeakSet<object>();

/** The CodeMirror adapter behind a textarea ref, or null for a real textarea. */
export function getCodeMirrorTextareaAdapter(target: unknown): CodeMirrorTextareaAdapter | null {
  return typeof target === "object" && target !== null && adapters.has(target)
    ? (target as CodeMirrorTextareaAdapter)
    : null;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function normalizeSourceLineEndings(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

export class CodeMirrorTextareaAdapter {
  private view: EditorView | null = null;
  private driver: CodeMirrorAdapterDriver | null = null;
  private fallbackValue: string;
  private pendingSelection: SourceOffsetRange | null = null;
  private pendingScroll: { left?: number; top?: number } = {};
  private listeners: ListenerEntry[] = [];
  private valueCache: { doc: unknown; text: string } | null = null;
  /** Lets `instanceof`-free callers and debuggers tell the adapter apart. */
  readonly tagName = "LIBERA-CODEMIRROR-SOURCE";

  constructor(initialValue: string) {
    this.fallbackValue = normalizeSourceLineEndings(initialValue);
    adapters.add(this);
  }

  /** The adapter typed as the ref the workspace expects. */
  asTextarea() {
    return this as unknown as HTMLTextAreaElement;
  }

  get editorView() {
    return this.view;
  }

  attach(view: EditorView, driver: CodeMirrorAdapterDriver) {
    this.detach();
    this.view = view;
    this.driver = driver;
    for (const entry of this.listeners) this.targetFor(entry.type)?.addEventListener(entry.type, entry.listener, entry.options);
    const selection = this.pendingSelection;
    this.pendingSelection = null;
    if (selection) this.setSelectionRange(selection.start, selection.end);
    const scroll = this.pendingScroll;
    this.pendingScroll = {};
    if (scroll.top !== undefined) view.scrollDOM.scrollTop = scroll.top;
    if (scroll.left !== undefined) view.scrollDOM.scrollLeft = scroll.left;
  }

  /** Keeps the last text and selection readable after the view is destroyed,
   * as a detached textarea keeps its value. */
  detach() {
    const view = this.view;
    if (!view) return;
    this.fallbackValue = this.value;
    const { from, to } = view.state.selection.main;
    this.pendingSelection = { start: from, end: to };
    this.pendingScroll = { left: view.scrollDOM.scrollLeft, top: view.scrollDOM.scrollTop };
    for (const entry of this.listeners) this.targetFor(entry.type)?.removeEventListener(entry.type, entry.listener, entry.options);
    this.view = null;
    this.driver = null;
  }

  private targetFor(type: string): EventTarget | null {
    if (!this.view) return null;
    return type === "scroll" ? this.view.scrollDOM : this.view.contentDOM;
  }

  // Text and selection -------------------------------------------------------

  get value() {
    const view = this.view;
    if (!view) return this.fallbackValue;
    // Text is immutable, so one string per document version is enough even
    // when a caller reads `value` several times in a row.
    const doc = view.state.doc;
    if (this.valueCache?.doc !== doc) this.valueCache = { doc, text: doc.toString() };
    return this.valueCache.text;
  }

  /** The text reported while no view is attached (before load, after unmount). */
  setDetachedValue(next: string) {
    if (!this.view) this.fallbackValue = normalizeSourceLineEndings(next);
  }

  set value(next: string) {
    if (this.driver) this.driver.applyValue(next);
    else this.fallbackValue = normalizeSourceLineEndings(next);
  }

  get selectionStart() {
    if (this.view) return this.view.state.selection.main.from;
    return clamp(this.pendingSelection?.start ?? 0, 0, this.fallbackValue.length);
  }

  set selectionStart(start: number) {
    this.setSelectionRange(start, Math.max(start, this.selectionEnd));
  }

  get selectionEnd() {
    if (this.view) return this.view.state.selection.main.to;
    return clamp(this.pendingSelection?.end ?? 0, 0, this.fallbackValue.length);
  }

  set selectionEnd(end: number) {
    this.setSelectionRange(Math.min(this.selectionStart, end), end);
  }

  setSelectionRange(start: number, end: number) {
    const view = this.view;
    const length = view?.state.doc.length ?? this.fallbackValue.length;
    const head = clamp(end, 0, length);
    const anchor = clamp(start, 0, head);
    if (!view) {
      this.pendingSelection = { start: anchor, end: head };
      return;
    }
    // A textarea never scrolls on setSelectionRange; callers scroll explicitly.
    view.dispatch({ selection: { anchor, head } });
  }

  /** Accepts (and ignores) textarea focus options: CodeMirror focuses its
   * content without scrolling to the caret, matching `preventScroll` callers;
   * the others scroll explicitly afterwards. */
  focus() {
    this.view?.focus();
  }

  blur() {
    this.view?.contentDOM.blur();
  }

  get isConnected() {
    return this.view?.dom.isConnected ?? false;
  }

  get readOnly() {
    return this.view?.state.readOnly ?? false;
  }

  /** `replaceTextareaSelectionWithUndo` for CodeMirror: one undoable change
   * with the requested selection and scroll, announced by an input event just
   * like a native textarea edit. */
  replaceSelectionWithUndo(edit: TextareaLikeEdit) {
    const view = this.view;
    const driver = this.driver;
    if (!view || !driver) return false;
    driver.applyEdit(edit);
    if (typeof edit.scrollTop === "number") view.scrollDOM.scrollTop = edit.scrollTop;
    if (typeof edit.scrollLeft === "number") view.scrollDOM.scrollLeft = edit.scrollLeft;
    view.focus();
    // The event class must come from the editor's own window (jsdom in tests).
    const EventClass = view.contentDOM.ownerDocument.defaultView?.Event ?? Event;
    view.contentDOM.dispatchEvent(new EventClass("input", { bubbles: true }));
    return true;
  }

  // Events --------------------------------------------------------------------

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (!listener) return;
    this.listeners.push({ type, listener, options });
    this.targetFor(type)?.addEventListener(type, listener, options);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (!listener) return;
    const capture = (value?: boolean | EventListenerOptions) => typeof value === "boolean" ? value : !!value?.capture;
    this.listeners = this.listeners.filter((entry) => !(entry.type === type && entry.listener === listener && capture(entry.options) === capture(options)));
    this.targetFor(type)?.removeEventListener(type, listener, options);
  }

  dispatchEvent(event: Event) {
    return this.targetFor(event.type)?.dispatchEvent(event) ?? true;
  }

  // Scrolling and geometry ----------------------------------------------------

  get scrollTop() {
    return this.view?.scrollDOM.scrollTop ?? this.pendingScroll.top ?? 0;
  }

  set scrollTop(value: number) {
    if (this.view) this.view.scrollDOM.scrollTop = value;
    else this.pendingScroll.top = value;
  }

  get scrollLeft() {
    return this.view?.scrollDOM.scrollLeft ?? this.pendingScroll.left ?? 0;
  }

  set scrollLeft(value: number) {
    if (this.view) this.view.scrollDOM.scrollLeft = value;
    else this.pendingScroll.left = value;
  }

  get scrollHeight() {
    return this.view?.scrollDOM.scrollHeight ?? 0;
  }

  get scrollWidth() {
    return this.view?.scrollDOM.scrollWidth ?? 0;
  }

  get clientHeight() {
    return this.view?.scrollDOM.clientHeight ?? 0;
  }

  get clientWidth() {
    return this.view?.scrollDOM.clientWidth ?? 0;
  }

  getBoundingClientRect(): DOMRect {
    if (this.view) return this.view.scrollDOM.getBoundingClientRect();
    return { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  }

  /** The vertical position of `pos` in document coordinates. Lines outside the
   * rendered viewport use CodeMirror's height map, interpolated through a
   * wrapped line, so preview sync also works for off-screen text. */
  private documentY(pos: number) {
    const view = this.view!;
    const block = view.lineBlockAt(pos);
    try {
      if (pos >= view.viewport.from && pos <= view.viewport.to) {
        const coords = view.coordsAtPos(pos, 1);
        if (coords && (coords.top !== 0 || coords.bottom !== 0)) return coords.top - view.documentTop;
      }
    } catch {
      // Layout is unavailable (hidden pane or no DOM measurement): interpolate.
    }
    const span = Math.max(1, block.to - block.from);
    return block.top + block.height * clamp((pos - block.from) / span, 0, 1);
  }

  /** The document offset at a vertical position given in document coordinates. */
  private offsetAtDocumentY(y: number) {
    const view = this.view!;
    const block = view.lineBlockAtHeight(y);
    const progress = block.height > 0 ? clamp((y - block.top) / block.height, 0, 1) : 0;
    return clamp(Math.round(block.from + (block.to - block.from) * progress), 0, view.state.doc.length);
  }

  /** The document coordinate of the scroller's top edge plus `fraction` of its height. */
  private viewportDocumentY(fraction: number) {
    const view = this.view!;
    const rect = view.scrollDOM.getBoundingClientRect();
    return rect.top + view.scrollDOM.clientHeight * clamp(fraction, 0, 1) - view.documentTop;
  }

  offsetAtPoint(clientX: number, clientY: number) {
    const view = this.view;
    if (!view) return 0;
    try {
      return view.posAtCoords({ x: clientX, y: clientY }, false);
    } catch {
      return this.offsetAtDocumentY(clientY - view.documentTop);
    }
  }

  visibleStartOffset() {
    return this.view ? this.offsetAtDocumentY(this.viewportDocumentY(0) + 1) : 0;
  }

  viewportAnchorOffset(viewportProgress: number) {
    return this.view ? this.offsetAtDocumentY(this.viewportDocumentY(viewportProgress)) : 0;
  }

  visualProgressForRange(offset: number, range: SourceOffsetRange) {
    const view = this.view;
    if (!view) return 0;
    const length = view.state.doc.length;
    const start = clamp(range.start, 0, length);
    const end = clamp(range.end, start, length);
    const startY = this.documentY(start);
    const span = Math.max(0.0001, this.documentY(end) - startY);
    return clamp((this.documentY(clamp(offset, start, end)) - startY) / span, 0, 1);
  }

  offsetAtVisualProgress(range: SourceOffsetRange, progress: number) {
    const view = this.view;
    if (!view) return clamp(range.start, 0, this.fallbackValue.length);
    const length = view.state.doc.length;
    const start = clamp(range.start, 0, length);
    const end = clamp(range.end, start, length);
    if (end <= start) return start;
    const startY = this.documentY(start);
    const target = startY + clamp(progress, 0, 1) * Math.max(0.0001, this.documentY(end) - startY);
    let low = start;
    let high = end;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.documentY(middle) < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  clientPointForOffset(offset: number) {
    const view = this.view;
    const rect = this.getBoundingClientRect();
    let coords: { left: number; bottom: number } | null = null;
    try {
      coords = view ? view.coordsAtPos(clamp(offset, 0, view.state.doc.length)) : null;
    } catch {
      coords = null;
    }
    if (!coords) return { x: rect.left + 8, y: rect.top + 8 };
    return {
      x: Math.min(rect.right - 8, Math.max(rect.left + 8, coords.left)),
      y: Math.min(rect.bottom - 8, Math.max(rect.top + 8, coords.bottom)),
    };
  }

  scrollToOffset(offset: number, options: { block?: SourceScrollBlock; viewportProgress?: number } = {}) {
    const view = this.view;
    const driver = this.driver;
    if (!view || !driver) return;
    const pos = clamp(offset, 0, view.state.doc.length);
    if (typeof options.viewportProgress === "number") {
      driver.scrollIntoView(pos, "start", view.scrollDOM.clientHeight * clamp(options.viewportProgress, 0, 1));
      return;
    }
    driver.scrollIntoView(pos, options.block ?? "center");
  }
}
