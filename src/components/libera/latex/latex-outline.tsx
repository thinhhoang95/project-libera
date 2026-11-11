"use client";

import { ChevronDown, ChevronRight, ListTree, Search, X } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { SidebarNameTooltipButton } from "@/components/libera/sidebar-name-tooltip";
import type { OpenTab, OpenTabViewState } from "@/components/libera/types";
import { readLatexOutline } from "@/lib/latex/project";
import { visibleOutlineRows } from "@/lib/pdf-outline";
import type { LiberaFileNode } from "@/lib/types";
import { getLatexEditor } from "./latex-editor-registry";

/** Sectioning commands of the open LaTeX file as a tree; click to jump to one. */
export function LatexOutline({ activeTab, expansionLevel, onExpansionLevelChange, onOpenFile }: {
  activeTab: OpenTab;
  expansionLevel: number;
  onExpansionLevelChange: (level: number) => void;
  onOpenFile: (file: LiberaFileNode, options?: { viewState?: OpenTabViewState }) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const draft = useDeferredValue(activeTab.draft);
  // The file's highest sectioning command is level 1, whichever command it is.
  const entries = useMemo(() => {
    const parsed = readLatexOutline(draft);
    const minimumLevel = parsed.reduce((minimum, entry) => Math.min(minimum, entry.level), 6);
    return parsed.map((entry, index) => ({ ...entry, id: `${entry.line}:${index}`, level: entry.level - minimumLevel + 1 }));
  }, [draft]);
  const rows = useMemo(() => visibleOutlineRows(entries, { query, expansionLevel, expanded }), [entries, query, expansionLevel, expanded]);
  const searching = Boolean(query.trim());
  const cursorLine = activeTab.viewState?.latex?.line ?? 0;
  const activeEntryId = entries.findLast((entry) => entry.line <= cursorLine)?.id ?? null;

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
          className="libera-panel-field libera-panel-field--search w-full"
          placeholder="Search sections"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") setQuery("");
            else if (event.key === "Enter" && rows[0]) {
              event.preventDefault();
              navigate(rows[0].entry.line);
            }
          }}
        />
        {query ? (
          <button
            aria-label="Clear section search"
            className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            type="button"
            onClick={() => setQuery("")}
            onMouseDown={(event) => event.preventDefault()}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <label className="mb-3 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span>Expand to</span>
        <span className="relative">
          <select
            aria-label="Outline expansion level"
            className="libera-panel-field libera-panel-field--compact pl-3 pr-8"
            value={expansionLevel}
            onChange={(event) => {
              onExpansionLevelChange(Number(event.target.value));
              setExpanded({});
            }}
          >
            {[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>Level {level}</option>)}
          </select>
        </span>
      </label>
      <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <ListTree aria-hidden className="h-3.5 w-3.5" />
        <span className="min-w-0 flex-1 truncate">Sections</span>
      </div>
      {rows.length ? (
        <div className="space-y-0.5" role="tree" aria-label={`Sections of ${activeTab.file.name}`}>
          {rows.map(({ entry, hasChildren, expanded: isExpanded }) => {
            const isActive = entry.id === activeEntryId;
            return (
              <div key={entry.id} role="treeitem" aria-level={entry.level} aria-selected={isActive} aria-expanded={hasChildren ? isExpanded : undefined} className="flex items-start gap-0.5" style={{ paddingLeft: searching ? 0 : `${(entry.level - 1) * 12}px` }}>
                {hasChildren ? (
                  <button
                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${entry.title}`}
                    aria-expanded={isExpanded}
                    className="libera-sidebar-icon-button mt-1 inline-flex h-6 w-5 shrink-0 items-center justify-center rounded"
                    type="button"
                    onClick={() => setExpanded((current) => ({ ...current, [entry.id]: !isExpanded }))}
                  >
                    {isExpanded ? <ChevronDown aria-hidden className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden className="h-3.5 w-3.5" />}
                  </button>
                ) : <span aria-hidden className="w-5 shrink-0" />}
                <SidebarNameTooltipButton
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  style={isActive ? { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)" } : undefined}
                  aria-current={isActive ? "location" : undefined}
                  fullName={`${entry.title} (\\${entry.command})`}
                  type="button"
                  onClick={() => navigate(entry.line)}
                >
                  <span className={`min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] ${entry.level === 1 ? "font-medium" : ""}`}>{entry.title}</span>
                  <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">L. {entry.line}</span>
                </SidebarNameTooltipButton>
              </div>
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
