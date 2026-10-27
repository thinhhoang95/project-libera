import { X } from "lucide-react";
import type { CSSProperties } from "react";
import { isMarkdownSlidesPath } from "@/lib/markdown-slides";
import type { LiberaFileNode } from "@/lib/types";

/** A stable hue per tag so the same tag is always the same color. */
export function tagHue(tag: string) {
  let hash = 0;
  for (const char of tag.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

export function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  return (
    <span className="libera-tag-chip" style={{ "--tag-hue": tagHue(tag) } as CSSProperties}>
      {tag}
      {onRemove ? (
        <button type="button" aria-label={`Remove tag ${tag}`} onClick={onRemove}>
          <X aria-hidden size={11} />
        </button>
      ) : null}
    </span>
  );
}

export type FileKind = "markdown" | "slides" | "latex" | "bibtex" | "text" | "image" | "pdf" | "audio";

export function fileKind(file: Pick<LiberaFileNode, "fileType" | "name">): FileKind {
  if (file.fileType === "markdown") return isMarkdownSlidesPath(file.name) ? "slides" : "markdown";
  if (file.fileType === "latex") return /\.bib$/i.test(file.name) ? "bibtex" : "latex";
  // App pages are tabs, never files in a notebook.
  if (file.fileType === "page") return "text";
  return file.fileType;
}

export const FILE_KIND_LABELS: Record<FileKind, string> = {
  markdown: "Markdown document",
  slides: "Slide deck",
  latex: "LaTeX document",
  bibtex: "BibTeX bibliography",
  text: "Text file",
  image: "Image",
  pdf: "PDF document",
  audio: "Voice memo",
};

/** Every tag in use, sorted, keeping the first spelling seen. */
export function collectAllTags(fileTags: Record<string, string[]>) {
  const tags = new Map<string, string>();
  for (const list of Object.values(fileTags)) {
    for (const tag of list) if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  }
  return [...tags.values()].sort((a, b) => a.localeCompare(b));
}

export type TagQuery = {
  /** Lower-cased tags a file must all carry (prefix match). */
  tags: string[];
  /** Whatever is left once the tag filters are taken out. */
  text: string;
  /** The tag being typed at the end of the query, if any, for suggestions. */
  partialTag: string | null;
};

const TAG_TOKEN = /(^|\s)tags?:("[^"]*"?|\S*)/gi;

/** Parses `tags:a,b tag:"two words" rest of query`. */
export function parseTagQuery(query: string): TagQuery {
  const tags: string[] = [];
  let partialTag: string | null = null;

  const text = query.replace(TAG_TOKEN, (match, lead: string, value: string, offset: number) => {
    const unquoted = value.replace(/^"|"$/g, "");
    const parts = value.startsWith("\"") ? [unquoted] : unquoted.split(",");
    tags.push(...parts.map((part) => part.trim().toLowerCase()).filter(Boolean));
    if (offset + match.length === query.length) partialTag = parts.at(-1)?.trim() ?? "";
    return lead;
  }).replace(/\s+/g, " ").trim();

  return { tags, text, partialTag };
}

export function fileMatchesTags(fileTags: string[] | undefined, wanted: string[]) {
  if (!wanted.length) return true;
  const own = (fileTags ?? []).map((tag) => tag.toLowerCase());
  return wanted.every((tag) => own.some((candidate) => candidate.startsWith(tag)));
}

/** Replaces the tag being typed at the end of `query` with `tag`, ready for the next token. */
export function completeTagQuery(query: string, tag: string) {
  const value = /\s/.test(tag) ? `"${tag}"` : tag;
  return query.replace(/(tags?:)((?:[^\s,"]*,)*)("[^"]*"?|[^\s,]*)$/i, (_match, key: string, done: string) => `${key}${done}${value} `);
}
