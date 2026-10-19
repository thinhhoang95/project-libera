import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";

export const runtime = "nodejs";

// Chart.js's browser build for live HTML blocks in Markdown Slides: the
// page fetches it and inlines it into each sandboxed frame
// (slide-live-blocks.tsx). next.config.ts traces the file into the
// standalone build.
const CHART_UMD_PATH = path.join(process.cwd(), "node_modules", "chart.js", "dist", "chart.umd.min.js");

let cached: Promise<Buffer> | null = null;

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    cached ??= readFile(CHART_UMD_PATH);
    return new NextResponse(new Uint8Array(await cached), {
      headers: {
        "Cache-Control": "private, max-age=86400",
        "Content-Type": "text/javascript; charset=utf-8",
      },
    });
  } catch {
    cached = null;
    return NextResponse.json({ error: "Chart library is unavailable." }, { status: 404 });
  }
}
