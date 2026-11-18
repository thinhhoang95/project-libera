import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getServerT } from "@/lib/i18n/server-locale";
import { AiEditRequestError, runAiEdit } from "@/lib/ai-edit";
import { MAX_QUICK_PROMPT_LENGTH } from "@/lib/quick-prompts";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  const t = await getServerT("aiRoutes");
  try {
    const body = (await request.json()) as { prompt?: string; before?: string; after?: string; format?: string; thread?: unknown; model?: unknown; reasoningEffort?: unknown };
    const prompt = body.prompt?.trim() ?? "";

    if (!prompt) {
      return jsonError(t("write.enterPrompt"), 400);
    }

    if (prompt.length > MAX_QUICK_PROMPT_LENGTH) {
      return jsonError(t("write.promptTooLong"), 413);
    }

    // The response key predates LaTeX support; it holds LaTeX for LaTeX documents.
    const { output: markdown, thread } = await runAiEdit("write", body, request.signal);

    if (!markdown.trim()) {
      return jsonError(t("write.empty"), 502);
    }

    return NextResponse.json({ markdown, ...(thread ? { thread } : {}) });
  } catch (error) {
    if (error instanceof AiEditRequestError) return jsonError(error.message, error.status);
    return jsonError(
      t("write.failed", { detail: error instanceof Error ? error.message : t("unknownError") }),
      500,
    );
  }
}
