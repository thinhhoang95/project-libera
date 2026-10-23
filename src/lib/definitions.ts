// A document's definitions and notation: cards the AI Agent writes (the
// extract-definitions skill) into a side-car file, read by the Definitions tab
// of the Outlines panel. Shared by the server and the browser; keep free of
// Node imports.

export const DEFINITIONS_VERSION = 1;
export const DEFINITION_KINDS = ["definition", "notation", "convention"] as const;
export type DefinitionKind = typeof DEFINITION_KINDS[number];

export const DEFINITION_KIND_LABELS: Record<DefinitionKind, string> = {
  definition: "Definition",
  notation: "Notation",
  convention: "Convention",
};

/** The documents whose definitions can be extracted: what the agent can Read. */
export const DEFINITIONS_FILE_TYPES = ["markdown", "latex", "pdf"] as const;

export const MAX_DEFINITION_ENTRIES = 2_000;
export const MAX_DEFINITION_TERM_CHARS = 500;
export const MAX_DEFINITION_MEANING_CHARS = 4_000;
export const MAX_DEFINITION_QUOTE_CHARS = 400;
const MAX_ALIASES = 12;
const MAX_ALIAS_CHARS = 120;
const MAX_LOCATION_CHARS = 120;

export type DefinitionEntry = {
  id: string;
  kind: DefinitionKind;
  /** Markdown: the term or symbol, e.g. "Lipschitz continuity" or "$\\mathcal{F}_t$". */
  term: string;
  /** Markdown with math: what the term means in this document. */
  meaning: string;
  /** Plain-text words that find the card: spelled-out symbols, synonyms. */
  aliases?: string[];
  /** Where it is introduced, as the document labels it: "Definition 2.3", "§1.2". */
  location?: string;
  /** A short exact excerpt of the passage that introduces it. */
  quote?: string;
  /** Markdown and LaTeX: the 1-based line where it is introduced. */
  line?: number;
  /** PDF: the 1-based page where it is introduced. */
  page?: number;
};

export type DefinitionsFile = {
  version: typeof DEFINITIONS_VERSION;
  documentPath: string;
  generatedAt: string;
  model?: string;
  /** The document's identity when the cards were written, to tell when it changed since. */
  source: { size: number; contentHash: string } | null;
  entries: DefinitionEntry[];
};

export type DefinitionsPayload = {
  path: string;
  definitions: DefinitionsFile | null;
  /** The document changed since the cards were written. */
  stale: boolean;
};

/** Ask the AI Agent to (re)generate a document's definitions. */
export const DEFINITIONS_REQUEST_EVENT = "libera:definitions-request";
export type DefinitionsRequestDetail = { path: string; requestId: string };

/** The agent run a request started has ended; `error` when it did not start or failed. */
export const DEFINITIONS_RUN_FINISHED_EVENT = "libera:definitions-run-finished";
export type DefinitionsRunFinishedDetail = { requestId: string; error?: string };

/** A run saved cards for a document. */
export const DEFINITIONS_UPDATED_EVENT = "libera:definitions-updated";
export type DefinitionsUpdatedDetail = { path: string };

/** The first message of a run started from the Definitions tab. */
export function definitionsPrompt(path: string) {
  return `Extract the definitions and notation in ${path}.`;
}

function text(value: unknown, limit: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function isDefinitionKind(value: unknown): value is DefinitionKind {
  return DEFINITION_KINDS.some((kind) => kind === value);
}

/** One card read from disk or from the agent; null when it has no term or meaning. */
export function normalizeDefinitionEntry(value: unknown, fallbackId: string): DefinitionEntry | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const term = text(input.term, MAX_DEFINITION_TERM_CHARS);
  const meaning = text(input.meaning, MAX_DEFINITION_MEANING_CHARS);
  if (!term || !meaning) return null;
  const aliases = Array.isArray(input.aliases)
    ? [...new Set(input.aliases.map((alias) => text(alias, MAX_ALIAS_CHARS)).filter((alias): alias is string => !!alias))].slice(0, MAX_ALIASES)
    : [];
  const location = text(input.location, MAX_LOCATION_CHARS);
  const quote = text(input.quote, MAX_DEFINITION_QUOTE_CHARS);
  const line = positiveInteger(input.line);
  const page = positiveInteger(input.page);
  return {
    id: text(input.id, 64) ?? fallbackId,
    kind: isDefinitionKind(input.kind) ? input.kind : "definition",
    term,
    meaning,
    ...(aliases.length ? { aliases } : {}),
    ...(location ? { location } : {}),
    ...(quote ? { quote } : {}),
    ...(line ? { line } : {}),
    ...(page ? { page } : {}),
  };
}

/** A side-car read from disk, or null when it is not one Libera wrote. */
export function parseDefinitionsFile(value: unknown): DefinitionsFile | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<DefinitionsFile>;
  if (input.version !== DEFINITIONS_VERSION || !Array.isArray(input.entries) || typeof input.documentPath !== "string") return null;
  const source = input.source && typeof input.source.contentHash === "string" && typeof input.source.size === "number"
    ? { size: input.source.size, contentHash: input.source.contentHash }
    : null;
  return {
    version: DEFINITIONS_VERSION,
    documentPath: input.documentPath,
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : new Date(0).toISOString(),
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}),
    source,
    entries: input.entries.slice(0, MAX_DEFINITION_ENTRIES)
      .map((entry, index) => normalizeDefinitionEntry(entry, `d${index + 1}`))
      .filter((entry): entry is DefinitionEntry => !!entry),
  };
}

/**
 * Same card twice: same kind, term and location, ignoring spacing and case.
 * An overloaded symbol has one card per meaning, told apart by location.
 */
export function definitionKey(entry: Pick<DefinitionEntry, "kind" | "term" | "location">) {
  const squash = (text = "") => text.replace(/\s+/g, "").toLowerCase();
  return `${entry.kind}:${squash(entry.term)}:${squash(entry.location)}`;
}

/** Searchable text of a card: its term, aliases, meaning and location, with LaTeX commands spelled out. */
export function definitionSearchText(entry: DefinitionEntry) {
  return [entry.term, ...(entry.aliases ?? []), entry.meaning, entry.location ?? "", DEFINITION_KIND_LABELS[entry.kind]]
    .join(" ")
    .replace(/\\([a-zA-Z]+)/g, " $1 ")
    .replace(/[{}$^_\\]/g, " ")
    .toLowerCase();
}

/** Cards matching every word of the query. */
export function filterDefinitions(entries: DefinitionEntry[], query: string, kind: DefinitionKind | "all" = "all") {
  const words = query.toLowerCase().replace(/\\([a-zA-Z]+)/g, " $1 ").split(/[\s{}$^_\\]+/).filter(Boolean);
  return entries.filter((entry) => {
    if (kind !== "all" && entry.kind !== kind) return false;
    if (!words.length) return true;
    const haystack = definitionSearchText(entry);
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * Where an excerpt is in a document, ignoring differences in whitespace; null
 * when it is not there. Offsets are into `content`.
 */
export function findQuoteRange(content: string, quote: string): { start: number; end: number } | null {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  try {
    const match = new RegExp(escaped.join("\\s+"), "u").exec(content);
    return match ? { start: match.index, end: match.index + match[0].length } : null;
  } catch { return null; }
}

/** The 1-based line of an offset. */
export function lineAtOffset(content: string, offset: number) {
  let line = 1;
  for (let index = 0; index < Math.min(offset, content.length); index++) if (content.charCodeAt(index) === 10) line++;
  return line;
}

/** The offset where a 1-based line starts. */
export function offsetOfLine(content: string, line: number) {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = content.indexOf("\n", offset);
    if (next < 0) return content.length;
    offset = next + 1;
  }
  return offset;
}
