import { BookOpen, FileSearch, Search } from "lucide-react";
import { FileTypeIcon } from "@/components/libera/file-type";
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
    <div className="relative px-3 py-2">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-6 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
      />
      <input
        aria-label="Search notebooks and files"
        className="h-[34px] w-full rounded-md border border-zinc-300 bg-white px-9 text-sm outline-none transition focus:border-zinc-950"
        placeholder="Search notebooks and files"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {suggestionsOpen ? (
        <div className="absolute left-3 right-3 top-[2.875rem] z-30 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
          {searchResults.map((result) => (
            <button
              key={`${result.type}:${result.label}`}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-zinc-100"
              type="button"
              onClick={() => onSelectSearchResult(result)}
            >
              <span className="flex min-w-0 items-center gap-2">
                {result.type === "notebook" ? (
                  <BookOpen aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
                ) : (
                  <FileTypeIcon fileType={result.file.fileType} />
                )}
                <span className="truncate">{result.label}</span>
              </span>
              <span className="shrink-0 text-xs uppercase text-zinc-500">
                {result.type}
              </span>
            </button>
          ))}
          <button
            className="flex w-full items-center justify-between gap-3 border-t border-zinc-200 px-3 py-2 text-left text-sm font-medium hover:bg-zinc-100"
            type="button"
            onClick={() => onDeepSearch(normalizedQuery)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <FileSearch aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
              <span className="truncate">Deep Search</span>
            </span>
            <span className="shrink-0 text-xs text-zinc-500">content</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
