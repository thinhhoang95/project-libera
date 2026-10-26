"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { apiRequest } from "@/components/libera/api-client";
import { applyGallery, notifyDeletedGalleryPhotos } from "@/components/libera/gallery-store";
import type { ArchiveContents, GalleryContents, GalleryPhoto } from "@/lib/image-generation";

/**
 * The Protected Archive keeps privacy-sensitive photos out of the gallery.
 * Sending photos there needs nothing more than being signed in; seeing them
 * again needs the password, entered again. The archive locks when the reader
 * leaves it, leaves the gallery, or stops using it for a while.
 */

// Matches the server's ARCHIVE_MAX_AGE_SECONDS, after which the unlock lapses anyway.
const ARCHIVE_IDLE_MS = 10 * 60 * 1000;
// Activity renews the unlock this often, so photos keep loading while in use.
const ARCHIVE_RENEW_MS = 4 * 60 * 1000;

class ArchiveLockedError extends Error {}

async function archiveRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", "X-Libera-Gallery": "catalog", ...init?.headers } });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; locked?: boolean };
  if (response.status === 403 && payload.locked) throw new ArchiveLockedError(payload.error ?? "The Protected Archive is locked.");
  if (!response.ok) throw new Error(payload.error ?? "Request failed.");
  return payload as T;
}

function sendLock() {
  void fetch("/api/gallery/archive/session", { method: "DELETE" }).catch(() => undefined);
}

/** Sends photos to the Protected Archive. Hiding them needs no password. */
export async function moveToArchive(ids: string[]) {
  const result = await apiRequest<{ archived: number; gallery: GalleryContents }>("/api/gallery/archive", { method: "POST", body: JSON.stringify({ ids }) });
  applyGallery(result.gallery);
  return result.archived;
}

/**
 * The archive's contents, held only while it is unlocked and `open`. Archived
 * photos never enter the shared gallery store, so no other view can show them.
 */
export function useProtectedArchive(open: boolean) {
  const [contents, setContents] = useState<ArchiveContents | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  // Whether the server may still hold an unlock this view should end.
  const serverUnlockedRef = useRef(false);
  const renewedAtRef = useRef(0);

  // Leaving the archive locks it: its photos are dropped at once…
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setContents(null);
  }
  const unlocked = contents !== null;

  const lock = useCallback(() => {
    setContents(null);
    serverUnlockedRef.current = false;
    sendLock();
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await archiveRequest<ArchiveContents>("/api/gallery/archive");
      notifyDeletedGalleryPhotos(next.deletedPhotoIds);
      renewedAtRef.current = Date.now();
      setContents(next);
    } catch (error) {
      if (error instanceof ArchiveLockedError) setContents(null);
      throw error;
    }
  }, []);

  const unlock = useCallback(async (password: string) => {
    await archiveRequest("/api/gallery/archive/session", { method: "POST", body: JSON.stringify({ password }) });
    serverUnlockedRef.current = true;
    await load();
  }, [load]);

  /** A change to the archive; an unlock that lapsed shows the password prompt again. */
  const change = useCallback(async (url: string, method: string, ids: string[]) => {
    try {
      const result = await archiveRequest<{ archive: ArchiveContents; gallery?: GalleryContents }>(url, { method, body: JSON.stringify({ ids }) });
      renewedAtRef.current = Date.now();
      setContents(result.archive);
      notifyDeletedGalleryPhotos(result.archive.deletedPhotoIds);
      applyGallery(result.gallery);
    } catch (error) {
      if (error instanceof ArchiveLockedError) setContents(null);
      throw error;
    }
  }, []);

  const restore = useCallback((ids: string[]) => change("/api/gallery/archive/restore", "POST", ids), [change]);
  const remove = useCallback((ids: string[]) => change("/api/gallery/archive", "DELETE", ids), [change]);

  // …and the server forgets the unlock.
  useEffect(() => {
    if (open || !serverUnlockedRef.current) return;
    serverUnlockedRef.current = false;
    sendLock();
  }, [open]);

  // So does leaving the gallery.
  useEffect(() => () => { if (serverUnlockedRef.current) sendLock(); }, []);

  // And a spell without activity; activity keeps the server's unlock fresh.
  useEffect(() => {
    if (!unlocked) return;
    let timer = window.setTimeout(lock, ARCHIVE_IDLE_MS);
    function activity() {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, ARCHIVE_IDLE_MS);
      if (Date.now() - renewedAtRef.current > ARCHIVE_RENEW_MS) void load().catch(() => undefined);
    }
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const name of events) window.addEventListener(name, activity, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, activity);
    };
  }, [load, lock, unlocked]);

  return { unlocked, photos: contents?.photos ?? EMPTY, unlock, lock, restore, remove };
}

const EMPTY: GalleryPhoto[] = [];

const primary = "rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50";

/** The password prompt shown in place of the archive while it is locked. */
export function ArchiveUnlock({ onUnlock }: { onUnlock: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      await onUnlock(password);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not unlock the archive.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return <form className="mx-auto mt-16 flex max-w-xs flex-col items-center text-center" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted"><Lock className="h-6 w-6 text-muted-foreground" /></span>
    <h3 className="text-sm font-medium">Protected Archive</h3>
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Enter your Libera password to see the photos kept here. The archive locks again when you leave it, or after 10 minutes without activity.</p>
    <label className="sr-only" htmlFor="gallery-archive-password">Password</label>
    <input id="gallery-archive-password" type="password" autoFocus autoComplete="current-password" placeholder="Password" value={password} disabled={busy}
      onChange={(event) => setPassword(event.target.value)}
      className="mt-4 h-10 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring" />
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    <button type="submit" className={`${primary} mt-3 w-full`} disabled={busy || !password}>{busy ? "Unlocking…" : "Unlock"}</button>
  </form>;
}
