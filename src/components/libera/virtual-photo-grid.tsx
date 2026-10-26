"use client";

import { memo, useLayoutEffect, useState } from "react";
import type { CSSProperties, MouseEvent, RefObject } from "react";
import { Check, Star } from "lucide-react";
import { GALLERY_GAP, photoRatio, visibleGalleryRows, type GalleryRows } from "@/lib/gallery-layout";
import type { PhotoSection } from "@/lib/gallery-timeline";
import { sizedGalleryUrl, type GalleryPhoto } from "@/lib/image-generation";

type Props = {
  groups: PhotoSection<GalleryPhoto>[];
  layout: GalleryRows;
  justified: boolean;
  size: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  selected: Set<string>;
  landedId: string | null;
  thumbnailUrl: (photo: GalleryPhoto, thumbnail: boolean) => string;
  onToggle: (photo: GalleryPhoto, event: MouseEvent) => void;
  onToggleGroup: (photos: GalleryPhoto[]) => void;
  onOpen: (photo: GalleryPhoto) => void;
  onStar?: (photo: GalleryPhoto) => void;
  onContextMenu: (photo: GalleryPhoto, event: MouseEvent) => void;
};

/** Viewer navigation never reconciles this subtree; scroll state belongs here. */
export const VirtualPhotoGrid = memo(function VirtualPhotoGrid({ groups, layout, justified, size, scrollRef, selected, landedId, thumbnailUrl, onToggle, onToggleGroup, onOpen, onStar, onContextMenu }: Props) {
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = scroller.clientHeight || 600;
      const top = Math.max(0, Math.min(scroller.scrollTop, layout.height - height));
      setViewport((current) => current.top === top && current.height === height ? current : { top, height });
    };
    const later = () => { if (!frame) frame = window.requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(later);
    observer.observe(scroller);
    scroller.addEventListener("scroll", later, { passive: true });
    // Also read scroll restored by the parent's layout effect.
    later();
    return () => { observer.disconnect(); scroller.removeEventListener("scroll", later); window.cancelAnimationFrame(frame); };
  }, [layout, scrollRef]);
  const selecting = selected.size > 0;
  return <div className="relative" style={{ height: layout.height }} data-gallery-virtual>
    {visibleGalleryRows(layout.rows, viewport.top, viewport.height).map((row) => {
      const group = groups[row.group];
      if (row.heading) {
        const allSelected = group.photos.every((photo) => selected.has(photo.id));
        return <div key={`heading:${group.key}`} className="group/day absolute left-0 right-0 flex items-center gap-2 pt-5 pb-2" style={{ top: row.top, height: row.height }}>
          <button type="button" aria-label={`${allSelected ? "Deselect" : "Select"} photos from ${group.label}`}
            className={`flex h-5 w-5 items-center justify-center rounded-full border ${allSelected ? "border-primary bg-primary text-primary-foreground" : `border-muted-foreground/50 ${selecting ? "" : "opacity-0 group-hover/day:opacity-100 focus-visible:opacity-100"}`}`}
            onClick={() => onToggleGroup(group.photos)}>{allSelected && <Check className="h-3 w-3" />}</button>
          <h3 className="text-sm font-medium">{group.label}</h3>
        </div>;
      }
      return <div key={`${group.key}:${row.start}`} className="absolute left-0 right-0 flex" style={{ top: row.top, height: row.height, gap: GALLERY_GAP }}>
        {group.photos.slice(row.start, row.end).map((photo) => {
          const width = justified ? photoRatio(photo.width, photo.height) * row.height : layout.tileWidth;
          return <PhotoTile key={photo.id} photo={photo} thumbnail={sizedGalleryUrl(thumbnailUrl(photo, true), Math.max(width, row.height) * 2)}
            style={{ width, height: row.height, flex: "none" }} compact={size < 100} landed={photo.id === landedId}
            selected={selected.has(photo.id)} selecting={selecting} onToggle={onToggle} onOpen={onOpen} onStar={onStar} onContextMenu={onContextMenu} />;
        })}
      </div>;
    })}
  </div>;
});

const PhotoTile = memo(function PhotoTile({ photo, thumbnail, style, compact, landed, selected, selecting, onToggle, onOpen, onStar, onContextMenu }: {
  photo: GalleryPhoto; thumbnail: string; style: CSSProperties; compact: boolean; landed: boolean; selected: boolean; selecting: boolean;
  onToggle: Props["onToggle"]; onOpen: Props["onOpen"]; onStar: Props["onStar"]; onContextMenu: Props["onContextMenu"];
}) {
  return <div className={`group/tile relative overflow-hidden ${selected ? "rounded-lg bg-primary/10" : "bg-muted"}`} style={style} onContextMenu={(event) => onContextMenu(photo, event)} data-photo-id={photo.id} data-photo-time={photo.createdAt}>
    {landed && <span aria-hidden className="pointer-events-none absolute inset-0 z-10 animate-pulse ring-4 ring-inset ring-primary" />}
    <button type="button" className="block h-full w-full" aria-label={photo.prompt ? `Open “${photo.prompt.slice(0, 80)}”` : `Open ${photo.name}`}
      onClick={(event) => selecting || event.shiftKey || event.metaKey || event.ctrlKey ? onToggle(photo, event) : onOpen(photo)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local authenticated files */}
      <img src={thumbnail} alt="" loading="lazy" decoding="async" draggable={false} className={`h-full w-full object-cover transition-transform duration-150 ${selected ? "scale-[0.86] rounded-lg" : ""}`} />
    </button>
    <span aria-hidden className={`pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/40 to-transparent opacity-0 transition-opacity ${selected ? "" : "group-hover/tile:opacity-100"}`} />
    <button type="button" role="checkbox" aria-checked={selected} aria-label={`Select ${photo.name}`}
      className={`absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 transition ${selected ? "border-primary bg-primary text-primary-foreground opacity-100" : `border-white/90 bg-black/10 text-transparent hover:text-white/90 ${selecting ? "opacity-100" : "opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100"}`}`}
      onClick={(event) => { event.stopPropagation(); onToggle(photo, event); }}><Check className="h-3.5 w-3.5" /></button>
    {!compact && !selecting && onStar && <button type="button" aria-label={photo.starred ? `Unstar ${photo.name}` : `Star ${photo.name}`} aria-pressed={photo.starred}
      className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full text-white opacity-0 transition hover:bg-black/30 focus-visible:opacity-100 group-hover/tile:opacity-100"
      onClick={(event) => { event.stopPropagation(); onStar(photo); }}><Star className={`h-4 w-4 drop-shadow ${photo.starred ? "fill-amber-400 text-amber-400" : ""}`} /></button>}
    {photo.starred && !selected && <Star aria-label="Starred" className="pointer-events-none absolute bottom-1.5 left-1.5 h-4 w-4 fill-amber-400 text-amber-400 drop-shadow" />}
  </div>;
});
