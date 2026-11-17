import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findTextMatches, type TextFindOptions } from "./text-find";

export type TiptapFindMatch = { from: number; to: number };

export type TiptapFindState = {
  activeMatchIndex: number;
  decorations: DecorationSet;
  matches: TiptapFindMatch[];
  query: string;
  wildcards: boolean;
};

type TiptapFindUpdate = {
  activeMatchIndex?: number;
  query?: string;
  wildcards?: boolean;
};

export const tiptapFindPluginKey = new PluginKey<TiptapFindState>("liberaTiptapFind");

// A few active queries may share immutable ProseMirror blocks. Cache relative
// matches so moving/editing another block never searches unchanged text again.
const blockSearches = new Map<string, WeakMap<ProseMirrorNode, TiptapFindMatch[]>>();

function blockSearchCache(query: string, options: TextFindOptions) {
  const cacheKey = `${options.wildcards ? 1 : 0}:${query}`;
  let cache = blockSearches.get(cacheKey);
  if (!cache) {
    cache = new WeakMap();
    blockSearches.set(cacheKey, cache);
    if (blockSearches.size > 4) blockSearches.delete(blockSearches.keys().next().value!);
  }
  return cache;
}

/** Work counters for tests: text blocks visited and decorations created by the incremental path. */
export const tiptapFindWork = { incremental: 0, fallback: 0, blocksVisited: 0, decorationsCreated: 0 };

// Appends the matches of one text block, in document positions.
function searchTextblock(
  node: ProseMirrorNode,
  position: number,
  cache: WeakMap<ProseMirrorNode, TiptapFindMatch[]>,
  query: string,
  options: TextFindOptions,
  matches: TiptapFindMatch[],
) {
  tiptapFindWork.blocksVisited++;
  const cached = cache.get(node);
  if (cached) {
    for (const match of cached) matches.push({ from: position + 1 + match.from, to: position + 1 + match.to });
    return;
  }
  const relative: TiptapFindMatch[] = [];
  // A run of text and of atoms that read as text (`leafText`, e.g. a
  // citation's source token). A match inside such an atom covers the atom.
  let runText = "";
  let pieces: { text: number; length: number; position: number; size: number; atom: boolean }[] = [];
  const positionAt = (offset: number, end: boolean) => {
    const piece = pieces.find((candidate) => end
      ? offset > candidate.text && offset <= candidate.text + candidate.length
      : offset >= candidate.text && offset < candidate.text + candidate.length) ?? pieces.at(-1)!;
    if (piece.atom) return end ? piece.position + piece.size : piece.position;
    return piece.position + offset - piece.text;
  };
  const flushRun = () => {
    if (runText) {
      relative.push(...findTextMatches(runText, query, options).map((match) => ({
        from: positionAt(match.start, false),
        to: positionAt(match.end, true),
      })));
    }
    pieces = [];
    runText = "";
  };

  node.descendants((child, childPosition) => {
    const leafText = child.isText ? child.text ?? "" : child.isLeaf ? child.type.spec.leafText?.(child) : undefined;
    if (leafText !== undefined && leafText !== "") {
      pieces.push({ text: runText.length, length: leafText.length, position: childPosition, size: child.nodeSize, atom: !child.isText });
      runText += leafText;
    } else if (child.isLeaf) {
      flushRun();
    }
  });
  flushRun();
  cache.set(node, relative);
  for (const match of relative) matches.push({ from: position + 1 + match.from, to: position + 1 + match.to });
}

export function findTiptapTextMatches(
  doc: ProseMirrorNode,
  query: string,
  options: TextFindOptions = {},
) {
  if (!query) return [];

  const cache = blockSearchCache(query, options);
  const matches: TiptapFindMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    searchTextblock(node, position, cache, query, options, matches);
    // This text block has been searched; do not visit its inline children again.
    return false;
  });

  return matches;
}

/** The text blocks overlapping `from..to`, searched like `findTiptapTextMatches`. */
function findTiptapTextMatchesBetween(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  query: string,
  options: TextFindOptions,
) {
  const cache = blockSearchCache(query, options);
  const matches: TiptapFindMatch[] = [];
  doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return;
    searchTextblock(node, position, cache, query, options, matches);
    return false;
  });
  return matches;
}

/** The full rebuild; the incremental path below must always agree with it. */
export function createFindState(doc: ProseMirrorNode, query: string, requestedIndex = 0, wildcards = false): TiptapFindState {
  const matches = findTiptapTextMatches(doc, query, { wildcards });
  const activeMatchIndex = matches.length
    ? (requestedIndex + matches.length) % matches.length
    : 0;
  const decorations = DecorationSet.create(doc, matches.map((match, index) =>
    Decoration.inline(match.from, match.to, {
      class: index === activeMatchIndex
        ? "markdown-editor-find-match markdown-editor-find-match-active"
        : "markdown-editor-find-match",
    }),
  ));

  return { activeMatchIndex, decorations, matches, query, wildcards };
}

const MATCH_CLASS = "markdown-editor-find-match";
const ACTIVE_MATCH_CLASS = "markdown-editor-find-match markdown-editor-find-match-active";

// Smallest range of the new document that contains every change of the
// transaction. Outside it the content is unchanged, so text shifts by a
// constant. Null when a step changes content without a position range
// (marks, node attributes), which can alter what an atom reads as.
function changedRange(tr: Transaction) {
  const maps = tr.mapping.maps;
  let from = Infinity, to = -Infinity;
  for (let index = 0; index < maps.length; index++) {
    const rest = tr.mapping.slice(index + 1);
    let empty = true;
    maps[index].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      empty = false;
      from = Math.min(from, rest.map(newStart, -1));
      to = Math.max(to, rest.map(newEnd, 1));
    });
    if (empty) return null;
  }
  return maps.length ? { from, to } : null;
}

/**
 * The state after a document change, reusing the matches and decorations of
 * the text blocks the change did not touch. Returns null when it cannot prove
 * itself equal to `createFindState`, which the caller then runs instead.
 */
function updateFindState(previous: TiptapFindState, tr: Transaction, requestedIndex: number): TiptapFindState | null {
  const range = changedRange(tr);
  if (!range) return null;
  const doc = tr.doc;
  const delta = doc.content.size - tr.before.content.size;
  // Widen to whole text blocks, whose matches are searched as one unit.
  const textblockDepth = ($pos: ReturnType<ProseMirrorNode["resolve"]>) => {
    for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).isTextblock) return depth;
    return 0;
  };
  const $from = doc.resolve(Math.min(range.from, doc.content.size)), $to = doc.resolve(Math.min(range.to, doc.content.size));
  const fromDepth = textblockDepth($from), toDepth = textblockDepth($to);
  const from = fromDepth ? $from.before(fromDepth) : range.from;
  const to = toDepth ? $to.after(toDepth) : range.to;
  const oldTo = to - delta;
  if (from > range.to || oldTo < from || to > doc.content.size) return null;

  const { matches: oldMatches } = previous;
  // Matches are in document order, and a block never straddles `from` or `oldTo`.
  const firstFrom = (start: number, bound: number) => {
    let low = start, high = oldMatches.length;
    while (low < high) { const mid = (low + high) >> 1; if (oldMatches[mid].from < bound) low = mid + 1; else high = mid; }
    return low;
  };
  const first = firstFrom(0, from), last = firstFrom(first, oldTo);

  const stale = previous.decorations.find(from, oldTo);
  if (stale.length !== last - first) return null;

  const options = { wildcards: previous.wildcards };
  const middle = findTiptapTextMatchesBetween(doc, from, to, previous.query, options);
  const matches = [...oldMatches.slice(0, first), ...middle, ...oldMatches.slice(last).map((match) => ({ from: match.from + delta, to: match.to + delta }))];
  const activeMatchIndex = matches.length ? (requestedIndex + matches.length) % matches.length : 0;

  let decorations = previous.decorations.remove(stale).map(tr.mapping, doc);
  // Where each surviving match sits in the new array.
  const newIndex = (oldIndex: number) => oldIndex < first ? oldIndex : oldIndex >= last ? oldIndex - last + first + middle.length : -1;
  const wasActive = previous.matches.length ? newIndex(previous.activeMatchIndex) : -1;
  const restyle = (index: number, active: boolean) => {
    const match = matches[index];
    const found = decorations.find(match.from, match.to).filter((decoration) => decoration.from === match.from && decoration.to === match.to);
    if (found.length !== 1) return false;
    tiptapFindWork.decorationsCreated++;
    decorations = decorations.remove(found).add(doc, [Decoration.inline(match.from, match.to, { class: active ? ACTIVE_MATCH_CLASS : MATCH_CLASS })]);
    return true;
  };
  if (wasActive >= 0 && wasActive !== activeMatchIndex && !restyle(wasActive, false)) return null;
  const activeSurvived = matches.length > 0 && (activeMatchIndex < first || activeMatchIndex >= first + middle.length);
  if (activeSurvived && wasActive !== activeMatchIndex && !restyle(activeMatchIndex, true)) return null;
  if (middle.length) {
    tiptapFindWork.decorationsCreated += middle.length;
    decorations = decorations.add(doc, middle.map((match, offset) => Decoration.inline(match.from, match.to, {
      class: first + offset === activeMatchIndex ? ACTIVE_MATCH_CLASS : MATCH_CLASS,
    })));
  }
  return { activeMatchIndex, decorations, matches, query: previous.query, wildcards: previous.wildcards };
}

export const TiptapFind = Extension.create({
  name: "tiptapFind",
  addProseMirrorPlugins() {
    return [new Plugin<TiptapFindState>({
      key: tiptapFindPluginKey,
      state: {
        init: (_, state) => createFindState(state.doc, ""),
        apply: (transaction, previous) => {
          const update = transaction.getMeta(tiptapFindPluginKey) as TiptapFindUpdate | undefined;
          if (!transaction.docChanged && !update) return previous;
          // An inactive find has no positions to map. Keep the shared empty
          // snapshot instead of allocating a new state on every keystroke.
          if (!previous.query && !update) return previous;
          // Moving between existing matches never needs another document search.
          if (!transaction.docChanged && update &&
              (update.query === undefined || update.query === previous.query) &&
              (update.wildcards === undefined || update.wildcards === previous.wildcards)) {
            const count = previous.matches.length;
            const activeMatchIndex = count ? ((update.activeMatchIndex ?? previous.activeMatchIndex) % count + count) % count : 0;
            if (activeMatchIndex === previous.activeMatchIndex) return previous;
            const oldMatch = previous.matches[previous.activeMatchIndex];
            const nextMatch = previous.matches[activeMatchIndex];
            const remove = [oldMatch, nextMatch].flatMap((match) => previous.decorations.find(match.from, match.to)
              .filter((decoration) => decoration.from === match.from && decoration.to === match.to));
            const decorations = previous.decorations.remove(remove).add(transaction.doc, [
              Decoration.inline(oldMatch.from, oldMatch.to, { class: "markdown-editor-find-match" }),
              Decoration.inline(nextMatch.from, nextMatch.to, { class: "markdown-editor-find-match markdown-editor-find-match-active" }),
            ]);
            return { ...previous, activeMatchIndex, decorations };
          }
          const query = update?.query ?? previous.query, wildcards = update?.wildcards ?? previous.wildcards;
          const requested = update?.activeMatchIndex ?? previous.activeMatchIndex;
          // The same search after an edit: only the text blocks the edit touched are searched again.
          if (transaction.docChanged && query === previous.query && wildcards === previous.wildcards) {
            const next = updateFindState(previous, transaction, requested);
            if (next) { tiptapFindWork.incremental++; return next; }
            tiptapFindWork.fallback++;
          }
          return createFindState(
            transaction.doc,
            update?.query ?? previous.query,
            update?.activeMatchIndex ?? previous.activeMatchIndex,
            update?.wildcards ?? previous.wildcards,
          );
        },
      },
      props: {
        decorations: (state) => tiptapFindPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
      },
    })];
  },
});

export function updateTiptapFind(
  editor: Editor,
  update: TiptapFindUpdate,
) {
  editor.view.dispatch(editor.state.tr.setMeta(tiptapFindPluginKey, update));
}
