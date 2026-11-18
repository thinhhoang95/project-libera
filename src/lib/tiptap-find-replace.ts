import { createNodeFromContent, type Editor } from "@tiptap/core";
import { Fragment, type Mark, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import type { Finder, Replacer } from "./find";
import { tiptapMarkdownInsertionContent } from "./tiptap-editor-actions";
import {
  DEFAULT_TIPTAP_FIND_READING,
  findTiptapTextMatches,
  readingPosition,
  tiptapFindMatchRun,
  tiptapFindPluginKey,
  type TiptapFindMatch,
  type TiptapFindRange,
  type TiptapReadingRun,
} from "./tiptap-find";

/* Replace in the rich editor (docs/find-replace-patterns-plan.md §10). Every
 * match is replaced one of three ways:
 *  - inside one math atom's LaTeX: the atom's `latex` attribute is rewritten;
 *  - covering whole math atoms, or with "Replacement is Markdown": the rendered
 *    replacement is parsed as Markdown (so `\(*\)` → `\[@1\]` makes display math);
 *  - otherwise from the replacement's pieces: literal text takes the marks at
 *    the match start, captures are copied from the document with their marks.
 * Replace All is one transaction and one undo step. The work happens on a
 * transaction, so several find/replace pairs can run in sequence as one edit. */

export type TiptapReplaceOptions = {
  replacer: Replacer;
  /** Interpret the replacement as Markdown. */
  markdown?: boolean;
  /** The `@#` number of the first match (1 for Replace All, the active match's number for Replace). */
  firstCounter?: number;
};

export type TiptapReplaceResult = {
  replaced: number;
  /** Matches whose replacement could not be computed (arithmetic on a non-number). */
  skipped: number;
  /** Where the last replaced match ends in the new document, or null when nothing changed. */
  end: number | null;
};

type Plan =
  | { kind: "latex"; match: TiptapFindMatch; start: number; end: number; text: string }
  | { kind: "fragment"; match: TiptapFindMatch; fragment: Fragment };

function marksAt(doc: ProseMirrorNode, position: number): readonly Mark[] {
  const node = doc.nodeAt(position);
  return node?.isText ? node.marks : doc.resolve(position).marks();
}

function coversMath(run: TiptapReadingRun, match: TiptapFindMatch) {
  const { start, end } = match.reading;
  return run.pieces.some((piece) => piece.kind === "math" && piece.start < end && piece.end > start);
}

function piecesFragment(doc: ProseMirrorNode, run: TiptapReadingRun, match: TiptapFindMatch, replacer: Replacer, counter: number) {
  const pieces = replacer.pieces(run.text, match.reading, counter);
  if (!Array.isArray(pieces)) return null;
  const schema = doc.type.schema;
  const marks = marksAt(doc, match.from);
  const nodes: ProseMirrorNode[] = [];
  for (const piece of pieces) {
    if (piece.kind === "text") {
      if (piece.text) nodes.push(schema.text(piece.text, marks));
      continue;
    }
    if (piece.end <= piece.start) continue;
    const from = match.unit + readingPosition(run, piece.start, false);
    const to = match.unit + readingPosition(run, piece.end, true);
    if (to > from) doc.slice(from, to).content.forEach((node) => { nodes.push(node); });
  }
  return Fragment.fromArray(nodes);
}

/** The rendered replacement as document content: parsed Markdown, or the text itself without a parser. */
function markdownFragment(editor: Editor, doc: ProseMirrorNode, match: TiptapFindMatch, rendered: string) {
  if (!rendered) return Fragment.empty;
  const content = tiptapMarkdownInsertionContent(editor, match, rendered, doc);
  const schema = doc.type.schema;
  if (!content) return Fragment.from(schema.text(rendered, marksAt(doc, match.from)));
  const created = createNodeFromContent(content, schema);
  const fragment = created instanceof Fragment ? created : Fragment.from(created);
  // Plain text keeps the formatting around it, as typing would.
  let plain = fragment.childCount > 0;
  fragment.forEach((node) => { if (!node.isText || node.marks.length) plain = false; });
  return plain ? Fragment.from(schema.text(fragment.textBetween(0, fragment.size), marksAt(doc, match.from))) : fragment;
}

/**
 * Replaces matches of `tr.doc` (in document order) by adding steps to `tr`.
 * The caller dispatches; the matches must have been found in `tr.doc`.
 */
export function replaceTiptapFindMatchesInTransaction(editor: Editor, tr: Transaction, matches: TiptapFindMatch[], options: TiptapReplaceOptions): TiptapReplaceResult {
  const { replacer, markdown = false, firstCounter = 1 } = options;
  const doc = tr.doc;
  const reading = tiptapFindPluginKey.getState(editor.state)?.reading ?? DEFAULT_TIPTAP_FIND_READING;
  const plans: Plan[] = [];
  let skipped = 0;
  matches.forEach((match, index) => {
    const counter = firstCounter + index;
    const run = tiptapFindMatchRun(doc, match, reading);
    if (!run) { skipped++; return; }
    if (match.insideMath) {
      const rendered = replacer.render(run.text, match.reading, counter);
      if (typeof rendered !== "string") { skipped++; return; }
      const atom = run.pieces.find((piece) => piece.kind === "math" && piece.start <= match.reading.start && piece.end >= match.reading.end)!;
      plans.push({ kind: "latex", match, start: match.reading.start - atom.contentStart, end: match.reading.end - atom.contentStart, text: rendered });
      return;
    }
    if (markdown || coversMath(run, match)) {
      const rendered = replacer.render(run.text, match.reading, counter);
      if (typeof rendered !== "string") { skipped++; return; }
      plans.push({ kind: "fragment", match, fragment: markdownFragment(editor, doc, match, rendered) });
      return;
    }
    const fragment = piecesFragment(doc, run, match, replacer, counter);
    if (!fragment) { skipped++; return; }
    plans.push({ kind: "fragment", match, fragment });
  });
  if (!plans.length) return { replaced: 0, skipped, end: null };

  const mapping = tr.mapping.maps.length;
  // Back to front, so the positions of the matches still to replace stay valid.
  for (const plan of plans.toReversed()) {
    const { from, to } = plan.match;
    if (plan.kind === "fragment") {
      if (plan.fragment.size) tr.replaceWith(from, to, plan.fragment);
      else tr.delete(from, to);
      continue;
    }
    // Earlier matches in the same atom come later here, so their offsets still hold.
    const node = tr.doc.nodeAt(from);
    if (!node) continue;
    const latex = String(node.attrs.latex ?? "");
    tr.setNodeMarkup(from, undefined, { ...node.attrs, latex: latex.slice(0, plan.start) + plan.text + latex.slice(plan.end) });
  }
  const end = tr.mapping.slice(mapping).map(plans.at(-1)!.match.to, 1);
  return { replaced: plans.length, skipped, end };
}

/** Finds every match of `finder` in `tr.doc` and replaces them in `tr`; call again with another pair to chain a recipe. */
export function replaceAllTiptapFindInTransaction(
  editor: Editor,
  tr: Transaction,
  finder: Finder,
  options: TiptapReplaceOptions & { within?: TiptapFindRange[] | null },
): TiptapReplaceResult {
  const reading = tiptapFindPluginKey.getState(editor.state)?.reading ?? DEFAULT_TIPTAP_FIND_READING;
  const matches = findTiptapTextMatches(tr.doc, finder, { reading, within: options.within ?? null });
  return replaceTiptapFindMatchesInTransaction(editor, tr, matches, options);
}

/** Replaces the given matches of the current document as one undo step. */
export function replaceTiptapFindMatches(editor: Editor, matches: TiptapFindMatch[], options: TiptapReplaceOptions): TiptapReplaceResult {
  const tr = closeHistory(editor.state.tr);
  const result = replaceTiptapFindMatchesInTransaction(editor, tr, matches, options);
  if (!tr.docChanged) return result;
  tr.setMeta(tiptapFindPluginKey, { activeMatchIndex: 0 });
  editor.view.dispatch(tr);
  return result;
}
