"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRegisterGalleryTranslator } from "@/components/libera/gallery-i18n";
import { AlbumNameDialog } from "@/components/libera/image-gallery-view";
import { announceImageSaved, saveImageToNewAlbum, subscribeSaveToNewAlbum, type ImageSaveSource } from "@/components/libera/image-save";

/** Names the album an image viewer's Save ▸ Save to Album ▸ New Album… makes for the image. */
export function SaveImageToNewAlbumDialog() {
  const t = useTranslations("saveImageToNewAlbumDialog");
  useRegisterGalleryTranslator();
  const [source, setSource] = useState<ImageSaveSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => subscribeSaveToNewAlbum((next) => { setSource(next); setError(""); }), []);

  if (!source) return null;
  return <AlbumNameDialog key={source.src} title={t("title")} submitLabel={t("submitLabel")} busy={busy} error={error}
    note={t("note")}
    onClose={() => setSource(null)}
    onSubmit={async (name) => {
      setBusy(true);
      setError("");
      try {
        const album = await saveImageToNewAlbum(source, name);
        announceImageSaved(source.src, t("savedToAlbum", { album: album.name }));
        setSource(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : t("createAlbumFailed"));
      } finally {
        setBusy(false);
      }
    }} />;
}
