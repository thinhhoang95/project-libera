import { Extension } from "@tiptap/core";
import { DOMSerializer, Fragment, Mark, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import katex from "katex";
import { markdownAssetSource } from "./tiptap-markdown";

export type ChangeSource = "rewrite" | "write" | "format" | "image" | "review";
export type ChangeDecision = "accept" | "reject";
type Range = { from: number; to: number };
/** One aligned difference between two node lists. Block hunks cover whole
 * sibling nodes; inline hunks cover part of a paired textblock's content. */
export type ChangeHunk = { a: Range; b: Range; aContent: Fragment; bContent: Fragment; block: boolean };
/** A proposed change shown inline, Cursor style.
 * - "applied": the proposal is already in the document; `other` holds the
 *   original, restored on reject (AI Rewrite / Format).
 * - "preview": the original stays in the document; `other` holds the proposal
 *   for display only, and its owner applies it on accept (Agentic Review). */
export type TrackedChange = {
  id: string; group: string; source: ChangeSource; label?: string;
  mode: "applied" | "preview"; block: boolean;
  from: number; to: number; other: Fragment;
  showActions: boolean;
};
export type ChangeDecider = (groups: string[], decision: ChangeDecision) => void;
export type TiptapChangesState = { changes: TrackedChange[]; decide?: ChangeDecider; decorations: DecorationSet };
export type TiptapChangesMeta =
  | { type: "track"; source: ChangeSource }
  | { type: "resolve"; ids: string[] }
  | { type: "preview"; changes: TrackedChange[]; decide?: ChangeDecider };

export const tiptapChangesKey = new PluginKey<TiptapChangesState>("liberaChanges");

// Containers whose children can be diffed (and rendered) individually. Tables
// and other structured nodes are compared as a whole.
const RECURSIVE_NODES = new Set(["bulletList", "orderedList", "listItem", "taskList", "taskItem", "blockquote"]);
// Below this share of unchanged text, a paragraph reads better as replaced.
const MIN_INLINE_SIMILARITY = 0.3;
const MAX_LCS_CELLS = 4_000_000;

function childNodes(node: ProseMirrorNode | Fragment, from = 0, to?: number) {
  const nodes: ProseMirrorNode[] = [];
  const fragment = node instanceof Fragment ? node : node.content;
  for (let index = from; index < (to ?? fragment.childCount); index++) nodes.push(fragment.child(index));
  return nodes;
}
const sizeOf = (nodes: readonly ProseMirrorNode[]) => nodes.reduce((size, node) => size + node.nodeSize, 0);

/** Index pairs of a longest common subsequence, or null when too large. */
function commonPairs<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean): [number, number][] | null {
  let start = 0;
  while (start < a.length && start < b.length && equal(a[start], b[start])) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && equal(a[endA - 1], b[endB - 1])) { endA--; endB--; }
  const n = endA - start, m = endB - start, width = m + 1;
  if (n * m > MAX_LCS_CELLS) return null;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = equal(a[start + i], b[start + j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (equal(a[start + i], b[start + j])) pairs.push([start + i++, start + j++]);
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

type Token = { key: string; size: number };
function inlineTokens(fragment: Fragment) {
  const tokens: Token[] = [];
  fragment.forEach((node) => {
    const marks = node.marks.map((mark) => mark.type.name + JSON.stringify(mark.attrs)).join("|");
    if (node.isText) {
      for (const chunk of node.text!.match(/\s+|[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu) ?? []) tokens.push({ key: `${marks}\u0000${chunk}`, size: chunk.length });
    } else tokens.push({ key: `${marks}\u0001${node.type.name}${JSON.stringify(node.attrs)}`, size: node.nodeSize });
  });
  return tokens;
}

type Run = { equal: boolean; aFrom: number; aTo: number; bFrom: number; bTo: number };
// Semantic cleanup (after diff-match-patch): fold an unchanged run into its
// neighbours when it is no longer than the edits on both sides, so a rewrite
// shows as readable phrases rather than alternating single words.
function mergeShortEqualities(runs: Run[]) {
  const span = (run: Run) => Math.max(run.aTo - run.aFrom, run.bTo - run.bFrom);
  for (let index = 1; index + 1 < runs.length;) {
    const previous = runs[index - 1], run = runs[index], next = runs[index + 1];
    if (run.equal && !previous.equal && !next.equal && run.aTo - run.aFrom <= span(previous) && run.aTo - run.aFrom <= span(next)) {
      runs.splice(index - 1, 3, { equal: false, aFrom: previous.aFrom, aTo: next.aTo, bFrom: previous.bFrom, bTo: next.bTo });
      index = Math.max(1, index - 2);
    } else index++;
  }
}

function diffInline(a: Fragment, aStart: number, b: Fragment, bStart: number): ChangeHunk[] | null {
  const aTokens = inlineTokens(a), bTokens = inlineTokens(b);
  const pairs = commonPairs(aTokens.map((token) => token.key), bTokens.map((token) => token.key), (x, y) => x === y);
  if (!pairs) return null;
  const offsets = (tokens: Token[]) => tokens.reduce((list, token) => { list.push(list.at(-1)! + token.size); return list; }, [0]);
  const aOffsets = offsets(aTokens), bOffsets = offsets(bTokens);
  const runs: Run[] = [];
  const push = (run: Run) => {
    const last = runs.at(-1);
    if (last?.equal === run.equal) { last.aTo = run.aTo; last.bTo = run.bTo; } else runs.push(run);
  };
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [aTokens.length, bTokens.length]]) {
    if (pi > i || pj > j) push({ equal: false, aFrom: aOffsets[i], aTo: aOffsets[pi], bFrom: bOffsets[j], bTo: bOffsets[pj] });
    if (pi < aTokens.length) push({ equal: true, aFrom: aOffsets[pi], aTo: aOffsets[pi + 1], bFrom: bOffsets[pj], bTo: bOffsets[pj + 1] });
    i = pi + 1; j = pj + 1;
  }
  mergeShortEqualities(runs);
  const unchanged = runs.reduce((total, run) => run.equal ? total + run.aTo - run.aFrom : total, 0);
  if (unchanged < MIN_INLINE_SIMILARITY * Math.max(a.size, b.size)) return null;
  return runs.filter((run) => !run.equal).map((run) => ({
    a: { from: aStart + run.aFrom, to: aStart + run.aTo }, b: { from: bStart + run.bFrom, to: bStart + run.bTo },
    aContent: a.cut(run.aFrom, run.aTo), bContent: b.cut(run.bFrom, run.bTo), block: false,
  }));
}

function blockHunk(a: readonly ProseMirrorNode[], aPos: number, b: readonly ProseMirrorNode[], bPos: number): ChangeHunk {
  return {
    a: { from: aPos, to: aPos + sizeOf(a) }, b: { from: bPos, to: bPos + sizeOf(b) },
    aContent: Fragment.fromArray([...a]), bContent: Fragment.fromArray([...b]), block: true,
  };
}

function refinePair(a: ProseMirrorNode, aPos: number, b: ProseMirrorNode, bPos: number): ChangeHunk[] | null {
  if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks) || JSON.stringify(a.attrs) !== JSON.stringify(b.attrs)) return null;
  if (a.isTextblock) return diffInline(a.content, aPos + 1, b.content, bPos + 1);
  if (RECURSIVE_NODES.has(a.type.name)) return diffNodes(childNodes(a), aPos + 1, childNodes(b), bPos + 1);
  return null;
}

// Pair compatible nodes from both ends of an unmatched run; whatever remains
// in the middle is one block replacement, accepted or rejected as a unit.
function diffRun(a: ProseMirrorNode[], aPos: number, b: ProseMirrorNode[], bPos: number, out: ChangeHunk[]) {
  const head: ChangeHunk[] = [], tail: ChangeHunk[] = [];
  let low = 0;
  while (low < a.length && low < b.length) {
    const refined = refinePair(a[low], aPos, b[low], bPos);
    if (!refined) break;
    head.push(...refined);
    aPos += a[low].nodeSize; bPos += b[low].nodeSize; low++;
  }
  let aEnd = a.length, bEnd = b.length;
  let aEndPos = aPos + sizeOf(a.slice(low)), bEndPos = bPos + sizeOf(b.slice(low));
  while (aEnd > low && bEnd > low) {
    const aNode = a[aEnd - 1], bNode = b[bEnd - 1];
    const refined = refinePair(aNode, aEndPos - aNode.nodeSize, bNode, bEndPos - bNode.nodeSize);
    if (!refined) break;
    tail.unshift(...refined);
    aEnd--; bEnd--; aEndPos -= aNode.nodeSize; bEndPos -= bNode.nodeSize;
  }
  out.push(...head);
  if (aEnd > low || bEnd > low) out.push(blockHunk(a.slice(low, aEnd), aPos, b.slice(low, bEnd), bPos));
  out.push(...tail);
}

/** Diff two sibling node lists starting at the given document positions. */
export function diffNodes(a: readonly ProseMirrorNode[], aStart: number, b: readonly ProseMirrorNode[], bStart: number): ChangeHunk[] {
  const pairs = commonPairs(a, b, (x, y) => x.eq(y)) ?? [];
  const hunks: ChangeHunk[] = [];
  let i = 0, j = 0, aPos = aStart, bPos = bStart;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    const aGap = a.slice(i, pi), bGap = b.slice(j, pj);
    if (aGap.length || bGap.length) diffRun(aGap, aPos, bGap, bPos, hunks);
    aPos += sizeOf(aGap) + (pi < a.length ? a[pi].nodeSize : 0);
    bPos += sizeOf(bGap) + (pj < b.length ? b[pj].nodeSize : 0);
    i = pi + 1; j = pj + 1;
  }
  return hunks;
}

/** Diff two documents, limited to the top-level blocks that differ. */
export function diffDocuments(before: ProseMirrorNode, after: ProseMirrorNode): ChangeHunk[] {
  const start = before.content.findDiffStart(after.content);
  if (start === null) return [];
  let { a: endA, b: endB } = before.content.findDiffEnd(after.content)!;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) { endA += overlap; endB += overlap; }
  // Index of the child containing (or starting at) pos, and that child's offset.
  const locate = (fragment: Fragment, pos: number) => {
    let index = 0, offset = 0;
    while (index < fragment.childCount && offset + fragment.child(index).nodeSize <= pos) offset += fragment.child(index++).nodeSize;
    return { index, offset };
  };
  const { index: first, offset } = locate(before.content, start);
  const childEnd = (fragment: Fragment, pos: number) => {
    const found = locate(fragment, Math.min(pos, fragment.size));
    return Math.max(first, found.offset === pos ? found.index : found.index + 1);
  };
  const lastA = childEnd(before.content, endA), lastB = childEnd(after.content, endB);
  return diffNodes(childNodes(before, first, lastA), offset, childNodes(after, first, lastB), offset);
}

let nextChangeId = 0;
function trackChanges(before: ProseMirrorNode, after: ProseMirrorNode, source: ChangeSource): TrackedChange[] {
  return diffDocuments(before, after).map((hunk) => {
    const id = `${source}-${++nextChangeId}`;
    return { id, group: id, source, mode: "applied", block: hunk.block, from: hunk.b.from, to: hunk.b.to, other: hunk.aContent, showActions: true };
  });
}

// Keep changes anchored through unrelated edits. Editing inside a change (or
// replacing the document) settles it: the user has taken ownership of the text.
function mapChanges(changes: TrackedChange[], tr: Transaction) {
  if (!changes.length) return changes;
  return changes.flatMap((change) => {
    let { from, to } = change;
    for (const map of tr.mapping.maps) {
      let touched = false;
      map.forEach((start, end) => { if (from === to ? start < from && end > from : start < to && end > from) touched = true; });
      if (touched) return [];
      const empty = from === to;
      from = map.map(from, 1);
      to = empty ? from : Math.max(from, map.map(to, -1));
    }
    return [{ ...change, from, to }];
  });
}

/** Decision units: applied hunks individually, previews per suggestion. */
export function tiptapChangeUnits(changes: readonly TrackedChange[]) {
  const units = new Map<string, { group: string; ids: string[]; from: number; source: ChangeSource; label?: string }>();
  for (const change of changes) {
    const unit = units.get(change.group);
    if (unit) { unit.ids.push(change.id); unit.from = Math.min(unit.from, change.from); }
    else units.set(change.group, { group: change.group, ids: [change.id], from: change.from, source: change.source, label: change.label });
  }
  return [...units.values()].sort((a, b) => a.from - b.from);
}

/** Accept or reject changes by id. Applied changes are settled here; preview
 * suggestions are forwarded to their owner as whole groups. */
export function decideTiptapChanges(view: EditorView, ids: readonly string[] | "all", decision: ChangeDecision) {
  const state = tiptapChangesKey.getState(view.state);
  const chosen = state?.changes.filter((change) => ids === "all" || ids.includes(change.id)) ?? [];
  if (!chosen.length) return false;
  const applied = chosen.filter((change) => change.mode === "applied");
  if (applied.length) {
    const tr = view.state.tr.setMeta(tiptapChangesKey, { type: "resolve", ids: applied.map((change) => change.id) } satisfies TiptapChangesMeta);
    if (decision === "reject") {
      closeHistory(tr);
      // Restore from the end so earlier positions stay valid.
      for (const change of [...applied].sort((a, b) => b.from - a.from)) tr.replace(change.from, change.to, new Slice(change.other, 0, 0));
    } else tr.setMeta("addToHistory", false);
    view.dispatch(tr);
  }
  const groups = [...new Set(chosen.filter((change) => change.mode === "preview").map((change) => change.group))];
  if (groups.length) state!.decide?.(groups, decision);
  return true;
}

const ICONS = { accept: ["M20 6 9 17l-5-5"], reject: ["M18 6 6 18", "m6 6 12 12"] };
function icon(paths: string[]) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// Serialized nodes lack their node views: render math and resolve image assets.
function enhance(root: HTMLElement, documentPath: string) {
  const within = (selector: string) => [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll<HTMLElement>(selector)];
  for (const element of within("[data-latex]")) {
    try { katex.render(element.dataset.latex ?? "", element, { displayMode: element.dataset.type === "block-math", throwOnError: false }); }
    catch { element.textContent = element.dataset.latex ?? ""; }
  }
  for (const image of within("img") as HTMLImageElement[]) image.src = markdownAssetSource(documentPath, image.getAttribute("src") ?? "");
  return root;
}

function contentWidget(pos: number, side: number, key: string, className: string, build: (serializer: DOMSerializer) => Node, documentPath: string) {
  return Decoration.widget(pos, (view) => {
    const serializer = DOMSerializer.fromSchema(view.state.schema);
    let root = build(serializer);
    if (!(root instanceof HTMLElement)) {
      const wrapper = document.createElement("span");
      wrapper.append(root);
      root = wrapper;
    }
    const element = root as HTMLElement;
    element.classList.add("libera-change", "libera-change-widget", ...className.split(" "));
    element.contentEditable = "false";
    element.setAttribute("aria-label", className.includes("deleted") ? "Original text" : "Proposed text");
    return enhance(element, documentPath);
  }, { side, key, marks: [], ignoreSelection: true, stopEvent: () => true });
}

function actionsWidget(change: TrackedChange, ids: string[]) {
  return Decoration.widget(change.to, (view) => {
    const root = document.createElement(change.block ? "div" : "span");
    root.className = `libera-change-actions${change.block ? " libera-change-actions-block" : ""}`;
    root.contentEditable = "false";
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", change.label ? `${change.label} actions` : "Proposed change actions");
    if (change.label) {
      const label = document.createElement("span");
      label.className = "libera-change-actions-label";
      label.textContent = change.label;
      root.append(label);
    }
    for (const decision of ["reject", "accept"] as const) {
      const button = document.createElement("button");
      const title = decision === "accept" ? "Accept change" : "Reject change";
      button.type = "button";
      button.title = title;
      button.dataset.decision = decision;
      button.setAttribute("aria-label", title);
      button.append(icon(ICONS[decision]));
      if (change.block) button.append(decision === "accept" ? "Accept" : "Reject");
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => { event.preventDefault(); decideTiptapChanges(view, ids, decision); });
      root.append(button);
    }
    return root;
  }, { side: 1000, key: `${change.id}:actions:${change.label ?? ""}:${ids.length}`, marks: [], ignoreSelection: true, stopEvent: () => true });
}

function changeDecorations(doc: ProseMirrorNode, changes: TrackedChange[], documentPath: string) {
  const groups = new Map(tiptapChangeUnits(changes).map((unit) => [unit.group, unit.ids]));
  const decorations: Decoration[] = [];
  for (const change of changes) {
    const inDocument = change.mode === "applied" ? "inserted" : "deleted";
    const shown = change.mode === "applied" ? "deleted" : "inserted";
    if (change.from < change.to) {
      if (change.block) {
        for (let pos = change.from; pos < change.to;) {
          const node = doc.nodeAt(pos);
          if (!node) break;
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `libera-change libera-change-${inDocument}-block` }));
          pos += node.nodeSize;
        }
      } else decorations.push(Decoration.inline(change.from, change.to, { class: `libera-change libera-change-${inDocument}` }));
    }
    if (change.other.size) {
      // Originals precede the proposal they were replaced by; previewed
      // proposals follow the original passage they would replace.
      const pos = change.mode === "applied" ? change.from : change.to;
      const side = (index: number) => change.mode === "applied" ? -1000 + index : 1 + index;
      if (change.block) {
        childNodes(change.other).forEach((node, index) => decorations.push(contentWidget(pos, side(index), `${change.id}:${shown}:${index}`, `libera-change-${shown}-block`, (serializer) => serializer.serializeNode(node), documentPath)));
      } else decorations.push(contentWidget(pos, side(0), `${change.id}:${shown}`, `libera-change-${shown}`, (serializer) => serializer.serializeFragment(change.other), documentPath));
    }
    if (change.showActions) decorations.push(actionsWidget(change, groups.get(change.group) ?? [change.id]));
  }
  return DecorationSet.create(doc, decorations);
}

export const TiptapChanges = Extension.create<{ documentPath: string }>({
  name: "liberaChanges",
  addOptions: () => ({ documentPath: "" }),
  addProseMirrorPlugins() {
    const { documentPath } = this.options;
    return [new Plugin<TiptapChangesState>({
      key: tiptapChangesKey,
      state: {
        init: () => ({ changes: [], decorations: DecorationSet.empty }),
        apply(tr, value, oldState, newState) {
          const meta = tr.getMeta(tiptapChangesKey) as TiptapChangesMeta | undefined;
          let { changes, decide } = value;
          if (tr.docChanged) changes = mapChanges(changes, tr);
          if (meta?.type === "track") changes = [...changes, ...trackChanges(oldState.doc, newState.doc, meta.source)];
          else if (meta?.type === "resolve") changes = changes.filter((change) => !meta.ids.includes(change.id));
          else if (meta?.type === "preview") {
            const size = newState.doc.content.size;
            changes = [...changes.filter((change) => change.mode !== "preview"), ...meta.changes.filter((change) => change.from >= 0 && change.from <= change.to && change.to <= size)];
            decide = meta.decide;
          }
          if (changes === value.changes && decide === value.decide) return value;
          changes = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
          return { changes, decide, decorations: changes.length ? changeDecorations(newState.doc, changes, documentPath) : DecorationSet.empty };
        },
      },
      props: {
        decorations: (state) => tiptapChangesKey.getState(state)?.decorations,
        handleKeyDown(view, event) {
          if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return false;
          if (event.key === "Enter") return decideTiptapChanges(view, "all", "accept");
          if (event.key === "Backspace") return decideTiptapChanges(view, "all", "reject");
          return false;
        },
      },
    })];
  },
});
