"use client";

import { useEffect, useState } from "react";
import { AlbumNameDialog } from "@/components/libera/image-gallery-view";
import { announceImageSaved, saveImageToNewAlbum, subscribeSaveToNewAlbum, type ImageSaveSource } from "@/components/libera/image-save";

/** Names the album an image viewer's Save ▸ Save to Album ▸ New Album… makes for the image. */
export function SaveImageToNewAlbumDialog() {
  const [source, setSource] = useState<ImageSaveSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => subscribeSaveToNewAlbum((next) => { setSource(next); setError(""); }), []);

  if (!source) return null;
  return <AlbumNameDialog key={source.src} title="New album" submitLabel="Create and save" busy={busy} error={error}
    note="A copy of this image is added to the new album in your gallery."
    onClose={() => setSource(null)}
    onSubmit={async (name) => {
      setBusy(true);
      setError("");
      try {
        const album = await saveImageToNewAlbum(source, name);
        announceImageSaved(source.src, `Saved to “${album.name}”`);
        setSource(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Could not create the album.");
      } finally {
        setBusy(false);
      }
    }} />;
}
