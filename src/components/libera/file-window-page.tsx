"use client";

import { useEffect } from "react";
import { encodeFilePath } from "@/components/libera/api-client";
import { ImageViewer } from "@/components/libera/image-viewer";
import { NoteMathMarkersProvider } from "@/components/libera/note-math-context";
import { PdfViewer } from "@/components/libera/pdf-viewer";
import type { MathMarkerSettings } from "@/lib/math-markers";

// A PDF or image tab duplicated into its own window. The viewer is fully
// interactive; annotation edits sync with other windows showing the same file.
export function FileWindowPage({
  filePath,
  fileType,
  mathMarkers,
}: {
  filePath: string;
  fileType: "pdf" | "image" | null;
  mathMarkers: MathMarkerSettings;
}) {
  const fileName = filePath.split("/").at(-1) ?? "";
  const src = `/api/files/raw/${encodeFilePath(filePath)}`;

  useEffect(() => {
    if (fileName) {
      document.title = fileName;
    }
  }, [fileName]);

  return (
    <main className="libera-workspace-region flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={filePath}>
          {fileName || "File"}
        </h1>
      </header>
      <div className="libera-document-workspace flex min-h-0 flex-1 flex-col overflow-hidden">
        <NoteMathMarkersProvider value={mathMarkers}>
          {fileType === "pdf" ? (
            <PdfViewer src={src} filePath={filePath} />
          ) : fileType === "image" ? (
            <ImageViewer src={src} alt={fileName} filePath={filePath} />
          ) : (
            <p role="alert" className="p-6 text-sm text-destructive">
              This file can&apos;t be opened in its own window.
            </p>
          )}
        </NoteMathMarkersProvider>
      </div>
    </main>
  );
}
