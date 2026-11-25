"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { encodeFilePath } from "@/components/libera/api-client";
import { subscribeOtherWindowMoves, remapMovedPath } from "@/components/libera/file-move-channel";
import { pendingSaves } from "@/components/libera/pending-saves";
import { ImageViewer } from "@/components/libera/image-viewer";
import { NoteMathMarkersProvider } from "@/components/libera/note-math-context";
import { PdfViewer } from "@/components/libera/pdf-viewer";
import { ReadAloudBar } from "@/components/libera/read-aloud";
import { SaveImageToNewAlbumDialog } from "@/components/libera/save-image-to-new-album-dialog";
import type { MathMarkerSettings } from "@/lib/math-markers";

// A PDF or image tab duplicated into its own window. The viewer is fully
// interactive; annotation edits sync with other windows showing the same file.
export function FileWindowPage({
  filePath: openedPath,
  fileType,
  mathMarkers,
}: {
  filePath: string;
  fileType: "pdf" | "image" | null;
  mathMarkers: MathMarkerSettings;
}) {
  const t = useTranslations("fileWindowPage");
  // The file this window shows follows it when another window moves or renames it (or its folder).
  const [filePath, setFilePath] = useState(openedPath);
  const pathRef = useRef(openedPath);
  useEffect(() => subscribeOtherWindowMoves((moves) => {
    const from = pathRef.current;
    const to = remapMovedPath(from, moves);
    if (to === from) return;
    // Unsaved ink and annotations go with the file; the viewer then writes to the new path only.
    pendingSaves.moveUnsavedMany([{ from, to }]);
    pathRef.current = to;
    setFilePath(to);
    try { window.history.replaceState(window.history.state, "", `/file-window?path=${encodeURIComponent(to)}`); } catch { /* Not essential. */ }
  }), []);
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
          {fileName || t("fallbackTitle")}
        </h1>
      </header>
      <div className="libera-document-workspace flex min-h-0 flex-1 flex-col overflow-hidden">
        <NoteMathMarkersProvider value={mathMarkers}>
          {fileType === "pdf" ? (
            <PdfViewer src={src} filePath={filePath} />
          ) : fileType === "image" ? (
            <><ImageViewer src={src} alt={fileName} filePath={filePath} saveDestination="gallery" /><SaveImageToNewAlbumDialog /></>
          ) : (
            <p role="alert" className="p-6 text-sm text-destructive">
              {t("cannotOpen")}
            </p>
          )}
        </NoteMathMarkersProvider>
      </div>
      <ReadAloudBar />
    </main>
  );
}
