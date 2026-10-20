import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import { contentDisposition } from "@/lib/content-disposition";
import { parseByteRange } from "@/lib/http-range";
import { getRawFile, locateRawFile, toStorageError } from "@/lib/storage";

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
    const relativePath = path.map(decodeURIComponent).join("/");
    const located = await locateRawFile(relativePath);

    // Recordings are streamed, and in ranges, so the player can seek through
    // an hour-long memo without loading all of it.
    if (located.fileType === "audio") {
      const size = located.node.size;
      const headers: Record<string, string> = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": contentDisposition("inline", located.node.name),
        "Content-Type": located.contentType,
      };
      const rangeHeader = request.headers.get("range");
      const range = rangeHeader ? parseByteRange(rangeHeader, size) : null;
      if (rangeHeader && !range) {
        return new NextResponse(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
      }
      const { start, end } = range ?? { start: 0, end: size - 1 };
      const body = size ? Readable.toWeb(createReadStream(located.absolutePath, { start, end })) as ReadableStream : null;
      return new NextResponse(body, {
        status: range ? 206 : 200,
        headers: {
          ...headers,
          "Content-Length": String(size ? end - start + 1 : 0),
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
        },
      });
    }

    const rawFile = await getRawFile(relativePath);

    return new NextResponse(rawFile.body, {
      headers: {
        "Cache-Control": "private, max-age=60",
        "Content-Disposition": contentDisposition("inline", rawFile.node.name),
        "Content-Type": rawFile.contentType,
      },
    });
  } catch (error) {
    const storageError = toStorageError(error);
    return NextResponse.json({ error: storageError.message }, { status: storageError.status });
  }
}
