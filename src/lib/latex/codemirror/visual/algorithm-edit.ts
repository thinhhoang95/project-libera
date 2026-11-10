import { MapMode, type ChangeSpec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep } from "../../../collab/undo-boundary";
import { readGroup } from "../../../macros/core";
import { isAlgorithmicStatement, type AlgorithmLine } from "./algorithm";
import { visualConfig } from "./model";
import { minimalChange } from "./title-edit";
import { revealSourceAt, setAlgorithmHooks, type AlgorithmElement } from "./widgets";

/* Editing an algorithm by its parts. Clicking a statement opens that
 * statement's LaTeX in a field over it (a block's first line without the
 * lines inside it); clicking the caption opens the caption's. Saving writes
 * only the characters that changed, as one undo step. A line's menu inserts a
 * statement above or below it (written with the package's keyword, a block
 * with its last line so blocks stay balanced) and deletes a statement, or a
 * block whole. */

/** Whether the view may be edited through the algorithm (a viewer, a read-only tab, or a closed view may not). */
function canEdit(view: EditorView) {
  return view.dom.isConnected && !view.state.readOnly && view.state.facet(visualConfig).editable();
}

/**
 * An open editor, or an open menu. Its positions are mapped through every change (a collaborator's too), so saving
 * writes to the same text, or knows it is gone.
 */
type Session = {
  view: EditorView; base: number | null; from: number | null; to: number | null;
  index: number; original: string; typed: boolean; area: HTMLTextAreaElement | null; abandon: () => void;
};
const sessions = new Set<Session>();

const sessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of sessions) {
    if (session.view !== update.view) continue;
    const map = (pos: number | null, assoc: -1 | 1) => (pos === null ? null : update.changes.mapPos(pos, assoc, MapMode.TrackDel));
    session.base = map(session.base, -1);
    session.from = map(session.from, -1);
    session.to = map(session.to, 1);
  }
});

function findList(view: EditorView, base: number) {
  for (const list of view.contentDOM.querySelectorAll<AlgorithmElement>(".cm-vis-algorithm")) if (list.liberaAlgorithm?.base() === base) return list;
  return null;
}

/** The field over a line or caption: Enter saves, Shift+Enter starts a new line, Escape cancels. */
function field(value: string, label: string) {
  const area = document.createElement("textarea");
  area.className = "cm-vis-title-editor cm-vis-algorithm-editor";
  area.spellcheck = false;
  area.rows = 1;
  area.value = value;
  area.setAttribute("aria-label", `${label} (LaTeX). Enter saves, Shift+Enter starts a new line, Escape cancels, Tab goes to the next statement, Ctrl+Enter adds a statement below.`);
  return area;
}

const fit = (area: HTMLTextAreaElement) => { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; };

/** The lines that can be edited, from `index` in direction `step`. */
function nextEditable(lines: AlgorithmLine[], index: number, step: -1 | 1) {
  for (let at = index + step; at >= 0 && at < lines.length; at += step) if (lines[at].source?.exact) return at;
  return -1;
}

type Resume = { original: string; draft: string; typed: boolean };

/** Opens line `index` of an algorithm in an editor over it. */
function editLine(view: EditorView, list: AlgorithmElement, index: number, resume?: Resume): boolean {
  const algorithm = list.liberaAlgorithm;
  const line = algorithm?.spec.lines[index];
  const base = algorithm?.base() ?? null;
  if (!algorithm || !line?.source?.exact || base === null || !canEdit(view)) return false;
  const row = list.querySelector<HTMLElement>(`[data-algorithm-line="${index}"]`);
  const body = row?.querySelector<HTMLElement>(".cm-vis-algorithm-body");
  if (!row || !body) return false;
  if (body.querySelector(".cm-vis-algorithm-editor")) return true;
  // Another editor open in this view is saved first (which may redraw this algorithm).
  for (const other of [...sessions]) if (other.view === view && other.area?.isConnected) other.area.blur();
  if (!list.isConnected) return true;
  const from = base + line.source.from;
  const to = base + line.source.to;
  const original = resume?.original ?? view.state.sliceDoc(from, to);
  const area = field(resume?.draft ?? original, "Statement");
  const drawn = [...body.childNodes];
  row.classList.add("cm-vis-algorithm-editing");
  body.replaceChildren(area);
  fit(area);
  area.focus();
  if (resume) area.setSelectionRange(area.value.length, area.value.length);
  else area.select();

  let done = false;
  const session: Session = { view, base, from, to, index, original, typed: resume?.typed ?? false, area, abandon: () => undefined };
  sessions.add(session);
  const onInput = () => { session.typed = true; fit(area); };
  const detach = () => {
    done = true;
    sessions.delete(session);
    area.removeEventListener("keydown", onKey);
    area.removeEventListener("blur", onBlur);
    area.removeEventListener("input", onInput);
    row.classList.remove("cm-vis-algorithm-editing");
  };
  session.abandon = () => { if (!done) detach(); };

  /** Saves (or not) and closes; then edits the line `next` lines on, or opens a new statement below (`"insert"`). */
  const finish = (save: boolean, next: -1 | 0 | 1 | "insert" = 0) => {
    if (done) return;
    detach();
    const text = area.value;
    const now = session.from !== null && session.to !== null ? view.state.sliceDoc(session.from, session.to) : null;
    // Opening and leaving a statement without typing writes nothing.
    if (save && session.typed && text !== original) {
      if (now === null || session.from === null || !canEdit(view)) {
        window.alert(`The algorithm changed while you were editing this statement, so your text was not saved:\n\n${text}`);
      } else if (now === original || window.confirm("A co-author changed this statement while you were editing it. Replace their version with yours?")) {
        dispatchAsOneStep(view, { changes: minimalChange(session.from, now, text), userEvent: "input.visual.algorithm" });
      }
    }
    area.remove();
    if (body.isConnected) body.replaceChildren(...drawn);
    const start = session.base;
    if (save && next !== 0 && start !== null) {
      requestAnimationFrame(() => {
        const current = findList(view, start);
        const lines = current?.liberaAlgorithm?.spec.lines ?? [];
        if (current && next === "insert") { if (openInsert(view, current, index, "below")) return; }
        else if (current && next !== "insert") {
          const sibling = nextEditable(lines, index, next);
          if (sibling >= 0 && editLine(view, current, sibling)) return;
        }
        view.focus();
      });
    } else if (view.dom.isConnected) view.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); finish(true, "insert"); }
    else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); finish(true); }
    else if (event.key === "Tab") { event.preventDefault(); finish(true, event.shiftKey ? -1 : 1); }
    else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const box = row.getBoundingClientRect();
      finish(true);
      const current = session.base === null ? null : findList(view, session.base);
      if (current) lineMenu(view, { clientX: box.left + 24, clientY: box.bottom } as MouseEvent, current, index);
    }
  };
  const onBlur = () => {
    // Removed from the page because the algorithm was redrawn: the new one adopts the draft (adopt).
    if (!area.isConnected) {
      requestAnimationFrame(() => {
        if (done || area.isConnected) return;
        session.abandon();
        if (session.typed && area.value !== original) window.alert(`The algorithm changed while you were editing it, so your text was not saved:\n\n${area.value}`);
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

/** A redrawn algorithm: an editor open in the old one continues on the same line, with its draft. */
function adopt(view: EditorView, list: AlgorithmElement) {
  for (const session of [...sessions]) {
    if (session.view !== view || !session.area || session.area.isConnected || list.liberaAlgorithm?.base() !== session.base) continue;
    const { index, original, typed } = session;
    const draft = session.area.value;
    session.abandon();
    if (!editLine(view, list, index, { original, draft, typed }) && typed && draft !== original) {
      window.alert(`The algorithm changed while you were editing it, so your text was not saved:\n\n${draft}`);
    }
  }
}

/* ---- inserting and deleting statements ------------------------------------------------------ */

/** The closing line algorithmic and algpseudocode write for each block (`\If` … `\EndIf`). */
const CLOSERS: Record<string, string> = {
  if: "EndIf", for: "EndFor", forall: "EndFor", while: "EndWhile", loop: "EndLoop", function: "EndFunction", procedure: "EndProcedure", repeat: "Until{}",
};

/** The LaTeX a typed statement is written as: with `\State` (algorithmic) or `\;` (algorithm2e), a block with its last line. */
export function statementSource(typed: string, pkg: "algorithmic" | "algorithm2e", capitals: boolean, indent: string) {
  let text = typed.trim();
  if (!text) return "";
  if (pkg === "algorithm2e") return /\\;\s*$/.test(text) || /^\\[A-Za-z]+[\s\S]*\}$/.test(text) ? text : `${text}\\;`;
  const command = /^\\([A-Za-z]+)/.exec(text)?.[1];
  if (!command || !isAlgorithmicStatement(command)) return `${capitals ? "\\STATE" : "\\State"} ${text}`;
  const closer = CLOSERS[command.toLowerCase()];
  if (closer && !new RegExp(`\\\\${closer.replace("{}", "")}(?![A-Za-z])`, "i").test(text)) {
    const name = capitals ? closer.toUpperCase().replace("{}", "{}") : closer;
    text += `\n${indent}\\${name}`;
  }
  return text;
}

/** The spaces a document line starts with. */
function indentAt(view: EditorView, pos: number) {
  return /^[ \t]*/.exec(view.state.doc.lineAt(pos).text)![0];
}

/** Opens a field for a new statement above or below line `index`; Enter writes it there. */
function openInsert(view: EditorView, list: AlgorithmElement, index: number, where: "above" | "below"): boolean {
  const algorithm = list.liberaAlgorithm;
  const line = algorithm?.spec.lines[index];
  const base = algorithm?.base() ?? null;
  if (!algorithm || !line || base === null || !canEdit(view)) return false;
  const anchor = where === "above" ? (line.source?.exact ? base + line.source.from : null) : line.after !== undefined ? base + line.after : null;
  const row = list.querySelector<HTMLElement>(`[data-algorithm-line="${index}"]`);
  if (anchor === null || !row) return false;
  for (const other of [...sessions]) if (other.view === view && other.area?.isConnected) other.area.blur();
  const inside = where === "below" && (line.role === "open" || line.role === "middle");
  const fresh = document.createElement("div");
  fresh.className = "cm-vis-algorithm-line cm-vis-algorithm-editing";
  fresh.style.setProperty("--vis-algorithm-depth", String(line.depth + (inside ? 1 : 0)));
  const body = document.createElement("span");
  body.className = "cm-vis-algorithm-body";
  const number = document.createElement("span");
  number.className = "cm-vis-algorithm-number";
  const area = field("", "New statement");
  body.append(area);
  fresh.append(number, body);
  row.insertAdjacentElement(where === "above" ? "beforebegin" : "afterend", fresh);
  fit(area);
  area.focus();
  const pkg = algorithm.spec.package ?? "algorithmic";
  const capitals = /\\(?:STATE|IF|FOR|WHILE|REQUIRE|ENSURE|RETURN)(?![A-Za-z])/.test(view.state.sliceDoc(base, base + Math.max(...algorithm.spec.lines.map((each) => each.source?.to ?? 0))));
  let done = false;
  const session: Session = { view, base, from: anchor, to: anchor, index, original: "", typed: false, area, abandon: () => undefined };
  sessions.add(session);
  const detach = () => { done = true; sessions.delete(session); area.removeEventListener("keydown", onKey); area.removeEventListener("blur", onBlur); fresh.remove(); };
  session.abandon = () => { if (!done) detach(); };
  const write = () => {
    const at = where === "above" ? session.from : session.to;
    const typed = area.value;
    detach();
    if (at === null || !typed.trim() || !canEdit(view)) { if (view.dom.isConnected) view.focus(); return; }
    const doc = view.state.doc;
    const docLine = doc.lineAt(at);
    let indent = indentAt(view, at);
    let change: ChangeSpec;
    if (where === "above") {
      const alone = !doc.sliceString(docLine.from, at).trim();
      const text = statementSource(typed, pkg, capitals, indent);
      change = alone ? { from: docLine.from, insert: `${indent}${text}\n` } : { from: at, insert: `${text} ` };
    } else {
      // Inside a block, one level in: as deep as the line after it is written, else two spaces more.
      if (inside) {
        const nextLine = docLine.number < doc.lines ? doc.line(docLine.number + 1) : null;
        const deeper = nextLine ? /^[ \t]*/.exec(nextLine.text)![0] : "";
        indent = deeper.length > indent.length ? deeper : `${indent}  `;
      }
      change = { from: at, insert: `\n${indent}${statementSource(typed, pkg, capitals, indent)}` };
    }
    dispatchAsOneStep(view, { changes: change, userEvent: "input.visual.algorithm" });
    view.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); detach(); view.focus(); }
    else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); write(); }
  };
  const onBlur = () => { if (!done && area.isConnected) write(); };
  area.addEventListener("keydown", onKey);
  area.addEventListener("blur", onBlur);
  return true;
}

/**
 * What deleting line `line` removes (from the body's start `base`): the statement, or a block whole, with the line(s)
 * it was alone on; null when it cannot be deleted alone (a block's middle or last line, or a line from a macro).
 */
export function deletion(view: EditorView, line: AlgorithmLine, base: number): { from: number; to: number; block: boolean } | null {
  if (!line.source?.exact || line.role === "middle" || line.role === "close") return null;
  if (line.role === "open" && !line.block) return null;
  let from = base + (line.block ?? line.source).from;
  let to = base + (line.block ?? line.source).to;
  // algorithm2e's `\;` after the statement goes with it.
  if (!line.block && line.after !== undefined && base + line.after > to && /^\s*\\;$/.test(view.state.sliceDoc(to, base + line.after))) to = base + line.after;
  const doc = view.state.doc;
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  if (!doc.sliceString(first.from, from).trim() && !doc.sliceString(to, last.to).trim()) {
    // Alone on its lines: the lines go (the line break before them, at the end of the body).
    if (last.to < doc.length) { from = first.from; to = last.to + 1; }
    else { from = Math.max(0, first.from - 1); to = last.to; }
  } else while (to < doc.length && /[ \t]/.test(doc.sliceString(to, to + 1))) to++;
  return { from, to, block: !!line.block };
}

let openMenu: { menu: HTMLElement; close: () => void } | null = null;

/** Insert and delete commands for line `index` of an algorithm. */
function lineMenu(view: EditorView, event: MouseEvent, list: AlgorithmElement, index: number) {
  const algorithm = list.liberaAlgorithm;
  const line = algorithm?.spec.lines[index];
  const base = algorithm?.base() ?? null;
  if (!algorithm || !line || base === null) return;
  const removal = deletion(view, line, base);
  // The text deleted is checked again when the item is chosen: a collaborator's edit meanwhile cancels it.
  const session: Session = { view, base, from: removal?.from ?? null, to: removal?.to ?? null, index, original: removal ? view.state.sliceDoc(removal.from, removal.to) : "", typed: false, area: null, abandon: () => undefined };
  sessions.add(session);
  openMenu?.close();
  const menu = document.createElement("div");
  menu.className = "cm-vis-table-menu cm-vis-algorithm-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Algorithm");
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 180)}px`;
  const returnFocus = document.activeElement as HTMLElement | null;
  const close = () => {
    sessions.delete(session);
    if (openMenu?.menu === menu) openMenu = null;
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
  };
  session.abandon = close;
  const outside = (down: MouseEvent) => { if (!menu.contains(down.target as Node)) close(); };
  const current = () => (session.base === null ? null : findList(view, session.base));
  const lines = removal?.block ? view.state.sliceDoc(removal.from, removal.to).split("\n").filter((text) => text.trim()).length : 0;
  const items: Array<[string, string | null, () => void]> = [
    ["Insert statement above", line.source?.exact ? null : "Not possible here (this line is not written as a statement)", () => { const now = current(); if (now) openInsert(view, now, index, "above"); }],
    ["Insert statement below", line.after !== undefined ? null : "Not possible here", () => { const now = current(); if (now) openInsert(view, now, index, "below"); }],
    [removal?.block ? "Delete block" : "Delete statement", removal ? null : line.role === "middle" || line.role === "close" ? "Delete the block from its first line" : "Not possible here (this line is not written as a statement)", () => {
      const now = session.from !== null && session.to !== null ? view.state.sliceDoc(session.from, session.to) : null;
      if (now === null || now !== session.original || !canEdit(view)) { window.alert("The algorithm changed while this menu was open; nothing was deleted. Try again."); return; }
      if (removal!.block && !window.confirm(`Delete this block and the ${lines} lines of LaTeX in it?`)) return;
      dispatchAsOneStep(view, { changes: { from: session.from!, to: session.to! }, userEvent: "delete.visual.algorithm" });
    }],
    ["Show source", line.source ? null : "Not possible here", () => { const b = session.base; if (b !== null && line.source) revealSourceAt(view, b + line.source.from, b + line.source.to); }],
  ];
  const buttons: HTMLButtonElement[] = [];
  for (const [label, disabled, act] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.textContent = label;
    if (disabled || !canEdit(view) && label !== "Show source") { button.disabled = true; button.title = disabled ?? "This file cannot be edited"; }
    button.addEventListener("mousedown", (down) => down.preventDefault());
    button.addEventListener("click", (click) => {
      click.preventDefault();
      // The menu's session is kept until the action has read its mapped positions.
      menu.remove();
      document.removeEventListener("mousedown", outside, true);
      if (view.dom.isConnected) view.focus();
      act();
      close();
    });
    buttons.push(button);
    menu.append(button);
  }
  menu.addEventListener("keydown", (key) => {
    const enabled = buttons.filter((button) => !button.disabled);
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (key.key === "Escape" || key.key === "Tab") { key.preventDefault(); close(); returnFocus?.focus(); }
    else if (key.key === "ArrowDown" || key.key === "ArrowUp") { key.preventDefault(); enabled[(at + (key.key === "ArrowDown" ? 1 : enabled.length - 1)) % enabled.length]?.focus(); }
  });
  document.body.append(menu);
  document.addEventListener("mousedown", outside, true);
  openMenu = { menu, close };
  buttons.find((button) => !button.disabled)?.focus();
}

/* ---- the caption --------------------------------------------------------------------------- */

/** Where the caption whose LaTeX is `caption` is written in [from, to]: the inside of its `\caption{…}`. */
export function captionRange(text: string, offset: number, caption: string) {
  for (const match of text.matchAll(/\\caption\*?\s*(?:\[[^\]]*\]\s*)?\{/g)) {
    const open = match.index! + match[0].length - 1;
    const group = readGroup(text, open);
    if (group && group.content === caption) return { from: offset + open + 1, to: offset + group.end - 1 };
  }
  return null;
}

function editCaption(view: EditorView, target: HTMLElement, caption: string, range: () => { from: number; to: number } | null): boolean {
  const float = range();
  if (!float || !canEdit(view) || target.querySelector(".cm-vis-algorithm-editor")) return !!float;
  const span = captionRange(view.state.sliceDoc(float.from, float.to), float.from, caption);
  if (!span) return false;
  for (const other of [...sessions]) if (other.view === view && other.area?.isConnected) other.area.blur();
  const original = view.state.sliceDoc(span.from, span.to);
  const area = field(original, "Caption");
  const drawn = [...target.childNodes];
  target.replaceChildren(area);
  fit(area);
  area.focus();
  area.select();
  let done = false;
  const session: Session = { view, base: null, from: span.from, to: span.to, index: -1, original, typed: false, area, abandon: () => undefined };
  sessions.add(session);
  const onInput = () => { session.typed = true; fit(area); };
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    sessions.delete(session);
    area.removeEventListener("keydown", onKey);
    area.removeEventListener("blur", onBlur);
    area.removeEventListener("input", onInput);
    const text = area.value;
    const now = session.from !== null && session.to !== null ? view.state.sliceDoc(session.from, session.to) : null;
    if (save && session.typed && text !== original) {
      if (now === null || session.from === null || !canEdit(view)) window.alert(`The caption changed while you were editing it, so your text was not saved:\n\n${text}`);
      else if (now === original || window.confirm("A co-author changed this caption while you were editing it. Replace their version with yours?")) {
        dispatchAsOneStep(view, { changes: minimalChange(session.from, now, text), userEvent: "input.visual.algorithm" });
      }
    }
    area.remove();
    if (target.isConnected) target.replaceChildren(...drawn);
    if (view.dom.isConnected) view.focus();
  };
  session.abandon = () => { if (!done) { done = true; sessions.delete(session); } };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    else if ((event.key === "Enter" && !event.shiftKey && !event.isComposing) || event.key === "Tab") { event.preventDefault(); finish(true); }
  };
  const onBlur = () => { if (area.isConnected) finish(true); };
  area.addEventListener("keydown", onKey);
  area.addEventListener("blur", onBlur);
  area.addEventListener("input", onInput);
  return true;
}

/** Closes a view's algorithm editors and menus without writing: the view is going away, or leaving the Visual mode. */
export function closeAlgorithmSessions(view: EditorView) {
  for (const session of [...sessions]) if (session.view === view) session.abandon();
  if (openMenu && !sessions.size) openMenu.close();
}

/** Installs the algorithm editor; the figure widget calls it through hooks. */
export function installAlgorithmEditor(): Extension {
  setAlgorithmHooks({ edit: (view, list, index) => editLine(view, list, index), menu: lineMenu, caption: editCaption, adopt });
  return [sessionTracker];
}
