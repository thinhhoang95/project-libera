import {
  readImageAnnotations,
  readPdfAnnotations,
} from "@/lib/storage/annotations";
import { readLiberaFile } from "@/lib/storage/files";
import { getTree } from "@/lib/storage/tree";
import type {
  DeepSearchPayload,
  DeepSearchResult,
  DeepSearchResultSource,
  LiberaFileNode,
  LiberaTreeNode,
} from "@/lib/types";

const MAX_DEEP_SEARCH_RESULTS = 100;
const MAX_QUERY_LENGTH = 200;
const EXCERPT_RADIUS = 84;

function collectFiles(nodes: LiberaTreeNode[], files: LiberaFileNode[]) {
  for (const node of nodes) {
    if (node.kind === "file") {
      files.push(node);
      continue;
    }

    collectFiles(node.children, files);
  }
}

function countMatches(value: string, normalizedQuery: string) {
  const normalizedValue = value.toLowerCase();
  let count = 0;
  let searchFrom = 0;

  while (searchFrom <= normalizedValue.length) {
    const matchIndex = normalizedValue.indexOf(normalizedQuery, searchFrom);

    if (matchIndex === -1) {
      break;
    }

    count += 1;
    searchFrom = matchIndex + normalizedQuery.length;
  }

  return count;
}

function createExcerpt(value: string, normalizedQuery: string) {
  const normalizedValue = value.toLowerCase();
  const matchIndex = normalizedValue.indexOf(normalizedQuery);

  if (matchIndex === -1) {
    return "";
  }

  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(value.length, matchIndex + normalizedQuery.length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < value.length ? "..." : "";

  return `${prefix}${value.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function createResult({
  annotationId,
  file,
  id,
  matchCount,
  normalizedQuery,
  pageNumber,
  source,
  sourceLabel,
  text,
}: {
  annotationId?: string;
  file: LiberaFileNode;
  id: string;
  matchCount: number;
  normalizedQuery: string;
  pageNumber?: number;
  source: DeepSearchResultSource;
  sourceLabel: string;
  text: string;
}): DeepSearchResult {
  return {
    id,
    source,
    notebook: file.notebook,
    file,
    title: file.path,
    sourceLabel,
    excerpt: createExcerpt(text, normalizedQuery),
    matchCount,
    pageNumber,
    annotationId,
  };
}

function pushTextResult(
  results: DeepSearchResult[],
  options: Omit<Parameters<typeof createResult>[0], "matchCount">,
) {
  if (results.length >= MAX_DEEP_SEARCH_RESULTS) {
    return;
  }

  const matchCount = countMatches(options.text, options.normalizedQuery);

  if (!matchCount) {
    return;
  }

  results.push(createResult({ ...options, matchCount }));
}

export async function deepSearch(query: string): Promise<DeepSearchPayload> {
  const normalizedQuery = query.trim().slice(0, MAX_QUERY_LENGTH).toLowerCase();

  if (!normalizedQuery) {
    return {
      query: "",
      searchedFiles: 0,
      results: [],
    };
  }

  const tree = await getTree();
  const files: LiberaFileNode[] = [];
  const results: DeepSearchResult[] = [];

  for (const notebook of tree.notebooks) {
    collectFiles(notebook.children, files);
  }

  for (const file of files) {
    if (results.length >= MAX_DEEP_SEARCH_RESULTS) {
      break;
    }

    if (file.fileType === "markdown") {
      const payload = await readLiberaFile(file.path);

      pushTextResult(results, {
        file,
        id: `markdown:${file.path}`,
        normalizedQuery,
        source: "markdown",
        sourceLabel: "Markdown",
        text: payload.content ?? "",
      });
    }

    if (file.fileType === "pdf") {
      const payload = await readPdfAnnotations(file.path);

      for (const annotation of payload.annotations) {
        if (results.length >= MAX_DEEP_SEARCH_RESULTS) {
          break;
        }

        if (annotation.type !== "text") {
          continue;
        }

        pushTextResult(results, {
          annotationId: annotation.id,
          file,
          id: `pdf:${file.path}:${annotation.id}`,
          normalizedQuery,
          pageNumber: annotation.pageNumber,
          source: "pdf-annotation",
          sourceLabel: `PDF annotation, page ${annotation.pageNumber}`,
          text: annotation.text,
        });
      }
    }

    if (file.fileType === "image") {
      const payload = await readImageAnnotations(file.path);

      for (const annotation of payload.annotations) {
        if (results.length >= MAX_DEEP_SEARCH_RESULTS) {
          break;
        }

        pushTextResult(results, {
          annotationId: annotation.id,
          file,
          id: `image:${file.path}:${annotation.id}`,
          normalizedQuery,
          pageNumber: annotation.pageNumber,
          source: "image-annotation",
          sourceLabel: "Image annotation",
          text: annotation.text,
        });
      }
    }
  }

  return {
    query: normalizedQuery,
    searchedFiles: files.length,
    results,
  };
}
