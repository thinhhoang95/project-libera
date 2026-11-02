import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { AiEditRequestError, runAiEdit } from "@/lib/ai-edit";
import { MAX_QUICK_PROMPT_LENGTH } from "@/lib/quick-prompts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as { prompt?: string; before?: string; after?: string; format?: string; thread?: unknown };
    const prompt = body.prompt?.trim() ?? "";

    if (!prompt) {
      return jsonError("Enter a prompt describing what to write.", 400);
    }

    if (prompt.length > MAX_QUICK_PROMPT_LENGTH) {
      return jsonError("Write prompt is too long.", 413);
    }

    // The response key predates LaTeX support; it holds LaTeX for LaTeX documents.
    const { output: markdown, thread } = await runAiEdit("write", body, request.signal);

    if (!markdown.trim()) {
      return jsonError("Write with AI returned an empty response.", 502);
    }

    return NextResponse.json({ markdown, ...(thread ? { thread } : {}) });
  } catch (error) {
    if (error instanceof AiEditRequestError) return jsonError(error.message, error.status);
    return jsonError(
      `Write with AI failed: ${
        error instanceof Error ? error.message : "Write with AI failed."
      }`,
      500,
    );
  }
}
