import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
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

export function findTiptapTextMatches(
  doc: ProseMirrorNode,
  query: string,
  options: TextFindOptions = {},
) {
  if (!query) return [];

  const cacheKey = `${options.wildcards ? 1 : 0}:${query}`;
  let cache = blockSearches.get(cacheKey);
  if (!cache) {
    cache = new WeakMap();
    blockSearches.set(cacheKey, cache);
    if (blockSearches.size > 4) blockSearches.delete(blockSearches.keys().next().value!);
  }
  const matches: TiptapFindMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return;

    const cached = cache!.get(node);
    if (cached) {
      for (const match of cached) matches.push({ from: position + 1 + match.from, to: position + 1 + match.to });
      return false;
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
    cache!.set(node, relative);
    for (const match of relative) matches.push({ from: position + 1 + match.from, to: position + 1 + match.to });

    // This text block has been searched; do not visit its inline children again.
    return false;
  });

  return matches;
}

function createFindState(doc: ProseMirrorNode, query: string, requestedIndex = 0, wildcards = false): TiptapFindState {
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
