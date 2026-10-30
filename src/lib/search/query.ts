import path from "node:path";
import {
  MAX_SEARCH_QUERY_IMAGES,
  MAX_SEARCH_UPLOAD_BYTES,
  SEARCH_FILE_KINDS,
  SEARCH_QUERY_PREFIX,
  extractSpeakerFilters,
  passageHasSpeaker,
  searchQueryPlainText,
  searchQueryTerms,
  searchQueryText,
  type SearchFileKind,
  type SearchGalleryPhoto,
  type SearchHit,
  type SearchImageRef,
  type SearchQueryPart,
  type SearchReferenceRecord,
  type SearchRequest,
  type SearchResponse,
  type SearchResultFile,
} from "@/lib/global-search";
import type { ChunkRow } from "@/lib/search/database";
import { getSearchIndexer } from "@/lib/search/indexer";
import { getSearchPreferences } from "@/lib/search/settings";
import { getSearchWorker, type EmbedImage } from "@/lib/search/worker-client";
import { ARCHIVE_DIR, IMAGE_EXTENSIONS } from "@/lib/storage/constants";
import { StorageError } from "@/lib/storage/errors";
import { getGalleryRoot } from "@/lib/storage/gallery";
import { assertSafeUserSegment, filePathFromParts, splitFilePath } from "@/lib/storage/paths";
import type { LiberaFileNode } from "@/lib/types";

const CANDIDATES = 240;
const RRF_K = 60;
const DEFAULT_RESULT_LIMIT = 60;
const MAX_HITS_PER_FILE = 4;
const MAX_QUERY_CHARS = 4000;
const UPLOAD_TYPES = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;

function resolveImage(image: SearchImageRef): EmbedImage {
  if (image.kind === "file") {
    const { notebook, pathParts, name } = splitFilePath(image.path);
    if (!IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new StorageError(`${name} is not an image.`);
    return { path: filePathFromParts(notebook, pathParts) };
  }

  if (image.kind === "gallery") {
    const parts = String(image.path).split("/").map((part) => assertSafeUserSegment(part, "Photo path"));
    return { path: path.join(getGalleryRoot(), ...parts) };
  }

  const match = UPLOAD_TYPES.exec(image.dataUrl ?? "");
  if (!match) throw new StorageError("Paste or drop a PNG, JPEG, WebP or GIF image.");
  const data = Buffer.from(image.dataUrl.slice(match[0].length), "base64");
  if (!data.length) throw new StorageError("The image is empty.");
  if (data.length > MAX_SEARCH_UPLOAD_BYTES) throw new StorageError("Images in a search are limited to 12 MB.", 413);
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

function normalizeParts(parts: unknown): SearchQueryPart[] {
  if (!Array.isArray(parts)) throw new StorageError("The search query is invalid.");
  const normalized: SearchQueryPart[] = [];

  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") normalized.push({ type: "text", text: part.text });
    else if (part?.type === "image" && part.image && typeof part.image === "object") normalized.push({ type: "image", image: part.image });
  }

  if (normalized.filter((part) => part.type === "image").length > MAX_SEARCH_QUERY_IMAGES) {
    throw new StorageError(`A search can include up to ${MAX_SEARCH_QUERY_IMAGES} images.`);
  }
  if (searchQueryPlainText(normalized).length > MAX_QUERY_CHARS) {
    throw new StorageError("The search text is too long.");
  }
  return normalized;
}

/** FTS5 query: each term matched as a word prefix (or as a phrase), all of them or any of them. */
export function keywordMatchExpression(terms: string[], operator: "AND" | "OR" = "OR") {
  return terms
    .map((term) => {
      const quoted = `"${term.replaceAll('"', '""')}"`;
      return term.includes(" ") || term.length < 3 ? quoted : `${quoted}*`;
    })
    .join(` ${operator} `);
}

type Candidate = { id: number; score: number; similarity?: number; semantic: boolean; keyword: boolean };

/** Reciprocal rank fusion: robust to the very different scales of BM25 and cosine similarity. */
export function fuseRankings(
  semantic: Array<{ id: number; similarity: number }>,
  keyword: Array<{ id: number }>,
  keywordWeight: number,
) {
  const candidates = new Map<number, Candidate>();

  semantic.forEach((hit, rank) => {
    candidates.set(hit.id, { id: hit.id, score: 1 / (RRF_K + rank + 1), similarity: hit.similarity, semantic: true, keyword: false });
  });
  keyword.forEach((hit, rank) => {
    const existing = candidates.get(hit.id);
    const score = keywordWeight / (RRF_K + rank + 1);
    if (existing) {
      existing.score += score;
      existing.keyword = true;
    } else {
      candidates.set(hit.id, { id: hit.id, score, semantic: false, keyword: true });
    }
  });

  return [...candidates.values()].sort((left, right) => right.score - left.score);
}

/**
 * Vector search always returns its k nearest passages, however far. Keep the
 * ones near the best match of their own modality: EmbeddingGemma 2 scores text
 * against photos lower than text against text, so one cutoff cannot serve both.
 * The floors below come from trying queries on mixed notes, PDFs and photos;
 * relevant passages scored about 0.65–0.75 against a text query, unrelated
 * ones about 0.50–0.60.
 */
const SEMANTIC_FLOORS = {
  textQuery: { text: { absolute: 0.55, belowBest: 0.15 }, image: { absolute: 0.62, belowBest: 0.1 } },
  imageQuery: { text: { absolute: 0.5, belowBest: 0.2 }, image: { absolute: 0.55, belowBest: 0.2 } },
};

export function relevantSemanticHits<T extends { similarity: number; image: boolean }>(hits: T[], imageQuery: boolean) {
  const floors = imageQuery ? SEMANTIC_FLOORS.imageQuery : SEMANTIC_FLOORS.textQuery;
  const best = { text: 0, image: 0 };
  for (const hit of hits) {
    const modality = hit.image ? "image" : "text";
    best[modality] = Math.max(best[modality], hit.similarity);
  }
  return hits.filter((hit) => {
    const modality = hit.image ? "image" : "text";
    const floor = floors[modality];
    return hit.similarity >= Math.max(floor.absolute, best[modality] - floor.belowBest);
  });
}

function fileNode(row: ChunkRow): LiberaFileNode {
  return {
    kind: "file",
    name: row.name,
    path: row.path,
    notebook: row.notebook,
    fileType: row.kind as LiberaFileNode["fileType"],
    createdAt: "",
    size: 0,
    updatedAt: "",
  };
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseMeta<T>(meta: string | null): T | undefined {
  if (!meta) return undefined;
  try {
    return JSON.parse(meta) as T;
  } catch {
    return undefined;
  }
}

function toHit(row: ChunkRow, candidate: Candidate): SearchHit {
  return {
    chunkId: row.id,
    score: candidate.score,
    similarity: candidate.similarity,
    semantic: candidate.semantic,
    keyword: candidate.keyword,
    text: row.text,
    location: {
      page: row.page ?? undefined,
      line: row.line ?? undefined,
      endLine: row.endLine ?? undefined,
      start: row.start ?? undefined,
      end: row.end ?? undefined,
      section: row.title || undefined,
    },
  };
}

export async function runSearch(request: SearchRequest): Promise<SearchResponse> {
  const started = Date.now();
  const filters = extractSpeakerFilters(normalizeParts(request.parts));
  const speakers = filters.speakers;
  // `speaker:Vy` alone finds what Vy said: her name is in each of her lines.
  const parts = speakers.length && !searchQueryPlainText(filters.parts) && !filters.parts.some((part) => part.type === "image")
    ? [{ type: "text" as const, text: speakers.join(" ") }]
    : filters.parts;
  const kinds = speakers.length
    ? ["audio" as const]
    : Array.isArray(request.kinds)
      ? request.kinds.filter((kind): kind is SearchFileKind => SEARCH_FILE_KINDS.includes(kind))
      : [];
  const scope = Array.isArray(request.scope) ? new Set(request.scope.filter((item) => typeof item === "string")) : null;
  const includeArchive = request.includeArchive !== false;
  // The References entries of a notebook show with its files.
  const scopeNotebooks = scope ? new Set([...scope].map((item) => item.split("/")[0])) : null;
  const within = request.within && typeof request.within === "object"
    ? { notebooks: stringList(request.within.notebooks), paths: stringList(request.within.paths) }
    : null;
  const limit = Math.max(1, Math.min(200, Number(request.limit) || DEFAULT_RESULT_LIMIT));

  const imageParts = parts.filter((part): part is Extract<SearchQueryPart, { type: "image" }> => part.type === "image");
  const plainText = searchQueryPlainText(parts);
  const terms = searchQueryTerms(plainText);
  if (!plainText && !imageParts.length) return { results: [], mode: "keyword", terms: [], tookMs: 0 };

  const indexer = getSearchIndexer();
  const db = await indexer.databaseForSearch();
  if (!db) {
    return {
      results: [],
      mode: "keyword",
      terms,
      tookMs: Date.now() - started,
      warning: "There is no search index yet. Build one, or choose an existing index, in the Search panel.",
    };
  }
  indexer.requestScan();
  // A restricted search ranks every passage of its records, not only those near the top of the whole index.
  const fileIds = within ? db.fileIdsWithin(within) : undefined;
  if (fileIds && !fileIds.length) return { results: [], mode: "keyword", terms, tookMs: Date.now() - started };

  const worker = getSearchWorker();
  if (worker.configure(getSearchPreferences())) indexer.requestScan({ force: true, manual: false, immediate: true });
  const warnings: string[] = [];
  const filter = kinds.length ? kinds : undefined;
  let nearest: Array<{ id: number; similarity: number }> = [];

  if (!indexer.vectorsUsable) {
    warnings.push("Semantic search is off: the index's vectors were made with other settings. Re-embed them in the Search panel, or switch back. Showing keyword matches.");
  } else if (!worker.configured) {
    warnings.push("Semantic search is off until EmbeddingGemma 2 is downloaded. Showing keyword matches.");
  } else if (imageParts.length && !worker.visionConfigured) {
    warnings.push("Searching with images needs the EmbeddingGemma 2 vision encoder. Download the model again, or choose the encoder in Preferences → Search.");
  } else {
    try {
      const images = imageParts.map((part) => resolveImage(part.image));
      const text = searchQueryText(parts);
      const input = images.length
        ? { text: plainText ? `${SEARCH_QUERY_PREFIX}${text}` : undefined, images }
        : { text: `${SEARCH_QUERY_PREFIX}${plainText}` };
      const [vector] = await worker.embed([input], "query");
      if (indexer.database() === db && indexer.vectorsUsable) {
        nearest = fileIds ? db.nearestAmong(vector, CANDIDATES, fileIds, filter) : db.nearest(vector, CANDIDATES, filter);
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      warnings.push(`Semantic search is unavailable (${error instanceof Error ? error.message : "unknown error"}). Showing keyword matches.`);
    }
  }

  if (indexer.database() !== db) {
    return { results: [], mode: "keyword", terms, tookMs: Date.now() - started, warning: "The search index changed during the search. Search again." };
  }

  // With images, the words describe the images ("like this, but at night"),
  // so literal matches would mostly be noise. Passages with every word come
  // first; matching any one word of a longer query is weak evidence.
  let allTerms: Array<{ id: number }> = [];
  let anyTerm: Array<{ id: number }> = [];
  if (terms.length && (!imageParts.length || !nearest.length)) {
    try {
      allTerms = db.keyword(keywordMatchExpression(terms, "AND"), CANDIDATES, filter, fileIds);
      if (terms.length > 1 && allTerms.length < 5) {
        const seen = new Set(allTerms.map((hit) => hit.id));
        anyTerm = db.keyword(keywordMatchExpression(terms, "OR"), CANDIDATES, filter, fileIds).filter((hit) => !seen.has(hit.id));
      }
    } catch {
      // A query FTS5 cannot parse simply has no keyword matches.
    }
  }

  const rows = new Map(
    db.chunkRows([...new Set([...nearest, ...allTerms, ...anyTerm].map((hit) => hit.id))]).map((row) => [row.id, row]),
  );
  // "Find images like this one" should not return this one.
  const queryImageKeys = new Set(imageParts.flatMap(({ image }) =>
    image.kind === "file" ? [image.path] : image.kind === "gallery" ? [`gallery:${image.id}`] : []));
  const semantic = relevantSemanticHits(
    nearest
      .filter((hit) => !queryImageKeys.has(rows.get(hit.id)?.key ?? ""))
      .map((hit) => ({ ...hit, image: rows.get(hit.id)?.kind === "image" })),
    imageParts.length > 0,
  );
  const semanticIds = new Set(semantic.map((hit) => hit.id));
  // A passage sharing one word with a longer question needs the meaning to agree too.
  const weakKeywords = semantic.length && terms.length >= 3
    ? anyTerm.filter((hit) => semanticIds.has(hit.id))
    : anyTerm;
  const keyword = [...allTerms, ...weakKeywords];
  const keywordWeight = !semantic.length ? 1 : terms.length <= 2 ? 0.9 : allTerms.length ? 0.7 : 0.4;
  const fused = fuseRankings(semantic, keyword, keywordWeight);
  const files = new Map<string, { row: ChunkRow; hits: SearchHit[] }>();

  for (const candidate of fused) {
    const row = rows.get(candidate.id);
    if (!row || indexer.isStale(row.fileId)) continue;
    if (row.source === "library" && scope && !scope.has(row.path)) continue;
    if (row.source === "references" && scopeNotebooks && !scopeNotebooks.has(row.notebook)) continue;
    if (row.source === "library" && !includeArchive && row.path.split("/").includes(ARCHIVE_DIR)) continue;
    if (speakers.length && (row.kind !== "audio" || !passageHasSpeaker(row.text, speakers))) continue;
    const entry = files.get(row.key) ?? { row, hits: [] };
    if (entry.hits.length < MAX_HITS_PER_FILE) entry.hits.push(toHit(row, candidate));
    files.set(row.key, entry);
  }

  const results: SearchResultFile[] = [...files.values()]
    .map(({ row, hits }) => {
      const photo = row.source === "gallery" ? parseMeta<SearchGalleryPhoto>(row.meta) : undefined;
      const reference = row.source === "references" ? parseMeta<SearchReferenceRecord>(row.meta) : undefined;
      return {
        key: row.key,
        source: row.source,
        kind: row.kind,
        name: row.name,
        path: row.path,
        file: row.source === "library" ? fileNode(row) : undefined,
        photo,
        reference,
        // A file with several strong passages ranks a little above one with a single match.
        score: hits[0].score + 0.1 * (hits[1]?.score ?? 0) + 0.05 * (hits[2]?.score ?? 0),
        hits,
      };
    })
    .filter((result) => result.source === "library" || result.photo || result.reference)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  return {
    results,
    mode: semantic.length && keyword.length ? "hybrid" : semantic.length ? "semantic" : "keyword",
    terms,
    tookMs: Date.now() - started,
    warning: warnings[0],
  };
}
