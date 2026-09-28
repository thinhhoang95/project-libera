import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getAiFunctionOptions, getAiRewriteCustomInstruction } from "@/lib/ai-preferences";
import { formatDocumentContext, INSERTION_MARKER, readDocumentContext } from "@/lib/ai-document-context";
import { createOpenRouterMarkdownCompletion } from "@/lib/openrouter";
import { MAX_QUICK_PROMPT_LENGTH } from "@/lib/quick-prompts";

export const runtime = "nodejs";

async function readSystemPrompt() {
  const formatterPrompt = await readFile(
    path.join(process.cwd(), "prompts", "system_prompt_ai_formatter.md"),
    "utf8",
  );

  const customInstruction = getAiRewriteCustomInstruction().trim();

  return `${formatterPrompt}

Write mode override:

* Write new Markdown content according to the user's instruction. It will be inserted into the user's document at the marked insertion point.
* The rules above about preserving the original text and not inventing content do not apply: you are writing new content, not formatting existing text.
* When the document is provided, the new content goes at ${INSERTION_MARKER}. Use the document only as context: match its topic, tone, language, terminology, heading levels, and notation, and make the new content fit between what comes before and after the marker. Do not repeat the surrounding content unless the instruction asks for it, and do not output the marker.
* Keep all output-format rules from the formatter prompt: return only the new Markdown content, no explanations, no introductions, no closing remarks, and no code fences around the whole response.
* Keep links, images, math delimiters, tables, and code syntax valid.${customInstruction ? `

User-configured custom instructions for every AI Rewrite and Write with AI request:
${customInstruction}` : ""}`;
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as { prompt?: string; before?: string; after?: string };
    const prompt = body.prompt?.trim() ?? "";

    if (!prompt) {
      return jsonError("Enter a prompt describing what to write.", 400);
    }

    if (prompt.length > MAX_QUICK_PROMPT_LENGTH) {
      return jsonError("Write prompt is too long.", 413);
    }

    const context = readDocumentContext(body);
    const markdown = await createOpenRouterMarkdownCompletion([
      {
        role: "system",
        content: await readSystemPrompt(),
      },
      {
        role: "user",
        content: `${context ? `Full document, with the insertion point marked:
${formatDocumentContext(context, INSERTION_MARKER)}

` : ""}Instruction:
${prompt}`,
      },
    ], getAiFunctionOptions("rewrite"));

    if (!markdown.trim()) {
      return jsonError("Write with AI returned an empty response.", 502);
    }

    return NextResponse.json({ markdown });
  } catch (error) {
    return jsonError(
      `Write with AI failed: ${
        error instanceof Error ? error.message : "Write with AI failed."
      }`,
      500,
    );
  }
}
