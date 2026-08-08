import { BookOpen, FileSearch, Search, X } from "lucide-react";
import { FileTypeIcon } from "@/components/libera/file-type";
import { SidebarNameTooltipButton } from "@/components/libera/sidebar-name-tooltip";
import type { SearchResult } from "@/components/libera/types";

type SidebarSearchProps = {
  query: string;
  searchResults: SearchResult[];
  onDeepSearch: (query: string) => void;
  onQueryChange: (query: string) => void;
  onSelectSearchResult: (result: SearchResult) => void;
};

export function SidebarSearch({
  query,
  searchResults,
  onDeepSearch,
  onQueryChange,
  onSelectSearchResult,
}: SidebarSearchProps) {
  const normalizedQuery = query.trim();
  const suggestionsOpen = Boolean(normalizedQuery);

  return (
    <div className="relative border-b border-transparent px-3 py-2">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        aria-label="Search notebooks and files"
        className="h-9 w-full rounded-full border border-input bg-card px-9 text-sm outline-none transition focus:border-ring"
        placeholder="Search notebooks and files"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {query ? (
        <button
          aria-label="Clear search"
          className="absolute right-5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          type="button"
          onClick={() => onQueryChange("")}
          onMouseDown={(event) => event.preventDefault()}
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      ) : null}
      {suggestionsOpen ? (
        <div className="absolute left-3 right-3 top-[2.875rem] z-30 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          {searchResults.map((result) => (
            <SidebarNameTooltipButton
              key={`${result.type}:${result.label}`}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
              fullName={result.label}
              type="button"
              onClick={() => onSelectSearchResult(result)}
            >
              <span className="flex min-w-0 items-center gap-2">
                {result.type === "notebook" ? (
                  <BookOpen aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FileTypeIcon fileType={result.file.fileType} />
                )}
                <span className="truncate">{result.label}</span>
              </span>
              <span className="shrink-0 text-xs uppercase text-muted-foreground">
                {result.type}
              </span>
            </SidebarNameTooltipButton>
          ))}
          <button
            className="flex w-full items-center justify-between gap-3 border-t border-border px-3 py-2 text-left text-sm font-medium hover:bg-muted"
            type="button"
            onClick={() => onDeepSearch(normalizedQuery)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FileSearch aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">Deep Search</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">content</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
