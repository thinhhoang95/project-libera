import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import {
  copyFileToDirectory,
  createMarkdownFile,
  deleteFile,
  moveFileToDirectory,
  moveFile,
  readLiberaFile,
  toStorageError,
  updateMarkdownFile,
} from "@/lib/storage";

export const runtime = "nodejs";

function handleError(error: unknown) {
  const storageError = toStorageError(error);
  return NextResponse.json({ error: storageError.message }, { status: storageError.status });
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const filePath = request.nextUrl.searchParams.get("path") ?? "";
    return NextResponse.json(await readLiberaFile(filePath));
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      notebook?: string;
      name?: string;
      content?: string;
      parentPath?: string;
    };

    return NextResponse.json(
      await createMarkdownFile(
        body.notebook ?? "",
        body.name ?? "",
        body.content ?? "",
        body.parentPath,
      ),
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      path?: string;
      content?: string;
      destinationNotebook?: string;
      destinationName?: string;
      destinationDirectory?: string;
      copy?: boolean;
    };

    if (body.copy && body.destinationDirectory) {
      return NextResponse.json(
        await copyFileToDirectory(
          body.path ?? "",
          body.destinationDirectory,
          body.destinationName,
        ),
      );
    }

    if (body.destinationDirectory) {
      return NextResponse.json(
        await moveFileToDirectory(
          body.path ?? "",
          body.destinationDirectory,
          body.destinationName,
        ),
      );
    }

    if (body.destinationNotebook || body.destinationName) {
      return NextResponse.json(
        await moveFile(
          body.path ?? "",
          body.destinationNotebook ?? "",
          body.destinationName ?? "",
        ),
      );
    }

    return NextResponse.json(await updateMarkdownFile(body.path ?? "", body.content ?? ""));
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const filePath = request.nextUrl.searchParams.get("path") ?? "";
    return NextResponse.json(await deleteFile(filePath));
  } catch (error) {
    return handleError(error);
  }
}
