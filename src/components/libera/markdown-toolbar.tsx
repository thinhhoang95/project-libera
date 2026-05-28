import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  ImagePlus,
  Images,
  Italic,
  Link,
  List,
  Maximize2,
  Minimize2,
  Scissors,
  Sigma,
  Sparkles,
  Underline,
  ZoomIn,
} from "lucide-react";
import { useRef } from "react";

type MarkdownToolbarProps = {
  canStartScreenshotSnip: boolean;
  markdownZoom: number;
  onFixChatGptEquations: () => void;
  onInsert: (before: string, after?: string, placeholder?: string) => void;
  onInsertExistingImage: () => void;
  onInsertImage: (file: File) => Promise<void>;
  onMarkdownZoomChange: (zoom: number) => void;
  onStartScreenshotSnip: () => void;
  onTogglePreviewFullscreen: () => void;
  previewFullscreen: boolean;
};

export function MarkdownToolbar({
  canStartScreenshotSnip,
  markdownZoom,
  onFixChatGptEquations,
  onInsert,
  onInsertExistingImage,
  onInsertImage,
  onMarkdownZoomChange,
  onStartScreenshotSnip,
  onTogglePreviewFullscreen,
  previewFullscreen,
}: MarkdownToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);

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
    <div className="flex max-w-full flex-nowrap items-center gap-2 overflow-x-auto border-b border-zinc-200 bg-white px-4 py-2 whitespace-nowrap">
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
        onClick={() => onInsert("[", "](https://)", "link")}
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
      <label
        aria-label={`Rendered Markdown text zoom: ${markdownZoom}%`}
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 text-sm font-medium text-zinc-700"
        title={`Rendered Markdown text zoom: ${markdownZoom}%`}
      >
        <ZoomIn aria-hidden className="h-4 w-4" />
        <input
          className="h-2 w-32 accent-zinc-900"
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
        aria-label={previewFullscreen ? "Exit preview-only mode" : "Preview only"}
        className="toolbar-button"
        type="button"
        aria-pressed={previewFullscreen}
        title={previewFullscreen ? "Exit preview-only mode" : "Preview only"}
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
