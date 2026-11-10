import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { looksLikeImageFile } from "../image-insert";
import { pasteStaysLiteral, trackRange, type TrackedRange } from "./markdown-paste";

/* Images pasted from the clipboard or dropped from the file manager into a
 * .tex file (Source and Visual mode alike): the files go to `onImages`, which
 * saves them in the project and inserts a figure where `range` is then
 * (latex-image-drop.ts). Everything else (text, rich text, Markdown, a drag
 * of text inside the editor) is left to the handlers that follow. */

export type LatexImageRequest = { files: File[]; range: TrackedRange; origin: "paste" | "drop" };
export type LatexImageHandler = {
  onImages: (request: LatexImageRequest) => void;
  /** An image dropped where a figure cannot go (math, a comment, verbatim, the preamble). */
  onRefused: (message: string) => void;
};

/** The image files a clipboard or a drop holds (a screenshot's `image/png` item has no file name). */
export function imageFilesOf(data: DataTransfer | null) {
  if (!data) return [];
  const files = Array.from(data.files ?? []).filter((file) => looksLikeImageFile(file.name, file.type));
  if (files.length) return files;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file" && looksLikeImageFile("", item.type))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

/**
 * Whether a paste is an image paste: it holds an image and no text. A copy
 * from Word or a web page carries a picture of the selection besides its text;
 * that one is text, for the Markdown and rich-text paste to convert.
 */
export function isImagePaste(data: DataTransfer | null) {
  if (!data) return false;
  if ((data.getData("text/plain") ?? "").trim()) return false;
  const html = data.getData("text/html") ?? "";
  // A browser's "Copy Image" sends `<img src=…>` and the image: still an image. Any visible text makes it text.
  if (html && html.replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, "").replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "")) return false;
  return imageFilesOf(data).length > 0;
}

export function latexImagePaste(handler: () => LatexImageHandler | null): Extension {
  return Prec.highest(EditorView.domEventHandlers({
    paste(event, view) {
      const current = handler();
      if (!current || view.state.readOnly || !isImagePaste(event.clipboardData)) return false;
      const { from, to } = view.state.selection.main;
      // In math, a comment, verbatim or the preamble an image has no place: nothing is pasted.
      if (pasteStaysLiteral(view.state, from)) { event.preventDefault(); current.onRefused("An image cannot be pasted here (math, a comment, verbatim or the preamble)."); return true; }
      event.preventDefault();
      current.onImages({ files: imageFilesOf(event.clipboardData), range: trackRange(view, from, to), origin: "paste" });
      return true;
    },
    dragover(event, view) {
      // Files from outside: let the drop happen (CodeMirror's drop cursor shows where).
      if (!handler() || view.state.readOnly || !event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return false;
      event.preventDefault();
      return false;
    },
    drop(event, view) {
      const current = handler();
      if (!current || view.state.readOnly) return false;
      const files = imageFilesOf(event.dataTransfer);
      if (!files.length) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      // Otherwise CodeMirror would read the files as text and insert that.
      event.preventDefault();
      if (pasteStaysLiteral(view.state, pos)) { current.onRefused("An image cannot be dropped here (math, a comment, verbatim or the preamble)."); return true; }
      current.onImages({ files, range: trackRange(view, pos, pos), origin: "drop" });
      return true;
    },
  }));
}
