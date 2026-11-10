import { MapMode, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep } from "../../../collab/undo-boundary";
import { visualConfig } from "./model";
import { minimalChange } from "./title-edit";
import { floatPartPos, setFloatHooks } from "./widgets";

/* Editing a float's parts in place: a caption's LaTeX (a float's, a panel's or a sub-figure's), and a part the float
 * shows as source (an unknown command, a code listing). Clicking one opens its LaTeX in a field over it; Enter saves
 * the characters that changed as one undo step, Escape cancels. The rest of the float stays drawn. */

/** Whether the view may be edited through a float (a viewer, a read-only tab, or a closed view may not). */
function canEdit(view: EditorView) {
  return view.dom.isConnected && !view.state.readOnly && view.state.facet(visualConfig).editable();
}

/**
 * An open part editor. Its range is mapped through every change (a collaborator's too), so saving writes to the same
 * text, or knows it is gone.
 */
type PartSession = {
  view: EditorView; from: number | null; to: number | null; label: string;
  original: string; typed: boolean; area: HTMLTextAreaElement; abandon: () => void;
};
const sessions = new Set<PartSession>();

const sessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of sessions) {
    if (session.view !== update.view) continue;
    const map = (pos: number | null, assoc: -1 | 1) => (pos === null ? null : update.changes.mapPos(pos, assoc, MapMode.TrackDel));
    session.from = map(session.from, -1);
    session.to = map(session.to, 1);
  }
});

type Resume = { original: string; draft: string; typed: boolean };

function editPart(view: EditorView, target: HTMLElement, from: number, expected: string, label: string, resume?: Resume): boolean {
  if (!canEdit(view)) return false;
  if (target.querySelector(".cm-vis-float-editor")) return true;
  const to = from + expected.length;
  // The widget may be older than the text (a change not drawn yet): only the text it shows is edited.
  if (!resume && view.state.sliceDoc(from, to) !== expected) return false;
  // Another part open in this view is saved first.
  for (const other of [...sessions]) if (other.view === view && other.area.isConnected) other.area.blur();
  if (!target.isConnected) return true;

  const original = resume?.original ?? expected;
  const shown = [...target.childNodes];
  const area = document.createElement("textarea");
  area.className = "cm-vis-float-editor";
  area.spellcheck = false;
  area.rows = 1;
  area.value = resume?.draft ?? view.state.sliceDoc(from, to);
  area.setAttribute("aria-label", `${label} (LaTeX). Enter saves, Shift+Enter starts a new line, Escape cancels.`);
  target.classList.add("cm-vis-float-editing");
  target.replaceChildren(area);
  const fit = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; };
  fit();
  area.focus();
  if (resume) area.setSelectionRange(area.value.length, area.value.length);
  else area.select();

  let done = false;
  const session: PartSession = { view, from, to, label, original, typed: resume?.typed ?? false, area, abandon: () => undefined };
  sessions.add(session);
  const onInput = () => { session.typed = true; fit(); };
  const detach = () => {
    done = true;
    sessions.delete(session);
    area.removeEventListener("keydown", onKey);
    area.removeEventListener("blur", onBlur);
    area.removeEventListener("input", onInput);
    target.classList.remove("cm-vis-float-editing");
  };
  session.abandon = () => { if (!done) detach(); };

  const finish = (save: boolean) => {
    if (done) return;
    detach();
    const text = area.value;
    const now = session.from !== null && session.to !== null ? view.state.sliceDoc(session.from, session.to) : null;
    // Showing what it showed; a saved change redraws the float anyway.
    target.replaceChildren(...shown);
    // Opening and leaving a part without typing writes nothing.
    if (save && session.typed && text !== original) {
      if (now === null || session.from === null || !canEdit(view)) {
        window.alert(`The ${label.toLowerCase()} changed while you were editing it, so your text was not saved:\n\n${text}`);
      } else if (now === original || window.confirm(`A co-author changed this ${label.toLowerCase()} while you were editing it. Replace their version with yours?`)) {
        // Only the characters that changed are written, as one undo step.
        dispatchAsOneStep(view, { changes: minimalChange(session.from, now, text), userEvent: "input.visual.float" });
      }
    }
    if (view.dom.isConnected) view.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); finish(true); }
  };
  const onBlur = () => {
    // Removed from the page because the float was redrawn: the new one adopts the draft (adoptSessions).
    if (!area.isConnected) {
      requestAnimationFrame(() => {
        if (done || area.isConnected) return;
        session.abandon();
        if (session.typed && area.value !== original) window.alert(`The float changed while you were editing its ${label.toLowerCase()}, so your text was not saved:\n\n${area.value}`);
      });
      return;
    }
    finish(true);
  };
  area.addEventListener("keydown", onKey);
  area.addEventListener("blur", onBlur);
  area.addEventListener("input", onInput);
  return true;
}

/** A redrawn float: an editor open in the old one continues on the same part (found by where its text now is), with its draft. */
function adoptSessions(view: EditorView, dom: HTMLElement) {
  for (const session of [...sessions]) {
    if (session.view !== view || session.area.isConnected || session.from === null || session.to === null) continue;
    const target = [...dom.querySelectorAll<HTMLElement>("[data-float-offset]")].find((part) => floatPartPos(view, dom, part) === session.from);
    if (!target) continue;
    const { original, typed, label, from, to } = session;
    const draft = session.area.value;
    session.abandon();
    if (!editPart(view, target, from, view.state.sliceDoc(from, to), label, { original, draft, typed }) && typed && draft !== original) {
      window.alert(`The float changed while you were editing its ${label.toLowerCase()}, so your text was not saved:\n\n${draft}`);
    }
  }
}

/** Closes a view's float part editors without writing: the view is going away, or leaving the Visual mode. */
export function closeFloatSessions(view: EditorView) {
  for (const session of [...sessions]) if (session.view === view) session.abandon();
}

/** Installs the float part editor; the figure widget calls it through hooks. */
export function installFloatEditor(): Extension {
  setFloatHooks({ edit: (view, target, from, original, label) => editPart(view, target, from, original, label), adopt: adoptSessions });
  return [sessionTracker];
}
