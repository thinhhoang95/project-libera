import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { cancelPythonRuntimeSetup, ensurePythonRuntime, getPythonRuntimeStatus } from "@/lib/python/runtime";

export const runtime = "nodejs";

/**
 * Whether Python for notes is ready, and any setup in progress. The app asks
 * with `?ensure=1` when it opens, which starts the setup on a new computer.
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  if (request.nextUrl.searchParams.get("ensure") === "1") ensurePythonRuntime();
  return NextResponse.json(getPythonRuntimeStatus());
}

/** Retry a setup that failed (or start one); the client polls GET for progress. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  ensurePythonRuntime({ retry: true });
  return NextResponse.json(getPythonRuntimeStatus());
}

export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  cancelPythonRuntimeSetup();
  return NextResponse.json(getPythonRuntimeStatus());
}
