import {
  getMarkdownHighlightColorByShortcut,
  MARKDOWN_DEFAULT_HIGHLIGHT_COLOR,
  MARKDOWN_HIGHLIGHT_COLORS,
  type MarkdownHighlightColor,
} from "@/lib/markdown-colors";

const HIGHLIGHT_OPEN = ">>>";
const HIGHLIGHT_CLOSE = "<<<";
const HIGHLIGHT_OPEN_SENTINEL = "\uE000\uE000\uE000";
const HIGHLIGHT_CLOSE_SENTINEL = "\uE001\uE001\uE001";

type MarkdownPositionPoint = {
  offset?: number;
};

type MarkdownPosition = {
  end?: MarkdownPositionPoint;
  start?: MarkdownPositionPoint;
};

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
  position?: MarkdownPosition;
  type?: string;
  value?: string;
};

type HighlightOpenMarker = {
  color: MarkdownHighlightColor;
  kind: "open";
  raw: string;
  value: string;
};

type HighlightCloseMarker = {
  kind: "close";
  raw: string;
  value: string;
};

type HighlightMarker = HighlightCloseMarker | HighlightOpenMarker;

type SplitPart =
  | {
      kind: "text";
      node: MarkdownAstNode;
    }
  | HighlightMarker;

const COLOR_HIGHLIGHT_OPEN_MARKERS: HighlightOpenMarker[] =
  MARKDOWN_HIGHLIGHT_COLORS.flatMap((color) => [
    {
      color,
      kind: "open" as const,
      raw: `${color.shortcut}${HIGHLIGHT_OPEN}`,
      value: `${color.shortcut}${HIGHLIGHT_OPEN_SENTINEL}`,
    },
    {
      color,
      kind: "open" as const,
      raw: `${color.shortcut}${HIGHLIGHT_OPEN}`,
      value: `${color.shortcut}${HIGHLIGHT_OPEN}`,
    },
  ]);

const MARKERS: HighlightMarker[] = [
  {
    color: MARKDOWN_DEFAULT_HIGHLIGHT_COLOR,
    kind: "open",
    raw: HIGHLIGHT_OPEN,
    value: HIGHLIGHT_OPEN_SENTINEL,
  },
  { kind: "close", raw: HIGHLIGHT_CLOSE, value: HIGHLIGHT_CLOSE_SENTINEL },
  ...COLOR_HIGHLIGHT_OPEN_MARKERS,
  {
    color: MARKDOWN_DEFAULT_HIGHLIGHT_COLOR,
    kind: "open",
    raw: HIGHLIGHT_OPEN,
    value: HIGHLIGHT_OPEN,
  },
  { kind: "close", raw: HIGHLIGHT_CLOSE, value: HIGHLIGHT_CLOSE },
];

const SKIP_CHILDREN_NODE_TYPES = new Set([
  "code",
  "definition",
  "html",
  "inlineCode",
  "inlineMath",
  "math",
  "toml",
  "yaml",
]);

type FenceState = {
  character: "`" | "~";
  length: number;
};

function fencedCodeMarker(line: string): FenceState | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);

  if (!match) {
    return null;
  }

  return {
    character: match[1][0] as FenceState["character"],
    length: match[1].length,
  };
}

function closesFence(line: string, fence: FenceState) {
  const marker = fencedCodeMarker(line);

  return (
    marker?.character === fence.character && marker.length >= fence.length
  );
}

function isBlockStartingHighlightPrefix(prefix: string) {
  return /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)]) {1,4}(?:\[[ xX]\] {1,4})?|> ?)*$/.test(
    prefix,
  );
}

function blockStartingHighlightIndex(line: string) {
  let index = line.indexOf(HIGHLIGHT_OPEN);

  while (index >= 0) {
    if (isBlockStartingHighlightPrefix(line.slice(0, index))) {
      return index;
    }

    index = line.indexOf(HIGHLIGHT_OPEN, index + HIGHLIGHT_OPEN.length);
  }

  return -1;
}

function colorBlockStartingHighlightIndex(line: string) {
  let index = line.indexOf(HIGHLIGHT_OPEN);

  while (index > 0) {
    const shortcut = line[index - 1];
    const markerStart = index - 1;

    if (
      getMarkdownHighlightColorByShortcut(shortcut) &&
      isBlockStartingHighlightPrefix(line.slice(0, markerStart))
    ) {
      return markerStart;
    }

    index = line.indexOf(HIGHLIGHT_OPEN, index + HIGHLIGHT_OPEN.length);
  }

  return -1;
}

function replaceAt(value: string, index: number, search: string, replacement: string) {
  return `${value.slice(0, index)}${replacement}${value.slice(
    index + search.length,
  )}`;
}

export function normalizeMarkdownHighlightDelimiters(content: string) {
  if (!content.includes(HIGHLIGHT_OPEN)) {
    return content;
  }

  const lines = content.match(/[^\n]*(?:\n|$)/g) ?? [];
  let fence: FenceState | null = null;
  let highlightIsOpen = false;
  let normalized = "";

  for (const lineWithBreak of lines) {
    if (!lineWithBreak) {
      continue;
    }

    const lineBreak = lineWithBreak.endsWith("\n") ? "\n" : "";
    let line = lineBreak ? lineWithBreak.slice(0, -1) : lineWithBreak;

    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }

      normalized += lineWithBreak;
      continue;
    }

    const fenceMarker = fencedCodeMarker(line);

    if (fenceMarker && !highlightIsOpen) {
      fence = fenceMarker;
      normalized += lineWithBreak;
      continue;
    }

    if (highlightIsOpen) {
      const closeIndex = line.indexOf(HIGHLIGHT_CLOSE);

      if (closeIndex >= 0) {
        line = replaceAt(
          line,
          closeIndex,
          HIGHLIGHT_CLOSE,
          HIGHLIGHT_CLOSE_SENTINEL,
        );
        highlightIsOpen = false;
      }

      normalized += `${line}${lineBreak}`;
      continue;
    }

    const colorOpenIndex = colorBlockStartingHighlightIndex(line);
    const defaultOpenIndex = blockStartingHighlightIndex(line);
    const openIndex =
      colorOpenIndex >= 0 &&
      (defaultOpenIndex < 0 || colorOpenIndex <= defaultOpenIndex)
        ? colorOpenIndex
        : defaultOpenIndex;

    if (openIndex >= 0) {
      const markerRaw =
        line.slice(openIndex, openIndex + 1 + HIGHLIGHT_OPEN.length).endsWith(
          HIGHLIGHT_OPEN,
        ) && getMarkdownHighlightColorByShortcut(line[openIndex])
          ? `${line[openIndex]}${HIGHLIGHT_OPEN}`
          : HIGHLIGHT_OPEN;

      line = replaceAt(
        line,
        openIndex,
        markerRaw,
        markerRaw === HIGHLIGHT_OPEN
          ? HIGHLIGHT_OPEN_SENTINEL
          : `${markerRaw[0]}${HIGHLIGHT_OPEN_SENTINEL}`,
      );

      const closeIndex = line.indexOf(
        HIGHLIGHT_CLOSE,
        openIndex + HIGHLIGHT_OPEN_SENTINEL.length,
      );

      if (closeIndex >= 0) {
        line = replaceAt(
          line,
          closeIndex,
          HIGHLIGHT_CLOSE,
          HIGHLIGHT_CLOSE_SENTINEL,
        );
      } else {
        highlightIsOpen = true;
      }
    }

    normalized += `${line}${lineBreak}`;
  }

  return normalized;
}

function cloneTextNode(node: MarkdownAstNode, value: string, start: number, end: number) {
  const positionStart = node.position?.start?.offset;

  return {
    ...node,
    position:
      typeof positionStart === "number"
        ? {
            end: { offset: positionStart + end },
            start: { offset: positionStart + start },
          }
        : node.position,
    value,
  };
}

function markerTextNode(marker: HighlightMarker): MarkdownAstNode {
  return {
    type: "text",
    value: marker.raw,
  };
}

function nextMarker(value: string, start: number) {
  let next: { index: number; marker: HighlightMarker } | null = null;

  for (const marker of MARKERS) {
    let index = value.indexOf(marker.value, start);

    while (index >= 0) {
      const previousCharacter = value[index - 1] ?? "";

      if (
        marker.kind !== "open" ||
        marker.raw === HIGHLIGHT_OPEN ||
        !/[A-Za-z0-9_-]/.test(previousCharacter)
      ) {
        break;
      }

      index = value.indexOf(marker.value, index + marker.value.length);
    }

    if (index >= 0 && (!next || index < next.index)) {
      next = { index, marker };
    }
  }

  return next;
}

function splitTextNode(node: MarkdownAstNode): SplitPart[] {
  const value = node.value ?? "";
  const parts: SplitPart[] = [];
  let index = 0;

  while (index < value.length) {
    const next = nextMarker(value, index);

    if (!next) {
      parts.push({
        kind: "text",
        node: cloneTextNode(node, value.slice(index), index, value.length),
      });
      break;
    }

    if (next.index > index) {
      parts.push({
        kind: "text",
        node: cloneTextNode(node, value.slice(index, next.index), index, next.index),
      });
    }

    parts.push(next.marker);
    index = next.index + next.marker.value.length;
  }

  return parts;
}

function pushNode(target: MarkdownAstNode[], node: MarkdownAstNode) {
  if (node.type === "text" && node.value === "") {
    return;
  }

  target.push(node);
}

function highlightNode(
  color: MarkdownHighlightColor,
  children: MarkdownAstNode[],
): MarkdownAstNode {
  const hProperties: Record<string, string> = {
    className: "markdown-highlight",
  };

  if (!color.useDefaultThemeColors) {
    hProperties["data-markdown-highlight-color"] = color.value;
    hProperties["data-markdown-highlight-foreground"] = color.foreground;
  }

  return {
    children,
    data: {
      hName: "mark",
      hProperties,
    },
    type: "liberaHighlight",
  };
}

function transformHighlightChildren(children: MarkdownAstNode[]) {
  const transformed: MarkdownAstNode[] = [];
  let openMarker: HighlightOpenMarker | null = null;
  let highlighted: MarkdownAstNode[] | null = null;

  for (const child of children) {
    if (child.type !== "text" || typeof child.value !== "string") {
      pushNode(highlighted ?? transformed, child);
      continue;
    }

    for (const part of splitTextNode(child)) {
      if (part.kind === "text") {
        pushNode(highlighted ?? transformed, part.node);
        continue;
      }

      if (part.kind === "open") {
        if (highlighted) {
          pushNode(highlighted, markerTextNode(part));
          continue;
        }

        openMarker = part;
        highlighted = [];
        continue;
      }

      if (!highlighted || !openMarker) {
        pushNode(transformed, markerTextNode(part));
        continue;
      }

      pushNode(transformed, highlightNode(openMarker.color, highlighted));
      openMarker = null;
      highlighted = null;
    }
  }

  if (highlighted && openMarker) {
    pushNode(transformed, markerTextNode(openMarker));

    for (const child of highlighted) {
      pushNode(transformed, child);
    }
  }

  children.splice(0, children.length, ...transformed);
}

function transformNode(node: MarkdownAstNode) {
  if (!node.children || (node.type && SKIP_CHILDREN_NODE_TYPES.has(node.type))) {
    return;
  }

  transformHighlightChildren(node.children);

  for (const child of node.children) {
    transformNode(child);
  }
}

export function remarkMarkdownHighlights() {
  return (tree: MarkdownAstNode) => {
    transformNode(tree);
  };
}
