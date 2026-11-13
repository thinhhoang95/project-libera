import { EMPTY_AUX } from "../../aux-file";
import { conditionalFactsKey, type LatexDefinitions, type LatexMacro } from "../../macros/definitions";
import { EMPTY_NUMBERING } from "../../macros/numbering";
import { macroPassThrough } from "../../macros/structure";
import { renderLatexFragment } from "./render-fragment";

/* Transparent arguments (docs/latex-visual-editor-plan.md §7.5): when a text
 * macro's body uses each parameter once, in order, in text, as in
 * `\newcommand{\todo}[1]{\textcolor{red}{[[#1]]}}`, a use is drawn without a
 * widget over its arguments. The body's fixed parts ("[[", "]]") are small
 * widgets, and each argument stays editable text with the body's styling
 * (red). */

export type TransparentPlan = {
  /** Rendered fixed parts: before the first argument, between arguments, after the last. */
  pieces: string[];
  /** Styling of each argument: classes and an inline style. */
  marks: Array<{ class: string; style: string }>;
};

const cache = new Map<string, TransparentPlan | null>();

/* What the plans depend on in the definitions (their fingerprint and what conditionals read: a string listing every
 * macro) as a short number: equal for equal strings, found once per definitions object. The numbers are dropped with
 * the plans that carry them. */
let interned = new Map<string, number>();
let internedOf = new WeakMap<LatexDefinitions, number>();
let internedCount = 0;
function definitionsId(defs: LatexDefinitions) {
  let id = internedOf.get(defs);
  if (id !== undefined) return id;
  if (interned.size >= 1000) { interned = new Map(); internedOf = new WeakMap(); cache.clear(); }
  const suffix = `${defs.fingerprint}\u0000${conditionalFactsKey(defs)}`;
  id = interned.get(suffix);
  if (id === undefined) interned.set(suffix, id = ++internedCount);
  internedOf.set(defs, id);
  return id;
}
const PLACEHOLDER = (n: number) => `⁣${n}⁣`;

function placeholderNodes(root: Node, count: number) {
  const found: Array<{ node: Text; index: number } | null> = Array.from({ length: count }, () => null);
  const walker = document.createTreeWalker(root, 4);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let n = 1; n <= count; n++) {
      const index = node.data.indexOf(PLACEHOLDER(n));
      if (index >= 0) found[n - 1] = { node, index };
    }
  }
  return found;
}

/** Classes and styles of the elements around a placeholder, as one mark. */
function styleAround(node: Node, root: Node) {
  const classes: string[] = [];
  const styles: string[] = [];
  for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
    const tag = element.tagName;
    if (element.closest(".cm-vis-fragment-math, .cm-vis-raw, .cm-vis-chip")) return null;
    if (tag === "STRONG") classes.push("cm-vis-b");
    else if (tag === "EM") classes.push("cm-vis-em");
    else if (tag === "U") classes.push("cm-vis-u");
    else if (tag === "S") classes.push("cm-vis-s");
    else if (tag === "SUP") classes.push("cm-vis-sup");
    else if (tag === "SUB") classes.push("cm-vis-sub");
    else if (tag === "CODE") classes.push("cm-vis-tt");
    else if (element.classList.contains("cm-vis-sc")) classes.push("cm-vis-sc");
    else if (element.classList.contains("cm-vis-sf")) classes.push("cm-vis-sf");
    else if (element.classList.contains("cm-vis-link")) classes.push("cm-vis-link");
    if (element.style.color) styles.push(`color: ${element.style.color}`);
    if (element.style.backgroundColor) styles.push(`background-color: ${element.style.backgroundColor}`);
  }
  return { class: ["cm-vis-macro-arg", ...classes].join(" "), style: styles.join("; ") };
}

/** How to draw a macro's uses with editable arguments, or null when it cannot be. */
export function transparentPlan(macro: LatexMacro, defs: LatexDefinitions): TransparentPlan | null {
  if (macro.arity < 1 || macro.arity > 4 || macro.optional !== undefined || macro.spec || macro.mathOnly || macro.unsupported) return null;
  // The plan renders the body, with the macros it uses: it depends on all the definitions, not only this one.
  const key = `${macro.fingerprint}\u0000${definitionsId(defs)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  // A macro that passes its argument on unchanged (`\rev{…}`, a version switch that is on) draws only the argument.
  const plan = macroPassThrough(macro, defs) === "identity" ? { pieces: ["", ""], marks: [{ class: "cm-vis-macro-arg", style: "" }] } : computePlan(macro, defs);
  cache.set(key, plan);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return plan;
}

function computePlan(macro: LatexMacro, defs: LatexDefinitions): TransparentPlan | null {
  if (typeof document === "undefined") return null;
  // Each parameter exactly once, in order: the arguments then read in the order they are written.
  const order = [...macro.body.matchAll(/##|#([1-9])/g)].filter((match) => match[1]).map((match) => Number(match[1]));
  if (order.length !== macro.arity || order.some((n, index) => n !== index + 1)) return null;
  const substituted = macro.body.replace(/##|#([1-9])/g, (whole, n: string | undefined) => (n ? PLACEHOLDER(Number(n)) : "#"));
  const container = document.createElement("span");
  container.append(renderLatexFragment(substituted, { defs, numbering: EMPTY_NUMBERING, aux: EMPTY_AUX, bib: () => null }));
  // Fixed parts that show numbers or citations would be drawn once, against no numbering: such a macro is drawn whole (MacroWidget refreshes).
  if (container.querySelector(".cm-vis-chip")) return null;
  const found = placeholderNodes(container, macro.arity);
  if (found.some((item) => !item)) return null;
  const marks: TransparentPlan["marks"] = [];
  for (const item of found) {
    const style = styleAround(item!.node, container);
    if (!style) return null;
    marks.push(style);
  }
  const pieces: string[] = [];
  for (let piece = 0; piece <= macro.arity; piece++) {
    const copy = container.cloneNode(true) as HTMLElement;
    const nodes = placeholderNodes(copy, macro.arity);
    const range = document.createRange();
    // Keep what is between the previous placeholder's end and the next one's start.
    if (piece < macro.arity) {
      const next = nodes[piece]!;
      range.setStart(next.node, next.index);
      range.setEndAfter(copy.lastChild!);
      range.deleteContents();
    }
    if (piece > 0) {
      const previous = placeholderNodes(copy, macro.arity)[piece - 1]!;
      const before = document.createRange();
      before.setStartBefore(copy.firstChild!);
      before.setEnd(previous.node, previous.index + PLACEHOLDER(piece).length);
      before.deleteContents();
    }
    pieces.push(copy.innerHTML);
  }
  return { pieces, marks };
}

/** The `{…}` arguments of a use, as absolute ranges of their braces; null when one is not a group. */
export function argumentGroups(text: string, offset: number, start: number, count: number) {
  const groups: Array<{ open: number; close: number }> = [];
  let index = start;
  for (let n = 0; n < count; n++) {
    while (text[index] === " " || text[index] === "\t") index++;
    if (text[index] !== "{") return null;
    let depth = 0;
    let close = -1;
    for (let i = index; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      // A comment can hide a brace; such an argument is not drawn transparently.
      if (text[i] === "%") return null;
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) { close = i; break; }
      else if (text[i] === "\n" && text[i + 1] === "\n") return null;
    }
    if (close < 0) return null;
    groups.push({ open: offset + index, close: offset + close });
    index = close + 1;
  }
  return groups;
}
