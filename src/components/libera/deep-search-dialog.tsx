import { FileSearch, Search } from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { FileTypeIcon } from "@/components/libera/file-type";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { DeepSearchPayload, DeepSearchResult, LiberaFileNode } from "@/lib/types";

type DeepSearchDialogProps = {
  initialQuery: string;
  onClose: () => void;
  onOpenFile: (file: LiberaFileNode) => Promise<void>;
};

export function DeepSearchDialog({
  initialQuery,
  onClose,
  onOpenFile,
}: DeepSearchDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const [searchedQuery, setSearchedQuery] = useState("");
  const [payload, setPayload] = useState<DeepSearchPayload | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");

  const runSearch = useCallback(async (nextQuery: string) => {
    const trimmedQuery = nextQuery.trim();

    if (!trimmedQuery) {
      setPayload(null);
      setSearchedQuery("");
      setError("");
      return;
    }

    setSearching(true);
    setError("");
    setSearchedQuery(trimmedQuery);

    try {
      const response = await apiRequest<DeepSearchPayload>(
        `/api/deep-search?q=${encodeURIComponent(trimmedQuery)}`,
      );

      setPayload(response);
    } catch (searchError) {
      setPayload(null);
      setError(searchError instanceof Error ? searchError.message : "Deep search failed.");
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!initialQuery.trim()) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      void runSearch(initialQuery);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [initialQuery, runSearch]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runSearch(query);
  }

  async function openResult(result: DeepSearchResult) {
    await onOpenFile(result.file);
    onClose();
  }

  return (
    <ModalDialog
      open
      title="Deep Search"
      description="Search Markdown content, PDF text, and saved text annotations."
      panelClassName="max-w-2xl"
      onClose={onClose}
    >
      <form className="flex gap-2" onSubmit={submitSearch}>
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
          />
          <input
            className="h-10 w-full rounded-md border border-zinc-300 bg-white px-9 text-sm outline-none transition focus:border-zinc-950"
            value={query}
            placeholder="Search Markdown, PDFs, and annotations"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md bg-zinc-950 px-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={searching || !query.trim()}
        >
          <FileSearch aria-hidden className="h-4 w-4" />
          Search
        </button>
      </form>

      <div className="mt-4 min-h-48 overflow-hidden rounded-md border border-zinc-200">
        <DeepSearchResults
          error={error}
          payload={payload}
          searchedQuery={searchedQuery}
          searching={searching}
          onOpenResult={(result) => void openResult(result)}
        />
      </div>
    </ModalDialog>
  );
}

function DeepSearchResults({
  error,
  payload,
  searchedQuery,
  searching,
  onOpenResult,
}: {
  error: string;
  payload: DeepSearchPayload | null;
  searchedQuery: string;
  searching: boolean;
  onOpenResult: (result: DeepSearchResult) => void;
}) {
  if (searching) {
    return (
      <div className="flex min-h-48 items-center justify-center text-sm text-zinc-500">
        Searching content, PDFs, and annotations...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-red-700">
        {error}
      </div>
    );
  }

  if (!searchedQuery) {
    return (
      <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-zinc-500">
        Enter a query to search Markdown files, PDFs, and saved annotations.
      </div>
    );
  }

  if (!payload?.results.length) {
    return (
      <div className="flex min-h-48 items-center justify-center px-4 text-center text-sm text-zinc-500">
        No deep search results for &quot;{searchedQuery}&quot;.
      </div>
    );
  }

  return (
    <div>
      <div className="border-b border-zinc-200 px-3 py-2 text-xs text-zinc-500">
        {payload.results.length} result{payload.results.length === 1 ? "" : "s"} across{" "}
        {payload.searchedFiles} file{payload.searchedFiles === 1 ? "" : "s"}
      </div>
      <div className="max-h-[50vh] overflow-auto">
        {payload.results.map((result) => (
          <button
            key={result.id}
            className="flex w-full gap-3 border-b border-zinc-200 px-3 py-3 text-left last:border-b-0 hover:bg-zinc-100"
            type="button"
            onClick={() => onOpenResult(result)}
          >
            <FileTypeIcon fileType={result.file.fileType} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium text-zinc-950">
                  {result.title}
                </span>
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">
                  {result.sourceLabel}
                </span>
              </span>
              <span className="mt-1 block text-sm leading-6 text-zinc-700">
                {result.excerpt}
              </span>
              <span className="mt-1 block text-xs text-zinc-500">
                {result.matchCount} match{result.matchCount === 1 ? "" : "es"}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
