import type { LiberaFileNode, LiberaTree, LiberaTreeNode } from "@/lib/types";
import type { SearchResult } from "./types";

/** Where a query matched, as character indices into the searched text. */
export type FuzzyMatch = { score: number; indices: number[] };

export type NotebookSearchHit = SearchResult & {
  score: number;
  /** Matched characters in the file or notebook name. */
  nameIndices: number[];
  /** Matched characters in the path, when the name alone did not match. */
  pathIndices: number[];
};

export type NotebookSearchOptions = {
  limit?: number;
  /** Also list notebooks whose name matches. */
  includeNotebooks?: boolean;
  /** Match letters in order with gaps ("mtgnts" finds "meeting-notes.md") and match the folder path too. */
  fuzzy?: boolean;
  /** Added to a file's score, e.g. to rank the current notebook or recent files first. */
  boost?: (file: LiberaFileNode) => number;
};

const WORD_BREAK = /[\s_\-./\\()[\]]/;

function isWordStart(text: string, index: number) {
  return index === 0 || WORD_BREAK.test(text[index - 1]) || (/[a-z]/.test(text[index - 1]) && /[A-Z]/.test(text[index]));
}

function matchToken(text: string, lower: string, token: string, fuzzy: boolean): FuzzyMatch | null {
  const at = lower.indexOf(token);
  if (at >= 0) {
    // A contiguous match: earlier and at a word start ranks higher.
    const score = 1000 - Math.min(at, 200) + (at === 0 ? 300 : isWordStart(text, at) ? 150 : 0) + token.length * 4;
    return { score, indices: Array.from({ length: token.length }, (_, offset) => at + offset) };
  }
  if (!fuzzy) return null;
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  for (const char of token) {
    // Prefer the next word start that carries this letter, then any position.
    let index = -1;
    for (let cursor = from; cursor < lower.length; cursor += 1) {
      if (lower[cursor] !== char) continue;
      if (isWordStart(text, cursor)) { index = cursor; break; }
      if (index < 0) index = cursor;
    }
    if (index < 0) return null;
    score += indices.length && index === indices[indices.length - 1] + 1 ? 12 : isWordStart(text, index) ? 10 : 2;
    indices.push(index);
    from = index + 1;
  }
  return { score: score - Math.min(indices[0], 40), indices };
}

/**
 * Matches every whitespace-separated word of the query against the text, in
 * any order. Without `fuzzy` each word must appear as written.
 */
export function fuzzyMatch(text: string, query: string, fuzzy = true): FuzzyMatch | null {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  let score = 0;
  const indices = new Set<number>();
  for (const token of tokens) {
    const match = matchToken(text, lower, token, fuzzy);
    if (!match) return null;
    score += match.score;
    match.indices.forEach((index) => indices.add(index));
  }
  return { score, indices: [...indices].sort((left, right) => left - right) };
}

function collectFiles(nodes: LiberaTreeNode[], into: LiberaFileNode[]) {
  for (const node of nodes) {
    if (node.kind === "folder") collectFiles(node.children, into);
    else into.push(node);
  }
  return into;
}

/**
 * Finds notebooks and files by name across the notebooks the tree shows: the
 * sidebar search and Quick Open (⌘/Ctrl+P) both use it. Best matches first.
 */
export function searchNotebookTree(tree: LiberaTree, query: string, options: NotebookSearchOptions = {}): NotebookSearchHit[] {
  const { limit = 12, includeNotebooks = false, fuzzy = false, boost } = options;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  // The sidebar matches the whole query as written; fuzzy search splits it into words.
  const matchName = (name: string) => fuzzy ? fuzzyMatch(name, normalized) : matchToken(name, name.toLowerCase(), normalized, false);
  const hits: NotebookSearchHit[] = [];

  for (const notebook of tree.notebooks) {
    if (includeNotebooks) {
      const match = matchName(notebook.name);
      if (match) hits.push({ type: "notebook", notebook: notebook.name, label: notebook.name, score: match.score + 200, nameIndices: match.indices, pathIndices: [] });
    }
    for (const file of collectFiles(notebook.children, [])) {
      const nameMatch = matchName(file.name);
      // A path match ("thesis chapter") ranks below any name match.
      const pathMatch = !nameMatch && fuzzy ? fuzzyMatch(file.path, normalized) : null;
      const match = nameMatch ?? (pathMatch ? { ...pathMatch, score: pathMatch.score / 3 } : null);
      if (!match) continue;
      hits.push({
        type: "file",
        notebook: notebook.name,
        file,
        label: file.path,
        score: match.score + (boost?.(file) ?? 0),
        nameIndices: nameMatch?.indices ?? [],
        pathIndices: pathMatch?.indices ?? [],
      });
    }
  }

  return hits
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);
}
