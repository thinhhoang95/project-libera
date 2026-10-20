// /api/collab/* → the collab host's control API (local-api.ts).
//
// The routes mirror ControlRoutes one to one behind the local app session.
// The host's bearer token is added here and never reaches the renderer.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { CollabHostError, collabHostConfig, fetchCollabHost } from "@/lib/collab/host-client";
import { ControlRoutes } from "@/lib/collab/local-api";

export const runtime = "nodejs";

/** Matches the control server's body limit. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function collabError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const config = collabHostConfig();
  if (!config) return collabError(503, "collab-disabled", "Collaboration is not enabled in this Libera.");

  const { path } = await context.params;
  // Segments arrive decoded; re-encode each so ids containing "/" or "?"
  // stay one segment, and refuse dot segments outright.
  if (!Array.isArray(path) || path.length === 0 || path.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return collabError(404, "not-found", "Unknown collaboration route.");
  }
  const target = `/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  // Only the login route hands the (verified) master password to the host.
  if (target.split("?")[0].toLowerCase() === ControlRoutes.unlock) {
    return collabError(404, "not-found", "Unknown collaboration route.");
  }

  let bodyText: string | undefined;
  if (request.method !== "GET" && request.method !== "DELETE") {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return collabError(413, "too-large", "The request body is too large.");
    }
    bodyText = await request.text();
    if (bodyText.length > MAX_BODY_BYTES) return collabError(413, "too-large", "The request body is too large.");
  }

  let response: Response;
  try {
    response = await fetchCollabHost(target, { method: request.method, bodyText, config, signal: request.signal });
  } catch (error) {
    if (error instanceof CollabHostError) return collabError(error.status, error.code, error.message);
    throw error;
  }
  // 401 from the host means Next holds the wrong token (a host restarted
  // with a new one). Passing it on would read as "the app session expired".
  if (response.status === 401) {
    await response.body?.cancel();
    return collabError(502, "collab-host-auth", "The collaboration service refused this app's credentials. Restart Libera.");
  }
  const headers = new Headers({ "cache-control": "no-store" });
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (response.status === 204) return new NextResponse(null, { status: 204, headers });
  return new NextResponse(await response.arrayBuffer(), { status: response.status, headers });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
