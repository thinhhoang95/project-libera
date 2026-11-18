"use client";

import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { findFileSuggestions, indexFileSuggestions } from "@/lib/file-suggestions";
import type { LiberaFileNode } from "@/lib/types";
import type { MarkdownSelectionLinkOption } from "./types";
import { createMarkdownFileLinkDestination } from "@/lib/markdown-file-links";
import {
  filterMarkdownHeadingAnchors,
  markdownHeadingAnchors,
  markdownHeadingHref,
  type MarkdownHeadingAnchor,
} from "@/lib/markdown-heading-anchors";

type LinkOption =
  | { kind: "file"; file: LiberaFileNode }
  | { kind: "selection"; link: MarkdownSelectionLinkOption }
  | { kind: "heading"; heading: MarkdownHeadingAnchor };

const MAX_MIXED_HEADING_MATCHES = 8;

export function MarkdownLinkInput({ files, markdown, selectionLinks = [], sourcePath, value, onChange }: {
  files: LiberaFileNode[];
  /** The current document, whose headings can be linked as `#slug`. */
  markdown?: string;
  /** Passages highlighted in other open tabs, offered while the query is empty. */
  selectionLinks?: MarkdownSelectionLinkOption[];
  sourcePath: string;
  value: string;
  onChange: (href: string, label?: string) => void;
}) {
  const t = useTranslations("markdownLinkInput");
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  const [selected, setSelected] = useState(0);
  const query = value.trim().replace(/^@/, "").toLocaleLowerCase();
  const fileIndex = useMemo(() => indexFileSuggestions(files), [files]);
  const headingQuery = value.trim().startsWith("#");
  const suggestions = useMemo(() => findFileSuggestions(fileIndex, headingQuery ? "" : query), [fileIndex, headingQuery, query]);
  const headings = useMemo(() => markdown ? markdownHeadingAnchors(markdown) : [], [markdown]);
  const matches = useMemo<LinkOption[]>(() => {
    if (headingQuery) {
      return filterMarkdownHeadingAnchors(headings, query).map((heading) => ({ kind: "heading", heading }));
    }

    const fileOptions = suggestions.files.map((file): LinkOption => ({ kind: "file", file }));
    if (!query) return [...selectionLinks.map((link): LinkOption => ({ kind: "selection", link })), ...fileOptions];
    // A plain search also offers this document's headings; "@" searches files only.
    if (value.trim().startsWith("@")) return fileOptions;
    return [
      ...fileOptions,
      ...filterMarkdownHeadingAnchors(headings, query)
        .slice(0, MAX_MIXED_HEADING_MATCHES)
        .map((heading): LinkOption => ({ kind: "heading", heading })),
    ];
  }, [headingQuery, headings, query, selectionLinks, suggestions.files, value]);
  const open = expanded && !/^[a-z][a-z0-9+.-]*:/i.test(value.trim());
  const index = Math.min(selected, Math.max(0, matches.length - 1));

  function choose(option: LinkOption) {
    if (option.kind === "heading") onChange(markdownHeadingHref(option.heading), option.heading.text);
    else if (option.kind === "selection") onChange(option.link.href, option.link.label);
    else onChange(createMarkdownFileLinkDestination({ sourcePath, targetPath: option.file.path }), option.file.name);
    setExpanded(false);
  }

  return <div>
    <input autoFocus role="combobox" aria-label={t("linkLabel")} aria-autocomplete="list"
      aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open && matches.length ? `${id}-${index}` : undefined}
      aria-describedby={`${id}-hint`} autoComplete="off"
      placeholder={markdown ? t("placeholderWithHeadings") : t("placeholderFilesOnly")}
      className="w-full rounded-md border border-border bg-background p-2"
      value={value} onChange={(event) => { onChange(event.target.value); setExpanded(true); setSelected(0); }}
      onFocus={() => setExpanded(true)} onBlur={() => setExpanded(false)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || !open) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setExpanded(false); return; }
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && matches.length) {
          event.preventDefault();
          const next = (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
          setSelected(next);
          document.getElementById(`${id}-${next}`)?.scrollIntoView?.({ block: "nearest" });
        }
        if ((event.key === "Enter" || event.key === "Tab") && matches.length) {
          event.preventDefault(); choose(matches[index]);
        }
      }} />
    <p id={`${id}-hint`} className="mt-2 text-xs text-muted-foreground">{markdown
      ? t("hintWithHeadings")
      : t("hintFilesOnly")}</p>
    {open && <div id={id} role="listbox" aria-label={headingQuery ? t("listLabelHeadings") : t("listLabelFiles")} className="mt-2 max-h-60 overflow-auto rounded-lg border border-border bg-card p-1">
      {matches.map((option, i) => <button key={option.kind === "file" ? option.file.path : option.kind === "selection" ? `tab:${option.link.id}` : `#${option.heading.offset}`} id={`${id}-${i}`} type="button" role="option"
        tabIndex={-1} aria-selected={i === index}
        className={`block w-full rounded-md p-2 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
        {option.kind === "selection" ? <>
          <span className="block truncate font-medium">{option.link.title}</span>
          <span className="block truncate text-muted-foreground">{t("selectionQuote", { label: option.link.label })}</span>
        </> : option.kind === "file" ? <>
          <span className="block truncate font-medium">{option.file.name}</span>
          <span className="block truncate text-muted-foreground">{option.file.path}</span>
        </> : <>
          <span className="block truncate font-medium" style={{ paddingLeft: `${(option.heading.level - 1) * 0.5}rem` }}>{option.heading.text}</span>
          <span className="block truncate text-muted-foreground">{t("headingSubtitle", { line: option.heading.line, slug: option.heading.slug })}</span>
        </>}
      </button>)}
      {!headingQuery && suggestions.hasMore && <p className="p-2 text-xs text-muted-foreground">{t("showingFirst50")}</p>}
      {!matches.length && <p role="status" className="p-2 text-xs text-muted-foreground">{headingQuery ? t("noMatchingHeadings") : t("noMatchingFiles")}</p>}
    </div>}
  </div>;
}
