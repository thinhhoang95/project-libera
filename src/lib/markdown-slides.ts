/**
 * Markdown Slides: a `.slides.md` file is a deck. A line containing only
 * `---` starts a new slide; the first block is the deck's own metadata (and
 * its title slide). Inside a slide:
 *
 *   $key = value      metadata lines at the top (JSON literal or bare text)
 *   # Heading         a leading # or ## heading becomes the slide title
 *   --                a build step: what follows appears on the next click
 *   |||               a column break
 *   ???               speaker notes: everything after it, never shown
 *
 * A deck may also open with YAML-style front matter (`---`, `key: value`
 * lines, `---`) instead of `$key = value` lines. Markers inside code fences
 * and multi-line HTML comments are ignored.
 */

export type MarkdownSlideTemplateId = string;

export type MarkdownSlideMetadata = Record<string, unknown>;

export type MarkdownSlideDiagnostic = {
  level: "warning";
  message: string;
  line?: number;
};

export type MarkdownSlideLayout = "default" | "top" | "center" | "section" | "blank";

export type MarkdownSlideTheme = "light" | "dark" | "paper" | "night";

export type MarkdownSlideTransition = "none" | "fade" | "slide";

export type MarkdownSlideSegment = {
  /** Position among every segment of the deck, for numbering citations across slides. */
  citationIndex: number;
  column: number;
  content: string;
  step: number;
};

export type MarkdownSlide = {
  background?: string;
  /** Offset of the first body character, where the editor caret goes for this slide. */
  bodyStart: number;
  columnCount: number;
  /** Relative column widths from `$columns = [2, 1]`. */
  columnWidths?: number[];
  /** The visible body: markers and speaker notes removed. */
  content: string;
  /** `$fit`: shrink the body to fit the slide. Undefined follows the deck. */
  fit?: boolean;
  fontSize?: number;
  hidden: boolean;
  index: number;
  kind: "slide" | "title";
  layout: MarkdownSlideLayout;
  metadata: MarkdownSlideMetadata;
  notes: string;
  segments: MarkdownSlideSegment[];
  sourceEnd: number;
  sourceStart: number;
  stepCount: number;
  title?: string;
};

export type MarkdownSlideDeck = {
  accent?: string;
  affiliation: string[];
  aspect: MarkdownSlideAspect;
  author: string[];
  date?: string;
  diagnostics: MarkdownSlideDiagnostic[];
  /** `$fit` for the deck: shrink overfull slides to fit (default true). */
  fit: boolean;
  fontSize?: number;
  /** Footer text; `false` hides it. Undefined means the default (author · title). */
  footer?: string | false;
  metadata: MarkdownSlideMetadata;
  paginate: boolean;
  slides: MarkdownSlide[];
  subtitle?: string;
  template: MarkdownSlideTemplateId;
  theme: MarkdownSlideTheme;
  title?: string;
  transition: MarkdownSlideTransition;
};

export type MarkdownSlideAspect = {
  height: number;
  label: string;
  width: number;
};

type MarkdownSlideBlock = {
  content: string;
  sourceEnd: number;
  sourceStart: number;
};

type LineRange = {
  end: number;
  /** Inside a code fence or a multi-line HTML comment (the opening line excluded). */
  opaque: boolean;
  start: number;
  text: string;
};

/** Slides are laid out on a fixed canvas this tall and scaled to fit wherever they are shown. */
export const MARKDOWN_SLIDE_CANVAS_HEIGHT = 540;
export const DEFAULT_MARKDOWN_SLIDE_FONT_SIZE = 21;

const ASPECTS: Record<string, MarkdownSlideAspect> = {
  "16:9": { height: MARKDOWN_SLIDE_CANVAS_HEIGHT, label: "16:9", width: 960 },
  "16:10": { height: MARKDOWN_SLIDE_CANVAS_HEIGHT, label: "16:10", width: 864 },
  "4:3": { height: MARKDOWN_SLIDE_CANVAS_HEIGHT, label: "4:3", width: 720 },
};
const LAYOUTS: MarkdownSlideLayout[] = ["default", "top", "center", "section", "blank"];
const THEMES: MarkdownSlideTheme[] = ["light", "dark", "paper", "night"];
const TRANSITIONS: MarkdownSlideTransition[] = ["none", "fade", "slide"];
const DEFAULT_TEMPLATE_ID = "default";
const FENCE_OPEN_REGEX = /^(`{3,}|~{3,})/;
const METADATA_LINE_REGEX = /^\$([A-Za-z][\w-]*)\s*=\s*(.*)$/;
const FRONT_MATTER_LINE_REGEX = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const FRONT_MATTER_ITEM_REGEX = /^-\s+(.*)$/;
const TITLE_HEADING_REGEX = /^ {0,3}(#{1,2})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const CSS_COLOR_REGEX =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([\d\s.,%/+-]+\)|[a-z]{3,20})$/i;
const MARKDOWN_SLIDES_PATH_REGEX = /\.slides\.(?:md|markdown)$/i;
// Front matter must name at least one of these, so a first slide that merely
// reads like `Key: value` stays a slide.
const DECK_KEYS = new Set([
  "accent", "affiliation", "aspect", "author", "citation-style", "date", "fit", "fontSize", "fontsize",
  "footer", "paginate", "subtitle", "template", "theme", "title", "transition",
]);

export function isMarkdownSlidesPath(pathOrName: string) {
  return MARKDOWN_SLIDES_PATH_REGEX.test(pathOrName);
}

/**
 * The text's lines with their offsets. Code fences and multi-line HTML
 * comments are opaque: slide markers inside them are content.
 */
function splitLines(value: string): LineRange[] {
  const lines: LineRange[] = [];
  let fence: { character: string; length: number } | null = null;
  let inComment = false;
  let start = 0;

  while (start < value.length) {
    const newlineIndex = value.indexOf("\n", start);
    const end = newlineIndex === -1 ? value.length : newlineIndex + 1;
    const text = value.slice(start, end);
    const trimmed = text.trim();
    const opaque = Boolean(fence) || inComment;

    lines.push({ end, opaque, start, text });

    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
    } else {
      const fenceMatch = trimmed.match(FENCE_OPEN_REGEX);

      if (fenceMatch) {
        const marker = fenceMatch[1];

        if (!fence) {
          fence = { character: marker[0], length: marker.length };
        } else if (fence.character === marker[0] && marker.length >= fence.length && trimmed === marker) {
          fence = null;
        }
      } else if (!fence && trimmed.startsWith("<!--") && !trimmed.includes("-->", 4)) {
        inComment = true;
      }
    }

    start = end;
  }

  return lines;
}

function lineNumberForOffset(value: string, offset: number) {
  return value.slice(0, Math.max(0, Math.min(offset, value.length))).split("\n").length;
}

function isMarkerLine(line: LineRange, marker: string) {
  return !line.opaque && line.text.trim() === marker;
}

function splitSlideBlocks(source: string): MarkdownSlideBlock[] {
  const blocks: MarkdownSlideBlock[] = [];
  let blockStart = 0;

  for (const line of splitLines(source)) {
    if (isMarkerLine(line, "---")) {
      blocks.push({
        content: source.slice(blockStart, line.start),
        sourceEnd: line.start,
        sourceStart: blockStart,
      });
      blockStart = line.end;
    }
  }

  blocks.push({
    content: source.slice(blockStart),
    sourceEnd: source.length,
    sourceStart: blockStart,
  });

  return blocks;
}

/**
 * A metadata value: a JSON literal (`"text"`, `21`, `true`, `["a", "b"]`),
 * or else the bare text itself, so `$title = My talk` just works.
 */
function parseMetadataValue(rawValue: string): { value: unknown } | { error: true } {
  const value = rawValue.trim();

  if (!value) {
    return { value: "" };
  }

  try {
    return { value: JSON.parse(value) };
  } catch {
    // Looks like JSON but is not: say so rather than guessing.
    if (/^[[{"]/.test(value)) {
      return { error: true };
    }

    return { value };
  }
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
      const parsed = parseMetadataValue(rawValue);

      if ("error" in parsed) {
        diagnostics.push({
          level: "warning",
          message: `Invalid value for $${key}: it starts like JSON but does not parse.`,
          line: lineNumberForOffset(source, block.sourceStart + line.start),
        });
      } else {
        metadata[key] = parsed.value;
      }

      contentStart = line.end;
      continue;
    }

    // `$x$` math and prices open paragraphs too; only `$word =` is metadata.
    break;
  }

  return {
    content: block.content.slice(contentStart).replace(/\s+$/, ""),
    contentStart,
    metadata,
  };
}

/**
 * YAML-style front matter (`key: value` lines, `- item` lists under a key)
 * when the file opens with `---`. Only that simple subset; anything else
 * means the block is not front matter but a slide.
 */
function parseFrontMatter(block: MarkdownSlideBlock): MarkdownSlideMetadata | null {
  const metadata: MarkdownSlideMetadata = {};
  let listKey: string | null = null;
  let sawDeckKey = false;

  for (const line of splitLines(block.content)) {
    const trimmed = line.text.trim();

    if (!trimmed) {
      continue;
    }

    const itemMatch = line.text.match(/^\s+/) || trimmed.startsWith("- ") ? trimmed.match(FRONT_MATTER_ITEM_REGEX) : null;

    if (itemMatch && listKey) {
      const parsed = parseMetadataValue(unquoteYaml(itemMatch[1]));
      const list = metadata[listKey] as unknown[];

      list.push("error" in parsed ? itemMatch[1] : parsed.value);
      continue;
    }

    const keyMatch = trimmed.match(FRONT_MATTER_LINE_REGEX);

    if (!keyMatch) {
      return null;
    }

    const [, key, rawValue] = keyMatch;

    sawDeckKey ||= DECK_KEYS.has(key);

    if (!rawValue.trim()) {
      metadata[key] = [];
      listKey = key;
      continue;
    }

    listKey = null;
    const parsed = parseMetadataValue(unquoteYaml(rawValue));

    metadata[key] = "error" in parsed ? rawValue.trim() : parsed.value;
  }

  return sawDeckKey ? metadata : null;
}

function unquoteYaml(value: string) {
  const trimmed = value.trim();

  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return JSON.stringify(trimmed.slice(1, -1).replace(/''/g, "'"));
  }

  return trimmed;
}

function stringValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringListValue(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => stringValue(item))
      .filter((item): item is string => Boolean(item));
  }

  const singleValue = stringValue(value);

  return singleValue ? [singleValue] : [];
}

function numberValue(value: unknown) {
  const number = typeof value === "string" ? Number(value) : value;

  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
}

function booleanValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  return fallback;
}

function fontSizeValue(metadata: MarkdownSlideMetadata) {
  return numberValue(metadata.fontsize ?? metadata.fontSize);
}

type Diagnose = (message: string) => void;

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T, name: string, diagnose: Diagnose): T {
  const text = stringValue(value)?.toLowerCase();

  if (!text) {
    return fallback;
  }

  if ((allowed as readonly string[]).includes(text)) {
    return text as T;
  }

  diagnose(`Unknown $${name} "${text}"; expected ${allowed.join(", ")}.`);
  return fallback;
}

function colorValue(value: unknown, name: string, diagnose: Diagnose) {
  const text = stringValue(value);

  if (!text) {
    return undefined;
  }

  if (CSS_COLOR_REGEX.test(text)) {
    return text;
  }

  diagnose(`$${name} "${text}" is not a CSS color.`);
  return undefined;
}

function columnWidthsValue(value: unknown, diagnose: Diagnose) {
  if (value === undefined) {
    return undefined;
  }

  const widths = Array.isArray(value) ? value.map((item) => numberValue(item)) : [];

  if (widths.length && widths.every((width): width is number => width !== undefined)) {
    return widths;
  }

  diagnose("$columns should list relative widths, like [2, 1].");
  return undefined;
}

/** Leading `# Title` (or `## Title`) when the slide has no `$title`. */
function extractHeadingTitle(content: string, maxLevel: number) {
  const lines = splitLines(content);
  const first = lines.find((line) => line.text.trim());
  const match = first && !first.opaque ? first.text.replace(/\r?\n$/, "").match(TITLE_HEADING_REGEX) : null;

  if (!first || !match || match[1].length > maxLevel) {
    return null;
  }

  return {
    content: content.slice(first.end).replace(/^\s*\n/, ""),
    removedLength: first.end,
    title: match[2].trim(),
  };
}

/** `$key = value` lines at the top of `text`, and the text after them. */
function takeLeadingMetadata(text: string, diagnose: Diagnose) {
  const metadata: MarkdownSlideMetadata = {};
  let restStart = 0;

  for (const line of splitLines(text)) {
    const trimmed = line.text.trim();
    const match = trimmed.match(METADATA_LINE_REGEX);

    if (trimmed && !match) break;

    if (match) {
      const parsed = parseMetadataValue(match[2]);
      if ("error" in parsed) diagnose(`Invalid value for $${match[1]}: it starts like JSON but does not parse.`);
      else metadata[match[1]] = parsed.value;
    }

    restStart = line.end;
  }

  return { metadata, rest: text.slice(restStart) };
}

/** The body before a `???` line, and the speaker notes after it. */
function splitNotes(content: string) {
  const notesLine = splitLines(content).find((line) => isMarkerLine(line, "???"));

  if (!notesLine) {
    return { body: content, notes: "" };
  }

  return {
    body: content.slice(0, notesLine.start).replace(/\s+$/, ""),
    notes: content.slice(notesLine.end).trim(),
  };
}

/**
 * The body cut at `--` (next build step) and `|||` (next column), in
 * reading order. A `--` right under a text line would be a setext heading,
 * so it only counts after a blank line.
 */
function splitSegments(body: string) {
  const segments: Array<Omit<MarkdownSlideSegment, "citationIndex">> = [];
  let column = 0;
  let step = 0;
  let segmentStart = 0;
  let previousBlank = true;

  function push(end: number) {
    const content = body.slice(segmentStart, end).replace(/^\s*\n/, "").replace(/\s+$/, "");

    segments.push({ column, content, step });
  }

  for (const line of splitLines(body)) {
    const isStep = isMarkerLine(line, "--") && previousBlank;
    const isColumn = isMarkerLine(line, "|||");

    if (isStep || isColumn) {
      push(line.start);
      segmentStart = line.end;

      if (isStep) step += 1;
      if (isColumn) column += 1;

      previousBlank = true;
      continue;
    }

    previousBlank = !line.text.trim();
  }

  push(body.length);

  const filled = segments.filter((segment) => segment.content);

  return {
    // An empty column still holds its place; an empty step would be a dead click.
    columnCount: column + 1,
    segments: filled.length ? filled : segments.slice(0, 1),
    stepCount: filled.reduce((count, segment) => Math.max(count, segment.step + 1), 1),
  };
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

type SlideDraft = Omit<MarkdownSlide, "index" | "segments"> & {
  segments: Array<Omit<MarkdownSlideSegment, "citationIndex">>;
};

function buildSlide({
  block,
  content,
  contentStart,
  diagnose,
  kind,
  metadata,
}: {
  block: MarkdownSlideBlock;
  content: string;
  contentStart: number;
  diagnose: Diagnose;
  kind: MarkdownSlide["kind"];
  metadata: MarkdownSlideMetadata;
}): SlideDraft | null {
  const { body: bodyWithTitle, notes } = splitNotes(content);
  let title = stringValue(metadata.title);
  let body = bodyWithTitle;

  // The deck block's `# Heading` names the deck; a slide's # or ## names the slide.
  if (!title) {
    const heading = extractHeadingTitle(body, kind === "title" ? 1 : 2);

    if (heading) {
      title = heading.title;
      body = heading.content;

      // `$key = value` lines may also sit right under the title heading.
      const below = takeLeadingMetadata(body, diagnose);
      metadata = { ...metadata, ...below.metadata };
      body = below.rest;
    }
  }

  if (kind === "slide" && !title && !body.trim()) {
    return null;
  }

  const { columnCount, segments, stepCount } = splitSegments(body);

  return {
    background: colorValue(metadata.background, "background", diagnose),
    bodyStart: block.sourceStart + contentStart,
    columnCount,
    columnWidths: columnWidthsValue(metadata.columns, diagnose),
    content: segments.map((segment) => segment.content).filter(Boolean).join("\n\n"),
    fit: kind === "slide" && metadata.fit !== undefined ? booleanValue(metadata.fit, true) : undefined,
    fontSize: fontSizeValue(metadata),
    hidden: booleanValue(metadata.hidden, false),
    kind,
    layout: enumValue(metadata.layout, LAYOUTS, "default", "layout", diagnose),
    metadata,
    notes,
    segments,
    sourceEnd: block.sourceEnd,
    sourceStart: block.sourceStart,
    stepCount,
    title,
  };
}

export function parseMarkdownSlides(source: string): MarkdownSlideDeck {
  const diagnostics: MarkdownSlideDiagnostic[] = [];
  const blocks = splitSlideBlocks(source);
  let deckBlock = blocks[0] ?? { content: "", sourceEnd: 0, sourceStart: 0 };
  let slideBlocks = blocks.slice(1);
  let deckParsed: ReturnType<typeof parseMetadataBlock>;

  // `---` / key: value / `---` at the very top is front matter, not an empty
  // title block followed by a slide of YAML.
  const frontMatter = !deckBlock.content.trim() && blocks.length > 2 ? parseFrontMatter(blocks[1]) : null;

  if (frontMatter) {
    deckBlock = blocks[1];
    slideBlocks = blocks.slice(2);
    deckParsed = { content: "", contentStart: deckBlock.content.length, metadata: frontMatter };
  } else {
    deckParsed = parseMetadataBlock(deckBlock, diagnostics, source);
  }

  const deckMetadata = deckParsed.metadata;
  const deckDiagnose: Diagnose = (message) =>
    diagnostics.push({ level: "warning", message, line: lineNumberForOffset(source, deckBlock.sourceStart) });
  const drafts: SlideDraft[] = [];

  if (hasTitleSlideContent(deckMetadata, deckParsed.content)) {
    const titleSlide = buildSlide({
      block: deckBlock,
      content: deckParsed.content,
      contentStart: deckParsed.contentStart,
      diagnose: deckDiagnose,
      kind: "title",
      metadata: deckMetadata,
    });

    if (titleSlide) drafts.push(titleSlide);
  }

  for (const block of slideBlocks) {
    const parsed = parseMetadataBlock(block, diagnostics, source);
    const line = lineNumberForOffset(source, block.sourceStart);
    const slide = buildSlide({
      block,
      content: parsed.content,
      contentStart: parsed.contentStart,
      diagnose: (message) => diagnostics.push({ level: "warning", message, line }),
      kind: "slide",
      metadata: parsed.metadata,
    });

    if (slide) drafts.push(slide);
  }

  let citationIndex = 0;
  const slides: MarkdownSlide[] = drafts.map((draft, index) => ({
    ...draft,
    index,
    segments: draft.segments.map((segment) => ({ ...segment, citationIndex: citationIndex++ })),
  }));
  const titleSlide = slides[0]?.kind === "title" ? slides[0] : undefined;
  const aspectKey = stringValue(deckMetadata.aspect);
  const aspect = aspectKey ? ASPECTS[aspectKey] : ASPECTS["16:9"];
  const footer = deckMetadata.footer === false || deckMetadata.footer === "false"
    ? false
    : stringValue(deckMetadata.footer);

  if (aspectKey && !aspect) {
    deckDiagnose(`Unknown $aspect "${aspectKey}"; expected ${Object.keys(ASPECTS).join(", ")}.`);
  }

  return {
    accent: colorValue(deckMetadata.accent, "accent", deckDiagnose),
    affiliation: stringListValue(deckMetadata.affiliation),
    aspect: aspect ?? ASPECTS["16:9"],
    author: stringListValue(deckMetadata.author),
    date: stringValue(deckMetadata.date),
    diagnostics,
    fit: booleanValue(deckMetadata.fit, true),
    fontSize: fontSizeValue(deckMetadata),
    footer,
    metadata: deckMetadata,
    paginate: booleanValue(deckMetadata.paginate, true),
    slides,
    subtitle: stringValue(deckMetadata.subtitle),
    template: stringValue(deckMetadata.template) ?? DEFAULT_TEMPLATE_ID,
    theme: enumValue(deckMetadata.theme, THEMES, "light", "theme", deckDiagnose),
    title: titleSlide?.title ?? stringValue(deckMetadata.title),
    transition: enumValue(deckMetadata.transition, TRANSITIONS, "fade", "transition", deckDiagnose),
  };
}

/** The slide whose source contains `offset` (or the last one before it). */
export function markdownSlideIndexAtOffset(deck: MarkdownSlideDeck, offset: number) {
  let index = 0;

  for (const slide of deck.slides) {
    if (offset < slide.sourceStart) break;
    index = slide.index;
    if (offset <= slide.sourceEnd) break;
  }

  return index;
}

/** The slides a presentation or export shows, in order. */
export function visibleMarkdownSlides(deck: MarkdownSlideDeck) {
  return deck.slides.filter((slide) => !slide.hidden);
}
