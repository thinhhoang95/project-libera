import { isValidCitationKey } from "./keys";
import { importProvenance, normalizeEntryInput, type ReferenceParseError, type ReferenceParseResult } from "./normalize";
import { CSL_ITEM_TYPES, type CslItem, type ReferenceAttachment, type ReferenceIdentifiers } from "./types";

// CSL-JSON ↔ entries. Items are CSL already; parsing validates the type,
// takes `id` as the source key, moves `keyword` into tags and normalizes.
// Serializing writes `id` = citation key and fills DOI, ISBN, PMID and
// PMCID from the entry's identifiers, and URL from its first URL
// attachment, when the item lacks them. Pure and dependency-free.

export type CslJsonParseOptions = {
  /** Timestamp for the provenance of every parsed field. Defaults to now. */
  retrievedAt?: string;
};

/** What `serializeCslJson` needs from an entry; a ReferenceEntry fits. */
export type CslJsonSerializableEntry = {
  key: string;
  csl: CslItem;
  identifiers?: ReferenceIdentifiers;
  attachments?: ReferenceAttachment[];
  tags?: string[];
};

/** Start offsets of the top-level elements of a JSON array, for line numbers. */
function elementOffsets(text: string) {
  const offsets: number[] = [];
  let depth = 0;
  let inString = false;
  let expectElement = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
      continue;
    }
    if (expectElement && !/\s/.test(char) && char !== "]") {
      offsets.push(index);
      expectElement = false;
    }
    if (char === "\"") inString = true;
    if (char === "[" || char === "{") {
      depth += 1;
      if (depth === 1) expectElement = true;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 1) {
      expectElement = true;
    }
  }
  return offsets;
}

function lineAt(text: string, offset: number) {
  return text.slice(0, offset).split("\n").length;
}

/**
 * Parses CSL-JSON: an array of items or a single item. An unknown or
 * missing `type` becomes "document" with an error. `id` is the source key
 * (`citation-key` when there is no id); it becomes the entry key when it is
 * a valid citation key.
 */
export function parseCslJson(text: string, options: CslJsonParseOptions = {}): ReferenceParseResult {
  const retrievedAt = options.retrievedAt ?? new Date().toISOString();
  const source = text.replace(/^﻿/, "");
  const errors: ReferenceParseError[] = [];
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = Number(message.match(/position (\d+)/)?.[1]);
    return { entries: [], errors: [{ line: Number.isFinite(position) ? lineAt(source, position) : 1, message: `Invalid JSON: ${message}` }] };
  }
  const isArray = Array.isArray(value);
  const items: unknown[] = isArray ? (value as unknown[]) : [value];
  const offsets = isArray ? elementOffsets(source) : [source.search(/\S/)];
  const entries: ReferenceParseResult["entries"] = [];
  items.forEach((item, index) => {
    const line = lineAt(source, Math.max(0, offsets[index] ?? 0));
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ line, message: `Item ${index + 1} is not an object` });
      return;
    }
    const { id, "citation-key": citationKey, keyword, ...rest } = item as Record<string, unknown>;
    const csl = rest as CslItem;
    if (!(CSL_ITEM_TYPES as readonly string[]).includes(csl.type)) {
      errors.push({ line, message: csl.type ? `Unknown CSL type "${String(csl.type)}" in item ${index + 1}, imported as a document` : `Item ${index + 1} has no type, imported as a document` });
      csl.type = "document";
    }
    const sourceKey = typeof id === "string" || typeof id === "number" ? String(id) : typeof citationKey === "string" ? citationKey : "";
    const tags = typeof keyword === "string" ? keyword.split(/\s*[,;]\s*/).filter(Boolean) : undefined;
    const input = normalizeEntryInput({ csl, tags });
    input.provenance = importProvenance(input.csl, retrievedAt);
    if (isValidCitationKey(sourceKey)) input.key = sourceKey;
    else if (typeof citationKey === "string" && isValidCitationKey(citationKey)) input.key = citationKey;
    entries.push({ input, sourceKey, line });
  });
  return { entries, errors };
}

/** Entries → a CSL-JSON array (pretty-printed) with `id` = key. */
export function serializeCslJson(entries: CslJsonSerializableEntry[]) {
  const items = entries.map((entry) => {
    const { type, ...rest } = entry.csl;
    const item: Record<string, unknown> = { id: entry.key, type, ...rest };
    const identifiers = entry.identifiers ?? {};
    if (!item.DOI && identifiers.doi) item.DOI = identifiers.doi;
    if (!item.ISBN && identifiers.isbn?.length) item.ISBN = identifiers.isbn.join(" ");
    if (!item.PMID && identifiers.pmid) item.PMID = identifiers.pmid;
    if (!item.PMCID && identifiers.pmcid) item.PMCID = identifiers.pmcid;
    if (!item.URL) {
      const url = entry.attachments?.find((attachment): attachment is { kind: "url"; url: string } => attachment.kind === "url")?.url;
      if (url) item.URL = url;
    }
    if (!item.keyword && entry.tags?.length) item.keyword = entry.tags.join(", ");
    return item;
  });
  return `${JSON.stringify(items, null, 2)}\n`;
}
