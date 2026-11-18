import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getServerT } from "@/lib/i18n/server-locale";
import { AiEditRequestError, runAiEdit } from "@/lib/ai-edit";
import { MAX_QUICK_PROMPT_LENGTH } from "@/lib/quick-prompts";

export const runtime = "nodejs";

const MAX_REWRITE_PROMPT_LENGTH = MAX_QUICK_PROMPT_LENGTH;
const MAX_REWRITE_TEXT_LENGTH = 20_000;

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  const t = await getServerT("aiRoutes");
  try {
    const body = (await request.json()) as { prompt?: string; text?: string; before?: string; after?: string; format?: string; thread?: unknown; model?: unknown; reasoningEffort?: unknown };
    const text = body.text ?? "";
    const prompt = body.prompt?.trim() ?? "";

    if (!text.trim()) {
      return jsonError(t("rewrite.selectText"), 400);
    }

    if (!prompt) {
      return jsonError(t("rewrite.enterPrompt"), 400);
    }

    if (text.length > MAX_REWRITE_TEXT_LENGTH) {
      return jsonError(t("rewrite.tooLarge"), 413);
    }

    if (prompt.length > MAX_REWRITE_PROMPT_LENGTH) {
      return jsonError(t("rewrite.promptTooLong"), 413);
    }

    const { output: rewrittenText, thread } = await runAiEdit("rewrite", body, request.signal);

    if (!rewrittenText.trim()) {
      return jsonError(t("rewrite.empty"), 502);
    }

    return NextResponse.json({ rewrittenText, ...(thread ? { thread } : {}) });
  } catch (error) {
    if (error instanceof AiEditRequestError) return jsonError(error.message, error.status);
    return jsonError(
      t("rewrite.failed", { detail: error instanceof Error ? error.message : t("unknownError") }),
      500,
    );
  }
}
