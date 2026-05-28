import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getTree, toStorageError, writeUploadedFile } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const formData = await request.formData();
    const notebook = String(formData.get("notebook") ?? "");
    const files = formData.getAll("files").filter((item): item is File => item instanceof File);

    if (!files.length) {
      return NextResponse.json({ error: "At least one file is required." }, { status: 400 });
    }

    const uploaded = [];

    for (const file of files) {
      uploaded.push(await writeUploadedFile(notebook, file));
    }

    return NextResponse.json({
      uploaded,
      tree: await getTree(),
    });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
