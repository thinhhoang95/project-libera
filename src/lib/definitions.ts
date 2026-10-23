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

// Search. Cards are found by their term first, then their aliases, then
// their meaning and location. LaTeX is matched loosely, because a reader types
// what they see: "Qfg" finds $\mathcal{Q}_{f,g}$, "PiK" and "πK" find $\Pi_K$,
// and "mathcal" finds every $\mathcal{…}$.

const GREEK_LETTERS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "π", rho: "ρ", varrho: "ρ", sigma: "σ",
  varsigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ",
  Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const squeeze = (text: string) => text.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();

/**
 * Compact forms of a term, with spacing, punctuation, braces, sub- and
 * superscript marks removed: one with LaTeX commands dropped (Greek letters
 * kept as letters), one with their names kept. `\mathcal{Q}_{f,g}` gives
 * "qfg" and "mathcalqfg"; `\Pi_K` gives "πk" and "pik".
 */
export function compactSearchForms(text: string) {
  const symbols = squeeze(text.replace(/\\([a-zA-Z]+)/g, (_, name: string) => GREEK_LETTERS[name] ?? " "));
  const names = squeeze(text.replace(/\\([a-zA-Z]+)/g, " $1 "));
  return [...new Set([symbols, names].filter(Boolean))];
}

/** Words of a text, with LaTeX command names as words of their own: `\mathcal{F}_t` gives "mathcal", "f", "t". */
function searchWords(text: string) {
  return text.normalize("NFKD").replace(/\\([a-zA-Z]+)/g, " $1 ").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

type SearchQuery = { forms: string[]; words: string[] };

/** How well a text matches: 0 the same, 1 starts with the query, 2 contains it, null not at all. */
function matchStrength(text: string, query: SearchQuery, { loose }: { loose: boolean }): number | null {
  const forms = compactSearchForms(text);
  if (query.forms.some((form) => forms.includes(form))) return 0;
  if (query.forms.some((form) => forms.some((candidate) => candidate.startsWith(form)))) return 1;
  // Inside long text a short squeezed query matches by accident ("ab" in "a, b"); there it must be words.
  if (query.forms.some((form) => (loose || form.length >= 3) && forms.some((candidate) => candidate.includes(form)))) return 2;
  const words = searchWords(text);
  if (query.words.length && query.words.every((word) => words.some((candidate) => candidate.startsWith(word)))) return 2;
  return null;
}

/**
 * How well a card matches a query, lower is better, or null: its term
 * (0 exact, 1 prefix, 2 anywhere), its aliases (3–5), then its meaning,
 * location or kind (6).
 */
export function definitionMatchRank(entry: DefinitionEntry, query: string): number | null {
  const parsed: SearchQuery = { forms: compactSearchForms(query), words: searchWords(query) };
  if (!parsed.forms.length) return 0;
  const term = matchStrength(entry.term, parsed, { loose: true });
  if (term !== null) return term;
  const aliases: number[] = [];
  for (const alias of entry.aliases ?? []) {
    // Aliases are phrases: like meanings, a short query must match a word.
    const rank = matchStrength(alias, parsed, { loose: false });
    if (rank !== null) aliases.push(rank);
  }
  if (aliases.length) return 3 + Math.min(...aliases);
  const rest = [entry.meaning, entry.location ?? "", DEFINITION_KIND_LABELS[entry.kind]].join(" \n ");
  if (matchStrength(rest, parsed, { loose: false }) !== null) return 6;
  // Words spread over the fields: "lipschitz definition 2" across term, kind and location.
  const words = searchWords([entry.term, ...(entry.aliases ?? []), rest].join(" "));
  return parsed.words.length && parsed.words.every((word) => words.some((candidate) => candidate.startsWith(word))) ? 6 : null;
}

/** Cards matching the query, best first: term matches, then aliases, then meanings; ties keep document order. */
export function filterDefinitions(entries: DefinitionEntry[], query: string, kind: DefinitionKind | "all" = "all") {
  const ranked: { entry: DefinitionEntry; rank: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    if (kind !== "all" && entry.kind !== kind) return;
    const rank = query.trim() ? definitionMatchRank(entry, query) : 0;
    if (rank !== null) ranked.push({ entry, rank, index });
  });
  return ranked.sort((left, right) => left.rank - right.rank || left.index - right.index).map(({ entry }) => entry);
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
