import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  ImageIcon,
  Italic,
  Link,
  List,
  Sigma,
  Underline,
} from "lucide-react";
import { useRef } from "react";

type MarkdownToolbarProps = {
  onInsert: (before: string, after?: string, placeholder?: string) => void;
  onInsertExistingImage: () => void;
  onInsertImage: (file: File) => Promise<void>;
};

export function MarkdownToolbar({
  onInsert,
  onInsertExistingImage,
  onInsertImage,
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
    <div className="flex flex-wrap gap-2 border-b border-zinc-200 bg-white px-4 py-2">
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
    </div>
  );
}
