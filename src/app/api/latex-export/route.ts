import { NextRequest } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { exportLatexPdf } from "@/lib/latex-export";

import { parseLatexOptions } from "@/lib/latex-options";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  if (typeof body?.markdown !== "string" || !body.markdown.trim()) return jsonError("The document is empty.", 400);
  if (body.markdown.length > 200_000) return jsonError("The document is too large. Export fewer than 200,000 characters at a time.", 413);

  if (body.documentPath !== undefined && typeof body.documentPath !== "string") return jsonError("Invalid document path.", 400);
  let options;
  try { options = parseLatexOptions(body.options); } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid LaTeX options.", 400);
  }

  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(15 * 60_000)]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(streamController) {
      const send = (event: object) => {
        if (!controller.signal.aborted) streamController.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const result = await exportLatexPdf(body.markdown, signal, (message) => send({ type: "progress", message }), options, body.documentPath ?? "");
        send({ type: "result", ...result });
      } catch (error) {
        send({ type: "error", message: signal.aborted ? "Export canceled or timed out. Please retry." : error instanceof Error ? error.message : "LaTeX export failed." });
      } finally {
        if (!controller.signal.aborted) streamController.close();
      }
    },
    cancel() { controller.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
