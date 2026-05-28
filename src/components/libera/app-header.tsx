import { useEffect, useRef, useState } from "react";
import { BookOpen, Info, LogOut, Search } from "lucide-react";
import { AboutDialog } from "@/components/libera/about-dialog";
import { FileTypeIcon } from "@/components/libera/file-type";
import type { SearchResult } from "@/components/libera/types";

type AppHeaderProps = {
  query: string;
  searchResults: SearchResult[];
  onLogout: () => Promise<void>;
  onQueryChange: (query: string) => void;
  onSelectSearchResult: (result: SearchResult) => void;
};

export function AppHeader({
  query,
  searchResults,
  onLogout,
  onQueryChange,
  onSelectSearchResult,
}: AppHeaderProps) {
  const [aboutMenuOpen, setAboutMenuOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const aboutMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!aboutMenuOpen) {
      return;
    }

    function closeAboutMenu() {
      setAboutMenuOpen(false);
    }

    function handlePointerDown(event: PointerEvent) {
      if (!aboutMenuRef.current?.contains(event.target as Node)) {
        closeAboutMenu();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeAboutMenu();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("scroll", closeAboutMenu, true);
    window.addEventListener("resize", closeAboutMenu);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("scroll", closeAboutMenu, true);
      window.removeEventListener("resize", closeAboutMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [aboutMenuOpen]);

  function openAboutDialog() {
    setAboutMenuOpen(false);
    setAboutDialogOpen(true);
  }

  return (
    <>
      <header className="border-b border-zinc-200 bg-white px-5 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-5">
            <h1 className="text-xl font-semibold tracking-tight">LiBERA</h1>
            <nav aria-label="Application navigation" className="flex items-center gap-1">
              <div className="relative" ref={aboutMenuRef}>
                <button
                  aria-expanded={aboutMenuOpen}
                  aria-haspopup="menu"
                  className="rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950"
                  type="button"
                  onClick={() => setAboutMenuOpen((open) => !open)}
                >
                  About
                </button>
                {aboutMenuOpen ? (
                  <div
                    className="absolute left-0 top-10 z-30 min-w-40 overflow-hidden rounded-md border border-zinc-200 bg-white py-1 text-sm shadow-lg"
                    role="menu"
                  >
                    <button
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100"
                      type="button"
                      role="menuitem"
                      onClick={openAboutDialog}
                    >
                      <Info aria-hidden className="h-4 w-4 text-zinc-500" />
                      About LiBERA
                    </button>
                  </div>
                ) : null}
              </div>
            </nav>
          </div>
          <div className="relative flex w-full max-w-xl items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
              />
              <input
                className="h-10 w-full rounded-md border border-zinc-300 px-9 text-sm outline-none transition focus:border-zinc-950"
                placeholder="Search notebooks and files"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </div>
            {searchResults.length ? (
              <div className="absolute left-0 right-0 top-11 z-20 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg">
                {searchResults.map((result) => (
                  <button
                    key={`${result.type}:${result.label}`}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-100"
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
                    <span className="text-xs uppercase text-zinc-500">{result.type}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <button
              className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-50"
              type="button"
              onClick={onLogout}
            >
              <LogOut aria-hidden className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      </header>
      <AboutDialog open={aboutDialogOpen} onClose={() => setAboutDialogOpen(false)} />
    </>
  );
}
