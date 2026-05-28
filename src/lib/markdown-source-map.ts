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

export function findMarkdownSourceElementForOffset(
  container: HTMLElement,
  offset: number,
) {
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>(MARKDOWN_SOURCE_BLOCK_SELECTOR),
  );
  let bestContained: { element: HTMLElement; span: number } | null = null;
  let nearest: { distance: number; element: HTMLElement } | null = null;

  for (const element of elements) {
    const range = getMarkdownSourceRange(element);

    if (!range) {
      continue;
    }

    if (offset >= range.start && offset <= range.end) {
      const span = range.end - range.start;

      if (!bestContained || span < bestContained.span) {
        bestContained = { element, span };
      }

      continue;
    }

    const distance = offset < range.start ? range.start - offset : offset - range.end;

    if (!nearest || distance < nearest.distance) {
      nearest = { distance, element };
    }
  }

  return bestContained?.element ?? nearest?.element ?? null;
}
