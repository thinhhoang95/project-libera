import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { docTagsToMarkdown } from "@/lib/document-ocr/doctags";
import { detectDocumentOcrModel, documentOcrModelDirectory } from "@/lib/document-ocr/model";
import { getDocumentOcrWorker } from "@/lib/document-ocr/worker-client";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Read one page or snip image into Markdown with the local model.
 * Form fields: `image` (PNG or JPEG), optional `inlineMathMarkers` and
 * `blockMathMarkers` from Preferences, `maxNewTokens`, and `maxEdge`, the
 * largest long edge in pixels the model reads the image at.
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const directory = documentOcrModelDirectory();
  const dtype = await detectDocumentOcrModel(directory);
  if (!dtype) {
    return jsonError(
      directory
        ? "The PDF reading model is not in its folder yet. Download it first."
        : "Choose a folder for the PDF reading model in Preferences → Search.",
      409,
    );
  }

  try {
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File) || !image.size) return jsonError("An image is required.", 400);
    if (image.size > MAX_IMAGE_BYTES) return jsonError("The image is too large to read.", 413);

    const text = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" && value ? value : undefined;
    };
    const result = await getDocumentOcrWorker().convert(new Uint8Array(await image.arrayBuffer()), { directory, dtype }, {
      maxNewTokens: Number(text("maxNewTokens")) || undefined,
      maxEdge: Number(text("maxEdge")) || undefined,
      signal: request.signal,
    });
    if (result.stopped === "cancelled") return jsonError("Cancelled.", 499);

    const converted = docTagsToMarkdown(result.doctags, {
      inlineMathMarkers: text("inlineMathMarkers"),
      blockMathMarkers: text("blockMathMarkers"),
    });

    return NextResponse.json({
      ...converted,
      stopped: result.stopped,
      tokens: result.tokens,
      ms: result.ms,
    });
  } catch (error) {
    if (request.signal.aborted) return jsonError("Cancelled.", 499);
    return jsonError(error instanceof Error ? error.message : "Could not read the image.", 500);
  }
}
