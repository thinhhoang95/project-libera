import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireAuth } from "@/lib/api";
import { parseImageGenerationSettings } from "@/lib/image-generation";
import { generateImages, generatedImageName, parseReferenceImages } from "@/lib/image-generation-server";
import { getTree, StorageError, toStorageError, writeUploadedFile } from "@/lib/storage";
import { writeGalleryPhoto } from "@/lib/storage/gallery";
import { isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { writeSharedUpload } from "@/lib/collab/shared-writes";

export const runtime = "nodejs";

const MAX_PROMPT_LENGTH = 32_000;

async function writeToFolder(folderPath: string, name: string, body: Buffer, mediaType: string) {
  const [notebook] = folderPath.split("/");
  // "Notebook folder" destinations in a shared notebook become manifest blobs through the collab host.
  const write = isSharedNotebookPath(folderPath) ? writeSharedUpload : writeUploadedFile;
  const dot = name.lastIndexOf(".");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt ? `${name.slice(0, dot)}-${attempt}${name.slice(dot)}` : name;
    try {
      return await write(notebook, new File([new Uint8Array(body)], candidate, { type: mediaType }), folderPath);
    } catch (error) {
      if (!(error instanceof StorageError && error.status === 409)) throw error;
    }
  }
  throw new StorageError("Could not find a free file name in that folder.", 409);
}

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  let body: { prompt?: unknown; model?: unknown; params?: unknown; destination?: unknown; references?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid request.", 400); }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return jsonError("Describe the image you would like.", 400);
  if (prompt.length > MAX_PROMPT_LENGTH) return jsonError("That prompt is too long.", 400);
  let references: string[];
  try { references = parseReferenceImages(body.references); } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Invalid reference photos.", 400);
  }
  const settings = parseImageGenerationSettings({ model: body.model, paramsByModel: { [String(body.model)]: body.params }, destination: body.destination });

  let generated;
  try {
    generated = await generateImages({ model: settings.model, prompt, params: settings.paramsByModel[settings.model] ?? {}, references }, request.signal);
  } catch (error) {
    if (request.signal.aborted) return jsonError("Image generation was cancelled.", 499);
    return jsonError(error instanceof Error ? error.message : "Could not generate the image.", 502);
  }

  try {
    const createdAt = new Date();
    const destination = settings.destination;
    if (destination.kind === "folder") {
      const files = [];
      for (const [index, image] of generated.images.entries()) {
        files.push(await writeToFolder(destination.path, generatedImageName(prompt, image.mediaType, index, createdAt), image.body, image.mediaType));
      }
      return NextResponse.json({ destination, files, cost: generated.cost, tree: await getTree() });
    }
    const photos = [];
    for (const [index, image] of generated.images.entries()) {
      photos.push(await writeGalleryPhoto(destination.album, generatedImageName(prompt, image.mediaType, index, createdAt), image.body, {
        prompt, model: settings.model, createdAt: createdAt.toISOString(),
      }));
    }
    return NextResponse.json({ destination, photos, cost: generated.cost });
  } catch (error) {
    const storageError = toStorageError(error);
    return jsonError(`The image was generated but could not be saved: ${storageError.message}`, storageError.status);
  }
}
