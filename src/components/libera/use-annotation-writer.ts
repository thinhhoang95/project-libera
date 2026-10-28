import { useEffect, useLayoutEffect, useMemo } from "react";
import { apiRequest } from "./api-client";
import { broadcastSavedAnnotations } from "./annotation-sync";
import { pendingSaves, unsavedJournal } from "./pending-saves";
import type { PdfAnnotation, PdfTextAnnotation } from "@/lib/types";

// A file's annotations wait in memory until the person saves, as a note's
// text does (pending-saves.ts): the side-car is in the synced notebook, and
// every write is an upload. Unsaved annotations are kept in the local
// recovery journal meanwhile, and count as unsaved for the tab's dot and the
// close and quit prompts.

type WriterCallbacks<T> = { onSaved: (annotations: T[]) => void; onError: (error: unknown) => void };

export type AnnotationWriter<T> = {
  /** The annotations as they are now; written on the next Save. */
  schedule: (annotations: T[]) => void;
  save: () => Promise<void>;
  /** There are annotations waiting for Save. */
  readonly dirty: boolean;
  /** Unsaved annotations kept from before a crash or restart, if any. */
  recover: () => Promise<T[] | null>;
};

function createAnnotationWriter<T>(kind: "pdf" | "image", initialPath: string) {
  const key = `annotations:${kind}`;
  // A move or rename retargets the writer (pending-saves.ts), unsaved annotations and all.
  let filePath = initialPath;
  let callbacks: WriterCallbacks<T> | null = null;
  let pending: T[] | null = null;
  let saving: Promise<void> | null = null;
  let version = 0;

  const setPending = (annotations: T[] | null) => {
    pending = annotations;
    version += 1;
    pendingSaves.setDirty(filePath, key, annotations !== null);
    if (annotations === null) unsavedJournal.remove(filePath, key);
    else unsavedJournal.put(filePath, key, annotations);
  };

  const writer = {
    setCallbacks: (value: WriterCallbacks<T> | null) => { callbacks = value; },
    get dirty() { return pending !== null; },
    schedule: (annotations: T[]) => setPending(annotations),
    discard: () => setPending(null),
    retarget(path: string) {
      filePath = path;
      if (pending !== null) setPending(pending);
    },
    async recover() {
      const started = version;
      const kept = await unsavedJournal.get<T[]>(filePath, key);
      // Loading recovery must not replay a save or replace an edit made while
      // IndexedDB was opening. The writer owns recovery, including its dirty flag.
      if (started === version && pending === null && kept) setPending(kept);
      return pending;
    },
    async save(): Promise<void> {
      while (saving) await saving.catch(() => undefined);
      const sent = pending;
      const path = filePath;
      if (!sent) return;
      saving = (async () => {
        try {
          const payload = await apiRequest<{ annotations: T[] }>(`/api/${kind}-annotations`, {
            method: "PATCH", body: JSON.stringify({ path, annotations: sent }),
          });
          broadcastSavedAnnotations(kind, path, payload.annotations);
          // An edit made during the request stays unsaved, and is not replaced.
          if (pending === sent) {
            setPending(null);
            callbacks?.onSaved(payload.annotations);
          }
        } catch (error) {
          callbacks?.onError(error);
          throw error;
        } finally {
          saving = null;
        }
      })();
      return saving;
    },
  };
  return writer;
}

export function useAnnotationWriter<T extends PdfAnnotation | PdfTextAnnotation>(
  kind: "pdf" | "image", filePath: string,
  onSaved: (annotations: T[]) => void, onError: (error: unknown) => void,
): AnnotationWriter<T> {
  const writer = useMemo(() => pendingSaves.getWriter<ReturnType<typeof createAnnotationWriter<T>>>(filePath, `annotations:${kind}`) ?? createAnnotationWriter<T>(kind, filePath), [filePath, kind]);
  useLayoutEffect(() => {
    writer.setCallbacks({ onSaved, onError });
    return () => { writer.setCallbacks(null); };
  });
  useEffect(() => {
    const unregister = pendingSaves.register(filePath, `annotations:${kind}`, {
      dirty: writer.dirty,
      writer,
      save: () => writer.save(),
      discard: () => writer.discard(),
      retarget: (path) => writer.retarget(path),
    });
    return () => {
      // Unsaved annotations stay in the recovery journal, and the file stays unsaved.
      unregister();
    };
  }, [filePath, kind, writer]);
  return writer;
}
