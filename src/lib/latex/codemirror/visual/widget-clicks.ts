import { EditorView, ViewPlugin } from "@codemirror/view";
import { forceRevealEffect, structuralField } from "./structural";
import { widgetPos } from "./widgets";

/* Nothing drawn in the Visual mode is out of reach for editing. Most widgets open their source themselves on a click
 * (a formula, a citation, a table); the small ones that draw a hidden command (a heading's number, a footnote mark,
 * `\ldots`, `\\`, a proof's ∎, an item's bullet) did not, and CodeMirror ignores clicks on widgets by default, so
 * whether they could be edited was up to where the browser put the caret. A click on a widget that no handler of its
 * own took now shows the source of the construct it stands for, as Alt+Enter does. */

/** Controls inside a widget that keep their own click (an editor's field, a button, a link). */
const OWN_CLICK = "input, textarea, select, button, a[href], math-field, [contenteditable=true]";

/** The widget a click landed in: the outermost non-editable element of a line, or a block widget. */
function widgetRoot(content: HTMLElement, target: EventTarget | null) {
  let root: HTMLElement | null = null;
  for (let node = target instanceof Element ? (target as HTMLElement) : null; node && node !== content; node = node.parentElement) {
    if (node.classList.contains("cm-line")) break;
    if (node.contentEditable === "false") root = node;
  }
  return root;
}

type Range = { id: number; from: number; to: number };

/** The source range a widget starting at `pos` replaces (its point position for a widget that replaces nothing). */
function widgetRange(view: EditorView, pos: number) {
  let to = pos;
  view.state.field(structuralField, false)?.shown.between(pos, pos, (from, end, decoration) => {
    if (from === pos && decoration.spec.widget && end > to) to = end;
  });
  return { from: pos, to };
}

/**
 * The construct a widget over `from`–`to` stands for: the innermost one that runs over a part of it (a construct can start
 * inside the widget: an indented `\end{proof}`'s ∎ covers the indent too), else one that touches it (a point widget).
 */
function constructOver(view: EditorView, from: number, to: number) {
  const value = view.state.field(structuralField, false);
  if (!value) return null;
  let over: Range | null = null;
  let touching: Range | null = null;
  value.extents.between(from, to, (start, end, mark) => {
    const range = { id: mark.id, from: start, to: end };
    if (start < Math.max(to, from + 1) && end > from) { if (!over || end - start < over.to - over.from) over = range; }
    else if (!touching || end - start < touching.to - touching.from) touching = range;
  });
  return (over ?? touching) as Range | null;
}

/** Whether the construct's source shows now. */
function revealedOver(view: EditorView, construct: Range) {
  const revealed = view.state.field(structuralField, false)?.revealed;
  if (!revealed) return false;
  for (const range of revealed.values()) if (range.from <= construct.from && range.to >= construct.to) return true;
  return false;
}

export const widgetClickFallback = ViewPlugin.fromClass(class {
  constructor(readonly view: EditorView) {
    this.onMouseDown = this.onMouseDown.bind(this);
    // Bubbling to the content element: a widget's own handler has run first, and took the click if it prevented it.
    view.contentDOM.addEventListener("mousedown", this.onMouseDown);
  }

  onMouseDown(event: MouseEvent) {
    // A click it cannot take (not cancelable: a widget's own handler could not mark it taken either) is left alone.
    if (!event.cancelable || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
    const root = widgetRoot(this.view.contentDOM, event.target);
    if (!root) return;
    const own = (event.target as Element).closest(OWN_CLICK);
    if (own && root.contains(own)) return;
    const pos = widgetPos(this.view, root);
    if (pos === null) return;
    const { to } = widgetRange(this.view, pos);
    const construct = constructOver(this.view, pos, to);
    if (!construct) return;
    event.preventDefault();
    // As `revealSourceAt`: the cursor strictly inside, which shows the source of what it is in; a construct that does
    // not open for the cursor (shown as source only on request) is forced open, as Alt+Enter does.
    const anchor = Math.max(construct.from, Math.min(construct.to - 1, construct.from + 1));
    this.view.dispatch({ selection: { anchor }, scrollIntoView: true });
    if (!revealedOver(this.view, construct)) this.view.dispatch({ effects: forceRevealEffect.of(construct.id) });
    this.view.focus();
  }

  destroy() {
    this.view.contentDOM.removeEventListener("mousedown", this.onMouseDown);
  }
});
