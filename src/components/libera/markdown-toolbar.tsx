import {
  Bold,
  ChevronDown,
  ChevronUp,
  Code2,
  Heading1,
  Heading2,
  Highlighter,
  ImagePlus,
  Images,
  Italic,
  Link,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Palette,
  Scissors,
  Sigma,
  Sparkles,
  Underline,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ColorPalette } from "@/components/libera/color-palette";
import {
  MARKDOWN_HIGHLIGHT_COLORS,
  MARKDOWN_TEXT_COLORS,
  type MarkdownHighlightColor,
  type MarkdownTextColor,
} from "@/lib/markdown-colors";
import type { MarkdownHeadingEnumerationScope } from "@/lib/markdown-heading-enumeration";

type MarkdownToolbarProps = {
  canStartScreenshotSnip: boolean;
  isSlideDeck?: boolean;
  markdownZoom: number;
  onEnumerateHeadings: (
    scope: MarkdownHeadingEnumerationScope,
    startAt?: number,
  ) => void;
  onFixChatGptEquations: () => void;
  onInsert: (before: string, after?: string, placeholder?: string) => void;
  onInsertExistingImage: () => void;
  onInsertFileLink: () => void;
  onInsertImage: (file: File) => Promise<void>;
  onMarkdownZoomChange: (zoom: number) => void;
  onStartScreenshotSnip: () => void;
  onTogglePreviewFullscreen: () => void;
  previewFullscreen: boolean;
};

const ENUMERATE_HEADINGS_MENU_WIDTH = 288;
const HIGHLIGHT_MENU_WIDTH = 160;
const TEXT_COLOR_MENU_WIDTH = 160;
const FLOATING_MENU_GAP = 6;
const FULL_TOOLBAR_BUTTON_COUNT = 17;

function getFloatingMenuPosition(button: HTMLElement | null, width: number) {
  if (!button) {
    return null;
  }

  const rect = button.getBoundingClientRect();
  const maxLeft = window.innerWidth - width - FLOATING_MENU_GAP;

  return {
    left: Math.max(FLOATING_MENU_GAP, Math.min(rect.left, maxLeft)),
    top: Math.min(
      rect.bottom + FLOATING_MENU_GAP,
      window.innerHeight - FLOATING_MENU_GAP,
    ),
  };
}

export function MarkdownToolbar({
  canStartScreenshotSnip,
  isSlideDeck = false,
  markdownZoom,
  onEnumerateHeadings,
  onFixChatGptEquations,
  onInsert,
  onInsertExistingImage,
  onInsertFileLink,
  onInsertImage,
  onMarkdownZoomChange,
  onStartScreenshotSnip,
  onTogglePreviewFullscreen,
  previewFullscreen,
}: MarkdownToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const toolbarMeasureRef = useRef<HTMLDivElement>(null);
  const toolbarRowRef = useRef<HTMLDivElement>(null);
  const highlightButtonRef = useRef<HTMLButtonElement>(null);
  const highlightMenuRef = useRef<HTMLDivElement>(null);
  const textColorButtonRef = useRef<HTMLButtonElement>(null);
  const textColorMenuRef = useRef<HTMLDivElement>(null);
  const enumerateButtonRef = useRef<HTMLButtonElement>(null);
  const enumerateMenuRef = useRef<HTMLDivElement>(null);
  const [highlightMenuOpen, setHighlightMenuOpen] = useState(false);
  const [highlightMenuPosition, setHighlightMenuPosition] = useState({
    left: 0,
    top: 0,
  });
  const [textColorMenuOpen, setTextColorMenuOpen] = useState(false);
  const [textColorMenuPosition, setTextColorMenuPosition] = useState({
    left: 0,
    top: 0,
  });
  const [enumerateMenuOpen, setEnumerateMenuOpen] = useState(false);
  const [enumerateMenuPosition, setEnumerateMenuPosition] = useState({
    left: 0,
    top: 0,
  });
  const [selectedHeadingStart, setSelectedHeadingStart] = useState("1");
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(false);

  const getEnumerateMenuPosition = useCallback(() => {
    return getFloatingMenuPosition(
      enumerateButtonRef.current,
      ENUMERATE_HEADINGS_MENU_WIDTH,
    );
  }, []);

  const getHighlightMenuPosition = useCallback(() => {
    return getFloatingMenuPosition(highlightButtonRef.current, HIGHLIGHT_MENU_WIDTH);
  }, []);

  const getTextColorMenuPosition = useCallback(() => {
    return getFloatingMenuPosition(
      textColorButtonRef.current,
      TEXT_COLOR_MENU_WIDTH,
    );
  }, []);

  useEffect(() => {
    const measure = toolbarMeasureRef.current;
    const row = toolbarRowRef.current;

    if (!measure || !row) {
      return;
    }

    function updateToolbarCollapse() {
      const measureElement = toolbarMeasureRef.current;
      const rowElement = toolbarRowRef.current;

      if (!measureElement || !rowElement) {
        return;
      }

      const nextCollapsed = measureElement.scrollWidth > rowElement.clientWidth + 1;

      setToolbarCollapsed(nextCollapsed);

      if (!nextCollapsed) {
        setToolbarExpanded(false);
      }
    }

    updateToolbarCollapse();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateToolbarCollapse);

      return () => window.removeEventListener("resize", updateToolbarCollapse);
    }

    const observer = new ResizeObserver(updateToolbarCollapse);

    observer.observe(measure);
    observer.observe(row);
    window.addEventListener("resize", updateToolbarCollapse);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateToolbarCollapse);
    };
  }, []);

  useEffect(() => {
    if (!highlightMenuOpen && !textColorMenuOpen && !enumerateMenuOpen) {
      return;
    }

    function closeOpenMenus(event: PointerEvent) {
      const target = event.target;

      if (
        target instanceof Node &&
        (highlightButtonRef.current?.contains(target) ||
          highlightMenuRef.current?.contains(target) ||
          textColorButtonRef.current?.contains(target) ||
          textColorMenuRef.current?.contains(target) ||
          enumerateButtonRef.current?.contains(target) ||
          enumerateMenuRef.current?.contains(target))
      ) {
        return;
      }

      setHighlightMenuOpen(false);
      setTextColorMenuOpen(false);
      setEnumerateMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setHighlightMenuOpen(false);
        setTextColorMenuOpen(false);
        setEnumerateMenuOpen(false);
      }
    }

    function repositionOpenMenus() {
      if (highlightMenuOpen) {
        const nextPosition = getHighlightMenuPosition();

        if (nextPosition) {
          setHighlightMenuPosition(nextPosition);
        }
      }

      if (textColorMenuOpen) {
        const nextPosition = getTextColorMenuPosition();

        if (nextPosition) {
          setTextColorMenuPosition(nextPosition);
        }
      }

      if (enumerateMenuOpen) {
        const nextPosition = getEnumerateMenuPosition();

        if (nextPosition) {
          setEnumerateMenuPosition(nextPosition);
        }
      }
    }

    window.addEventListener("pointerdown", closeOpenMenus);
    window.addEventListener("scroll", repositionOpenMenus, true);
    window.addEventListener("resize", repositionOpenMenus);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", closeOpenMenus);
      window.removeEventListener("scroll", repositionOpenMenus, true);
      window.removeEventListener("resize", repositionOpenMenus);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    enumerateMenuOpen,
    getEnumerateMenuPosition,
    getHighlightMenuPosition,
    getTextColorMenuPosition,
    highlightMenuOpen,
    textColorMenuOpen,
  ]);

  function toggleHighlightMenu() {
    if (highlightMenuOpen) {
      setHighlightMenuOpen(false);
      return;
    }

    const nextPosition = getHighlightMenuPosition();

    if (nextPosition) {
      setHighlightMenuPosition(nextPosition);
    }

    setTextColorMenuOpen(false);
    setEnumerateMenuOpen(false);
    setHighlightMenuOpen(true);
  }

  function toggleTextColorMenu() {
    if (textColorMenuOpen) {
      setTextColorMenuOpen(false);
      return;
    }

    const nextPosition = getTextColorMenuPosition();

    if (nextPosition) {
      setTextColorMenuPosition(nextPosition);
    }

    setHighlightMenuOpen(false);
    setEnumerateMenuOpen(false);
    setTextColorMenuOpen(true);
  }

  function toggleEnumerateMenu() {
    if (enumerateMenuOpen) {
      setEnumerateMenuOpen(false);
      return;
    }

    const nextPosition = getEnumerateMenuPosition();

    if (nextPosition) {
      setEnumerateMenuPosition(nextPosition);
    }

    setHighlightMenuOpen(false);
    setTextColorMenuOpen(false);
    setEnumerateMenuOpen(true);
  }

  function toggleToolbarExpanded() {
    setHighlightMenuOpen(false);
    setTextColorMenuOpen(false);
    setEnumerateMenuOpen(false);
    setToolbarExpanded((current) => !current);
  }

  function selectedHeadingStartValue() {
    const parsed = Number(selectedHeadingStart);

    if (!Number.isFinite(parsed)) {
      return 1;
    }

    return Math.max(1, Math.floor(parsed));
  }

  function enumerateHeadings(
    scope: MarkdownHeadingEnumerationScope,
    startAt?: number,
  ) {
    setEnumerateMenuOpen(false);
    onEnumerateHeadings(scope, startAt);
  }

  function insertHighlight(color: MarkdownHighlightColor) {
    setHighlightMenuOpen(false);
    onInsert(`${color.shortcut}>>> `, " <<<", `${color.label.toLowerCase()} highlight`);
  }

  function insertTextColor(color: MarkdownTextColor) {
    setTextColorMenuOpen(false);
    onInsert(`[color=${color.value}]`, "[/color]", "colored text");
  }

  const fullscreenLabel = isSlideDeck
    ? previewFullscreen
      ? "Exit presentation"
      : "Present slides"
    : previewFullscreen
      ? "Exit preview-only mode"
      : "Preview only";

  async function handleImageChange() {
    const file = imageInputRef.current?.files?.[0];

    if (!file) {
      return;
    }

    await onInsertImage(file);

    if (imageInputRef.current) {
      imageInputRef.current.value = "";
    }
  }

  function renderZoomControl() {
    return (
      <label
        aria-label={`Rendered Markdown text zoom: ${markdownZoom}%`}
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-muted px-3 text-sm font-medium text-foreground"
        title={`Rendered Markdown text zoom: ${markdownZoom}%`}
      >
        <ZoomIn aria-hidden className="h-4 w-4" />
        <input
          className="h-2 w-32 accent-foreground"
          type="range"
          min="75"
          max="150"
          step="5"
          value={markdownZoom}
          aria-label="Rendered Markdown text zoom"
          onChange={(event) => onMarkdownZoomChange(Number(event.target.value))}
        />
        <span className="min-w-10 text-right tabular-nums">{markdownZoom}%</span>
      </label>
    );
  }

  function renderSecondaryControls() {
    return (
      <>
        <button
          aria-label="Insert image from file"
          className="toolbar-button"
          title="Insert image from file"
          type="button"
          onClick={() => imageInputRef.current?.click()}
        >
          <ImagePlus aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Insert existing image"
          className="toolbar-button"
          title="Insert existing image"
          type="button"
          onClick={onInsertExistingImage}
        >
          <Images aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Snip from image or PDF tab"
          className="toolbar-button disabled:cursor-not-allowed disabled:opacity-40"
          title={
            canStartScreenshotSnip
              ? "Snip from image or PDF tab"
              : "Open an image or PDF tab to snip"
          }
          type="button"
          disabled={!canStartScreenshotSnip}
          onClick={onStartScreenshotSnip}
        >
          <Scissors aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Inline code"
          className="toolbar-button"
          title="Inline code"
          type="button"
          onClick={() => onInsert("`", "`", "code")}
        >
          <Code2 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Math block"
          className="toolbar-button"
          title="Math block"
          type="button"
          onClick={() => onInsert("$$\n", "\n$$", "x = y")}
        >
          <Sigma aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Fix ChatGPT equations"
          className="toolbar-button"
          title="Fix ChatGPT equations"
          type="button"
          onClick={onFixChatGptEquations}
        >
          <Sparkles aria-hidden className="h-4 w-4" />
        </button>
        <button
          ref={enumerateButtonRef}
          aria-expanded={enumerateMenuOpen}
          aria-haspopup="menu"
          aria-label="Enumerate Headings"
          className="toolbar-button"
          title="Enumerate Headings"
          type="button"
          onClick={toggleEnumerateMenu}
        >
          <ListOrdered aria-hidden className="h-4 w-4" />
        </button>
        {renderZoomControl()}
      </>
    );
  }

  function renderFullscreenButton() {
    return (
      <button
        aria-label={fullscreenLabel}
        className="toolbar-button"
        type="button"
        aria-pressed={previewFullscreen}
        title={fullscreenLabel}
        onClick={onTogglePreviewFullscreen}
      >
        {previewFullscreen ? (
          <Minimize2 aria-hidden className="h-4 w-4" />
        ) : (
          <Maximize2 aria-hidden className="h-4 w-4" />
        )}
      </button>
    );
  }

  return (
    <div className="relative z-40 border-b border-border bg-card px-4 py-2 shadow-sm">
      <input
        ref={imageInputRef}
        className="hidden"
        type="file"
        accept=".png,.jpg,.jpeg,.gif,.webp"
        onChange={() => void handleImageChange()}
      />
      <div
        ref={toolbarMeasureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-4 top-2 flex max-w-none items-center gap-2 whitespace-nowrap"
      >
        {Array.from({ length: FULL_TOOLBAR_BUTTON_COUNT }, (_, index) => (
          <span className="toolbar-button" key={index} />
        ))}
        <span className="inline-flex h-9 w-56 shrink-0" />
      </div>
      <div
        ref={toolbarRowRef}
        className="flex max-w-full flex-nowrap items-center gap-2 overflow-hidden whitespace-nowrap"
      >
        <button
          aria-label="Bold"
          className="toolbar-button"
          title="Bold (Ctrl/Cmd+B)"
          type="button"
          onClick={() => onInsert("**", "**")}
        >
          <Bold aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Italic"
          className="toolbar-button"
          title="Italic (Ctrl/Cmd+I)"
          type="button"
          onClick={() => onInsert("_", "_")}
        >
          <Italic aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Underline"
          className="toolbar-button"
          title="Underline (Ctrl/Cmd+U)"
          type="button"
          onClick={() => onInsert("<u>", "</u>")}
        >
          <Underline aria-hidden className="h-4 w-4" />
        </button>
        <button
          ref={highlightButtonRef}
          aria-expanded={highlightMenuOpen}
          aria-haspopup="listbox"
          aria-label="Highlight"
          className="toolbar-button"
          title="Highlight"
          type="button"
          onClick={toggleHighlightMenu}
        >
          <Highlighter aria-hidden className="h-4 w-4" />
        </button>
        {highlightMenuOpen ? (
          <div
            ref={highlightMenuRef}
            className="fixed z-50 w-40 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-card p-1 shadow-lg"
            style={{
              left: highlightMenuPosition.left,
              top: highlightMenuPosition.top,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <ColorPalette
              ariaLabel="Highlight colors"
              colors={MARKDOWN_HIGHLIGHT_COLORS}
              optionLabel="highlight color"
              onSelect={insertHighlight}
            />
          </div>
        ) : null}
        <button
          ref={textColorButtonRef}
          aria-expanded={textColorMenuOpen}
          aria-haspopup="listbox"
          aria-label="Text color"
          className="toolbar-button"
          title="Text color"
          type="button"
          onClick={toggleTextColorMenu}
        >
          <Palette aria-hidden className="h-4 w-4" />
        </button>
        {textColorMenuOpen ? (
          <div
            ref={textColorMenuRef}
            className="fixed z-50 w-40 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-card p-1 shadow-lg"
            style={{
              left: textColorMenuPosition.left,
              top: textColorMenuPosition.top,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <ColorPalette
              ariaLabel="Text colors"
              colors={MARKDOWN_TEXT_COLORS}
              optionLabel="text color"
              onSelect={insertTextColor}
            />
          </div>
        ) : null}
        <button
          aria-label="Heading 1"
          className="toolbar-button"
          title="Heading 1"
          type="button"
          onClick={() => onInsert("# ", "", "Heading")}
        >
          <Heading1 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Heading 2"
          className="toolbar-button"
          title="Heading 2"
          type="button"
          onClick={() => onInsert("## ", "", "Heading")}
        >
          <Heading2 aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Bulleted list"
          className="toolbar-button"
          title="Bulleted list"
          type="button"
          onClick={() => onInsert("- ", "", "List item")}
        >
          <List aria-hidden className="h-4 w-4" />
        </button>
        <button
          aria-label="Link"
          className="toolbar-button"
          title="Link"
          type="button"
          onClick={onInsertFileLink}
        >
          <Link aria-hidden className="h-4 w-4" />
        </button>
        {toolbarCollapsed ? (
          <button
            aria-expanded={toolbarExpanded}
            aria-label={toolbarExpanded ? "Collapse toolbar" : "Expand toolbar"}
            className="toolbar-button"
            title={toolbarExpanded ? "Collapse toolbar" : "Expand toolbar"}
            type="button"
            onClick={toggleToolbarExpanded}
          >
            {toolbarExpanded ? (
              <ChevronUp aria-hidden className="h-4 w-4" />
            ) : (
              <ChevronDown aria-hidden className="h-4 w-4" />
            )}
          </button>
        ) : (
          renderSecondaryControls()
        )}
        {renderFullscreenButton()}
      </div>
      {toolbarCollapsed && toolbarExpanded ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
          {renderSecondaryControls()}
        </div>
      ) : null}
      {enumerateMenuOpen ? (
        <div
          ref={enumerateMenuRef}
          className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-card p-1 text-sm shadow-lg"
          role="menu"
          style={{
            left: enumerateMenuPosition.left,
            top: enumerateMenuPosition.top,
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left font-medium text-foreground hover:bg-muted"
            type="button"
            role="menuitem"
            onClick={() => enumerateHeadings("all", 1)}
          >
            <ListOrdered aria-hidden className="h-4 w-4 text-muted-foreground" />
            Enumerate All Headings
          </button>
          <form
            className="mt-1 border-t border-border px-2 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              enumerateHeadings("selected", selectedHeadingStartValue());
            }}
          >
            <label
              className="block text-xs font-medium text-muted-foreground"
              htmlFor="enumerate-selected-headings-start"
            >
              Enumerate Selected Headings
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="enumerate-selected-headings-start"
                className="h-8 min-w-0 flex-1 rounded-xl border border-border bg-card px-2 text-sm outline-none focus:border-input"
                type="number"
                min="1"
                step="1"
                value={selectedHeadingStart}
                aria-label="Selected heading start value"
                onChange={(event) => setSelectedHeadingStart(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setEnumerateMenuOpen(false);
                  }
                }}
              />
              <button
                className="inline-flex h-8 shrink-0 items-center rounded bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                type="submit"
              >
                Apply
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
