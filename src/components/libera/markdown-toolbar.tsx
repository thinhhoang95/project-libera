import {
  Bold,
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
  Scissors,
  Sigma,
  Sparkles,
  Underline,
  ZoomIn,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
const ENUMERATE_HEADINGS_MENU_GAP = 6;

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
  const enumerateButtonRef = useRef<HTMLButtonElement>(null);
  const enumerateMenuRef = useRef<HTMLDivElement>(null);
  const [enumerateMenuOpen, setEnumerateMenuOpen] = useState(false);
  const [enumerateMenuPosition, setEnumerateMenuPosition] = useState({
    left: 0,
    top: 0,
  });
  const [selectedHeadingStart, setSelectedHeadingStart] = useState("1");

  const getEnumerateMenuPosition = useCallback(() => {
    const button = enumerateButtonRef.current;

    if (!button) {
      return null;
    }

    const rect = button.getBoundingClientRect();
    const maxLeft =
      window.innerWidth - ENUMERATE_HEADINGS_MENU_WIDTH - ENUMERATE_HEADINGS_MENU_GAP;

    return {
      left: Math.max(
        ENUMERATE_HEADINGS_MENU_GAP,
        Math.min(rect.left, maxLeft),
      ),
      top: Math.min(
        rect.bottom + ENUMERATE_HEADINGS_MENU_GAP,
        window.innerHeight - ENUMERATE_HEADINGS_MENU_GAP,
      ),
    };
  }, []);

  useEffect(() => {
    if (!enumerateMenuOpen) {
      return;
    }

    function closeEnumerateMenu(event: PointerEvent) {
      const target = event.target;

      if (
        target instanceof Node &&
        (enumerateButtonRef.current?.contains(target) ||
          enumerateMenuRef.current?.contains(target))
      ) {
        return;
      }

      setEnumerateMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setEnumerateMenuOpen(false);
      }
    }

    function repositionEnumerateMenu() {
      const nextPosition = getEnumerateMenuPosition();

      if (nextPosition) {
        setEnumerateMenuPosition(nextPosition);
      }
    }

    window.addEventListener("pointerdown", closeEnumerateMenu);
    window.addEventListener("scroll", repositionEnumerateMenu, true);
    window.addEventListener("resize", repositionEnumerateMenu);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", closeEnumerateMenu);
      window.removeEventListener("scroll", repositionEnumerateMenu, true);
      window.removeEventListener("resize", repositionEnumerateMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enumerateMenuOpen, getEnumerateMenuPosition]);

  function toggleEnumerateMenu() {
    if (enumerateMenuOpen) {
      setEnumerateMenuOpen(false);
      return;
    }

    const nextPosition = getEnumerateMenuPosition();

    if (nextPosition) {
      setEnumerateMenuPosition(nextPosition);
    }

    setEnumerateMenuOpen(true);
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

  return (
    <div className="relative z-10 flex max-w-full flex-nowrap items-center gap-2 overflow-x-auto border-b border-border bg-card px-4 py-2 whitespace-nowrap shadow-sm">
      <input
        ref={imageInputRef}
        className="hidden"
        type="file"
        accept=".png,.jpg,.jpeg,.gif,.webp"
        onChange={() => void handleImageChange()}
      />
      <button
        aria-label="Bold"
        className="toolbar-button"
        title="Bold"
        type="button"
        onClick={() => onInsert("**", "**")}
      >
        <Bold aria-hidden className="h-4 w-4" />
      </button>
      <button
        aria-label="Italic"
        className="toolbar-button"
        title="Italic"
        type="button"
        onClick={() => onInsert("_", "_")}
      >
        <Italic aria-hidden className="h-4 w-4" />
      </button>
      <button
        aria-label="Underline"
        className="toolbar-button"
        title="Underline"
        type="button"
        onClick={() => onInsert("<u>", "</u>")}
      >
        <Underline aria-hidden className="h-4 w-4" />
      </button>
      <button
        aria-label="Highlight"
        className="toolbar-button"
        title="Highlight"
        type="button"
        onClick={() => onInsert(">>> ", " <<<", "highlight")}
      >
        <Highlighter aria-hidden className="h-4 w-4" />
      </button>
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
    </div>
  );
}
