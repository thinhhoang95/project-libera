import type { LiberaFileNode, LiberaFileType } from "@/lib/types";

export type MarkdownLinkViewState = {
  image?: {
    fontSize?: number;
    panX?: number;
    panY?: number;
    selectedAnnotationId?: string;
    tool?: "select" | "text";
    zoom?: number;
  };
  markdown?: {
    editorScrollLeft?: number;
    editorScrollTop?: number;
    line?: number;
    previewScrollLeft?: number;
    previewScrollTop?: number;
    selectionEnd?: number;
    selectionStart?: number;
    zoom?: number;
  };
  pdf?: {
    fontSize?: number;
    scrollLeft?: number;
    scrollTop?: number;
    selectedAnnotationId?: string;
    tool?: "select" | "highlight" | "text";
    zoom?: number;
  };
};

export type MarkdownFileLinkMetadata = {
  fileType?: LiberaFileType;
  line?: number;
  v: 1;
  viewState?: MarkdownLinkViewState;
};

export type ResolvedMarkdownFileLink = {
  file: LiberaFileNode;
  metadata?: MarkdownFileLinkMetadata;
};

const LIBERA_LINK_HASH_KEY = "libera";

function base64UrlEncode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

function decodeHrefPath(pathValue: string) {
  return pathValue
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function encodeHrefPath(pathValue: string) {
  return pathValue
    .split("/")
    .map((segment) => {
      if (segment === "." || segment === "..") {
        return segment;
      }

      return encodeURIComponent(segment);
    })
    .join("/");
}

function normalizeWorkspacePath(pathValue: string) {
  const parts: string[] = [];

  for (const part of pathValue.split("/")) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      if (!parts.length) {
        return null;
      }

      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return parts.join("/") || null;
}

function getParentPath(pathValue: string) {
  return pathValue.split("/").slice(0, -1).join("/");
}

function getRelativePath(fromDirectory: string, targetPath: string) {
  const fromParts = fromDirectory ? fromDirectory.split("/") : [];
  const targetParts = targetPath.split("/");
  let sharedCount = 0;

  while (
    sharedCount < fromParts.length &&
    sharedCount < targetParts.length &&
    fromParts[sharedCount] === targetParts[sharedCount]
  ) {
    sharedCount += 1;
  }

  const parentSegments = fromParts.slice(sharedCount).map(() => "..");
  const childSegments = targetParts.slice(sharedCount);
  const relativeParts = [...parentSegments, ...childSegments];

  return relativeParts.join("/") || targetPath.split("/").at(-1) || targetPath;
}

function splitMarkdownHref(href: string) {
  const hashIndex = href.indexOf("#");
  const beforeHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const hash = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";
  const queryIndex = beforeHash.indexOf("?");

  return {
    hash,
    path: queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash,
  };
}

function parseMarkdownFileLinkMetadata(hash: string) {
  const params = new URLSearchParams(hash);
  const encodedMetadata = params.get(LIBERA_LINK_HASH_KEY);

  if (!encodedMetadata) {
    return undefined;
  }

  try {
    const metadata = JSON.parse(base64UrlDecode(encodedMetadata)) as Partial<MarkdownFileLinkMetadata>;

    if (metadata.v !== 1) {
      return undefined;
    }

    return metadata as MarkdownFileLinkMetadata;
  } catch {
    return undefined;
  }
}

export function createMarkdownFileLinkDestination({
  metadata,
  sourcePath,
  targetPath,
}: {
  metadata?: MarkdownFileLinkMetadata;
  sourcePath: string;
  targetPath: string;
}) {
  const relativePath = getRelativePath(getParentPath(sourcePath), targetPath);
  const encodedPath = encodeHrefPath(relativePath);

  if (!metadata) {
    return encodedPath;
  }

  return `${encodedPath}#${LIBERA_LINK_HASH_KEY}=${base64UrlEncode(
    JSON.stringify(metadata),
  )}`;
}

export function isLikelyWorkspaceMarkdownLink(href: string | undefined) {
  if (!href || href.startsWith("#") || href.startsWith("/")) {
    return false;
  }

  return !/^[a-z][a-z0-9+.-]*:/i.test(href);
}

export function resolveMarkdownFileLink(
  href: string,
  sourcePath: string,
  files: LiberaFileNode[],
): ResolvedMarkdownFileLink | null {
  if (!isLikelyWorkspaceMarkdownLink(href)) {
    return null;
  }

  const { hash, path } = splitMarkdownHref(href);
  const decodedPath = decodeHrefPath(path);
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const relativePath = normalizeWorkspacePath(
    `${getParentPath(sourcePath)}/${decodedPath}`,
  );
  const relativeFile = relativePath ? fileByPath.get(relativePath) : undefined;

  if (relativeFile) {
    return {
      file: relativeFile,
      metadata: parseMarkdownFileLinkMetadata(hash),
    };
  }

  const directPath = normalizeWorkspacePath(decodedPath);
  const directFile = directPath ? fileByPath.get(directPath) : undefined;

  if (!directFile) {
    return null;
  }

  return {
    file: directFile,
    metadata: parseMarkdownFileLinkMetadata(hash),
  };
}
