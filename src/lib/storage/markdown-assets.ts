import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertMarkdownFileName,
  assertSupportedFileName,
  ensureImageName,
  normalizeAssetFileName,
  getContentType,
} from "@/lib/storage/file-types";
import { findAvailableFilePath } from "@/lib/storage/fs-utils";
import {
  ensureAdminRoot,
  filePathFromParts,
  markdownAssetPath,
  markdownAssetsDirectoryName,
  markdownAssetsDirectoryPath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import { StorageError } from "@/lib/storage/errors";
import { getRawFile } from "@/lib/storage/files";
import { MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import type { MarkdownImageAssetPayload } from "@/lib/types";

export async function writeMarkdownImageAsset(
  documentPath: string,
  upload: File,
): Promise<MarkdownImageAssetPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const safeName = normalizeAssetFileName(ensureImageName(upload.name));
  const assetDirectory = markdownAssetsDirectoryPath(notebook, name);
  await mkdir(assetDirectory, { recursive: true });

  const available = await findAvailableFilePath(assetDirectory, safeName);
  await writeFile(available.path, Buffer.from(await upload.arrayBuffer()));

  const assetPath = `${MARKDOWN_ASSETS_DIR}/${markdownAssetsDirectoryName(
    name,
  )}/${available.name}`;

  return {
    assetPath,
    markdown: `![${path.basename(available.name, path.extname(available.name))}](${assetPath})`,
    rawUrl: `/api/markdown-assets/raw?document=${encodeURIComponent(
      relativeFilePath(notebook, pathParts),
    )}&asset=${encodeURIComponent(assetPath)}`,
  };
}

export async function getMarkdownImageAsset(documentPath: string, assetPath: string) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const asset = markdownAssetPath(notebook, assetPath);
  const fileName = path.basename(asset.normalized);
  const fileType = assertSupportedFileName(fileName);

  if (fileType !== "image") {
    throw new StorageError("Markdown asset is not an image.");
  }

  return {
    body: await readFile(asset.targetPath),
    contentType: getContentType(fileName, fileType),
    assetPath: asset.normalized,
    fileName,
  };
}

export async function getMarkdownImageAssetBySource(
  documentPath: string,
  imageSource: string,
) {
  const source = imageSource.trim();

  if (!source) {
    throw new StorageError("Image source is required.");
  }

  if (source.startsWith("/api/markdown-assets/raw")) {
    const url = new URL(source, "http://libera.local");
    const sourceDocumentPath = url.searchParams.get("document") ?? documentPath;
    const assetPath = url.searchParams.get("asset") ?? "";
    return getMarkdownImageAsset(sourceDocumentPath, assetPath);
  }

  if (source.startsWith("/api/files/raw/")) {
    const rawPath = source
      .slice("/api/files/raw/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const rawFile = await getRawFile(rawPath);

    if (rawFile.node.fileType !== "image") {
      throw new StorageError("Markdown image source is not an image.");
    }

    return {
      body: rawFile.body,
      contentType: rawFile.contentType,
      assetPath: rawPath,
      fileName: rawFile.node.name,
    };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    throw new StorageError("Only local Markdown images can be converted.");
  }

  return getMarkdownImageAsset(documentPath, source);
}
