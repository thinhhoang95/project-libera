export type MarkdownColor = {
  label: string;
  value: `#${string}`;
};

export type MarkdownTextColor = MarkdownColor;

export type MarkdownHighlightColor = MarkdownColor & {
  foreground: `#${string}`;
  shortcut: string;
  useDefaultThemeColors?: boolean;
};

export const MARKDOWN_TEXT_COLORS = [
  { label: "Red", value: "#dc2626" },
  { label: "Orange", value: "#ea580c" },
  { label: "Amber", value: "#d97706" },
  { label: "Green", value: "#16a34a" },
  { label: "Teal", value: "#0d9488" },
  { label: "Blue", value: "#2563eb" },
  { label: "Violet", value: "#7c3aed" },
  { label: "Pink", value: "#db2777" },
  { label: "Slate", value: "#475569" },
] as const satisfies readonly MarkdownTextColor[];

export const MARKDOWN_HIGHLIGHT_COLORS = [
  {
    foreground: "#422006",
    label: "Yellow",
    shortcut: "y",
    useDefaultThemeColors: true,
    value: "#fef08a",
  },
  { foreground: "#ffffff", label: "Red", shortcut: "r", value: "#dc2626" },
  { foreground: "#ffffff", label: "Orange", shortcut: "o", value: "#c2410c" },
  { foreground: "#ffffff", label: "Amber", shortcut: "a", value: "#b45309" },
  { foreground: "#ffffff", label: "Green", shortcut: "g", value: "#15803d" },
  { foreground: "#ffffff", label: "Teal", shortcut: "t", value: "#0f766e" },
  { foreground: "#ffffff", label: "Blue", shortcut: "b", value: "#2563eb" },
  { foreground: "#ffffff", label: "Violet", shortcut: "v", value: "#7c3aed" },
  { foreground: "#ffffff", label: "Pink", shortcut: "p", value: "#be185d" },
  { foreground: "#ffffff", label: "Slate", shortcut: "s", value: "#475569" },
] as const satisfies readonly MarkdownHighlightColor[];

export const MARKDOWN_DEFAULT_HIGHLIGHT_COLOR = MARKDOWN_HIGHLIGHT_COLORS[0];

const MARKDOWN_HIGHLIGHT_COLORS_BY_SHORTCUT: ReadonlyMap<
  string,
  MarkdownHighlightColor
> = new Map(
  MARKDOWN_HIGHLIGHT_COLORS.map((color) => [color.shortcut, color]),
);

export function getMarkdownHighlightColorByShortcut(shortcut: string) {
  return MARKDOWN_HIGHLIGHT_COLORS_BY_SHORTCUT.get(shortcut.toLowerCase());
}

const COLOR_OPEN_PATTERN =
  /\[color=(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))\]/g;
const COLOR_CLOSE = "[/color]";

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

type ColorOpenMarker = {
  color: string;
  kind: "open";
  raw: string;
};

type ColorCloseMarker = {
  kind: "close";
  raw: typeof COLOR_CLOSE;
};

type ColorMarker = ColorCloseMarker | ColorOpenMarker;

type SplitPart =
  | {
      kind: "text";
      node: MarkdownAstNode;
    }
  | ColorMarker;

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

export function isSafeMarkdownTextColor(value: string) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(
    value,
  );
}

function normalizeMarkdownTextColor(value: string) {
  return value.toLowerCase();
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

function markerTextNode(marker: ColorMarker): MarkdownAstNode {
  return {
    type: "text",
    value: marker.raw,
  };
}

function nextOpenMarker(
  value: string,
  start: number,
): { index: number; marker: ColorOpenMarker } | null {
  COLOR_OPEN_PATTERN.lastIndex = start;

  const match = COLOR_OPEN_PATTERN.exec(value);

  if (!match) {
    return null;
  }

  return {
    index: match.index,
    marker: {
      color: normalizeMarkdownTextColor(match[1]),
      kind: "open" as const,
      raw: match[0],
    },
  };
}

function nextMarker(
  value: string,
  start: number,
): { index: number; marker: ColorMarker } | null {
  const nextOpen = nextOpenMarker(value, start);
  const nextCloseIndex = value.indexOf(COLOR_CLOSE, start);
  const nextClose =
    nextCloseIndex >= 0
      ? {
          index: nextCloseIndex,
          marker: {
            kind: "close" as const,
            raw: COLOR_CLOSE,
          } satisfies ColorCloseMarker,
        }
      : null;

  if (!nextOpen) {
    return nextClose;
  }

  if (!nextClose || nextOpen.index < nextClose.index) {
    return nextOpen;
  }

  return nextClose;
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
    index = next.index + next.marker.raw.length;
  }

  return parts;
}

function pushNode(target: MarkdownAstNode[], node: MarkdownAstNode) {
  if (node.type === "text" && node.value === "") {
    return;
  }

  target.push(node);
}

function colorNode(color: string, children: MarkdownAstNode[]): MarkdownAstNode {
  return {
    children,
    data: {
      hName: "span",
      hProperties: {
        className: "markdown-text-color",
        "data-markdown-color": color,
      },
    },
    type: "liberaTextColor",
  };
}

function transformColorChildren(children: MarkdownAstNode[]) {
  const transformed: MarkdownAstNode[] = [];
  let colorMarker: ColorOpenMarker | null = null;
  let colored: MarkdownAstNode[] | null = null;

  for (const child of children) {
    if (child.type !== "text" || typeof child.value !== "string") {
      pushNode(colored ?? transformed, child);
      continue;
    }

    for (const part of splitTextNode(child)) {
      if (part.kind === "text") {
        pushNode(colored ?? transformed, part.node);
        continue;
      }

      if (part.kind === "open") {
        if (colored) {
          pushNode(colored, markerTextNode(part));
          continue;
        }

        colorMarker = part;
        colored = [];
        continue;
      }

      if (!colored || !colorMarker) {
        pushNode(transformed, markerTextNode(part));
        continue;
      }

      pushNode(transformed, colorNode(colorMarker.color, colored));
      colorMarker = null;
      colored = null;
    }
  }

  if (colored && colorMarker) {
    pushNode(transformed, markerTextNode(colorMarker));

    for (const child of colored) {
      pushNode(transformed, child);
    }
  }

  children.splice(0, children.length, ...transformed);
}

function transformNode(node: MarkdownAstNode) {
  if (!node.children || (node.type && SKIP_CHILDREN_NODE_TYPES.has(node.type))) {
    return;
  }

  transformColorChildren(node.children);

  for (const child of node.children) {
    transformNode(child);
  }
}

export function remarkMarkdownTextColors() {
  return (tree: MarkdownAstNode) => {
    transformNode(tree);
  };
}
