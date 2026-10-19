import type { OpenTabViewState } from "@/components/libera/types";
import type { SearchFileKind, SearchGalleryPhoto, SearchHit } from "@/lib/global-search";
import type { GalleryPhoto } from "@/lib/image-generation";

/** The words a PDF viewer can find on the page: the start of the passage, kept short to survive line breaks. */
export function pdfFindPhrase(text: string) {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word));
  return words.slice(0, 6).join(" ");
}

/** How a file should open to show a search hit: the editor's one-shot reveal request. */
export function searchRevealViewState(kind: SearchFileKind, hit: SearchHit, terms: string[] = []): OpenTabViewState | undefined {
  const nonce = Date.now();
  const { start, end, line, endLine, page } = hit.location;

  if (kind === "markdown" && start !== undefined && end !== undefined) {
    return { markdown: { line, selectionStart: start, selectionEnd: start, reveal: { start, end, nonce } } };
  }
  if (kind === "latex" && line) {
    return { latex: { revealLine: { line, nonce } } };
  }
  if (kind === "text" && line) {
    return { text: { line, reveal: { line, endLine, nonce } } };
  }
  if (kind === "pdf" && page) {
    return { pdf: { reveal: { page, text: pdfFindPhrase(hit.text), nonce } } };
  }
  if (kind === "audio" && start !== undefined) {
    // The passage can span minutes; the player goes on to the line that matched.
    return { audio: { reveal: { seconds: start / 1000, end: end !== undefined ? end / 1000 : undefined, terms, nonce } } };
  }
  return undefined;
}

/** Enough of a gallery photo to open it as a read-only image tab. */
export function galleryPhotoFromSearch(photo: SearchGalleryPhoto): GalleryPhoto {
  const slash = photo.path.lastIndexOf("/");
  return {
    id: photo.id,
    path: photo.path,
    name: photo.name,
    folder: slash < 0 ? "" : photo.path.slice(0, slash),
    albumIds: [],
    createdAt: photo.updatedAt,
    updatedAt: photo.updatedAt,
    size: photo.size,
    prompt: photo.prompt,
    starred: false,
    edited: false,
  };
}
