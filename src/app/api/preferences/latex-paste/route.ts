import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { readMarkdownPasteOptions, writeMarkdownPasteOptions } from "@/lib/latex/markdown-paste-storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await readMarkdownPasteOptions(), { headers: { "Cache-Control": "no-store" } });
  } catch { return jsonError("Could not load the Markdown paste settings.", 500); }
}

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = await request.json().catch(() => null);
  // An object of settings: arrays, strings and null are refused rather than read as "all defaults".
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("Send the Markdown paste settings as an object.", 400);
  try { return NextResponse.json(await writeMarkdownPasteOptions(body)); } catch {
    return jsonError("Could not save the Markdown paste settings. Please retry.", 500);
  }
}
