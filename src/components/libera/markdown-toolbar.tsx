import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  ImageIcon,
  Italic,
  Link,
  List,
  Maximize2,
  Minimize2,
  Sigma,
  Sparkles,
  Underline,
  ZoomIn,
} from "lucide-react";
import { useRef } from "react";

type MarkdownToolbarProps = {
  markdownZoom: number;
  onFixChatGptEquations: () => void;
  onInsert: (before: string, after?: string, placeholder?: string) => void;
  onInsertExistingImage: () => void;
  onInsertImage: (file: File) => Promise<void>;
  onMarkdownZoomChange: (zoom: number) => void;
  onTogglePreviewFullscreen: () => void;
  previewFullscreen: boolean;
};

export function MarkdownToolbar({
  markdownZoom,
  onFixChatGptEquations,
  onInsert,
  onInsertExistingImage,
  onInsertImage,
  onMarkdownZoomChange,
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
      <button className="toolbar-button" type="button" onClick={() => onInsert("**", "**")}>
        <Bold aria-hidden className="h-4 w-4" />
        Bold
      </button>
      <button className="toolbar-button" type="button" onClick={() => onInsert("_", "_")}>
        <Italic aria-hidden className="h-4 w-4" />
        Italic
      </button>
      <button className="toolbar-button" type="button" onClick={() => onInsert("<u>", "</u>")}>
        <Underline aria-hidden className="h-4 w-4" />
        Underline
      </button>
      <button className="toolbar-button" type="button" onClick={() => onInsert("# ", "", "Heading")}>
        <Heading1 aria-hidden className="h-4 w-4" />
        H1
      </button>
      <button className="toolbar-button" type="button" onClick={() => onInsert("## ", "", "Heading")}>
        <Heading2 aria-hidden className="h-4 w-4" />
        H2
      </button>
      <button className="toolbar-button" type="button" onClick={() => onInsert("- ", "", "List item")}>
        <List aria-hidden className="h-4 w-4" />
        List
      </button>
      <button className="toolbar-button" type="button" onClick={() => onInsert("[", "](https://)", "link")}>
        <Link aria-hidden className="h-4 w-4" />
        Link
      </button>
      <button
        className="toolbar-button"
        type="button"
        onClick={() => imageInputRef.current?.click()}
      >
        <ImageIcon aria-hidden className="h-4 w-4" />
        Image from File
      </button>
      <button
        className="toolbar-button"
        type="button"
        onClick={onInsertExistingImage}
      >
        <ImageIcon aria-hidden className="h-4 w-4" />
        Image from Existing
      </button>
      <button className="toolbar-button" type="button" onClick={() => onInsert("`", "`", "code")}>
        <Code2 aria-hidden className="h-4 w-4" />
        Code
      </button>
      <button className="toolbar-button" type="button" onClick={() => onInsert("$$\n", "\n$$", "x = y")}>
        <Sigma aria-hidden className="h-4 w-4" />
        Math
      </button>
      <button className="toolbar-button" type="button" onClick={onFixChatGptEquations}>
        <Sparkles aria-hidden className="h-4 w-4" />
        ChatGPT Eqfix
      </button>
      <label className="inline-flex shrink-0 items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm font-medium text-zinc-700">
        <ZoomIn aria-hidden className="h-4 w-4" />
        <span>Zoom</span>
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
        className="toolbar-button"
        type="button"
        aria-pressed={previewFullscreen}
        onClick={onTogglePreviewFullscreen}
      >
        {previewFullscreen ? (
          <Minimize2 aria-hidden className="h-4 w-4" />
        ) : (
          <Maximize2 aria-hidden className="h-4 w-4" />
        )}
        {previewFullscreen ? "Exit" : "Preview"}
      </button>
    </div>
  );
}
