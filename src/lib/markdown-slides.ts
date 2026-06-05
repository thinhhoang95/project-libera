export type MarkdownSlideTemplateId = string;

export type MarkdownSlideMetadata = Record<string, unknown>;

export type MarkdownSlideDiagnostic = {
  level: "warning";
  message: string;
  line?: number;
};

export type MarkdownSlide = {
  content: string;
  fontSize?: number;
  index: number;
  kind: "slide" | "title";
  metadata: MarkdownSlideMetadata;
  sourceEnd: number;
  sourceStart: number;
  title?: string;
};

export type MarkdownSlideDeck = {
  affiliation: string[];
  author: string[];
  date?: string;
  diagnostics: MarkdownSlideDiagnostic[];
  fontSize?: number;
  metadata: MarkdownSlideMetadata;
  slides: MarkdownSlide[];
  subtitle?: string;
  template: MarkdownSlideTemplateId;
  title?: string;
};

type MarkdownSlideBlock = {
  content: string;
  sourceEnd: number;
  sourceStart: number;
};

type LineRange = {
  end: number;
  start: number;
  text: string;
};

const DEFAULT_TEMPLATE_ID = "default";
const FENCE_OPEN_REGEX = /^(`{3,}|~{3,})/;
const METADATA_LINE_REGEX = /^\$([A-Za-z][\w-]*)\s*=\s*(.+)$/;
const MARKDOWN_SLIDES_PATH_REGEX = /\.slides\.(?:md|markdown)$/i;

export function isMarkdownSlidesPath(pathOrName: string) {
  return MARKDOWN_SLIDES_PATH_REGEX.test(pathOrName);
}

function splitLines(value: string): LineRange[] {
  const lines: LineRange[] = [];
  let start = 0;

  while (start < value.length) {
    const newlineIndex = value.indexOf("\n", start);
    const end = newlineIndex === -1 ? value.length : newlineIndex + 1;

    lines.push({
      start,
      end,
      text: value.slice(start, end),
    });

    start = end;
  }

  return lines;
}

function lineNumberForOffset(value: string, offset: number) {
  return value.slice(0, Math.max(0, Math.min(offset, value.length))).split("\n")
    .length;
}

function splitSlideBlocks(source: string): MarkdownSlideBlock[] {
  const blocks: MarkdownSlideBlock[] = [];
  let blockStart = 0;
  let position = 0;
  let fence: { character: string; length: number } | null = null;

  while (position < source.length) {
    const lineStart = position;
    const newlineIndex = source.indexOf("\n", position);
    const lineEnd = newlineIndex === -1 ? source.length : newlineIndex + 1;
    const rawLine = source.slice(lineStart, lineEnd);
    const line = rawLine.replace(/\r?\n$/, "");
    const trimmed = line.trim();

    if (!fence && trimmed === "---") {
      blocks.push({
        content: source.slice(blockStart, lineStart),
        sourceEnd: lineStart,
        sourceStart: blockStart,
      });
      blockStart = lineEnd;
      position = lineEnd;
      continue;
    }

    const fenceMatch = trimmed.match(FENCE_OPEN_REGEX);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      const character = marker[0];

      if (!fence) {
        fence = { character, length: marker.length };
      } else if (fence.character === character && marker.length >= fence.length) {
        fence = null;
      }
    }

    position = lineEnd;
  }

  blocks.push({
    content: source.slice(blockStart),
    sourceEnd: source.length,
    sourceStart: blockStart,
  });

  return blocks;
}

function parseMetadataBlock(
  block: MarkdownSlideBlock,
  diagnostics: MarkdownSlideDiagnostic[],
  source: string,
) {
  const metadata: MarkdownSlideMetadata = {};
  const lines = splitLines(block.content);
  let contentStart = 0;

  for (const line of lines) {
    const trimmed = line.text.trim();

    if (!trimmed) {
      contentStart = line.end;
      continue;
    }

    const metadataMatch = trimmed.match(METADATA_LINE_REGEX);

    if (metadataMatch) {
      const [, key, rawValue] = metadataMatch;

      try {
        metadata[key] = JSON.parse(rawValue);
      } catch {
        diagnostics.push({
          level: "warning",
          message: `Invalid metadata value for $${key}; expected a JSON literal.`,
          line: lineNumberForOffset(source, block.sourceStart + line.start),
        });
      }

      contentStart = line.end;
      continue;
    }

    if (trimmed.startsWith("$")) {
      diagnostics.push({
        level: "warning",
        message: "Invalid metadata line; expected $key = JSON_LITERAL.",
        line: lineNumberForOffset(source, block.sourceStart + line.start),
      });
      contentStart = line.end;
      continue;
    }

    break;
  }

  return {
    content: block.content.slice(contentStart).replace(/\s+$/, ""),
    contentStart,
    metadata,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringListValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  const singleValue = stringValue(value);

  return singleValue ? [singleValue] : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function fontSizeValue(metadata: MarkdownSlideMetadata) {
  return numberValue(metadata.fontsize ?? metadata.fontSize);
}

function hasTitleSlideContent(deckMetadata: MarkdownSlideMetadata, content: string) {
  return Boolean(
    stringValue(deckMetadata.title) ||
      stringValue(deckMetadata.subtitle) ||
      stringListValue(deckMetadata.author).length ||
      stringListValue(deckMetadata.affiliation).length ||
      stringValue(deckMetadata.date) ||
      content.trim(),
  );
}

export function parseMarkdownSlides(source: string): MarkdownSlideDeck {
  const diagnostics: MarkdownSlideDiagnostic[] = [];
  const blocks = splitSlideBlocks(source);
  const deckBlock = blocks[0] ?? { content: "", sourceEnd: 0, sourceStart: 0 };
  const parsedDeckMetadata = parseMetadataBlock(deckBlock, diagnostics, source);
  const deckFontSize = fontSizeValue(parsedDeckMetadata.metadata);
  const contentSlides = blocks.slice(1).flatMap((block) => {
    const parsedSlide = parseMetadataBlock(block, diagnostics, source);
    const title = stringValue(parsedSlide.metadata.title);

    if (!title && !parsedSlide.content.trim()) {
      return [];
    }

    return [
      {
        content: parsedSlide.content,
        fontSize: fontSizeValue(parsedSlide.metadata),
        index: 0,
        kind: "slide" as const,
        metadata: parsedSlide.metadata,
        sourceEnd: block.sourceEnd,
        sourceStart: block.sourceStart,
        title,
      },
    ];
  });
  const slides: MarkdownSlide[] = [
    ...(hasTitleSlideContent(parsedDeckMetadata.metadata, parsedDeckMetadata.content)
      ? [
          {
            content: parsedDeckMetadata.content,
            fontSize: deckFontSize,
            index: 0,
            kind: "title" as const,
            metadata: parsedDeckMetadata.metadata,
            sourceEnd: deckBlock.sourceEnd,
            sourceStart: deckBlock.sourceStart,
            title: stringValue(parsedDeckMetadata.metadata.title),
          },
        ]
      : []),
    ...contentSlides,
  ].map((slide, index) => ({ ...slide, index }));

  return {
    affiliation: stringListValue(parsedDeckMetadata.metadata.affiliation),
    author: stringListValue(parsedDeckMetadata.metadata.author),
    date: stringValue(parsedDeckMetadata.metadata.date),
    diagnostics,
    fontSize: deckFontSize,
    metadata: parsedDeckMetadata.metadata,
    slides,
    subtitle: stringValue(parsedDeckMetadata.metadata.subtitle),
    template: stringValue(parsedDeckMetadata.metadata.template) ?? DEFAULT_TEMPLATE_ID,
    title: stringValue(parsedDeckMetadata.metadata.title),
  };
}
