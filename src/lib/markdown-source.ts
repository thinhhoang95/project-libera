import type { MarkdownImageSelection } from "@/components/libera/types";
import { getMarkdownEditorLineHighlight, initialMarkdownEditorHighlightState } from "./markdown-editor-highlighting";
import type { MarkdownEditorHighlightState } from "./markdown-editor-highlighting";
import { convertClipboardHtmlToMarkdown } from "./markdown-clipboard";
import { smartPasteMarkdown, type SmartPasteMode } from "./markdown-smart-paste";
import type { MathMarkerSettings } from "./math-markers";
import type { TextareaLikeEdit } from "./markdown-codemirror/textarea-adapter";
import { markdownHeadingAnchors, markdownHeadingHref, type MarkdownHeadingAnchor } from "./markdown-heading-anchors";
import { citationTriggerAt, citedKeys } from "./references/citation-syntax";
import { mayTriggerCitation } from "./references/reference-suggestions";
import type { CitationOccurrence } from "./references/types";

const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const IMAGE_FILE_EXTENSION_REGEX = /\.(png|jpe?g|gif|webp)$/i;
const CLIPBOARD_IMAGE_TYPE_EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MARKDOWN_HEADING_REGEX = /^( {0,3})(#{1,6})([ \t]+|$)/;

export const SOURCE_DRAFT_DELAY_MS = 250;
export const SELECTION_CHANGE_DEBOUNCE_MS = 120;
export const SOURCE_EDITOR_LABEL = "Source Markdown editor";
export const SOURCE_TAB_SIZE = 4;
export const SOURCE_PANE_PADDING = "1.25rem";
export const SOURCE_SPELLCHECK = false;

export type SourceKey = { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };

/** App shortcuts have the same modifier rules on every platform. */
export function sourceShortcut(event: SourceKey) {
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    const format = MARKDOWN_SHORTCUT_FORMATS[event.key.toLowerCase()];
    if (format) return { kind: "format" as const, format };
  }
  if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
    return { kind: "heading" as const, direction: event.shiftKey ? "unindent" as const : "indent" as const };
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") return { kind: "find" as const };
  return null;
}

export function fileLinkPopupKey(event: SourceKey, count: number) {
  if (event.key === "Escape") return "close";
  if (!count) return null;
  if (event.key === "ArrowDown") return "next";
  if (event.key === "ArrowUp") return "previous";
  if (event.key === "Enter") return "choose";
  return null;
}

export function refreshSourcePopupOnKeyUp(key: string) {
  return !["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(key);
}

export function handleSourceKey(event: SourceKey, handlers: {
  citation: (event: SourceKey) => boolean;
  fileLink: (event: SourceKey) => boolean;
  format: (format: MarkdownFormat) => void;
  heading: (direction: HeadingLevelChangeDirection) => boolean;
  find: () => void;
}) {
  if (handlers.citation(event) || handlers.fileLink(event)) return true;
  const shortcut = sourceShortcut(event);
  if (shortcut?.kind === "format") { handlers.format(shortcut.format); return true; }
  if (shortcut?.kind === "heading") return handlers.heading(shortcut.direction);
  if (shortcut?.kind === "find") { handlers.find(); return true; }
  return false;
}

export function sourceFormatEdit(text: string, start: number, end: number, { before, after, placeholder = "text" }: MarkdownFormat): TextareaLikeEdit {
  const selected = text.slice(start, end) || placeholder;
  const nextStart = start + before.length;
  return { selectionStart: start, selectionEnd: end, replacement: `${before}${selected}${after}`, nextSelectionStart: nextStart, nextSelectionEnd: nextStart + selected.length };
}

export type FileLinkPopupContext = {
  destinationEnd: number;
  destinationStart: number;
  headings?: MarkdownHeadingAnchor[];
  query: string;
  x: number;
  y: number;
};

export type CitationPopupContext = {
  from: number; to: number; query: string; insideCitation: boolean; citedKeys: string[];
  x: number; y: number; before: string;
};

/** Both link and citation pickers use this pane geometry. */
export function sourcePopupPosition(point: { x: number; y: number }) {
  const width = Math.min(384, window.innerWidth - 16);
  return {
    x: Math.max(8, Math.min(point.x, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(point.y + 6, window.innerHeight - 384 - 8)),
  };
}

export function sourceFileLinkContext(text: string, start: number, end: number, previous: FileLinkPopupContext | null, point: () => { x: number; y: number }): FileLinkPopupContext | null {
  if (start !== end) return null;
  const destination = fileLinkDestinationAt(text, start);
  if (!destination) return null;
  const headings = destination.query.startsWith("#")
    ? previous?.destinationStart === destination.destinationStart && previous.headings
      ? previous.headings : markdownHeadingAnchors(text)
    : undefined;
  return { ...destination, headings, ...sourcePopupPosition(point()) };
}

export function sameFileLinkPopup(left: FileLinkPopupContext | null, right: FileLinkPopupContext | null) {
  return left?.destinationEnd === right?.destinationEnd && left?.destinationStart === right?.destinationStart &&
    left?.query === right?.query && !left?.headings === !right?.headings && left?.x === right?.x && left?.y === right?.y;
}

export function sourceHeadingLinkEdit(text: string, popup: FileLinkPopupContext, heading: MarkdownHeadingAnchor): TextareaLikeEdit {
  const href = markdownHeadingHref(heading);
  const lineEnd = text.indexOf("\n", popup.destinationEnd);
  const closeIndex = text.indexOf(")", popup.destinationEnd);
  const hasClose = closeIndex >= 0 && (lineEnd < 0 || closeIndex < lineEnd);
  const caret = popup.destinationStart + href.length + 1;
  return { selectionStart: popup.destinationStart, selectionEnd: popup.destinationEnd, replacement: hasClose ? href : `${href})`, nextSelectionStart: caret, nextSelectionEnd: caret };
}

/** Trigger, dismissal and cited-key reuse are independent of editor DOM. */
export function sourceCitationContext(text: string, start: number, end: number, options: {
  fileLinkOpen: boolean; previous: CitationPopupContext | null; inserted: { from: number; query: string } | null;
  mathMarkers?: MathMarkerSettings; resolves?: ((key: string) => boolean) | null; point: (offset: number) => { x: number; y: number };
}) {
  const { previous, inserted, mathMarkers, resolves } = options;
  let popup: CitationPopupContext | null = null;
  let dismissed = inserted;
  if (start === end && !options.fileLinkOpen && mayTriggerCitation(text.slice(Math.max(0, start - 260), start))) {
    const trigger = citationTriggerAt(text, start, { mathMarkers });
    if (!(trigger && inserted && inserted.from === trigger.from && inserted.query === trigger.query)) {
      dismissed = null;
      if (trigger) {
        const same = previous?.from === trigger.from;
        popup = {
          from: trigger.from, to: start, query: trigger.query, insideCitation: trigger.insideCitation,
          citedKeys: same ? previous.citedKeys : citedKeys(text, { mathMarkers, resolves }),
          ...(same ? { x: previous.x, y: previous.y } : sourcePopupPosition(options.point(trigger.from))),
          before: trigger.from > 0 ? text[trigger.from - 1] : "",
        };
      }
    }
  } else dismissed = null;
  return { popup, inserted: dismissed };
}

export function sameCitationPopup(left: CitationPopupContext | null, right: CitationPopupContext | null) {
  return left?.from === right?.from && left?.to === right?.to && left?.query === right?.query && left?.insideCitation === right?.insideCitation;
}

export function sourceCitationHit(offset: number, clientX: number, lookup: (offset: number) => CitationOccurrence | null,
  point: (offset: number) => { x: number; y: number }, resolves?: ((key: string) => boolean) | null) {
  const found = lookup(offset);
  if (!found || (found.citation.narrative && !resolves?.(found.citation.items[0].key))) return null;
  const start = point(found.start), end = point(found.end);
  if (start.y === end.y && (clientX < start.x - 2 || clientX > end.x + 2)) return null;
  return found;
}

export function sourceSelectionAfterChange(start: number, end: number, change: { from: number; to: number; insert: string }) {
  const delta = change.insert.length - (change.to - change.from);
  const shift = (offset: number) => offset <= change.from ? offset : offset >= change.to ? offset + delta : change.from + change.insert.length;
  return { nextSelectionStart: shift(start), nextSelectionEnd: shift(end) };
}

/** The smallest range of `current` that must be replaced to produce `next`,
 * so whole-document edits land in the textarea as one compact undo step. */
export function getChangedTextRange(current: string, next: string) {
  let prefixLength = 0;
  while (
    prefixLength < current.length &&
    prefixLength < next.length &&
    current[prefixLength] === next[prefixLength]
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < current.length - prefixLength &&
    suffixLength < next.length - prefixLength &&
    current[current.length - 1 - suffixLength] === next[next.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }
  return {
    replacement: next.slice(prefixLength, next.length - suffixLength),
    selectionEnd: current.length - suffixLength,
    selectionStart: prefixLength,
  };
}

export type HeadingLevelChangeDirection = "indent" | "unindent";

type TextMutation = {
  inserted: number;
  offset: number;
  removed: number;
};

type HeadingLevelChangeResult = {
  changed: boolean;
  hasHeading: boolean;
  nextEnd: number;
  nextStart: number;
  nextValue: string;
};

export type MarkdownFormat = {
  after: string;
  before: string;
  placeholder?: string;
};

export const MARKDOWN_SHORTCUT_FORMATS: Record<string, MarkdownFormat> = {
  b: { before: "**", after: "**" },
  i: { before: "_", after: "_" },
  u: { before: "<u>", after: "</u>" },
};

export function findMarkdownImageInText(
  value: string,
  start: number,
  end: number,
): MarkdownImageSelection | undefined {
  const selection = value.slice(start, end);
  const selectedMatch = Array.from(selection.matchAll(MARKDOWN_IMAGE_REGEX))[0];

  if (selectedMatch?.index !== undefined) {
    return {
      alt: selectedMatch[1] ?? "",
      src: selectedMatch[2] ?? "",
      start: start + selectedMatch.index,
      end: start + selectedMatch.index + selectedMatch[0].length,
    };
  }

  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const nextLineBreak = value.indexOf("\n", end);
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
  const line = value.slice(lineStart, lineEnd);

  for (const match of line.matchAll(MARKDOWN_IMAGE_REGEX)) {
    if (match.index === undefined) {
      continue;
    }

    const imageStart = lineStart + match.index;
    const imageEnd = imageStart + match[0].length;

    if (start >= imageStart && start <= imageEnd) {
      return {
        alt: match[1] ?? "",
        src: match[2] ?? "",
        start: imageStart,
        end: imageEnd,
      };
    }
  }
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSION_REGEX.test(file.name);
}

export function hasImageDragItem(dataTransfer: DataTransfer) {
  if (dataTransfer.files.length) {
    return Array.from(dataTransfer.files).some(isImageFile);
  }

  return Array.from(dataTransfer.items).some(
    (item) =>
      item.kind === "file" &&
      (item.type.startsWith("image/") || !item.type),
  );
}

export function getDroppedImageFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.files).filter(isImageFile);
}

function timestampForPastedImageName() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-");
}

function normalizeClipboardImageFile(file: File) {
  if (IMAGE_FILE_EXTENSION_REGEX.test(file.name)) {
    return file;
  }

  const extension = CLIPBOARD_IMAGE_TYPE_EXTENSIONS[file.type.toLowerCase()];

  if (!extension) {
    return null;
  }

  return new File([file], `pasted-image-${timestampForPastedImageName()}.${extension}`, {
    lastModified: file.lastModified || Date.now(),
    type: file.type,
  });
}

export function getClipboardImageFiles(dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files)
    .filter(isImageFile)
    .map(normalizeClipboardImageFile)
    .filter((file): file is File => Boolean(file));

  if (files.length) {
    return files;
  }

  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file))
    .map(normalizeClipboardImageFile)
    .filter((file): file is File => Boolean(file));
}

/** Image data wins over all text representations in a native paste. */
export function sourceClipboardContents(data: DataTransfer) {
  const image = getClipboardImageFiles(data)[0];
  return image ? { kind: "image" as const, image } : {
    kind: "text" as const,
    clipboard: { html: data.getData("text/html"), markdown: data.getData("text/markdown"), plain: data.getData("text/plain") },
  };
}

export function sourceDragKind(data: DataTransfer | null, pdfQuote: boolean) {
  if (pdfQuote) return "quote";
  return data && hasImageDragItem(data) ? "image" : null;
}

function isHeadingTone(tone: string | undefined) {
  return tone?.startsWith("heading-") ?? false;
}

function transformSelectionOffset(
  offset: number,
  mutations: TextMutation[],
  insertAffinity: "after" | "before",
) {
  let delta = 0;

  for (const mutation of mutations) {
    if (mutation.removed === 0) {
      if (
        offset > mutation.offset ||
        (offset === mutation.offset && insertAffinity === "after")
      ) {
        delta += mutation.inserted;
      }

      continue;
    }

    if (offset <= mutation.offset) {
      continue;
    }

    if (offset <= mutation.offset + mutation.removed) {
      return mutation.offset + delta + mutation.inserted;
    }

    delta += mutation.inserted - mutation.removed;
  }

  return offset + delta;
}

export function changeSelectedHeadingLevels(
  value: string,
  start: number,
  end: number,
  direction: HeadingLevelChangeDirection,
): HeadingLevelChangeResult {
  const selectionStart = Math.max(0, Math.min(start, end, value.length));
  const selectionEnd = Math.max(0, Math.min(Math.max(start, end), value.length));

  if (selectionStart === selectionEnd) {
    return {
      changed: false,
      hasHeading: false,
      nextEnd: selectionEnd,
      nextStart: selectionStart,
      nextValue: value,
    };
  }

  const lines = value.split("\n");
  const mutations: TextMutation[] = [];
  const nextLines: string[] = [];
  let hasHeading = false;
  let lineOffset = 0;
  let state: MarkdownEditorHighlightState = initialMarkdownEditorHighlightState();

  for (const line of lines) {
    const lineEnd = lineOffset + line.length;
    const lineSelected = selectionStart < lineEnd && selectionEnd > lineOffset;
    const highlight = getMarkdownEditorLineHighlight(line, state);
    const headingMatch = line.match(MARKDOWN_HEADING_REGEX);
    let nextLine = line;

    state = highlight.nextState;

    if (lineSelected && isHeadingTone(highlight.tone) && headingMatch) {
      const leadingSpaces = headingMatch[1] ?? "";
      const headingMarkers = headingMatch[2] ?? "";
      const headingSeparator = headingMatch[3] ?? "";
      const markerOffset = lineOffset + leadingSpaces.length;

      hasHeading = true;

      if (direction === "indent" && headingMarkers.length < 6) {
        nextLine = `${line.slice(0, leadingSpaces.length)}#${line.slice(
          leadingSpaces.length,
        )}`;
        mutations.push({
          inserted: 1,
          offset: markerOffset,
          removed: 0,
        });
      }

      if (direction === "unindent") {
        const removed = headingMarkers.length === 1
          ? headingMarkers.length + headingSeparator.length
          : 1;
        nextLine = `${line.slice(0, leadingSpaces.length)}${line.slice(
          leadingSpaces.length + removed,
        )}`;
        mutations.push({
          inserted: 0,
          offset: markerOffset,
          removed,
        });
      }
    }

    nextLines.push(nextLine);
    lineOffset = lineEnd + 1;
  }

  if (!mutations.length) {
    return {
      changed: false,
      hasHeading,
      nextEnd: selectionEnd,
      nextStart: selectionStart,
      nextValue: value,
    };
  }

  return {
    changed: true,
    hasHeading,
    nextEnd: transformSelectionOffset(selectionEnd, mutations, "after"),
    nextStart: transformSelectionOffset(selectionStart, mutations, "before"),
    nextValue: nextLines.join("\n"),
  };
}

export type SourceClipboard = { html: string; markdown: string; plain: string };

export function sourcePasteMode(smartPaste: boolean, menuMode: "normal" | "peer" = "normal"): SmartPasteMode | false {
  return menuMode === "peer" ? "peer" : smartPaste ? "child" : false;
}

/** What a text paste does in the Source editor: rich HTML becomes Libera
 * Markdown, `text/markdown` is used as is, and Smart Paste places pasted
 * headings under ("child", Ctrl+V) or beside ("peer") the heading before them.
 * Null means "let the editor paste the plain text itself", the same cases in
 * which the textarea leaves the paste to the browser; `insertPlain` (a paste
 * from the right-click menu, with no browser paste behind it) inserts the
 * plain text instead. */
export function sourcePasteEdit(
  current: string,
  selection: { start: number; end: number },
  clipboard: SourceClipboard,
  options: { insertPlain?: boolean; mathMarkers?: MathMarkerSettings; smartPaste?: SmartPasteMode | false } = {},
): TextareaLikeEdit | null {
  let replacement = clipboard.markdown;
  if (!replacement && clipboard.html) {
    try {
      replacement = convertClipboardHtmlToMarkdown(clipboard.html, options.mathMarkers);
    } catch {
      // Preserve the plain-text fallback for malformed clipboard HTML.
      if (!options.smartPaste && !options.insertPlain) return null;
    }
  }
  const { start, end } = selection;
  const smartPasted = options.smartPaste
    ? smartPasteMarkdown(current, { end, start }, replacement || clipboard.plain, options.smartPaste)
    : null;
  if (!replacement && !smartPasted) {
    if (!options.insertPlain || !clipboard.plain) return null;
    replacement = clipboard.plain;
  }
  const nextSelection = smartPasted?.selection.start ?? start + replacement.length;
  const edit = smartPasted
    ? getChangedTextRange(current, smartPasted.value)
    : { replacement, selectionEnd: end, selectionStart: start };
  return { ...edit, nextSelectionStart: nextSelection, nextSelectionEnd: nextSelection };
}

/** The file-link picker opens while the caret sits in a link destination,
 * `[label](here`, on one line. This is the textarea editor's test. */
export function fileLinkDestinationAt(text: string, cursor: number) {
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const beforeCursor = text.slice(lineStart, cursor);
  const linkOpenIndex = beforeCursor.lastIndexOf("](");
  if (linkOpenIndex < 0) return null;
  if (beforeCursor.lastIndexOf("[", linkOpenIndex) < 0) return null;
  const destinationStart = lineStart + linkOpenIndex + 2;
  const destination = text.slice(destinationStart, cursor);
  if (destination.includes("\n") || destination.includes(")")) return null;
  return { destinationStart, destinationEnd: cursor, query: destination.replace(/^</, "") };
}
