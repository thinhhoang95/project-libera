import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { getServerT } from "@/lib/i18n/server-locale";
import { getAiFunctionOptions, withAiCustomInstruction } from "@/lib/ai-preferences";
import { createOpenRouterMarkdownCompletion } from "@/lib/openrouter";
import { getMarkdownImageAssetBySource, toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function readSystemPrompt() {
  return readFile(
    path.join(process.cwd(), "prompts", "system_prompt_ai_image_to_markdown.md"),
    "utf8",
  );
}

function parseDataImage(source: string) {
  const match = source.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i);

  if (!match) {
    return null;
  }

  return {
    contentType: match[1],
    body: Buffer.from(match[2], "base64"),
  };
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  const t = await getServerT("aiRoutes");
  try {
    const body = (await request.json()) as {
      documentPath?: string;
      imageSource?: string;
      alt?: string;
    };
    const imageSource = body.imageSource ?? "";
    const dataImage = parseDataImage(imageSource);
    const image = dataImage
      ? dataImage
      : await getMarkdownImageAssetBySource(body.documentPath ?? "", imageSource);

    if (image.body.byteLength > MAX_IMAGE_BYTES) {
      return jsonError(t("imageToMarkdown.tooLarge"), 413);
    }

    const markdown = await createOpenRouterMarkdownCompletion([
      {
        role: "system",
        content: withAiCustomInstruction(await readSystemPrompt(), "imageToMarkdown"),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: body.alt
              ? `Convert this image to Markdown. Existing alt text: ${body.alt}`
              : "Convert this image to Markdown.",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${image.contentType};base64,${Buffer.from(image.body).toString(
                "base64",
              )}`,
            },
          },
        ],
      },
    ], { ...getAiFunctionOptions("imageToMarkdown"), signal: request.signal });

    if (!markdown.trim()) {
      return jsonError(t("imageToMarkdown.empty"), 502);
    }

    return NextResponse.json({ markdown });
  } catch (error) {
    const storageError = toStorageError(error);

    if (storageError.status !== 500) {
      return NextResponse.json({ error: storageError.message }, { status: storageError.status });
    }

    return jsonError(
      t("imageToMarkdown.failed", { detail: error instanceof Error ? error.message : t("unknownError") }),
      500,
    );
  }
}
