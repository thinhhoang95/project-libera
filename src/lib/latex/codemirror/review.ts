import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { StateEffect, StateField, type ChangeDesc, type EditorState, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { diffTexts } from "../../text-hunks";

/* Cursor-style review of AI edits. The proposal is applied to the document
 * right away; each changed hunk remembers the text it replaced, so it can be
 * shown struck through and restored on Reject. Hunks follow later edits, and
 * undoing the AI edit removes its hunks (redo brings them back). */

export type AiChangeSource = "rewrite" | "write" | "format";
export type ReviewHunk = { id: string; from: number; to: number; original: string; source: AiChangeSource };
type PendingRequest = { id: string; from: number; to: number; kind: AiChangeSource };

function mapHunk(hunk: ReviewHunk, changes: ChangeDesc): ReviewHunk {
  const from = changes.mapPos(hunk.from, 1);
  const to = Math.max(from, changes.mapPos(hunk.to, -1));
  return from === hunk.from && to === hunk.to ? hunk : { ...hunk, from, to };
}

export const addReviewHunks = StateEffect.define<ReviewHunk[]>({ map: (hunks, changes) => hunks.map((hunk) => mapHunk(hunk, changes)) });
export const resolveReviewHunks = StateEffect.define<string[]>();
export const setPendingAiRequest = StateEffect.define<PendingRequest | null>({
  map: (request, changes) => request && { ...request, from: changes.mapPos(request.from, 1), to: Math.max(changes.mapPos(request.from, 1), changes.mapPos(request.to, -1)) },
});

export const reviewHunksField = StateField.define<ReviewHunk[]>({
  create: () => [],
  update(hunks, tr) {
    let next = tr.docChanged ? hunks.map((hunk) => mapHunk(hunk, tr.changes)) : hunks;
    for (const effect of tr.effects) {
      if (effect.is(addReviewHunks)) next = [...next.filter((hunk) => !effect.value.some((added) => added.id === hunk.id)), ...effect.value].sort((a, b) => a.from - b.from);
      if (effect.is(resolveReviewHunks)) next = next.filter((hunk) => !effect.value.includes(hunk.id));
    }
    // A hunk whose text is back to the original has nothing left to review.
    if (tr.docChanged && next.length) next = next.filter((hunk) => !(hunk.from === hunk.to && !hunk.original) && tr.newDoc.sliceString(hunk.from, hunk.to) !== hunk.original);
    return next.length === hunks.length && next.every((hunk, index) => hunk === hunks[index]) ? hunks : next;
  },
});

export const pendingAiField = StateField.define<PendingRequest | null>({
  create: () => null,
  update(request, tr) {
    let next = request && tr.docChanged
      ? { ...request, from: tr.changes.mapPos(request.from, 1), to: Math.max(tr.changes.mapPos(request.from, 1), tr.changes.mapPos(request.to, -1)) }
      : request;
    for (const effect of tr.effects) if (effect.is(setPendingAiRequest)) next = effect.value;
    return next;
  },
});

class DeletedTextWidget extends WidgetType {
  constructor(readonly text: string, readonly block: boolean) { super(); }
  eq(other: DeletedTextWidget) { return other.text === this.text && other.block === this.block; }
  toDOM() {
    const element = document.createElement(this.block ? "div" : "span");
    element.className = this.block ? "cm-ai-deleted cm-ai-deleted-block" : "cm-ai-deleted";
    element.textContent = this.block ? this.text.replace(/\n$/, "") : this.text;
    element.setAttribute("aria-label", `Removed: ${this.text}`);
    return element;
  }
  ignoreEvent() { return false; }
}

class HunkActionsWidget extends WidgetType {
  constructor(readonly id: string) { super(); }
  eq(other: HunkActionsWidget) { return other.id === this.id; }
  toDOM(view: EditorView) {
    const wrapper = document.createElement("span");
    wrapper.className = "libera-change-actions cm-ai-actions";
    wrapper.setAttribute("contenteditable", "false");
    const button = (label: string, title: string, className: string, decide: "accept" | "reject") => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.title = title;
      element.className = className;
      element.dataset.decision = decide;
      element.addEventListener("mousedown", (event) => event.preventDefault());
      element.addEventListener("click", (event) => {
        event.preventDefault();
        decideReviewHunks(view, [this.id], decide);
        view.focus();
      });
      return element;
    };
    wrapper.append(button("Reject", "Reject this change", "cm-ai-reject", "reject"), button("Accept", "Accept this change", "cm-ai-accept", "accept"));
    return wrapper;
  }
  ignoreEvent() { return true; }
}

/** Whether a hunk replaces whole lines, so it can be shown as removed lines
 * above added lines instead of inline. */
function coversWholeLines(doc: Text, hunk: ReviewHunk) {
  if (doc.lineAt(hunk.from).from !== hunk.from) return false;
  if (hunk.to === hunk.from) return hunk.original.endsWith("\n");
  return doc.sliceString(hunk.to - 1, hunk.to) === "\n" || hunk.to === doc.lineAt(hunk.to).to;
}

function buildDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const doc = state.doc;
  for (const hunk of state.field(reviewHunksField)) {
    const block = coversWholeLines(doc, hunk);
    if (hunk.original) decorations.push(Decoration.widget({ widget: new DeletedTextWidget(hunk.original, block), side: -1, block }).range(hunk.from));
    if (hunk.to > hunk.from) {
      if (block) {
        for (let pos = hunk.from; pos < hunk.to;) {
          const line = doc.lineAt(pos);
          decorations.push(Decoration.line({ class: "cm-ai-inserted-line" }).range(line.from));
          pos = line.to + 1;
        }
      } else {
        decorations.push(Decoration.mark({ class: "cm-ai-inserted" }).range(hunk.from, hunk.to));
      }
    }
    const actionsAt = hunk.to > hunk.from && block && doc.sliceString(hunk.to - 1, hunk.to) === "\n" ? hunk.to - 1 : hunk.to;
    decorations.push(Decoration.widget({ widget: new HunkActionsWidget(hunk.id), side: 1 }).range(actionsAt));
  }
  const pending = state.field(pendingAiField);
  if (pending) {
    if (pending.to > pending.from) decorations.push(Decoration.mark({ class: "cm-ai-pending" }).range(pending.from, pending.to));
    else decorations.push(Decoration.widget({ widget: new PendingWidget(pending.kind), side: 1 }).range(pending.from));
  }
  return Decoration.set(decorations, true);
}

class PendingWidget extends WidgetType {
  constructor(readonly kind: AiChangeSource) { super(); }
  eq(other: PendingWidget) { return other.kind === this.kind; }
  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-ai-pending-caret";
    element.textContent = this.kind === "write" ? " Writing…" : " Working…";
    return element;
  }
}

const reviewDecorations = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(value, tr) {
    const changed = tr.startState.field(reviewHunksField) !== tr.state.field(reviewHunksField) || tr.startState.field(pendingAiField) !== tr.state.field(pendingAiField);
    return changed ? buildDecorations(tr.state) : tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Undoing an AI edit also drops its hunks; redoing it restores them. */
const reviewHistory = invertedEffects.of((tr) => {
  const effects: StateEffect<unknown>[] = [];
  for (const effect of tr.effects) {
    if (effect.is(addReviewHunks)) effects.push(resolveReviewHunks.of(effect.value.map((hunk) => hunk.id)));
    if (effect.is(resolveReviewHunks)) {
      const removed = tr.startState.field(reviewHunksField).filter((hunk) => effect.value.includes(hunk.id));
      // Only rejections and undos change the text; accepting is not an undo step.
      // The inverse transaction ends on this transaction's start document, so
      // the hunks keep their current positions.
      if (removed.length && tr.docChanged) effects.push(addReviewHunks.of(removed));
    }
  }
  return effects;
});

export function decideReviewHunks(view: EditorView, ids: string[] | "all", decision: "accept" | "reject") {
  const hunks = view.state.field(reviewHunksField).filter((hunk) => ids === "all" || ids.includes(hunk.id));
  if (!hunks.length) return false;
  const resolved = resolveReviewHunks.of(hunks.map((hunk) => hunk.id));
  if (decision === "accept") {
    view.dispatch({ effects: resolved });
    return true;
  }
  view.dispatch({
    changes: hunks.map((hunk) => ({ from: hunk.from, to: hunk.to, insert: hunk.original })),
    effects: resolved,
    userEvent: "input.ai.reject",
  });
  return true;
}

/* ---- Diffing a proposal into hunks ------------------------------------------ */

// diffTexts lives in text-hunks.ts so code without CodeMirror (the collab
// host, the suggestion model) can use it without bundling the editor.
export { diffTexts };

let hunkCounter = 0;

/** Replace `from`–`to` with `text`, showing the difference for review. */
export function applyAiProposal(view: EditorView, from: number, to: number, text: string, source: AiChangeSource) {
  const original = view.state.sliceDoc(from, to);
  const hunks = diffTexts(original, text).map((hunk): ReviewHunk => ({
    id: `ai-${Date.now().toString(36)}-${hunkCounter++}`,
    from: from + hunk.fromB,
    to: from + hunk.toB,
    original: original.slice(hunk.fromA, hunk.toA),
    source,
  }));
  view.dispatch({
    changes: { from, to, insert: text },
    // Center the proposal so the review bar at the bottom never covers it.
    effects: [setPendingAiRequest.of(null), ...(hunks.length ? [addReviewHunks.of(hunks)] : []), EditorView.scrollIntoView(hunks[0]?.from ?? from, { y: "center" })],
    selection: { anchor: hunks[0]?.from ?? from },
    userEvent: `input.ai.${source}`,
    annotations: isolateHistory.of("full"),
  });
  return hunks.length;
}

export function latexReviewExtension(): Extension {
  return [reviewHunksField, pendingAiField, reviewDecorations, reviewHistory];
}
