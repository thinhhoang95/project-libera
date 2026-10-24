import { useLayoutEffect, useMemo } from "react";
import { apiRequest } from "./api-client";
import { broadcastSavedAnnotations } from "./annotation-sync";
import { createDeferredSave, registerStateFlusher, stateRequestKeepalive } from "./deferred-save";
import type { PdfAnnotation, PdfTextAnnotation } from "@/lib/types";

type WriterCallbacks<T> = { onSaved: (annotations: T[]) => void; onError: (error: unknown) => void };

function createAnnotationWriter<T>(kind: "pdf" | "image", filePath: string) {
  let callbacks: WriterCallbacks<T> | null = null;
  let latest = "";
  const saver = createDeferredSave(async (body) => {
    const payload = await apiRequest<{ annotations: T[] }>(`/api/${kind}-annotations`, {
      method: "PATCH", body, keepalive: stateRequestKeepalive(body),
    });
    broadcastSavedAnnotations(kind, filePath, payload.annotations);
    // An older response must not replace an edit made during its request,
    // or update a viewer which has since moved to another file.
    if (latest === body) callbacks?.onSaved(payload.annotations);
  }, (error) => callbacks?.onError(error));
  return {
    flush: saver.flush,
    setCallbacks: (value: WriterCallbacks<T> | null) => { callbacks = value; },
    schedule: (annotations: T[]) => {
      latest = JSON.stringify({ path: filePath, annotations });
      saver.schedule({ path: filePath, annotations }, 350);
    },
  };
}

export function useAnnotationWriter<T extends PdfAnnotation | PdfTextAnnotation>(
  kind: "pdf" | "image", filePath: string,
  onSaved: (annotations: T[]) => void, onError: (error: unknown) => void,
) {
  const writer = useMemo(() => createAnnotationWriter<T>(kind, filePath), [filePath, kind]);
  useLayoutEffect(() => { writer.setCallbacks({ onSaved, onError }); });
  useLayoutEffect(() => {
    let disposed = false;
    const flush = async () => {
      await writer.flush();
      if (disposed) unregister();
    };
    const unregister = registerStateFlusher(flush);
    return () => {
      disposed = true;
      writer.setCallbacks(null);
      // Stay registered until the last save completes, including retries.
      void flush().catch(() => undefined);
    };
  }, [writer]);
  return writer.schedule;
}
