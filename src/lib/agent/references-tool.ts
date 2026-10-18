import { readReferenceLibrary } from "@/lib/storage/references";
import { DEFAULT_CSL_STYLE, type CslName, type ReferenceEntry, type ReferenceLibrary } from "@/lib/references/types";
import { formatCitationDocument, isBundledCslStyle, libraryEntriesByKey, loadCitationFormatter, loadCslStyle } from "@/lib/references/format";
import { ok, optionalInteger, plural, quoted, ToolError, type AgentTool, type ToolContext } from "./tools";

// References: read-only lookup in the current notebook's reference library.
// The library is a hidden file the other tools never read, so this is how the
// agent learns which citation keys exist and what they point to. Offered in
// every run and every permission.

export const REFERENCES_TOOL = "References";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const ABSTRACT_CHARS = 600;

function nameText(name: CslName) {
  if (name.literal) return name.literal;
  return [name.given, name["non-dropping-particle"], name.family].filter(Boolean).join(" ");
}

export function entryYear(entry: ReferenceEntry) {
  const year = entry.csl.issued?.["date-parts"]?.[0]?.[0];
  if (typeof year === "number") return year;
  const match = (entry.csl.issued?.literal ?? entry.csl.issued?.raw ?? "").match(/\b(\d{4})\b/);
  return match ? Number(match[1]) : undefined;
}

export function entryAuthors(entry: ReferenceEntry, max = 3) {
  const names = (entry.csl.author ?? entry.csl.editor ?? []).map(nameText).filter(Boolean);
  if (!names.length) return "";
  return names.length > max ? `${names.slice(0, max).join(", ")} et al.` : names.join(", ");
}

/** A short plain-text reference used when citeproc cannot format one. */
export function plainReference(entry: ReferenceEntry) {
  const year = entryYear(entry);
  return [
    entryAuthors(entry) || "Unknown author",
    year ? `(${year})` : "(n.d.)",
    entry.csl.title ? `${entry.csl.title}.` : "Untitled.",
    entry.csl["container-title"] ? `${entry.csl["container-title"]}.` : "",
  ].filter(Boolean).join(" ");
}

/** Plain-text bibliography entries in the library's style, by entry id; plainReference for any it cannot format. */
export async function formatReferences(library: ReferenceLibrary, entries: ReferenceEntry[], { styleXml }: { styleXml?: string | null } = {}): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!entries.length) return result;
  try {
    await loadCitationFormatter();
    // A document's own style (fact-check passes it) wins over the notebook's.
    const style = styleXml ?? await loadCslStyle(isBundledCslStyle(library.style) || library.style?.trim().startsWith("<") ? library.style : DEFAULT_CSL_STYLE);
    const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));
    const formatted = formatCitationDocument({
      citations: [{ items: entries.map((entry) => ({ key: entry.key })), raw: "" }],
      entries: byKey, style, format: "text",
    });
    for (const entry of entries) {
      const text = formatted.bibliographyEntries[entry.id]?.replace(/\s+/g, " ").trim();
      if (text) result.set(entry.id, text);
    }
  } catch { /* Fall back to plain references below. */ }
  for (const entry of entries) if (!result.has(entry.id)) result.set(entry.id, plainReference(entry));
  return result;
}

function identifiersText(entry: ReferenceEntry) {
  const ids = entry.identifiers ?? {};
  return [
    ids.doi ? `DOI ${ids.doi}` : "",
    ids.arxiv ? `arXiv ${ids.arxiv}` : "",
    ids.isbn?.length ? `ISBN ${ids.isbn.join(", ")}` : "",
    ids.pmid ? `PMID ${ids.pmid}` : "",
    ids.pmcid ? `PMCID ${ids.pmcid}` : "",
    ids.openalex ? `OpenAlex ${ids.openalex}` : "",
    !ids.doi && typeof entry.csl.URL === "string" ? `URL ${entry.csl.URL}` : "",
  ].filter(Boolean).join("; ");
}

export function attachmentPaths(entry: ReferenceEntry) {
  return entry.attachments.flatMap((attachment) => attachment.kind === "url" ? [] : [attachment.path]);
}

function searchText(entry: ReferenceEntry) {
  const year = entryYear(entry);
  return [
    entry.key, ...entry.aliases,
    ...(entry.csl.author ?? []).map(nameText), ...(entry.csl.editor ?? []).map(nameText),
    year ? String(year) : "", entry.csl.title ?? "", entry.csl["container-title"] ?? "", ...(entry.tags ?? []),
  ].join(" ").toLowerCase();
}

/**
 * Entries matching `query`: every word must occur in the entry's key,
 * aliases, authors, year, title, venue or tags. Title and key hits rank first,
 * then newer works.
 */
export function searchReferences(library: ReferenceLibrary, query: string) {
  const words = query.toLowerCase().split(/[\s,;]+/).map((word) => word.replace(/^@/, "")).filter(Boolean);
  if (!words.length) return [];
  const scored: { entry: ReferenceEntry; score: number }[] = [];
  for (const entry of Object.values(library.entries)) {
    const haystack = searchText(entry);
    if (!words.every((word) => haystack.includes(word))) continue;
    const title = (entry.csl.title ?? "").toLowerCase();
    const key = [entry.key, ...entry.aliases].join(" ").toLowerCase();
    const score = words.reduce((sum, word) => sum + (key.includes(word) ? 3 : 0) + (title.includes(word) ? 2 : 0) + 1, 0);
    scored.push({ entry, score });
  }
  return scored.sort((left, right) => right.score - left.score || (entryYear(right.entry) ?? 0) - (entryYear(left.entry) ?? 0) || left.entry.key.localeCompare(right.entry.key)).map((item) => item.entry);
}

/** The entries `keys` name, by key or alias (exact, then ignoring case); `missing` lists the keys that match nothing. */
export function lookupReferenceKeys(library: ReferenceLibrary, keys: string[]) {
  const byKey = libraryEntriesByKey(library);
  const lower = new Map<string, ReferenceEntry>();
  for (const [key, entry] of Object.entries(byKey)) if (!lower.has(key.toLowerCase())) lower.set(key.toLowerCase(), entry);
  const found: ReferenceEntry[] = [];
  const missing: string[] = [];
  for (const raw of keys) {
    const key = raw.trim().replace(/^@/, "");
    if (!key) continue;
    const entry = (Object.prototype.hasOwnProperty.call(byKey, key) ? byKey[key] : undefined) ?? lower.get(key.toLowerCase());
    if (!entry) missing.push(key);
    else if (!found.includes(entry)) found.push(entry);
  }
  return { found, missing };
}

export function describeReferenceEntry(entry: ReferenceEntry, formatted: string) {
  const abstract = typeof entry.csl.abstract === "string" ? entry.csl.abstract.replace(/\s+/g, " ").trim() : "";
  const attachments = attachmentPaths(entry);
  const retraction = entry.retraction && entry.retraction.state !== "none" ? entry.retraction.state : "";
  return [
    `@${entry.key}${entry.aliases.length ? ` (aliases: ${entry.aliases.map((alias) => `@${alias}`).join(", ")})` : ""} · ${entry.status}${retraction ? ` · ${retraction}` : ""}`,
    `Reference: ${formatted}`,
    identifiersText(entry) ? `Identifiers: ${identifiersText(entry)}` : "",
    `Attachments: ${attachments.length ? attachments.join(", ") : "none"}`,
    abstract ? `Abstract: ${abstract.length > ABSTRACT_CHARS ? `${abstract.slice(0, ABSTRACT_CHARS - 1)}…` : abstract}` : "",
  ].filter(Boolean).join("\n");
}

function stringList(value: unknown, name: string) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return value.split(/[\s,;]+/).filter(Boolean);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ToolError(`${name} must be a list of strings.`);
  return value as string[];
}

export async function readNotebookLibrary(context: Pick<ToolContext, "notebook">, notebook = context.notebook) {
  if (!notebook) throw new ToolError("No notebook is selected, so there is no reference library to search. Ask the user to open a file or select a notebook.");
  try { return await readReferenceLibrary(notebook); }
  catch (error) { throw new ToolError(`Could not read the reference library of "${notebook}": ${error instanceof Error ? error.message : "unknown error"}.`); }
}

export const referencesTool: AgentTool = {
  name: REFERENCES_TOOL,
  kind: "read",
  description: `Looks up works in the current notebook's References library (read-only). The library is not a file you can Read or Grep; use this tool to see which citation keys exist.

Usage:
- keys: citation keys or aliases to look up exactly, e.g. ["smith2020sparse"]. An alias resolves to the entry it now belongs to.
- query: words to find in authors, year, title, venue and tags, e.g. "smith 2020 sparse attention". Every word must match.
- Pass keys, query, or both; without either, the most recently added entries are listed. limit caps the entries returned (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).
- Each entry comes with its key and aliases, the formatted reference, identifiers, status (confirmed, needs-review, unresolved), attached files (library paths you can Read) and the start of its abstract.
- Cite works as [@key] with keys from this tool or from the notes; never invent a key.`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to search for in authors, year, title, venue and tags." },
      keys: { type: "array", items: { type: "string" }, description: "Citation keys or aliases to look up exactly." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Maximum entries to return (default ${DEFAULT_LIMIT}).` },
    },
    additionalProperties: false,
  },
  describe: (args) => {
    const keys = stringList(args.keys, "keys").slice(0, 3);
    if (keys.length) return `Looking up ${keys.map((key) => `@${key.replace(/^@/, "")}`).join(", ")} in References`;
    return args.query ? `Searching References for ${quoted(args.query)}` : "Listing References";
  },
  async run(args, context) {
    const keys = stringList(args.keys, "keys");
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (args.query !== undefined && args.query !== null && typeof args.query !== "string") throw new ToolError("query must be a string.");
    const limit = optionalInteger(args, "limit", { min: 1, max: MAX_LIMIT }) ?? DEFAULT_LIMIT;
    const library = await readNotebookLibrary(context);
    const total = Object.keys(library.entries).length;
    if (!total) return ok(`The References library of "${context.notebook}" is empty: there are no citation keys to cite.`, "Library is empty");

    const { found, missing } = lookupReferenceKeys(library, keys);
    let matches = found;
    if (query) {
      const searched = searchReferences(library, query);
      matches = keys.length ? [...found, ...searched.filter((entry) => !found.includes(entry))] : searched;
    } else if (!keys.length) {
      matches = Object.values(library.entries).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    }
    const shown = matches.slice(0, limit);
    const formatted = await formatReferences(library, shown);
    const notes = [
      missing.length ? `No entry has the key or alias ${missing.map((key) => `@${key}`).join(", ")}.` : "",
      matches.length > shown.length ? `(Showing ${shown.length} of ${matches.length} matches; narrow the query or raise limit.)` : "",
    ].filter(Boolean);
    if (!shown.length) {
      return ok([`No entries in the References library of "${context.notebook}" (${plural(total, "entry", "entries")}) match${query ? ` ${quoted(query)}` : ""}.`, ...notes].join("\n"), "No matches");
    }
    const body = shown.map((entry) => describeReferenceEntry(entry, formatted.get(entry.id)!)).join("\n\n");
    return ok([body, ...notes].join("\n\n"), plural(shown.length, "entry", "entries"), body.slice(0, 1_500));
  },
};
