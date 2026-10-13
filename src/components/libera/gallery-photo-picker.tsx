"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Images, Star } from "lucide-react";
import { refreshGallery, useGallery } from "@/components/libera/gallery-store";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { galleryRawUrl, type GalleryPhoto } from "@/lib/image-generation";

type PickerView = { kind: "photos" } | { kind: "starred" } | { kind: "albums" } | { kind: "album"; id: string };

const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Notes take PNG, JPEG, WebP and GIF images; vector photos stay in the gallery. */
export function isInsertableGalleryPhoto(photo: Pick<GalleryPhoto, "name">) {
  return Boolean(CONTENT_TYPES[photo.name.split(".").at(-1)?.toLowerCase() ?? ""]);
}

/**
 * Reads a gallery photo as a File, so it goes through the same upload path as
 * a photo chosen from the computer and the note keeps its own copy.
 */
export async function galleryPhotoFile(photo: GalleryPhoto) {
  const response = await fetch(galleryRawUrl(photo));
  if (!response.ok) throw new Error(`Could not read ${photo.name} from the gallery.`);
  const blob = await response.blob();
  const type = CONTENT_TYPES[photo.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? blob.type;
  return new File([blob], photo.name, { type });
}

/** Picks one or more gallery photos, browsing Photos, Starred and albums. */
export function GalleryPhotoPicker({ open, onClose, onInsert }: {
  open: boolean;
  onClose: () => void;
  onInsert: (photos: GalleryPhoto[]) => Promise<void> | void;
}) {
  const gallery = useGallery();
  const [view, setView] = useState<PickerView>({ kind: "photos" });
  // Selection order is insertion order.
  const [selected, setSelected] = useState<string[]>([]);
  const [inserting, setInserting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    void refreshGallery();
    // A fresh pick each time the picker opens.
    queueMicrotask(() => { setSelected([]); setError(""); setView({ kind: "photos" }); });
  }, [open]);

  const contents = gallery.contents;
  const photoById = useMemo(() => new Map(contents?.photos.map((photo) => [photo.id, photo])), [contents]);
  const album = view.kind === "album" ? contents?.albums.find((item) => item.id === view.id) : undefined;
  const photos = useMemo(() => {
    const all = (contents?.photos ?? []).filter(isInsertableGalleryPhoto);
    const visible = view.kind === "album" ? all.filter((photo) => photo.albumIds.includes(view.id))
      : view.kind === "starred" ? all.filter((photo) => photo.starred) : all;
    return [...visible].sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  }, [contents, view]);
  const chosen = selected.map((id) => photoById.get(id)).filter((photo): photo is GalleryPhoto => Boolean(photo));

  function toggle(photo: GalleryPhoto) {
    setSelected((current) => current.includes(photo.id) ? current.filter((id) => id !== photo.id) : [...current, photo.id]);
  }

  async function insert(photosToInsert: GalleryPhoto[]) {
    if (!photosToInsert.length || inserting) return;
    setInserting(true);
    setError("");
    try {
      await onInsert(photosToInsert);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not insert the photos.");
    } finally {
      setInserting(false);
    }
  }

  const tab = (kind: "photos" | "starred" | "albums", label: string) => <button key={kind} type="button" role="tab"
    aria-selected={view.kind === kind || (kind === "albums" && view.kind === "album")}
    className={`inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium ${view.kind === kind || (kind === "albums" && view.kind === "album") ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
    onClick={() => setView({ kind })}>{kind === "starred" && <Star className="h-3 w-3" />}{label}</button>;

  return <ModalDialog open={open} title="Insert from gallery" panelClassName="max-w-3xl"
    description="Choose one or more photos. Each is copied into the note, so it stays even if the gallery changes."
    onClose={() => { if (!inserting) onClose(); }}
    footer={<div className="flex items-center gap-2">
      <span className="mr-auto text-sm text-muted-foreground">{chosen.length ? `${chosen.length} selected` : "Click photos to select them"}</span>
      <button type="button" className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" disabled={inserting} onClick={onClose}>Cancel</button>
      <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={!chosen.length || inserting} onClick={() => void insert(chosen)}>
        {inserting ? "Inserting…" : chosen.length > 1 ? `Insert ${chosen.length} photos` : "Insert photo"}
      </button>
    </div>}>
    <div className="mb-3 flex items-center gap-2">
      {view.kind === "album" && <button type="button" aria-label="Back to albums" title="Back to albums" className="inline-flex h-7 w-7 items-center justify-center rounded-lg hover:bg-muted" onClick={() => setView({ kind: "albums" })}><ArrowLeft className="h-4 w-4" /></button>}
      {view.kind === "album" ? <h3 className="mr-auto truncate text-sm font-semibold">{album?.name}</h3> : <span className="mr-auto" />}
      <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Gallery sections">
        {tab("photos", "Photos")}{tab("starred", "Starred")}{tab("albums", "Albums")}
      </div>
    </div>
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    <div className="h-[55vh] overflow-auto">
      {!contents ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">{gallery.error || "Opening your gallery…"}</p>
        : view.kind === "albums" ? (contents.albums.length ? <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {contents.albums.map((item) => {
            const cover = item.coverId ? photoById.get(item.coverId) : undefined;
            return <button key={item.id} type="button" className="group text-left" onClick={() => setView({ kind: "album", id: item.id })}>
              <span className="block aspect-square overflow-hidden rounded-xl bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
                {cover ? <img src={galleryRawUrl(cover, true)} alt="" loading="lazy" className="h-full w-full object-cover" />
                  : <span className="flex h-full items-center justify-center text-muted-foreground"><Images className="h-6 w-6" /></span>}
              </span>
              <span className="mt-1.5 block truncate text-sm font-medium">{item.name}</span>
              <span className="block text-xs text-muted-foreground">{item.count} {item.count === 1 ? "item" : "items"}</span>
            </button>;
          })}
        </div> : <p className="py-10 text-center text-sm text-muted-foreground">No albums yet.</p>)
        : photos.length ? <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1">
          {photos.map((photo) => {
            const order = selected.indexOf(photo.id);
            return <button key={photo.id} type="button" role="checkbox" aria-checked={order >= 0} aria-label={photo.prompt ? `${photo.name}: ${photo.prompt.slice(0, 80)}` : photo.name}
              title={photo.name} className={`relative aspect-square overflow-hidden ${order >= 0 ? "rounded-lg bg-primary/10" : "bg-muted"}`}
              onClick={() => toggle(photo)} onDoubleClick={() => void insert([photo])}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
              <img src={galleryRawUrl(photo, true)} alt="" loading="lazy" draggable={false} className={`h-full w-full object-cover transition-transform ${order >= 0 ? "scale-[0.86] rounded-lg" : ""}`} />
              <span aria-hidden className={`absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-semibold ${order >= 0 ? "border-primary bg-primary text-primary-foreground" : "border-white/90 bg-black/10 text-transparent"}`}>
                {order >= 0 ? (selected.length > 1 ? order + 1 : <Check className="h-3.5 w-3.5" />) : null}
              </span>
            </button>;
          })}
        </div> : <p className="py-10 text-center text-sm text-muted-foreground">{view.kind === "starred" ? "No starred photos." : view.kind === "album" ? "This album has no photos." : "Your gallery has no photos yet."}</p>}
    </div>
  </ModalDialog>;
}
