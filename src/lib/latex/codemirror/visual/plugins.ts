import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { ySyncFacet } from "y-codemirror.next";
import { remoteUsers } from "../../../collab/awareness";
import { latexParser } from "../latex-parser";
import { loadKey } from "../../macros/definitions";
import { computeLatexNumbering, type IncludedFile } from "../../macros/numbering";
import { latexProjectField } from "../editing";
import { auxField, definitionsField, numberingField, numberingIncludesField, numberingStartField, setNumbering, visualConfig, visualDefinitions } from "./model";
import { buildPendingEffect, CHUNK, constructAt, structuralField } from "./structural";
import { followReference, refreshVisualWidgets } from "./widgets";

/* The Visual mode's background work: numbering after a pause in typing,
 * building the rest of a long document while the browser is idle, opening
 * links, and outlining where collaborators are. None of it changes the
 * document. */

const NUMBERING_DELAY = 150;

/** Included files' parse trees, kept while their texts stay the same. */
const includedTrees = new Map<string, IncludedFile>();
function includedFile(text: string | undefined): IncludedFile | null {
  if (text === undefined) return null;
  let file = includedTrees.get(text);
  if (!file) {
    file = { tree: latexParser.parse(text), read: (from, to) => text.slice(from, to) };
    includedTrees.set(text, file);
    if (includedTrees.size > 40) includedTrees.delete(includedTrees.keys().next().value!);
  }
  return file;
}

type IdleWindow = { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (handle: number) => void };
const idle = () => globalThis as unknown as IdleWindow;
const requestIdle = (callback: () => void): number => idle().requestIdleCallback?.(callback, { timeout: 400 }) ?? (setTimeout(callback, 30) as unknown as number);
const cancelIdle = (handle: number) => {
  if (idle().cancelIdleCallback) idle().cancelIdleCallback!(handle);
  else clearTimeout(handle);
};

/** Numbers headings, equations, figures and labels after a pause, and refreshes the widgets that show numbers. */
export const numberingPlugin = ViewPlugin.fromClass(class {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly view: EditorView) { this.schedule(0); }
  update(update: ViewUpdate) {
    const state = update.state;
    if (update.docChanged || syntaxTree(update.startState) !== syntaxTree(state) || update.startState.field(definitionsField, false) !== state.field(definitionsField, false)
      || update.startState.field(numberingStartField, false) !== state.field(numberingStartField, false)
      || update.startState.field(numberingIncludesField, false) !== state.field(numberingIncludesField, false)) {
      this.schedule(NUMBERING_DELAY);
    }
    if (update.startState.field(numberingField, false) !== state.field(numberingField, false)
      || update.startState.field(auxField, false) !== state.field(auxField, false)
      || update.startState.field(latexProjectField, false) !== state.field(latexProjectField, false)) {
      this.queueRefresh(false);
    } else if (update.viewportChanged && !update.docChanged) {
      // Scrolled: lines drawn again may reuse an equal widget's DOM from another place (every `\section` number is equal).
      this.queueRefresh(true);
    }
  }
  private schedule(delay: number) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.compute(); }, delay);
  }
  private compute() {
    const state = this.view.state;
    const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
    const includes = state.field(numberingIncludesField, false);
    const numbering = computeLatexNumbering(tree, (from, to) => state.doc.sliceString(from, to), visualDefinitions(state), {
      start: state.field(numberingStartField, false),
      includes: includes?.size ? (name) => includedFile(includes.get(loadKey("input", name))) : null,
    });
    if (numbering.fingerprint !== state.field(numberingField, false)?.fingerprint) this.view.dispatch({ effects: setNumbering.of(numbering) });
  }
  /** A full refresh queued, or one of the widgets that moved: a full one covers both. */
  private refreshQueued: "all" | "moved" | null = null;
  private queueRefresh(moved: boolean) {
    if (this.refreshQueued === "all" || (this.refreshQueued === "moved" && moved)) return;
    const first = this.refreshQueued === null;
    this.refreshQueued = moved ? "moved" : "all";
    if (first) queueMicrotask(() => { const kind = this.refreshQueued; this.refreshQueued = null; refreshVisualWidgets(this.view, kind === "moved"); });
  }
  destroy() { if (this.timer !== null) clearTimeout(this.timer); }
});

/** Builds the pending pieces of a long document while idle, the ones on screen first. */
export const pendingFiller = ViewPlugin.fromClass(class {
  private handle: number | null = null;
  constructor(readonly view: EditorView) { this.maybeSchedule(); }
  update(update: ViewUpdate) {
    // A piece on screen that is not built yet goes first, without waiting for idle time.
    if (update.viewportChanged || update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(buildPendingEffect)))) this.maybeSchedule();
    else if (update.startState.field(structuralField, false)?.pending !== update.state.field(structuralField, false)?.pending) this.maybeSchedule();
  }
  private next() {
    const pending = this.view.state.field(structuralField, false)?.pending ?? [];
    if (!pending.length) return null;
    const { from: top, to: bottom } = this.view.viewport;
    const visible = pending.find((range) => range.from < bottom && range.to > top);
    if (visible) {
      const from = Math.max(visible.from, top - CHUNK / 2);
      return { from, to: Math.min(visible.to, from + CHUNK) };
    }
    const after = pending.find((range) => range.from >= bottom) ?? pending[0];
    return { from: after.from, to: Math.min(after.to, after.from + CHUNK) };
  }
  private maybeSchedule() {
    if (this.handle !== null) return;
    if (!this.next()) return;
    this.handle = requestIdle(() => {
      this.handle = null;
      const chunk = this.next();
      if (chunk) this.view.dispatch({ effects: buildPendingEffect.of(chunk) });
    });
  }
  destroy() { if (this.handle !== null) cancelIdle(this.handle); }
});

/** ⌘/Ctrl-click on a link opens it. */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = (event.target as HTMLElement | null)?.closest?.(".cm-vis-link") as HTMLElement | null;
    if (!target || !(event.metaKey || event.ctrlKey)) return false;
    // `\hyperref[label]{text}`: to the label.
    const ref = target.getAttribute("data-ref");
    if (ref) { event.preventDefault(); return followReference(view, ref); }
    const href = target.getAttribute("data-href") ?? target.closest("[data-href]")?.getAttribute("data-href");
    if (!href || !/^(?:https?:|mailto:)/i.test(href.trim())) return false;
    event.preventDefault();
    view.state.facet(visualConfig).openLink(href.trim());
    return true;
  },
});

const setRemoteOutlines = StateEffect.define<DecorationSet>();
const remoteOutlineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setRemoteOutlines)) return effect.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

type AwarenessEvents = { on: (event: string, fn: () => void) => void; off: (event: string, fn: () => void) => void };

/** Outlines the construct each collaborator's cursor is in; it is never revealed for you. */
const remoteOutlinePlugin = ViewPlugin.fromClass(class {
  private listener: (() => void) | null = null;
  private awareness: AwarenessEvents | null = null;
  private scheduled = false;
  constructor(readonly view: EditorView) {
    const config = view.state.facet(ySyncFacet) as unknown as { awareness?: AwarenessEvents | null; ytext?: unknown } | undefined;
    if (!config?.awareness || !config.ytext) return;
    const awareness = config.awareness;
    this.awareness = awareness;
    const listener = () => this.schedule();
    this.listener = listener;
    awareness.on("change", listener);
    this.schedule();
  }
  update(update: ViewUpdate) {
    if (update.docChanged) this.schedule();
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => { this.scheduled = false; this.refresh(); });
  }
  private refresh() {
    const config = this.view.state.facet(ySyncFacet) as unknown as { awareness?: Parameters<typeof remoteUsers>[0]; ytext?: Parameters<typeof remoteUsers>[1] } | undefined;
    if (!config?.awareness) return;
    const ranges: Array<Range<Decoration>> = [];
    for (const user of remoteUsers(config.awareness, config.ytext)) {
      if (!user.cursor) continue;
      const construct = constructAt(this.view.state, Math.min(user.cursor.head, this.view.state.doc.length));
      if (!construct || construct.to <= construct.from) continue;
      ranges.push(Decoration.mark({ class: "cm-vis-remote", attributes: { style: `--vis-remote: ${user.color}`, title: user.name } }).range(construct.from, construct.to));
    }
    const next = ranges.length ? Decoration.set(ranges, true) : Decoration.none;
    const current = this.view.state.field(remoteOutlineField, false);
    if (current && current.size === 0 && next.size === 0) return;
    this.view.dispatch({ effects: setRemoteOutlines.of(next) });
  }
  destroy() { if (this.listener && this.awareness) this.awareness.off("change", this.listener); }
});

export const remoteOutlines = [remoteOutlineField, remoteOutlinePlugin];
