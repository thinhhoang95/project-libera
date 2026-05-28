import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertImageFileName,
  assertMarkdownFileName,
  assertSupportedFileName,
  ensureImageName,
  normalizeAssetFileName,
  getContentType,
} from "@/lib/storage/file-types";
import { findAvailableFilePath, pathExists } from "@/lib/storage/fs-utils";
import {
  ensureAdminRoot,
  filePathFromParts,
  imageAnnotationsPath,
  legacyImageAnnotationsPath,
  markdownAssetPath,
  markdownAssetsDirectoryName,
  markdownAssetsDirectoryPath,
  markdownAssetsDirectoryPathFromParts,
  markdownAssetsPathPrefix,
  notebookPath,
  normalizeMarkdownAssetPath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import { StorageError } from "@/lib/storage/errors";
import { MARKDOWN_ASSETS_DIR } from "@/lib/storage/constants";
import type { MarkdownImageAssetPayload } from "@/lib/types";

function markdownImageSources(markdown: string) {
  const sources = new Set<string>();
  const markdownImagePattern = /!\[[^\]]*]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  const htmlImagePattern = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi;

  for (const match of markdown.matchAll(markdownImagePattern)) {
    const source = match[1]?.trim() ?? "";
    sources.add(source.startsWith("<") && source.endsWith(">") ? source.slice(1, -1) : source);
  }

  for (const match of markdown.matchAll(htmlImagePattern)) {
    sources.add(match[2]?.trim() ?? "");
  }

  return [...sources].filter(Boolean);
}

function markdownAssetSourceTarget(documentPath: string, source: string) {
  if (source.startsWith("/api/markdown-assets/raw")) {
    const url = new URL(source, "http://libera.local");
    return {
      documentPath: url.searchParams.get("document") ?? documentPath,
      assetPath: normalizeMarkdownAssetPath(url.searchParams.get("asset") ?? ""),
    };
  }

  if (
    source.startsWith("#") ||
    source.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(source)
  ) {
    return null;
  }

  return {
    documentPath,
    assetPath: normalizeMarkdownAssetPath(source),
  };
}

function rawFileSourcePath(source: string) {
  if (!source.startsWith("/api/files/raw/")) {
    return null;
  }

  return source
    .slice("/api/files/raw/".length)
    .split("/")
    .map(decodeURIComponent)
    .join("/");
}

function referencedMarkdownAssetPaths(documentPath: string, markdown: string) {
  const assetPaths = new Set<string>();

  for (const source of markdownImageSources(markdown)) {
    try {
      const target = markdownAssetSourceTarget(documentPath, source);

      if (target?.documentPath === documentPath) {
        assetPaths.add(target.assetPath);
      }
    } catch {
      // Ignore malformed image URLs while pruning; rendering will surface them.
    }
  }

  return assetPaths;
}

function referencedRawFilePaths(markdown: string) {
  const rawPaths = new Set<string>();

  for (const source of markdownImageSources(markdown)) {
    const rawPath = rawFileSourcePath(source);

    if (rawPath) {
      rawPaths.add(rawPath);
    }
  }

  return rawPaths;
}

async function removeEmptyDirectory(targetPath: string) {
  try {
    await rm(targetPath, { recursive: false });
  } catch {
    // The directory is either absent or still contains referenced assets.
  }
}

async function pruneAssetDirectory({
  assetDirectory,
  assetPathPrefix,
  referencedAssets,
}: {
  assetDirectory: string;
  assetPathPrefix: string;
  referencedAssets: Set<string>;
}) {
  if (!(await pathExists(assetDirectory))) {
    return;
  }

  const entries = await readdir(assetDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const targetPath = path.join(assetDirectory, entry.name);
    const assetPath = `${assetPathPrefix}/${entry.name}`;

    if (entry.isDirectory()) {
      await pruneAssetDirectory({
        assetDirectory: targetPath,
        assetPathPrefix: assetPath,
        referencedAssets,
      });
      await removeEmptyDirectory(targetPath);
      continue;
    }

    if (entry.isFile() && !referencedAssets.has(assetPath)) {
      await rm(targetPath, { force: true });
    }
  }
}

export async function writeMarkdownImageAsset(
  documentPath: string,
  upload: File,
): Promise<MarkdownImageAssetPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const safeName = normalizeAssetFileName(ensureImageName(upload.name));
  const assetDirectory = markdownAssetsDirectoryPathFromParts(notebook, pathParts);
  await mkdir(assetDirectory, { recursive: true });

  const available = await findAvailableFilePath(assetDirectory, safeName);
  await writeFile(available.path, Buffer.from(await upload.arrayBuffer()));

  const assetPath = `${markdownAssetsPathPrefix(pathParts)}/${available.name}`;

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
    const rawPath = rawFileSourcePath(source) ?? "";
    const { notebook, name, pathParts } = splitFilePath(rawPath);
    assertImageFileName(name);

    return {
      body: await readFile(filePathFromParts(notebook, pathParts)),
      contentType: getContentType(name, "image"),
      assetPath: rawPath,
      fileName: name,
    };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    throw new StorageError("Only local Markdown images can be converted.");
  }

  return getMarkdownImageAsset(documentPath, source);
}

export async function pruneUnusedMarkdownImageAssets(
  documentPath: string,
  markdown: string,
) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  await stat(filePathFromParts(notebook, pathParts));

  const assetDirectory = markdownAssetsDirectoryPath(notebook, name);
  const currentAssetDirectory = markdownAssetsDirectoryPathFromParts(notebook, pathParts);
  const currentAssetPathPrefix = markdownAssetsPathPrefix(pathParts);
  const legacyAssetPathPrefix = `${MARKDOWN_ASSETS_DIR}/${markdownAssetsDirectoryName(
    name,
  )}`;
  const referencedAssets = referencedMarkdownAssetPaths(
    relativeFilePath(notebook, pathParts),
    markdown,
  );

  await pruneAssetDirectory({
    assetDirectory: currentAssetDirectory,
    assetPathPrefix: currentAssetPathPrefix,
    referencedAssets,
  });

  if (currentAssetDirectory !== assetDirectory) {
    await pruneAssetDirectory({
      assetDirectory,
      assetPathPrefix: legacyAssetPathPrefix,
      referencedAssets,
    });
  }

  await removeEmptyDirectory(currentAssetDirectory);
  await removeEmptyDirectory(assetDirectory);
  await removeEmptyDirectory(path.join(notebookPath(notebook), MARKDOWN_ASSETS_DIR));
}

export async function deleteMarkdownImageSource({
  documentPath,
  imageSource,
  nextMarkdown,
}: {
  documentPath: string;
  imageSource: string;
  nextMarkdown?: string;
}) {
  await ensureAdminRoot();

  const source = imageSource.trim();

  if (!source || parseDataImageSource(source) || /^[a-z][a-z0-9+.-]*:/i.test(source)) {
    return { deleted: false };
  }

  const rawPath = rawFileSourcePath(source);

  if (rawPath) {
    if (nextMarkdown && referencedRawFilePaths(nextMarkdown).has(rawPath)) {
      return { deleted: false };
    }

    const { notebook, name, pathParts } = splitFilePath(rawPath);
    assertImageFileName(name);
    await rm(filePathFromParts(notebook, pathParts), { force: true });
    await rm(imageAnnotationsPath(notebook, name), { force: true });
    await rm(legacyImageAnnotationsPath(notebook, name), { force: true });
    return { deleted: true };
  }

  const target = markdownAssetSourceTarget(documentPath, source);

  if (!target) {
    return { deleted: false };
  }

  if (nextMarkdown) {
    const referencedAssets = referencedMarkdownAssetPaths(target.documentPath, nextMarkdown);

    if (referencedAssets.has(target.assetPath)) {
      return { deleted: false };
    }
  }

  const { notebook } = splitFilePath(target.documentPath);
  const asset = markdownAssetPath(notebook, target.assetPath);

  await rm(asset.targetPath, { force: true });

  return { deleted: true };
}

function parseDataImageSource(source: string) {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(source);
}
