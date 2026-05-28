import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { getRawFile, toStorageError } from "@/lib/storage";

export const runtime = "nodejs";

type RawFileRouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export async function GET(request: NextRequest, context: RawFileRouteContext) {
  const authError = requireAuth(request);

  if (authError) {
    return authError;
  }

  try {
    const { path } = await context.params;
    const rawFile = await getRawFile(path.map(decodeURIComponent).join("/"));

    return new NextResponse(rawFile.body, {
      headers: {
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": `inline; filename="${rawFile.node.name.replaceAll('"', "")}"`,
        "Content-Type": rawFile.contentType,
      },
    });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
