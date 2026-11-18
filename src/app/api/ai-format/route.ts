import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getServerT } from "@/lib/i18n/server-locale";
import { AiTaskChoiceError, getAiTaskOptions, withAiCustomInstruction } from "@/lib/ai-preferences";
import { createOpenRouterCompletion, createOpenRouterMarkdownCompletion } from "@/lib/openrouter";
import { LATEX_FORMAT_PROMPT, normalizeLatexOutput } from "@/lib/latex/ai-prompts";

export const runtime = "nodejs";

const MAX_FORMAT_TEXT_LENGTH = 20_000;

async function readSystemPrompt() {
  return readFile(
    path.join(process.cwd(), "prompts", "system_prompt_ai_formatter.md"),
    "utf8",
  );
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  const t = await getServerT("aiRoutes");
  try {
    const body = (await request.json()) as { text?: string; format?: string; model?: unknown; reasoningEffort?: unknown };
    const text = body.text ?? "";

    if (!text.trim()) {
      return jsonError(t("format.selectText"), 400);
    }

    if (text.length > MAX_FORMAT_TEXT_LENGTH) {
      return jsonError(t("format.tooLarge"), 413);
    }

    const options = getAiTaskOptions("formatting", body);
    const formattedText = body.format === "latex"
      ? normalizeLatexOutput((await createOpenRouterCompletion([
        { role: "system", content: withAiCustomInstruction(LATEX_FORMAT_PROMPT, "formatting") },
        { role: "user", content: text },
      ], { ...options, signal: request.signal })).content)
      : await createOpenRouterMarkdownCompletion([
        {
          role: "system",
          content: withAiCustomInstruction(await readSystemPrompt(), "formatting"),
        },
        {
          role: "user",
          content: text,
        },
      ], { ...options, signal: request.signal });

    if (!formattedText.trim()) {
      return jsonError(t("format.empty"), 502);
    }

    return NextResponse.json({ formattedText });
  } catch (error) {
    if (error instanceof AiTaskChoiceError) return jsonError(error.message, 400);
    return jsonError(
      t("format.failed", { detail: error instanceof Error ? error.message : t("unknownError") }),
      500,
    );
  }
}
