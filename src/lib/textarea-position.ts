type TextareaScrollBlock = "center" | "start";

type TextareaLayoutMetrics = {
  charWidth: number;
  lineHeight: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  wrapColumn: number;
};

let measurementCanvas: HTMLCanvasElement | undefined;

function parsePixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMeasurementContext() {
  if (typeof document === "undefined") {
    return null;
  }

  measurementCanvas ??= document.createElement("canvas");
  return measurementCanvas.getContext("2d");
}

function getTextareaLayoutMetrics(textarea: HTMLTextAreaElement): TextareaLayoutMetrics {
  const styles = window.getComputedStyle(textarea);
  const paddingLeft = parsePixels(styles.paddingLeft);
  const paddingRight = parsePixels(styles.paddingRight);
  const paddingTop = parsePixels(styles.paddingTop);
  const fontSize = parsePixels(styles.fontSize) || 14;
  const lineHeight = parsePixels(styles.lineHeight) || fontSize * 1.5;
  const context = getMeasurementContext();
  const font = [
    styles.fontStyle,
    styles.fontVariant,
    styles.fontWeight,
    styles.fontSize,
    styles.fontFamily,
  ].join(" ");

  if (context) {
    context.font = font;
  }

  const charWidth = context
    ? context.measureText("M").width || fontSize * 0.6
    : fontSize * 0.6;
  const contentWidth = Math.max(1, textarea.clientWidth - paddingLeft - paddingRight);

  return {
    charWidth,
    lineHeight,
    paddingLeft,
    paddingRight,
    paddingTop,
    wrapColumn: Math.max(1, Math.floor(contentWidth / charWidth)),
  };
}

function getVisualLineCount(line: string, wrapColumn: number) {
  return Math.max(1, Math.ceil(Math.max(1, line.length) / wrapColumn));
}

function getTextareaVisualLineForOffset(
  textarea: HTMLTextAreaElement,
  offset: number,
  metrics: TextareaLayoutMetrics,
) {
  const clampedOffset = Math.max(0, Math.min(offset, textarea.value.length));
  const lines = textarea.value.split("\n");
  let currentOffset = 0;
  let visualLine = 0;

  for (const line of lines) {
    const lineEndOffset = currentOffset + line.length;

    if (clampedOffset <= lineEndOffset) {
      const column = clampedOffset - currentOffset;
      return visualLine + Math.floor(column / metrics.wrapColumn);
    }

    currentOffset = lineEndOffset + 1;
    visualLine += getVisualLineCount(line, metrics.wrapColumn);
  }

  return visualLine;
}

export function getTextareaOffsetAtPoint(
  textarea: HTMLTextAreaElement,
  clientX: number,
  clientY: number,
) {
  const metrics = getTextareaLayoutMetrics(textarea);
  const rect = textarea.getBoundingClientRect();
  const targetLine = Math.max(
    0,
    Math.floor(
      (clientY - rect.top - metrics.paddingTop + textarea.scrollTop) /
        metrics.lineHeight,
    ),
  );
  const targetColumn = Math.max(
    0,
    Math.round((clientX - rect.left - metrics.paddingLeft + textarea.scrollLeft) / metrics.charWidth),
  );
  const lines = textarea.value.split("\n");
  let offset = 0;
  let visualLine = 0;

  for (const line of lines) {
    const visualLineCount = getVisualLineCount(line, metrics.wrapColumn);

    if (targetLine < visualLine + visualLineCount) {
      const wrappedLine = targetLine - visualLine;
      const lineOffset = Math.min(
        line.length,
        wrappedLine * metrics.wrapColumn + targetColumn,
      );

      return offset + lineOffset;
    }

    offset += line.length + 1;
    visualLine += visualLineCount;
  }

  return textarea.value.length;
}

export function getTextareaVisibleStartOffset(textarea: HTMLTextAreaElement) {
  const metrics = getTextareaLayoutMetrics(textarea);
  const rect = textarea.getBoundingClientRect();

  return getTextareaOffsetAtPoint(
    textarea,
    rect.left + metrics.paddingLeft + 1,
    rect.top + metrics.paddingTop + 1,
  );
}

export function scrollTextareaToOffset(
  textarea: HTMLTextAreaElement,
  offset: number,
  options: { block?: TextareaScrollBlock } = {},
) {
  const metrics = getTextareaLayoutMetrics(textarea);
  const visualLine = getTextareaVisualLineForOffset(textarea, offset, metrics);
  const lineTop = visualLine * metrics.lineHeight;
  const block = options.block ?? "center";
  const nextScrollTop =
    block === "start"
      ? lineTop
      : lineTop - textarea.clientHeight / 2 + metrics.lineHeight;

  textarea.scrollTop = Math.max(0, nextScrollTop);
}
