import { MapMode, type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { dispatchAsOneStep } from "../../../collab/undo-boundary";
import { readGroup, readOptional, TEX_GROUPS } from "../../../macros/core";
import { isInLatexComment } from "../../macros/definitions";
import { visualConfig, visualDefinitions } from "./model";
import { ACCUMULATING_AUTHORS, LIPICS } from "./walk";
import { editableLines, frontMatterDetails } from "./front-matter";
import { setTitleHooks, type TitleElement, type TitlePart } from "./widgets";

/* Editing the title block in place. `\maketitle` draws `\title`, `\author`
 * and `\date` written elsewhere (usually the preamble, which is folded), so
 * its own source shows only `\maketitle`. Clicking a part opens that part's
 * LaTeX (the argument of its command, wherever it is written) in a field over
 * it; saving writes only the characters that changed, as one undo step. */

export type SourceSpan = { from: number; to: number };
export type TitleSources = { title: SourceSpan | null; authors: SourceSpan[]; date: SourceSpan | null; abstract: SourceSpan | null; lines: SourceSpan[] };

/** Each use of `\name` in `text` (outside comments), with up to `maxGroups` of its `{…}` arguments, as document ranges of their contents. */
function commandUses(text: string, offset: number, name: string, maxGroups = 1) {
  const uses: SourceSpan[][] = [];
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
    if (groups.length) uses.push(groups);
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
  const last = (uses: SourceSpan[][]) => uses.at(-1)?.[0] ?? null;
  // ICML's `\twocolumn[\icmltitle{…} \icmlauthor{Name}{aff} …]`: the names (affiliations are keys into `\icmlaffiliation`).
  if (/\\icmltitle(?![A-Za-z@])/.test(block)) {
    return { title: last(commandUses(block, from, "icmltitle")), authors: commandUses(block, from, "icmlauthor").map((groups) => groups[0]), date: null, abstract: null, lines: [] };
  }
  // imsart's and elsarticle's `frontmatter`: the commands in it.
  const frontMatter = /^\\begin\s*\{frontmatter\}/.test(block);
  const scope = frontMatter ? block : text;
  const base = frontMatter ? from : 0;
  const documentClass = visualDefinitions(state).documentClass ?? "";
  let authors: SourceSpan[];
  if (!frontMatter && LIPICS.test(documentClass)) {
    // LIPIcs' `\author{Name}{Affiliation}{email}{orcid}{funding}`: all five arguments, braces included.
    authors = commandUses(text, 0, "author", 5).map((groups) => ({ from: groups[0].from - 1, to: groups.at(-1)!.to + 1 }));
  } else {
    const uses = commandUses(scope, base, "author").map((groups) => groups[0]);
    // The classes that add an author with each `\author`; the others print the last one.
    authors = (frontMatter || ACCUMULATING_AUTHORS.test(documentClass) ? uses : uses.slice(-1)).flatMap((span) => authorPieces(state, span));
  }
  let abstract: SourceSpan | null = null;
  for (const match of text.matchAll(/\\begin\s*\{abstract\}/g)) {
    if (isInLatexComment(text, match.index ?? 0)) continue;
    const contentFrom = (match.index ?? 0) + match[0].length;
    const end = /\\end\s*\{abstract\}/.exec(text.slice(contentFrom));
    if (end) abstract = trimmed(state, { from: contentFrom, to: contentFrom + end.index });
  }
  // sn-jnl's `\abstract{…}` command.
  // (A&A's `\abstract{…}{…}{…}{…}{…}`, drawn with a label before each part, has no one place to edit: a click shows its source.)
  if (!abstract) {
    const use = commandUses(scope, base, "abstract").at(-1);
    const after = use ? state.sliceDoc(use[0].to + 1, Math.min(state.doc.length, use[0].to + 400)) : "";
    abstract = use && !/^(?:\s|%[^\n]*)*\{/.test(after) ? use[0] : null;
  }
  if (abstract) abstract = trimmed(state, abstract);
  const span = (found: SourceSpan | null) => (found ? trimmed(state, found) : null);
  // A class's affiliations, emails, institutes and notes, in the order the block numbers them.
  const details = frontMatterDetails(scope, base, documentClass, authors.length, frontMatter);
  const lines = details ? editableLines(details).map((line) => line.source!) : [];
  return { title: span(last(commandUses(scope, base, "title"))), authors, date: span(last(commandUses(scope, base, "date"))), abstract, lines };
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

const LABELS: Record<TitlePart, string> = { title: "Title", author: "Author", date: "Date", abstract: "Abstract", line: "Line" };

/**
 * An open part editor. Its source range and the block's start are mapped through every change (a collaborator's
 * too), so saving writes to the same text, or knows it is gone.
 */
type TitleSession = {
  view: EditorView; blockStart: number | null; from: number | null; to: number | null;
  part: TitlePart; index: number; original: string; typed: boolean; area: HTMLTextAreaElement; abandon: () => void;
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
  return [...block.querySelectorAll<HTMLElement>("[data-title-part]")];
}

function findBlock(view: EditorView, start: number) {
  for (const block of view.contentDOM.querySelectorAll<TitleElement>(".cm-vis-title-block")) if (block.liberaTitleStart?.() === start) return block;
  return null;
}

type Resume = { original: string; draft: string; typed: boolean };

function editPart(view: EditorView, block: TitleElement, part: TitlePart, index: number, resume?: Resume): boolean {
  const blockStart = block.liberaTitleStart?.();
  if (blockStart === null || blockStart === undefined || !canEdit(view)) return false;
  if (block.querySelector(`[data-title-part="${part}"][data-title-index="${index}"] .cm-vis-title-editor`)) return true;
  // Another part open in this view is saved first (which may redraw this block).
  for (const other of [...sessions]) if (other.view === view && other.area.isConnected) other.area.blur();
  if (!block.isConnected) return true;
  const target = block.querySelectorAll<HTMLElement>(`[data-title-part="${part}"]`)[index];
  if (!target) return false;
  const sources = titleSources(view.state, blockStart, blockStart + (block.liberaTitleScope ?? block.liberaTitleLength ?? 0));
  // An author list the block reads differently from its source (a macro that writes `\and`): edited as source instead.
  const span = part === "author"
    ? (sources.authors.length === block.querySelectorAll(`[data-title-part="author"]`).length ? sources.authors[index] : null)
    : part === "line" ? sources.lines[index] ?? null : sources[part];
  if (!span) return false;

  const original = resume?.original ?? view.state.sliceDoc(span.from, span.to);
  const area = document.createElement("textarea");
  area.className = "cm-vis-title-editor";
  area.spellcheck = false;
  area.rows = 1;
  area.value = resume?.draft ?? view.state.sliceDoc(span.from, span.to);
  area.setAttribute("aria-label", `${LABELS[part]} (LaTeX). Enter saves, Shift+Enter starts a new line, Escape cancels.`);
  target.classList.add("cm-vis-title-editing");
  target.replaceChildren(area);
  const fit = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; };
  fit();
  area.focus();
  if (resume) area.setSelectionRange(area.value.length, area.value.length);
  else area.select();

  let done = false;
  const session: TitleSession = { view, blockStart, from: span.from, to: span.to, part, index, original, typed: resume?.typed ?? false, area, abandon: () => undefined };
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
    if (save && session.typed && text !== original) {
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
    if (save && next !== 0 && start !== null) {
      requestAnimationFrame(() => {
        const current = findBlock(view, start);
        const parts = current ? partElements(current) : [];
        const at = parts.findIndex((element) => element.dataset.titlePart === part && Number(element.dataset.titleIndex) === index);
        const sibling = at >= 0 ? parts[at + next] : undefined;
        if (current && sibling && editPart(view, current, sibling.dataset.titlePart as TitlePart, Number(sibling.dataset.titleIndex))) return;
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
    const { part, index, original, typed } = session;
    const draft = session.area.value;
    session.abandon();
    if (!editPart(view, block, part, index, { original, draft, typed }) && typed && draft !== original) {
      window.alert(`The title block changed while you were editing it, so your text was not saved:\n\n${draft}`);
    }
  }
}

/** Closes a view's title editors without writing: the view is going away, or leaving the Visual mode. */
export function closeTitleSessions(view: EditorView) {
  for (const session of [...sessions]) if (session.view === view) session.abandon();
}

/** Installs the title editor; the title block calls it through hooks. */
export function installTitleEditor(): Extension {
  setTitleHooks({ edit: (view, block, part, index) => editPart(view, block, part, index), adopt: adoptSessions });
  return [sessionTracker];
}
