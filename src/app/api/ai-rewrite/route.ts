import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
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

  try {
    const body = (await request.json()) as { prompt?: string; text?: string; before?: string; after?: string; format?: string; thread?: unknown };
    const text = body.text ?? "";
    const prompt = body.prompt?.trim() ?? "";

    if (!text.trim()) {
      return jsonError("Select text to rewrite.", 400);
    }

    if (!prompt) {
      return jsonError("Enter a rewrite prompt.", 400);
    }

    if (text.length > MAX_REWRITE_TEXT_LENGTH) {
      return jsonError("Selection is too large to rewrite in one request.", 413);
    }

    if (prompt.length > MAX_REWRITE_PROMPT_LENGTH) {
      return jsonError("Rewrite prompt is too long.", 413);
    }

    const { output: rewrittenText, thread } = await runAiEdit("rewrite", body);

    if (!rewrittenText.trim()) {
      return jsonError("AI rewrite returned an empty response.", 502);
    }

    return NextResponse.json({ rewrittenText, ...(thread ? { thread } : {}) });
  } catch (error) {
    if (error instanceof AiEditRequestError) return jsonError(error.message, error.status);
    return jsonError(
      `AI rewrite failed: ${
        error instanceof Error ? error.message : "AI rewrite failed."
      }`,
      500,
    );
  }
}
