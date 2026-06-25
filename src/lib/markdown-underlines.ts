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

type UnderlineMarker = {
  kind: "close" | "open";
  value: string;
};

const UNDERLINE_OPEN_PATTERN = /^<u\s*>$/i;
const UNDERLINE_CLOSE_PATTERN = /^<\/u\s*>$/i;

const SKIP_CHILDREN_NODE_TYPES = new Set([
  "code",
  "definition",
  "inlineCode",
  "inlineMath",
  "math",
  "toml",
  "yaml",
]);

function underlineMarker(node: MarkdownAstNode): UnderlineMarker | null {
  if (node.type !== "html" || typeof node.value !== "string") {
    return null;
  }

  if (UNDERLINE_OPEN_PATTERN.test(node.value)) {
    return { kind: "open", value: node.value };
  }

  if (UNDERLINE_CLOSE_PATTERN.test(node.value)) {
    return { kind: "close", value: node.value };
  }

  return null;
}

function markerTextNode(marker: UnderlineMarker): MarkdownAstNode {
  return {
    type: "text",
    value: marker.value,
  };
}

function pushNode(target: MarkdownAstNode[], node: MarkdownAstNode) {
  if (node.type === "text" && node.value === "") {
    return;
  }

  target.push(node);
}

function underlineNode(children: MarkdownAstNode[]): MarkdownAstNode {
  return {
    children,
    data: {
      hName: "u",
      hProperties: {
        className: "markdown-underline",
      },
    },
    type: "liberaUnderline",
  };
}

function transformUnderlineChildren(children: MarkdownAstNode[]) {
  const transformed: MarkdownAstNode[] = [];
  let openMarker: UnderlineMarker | null = null;
  let underlined: MarkdownAstNode[] | null = null;

  for (const child of children) {
    const marker = underlineMarker(child);

    if (!marker) {
      pushNode(underlined ?? transformed, child);
      continue;
    }

    if (marker.kind === "open") {
      if (underlined) {
        pushNode(underlined, markerTextNode(marker));
        continue;
      }

      openMarker = marker;
      underlined = [];
      continue;
    }

    if (!underlined || !openMarker) {
      pushNode(transformed, markerTextNode(marker));
      continue;
    }

    pushNode(transformed, underlineNode(underlined));
    openMarker = null;
    underlined = null;
  }

  if (underlined && openMarker) {
    pushNode(transformed, markerTextNode(openMarker));

    for (const child of underlined) {
      pushNode(transformed, child);
    }
  }

  children.splice(0, children.length, ...transformed);
}

function transformNode(node: MarkdownAstNode) {
  if (!node.children || (node.type && SKIP_CHILDREN_NODE_TYPES.has(node.type))) {
    return;
  }

  transformUnderlineChildren(node.children);

  for (const child of node.children) {
    transformNode(child);
  }
}

export function remarkMarkdownUnderlines() {
  return (tree: MarkdownAstNode) => {
    transformNode(tree);
  };
}
