type TextareaScrollBlock = "center" | "start";

type TextareaMetrics = {
  contentWidth: number;
  lineHeight: number;
  paddingLeft: number;
  paddingTop: number;
};

type TextareaSourceRange = {
  end: number;
  start: number;
};

type ContentPoint = {
  height: number;
  x: number;
  y: number;
};

type TextareaMeasurer = {
  maxOffset: number;
  metrics: TextareaMetrics;
  contentPoint: (offset: number) => ContentPoint;
  lineTop: (offset: number) => number;
  offsetAtContentPoint: (contentX: number, contentY: number) => number;
  offsetAtContentY: (contentY: number) => number;
  scalar: (offset: number) => number;
};

// A hidden mirror element that wraps text pixel-identically to the editor
// textarea. The browser wraps a textarea at word boundaries, which a purely
// analytic "characters per column" estimate cannot reproduce, so all
// offset <-> pixel math is measured against this element instead. This is the
// well-known "textarea-caret-position" technique.
let mirrorElement: HTMLDivElement | undefined;
let mirrorTextNode: Text | undefined;
let mirrorValue: string | null = null;
let mirrorLayoutKey = "";
let measurementRange: Range | undefined;

// Appended after the textarea value so the final line always has measurable
// geometry even when the value ends with a newline (a trailing newline is not
// guaranteed to lay out an empty line). It is zero-width, so it never affects
// wrapping or horizontal measurements.
const MIRROR_SENTINEL = "​";

const MIRROR_COPIED_STYLE_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "font-feature-settings",
  "font-kerning",
  "font-variation-settings",
  "letter-spacing",
  "line-height",
  "tab-size",
  "text-indent",
  "text-transform",
  "text-rendering",
  "word-spacing",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
];

function parsePixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getTextareaMetrics(textarea: HTMLTextAreaElement): TextareaMetrics {
  const styles = window.getComputedStyle(textarea);
  const paddingLeft = parsePixels(styles.paddingLeft);
  const paddingRight = parsePixels(styles.paddingRight);
  const paddingTop = parsePixels(styles.paddingTop);
  const fontSize = parsePixels(styles.fontSize) || 14;
  const lineHeight = parsePixels(styles.lineHeight) || fontSize * 1.5;
  const contentWidth = Math.max(1, textarea.clientWidth - paddingLeft - paddingRight);

  return {
    contentWidth,
    lineHeight,
    paddingLeft,
    paddingTop,
  };
}

function ensureMirrorElement(): HTMLDivElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  if (!mirrorElement) {
    const element = document.createElement("div");
    element.setAttribute("aria-hidden", "true");

    const style = element.style;
    style.position = "fixed";
    style.top = "0px";
    style.left = "0px";
    style.visibility = "hidden";
    style.pointerEvents = "none";
    style.zIndex = "-1";
    style.margin = "0px";
    style.border = "0";
    style.boxSizing = "content-box";
    style.overflow = "hidden";
    style.whiteSpace = "pre-wrap";
    style.overflowWrap = "break-word";
    style.wordBreak = "normal";

    mirrorElement = element;
  }

  if (!mirrorElement.isConnected) {
    document.body.appendChild(mirrorElement);
    mirrorValue = null;
    mirrorLayoutKey = "";
  }

  return mirrorElement;
}

// Syncs the mirror so its wrapping matches the textarea, returning whether it is
// ready to measure. Style copying and text updates are skipped when nothing
// relevant changed, so repeated calls during a scroll gesture stay cheap.
function syncMirror(textarea: HTMLTextAreaElement): boolean {
  const mirror = ensureMirrorElement();

  if (!mirror) {
    return false;
  }

  const styles = window.getComputedStyle(textarea);
  const paddingLeft = parsePixels(styles.paddingLeft);
  const paddingRight = parsePixels(styles.paddingRight);
  const contentWidth = Math.max(1, textarea.clientWidth - paddingLeft - paddingRight);
  const layoutKey = [
    contentWidth,
    styles.fontFamily,
    styles.fontSize,
    styles.fontWeight,
    styles.fontStyle,
    styles.letterSpacing,
    styles.lineHeight,
    styles.tabSize,
    styles.paddingTop,
    styles.paddingLeft,
    styles.textTransform,
    styles.wordSpacing,
  ].join("|");

  if (layoutKey !== mirrorLayoutKey) {
    for (const property of MIRROR_COPIED_STYLE_PROPERTIES) {
      mirror.style.setProperty(property, styles.getPropertyValue(property));
    }

    mirror.style.width = `${contentWidth}px`;
    mirrorLayoutKey = layoutKey;
  }

  const value = textarea.value;

  if (value !== mirrorValue) {
    mirror.textContent = value + MIRROR_SENTINEL;
    mirrorTextNode = mirror.firstChild as Text;
    mirrorValue = value;
  }

  return Boolean(mirrorTextNode);
}

function createMeasurer(textarea: HTMLTextAreaElement): TextareaMeasurer | null {
  if (!syncMirror(textarea) || !mirrorElement || !mirrorTextNode) {
    return null;
  }

  const mirror = mirrorElement;
  const node = mirrorTextNode;
  const metrics = getTextareaMetrics(textarea);
  const mirrorRect = mirror.getBoundingClientRect();
  const originLeft = mirrorRect.left + metrics.paddingLeft;
  const originTop = mirrorRect.top + metrics.paddingTop;
  const maxOffset = textarea.value.length;

  measurementRange ??= document.createRange();
  const range = measurementRange;

  function rectAt(offset: number) {
    const index = clamp(offset, 0, node.length - 1);

    range.setStart(node, index);
    range.setEnd(node, index + 1);

    const rects = range.getClientRects();

    return rects.length ? rects[0] : range.getBoundingClientRect();
  }

  function contentPoint(offset: number): ContentPoint {
    const rect = rectAt(offset);

    return {
      height: rect.height || metrics.lineHeight,
      x: rect.left - originLeft,
      y: rect.top - originTop,
    };
  }

  function lineTop(offset: number) {
    return contentPoint(offset).y;
  }

  function lineIndex(offset: number) {
    return Math.round(lineTop(offset) / metrics.lineHeight);
  }

  function scalar(offset: number) {
    const point = contentPoint(offset);

    return (
      Math.round(point.y / metrics.lineHeight) +
      clamp(point.x / metrics.contentWidth, 0, 1)
    );
  }

  // First offset whose visual line is at or below `contentY`.
  function offsetAtContentY(contentY: number) {
    const targetLine = Math.max(0, Math.round(contentY / metrics.lineHeight));
    let low = 0;
    let high = maxOffset;

    while (low < high) {
      const middle = (low + high) >> 1;

      if (lineIndex(middle) < targetLine) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    return low;
  }

  function offsetAtContentPoint(contentX: number, contentY: number) {
    const lineStart = offsetAtContentY(contentY);
    const targetLine = lineIndex(lineStart);
    let best = lineStart;

    for (let offset = lineStart; offset <= maxOffset; offset += 1) {
      const point = contentPoint(offset);

      if (Math.round(point.y / metrics.lineHeight) !== targetLine) {
        break;
      }

      if (contentX <= point.x + point.height / 2) {
        return offset;
      }

      best = offset + 1;
    }

    return Math.min(best, maxOffset);
  }

  return {
    contentPoint,
    lineTop,
    maxOffset,
    metrics,
    offsetAtContentPoint,
    offsetAtContentY,
    scalar,
  };
}

export function getTextareaOffsetAtPoint(
  textarea: HTMLTextAreaElement,
  clientX: number,
  clientY: number,
) {
  const measurer = createMeasurer(textarea);

  if (!measurer) {
    return 0;
  }

  const rect = textarea.getBoundingClientRect();
  const contentX =
    clientX - rect.left - measurer.metrics.paddingLeft + textarea.scrollLeft;
  const contentY =
    clientY - rect.top - measurer.metrics.paddingTop + textarea.scrollTop;

  return measurer.offsetAtContentPoint(contentX, contentY);
}

export function getTextareaVisibleStartOffset(textarea: HTMLTextAreaElement) {
  const measurer = createMeasurer(textarea);

  if (!measurer) {
    return 0;
  }

  return measurer.offsetAtContentY(textarea.scrollTop + 1);
}

export function getTextareaViewportAnchorOffset(
  textarea: HTMLTextAreaElement,
  viewportProgress: number,
) {
  const measurer = createMeasurer(textarea);

  if (!measurer) {
    return 0;
  }

  const contentHeight = Math.max(
    1,
    textarea.clientHeight - measurer.metrics.paddingTop,
  );
  const contentY =
    textarea.scrollTop + contentHeight * clamp(viewportProgress, 0, 1);

  return measurer.offsetAtContentY(contentY);
}

export function getTextareaVisualProgressForRange(
  textarea: HTMLTextAreaElement,
  offset: number,
  range: TextareaSourceRange,
) {
  const measurer = createMeasurer(textarea);

  if (!measurer) {
    return 0;
  }

  const start = clamp(range.start, 0, measurer.maxOffset);
  const end = clamp(range.end, start, measurer.maxOffset);
  const clampedOffset = clamp(offset, start, end);
  const startScalar = measurer.scalar(start);
  const endScalar = measurer.scalar(end);
  const offsetScalar = measurer.scalar(clampedOffset);
  const span = Math.max(0.0001, endScalar - startScalar);

  return clamp((offsetScalar - startScalar) / span, 0, 1);
}

export function getTextareaOffsetAtVisualProgress(
  textarea: HTMLTextAreaElement,
  range: TextareaSourceRange,
  progress: number,
) {
  const measurer = createMeasurer(textarea);

  if (!measurer) {
    return clamp(range.start, 0, textarea.value.length);
  }

  const start = clamp(range.start, 0, measurer.maxOffset);
  const end = clamp(range.end, start, measurer.maxOffset);

  if (end <= start) {
    return start;
  }

  const startScalar = measurer.scalar(start);
  const endScalar = measurer.scalar(end);
  const span = Math.max(0.0001, endScalar - startScalar);
  const targetScalar = startScalar + clamp(progress, 0, 1) * span;
  let low = start;
  let high = end;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (measurer.scalar(middle) < targetScalar) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return low;
}

export function getTextareaClientPointForOffset(
  textarea: HTMLTextAreaElement,
  offset: number,
) {
  const measurer = createMeasurer(textarea);
  const rect = textarea.getBoundingClientRect();

  if (!measurer) {
    return {
      x: rect.left + 8,
      y: rect.top + 8,
    };
  }

  const point = measurer.contentPoint(offset);
  const x =
    rect.left + measurer.metrics.paddingLeft + point.x - textarea.scrollLeft;
  const y =
    rect.top + measurer.metrics.paddingTop + point.y - textarea.scrollTop;

  return {
    x: Math.min(rect.right - 8, Math.max(rect.left + 8, x)),
    y: Math.min(rect.bottom - 8, Math.max(rect.top + 8, y + point.height)),
  };
}

export function scrollTextareaToOffset(
  textarea: HTMLTextAreaElement,
  offset: number,
  options: { block?: TextareaScrollBlock; viewportProgress?: number } = {},
) {
  const measurer = createMeasurer(textarea);

  if (!measurer) {
    return;
  }

  const lineTop = measurer.lineTop(offset);
  const lineHeight = measurer.metrics.lineHeight;
  const block = options.block ?? "center";
  const nextScrollTop =
    typeof options.viewportProgress === "number"
      ? lineTop -
        Math.max(1, textarea.clientHeight - measurer.metrics.paddingTop) *
          clamp(options.viewportProgress, 0, 1)
      : block === "start"
        ? lineTop
        : lineTop - textarea.clientHeight / 2 + lineHeight;

  textarea.scrollTop = Math.max(0, nextScrollTop);
}
