"use client";

import { Search, X } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import type { OpenTab, OpenTabViewState } from "@/components/libera/types";
import { readLatexOutline } from "@/lib/latex/project";
import type { LiberaFileNode } from "@/lib/types";
import { getLatexEditor } from "./latex-editor-registry";

/** Sectioning commands of the open LaTeX file; click to jump to one. */
export function LatexOutline({ activeTab, onOpenFile }: {
  activeTab: OpenTab;
  onOpenFile: (file: LiberaFileNode, options?: { viewState?: OpenTabViewState }) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const draft = useDeferredValue(activeTab.draft);
  const entries = useMemo(() => readLatexOutline(draft), [draft]);
  const minimumLevel = entries.reduce((minimum, entry) => Math.min(minimum, entry.level), 6);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery ? entries.filter((entry) => entry.title.toLowerCase().includes(normalizedQuery)) : entries;
  const cursorLine = activeTab.viewState?.latex?.line ?? 0;
  const activeLine = entries.reduce((active, entry) => (entry.line <= cursorLine ? entry.line : active), 0);

  function navigate(line: number) {
    const editor = getLatexEditor(activeTab.id);
    if (editor) {
      editor.revealLine(line);
      return;
    }
    void onOpenFile(activeTab.file, { viewState: { latex: { revealLine: { line, nonce: Date.now() } } } });
  }

  return (
    <section>
      <div className="relative mb-3">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          aria-label="Search LaTeX sections"
          className="libera-sidebar-search-input h-10 w-full rounded-xl border border-input bg-card px-9 text-sm outline-none transition focus:border-ring"
          placeholder="Search sections"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
            else if (event.key === "Enter" && visible[0]) { event.preventDefault(); navigate(visible[0].line); }
          }}
        />
        {query ? (
          <button aria-label="Clear section search" className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" type="button" onClick={() => setQuery("")}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      {visible.length ? (
        <div className="space-y-0.5">
          {visible.map((entry) => {
            const active = entry.line === activeLine;
            return (
              <button
                key={`${entry.line}-${entry.title}`}
                type="button"
                className="flex w-full min-w-0 items-baseline gap-2 rounded border border-transparent px-2 py-1.5 text-left text-sm hover:bg-muted"
                style={{
                  paddingLeft: `${8 + (normalizedQuery ? 0 : (entry.level - minimumLevel) * 12)}px`,
                  ...(active ? { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)", borderColor: "color-mix(in srgb, var(--accent) 46%, transparent)" } : undefined),
                }}
                aria-current={active ? "location" : undefined}
                title={`\\${entry.command} · line ${entry.line}`}
                onClick={() => navigate(entry.line)}
              >
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{entry.line}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-input px-3 py-4 text-sm text-muted-foreground">
          {entries.length ? "No matching sections." : "Add \\section{…} commands to build an outline."}
        </p>
      )}
    </section>
  );
}
