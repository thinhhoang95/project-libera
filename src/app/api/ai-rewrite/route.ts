import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getAiFunctionOptions, getAiRewriteCustomInstruction } from "@/lib/ai-preferences";
import { formatDocumentContext, readDocumentContext, SELECTION_END_MARKER, SELECTION_START_MARKER } from "@/lib/ai-document-context";
import { createOpenRouterMarkdownCompletion } from "@/lib/openrouter";
import { MAX_QUICK_PROMPT_LENGTH } from "@/lib/quick-prompts";

export const runtime = "nodejs";

const MAX_REWRITE_PROMPT_LENGTH = MAX_QUICK_PROMPT_LENGTH;
const MAX_REWRITE_TEXT_LENGTH = 20_000;

async function readSystemPrompt() {
  const formatterPrompt = await readFile(
    path.join(process.cwd(), "prompts", "system_prompt_ai_formatter.md"),
    "utf8",
  );

  const customInstruction = getAiRewriteCustomInstruction().trim();

  return `${formatterPrompt}

Rewrite mode override:

* Rewrite the selected Markdown according to the user's rewrite instruction.
* The rewrite instruction may change wording, length, tone, structure, or emphasis.
* The rules above that say to preserve original content exactly and not rewrite are overridden only as needed to satisfy the user's rewrite instruction.
* Keep all output-format rules from the formatter prompt: return only Markdown content, no explanations, no introductions, no closing remarks, and no code fences around the whole response.
* Preserve Markdown validity and keep links, images, math delimiters, tables, and code syntax correct unless the user's rewrite instruction explicitly asks to change them.
* When the full document is provided, the selected Markdown is the part between ${SELECTION_START_MARKER} and ${SELECTION_END_MARKER}. Use the rest of the document only as context (topic, tone, terminology, notation, heading levels, what comes before and after) and return only the replacement for the selected part, without the markers.${customInstruction ? `

User-configured custom instructions for every AI Rewrite request:
${customInstruction}` : ""}`;
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as { prompt?: string; text?: string; before?: string; after?: string };
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

    const context = readDocumentContext(body);
    const rewrittenText = await createOpenRouterMarkdownCompletion([
      {
        role: "system",
        content: await readSystemPrompt(),
      },
      {
        role: "user",
        content: `${context ? `Full document, with the selected Markdown marked:
${formatDocumentContext(context, `${SELECTION_START_MARKER}${text}${SELECTION_END_MARKER}`)}

` : ""}Rewrite instruction:
${prompt}

Selected Markdown:
${text}`,
      },
    ], getAiFunctionOptions("rewrite"));

    if (!rewrittenText.trim()) {
      return jsonError("AI rewrite returned an empty response.", 502);
    }

    return NextResponse.json({ rewrittenText });
  } catch (error) {
    return jsonError(
      `AI rewrite failed: ${
        error instanceof Error ? error.message : "AI rewrite failed."
      }`,
      500,
    );
  }
}
