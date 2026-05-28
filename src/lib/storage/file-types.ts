import path from "node:path";
import {
  IMAGE_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  PDF_EXTENSIONS,
} from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { assertSafeSegment } from "@/lib/storage/paths";
import type { LiberaFileType } from "@/lib/types";

export function getFileType(name: string): LiberaFileType | null {
  const extension = path.extname(name).toLowerCase();

  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return "markdown";
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (PDF_EXTENSIONS.has(extension)) {
    return "pdf";
  }

  return null;
}

export function assertSupportedFileName(name: string) {
  const fileType = getFileType(name);

  if (!fileType) {
    throw new StorageError("Only Markdown, image, and PDF files are supported.");
  }

  return fileType;
}

export function assertPdfFileName(name: string) {
  const fileType = assertSupportedFileName(name);

  if (fileType !== "pdf") {
    throw new StorageError("PDF annotations can only be used with PDF files.");
  }
}

export function assertImageFileName(name: string) {
  const fileType = assertSupportedFileName(name);

  if (fileType !== "image") {
    throw new StorageError("Image annotations can only be used with image files.");
  }
}

export function assertMarkdownFileName(name: string) {
  const fileType = assertSupportedFileName(name);

  if (fileType !== "markdown") {
    throw new StorageError("Markdown assets can only be attached to Markdown files.");
  }
}

export function ensureMarkdownName(name: string) {
  const safeName = assertSafeSegment(name, "File name");

  if (path.extname(safeName)) {
    const fileType = assertSupportedFileName(safeName);

    if (fileType !== "markdown") {
      throw new StorageError("New note files must use a Markdown extension.");
    }

    return safeName;
  }

  return `${safeName}.md`;
}

export function ensureImageName(name: string) {
  const safeName = assertSafeSegment(name, "Image file name");
  const fileType = assertSupportedFileName(safeName);

  if (fileType !== "image") {
    throw new StorageError("Only image files can be inserted into Markdown.");
  }

  return safeName;
}

export function normalizeAssetFileName(name: string) {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  const normalizedStem = stem
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return `${normalizedStem || "image"}${extension.toLowerCase()}`;
}

export function getContentType(name: string, fileType: LiberaFileType) {
  const extension = path.extname(name).toLowerCase();

  if (fileType === "pdf") {
    return "application/pdf";
  }

  if (fileType === "markdown") {
    return "text/markdown; charset=utf-8";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".gif") {
    return "image/gif";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  return "application/octet-stream";
}
