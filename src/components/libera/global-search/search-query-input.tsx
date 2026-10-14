"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { encodeFilePath } from "@/components/libera/api-client";
import {
  MAX_SEARCH_QUERY_IMAGES,
  type SearchImageRef,
  type SearchQueryPart,
} from "@/lib/global-search";

/** Dragged from a search result: an image to put in the query. */
export const SEARCH_IMAGE_DRAG_MIME = "application/x-libera-search-image";
const LIBRARY_FILE_DRAG_MIME = "application/x-libera-file-path";
const IMAGE_FILE_PATTERN = /\.(png|jpe?g|gif|webp)$/i;
// The model sees images at a few hundred pixels; smaller uploads keep requests quick.
const UPLOAD_MAX_SIDE = 1280;

export type SearchQueryInputHandle = {
  focus: () => void;
  clear: () => void;
  insertImage: (image: SearchImageRef) => void;
  setParts: (parts: SearchQueryPart[]) => void;
  getParts: () => SearchQueryPart[];
};

export function searchImageThumbnail(image: SearchImageRef) {
  if (image.kind === "upload") return image.dataUrl;
  if (image.kind === "gallery") {
    return `/api/gallery/raw/${image.path.split("/").map(encodeURIComponent).join("/")}?thumbnail=1`;
  }
  return `/api/files/raw/${encodeFilePath(image.path)}`;
}

/** Read a pasted or dropped image, scaled down, as a JPEG data URL. */
export async function imageFileToDataUrl(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, UPLOAD_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not read the image.");
    // Transparent areas become white rather than black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  } finally {
    bitmap.close();
  }
}

let chipCounter = 0;

/**
 * The search box. Text and images read in order, so "photos like [image] at
 * night" keeps its meaning. Images are chips the caret steps over and
 * Backspace removes as a whole; the DOM is the source of truth and is read
 * back into query parts on every change.
 */
export function SearchQueryInput({
  ref,
  placeholder,
  onChange,
  onSubmit,
  onArrowDown,
  onEscape,
  onImageAdded,
  onError,
}: {
  ref?: Ref<SearchQueryInputHandle>;
  placeholder: string;
  onChange: (parts: SearchQueryPart[]) => void;
  onSubmit: () => void;
  onArrowDown?: () => void;
  onEscape?: () => void;
  onImageAdded?: () => void;
  onError?: (message: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const imagesRef = useRef(new Map<string, SearchImageRef>());
  const [empty, setEmpty] = useState(true);
  const callbacks = useRef({ onChange, onImageAdded, onError });
  useEffect(() => {
    callbacks.current = { onChange, onImageAdded, onError };
  });

  function readParts(): SearchQueryPart[] {
    const parts: SearchQueryPart[] = [];
    const pushText = (text: string) => {
      const last = parts.at(-1);
      if (last?.type === "text") last.text += text;
      else parts.push({ type: "text", text });
    };
    const walk = (node: Node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          pushText((child.textContent ?? "").replace(/ /g, " "));
        } else if (child instanceof HTMLElement) {
          const id = child.dataset.searchImage;
          const image = id ? imagesRef.current.get(id) : undefined;
          if (image) parts.push({ type: "image", image });
          else if (child.tagName === "BR") pushText(" ");
          else {
            if (child.tagName === "DIV" || child.tagName === "P") pushText(" ");
            walk(child);
          }
        }
      }
    };
    if (editorRef.current) walk(editorRef.current);
    return parts.filter((part) => part.type === "image" || part.text.length > 0);
  }

  function emit() {
    const parts = readParts();
    setEmpty(!parts.some((part) => part.type === "image" || part.text.trim()));
    // Forget images whose chips were deleted.
    const present = new Set(Array.from(editorRef.current?.querySelectorAll<HTMLElement>("[data-search-image]") ?? [], (chip) => chip.dataset.searchImage ?? ""));
    for (const id of imagesRef.current.keys()) if (!present.has(id)) imagesRef.current.delete(id);
    callbacks.current.onChange(parts);
  }

  function createChip(image: SearchImageRef) {
    chipCounter += 1;
    const id = `image-${chipCounter}`;
    imagesRef.current.set(id, image);

    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.searchImage = id;
    chip.className = "libera-search-chip";
    chip.title = image.name;

    const thumbnail = document.createElement("img");
    thumbnail.src = searchImageThumbnail(image);
    thumbnail.alt = "";
    thumbnail.draggable = false;

    const label = document.createElement("span");
    label.className = "libera-search-chip-label";
    label.textContent = image.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "libera-search-chip-remove";
    remove.setAttribute("aria-label", `Remove ${image.name} from the search`);
    remove.textContent = "×";
    remove.addEventListener("mousedown", (event) => event.preventDefault());
    remove.addEventListener("click", () => {
      chip.remove();
      emit();
      editorRef.current?.focus();
    });

    chip.append(thumbnail, label, remove);
    return chip;
  }

  function caretRangeInEditor() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range : null;
  }

  function placeCaretAfter(node: Node) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertImage(image: SearchImageRef, at?: Range | null) {
    const editor = editorRef.current;
    if (!editor) return;
    if (imagesRef.current.size >= MAX_SEARCH_QUERY_IMAGES) {
      callbacks.current.onError?.(`A search can include up to ${MAX_SEARCH_QUERY_IMAGES} images.`);
      return;
    }

    const chip = createChip(image);
    const spacer = document.createTextNode(" ");
    const range = at ?? caretRangeInEditor();
    if (range) {
      range.deleteContents();
      range.insertNode(spacer);
      range.insertNode(chip);
    } else {
      const last = editor.lastChild;
      if (last?.nodeType === Node.TEXT_NODE && last.textContent && !/\s$/.test(last.textContent)) {
        editor.append(document.createTextNode(" "));
      }
      editor.append(chip, spacer);
    }
    editor.focus();
    placeCaretAfter(spacer);
    emit();
    callbacks.current.onImageAdded?.();
  }

  function setParts(parts: SearchQueryPart[]) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.replaceChildren();
    imagesRef.current.clear();
    for (const part of parts) {
      if (part.type === "text") editor.append(document.createTextNode(part.text));
      else editor.append(createChip(part.image), document.createTextNode(" "));
    }
    emit();
  }

  useImperativeHandle(ref, () => ({
    focus: () => {
      const editor = editorRef.current;
      if (!editor) return;
      // Coming back to the box continues the query: the caret goes to the end.
      const hadFocus = document.activeElement === editor;
      editor.focus();
      const selection = window.getSelection();
      if (selection && (!hadFocus || !caretRangeInEditor())) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    },
    clear: () => setParts([]),
    insertImage: (image) => insertImage(image),
    setParts,
    getParts: readParts,
  }));

  async function addImageFiles(files: File[], at?: Range | null) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      try {
        insertImage({ kind: "upload", name: file.name || "Pasted image", dataUrl: await imageFileToDataUrl(file) }, at);
        at = null;
      } catch {
        callbacks.current.onError?.(`Could not read ${file.name || "the image"}.`);
      }
    }
  }

  function dropRange(x: number, y: number) {
    const range = document.caretRangeFromPoint?.(x, y);
    return range && editorRef.current?.contains(range.startContainer) ? range : null;
  }

  return (
    <div className="relative min-w-0 flex-1">
      {empty ? (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 right-0 block truncate py-0.5 text-[15px] leading-7 text-muted-foreground">
          {placeholder}
        </span>
      ) : null}
      <div
        ref={editorRef}
        role="textbox"
        aria-label="Search your library"
        aria-multiline="false"
        aria-placeholder={placeholder}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        className="libera-search-input min-h-7 max-h-32 overflow-y-auto py-0.5 text-[15px] leading-7 outline-none"
        onInput={emit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          } else if (event.key === "ArrowDown" && onArrowDown) {
            event.preventDefault();
            onArrowDown();
          } else if (event.key === "Escape" && onEscape) {
            event.preventDefault();
            onEscape();
          }
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
          event.preventDefault();
          if (files.length) {
            void addImageFiles(files, caretRangeInEditor());
            return;
          }
          const text = event.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ");
          if (text) document.execCommand("insertText", false, text);
        }}
        onDragOver={(event) => {
          const types = event.dataTransfer.types;
          if (types.includes("Files") || types.includes(SEARCH_IMAGE_DRAG_MIME) || types.includes(LIBRARY_FILE_DRAG_MIME)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          const range = dropRange(event.clientX, event.clientY);
          const searchImage = event.dataTransfer.getData(SEARCH_IMAGE_DRAG_MIME);
          const libraryPath = event.dataTransfer.getData(LIBRARY_FILE_DRAG_MIME);
          const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));

          if (searchImage) {
            event.preventDefault();
            try {
              insertImage(JSON.parse(searchImage) as SearchImageRef, range);
            } catch {
              // Not one of ours.
            }
          } else if (libraryPath && IMAGE_FILE_PATTERN.test(libraryPath)) {
            event.preventDefault();
            insertImage({ kind: "file", path: libraryPath, name: libraryPath.split("/").at(-1) ?? libraryPath }, range);
          } else if (files.length) {
            event.preventDefault();
            void addImageFiles(files, range);
          }
        }}
      />
    </div>
  );
}
