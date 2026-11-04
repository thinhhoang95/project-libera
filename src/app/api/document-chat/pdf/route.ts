import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { readPdfTextCache } from "@/lib/storage/pdf-text-cache";
import { toStorageError } from "@/lib/storage/errors";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    const pdf = await readPdfTextCache(request.nextUrl.searchParams.get("path") ?? "");
    if (!pdf.pages.some((page) => page.text.trim())) return jsonError("This PDF has no extractable text. Add screenshots as photos to discuss scanned pages.");
    const text = pdf.pages.map((page) => `## Page ${page.pageNumber}\n\n${page.text}`).join("\n\n");
    // The chat sends part of a long PDF, so the limit on what is sent applies there.
    return NextResponse.json({ text, pageCount: pdf.pages.length });
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(storageError.message, storageError.status);
  }
}
