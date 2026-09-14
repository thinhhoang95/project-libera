export const MARKDOWN_SOURCE_SELECTOR = "[data-source-start][data-source-end]";
export const MARKDOWN_SOURCE_BLOCK_SELECTOR =
  '[data-source-start][data-source-end][data-source-block="true"]';

export type MarkdownSourceRange = {
  end: number;
  start: number;
};

type MarkdownSourcePoint = {
  offset?: number;
};

type MarkdownSourcePosition = {
  end?: MarkdownSourcePoint;
  start?: MarkdownSourcePoint;
};

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  data?: {
    hProperties?: Record<string, string>;
  };
  position?: MarkdownSourcePosition;
  type?: string;
};

const BLOCK_NODE_TYPES = new Set([
  "blockquote",
  "code",
  "heading",
  "html",
  "list",
  "listItem",
  "math",
  "paragraph",
  "table",
  "tableCell",
  "tableRow",
  "thematicBreak",
]);

function annotateNode(node: MarkdownAstNode) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;

  if (
    node.type &&
    node.type !== "root" &&
    typeof start === "number" &&
    typeof end === "number" &&
    end >= start
  ) {
    node.data ??= {};
    node.data.hProperties ??= {};
    node.data.hProperties["data-source-start"] = String(start);
    node.data.hProperties["data-source-end"] = String(end);

    if (BLOCK_NODE_TYPES.has(node.type)) {
      node.data.hProperties["data-source-block"] = "true";
    }
  }

  for (const child of node.children ?? []) {
    annotateNode(child);
  }
}

export function remarkMarkdownSourceMap() {
  return (tree: MarkdownAstNode) => {
    annotateNode(tree);
  };
}

export function getMarkdownSourceRange(element: Element | null): MarkdownSourceRange | null {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const start = Number(element.dataset.sourceStart);
  const end = Number(element.dataset.sourceEnd);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return { start, end };
}

export function getMarkdownSourceOffsetAtPoint(element: Element, clientY: number) {
  const range = getMarkdownSourceRange(element);

  if (!range) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const height = Math.max(1, rect.height);
  const progress = Math.min(1, Math.max(0, (clientY - rect.top) / height));

  return Math.round(range.start + (range.end - range.start) * progress);
}

type SourceEntry = MarkdownSourceRange & { element: HTMLElement; order: number };
type SourceTree = { entry: SourceEntry; minStart: number; maxEnd: number; left: SourceTree | null; right: SourceTree | null };
type SourceIndex = { dirty: boolean; observer?: MutationObserver; root: SourceTree | null; starts: SourceEntry[]; ends: SourceEntry[] };
const sourceIndexes = new WeakMap<HTMLElement, SourceIndex>();
function sourceIndex(container: HTMLElement) {
  let index = sourceIndexes.get(container);
  if (!index) {
    index = { dirty: true, root: null, starts: [], ends: [] };
    if (typeof MutationObserver !== "undefined") {
      const current = index;
      index.observer = new MutationObserver(() => { current.dirty = true; });
      index.observer.observe(container, { subtree: true, childList: true, attributes: true,
        attributeFilter: ["data-source-start", "data-source-end", "data-source-block"] });
    }
    sourceIndexes.set(container, index);
  }
  if (index.observer?.takeRecords().length) index.dirty = true;
  if (index.dirty || !index.observer) {
    const entries = Array.from(container.querySelectorAll<HTMLElement>(MARKDOWN_SOURCE_BLOCK_SELECTOR))
      .flatMap((element, order) => { const range = getMarkdownSourceRange(element); return range ? [{ ...range, element, order }] : []; });
    index.starts = entries.slice().sort((a, b) => a.start - b.start || a.order - b.order);
    index.ends = entries.slice().sort((a, b) => a.end - b.end || b.order - a.order);
    function tree(from: number, to: number): SourceTree | null {
      if (from >= to) return null;
      const mid = (from + to) >>> 1;
      const entry = index!.starts[mid], left = tree(from, mid), right = tree(mid + 1, to);
      return { entry, left, right, minStart: index!.starts[from].start,
        maxEnd: Math.max(entry.end, left?.maxEnd ?? -Infinity, right?.maxEnd ?? -Infinity) };
    }
    index.root = tree(0, entries.length);
    index.dirty = false;
  }
  return index;
}

export function findMarkdownSourceElementForOffset(container: HTMLElement, offset: number) {
  const index = sourceIndex(container);
  let best: SourceEntry | undefined;
  function contained(node: SourceTree | null) {
    if (!node || node.maxEnd < offset || node.minStart > offset) return;
    const entry = node.entry;
    if (entry.start <= offset && entry.end >= offset && (!best || entry.end - entry.start < best.end - best.start ||
        (entry.end - entry.start === best.end - best.start && entry.order < best.order))) best = entry;
    contained(node.left); contained(node.right);
  }
  contained(index.root);
  if (best) return best.element;
  // No containing range: compare nearest following start and preceding end,
  // retaining document order when distances tie, as the original scan did.
  let low = 0, high = index.starts.length;
  while (low < high) { const mid = (low + high) >>> 1; if (index.starts[mid].start <= offset) low = mid + 1; else high = mid; }
  const after = index.starts[low];
  low = 0; high = index.ends.length;
  while (low < high) { const mid = (low + high) >>> 1; if (index.ends[mid].end < offset) low = mid + 1; else high = mid; }
  const before = index.ends[low - 1];
  if (!before) return after?.element ?? null;
  if (!after) return before.element;
  const leftDistance = offset - before.end, rightDistance = after.start - offset;
  return (leftDistance < rightDistance || leftDistance === rightDistance && before.order < after.order ? before : after).element;
}
