import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { DOCUMENT_OCR_MODEL, getDocumentOcrModelDownloader } from "@/lib/document-ocr/model";

export const runtime = "nodejs";

async function status() {
  const downloader = getDocumentOcrModelDownloader();
  return NextResponse.json({
    ...(await downloader.getStatus()),
    model: DOCUMENT_OCR_MODEL.name,
    license: DOCUMENT_OCR_MODEL.license,
  });
}

/** Whether the PDF reading model is installed, or how far its download has come. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  return status();
}

/** Start downloading the model; the client polls GET for progress. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    getDocumentOcrModelDownloader().start();
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not start the download.", 409);
  }
  return status();
}

/** Cancel a running download. The files so far are kept so it can resume. */
export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  getDocumentOcrModelDownloader().cancel();
  return status();
}
