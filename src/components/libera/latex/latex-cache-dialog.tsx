"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/components/libera/api-client";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { LatexCacheFile } from "@/lib/latex/build";

/** Mounted only while open, so every opening reads the cache afresh. */
type LatexCacheDialogProps = {
  rootPath: string;
  onClose: () => void;
  /** Called after files were deleted, with whether to compile again. */
  onCleared: (recompile: boolean) => void;
};

const FILE_DESCRIPTIONS: [RegExp, string][] = [
  [/\.aux$/i, "Cross-references and citations"],
  [/\.(bbl|bcf|run\.xml)$/i, "Bibliography data"],
  [/\.blg$/i, "Bibliography log"],
  [/\.fdb_latexmk$/i, "latexmk dependency database"],
  [/\.fls$/i, "List of files read"],
  [/\.log$/i, "Compile log"],
  [/\.(toc|lof|lot|out)$/i, "Contents, lists and bookmarks"],
  [/\.synctex(\.gz)?$/i, "Source ↔ PDF positions"],
  [/\.pdf$/i, "PDF output (the preview keeps its own copy)"],
  [/\.(nav|snm|vrb)$/i, "Beamer navigation data"],
  [/\.(idx|ind|ilg|glo|gls|glg|ist|acn|acr|alg)$/i, "Index and glossary data"],
  [/\.(tex|sty|cls)$/i, "Staged source (written again on every compile)"],
];

function describe(file: string) {
  return FILE_DESCRIPTIONS.find(([pattern]) => pattern.test(file))?.[1] ?? "Generated file";
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function LatexCacheDialog({ rootPath, onClose, onCleared }: LatexCacheDialogProps) {
  const [files, setFiles] = useState<LatexCacheFile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recompile, setRecompile] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ files: LatexCacheFile[] }>(`/api/latex/cache?path=${encodeURIComponent(rootPath)}`)
      .then(({ files: found }) => {
        if (cancelled) return;
        setFiles(found);
        setSelected(new Set(found.map((file) => file.path)));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setFiles([]);
        setError(reason instanceof Error ? reason.message : "Could not read the build cache.");
      });
    return () => { cancelled = true; };
  }, [rootPath]);

  const selectedSize = useMemo(() => (files ?? []).reduce((total, file) => total + (selected.has(file.path) ? file.size : 0), 0), [files, selected]);
  const allSelected = !!files?.length && selected.size === files.length;

  function toggle(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function clear() {
    setClearing(true);
    setError("");
    try {
      await apiRequest("/api/latex/cache", { method: "DELETE", body: JSON.stringify({ rootPath, files: [...selected] }) });
      onCleared(recompile);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not clear the build cache.");
    } finally {
      setClearing(false);
    }
  }

  return (
    <ModalDialog
      open
      title="Clear build cache"
      description={`Delete the files left by earlier compiles of ${rootPath.split("/").at(-1)} so the next build starts clean. Your source files are not touched.`}
      panelClassName="max-w-xl"
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          <label className="mr-auto flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
            <input type="checkbox" checked={recompile} onChange={(event) => setRecompile(event.target.checked)} />
            Recompile after clearing
          </label>
          <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={clearing || !selected.size}
            onClick={() => void clear()}
          >
            {clearing ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}
            {selected.size ? `Clear ${selected.size} file${selected.size === 1 ? "" : "s"}` : "Clear"}
          </button>
        </div>
      }
    >
      {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
      {files === null ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />Reading the build cache…</p>
      ) : !files.length ? (
        <p className="text-sm text-muted-foreground">{error ? "" : "The build cache is already empty."}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex cursor-pointer items-center gap-2 border-b border-border pb-2 text-sm font-medium text-foreground">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(input) => { if (input) input.indeterminate = selected.size > 0 && !allSelected; }}
              onChange={() => setSelected(allSelected ? new Set() : new Set(files.map((file) => file.path)))}
            />
            <span className="flex-1">All files</span>
            <span className="text-xs font-normal text-muted-foreground">{selected.size} of {files.length} · {formatSize(selectedSize)}</span>
          </label>
          <ul className="max-h-80 overflow-auto">
            {files.map((file) => (
              <li key={file.path}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted">
                  <input type="checkbox" checked={selected.has(file.path)} onChange={() => toggle(file.path)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-foreground" title={file.path}>{file.path}</span>
                    <span className="block text-xs text-muted-foreground">{describe(file.path)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatSize(file.size)}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ModalDialog>
  );
}
