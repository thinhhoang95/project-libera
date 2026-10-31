import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/api";
import { subscribeReferenceEvents } from "@/lib/references/library-events";
import { assertSafeSegment } from "@/lib/storage/paths";
import { jsonError } from "@/lib/api";

// Server-sent events about reference libraries (references/library-events.ts):
// `library` { notebook, revision } after every commit, and `tether`
// { notebook, status } when a tethered .bib file's sync state changes. An
// idle stream costs nothing: no timers, only writes when something happens.
// The browser's EventSource reconnects by itself after a drop.

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let notebook: string;
  try { notebook = assertSafeSegment(request.nextUrl.searchParams.get("notebook") ?? "", "Notebook name"); }
  catch { return jsonError("Notebook name is required."); }

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => {
        unsubscribe();
        request.signal.removeEventListener("abort", close);
        try { controller.close(); } catch { /* Already closed. */ }
      };
      unsubscribe = subscribeReferenceEvents((event) => {
        if (event.type === "moved" || event.notebook !== notebook) return;
        if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
        try { controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)); } catch { close(); }
      });
      // A comment opens the stream at once, so the client knows it is connected.
      controller.enqueue(encoder.encode(": connected\n\n"));
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
    },
    cancel() {
      close();
    },
  }, { highWaterMark: 64 });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
