import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { createOpenRouterMarkdownCompletion } from "@/lib/openrouter";

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

  try {
    const body = (await request.json()) as { text?: string };
    const text = body.text ?? "";

    if (!text.trim()) {
      return jsonError("Select text to format.", 400);
    }

    if (text.length > MAX_FORMAT_TEXT_LENGTH) {
      return jsonError("Selection is too large to format in one request.", 413);
    }

    const formattedText = await createOpenRouterMarkdownCompletion([
      {
        role: "system",
        content: await readSystemPrompt(),
      },
      {
        role: "user",
        content: text,
      },
    ]);

    if (!formattedText.trim()) {
      return jsonError("AI formatting returned an empty response.", 502);
    }

    return NextResponse.json({ formattedText });
  } catch (error) {
    return jsonError(
      `AI formatting failed: ${
        error instanceof Error ? error.message : "AI formatting failed."
      }`,
      500,
    );
  }
}
