import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import {
  deleteMarkdownImageSource,
  toStorageError,
  writeMarkdownImageAsset,
} from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const formData = await request.formData();
    const documentPath = String(formData.get("documentPath") ?? "");
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Image file is required." }, { status: 400 });
    }

    return NextResponse.json(await writeMarkdownImageAsset(documentPath, file));
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}

export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      documentPath?: string;
      imageSource?: string;
      nextMarkdown?: string;
    };

    return NextResponse.json(
      await deleteMarkdownImageSource({
        documentPath: body.documentPath ?? "",
        imageSource: body.imageSource ?? "",
        nextMarkdown: body.nextMarkdown,
      }),
    );
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
