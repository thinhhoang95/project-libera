import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { parseLatexOptions } from "@/lib/latex-options";
import { readLatexOptions, writeLatexOptions } from "@/lib/latex-options-storage";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await readLatexOptions(), { headers: { "Cache-Control": "no-store" } });
  } catch { return jsonError("Could not load saved LaTeX settings.", 500); }
}

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  let options;
  try { options = parseLatexOptions(await request.json()); } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid LaTeX settings.", 400);
  }
  try { return NextResponse.json(await writeLatexOptions(options)); } catch {
    return jsonError("Could not save LaTeX settings. Please retry.", 500);
  }
}
