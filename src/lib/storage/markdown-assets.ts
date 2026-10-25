import { mkdir, open, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertImageFileName,
  assertMarkdownFileName,
  assertSupportedFileName,
  ensureImageName,
  normalizeAssetFileName,
  getContentType,
} from "@/lib/storage/file-types";
import { copyFileIfExists, findAvailableFilePath, moveFileIfExists, pathExists } from "@/lib/storage/fs-utils";
import {
  ensureAdminRoot,
  filePathFromParts,
  markdownAssetPath,
  markdownAssetsDirectoryName,
  markdownAssetsDirectoryPathFromParts,
  markdownAssetsPathPrefix,
  notebookPath,
  normalizeMarkdownAssetPath,
  relativeFilePath,
  splitFilePath,
} from "@/lib/storage/paths";
import { StorageError } from "@/lib/storage/errors";
import { MARKDOWN_ASSETS_DIR, MARKDOWN_EXTENSIONS } from "@/lib/storage/constants";
import type { MarkdownImageAssetPayload } from "@/lib/types";
import { assertNotSharedItem, isSharedNotebookPath } from "@/lib/collab/shared-notebook";
import { markdownImageSources, rewriteMarkdownImageSources } from "@/lib/markdown-image-sources";
import { isInkBlockRenderingName } from "@/lib/ink/block";
import { legacyPythonSidecarPath, ownsPythonFigureSource, parsePythonFigureSource, previousPythonFigureSources, pythonFigureFolder, pythonFigureSourcePrefix, pythonSidecarPath, withPreviousPythonFigureSources } from "@/lib/python/sidecar";

export { markdownImageSources } from "@/lib/markdown-image-sources";

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
    assetPath: normalizeMarkdownAssetPath(source.split(/[?#]/, 1)[0]),
  };
}

function rawFileSourcePath(source: string) {
  if (!source.startsWith("/api/files/raw/")) {
    return null;
  }

  return new URL(source, "http://libera.local").pathname
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

      if (target && splitFilePath(target.documentPath).notebook === splitFilePath(documentPath).notebook) {
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
    let rawPath: string | null;
    try { rawPath = rawFileSourcePath(source); } catch { continue; }

    if (rawPath) {
      rawPaths.add(rawPath);
    }
  }

  return rawPaths;
}

async function removeEmptyDirectory(targetPath: string) {
  try {
    await rmdir(targetPath);
    return true;
  } catch {
    // The directory is either absent or still contains referenced assets.
    return !(await pathExists(targetPath));
  }
}

async function removeEmptyAssetParents(notebook: string, start: string) {
  const root = path.join(notebookPath(notebook), MARKDOWN_ASSETS_DIR);
  let directory = start;
  // Only derived asset folders may be removed; never ascend into the notebook.
  while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    if (!(await removeEmptyDirectory(directory)) || directory === root) break;
    directory = path.dirname(directory);
  }
}

type MarkdownDocument = { documentPath: string; content: string };

/** Include archived notes, but never descend into assets, dependencies or symlinks. */
export async function readMarkdownAssetDocuments(notebook: string) {
  const documents: MarkdownDocument[] = [];
  let remaining = 20_000;
  let complete = true;
  async function visit(parts: string[]) {
    try {
      for (const entry of await readdir(path.join(notebookPath(notebook), ...parts), { withFileTypes: true })) {
        if (--remaining < 0) { complete = false; return; }
        if (entry.name.startsWith(".") || [MARKDOWN_ASSETS_DIR, "node_modules", "__pycache__", "bower_components"].includes(entry.name)) continue;
        const next = [...parts, entry.name];
        if (entry.isDirectory()) await visit(next);
        else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          documents.push({ documentPath: relativeFilePath(notebook, next), content: await readFile(filePathFromParts(notebook, next), "utf8") });
        }
      }
    } catch {
      // An incomplete scan cannot establish that an image is unused.
      complete = false;
    }
  }
  await visit([]);
  return { documents, complete };
}

function ownedPrefixes(documentPath: string) {
  const { pathParts, name } = splitFilePath(documentPath);
  return new Set([pythonFigureFolder(documentPath), markdownAssetsPathPrefix(pathParts), `${MARKDOWN_ASSETS_DIR}/${markdownAssetsDirectoryName(name)}`]);
}

/** Remove only affected assets, keeping every image referenced by another saved note. */
export async function cleanupMarkdownImageAssets(notebook: string, previous: MarkdownDocument[], overrides: MarkdownDocument[] = []) {
  // The local archive remains writable inside a shared notebook, but its
  // shared assets belong to the host and cannot be collected by local deletes.
  if (isSharedNotebookPath(`${notebook}/${MARKDOWN_ASSETS_DIR}`)) return;
  const { documents, complete } = await readMarkdownAssetDocuments(notebook);
  if (!complete) return;
  const references = new Set<string>();
  // A save can be superseded while this scan runs. Keep both the text on disk
  // and the caller's references; an older request must not prune a newer save.
  for (const document of [...documents, ...overrides]) {
    for (const asset of referencedMarkdownAssetPaths(document.documentPath, document.content)) references.add(asset.toLowerCase());
  }
  const candidates = new Set<string>();
  const directories = new Set<string>();
  for (const document of previous) {
    for (const asset of referencedMarkdownAssetPaths(document.documentPath, document.content)) candidates.add(asset);
    for (const prefix of ownedPrefixes(document.documentPath)) {
      // Sanitized note names can collide. Never bulk-prune another note's
      // uploads, including uploads that have not yet reached its saved text.
      const ambiguous = documents.some((other) => other.documentPath !== document.documentPath &&
        [...ownedPrefixes(other.documentPath)].some((owned) => owned.toLowerCase() === prefix.toLowerCase()));
      if (ambiguous) continue;
      const directory = markdownAssetPath(notebook, `${prefix}/placeholder`).targetPath;
      const assetDirectory = path.dirname(directory);
      directories.add(assetDirectory);
      if (!(await pathExists(assetDirectory))) continue;
      const noteExists = documents.some((other) => other.documentPath === document.documentPath);
      for (const entry of await readdir(assetDirectory, { withFileTypes: true })) {
        // Child folders may belong to other notes with the same stem. Python
        // sidecars go with their note's moves and deletes, not its images.
        if (!entry.isFile() || entry.name.toLowerCase().endsWith(".py")) continue;
        // A figure the note's Python just made waits for the agent (or the
        // editor's Re-run) to put it in the note; a save meanwhile keeps it.
        // A deleted note's figures go with it, placed or not.
        if (noteExists && parsePythonFigureSource(entry.name)) continue;
        candidates.add(`${prefix}/${entry.name}`);
      }
    }
  }
  for (const candidate of candidates) {
    if (references.has(candidate.toLowerCase())) continue;
    // ProseMirror history can refer to any prior version, regardless of its age.
    if (parsePythonFigureSource(candidate) && previous.some((document) => documents.some((saved) => saved.documentPath === document.documentPath))) continue;
    const asset = markdownAssetPath(notebook, candidate);
    await rm(asset.targetPath, { force: true });
    directories.add(path.dirname(asset.targetPath));
  }
  for (const directory of directories) await removeEmptyAssetParents(notebook, directory);
}

// A note's Python sidecar sits in its assets folder (lib/python/sidecar.ts),
// at a path made from the note's own. It is moved, copied and deleted with the
// note itself (files.ts), since image sources, unlike the sidecar's path, stay
// where they are when a note moves inside its notebook.

function pythonSidecarFile(documentPath: string) {
  const { notebook, pathParts } = splitFilePath(pythonSidecarPath(documentPath));
  return { notebook, absolutePath: filePathFromParts(notebook, pathParts) };
}

const sidecarMigrations = new Map<string, Promise<void>>();

/** Migrate the original lossy layout only when its owner can be established. */
export function migratePythonSidecar(documentPath: string, alsoMoving?: string): Promise<void> {
  const existing = sidecarMigrations.get(documentPath);
  if (existing) return existing;
  const task = migrateLegacyPythonSidecar(documentPath, alsoMoving);
  sidecarMigrations.set(documentPath, task);
  void task.finally(() => { if (sidecarMigrations.get(documentPath) === task) sidecarMigrations.delete(documentPath); }).catch(() => undefined);
  return task;
}

async function migrateLegacyPythonSidecar(documentPath: string, alsoMoving?: string) {
  const canonical = pythonSidecarFile(documentPath);
  if (await pathExists(canonical.absolutePath)) return;
  const legacyPath = legacyPythonSidecarPath(documentPath);
  const legacy = splitFilePath(legacyPath);
  const legacyFile = filePathFromParts(legacy.notebook, legacy.pathParts);
  if (!(await pathExists(legacyFile))) return;
  const scan = await readMarkdownAssetDocuments(legacy.notebook);
  const prefix = legacyPath.split("/").slice(1, -1).join("/");
  if (!scan.complete || scan.documents.some((other) => other.documentPath !== documentPath && other.documentPath !== alsoMoving &&
    legacyPythonSidecarPath(other.documentPath).split("/").slice(1, -1).join("/").toLowerCase() === prefix.toLowerCase())) {
    throw new StorageError(`The legacy Python folder of ${documentPath} is shared by multiple note names. Copy its code to ${pythonSidecarPath(documentPath)} to choose its owner.`, 409);
  }
  const source = await readFile(legacyFile, "utf8");
  const figures = (await readdir(path.dirname(legacyFile))).filter((name) => parsePythonFigureSource(name)).map((name) => `${prefix}/${name}`);
  await mkdir(path.dirname(canonical.absolutePath), { recursive: true });
  try { await writeFile(canonical.absolutePath, withPreviousPythonFigureSources(source, [...previousPythonFigureSources(source), ...figures]), { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await rm(legacyFile, { force: true });
}

export async function movePythonSidecar(from: string, to: string) {
  await migratePythonSidecar(from, to);
  const source = pythonSidecarFile(from);
  if (!(await pathExists(source.absolutePath))) return;
  const code = await readFile(source.absolutePath, "utf8");
  const figures = (await readdir(path.dirname(source.absolutePath))).filter((name) => parsePythonFigureSource(name)).map((name) => `${pythonFigureSourcePrefix(from)}/${name}`);
  const destination = pythonSidecarFile(to);
  const previous = source.notebook === destination.notebook ? [...previousPythonFigureSources(code), ...figures] : [];
  await writeFile(source.absolutePath, withPreviousPythonFigureSources(code, previous));
  await moveFileIfExists(source.absolutePath, destination.absolutePath);
  await removeEmptyAssetParents(source.notebook, path.dirname(source.absolutePath));
}

export async function copyPythonSidecar(from: string, to: string) {
  await migratePythonSidecar(from);
  await copyFileIfExists(pythonSidecarFile(from).absolutePath, pythonSidecarFile(to).absolutePath);
  const target = pythonSidecarFile(to).absolutePath;
  if (await pathExists(target)) await writeFile(target, withPreviousPythonFigureSources(await readFile(target, "utf8"), []));
}

export async function deletePythonSidecar(documentPath: string) {
  const sidecar = pythonSidecarFile(documentPath);
  if (await pathExists(sidecar.absolutePath)) {
    const sources = previousPythonFigureSources(await readFile(sidecar.absolutePath, "utf8"));
    if (sources.length) await cleanupMarkdownImageAssets(sidecar.notebook, [{ documentPath, content: sources.map((src) => `![](<${src}>)`).join("\n") }]);
  } else {
    // Never delete an ambiguous legacy sidecar belonging to a surviving note.
    const legacy = splitFilePath(legacyPythonSidecarPath(documentPath));
    const scan = await readMarkdownAssetDocuments(legacy.notebook);
    if (scan.complete && !scan.documents.some((note) => legacyPythonSidecarPath(note.documentPath).toLowerCase() === legacyPythonSidecarPath(documentPath).toLowerCase())) {
      await rm(filePathFromParts(legacy.notebook, legacy.pathParts), { force: true });
    }
  }
  await rm(sidecar.absolutePath, { force: true });
  await removeEmptyAssetParents(sidecar.notebook, path.dirname(sidecar.absolutePath));
}

/** Library paths of the Markdown notes in a folder and its subfolders. */
export async function markdownPathsInFolder(notebook: string, folderParts: string[]) {
  const paths: string[] = [];
  async function visit(parts: string[]) {
    let entries;
    try { entries = await readdir(path.join(notebookPath(notebook), ...parts), { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === MARKDOWN_ASSETS_DIR) continue;
      if (entry.isDirectory()) await visit([...parts, entry.name]);
      else if (entry.isFile() && MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) paths.push(relativeFilePath(notebook, [...parts, entry.name]));
    }
  }
  await visit(folderParts);
  return paths;
}

async function writeAvailableAsset(directory: string, name: string, body: Buffer, verify?: () => Promise<void>) {
  const createdRoot = await mkdir(directory, { recursive: true });
  try {
    await verify?.();
    for (;;) {
      const available = await findAvailableFilePath(directory, name);
      let handle;
      try { handle = await open(available.path, "wx"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try {
        await handle.writeFile(body);
        await handle.close();
        await verify?.();
        return available;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(available.path, { force: true });
        throw error;
      }
    }
  } catch (error) {
    // A deleted notebook may race mkdir. Remove only empty folders this write
    // created, including the notebook itself if this call recreated it.
    if (createdRoot) {
      const root = path.toNamespacedPath(createdRoot);
      let current = path.toNamespacedPath(directory);
      while (current === root || current.startsWith(`${root}${path.sep}`)) {
        if (!(await removeEmptyDirectory(current)) || current === root) break;
        current = path.dirname(current);
      }
    }
    throw error;
  }
}

/** Copies have independent image files and destinations never overwrite existing images. */
export async function copyMarkdownImageAssets(from: string, to: string, markdown: string, includeOwnedUploads = false) {
  await migratePythonSidecar(from);
  const destination = splitFilePath(to);
  assertNotSharedItem(destination.notebook, [MARKDOWN_ASSETS_DIR]);
  const imageSources: Record<string, string> = {};
  const created: string[] = [];
  const sources = new Set(markdownImageSources(markdown));
  // A moved editor can have images in an unsaved draft. Carry its uploads too
  // and return their URL map so the draft follows the move without being saved.
  if (includeOwnedUploads) {
    for (const prefix of ownedPrefixes(from)) {
      const directory = path.dirname(markdownAssetPath(splitFilePath(from).notebook, `${prefix}/placeholder`).targetPath);
      if (!(await pathExists(directory))) continue;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile()) sources.add(`${prefix}/${entry.name}`);
      }
    }
  }
  const discard = async () => {
    for (const target of created) await rm(target, { force: true });
    await removeEmptyAssetParents(destination.notebook, markdownAssetsDirectoryPathFromParts(destination.notebook, destination.pathParts));
    await removeEmptyAssetParents(destination.notebook, path.dirname(pythonSidecarFile(to).absolutePath));
  };
  try {
    const sidecar = pythonSidecarFile(from);
    const previousSources = await readFile(sidecar.absolutePath, "utf8").then(previousPythonFigureSources, () => []);
    const copied = new Map<string, string>();
    for (const source of sources) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(source)) continue;
      if (source.startsWith("/") && !source.startsWith("/api/markdown-assets/raw") && !source.startsWith("/api/files/raw/")) continue;
      let asset;
      try { asset = await getMarkdownImageAssetBySource(from, source); }
      catch (error) {
        // An already missing image must not prevent moving the note itself.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          const target = markdownAssetSourceTarget(from, source);
          // Keep its original namespace so an unrelated destination image at
          // the same relative path cannot silently replace the missing image.
          if (target) imageSources[source] = `/api/markdown-assets/raw?document=${encodeURIComponent(target.documentPath)}&asset=${encodeURIComponent(target.assetPath)}`;
          continue;
        }
        if (error instanceof StorageError) continue;
        throw error;
      }
      const target = markdownAssetSourceTarget(from, source);
      const key = source.startsWith("/api/files/raw/") ? `raw:${asset.assetPath}`
        : `asset:${splitFilePath(target?.documentPath ?? from).notebook}/${asset.assetPath}`;
      const existing = copied.get(key);
      if (existing) { imageSources[source] = existing; continue; }
      const ownFigure = ownsPythonFigureSource(from, source, previousSources);
      const directory = ownFigure ? path.dirname(pythonSidecarFile(to).absolutePath) : markdownAssetsDirectoryPathFromParts(destination.notebook, destination.pathParts);
      const sameFigure = ownFigure && await readFile(path.join(directory, asset.fileName)).then((body) => body.equals(asset.body), () => false);
      const available = sameFigure ? { path: path.join(directory, asset.fileName), name: asset.fileName }
        : await writeAvailableAsset(directory, normalizeAssetFileName(asset.fileName), asset.body);
      if (!sameFigure) created.push(available.path);
      imageSources[source] = `${ownFigure ? pythonFigureSourcePrefix(to) : markdownAssetsPathPrefix(destination.pathParts)}/${available.name}`;
      copied.set(key, imageSources[source]);
    }
    return { content: rewriteMarkdownImageSources(markdown, imageSources), imageSources, discard };
  } catch (error) {
    await discard();
    throw error;
  }
}

export async function writeMarkdownImageAsset(
  documentPath: string,
  upload: File,
): Promise<MarkdownImageAssetPayload> {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  // _assets in a shared notebook are shared blobs; they are added through the host.
  assertNotSharedItem(notebook, [MARKDOWN_ASSETS_DIR]);
  const sourcePath = filePathFromParts(notebook, pathParts);
  const original = await stat(sourcePath, { bigint: true });
  async function assertSourceExists() {
    const current = await stat(sourcePath, { bigint: true });
    if (current.dev !== original.dev || current.ino !== original.ino || current.birthtimeNs !== original.birthtimeNs) {
      throw new StorageError("The image's document has changed.", 409);
    }
  }

  const safeName = normalizeAssetFileName(ensureImageName(upload.name));
  const assetDirectory = markdownAssetsDirectoryPathFromParts(notebook, pathParts);
  const body = Buffer.from(await upload.arrayBuffer());
  await assertSourceExists();
  const available = await writeAvailableAsset(assetDirectory, safeName, body, assertSourceExists);

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
  const { notebook, name } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  // The document selects the notebook namespace. An image may still be used
  // by another note after the original document has moved or been deleted.

  const asset = markdownAssetPath(notebook, assetPath);
  const fileName = path.basename(asset.normalized);
  // An ink block's rendering (lib/ink/block.ts) is the one SVG a note shows;
  // it is written by Libera from strokes and served with scripts disabled.
  if (isInkBlockRenderingName(fileName)) {
    return { body: await readFile(asset.targetPath), contentType: "image/svg+xml", assetPath: asset.normalized, fileName };
  }
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

  return getMarkdownImageAsset(documentPath, markdownAssetSourceTarget(documentPath, source)?.assetPath ?? source);
}

export async function pruneUnusedMarkdownImageAssets(
  documentPath: string,
  markdown: string,
  previousMarkdown = markdown,
) {
  await ensureAdminRoot();
  const { notebook, name, pathParts } = splitFilePath(documentPath);
  assertMarkdownFileName(name);
  assertNotSharedItem(notebook, [MARKDOWN_ASSETS_DIR]);
  await stat(filePathFromParts(notebook, pathParts));

  await cleanupMarkdownImageAssets(notebook, [{ documentPath, content: previousMarkdown }], [{ documentPath, content: markdown }]);
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
    assertNotSharedItem(notebook, pathParts);
    const scan = await readMarkdownAssetDocuments(notebook);
    if (!scan.complete || scan.documents.some((document) => document.documentPath !== documentPath &&
      referencedRawFilePaths(document.content).has(rawPath))) return { deleted: false };
    // Use the file lifecycle so annotations, references, tags and search follow
    // this deletion too. Loaded lazily because file saves also prune assets.
    const { deleteFile } = await import("@/lib/storage/files");
    if (await pathExists(filePathFromParts(notebook, pathParts))) await deleteFile(rawPath);
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
  assertNotSharedItem(notebook, asset.normalized.split("/"));
  const scan = await readMarkdownAssetDocuments(notebook);
  if (!scan.complete || scan.documents.some((document) => document.documentPath !== documentPath &&
    [...referencedMarkdownAssetPaths(document.documentPath, document.content)].some((reference) => reference.toLowerCase() === asset.normalized.toLowerCase()))) {
    return { deleted: false };
  }

  await rm(asset.targetPath, { force: true });
  await removeEmptyAssetParents(notebook, path.dirname(asset.targetPath));

  return { deleted: true };
}

function parseDataImageSource(source: string) {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(source);
}
