import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { toStorageError } from "@/lib/storage/errors";
import {
  isRecapSessionId,
  readRecapSession,
  readRecapSummary,
  readRecapView,
  recordRecapSessions,
  saveRecapSummary,
} from "@/lib/storage/where-was-i";
import { getWhereWasISettings, summarizeRecapSession, whereWasISummariesAvailable } from "@/lib/where-was-i-ai";
import type { RecapSessionUpdate, RecapSummary } from "@/lib/where-was-i";

export const runtime = "nodejs";

function storageErrorResponse(error: unknown) {
  const storageError = toStorageError(error);
  return jsonError(storageError.message, storageError.status);
}

/** The notebook home's recap: GET /api/where-was-i?notebook=…&session=<this window's session>. */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const notebook = request.nextUrl.searchParams.get("notebook") ?? "";
  const session = request.nextUrl.searchParams.get("session") ?? "";
  // Turned off in Preferences: the home shows no card.
  if (!getWhereWasISettings().enabled) return NextResponse.json({ disabled: true });
  try {
    return NextResponse.json(await readRecapView(notebook, session, whereWasISummariesAvailable()));
  } catch (error) {
    return storageErrorResponse(error);
  }
}

/** Records this window's session. Sent when a file closes and when the app quits. */
export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  // Turned off in Preferences: nothing is recorded.
  if (!getWhereWasISettings().enabled) return NextResponse.json({ ok: true, recorded: false });
  try {
    await recordRecapSessions((await request.json()) as RecapSessionUpdate);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

// One summary per finished session: concurrent requests share a run, and a
// failed run is not retried for a while, so a broken key or model cannot turn
// every visit to the notebook home into a paid request.
// Short enough to outlast an upstream rate limit, long enough to stay cheap.
const RETRY_AFTER_FAILURE_MS = 3 * 60_000;
const running = new Map<string, Promise<RecapSummary>>();
const failedAt = new Map<string, number>();

/** Summarizes a finished session once and stores the bullets: POST { notebook, sessionId }. */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const body = (await request.json().catch(() => null)) as { notebook?: unknown; sessionId?: unknown; retry?: unknown } | null;
  const notebook = typeof body?.notebook === "string" ? body.notebook : "";
  const sessionId = body?.sessionId;
  if (!notebook || !isRecapSessionId(sessionId)) return jsonError("Invalid request.");
  if (!whereWasISummariesAvailable()) return jsonError("Session summaries are turned off or no OpenRouter key is set.", 409);

  const key = `${notebook}\0${sessionId}`;
  const failed = failedAt.get(key);
  // "Try again" on the card is a person asking, not a revisit.
  if (failed && body?.retry !== true && Date.now() - failed < RETRY_AFTER_FAILURE_MS) return jsonError("The last summary attempt failed. Try again later.", 429);

  try {
    let task = running.get(key);
    if (!task) {
      task = (async () => {
        const existing = await readRecapSummary(notebook, sessionId);
        if (existing) return existing;
        const session = await readRecapSession(notebook, sessionId);
        if (!session?.files.length) throw new Error("There is no session to summarize.");
        const { bullets, model } = await summarizeRecapSession(notebook, session, AbortSignal.timeout(45_000));
        const summary: RecapSummary = { sessionId, bullets, model, generatedAt: new Date().toISOString() };
        await saveRecapSummary(notebook, summary);
        return summary;
      })();
      running.set(key, task);
      void task.finally(() => running.delete(key)).catch(() => undefined);
    }
    const summary = await task;
    failedAt.delete(key);
    return NextResponse.json({ summary });
  } catch (error) {
    failedAt.set(key, Date.now());
    console.error("Where Was I: could not summarize a session.", error);
    return jsonError(error instanceof Error ? error.message : "Could not summarize the session.", 502);
  }
}
