import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage";
import { verifyNotebook, type IntegrityStreamLine } from "@/lib/storage/integrity";

export const runtime = "nodejs";

/**
 * The notebook check (storage/integrity.ts): reads only, on request. With
 * `?stream=1` it reports each check as it starts, and closing the request
 * stops the check between reads.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const notebook = request.nextUrl.searchParams.get("notebook") ?? "";

  if (request.nextUrl.searchParams.get("stream") !== "1") {
    try {
      return NextResponse.json(await verifyNotebook(notebook, { signal: request.signal }));
    } catch (error) {
      const storageError = toStorageError(error);
      return NextResponse.json({ error: storageError.message }, { status: storageError.status });
    }
  }

  const encoder = new TextEncoder();
  const stop = new AbortController();
  const abort = () => stop.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: IntegrityStreamLine) => {
        if (stop.signal.aborted) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`)); } catch { stop.abort(); }
      };
      try {
        const report = await verifyNotebook(notebook, { signal: stop.signal, onProgress: (progress) => send({ type: "progress", ...progress }) });
        send({ type: "report", report });
      } catch (error) {
        send({ type: "error", error: toStorageError(error).message });
      } finally {
        request.signal.removeEventListener("abort", abort);
        try { controller.close(); } catch { /* Already closed. */ }
      }
    },
    cancel() {
      stop.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
