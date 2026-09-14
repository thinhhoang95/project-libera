"use client";

import { useId, useMemo, useState } from "react";
import type { LiberaFileNode } from "@/lib/types";
import { createMarkdownFileLinkDestination } from "@/lib/markdown-file-links";

export function MarkdownLinkInput({ files, sourcePath, value, onChange }: {
  files: LiberaFileNode[];
  sourcePath: string;
  value: string;
  onChange: (href: string, label?: string) => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  const [selected, setSelected] = useState(0);
  const query = value.trim().replace(/^@/, "").toLocaleLowerCase();
  const matches = useMemo(() => files.filter((file) => file.fileType === "markdown" &&
    `${file.name}\n${file.path}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(query)) - Number(!b.name.toLocaleLowerCase().startsWith(query)) || a.path.localeCompare(b.path)), [files, query]);
  const open = expanded && !/^[a-z][a-z0-9+.-]*:/i.test(value.trim());
  const index = Math.min(selected, Math.max(0, matches.length - 1));

  function choose(file: LiberaFileNode) {
    onChange(createMarkdownFileLinkDestination({ sourcePath, targetPath: file.path }), file.name);
    setExpanded(false);
  }

  return <div>
    <input autoFocus role="combobox" aria-label="Link URL or file path" aria-autocomplete="list"
      aria-expanded={open} aria-controls={open ? id : undefined}
      aria-activedescendant={open && matches.length ? `${id}-${index}` : undefined}
      aria-describedby={`${id}-hint`} autoComplete="off"
      placeholder="Search notes, type @, or paste https://…"
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
    <p id={`${id}-hint`} className="mt-2 text-xs text-muted-foreground">Search notebook Markdown files by name or path, or enter an external URL. Use ↑/↓ and Enter to choose a file.</p>
    {open && <div id={id} role="listbox" aria-label="Notebook Markdown files" className="mt-2 max-h-60 overflow-auto rounded-lg border border-border bg-card p-1">
      {matches.map((file, i) => <button key={file.path} id={`${id}-${i}`} type="button" role="option"
        tabIndex={-1} aria-selected={i === index}
        className={`block w-full rounded-md p-2 text-left text-xs ${i === index ? "bg-muted" : "hover:bg-muted"}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(file)}>
        <span className="block truncate font-medium">{file.name}</span>
        <span className="block truncate text-muted-foreground">{file.path}</span>
      </button>)}
      {!matches.length && <p role="status" className="p-2 text-xs text-muted-foreground">No matching Markdown files</p>}
    </div>}
  </div>;
}
