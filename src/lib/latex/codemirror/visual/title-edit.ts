import { MapMode, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep } from "../../../collab/undo-boundary";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { isInLatexComment } from "../../macros/definitions";
import { beginDocumentIndex } from "../../document-begin";
import { preambleOpenField, togglePreamble, visualConfig, visualDefinitions } from "./model";
import { preambleEndOf } from "./structural";
import { ACCUMULATING_AUTHORS, LIPICS } from "./walk";
import { editableLines, frontMatterDetails } from "./front-matter";
import { setTitleHooks, type TitleElement, type TitlePart } from "./widgets";

/* Editing the title block in place. `\maketitle` draws `\title`, `\author`
 * and `\date` written elsewhere (usually the preamble, which is folded), so
 * its own source shows only `\maketitle`. Clicking a part opens that part's
 * LaTeX (the argument of its command, wherever it is written) in a field over
 * it; saving writes only the characters that changed, as one undo step. */

export type SourceSpan = { from: number; to: number };
/**
 * `notes`: the arguments of the commands behind each small line under the title (keywords, CCS concepts, subject
 * classes), in the order the block draws them; `start`: where the first command that makes the block up is written
 * (`\title`, `\author`, `\affiliation`, the abstract, …), for showing its source; `addAuthorAt`: where another
 * author goes (` \and …` at the end of the author list), null where `\and` is not how the class adds one.
 */
export type TitleSources = { title: SourceSpan | null; authors: SourceSpan[]; date: SourceSpan | null; abstract: SourceSpan | null; lines: SourceSpan[]; notes: SourceSpan[][]; start: number | null; addAuthorAt: number | null };

/** One use of a command: the ranges of its arguments, and where the command itself starts. */
type CommandUse = SourceSpan[] & { start: number };

/** Each use of `\name` in `text` (outside comments), with up to `maxGroups` of its `{…}` arguments, as document ranges of their contents. */
function commandUses(text: string, offset: number, name: string, maxGroups = 1) {
  const uses: CommandUse[] = [];
  for (const match of text.matchAll(new RegExp(`\\\\${name}(?![A-Za-z@])\\*?`, "g"))) {
    const index = match.index ?? 0;
    if (isInLatexComment(text, index)) continue;
    const groups: SourceSpan[] = [];
    for (let at = index + match[0].length; groups.length < maxGroups;) {
      const space = /^\s*/.exec(text.slice(at, at + 200))![0];
      // A blank line ends the command's arguments.
      if (/\n[ \t]*\n/.test(space)) break;
      const next = at + space.length;
      if (text[next] === "[" && !groups.length) {
        const optional = readOptional(text, next, TEX_GROUPS);
        if (!optional) break;
        at = optional.end;
        continue;
      }
      const group = text[next] === "{" ? readGroup(text, next, TEX_GROUPS) : null;
      if (!group) break;
      groups.push({ from: offset + next + 1, to: offset + group.end - 1 });
      at = group.end;
    }
    if (groups.length) uses.push(Object.assign(groups, { start: offset + index }));
  }
  return uses;
}

/** A range without the spaces and line breaks at its ends. */
function trimmed(state: EditorState, span: SourceSpan): SourceSpan {
  const text = state.sliceDoc(span.from, span.to);
  const start = text.length - text.trimStart().length;
  return { from: span.from + start, to: Math.max(span.from + start, span.to - (text.length - text.trimEnd().length)) };
}

/** An `\author` argument split at `\and`, as the title block splits it (empty pieces are not drawn). */
function authorPieces(state: EditorState, span: SourceSpan) {
  const text = state.sliceDoc(span.from, span.to);
  const pieces: SourceSpan[] = [];
  let start = 0;
  const push = (end: number) => { if (text.slice(start, end).trim()) pieces.push(trimmed(state, { from: span.from + start, to: span.from + end })); };
  for (const match of text.matchAll(/\\(?:and|And|AND)(?![A-Za-z])/g)) {
    push(match.index ?? 0);
    start = (match.index ?? 0) + match[0].length;
  }
  push(text.length);
  return pieces;
}

/**
 * Where the parts of the title block drawn over [from, to] are written: the same commands the walk reads for it
 * (walk.ts: scanTitleParts, frontMatterParts, icmlTitle), as ranges of their arguments.
 */
export function titleSources(state: EditorState, from: number, to: number): TitleSources {
  const text = state.sliceDoc(0, to);
  const block = text.slice(from);
  // Where each command that makes the block up starts.
  const starts: number[] = [];
  const first = () => (starts.length ? Math.min(...starts) : null);
  const note = (use: CommandUse | undefined) => { if (use) starts.push(use.start); return use; };
  // ICML's `\twocolumn[\icmltitle{…} \icmlauthor{Name}{aff} …]`: the names (affiliations are keys into `\icmlaffiliation`).
  if (/\\icmltitle(?![A-Za-z@])/.test(block)) {
    const title = note(commandUses(block, from, "icmltitle").at(-1));
    const names = commandUses(block, from, "icmlauthor");
    names.forEach(note);
    return { title: title?.[0] ?? null, authors: names.map((groups) => groups[0]), date: null, abstract: null, lines: [], notes: [], start: first(), addAuthorAt: null };
  }
  // imsart's and elsarticle's `frontmatter`: the commands in it.
  const frontMatter = /^\\begin\s*\{frontmatter\}/.test(block);
  const scope = frontMatter ? block : text;
  const base = frontMatter ? from : 0;
  const documentClass = visualDefinitions(state).documentClass ?? "";
  let authors: SourceSpan[];
  let addAuthorAt: number | null = null;
  if (!frontMatter && LIPICS.test(documentClass)) {
    // LIPIcs' `\author{Name}{Affiliation}{email}{orcid}{funding}`: all five arguments, braces included.
    const uses = commandUses(text, 0, "author", 5);
    uses.forEach(note);
    authors = uses.map((groups) => ({ from: groups[0].from - 1, to: groups.at(-1)!.to + 1 }));
  } else {
    const all = commandUses(scope, base, "author");
    // The classes that add an author with each `\author`; the others print the last one, and take another after `\and`.
    const accumulating = frontMatter || ACCUMULATING_AUTHORS.test(documentClass);
    const uses = accumulating ? all : all.slice(-1);
    uses.forEach(note);
    authors = uses.flatMap((use) => authorPieces(state, use[0]));
    if (!accumulating && uses.length) addAuthorAt = trimmed(state, uses[0][0]).to;
  }
  let abstract: SourceSpan | null = null;
  let abstractStart: number | null = null;
  for (const match of text.matchAll(/\\begin\s*\{abstract\}/g)) {
    if (isInLatexComment(text, match.index ?? 0)) continue;
    const contentFrom = (match.index ?? 0) + match[0].length;
    const end = /\\end\s*\{abstract\}/.exec(text.slice(contentFrom));
    if (end) { abstract = { from: contentFrom, to: contentFrom + end.index }; abstractStart = match.index ?? 0; }
  }
  // sn-jnl's `\abstract{…}` command.
  if (!abstract) {
    const use = commandUses(scope, base, "abstract").at(-1);
    abstract = use?.[0] ?? null;
    abstractStart = use?.start ?? null;
  }
  if (abstract) {
    abstract = trimmed(state, abstract);
    if (abstractStart !== null) starts.push(abstractStart);
  }
  const span = (found: SourceSpan | null) => (found ? trimmed(state, found) : null);
  const title = note(commandUses(scope, base, "title").at(-1));
  const date = note(commandUses(scope, base, "date").at(-1));
  // A class's affiliations, emails, institutes and notes, in the order the block numbers them.
  const details = frontMatterDetails(scope, base, documentClass, authors.length, frontMatter);
  const lines = details ? editableLines(details).map((line) => line.source!) : [];
  for (const line of lines) starts.push(commandStartBefore(state, line));
  // The small lines under the block (walk.ts: scanTitleParts for the preamble's, titleRun for the declarations it folds).
  const notes: SourceSpan[][] = [];
  const addNotes = (source: string, offset: number) => {
    const blank = withoutNoteDefinitions(source);
    // CCS concepts, keywords, subject classes: the order titleNotes draws them in.
    for (const name of ["ccsdesc", "keywords", "subjclass"]) {
      const uses = commandUses(blank, offset, name);
      if (!uses.length) continue;
      uses.forEach(note);
      notes.push(uses.map((groups) => trimmed(state, groups[0])));
    }
  };
  const bodyStart = beginDocumentIndex(text);
  if (bodyStart > 0 && !frontMatter) addNotes(text.slice(0, bodyStart), 0);
  addNotes(block, from);
  return { title: span(title?.[0] ?? null), authors, date: span(date?.[0] ?? null), abstract, lines, notes, start: first(), addAuthorAt };
}

/** Blanks (keeping offsets) the definitions of the note commands: `\newcommand\keywords[1]{…}` is not a use of `\keywords`. */
function withoutNoteDefinitions(text: string) {
  return text.replace(/\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|def)\*?\s*\{?\s*\\(?=keywords|subjclass|ccsdesc)/g, (found) => " ".repeat(found.length));
}

/** Where the command whose argument is written at `span` starts (the `\affiliation{` before its text), or the span itself when that is not found. */
function commandStartBefore(state: EditorState, span: SourceSpan) {
  const before = state.sliceDoc(Math.max(0, span.from - 300), span.from);
  const found = /\\[A-Za-z@]+\*?(?:\s*\[[^\]]*\])*\s*\{[^{}]*$/.exec(before);
  return found ? span.from - before.length + found.index : span.from;
}

/** Whether the view may be edited through the title block (a viewer, a read-only tab, or a closed view may not). */
function canEdit(view: EditorView) {
  return view.dom.isConnected && !view.state.readOnly && view.state.facet(visualConfig).editable();
}

/** The one change that turns `now` (at `from`) into `text`: only the characters that differ. */
export function minimalChange(from: number, now: string, text: string) {
  let start = 0;
  while (start < now.length && start < text.length && now[start] === text[start]) start++;
  let end = 0;
  while (end < now.length - start && end < text.length - start && now[now.length - 1 - end] === text[text.length - 1 - end]) end++;
  return { from: from + start, to: from + now.length - end, insert: text.slice(start, text.length - end) };
}

const LABELS: Record<TitlePart, string> = { title: "Title", author: "Author", date: "Date", abstract: "Abstract", line: "Line", note: "Keywords and notes" };

/** What ` \and ` and a new author's text are written after, at the end of the author list (an author being added has no source yet). */
const ADD_AUTHOR_PREFIX = " \\and ";

/**
 * An open part editor. Its source range and the block's start are mapped through every change (a collaborator's
 * too), so saving writes to the same text, or knows it is gone. `adding`: a new author, which is written (after
 * `\and`) only when it is saved with some text; an empty or cancelled one writes nothing.
 */
type TitleSession = {
  view: EditorView; blockStart: number | null; from: number | null; to: number | null;
  part: TitlePart; index: number; original: string; typed: boolean; adding: boolean; area: HTMLTextAreaElement; abandon: () => void;
};
const sessions = new Set<TitleSession>();

const sessionTracker = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  for (const session of sessions) {
    if (session.view !== update.view) continue;
    const map = (pos: number | null, assoc: -1 | 1) => (pos === null ? null : update.changes.mapPos(pos, assoc, MapMode.TrackDel));
    session.blockStart = map(session.blockStart, 1);
    session.from = map(session.from, -1);
    session.to = map(session.to, 1);
  }
});

/** The parts of a block in order, for Tab and Shift+Tab. */
function partElements(block: HTMLElement) {
  return [...block.querySelectorAll<HTMLElement>("[data-title-part], [data-title-note]")];
}

/** The part a drawn element stands for: keywords and the like are numbered on their own (`data-title-note`). */
function elementPart(element: HTMLElement): { part: TitlePart; index: number } {
  if (element.dataset.titleNote !== undefined) return { part: "note", index: Number(element.dataset.titleNote) };
  return { part: element.dataset.titlePart as TitlePart, index: Number(element.dataset.titleIndex ?? 0) };
}

function partTarget(block: HTMLElement, part: TitlePart, index: number) {
  return part === "note" ? block.querySelectorAll<HTMLElement>("[data-title-note]")[index] : block.querySelectorAll<HTMLElement>(`[data-title-part="${part}"]`)[index];
}

function findBlock(view: EditorView, start: number) {
  for (const block of view.contentDOM.querySelectorAll<TitleElement>(".cm-vis-title-block")) if (block.liberaTitleStart?.() === start) return block;
  return null;
}

type Resume = { original: string; draft: string; typed: boolean };

/** The author list's end when another author can be added to the block: `\and` is how its class joins authors, and the list is read as drawn. */
function authorAppendPoint(block: TitleElement, sources: TitleSources) {
  return sources.addAuthorAt !== null && sources.authors.length === block.querySelectorAll(`[data-title-part="author"]`).length ? sources.addAuthorAt : null;
}

function editPart(view: EditorView, block: TitleElement, part: TitlePart, index: number, resume?: Resume, adding = false): boolean {
  const blockStart = block.liberaTitleStart?.();
  if (blockStart === null || blockStart === undefined || !canEdit(view)) return false;
  const newAuthor = ".cm-vis-title-new-author";
  if (adding ? block.querySelector(`${newAuthor} .cm-vis-title-editor`) : block.querySelector(part === "note" ? `[data-title-note="${index}"] .cm-vis-title-editor` : `[data-title-part="${part}"][data-title-index="${index}"] .cm-vis-title-editor`)) return true;
  // Another part open in this view is saved first (which may redraw this block).
  for (const other of [...sessions]) if (other.view === view && other.area.isConnected) other.area.blur();
  if (!block.isConnected) return true;
  const sources = titleSources(view.state, blockStart, blockStart + (block.liberaTitleScope ?? block.liberaTitleLength ?? 0));
  let target: HTMLElement | undefined;
  let span: SourceSpan | null;
  if (adding) {
    // A new author after the last one: an empty field at the end of the author line, written (after `\and`) when it has text.
    const at = authorAppendPoint(block, sources);
    const authors = block.querySelector<HTMLElement>(".cm-vis-authors");
    if (at === null || !authors) return false;
    target = document.createElement("div");
    target.className = "cm-vis-author cm-vis-title-new-author";
    authors.querySelector(".cm-vis-title-add-author")?.before(target);
    if (!target.parentElement) authors.append(target);
    span = { from: at, to: at };
  } else {
    target = partTarget(block, part, index);
    if (!target) return false;
    // An author list the block reads differently from its source (a macro that writes `\and`): edited as source instead.
    // A line made of several commands (several `\ccsdesc`) is not one field either.
    span = part === "author"
      ? (sources.authors.length === block.querySelectorAll(`[data-title-part="author"]`).length ? sources.authors[index] : null)
      : part === "line" ? sources.lines[index] ?? null
        : part === "note" ? (sources.notes.length === block.querySelectorAll("[data-title-note]").length && sources.notes[index]?.length === 1 ? sources.notes[index][0] : null)
          : sources[part];
  }
  if (!span || !target) { target?.remove(); return false; }

  const original = resume?.original ?? view.state.sliceDoc(span.from, span.to);
  const area = document.createElement("textarea");
  area.className = "cm-vis-title-editor";
  area.spellcheck = false;
  area.rows = 1;
  area.value = resume?.draft ?? view.state.sliceDoc(span.from, span.to);
  area.setAttribute("aria-label", `${adding ? "New author" : LABELS[part]} (LaTeX). Enter saves, Shift+Enter starts a new line, Escape cancels.`);
  target.classList.add("cm-vis-title-editing");
  target.replaceChildren(area);
  const fit = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; };
  fit();
  area.focus();
  if (resume) area.setSelectionRange(area.value.length, area.value.length);
  else area.select();

  let done = false;
  const session: TitleSession = { view, blockStart, from: span.from, to: span.to, part, index, original, typed: resume?.typed ?? false, adding, area, abandon: () => undefined };
  sessions.add(session);
  const onInput = () => { session.typed = true; fit(); };
  const detach = () => {
    done = true;
    sessions.delete(session);
    area.removeEventListener("keydown", onKey);
    area.removeEventListener("blur", onBlur);
    area.removeEventListener("input", onInput);
    target.classList.remove("cm-vis-title-editing");
  };
  session.abandon = () => { if (!done) detach(); };

  const finish = (save: boolean, next: -1 | 0 | 1 = 0) => {
    if (done) return;
    detach();
    const text = area.value;
    const now = session.from !== null && session.to !== null ? view.state.sliceDoc(session.from, session.to) : null;
    // Opening and leaving a part without typing writes nothing.
    if (adding) {
      // A new author: ` \and ` and its text at the end of the list (the point moves with every change before it).
      if (save && text.trim()) {
        if (session.from === null || !canEdit(view)) window.alert(`The title changed while you were adding an author, so your text was not saved:\n\n${text}`);
        else dispatchAsOneStep(view, { changes: { from: session.from, insert: ADD_AUTHOR_PREFIX + text.trim() }, userEvent: "input.visual.title" });
      }
    } else if (save && session.typed && text !== original) {
      if (now === null || session.from === null || !canEdit(view)) {
        window.alert(`The title changed while you were editing it, so your text was not saved:\n\n${text}`);
      } else if (now === original || window.confirm(`A co-author changed this ${LABELS[part].toLowerCase()} while you were editing it. Replace their version with yours?`)) {
        dispatchAsOneStep(view, { changes: minimalChange(session.from, now, text), userEvent: "input.visual.title" });
      }
    }
    // The block shows its parts again (or is redrawn by the change, when there was one).
    area.remove();
    block.liberaTitleRender?.();
    const start = session.blockStart;
    if (save && next !== 0 && start !== null && !adding) {
      requestAnimationFrame(() => {
        const current = findBlock(view, start);
        const parts = current ? partElements(current) : [];
        const at = parts.findIndex((element) => { const found = elementPart(element); return found.part === part && found.index === index; });
        const sibling = at >= 0 ? parts[at + next] : undefined;
        const open = sibling ? elementPart(sibling) : null;
        if (current && open && editPart(view, current, open.part, open.index)) return;
        view.focus();
      });
    } else if (view.dom.isConnected) view.focus();
  };
  const onKey = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); finish(true); }
    else if (event.key === "Tab") { event.preventDefault(); finish(true, event.shiftKey ? -1 : 1); }
  };
  const onBlur = () => {
    // Removed from the page because the block was redrawn: the new block adopts the draft (adoptSessions).
    if (!area.isConnected) {
      requestAnimationFrame(() => {
        if (done || area.isConnected) return;
        session.abandon();
        if (session.typed && area.value !== original) window.alert(`The title block changed while you were editing it, so your text was not saved:\n\n${area.value}`);
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

/** A redrawn title block: an editor open in the old one continues on the same part, with its draft. */
function adoptSessions(view: EditorView, block: TitleElement) {
  for (const session of [...sessions]) {
    if (session.view !== view || session.area.isConnected || block.liberaTitleStart?.() !== session.blockStart) continue;
    const { part, index, original, typed, adding } = session;
    const draft = session.area.value;
    session.abandon();
    if (!editPart(view, block, part, index, { original, draft, typed }, adding) && typed && draft !== original) {
      window.alert(`The title block changed while you were editing it, so your text was not saved:\n\n${draft}`);
    }
  }
}

/** Closes a view's title editors without writing: the view is going away, or leaving the Visual mode. */
export function closeTitleSessions(view: EditorView) {
  for (const session of [...sessions]) if (session.view === view) session.abandon();
}

/**
 * Shows the real source of the whole block: every command it is made of (`\title`, `\author` with each `\and`,
 * `\date`, affiliations, the abstract and keywords it draws, up to `\maketitle`), wherever they are written. They
 * are usually in the folded preamble, which opens; the cursor goes to the first of them, ready to type.
 */
export function revealTitleSource(view: EditorView, block: TitleElement): boolean {
  let start = block.liberaTitleStart?.();
  if (start === null || start === undefined) return false;
  // An open field is saved first (which redraws the block, and may move it).
  for (const other of [...sessions]) if (other.view === view && other.area.isConnected) other.area.blur();
  let live = block;
  if (!block.isConnected) {
    const was = start;
    let nearest: TitleElement | null = null;
    let gap = Infinity;
    for (const candidate of view.contentDOM.querySelectorAll<TitleElement>(".cm-vis-title-block")) {
      const at = candidate.liberaTitleStart?.();
      if (at !== null && at !== undefined && Math.abs(at - was) < gap) { gap = Math.abs(at - was); nearest = candidate; }
    }
    if (!nearest) return false;
    live = nearest;
    start = nearest.liberaTitleStart!()!;
  }
  const length = live.liberaTitleLength ?? 0;
  const { state } = view;
  const first = titleSources(state, start, start + (live.liberaTitleScope ?? length)).start;
  const effects = [];
  let anchor: number;
  if (first !== null && first < start) {
    // Written before the block: in the folded preamble, which opens; the plain source is there to type in.
    anchor = first;
    if (first <= preambleEndOf(state) && !state.field(preambleOpenField, false)) effects.push(togglePreamble.of(true));
  } else {
    // Written in the block's own range, which shows its source while the cursor is strictly inside it.
    const end = start + length;
    anchor = Math.max(start, Math.min(end - 1, (first ?? start) + 1));
  }
  view.dispatch({ selection: { anchor }, effects, scrollIntoView: true });
  view.focus();
  return true;
}

/** Whether another author can be added to the block: only where `\and` joins the authors (the others add one `\author` each). */
function canAddAuthor(view: EditorView, block: TitleElement) {
  if (!canEdit(view)) return false;
  const start = block.liberaTitleStart?.();
  // Not placed yet (just drawn): the class alone tells.
  if (start === null || start === undefined) return !ACCUMULATING_AUTHORS.test(visualDefinitions(view.state).documentClass ?? "");
  return authorAppendPoint(block, titleSources(view.state, start, start + (block.liberaTitleScope ?? block.liberaTitleLength ?? 0))) !== null;
}

/** Installs the title editor; the title block calls it through hooks. */
export function installTitleEditor(): Extension {
  setTitleHooks({
    edit: (view, block, part, index) => editPart(view, block, part, index),
    reveal: revealTitleSource,
    canAddAuthor,
    addAuthor: (view, block) => editPart(view, block, "author", 0, undefined, true),
    adopt: adoptSessions,
  });
  return [sessionTracker];
}
