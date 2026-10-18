import { readFile } from "node:fs/promises";
import type { Element, ElementContent } from "hast";
import { citedKeys, scanCitations } from "@/lib/references/citation-syntax";
import {
  citationEntriesForDocument,
  formatCitationDocument,
  isBundledCslStyle,
  loadCitationFormatter,
  loadCslStyle,
  sanitizeCitationHtml,
} from "@/lib/references/format";
import { DEFAULT_CSL_STYLE, type Citation, type ReferenceEntry, type ReferenceLibrary } from "@/lib/references/types";
import { StorageError } from "@/lib/storage/errors";
import { filePathFromParts, splitFilePath } from "@/lib/storage/paths";

// Formatted reference lists on the server (docs/references/plan.md §1.5,
// "Export document bibliography"): the cited entries of a document, or a
// whole library or a selection, in the notebook's CSL style or another one,
// as plain text, Markdown or HTML. citeproc runs in Node through format.ts,
// and its HTML goes through the same allowlist (sanitizeCitationHtml) before
// it is turned into any of the outputs. The LaTeX export reuses the parsing
// here (latex-citations.ts).

export type BibliographyFormat = "text" | "markdown" | "html";
export const BIBLIOGRAPHY_FORMATS: readonly BibliographyFormat[] = ["text", "markdown", "html"];

/** One bibliography entry: the label of a numeric style ("[1]"), if any, and the entry itself. */
export type BibliographyItem = { label: ElementContent[] | null; body: ElementContent[] };

function withClass(node: ElementContent | undefined, name: string): Element | null {
  return node?.type === "element" && Array.isArray(node.properties.className) && node.properties.className.includes(name) ? node : null;
}

/** Drop the indentation between block children (citeproc's left-margin and right-inline divs); inline spacing stays. */
function trimWhitespaceNodes(nodes: ElementContent[]) {
  if (!nodes.some((node) => node.type === "element" && node.tagName === "div")) return nodes;
  return nodes.filter((node) => node.type !== "text" || node.value.trim());
}

/** The entries of formatted bibliography HTML, in order, from the sanitized tree. */
export function bibliographyItems(html: string): BibliographyItem[] {
  const items: BibliographyItem[] = [];
  const visit = (nodes: ElementContent[]) => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (withClass(node, "csl-entry")) {
        const children = trimWhitespaceNodes(node.children);
        const label = children.map((child) => withClass(child, "csl-left-margin")).find(Boolean) ?? null;
        const rest = label ? children.filter((child) => child !== label) : children;
        const right = rest.length === 1 ? withClass(rest[0], "csl-right-inline")?.children ?? rest : rest;
        items.push({ label: label ? label.children : null, body: right });
      } else {
        visit(node.children);
      }
    }
  };
  visit(sanitizeCitationHtml(html).children as ElementContent[]);
  return items;
}

/** Whether every entry has a label, as numeric styles' entries do. */
export function isLabelledBibliography(items: BibliographyItem[]) {
  return items.length > 0 && items.every((item) => item.label !== null);
}

/** Plain text of sanitized nodes, whitespace collapsed. */
export function nodesToText(nodes: ElementContent[]): string {
  const collect = (list: ElementContent[]): string =>
    list.map((node) => node.type === "text" ? node.value : node.type === "element" ? collect(node.children) : "").join("");
  return collect(nodes).replace(/\s+/g, " ").trim();
}

const MARKDOWN_SPECIALS = /[\\`*_{}[\]<>#|~$&!]/g;

/** Escape text so Markdown shows it literally (emphasis, links, HTML, math, list markers). */
export function escapeMarkdownText(text: string) {
  return text.replace(MARKDOWN_SPECIALS, (char) => `\\${char}`);
}

/** Wrap with a Markdown delimiter, keeping surrounding spaces outside it so the emphasis still parses. */
function delimit(inner: string, marker: string) {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  return match[2] ? `${match[1]}${marker}${match[2]}${marker}${match[3]}` : inner;
}

/** Sanitized citeproc nodes → Markdown: italics as `*…*`, bold as `**…**`, everything else as escaped text. */
export function nodesToMarkdown(nodes: ElementContent[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += escapeMarkdownText(node.value.replace(/\s+/g, " "));
    else if (node.type === "element") {
      const inner = nodesToMarkdown(node.children);
      if (node.tagName === "i" || node.tagName === "em") output += delimit(inner, "*");
      else if (node.tagName === "b" || node.tagName === "strong") output += delimit(inner, "**");
      else output += inner;
    }
  }
  return output;
}

function startOfLineSafe(markdown: string) {
  // "1. Smith" would start an ordered list and "- x" or "+ x" a bullet list.
  return markdown.replace(/^(\d+)([.)])/, "$1\\$2").replace(/^([-+])(\s)/, "\\$1$2");
}

/** Text, Markdown or HTML for a formatted bibliography (citeproc HTML, already sanitized by format.ts). */
export function renderBibliography(html: string, format: BibliographyFormat): string {
  if (format === "html") return html;
  const items = bibliographyItems(html);
  if (format === "text") {
    return items.map(({ label, body }) => [label ? nodesToText(label) : "", nodesToText(body)].filter(Boolean).join(" ")).join("\n");
  }
  return items.map(({ label, body }) => {
    const text = [label ? nodesToMarkdown(label).trim() : "", nodesToMarkdown(body).trim()].filter(Boolean).join(" ");
    return startOfLineSafe(text);
  }).join("\n\n");
}

/** Read a `.csl` file in the library: a library-relative path, or one relative to the notebook. */
async function readCustomStyle(notebook: string, stylePath: string) {
  const candidates = [stylePath, ...(!stylePath.startsWith(`${notebook}/`) ? [`${notebook}/${stylePath}`] : [])];
  for (const candidate of candidates) {
    try {
      const { notebook: owner, pathParts } = splitFilePath(candidate);
      const xml = (await readFile(filePathFromParts(owner, pathParts), "utf8")).trim();
      if (xml.startsWith("<")) return xml;
    } catch {
      // Try the next location; the default style is used when none works.
    }
  }
  return null;
}

/** Whether `style` names a bundled style or a `.csl` file. */
export function isStyleSetting(style: string) {
  return isBundledCslStyle(style) || /\.csl$/i.test(style);
}

/** The style XML for a library style setting, the way the preview loads it. */
export async function loadNotebookStyle(notebook: string, setting: string | null | undefined): Promise<string> {
  const value = (setting || DEFAULT_CSL_STYLE).trim();
  let xml: string | null = null;
  if (!isBundledCslStyle(value) && /\.csl$/i.test(value)) xml = await readCustomStyle(notebook, value);
  return xml ?? loadCslStyle(value);
}

export type BibliographyRequest = {
  notebook: string;
  library: ReferenceLibrary;
  format: BibliographyFormat;
  /** The cited entries of this Markdown, in the style's order. */
  documentText?: string;
  /** Without documentText: these entries; otherwise the whole library. */
  ids?: string[];
  /** A bundled style id or a `.csl` path; defaults to the library's style. */
  style?: string;
};

export type FormattedBibliography = { text: string; count: number; unresolvedKeys: string[] };

/** Each entry cited once, by its key, in a stable order (creation time, then key). */
function entryCitations(entries: ReferenceEntry[]) {
  const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
  const byKey: Record<string, ReferenceEntry> = Object.create(null);
  const citations: Citation[] = sorted.map((entry) => {
    byKey[entry.key] = entry;
    return { items: [{ key: entry.key }], raw: `[@${entry.key}]` };
  });
  return { citations, entries: byKey };
}

/** The formatted reference list for a document, a selection or a whole library. */
export async function formatNotebookBibliography(request: BibliographyRequest): Promise<FormattedBibliography> {
  if (request.style !== undefined && !isStyleSetting(request.style)) {
    throw new StorageError("The style must be a bundled style or a .csl file.", 400);
  }
  let citations: Citation[];
  let entries: Record<string, ReferenceEntry>;
  if (request.documentText !== undefined) {
    citations = scanCitations(request.documentText).map((occurrence) => occurrence.citation);
    entries = citationEntriesForDocument(request.library, citedKeys(request.documentText));
  } else {
    let selected = Object.values(request.library.entries);
    if (request.ids) {
      const wanted = new Set(request.ids);
      selected = selected.filter((entry) => wanted.has(entry.id));
    }
    ({ citations, entries } = entryCitations(selected));
  }
  if (!citations.length) return { text: "", count: 0, unresolvedKeys: [] };

  const [style] = await Promise.all([loadNotebookStyle(request.notebook, request.style ?? request.library.style), loadCitationFormatter()]);
  const formatted = formatCitationDocument({ citations, entries, style, format: "html" });
  return {
    text: renderBibliography(formatted.bibliography, request.format),
    count: Object.keys(formatted.bibliographyEntries).length,
    unresolvedKeys: formatted.unresolvedKeys,
  };
}
