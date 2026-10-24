import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getPdfToMarkdownSettings, openRouterPdfReadingAvailable, readPageWithOpenRouter } from "@/lib/document-ocr/openrouter-pages";

export const runtime = "nodejs";

const MAX_PAGE_BYTES = 30 * 1024 * 1024;
const PAGE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

/** Which engine Convert PDF to Markdown uses, from Preferences → AI. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const { engine, model, concurrency, cleanup } = getPdfToMarkdownSettings();
  return NextResponse.json({ engine, model, concurrency, cleanup, available: openRouterPdfReadingAvailable() });
}

/**
 * Read one page with the OpenRouter model. Form fields: `page`, a one-page
 * PDF (or a PNG or JPEG render when the PDF could not be split), `pageNumber`,
 * and optional `inlineMathMarkers` and `blockMathMarkers` from Preferences.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  if (!openRouterPdfReadingAvailable()) return jsonError("Add an OpenRouter API key in Preferences to read PDFs with an OpenRouter model.", 409);

  try {
    const form = await request.formData();
    const page = form.get("page");
    if (!(page instanceof File) || !page.size) return jsonError("A page is required.", 400);
    if (page.size > MAX_PAGE_BYTES) return jsonError("The page is too large to send.", 413);
    const contentType = page.type.split(";")[0];
    if (!PAGE_TYPES.has(contentType)) return jsonError("The page must be a PDF, PNG or JPEG.", 415);

    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" && value ? value : undefined;
    };
    const result = await readPageWithOpenRouter(
      { data: new Uint8Array(await page.arrayBuffer()), contentType, pageNumber: Number(text("pageNumber")) || 1 },
      { mathMarkers: { inlineMathMarkers: text("inlineMathMarkers"), blockMathMarkers: text("blockMathMarkers") }, signal: request.signal },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (request.signal.aborted) return jsonError("Cancelled.", 499);
    return jsonError(error instanceof Error ? error.message : "Could not read the page.", 502);
  }
}
