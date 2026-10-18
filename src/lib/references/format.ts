// Citation formatting with citeproc-js (docs/references/plan.md §1.3, §4.2;
// the "Formatting" contract in docs/references/lanes.md).
//
// formatCitations() takes every citation of a document in order, the cited
// entries by key and alias, and the style XML. Citations go to citeproc as
// clusters in document order, so numeric styles number by first appearance
// and author-date styles disambiguate (2020a, 2020b). Keys that are not in
// the library never reach citeproc: inside a citation with resolved items
// they show as `@key?`, a citation without any resolved item shows its raw
// token, and both are listed in `unresolvedKeys`. The bibliography lists the
// cited, resolved entries only.
//
// Entry fields come from imports, the web and models, so the HTML citeproc
// returns is put through a small allowlist (sanitizeCitationHtml) before it
// leaves this module, and components render it through hast, never through
// innerHTML.
//
// citeproc (about 1 MB) and the bundled styles are loaded lazily:
// loadCitationFormatter() imports citeproc and the locale, loadCslStyle()
// the style XML. formatCitations() is synchronous and needs the formatter
// loaded first (the citation worker registers it statically instead).
// Results are cached by citations, cited entries, style and locale; engines
// are reused per style, which is what keeps repeated formatting cheap: an
// APA engine alone takes ~300 ms to build.

import type { Element, ElementContent, Root } from "hast";
import { abbreviateJournal, loadJournalAbbreviations } from "./journal-abbreviations";
import {
  BUNDLED_CSL_STYLES,
  DEFAULT_CSL_STYLE,
  type BundledCslStyleId,
  type Citation,
  type CitationItem,
  type CslItem,
  type ReferenceEntry,
  type ReferenceLibrary,
} from "./types";

// ---------------------------------------------------------------------------
// citeproc-js surface
// ---------------------------------------------------------------------------

type CiteprocItem = CslItem & { id: string };
type CiteprocCitationItem = {
  id: string;
  locator?: string;
  label?: string;
  prefix?: string;
  suffix?: string;
  "suppress-author"?: boolean;
};
type CiteprocCitation = { citationID: string; citationItems: CiteprocCitationItem[]; properties: { noteIndex: number } };
type CiteprocBibliographyMeta = {
  entry_ids: string[][];
  hangingindent?: number | boolean;
  "second-field-align"?: string | false;
};
type CiteprocSys = { retrieveLocale(lang: string): string | undefined; retrieveItem(id: string): CiteprocItem | undefined };
type CiteprocEngine = {
  rebuildProcessorState(citations: CiteprocCitation[], mode: "html" | "text"): Array<[string, number, string]>;
  setOutputFormat(mode: "html" | "text"): void;
  makeBibliography(): false | [CiteprocBibliographyMeta, string[]];
};
export type CiteprocModule = {
  Engine: new (sys: CiteprocSys, style: string, lang?: string, forceLang?: boolean) => CiteprocEngine;
};

let citeproc: CiteprocModule | null = null;
let localeXml: Record<string, string> = {};
let loading: Promise<void> | null = null;

/** Use an already imported citeproc and locale set (the citation worker imports them statically). */
export function registerCitationFormatter(module: CiteprocModule, locales: Record<string, string>) {
  citeproc = module;
  localeXml = locales;
}

/** Import citeproc and the bundled locale; resolves once formatCitations() can run. */
export function loadCitationFormatter(): Promise<void> {
  if (citeproc) return Promise.resolve();
  // The journal table is optional: styles that print short journal titles fall back to rule-based ISO 4 without it.
  loading ??= Promise.all([import("citeproc"), import("./csl/locales.generated"), loadJournalAbbreviations().catch(() => undefined)]).then(([module, locales]) => {
    const loaded = (module as { default?: CiteprocModule }).default ?? (module as unknown as CiteprocModule);
    registerCitationFormatter(loaded, locales.CSL_LOCALE_XML);
  }).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

export function citationFormatterLoaded() {
  return citeproc !== null;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

export function isBundledCslStyle(style: string | null | undefined): style is BundledCslStyleId {
  return BUNDLED_CSL_STYLES.some((entry) => entry.id === style);
}

/**
 * The style XML for a library's style setting: a bundled id gives its style,
 * a string starting with `<` is custom `.csl` contents used as they are, and
 * anything else (an unknown id, an empty setting) falls back to
 * DEFAULT_CSL_STYLE. A library-relative `.csl` path is read by the caller and
 * passed here as XML.
 */
export async function loadCslStyle(styleIdOrXml: string | null | undefined): Promise<string> {
  const value = (styleIdOrXml ?? "").trim();
  if (value.startsWith("<")) return value;
  const { BUNDLED_CSL_STYLE_XML } = await import("./csl/styles.generated");
  return BUNDLED_CSL_STYLE_XML[isBundledCslStyle(value) ? value : DEFAULT_CSL_STYLE];
}

type LayoutAffixes = { prefix: string; suffix: string; delimiter: string };

function decodeXmlEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => decodeEntity(entity) ?? match);
}

/** The affixes of the style's citation layout, used to place `@key?` inside the brackets. */
function citationLayout(style: string): LayoutAffixes {
  const citation = /<citation[\s>][\s\S]*?<\/citation>/.exec(style)?.[0] ?? "";
  const layout = /<layout\b([^>]*)>/.exec(citation)?.[1] ?? "";
  const attribute = (name: string) => {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(layout);
    return match ? decodeXmlEntities(match[1] ?? match[2] ?? "") : "";
  };
  return { prefix: attribute("prefix"), suffix: attribute("suffix"), delimiter: attribute("delimiter") || "; " };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const hasOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** Every entry of a library by key and by alias; a key wins over another entry's alias. */
export function libraryEntriesByKey(library: ReferenceLibrary | null | undefined): Record<string, ReferenceEntry> {
  const byKey: Record<string, ReferenceEntry> = Object.create(null);
  if (!library) return byKey;
  const entries = Object.values(library.entries);
  for (const entry of entries) {
    for (const alias of entry.aliases ?? []) if (!(alias in byKey)) byKey[alias] = entry;
  }
  for (const entry of entries) byKey[entry.key] = entry;
  return byKey;
}

/**
 * The entries a document cites, by key and by alias: for each of `keys` that
 * resolves, its entry under that key, the entry's current key and its aliases.
 */
export function citationEntriesForDocument(library: ReferenceLibrary | null | undefined, keys: Iterable<string>): Record<string, ReferenceEntry> {
  const all = libraryEntriesByKey(library);
  const cited: Record<string, ReferenceEntry> = Object.create(null);
  for (const key of keys) {
    const entry = all[key];
    if (!entry) continue;
    cited[key] = entry;
    if (!(entry.key in cited)) cited[entry.key] = entry;
    for (const alias of entry.aliases ?? []) if (all[alias] === entry && !(alias in cited)) cited[alias] = entry;
  }
  return cited;
}

/** The entry `key` resolves to in a by-key-and-alias record, ignoring inherited properties. */
export function entryForKey(entries: Record<string, ReferenceEntry>, key: string): ReferenceEntry | undefined {
  return hasOwn(entries, key) ? entries[key] : undefined;
}

const itemJson = new WeakMap<ReferenceEntry, string>();
function entryJson(entry: ReferenceEntry) {
  let json = itemJson.get(entry);
  if (json === undefined) {
    json = JSON.stringify(entry.csl);
    itemJson.set(entry, json);
  }
  return json;
}

/** Whether a style prints `container-title` in its short form (IEEE, Nature, Vancouver, Chicago in places). */
export function styleUsesShortContainerTitle(style: string) {
  for (const match of style.matchAll(/<text\b[^>]*>/g)) {
    if (/\bvariable\s*=\s*["']container-title["']/.test(match[0]) && /\bform\s*=\s*["']short["']/.test(match[0])) return true;
  }
  return false;
}

/**
 * The item citeproc formats. For a style that asks for short container
 * titles, an entry without `container-title-short` gets its ISO 4
 * abbreviation (citeproc would otherwise print the full title).
 */
function citeprocItemFor(entry: ReferenceEntry, shortContainers: boolean): CiteprocItem {
  const item: CiteprocItem = { ...entry.csl, id: entry.id };
  const container = typeof item["container-title"] === "string" ? item["container-title"].trim() : "";
  if (shortContainers && container && !(typeof item["container-title-short"] === "string" && item["container-title-short"].trim())) {
    const short = abbreviateJournal(container);
    if (short && short !== container) item["container-title-short"] = short;
  }
  return item;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export type CitationFormatInput = {
  /** In document order. */
  citations: Citation[];
  /** By key AND by alias. */
  entries: Record<string, ReferenceEntry>;
  /** CSL XML. */
  style: string;
  /** Default "en-US". */
  locale?: string;
  /** Default "html". */
  format?: "html" | "text";
};

export type FormattedCitations = { citations: string[]; bibliography: string; unresolvedKeys: string[] };

/** formatCitations() plus each bibliography entry on its own, by entry id (for hover cards). */
export type FormattedCitationDocument = FormattedCitations & { bibliographyEntries: Record<string, string> };

const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;

function citeprocCitationItem(item: CitationItem, id: string): CiteprocCitationItem {
  const result: CiteprocCitationItem = { id };
  if (item.locator) {
    result.locator = item.locator.replace(MARKDOWN_ESCAPE, "$1");
    result.label = item.label ?? "page";
  }
  if (item.prefix) result.prefix = item.prefix.replace(MARKDOWN_ESCAPE, "$1");
  if (item.suffix) {
    const suffix = item.suffix.replace(MARKDOWN_ESCAPE, "$1");
    result.suffix = /^[,.;:!?)\]]/.test(suffix) ? suffix : `, ${suffix}`;
  }
  if (item.suppressAuthor) result["suppress-author"] = true;
  return result;
}

type EngineState = { engine: CiteprocEngine; items: Map<string, CiteprocItem>; json: Map<string, string>; layout: LayoutAffixes };
const engines = new Map<string, EngineState>();
const MAX_ENGINES = 4;

/**
 * A citeproc engine for this style and locale. Engines are reused, since a
 * large style takes hundreds of milliseconds to build; but citeproc keeps
 * disambiguation state per item, so an engine whose items changed is rebuilt.
 */
function engineFor(style: string, locale: string, items: Map<string, CiteprocItem>, json: Map<string, string>) {
  const cacheKey = `${locale}\u0000${style}`;
  let state = engines.get(cacheKey);
  if (state) {
    for (const [id, value] of json) {
      const known = state.json.get(id);
      if (known !== undefined && known !== value) {
        state = undefined;
        break;
      }
    }
  }
  if (!state) {
    if (!citeproc) throw new Error("Call loadCitationFormatter() before formatCitations().");
    const fallback = localeXml["en-US"] ? "en-US" : Object.keys(localeXml)[0];
    const lang = localeXml[locale] ? locale : fallback;
    const current: EngineState = { engine: null as unknown as CiteprocEngine, items: new Map(), json: new Map(), layout: citationLayout(style) };
    const sys: CiteprocSys = {
      retrieveLocale: (requested) => localeXml[requested] ?? localeXml[requested.split("-")[0]] ?? (fallback ? localeXml[fallback] : undefined),
      retrieveItem: (id) => current.items.get(id),
    };
    current.engine = new citeproc.Engine(sys, style, lang, true);
    state = current;
    engines.delete(cacheKey);
    engines.set(cacheKey, state);
    while (engines.size > MAX_ENGINES) engines.delete(engines.keys().next().value!);
  }
  for (const [id, item] of items) state.items.set(id, item);
  for (const [id, value] of json) state.json.set(id, value);
  return state;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);
}

/** Put `@key?` marks for unresolved keys inside the formatted citation, before the layout's closing affix. */
function withUnresolvedKeys(formatted: string, keys: string[], layout: LayoutAffixes, format: "html" | "text") {
  const html = format === "html";
  const marks = keys.map((key) => html ? `<span class="csl-unresolved">@${escapeHtml(key)}?</span>` : `@${key}?`);
  const delimiter = html ? escapeHtml(layout.delimiter) : layout.delimiter;
  const closing = html ? /(?:<\/[a-z]+>)*$/.exec(formatted)?.[0] ?? "" : "";
  let body = formatted.slice(0, formatted.length - closing.length);
  const suffix = html ? escapeHtml(layout.suffix) : layout.suffix;
  let after = "";
  if (suffix && body.endsWith(suffix)) {
    body = body.slice(0, body.length - suffix.length);
    after = suffix;
  }
  return `${body}${delimiter}${marks.join(delimiter)}${after}${closing}`;
}

const results = new Map<string, FormattedCitationDocument>();
const MAX_RESULTS = 16;
/** Short ids for style XML, so cache keys do not repeat whole styles. */
const styleIds = new Map<string, number>();

function styleId(style: string) {
  let id = styleIds.get(style);
  if (id === undefined) {
    id = styleIds.size;
    styleIds.set(style, id);
  }
  return id;
}

function resultCacheKey(input: CitationFormatInput, resolved: Map<string, ReferenceEntry>, locale: string, format: string) {
  const parts = [format, locale, styleId(input.style), JSON.stringify(input.citations.map((citation) => [citation.raw, citation.items]))];
  for (const [key, entry] of resolved) parts.push(key, entry.id, entryJson(entry));
  return parts.join("\u0000");
}

/** formatCitations(), plus every bibliography entry on its own (by entry id). */
export function formatCitationDocument(input: CitationFormatInput): FormattedCitationDocument {
  const format = input.format ?? "html";
  const locale = input.locale ?? "en-US";
  const resolved = new Map<string, ReferenceEntry>();
  const unresolvedKeys: string[] = [];
  for (const citation of input.citations) {
    for (const item of citation.items) {
      if (resolved.has(item.key) || unresolvedKeys.includes(item.key)) continue;
      const entry = entryForKey(input.entries, item.key);
      if (entry) resolved.set(item.key, entry);
      else unresolvedKeys.push(item.key);
    }
  }

  const cacheKey = resultCacheKey(input, resolved, locale, format);
  const cached = results.get(cacheKey);
  if (cached) {
    results.delete(cacheKey);
    results.set(cacheKey, cached);
    return cached;
  }

  const raw = (citation: Citation) => format === "html" ? escapeHtml(citation.raw) : citation.raw;
  let result: FormattedCitationDocument;
  if (!resolved.size) {
    result = { citations: input.citations.map(raw), bibliography: "", bibliographyEntries: {}, unresolvedKeys };
  } else {
    const items = new Map<string, CiteprocItem>();
    const json = new Map<string, string>();
    const shortContainers = styleUsesShortContainerTitle(input.style);
    for (const entry of resolved.values()) {
      if (items.has(entry.id)) continue;
      items.set(entry.id, citeprocItemFor(entry, shortContainers));
      json.set(entry.id, entryJson(entry));
    }
    const state = engineFor(input.style, locale, items, json);
    const clusters: CiteprocCitation[] = [];
    const missing: string[][] = [];
    input.citations.forEach((citation, index) => {
      const seen = new Set<string>();
      const citationItems: CiteprocCitationItem[] = [];
      const unresolved: string[] = [];
      for (const item of citation.items) {
        const entry = resolved.get(item.key);
        if (!entry) {
          if (!unresolved.includes(item.key)) unresolved.push(item.key);
        } else if (!seen.has(entry.id)) {
          seen.add(entry.id);
          citationItems.push(citeprocCitationItem(item, entry.id));
        }
      }
      missing[index] = unresolved;
      if (citationItems.length) clusters.push({ citationID: `c${index}`, citationItems, properties: { noteIndex: 0 } });
    });

    const formatted = new Map<string, string>();
    for (const [id, , text] of state.engine.rebuildProcessorState(clusters, format)) formatted.set(id, text);
    const citations = input.citations.map((citation, index) => {
      const text = formatted.get(`c${index}`);
      if (text === undefined) return raw(citation);
      const clean = format === "html" ? sanitizeCitationHtmlString(text) : text;
      return missing[index].length ? withUnresolvedKeys(clean, missing[index], state.layout, format) : clean;
    });

    state.engine.setOutputFormat(format);
    const bibliography = state.engine.makeBibliography();
    const bibliographyEntries: Record<string, string> = {};
    let bibliographyText = "";
    if (bibliography) {
      const [meta, entries] = bibliography;
      const cleaned = entries.map((entry) => format === "html" ? sanitizeCitationHtmlString(entry.trim()) : entry.trim());
      cleaned.forEach((entry, index) => {
        const id = meta.entry_ids[index]?.[0];
        if (id !== undefined) bibliographyEntries[String(id)] = entry;
      });
      if (format === "html") {
        const classes = ["csl-bib-body"];
        if (meta.hangingindent) classes.push("csl-hanging-indent");
        if (meta["second-field-align"]) classes.push("csl-second-field-align");
        bibliographyText = `<div class="${classes.join(" ")}">${cleaned.join("")}</div>`;
      } else {
        bibliographyText = cleaned.join("\n");
      }
    }
    result = { citations, bibliography: bibliographyText, bibliographyEntries, unresolvedKeys };
  }

  results.set(cacheKey, result);
  while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
  return result;
}

/**
 * Format a document's citations, in document order, and its bibliography.
 * Results are cached: the same citations, cited entries, style and locale
 * return the same (read-only) object without running citeproc again.
 */
export function formatCitations(input: CitationFormatInput): FormattedCitations {
  const { citations, bibliography, unresolvedKeys } = formatCitationDocument(input);
  return { citations, bibliography, unresolvedKeys };
}

// ---------------------------------------------------------------------------
// Sanitizing citeproc's HTML
// ---------------------------------------------------------------------------

const FORMATTING_TAGS = new Set(["i", "b", "em", "strong", "sup", "sub"]);
const DROPPED_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript", "textarea", "title", "svg", "math", "select", "xmp", "plaintext", "noembed", "noframes",
]);
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntity(entity: string) {
  if (entity[0] !== "#") return NAMED_ENTITIES[entity.toLowerCase()];
  const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(code);
}

function decodeHtmlEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => decodeEntity(entity) ?? match);
}

function parseAttributes(source: string) {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

/** The element to keep for an allowed tag, with only its allowed attributes; null to unwrap it. */
function allowedElement(tag: string, attributes: Map<string, string>): Element | null {
  if (FORMATTING_TAGS.has(tag)) return { type: "element", tagName: tag, properties: {}, children: [] };
  if (tag === "span" || tag === "div") {
    const classes = (attributes.get("class") ?? "").split(/\s+/).filter((name) => /^csl-[a-z0-9-]+$/i.test(name) || (tag === "span" && name === "nocase"));
    const properties: Element["properties"] = {};
    if (classes.length) properties.className = classes;
    if (tag === "span" && /(?:^|;)\s*font-variant\s*:\s*small-caps\s*;?\s*$/i.test(attributes.get("style") ?? "")) properties.style = "font-variant:small-caps";
    return Object.keys(properties).length ? { type: "element", tagName: tag, properties, children: [] } : null;
  }
  if (tag === "a") {
    const href = (attributes.get("href") ?? "").trim();
    return /^https?:\/\/[^\s]+$/i.test(href)
      ? { type: "element", tagName: "a", properties: { href, rel: ["noopener", "noreferrer"], target: "_blank" }, children: [] }
      : null;
  }
  return null;
}

/**
 * Parse citeproc's HTML into hast through an allowlist: i, b, em, strong,
 * sup, sub; span with the `nocase` class or small caps; div and span with
 * csl-* classes; a with an http(s) href. Other tags are unwrapped (their text
 * stays, as text), script-like tags are dropped with their content, and every
 * other attribute is removed. Malformed markup becomes literal text.
 */
export function sanitizeCitationHtml(html: string): Root {
  const root: Root = { type: "root", children: [] };
  // Open elements; null marks an unwrapped tag that still needs its close tag matched.
  const stack: Array<{ tag: string; element: Element | null }> = [];
  const parent = () => {
    for (let index = stack.length - 1; index >= 0; index -= 1) if (stack[index].element) return stack[index].element!;
    return root;
  };
  let text = "";
  const flush = () => {
    if (!text) return;
    const value = decodeHtmlEntities(text);
    const children = parent().children as ElementContent[];
    const last = children[children.length - 1];
    if (last?.type === "text") last.value += value;
    else children.push({ type: "text", value });
    text = "";
  };

  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      text += html.slice(index);
      break;
    }
    text += html.slice(index, open);
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    TAG.lastIndex = open;
    const match = TAG.exec(html);
    if (!match) {
      text += "<";
      index = open + 1;
      continue;
    }
    index = TAG.lastIndex;
    flush();
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    if (closing) {
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth].tag === tag) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    if (DROPPED_WITH_CONTENT.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, index);
      const close = end === -1 ? -1 : html.indexOf(">", end);
      index = close === -1 ? html.length : close + 1;
      continue;
    }
    const element = allowedElement(tag, parseAttributes(match[3]));
    if (element) (parent().children as ElementContent[]).push(element);
    if (match[4] !== "/" && tag !== "br" && tag !== "img" && tag !== "hr" && tag !== "wbr" && tag !== "input") stack.push({ tag, element });
  }
  flush();
  return root;
}

function escapeText(value: string) {
  return value.replace(/[&<>]/g, (char) => HTML_ESCAPES[char]);
}

function serialize(nodes: ElementContent[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += escapeText(node.value);
    else if (node.type === "element") {
      let attributes = "";
      const { className, style, href, rel, target } = node.properties;
      if (Array.isArray(className) && className.length) attributes += ` class="${escapeHtml(className.join(" "))}"`;
      if (typeof style === "string") attributes += ` style="${escapeHtml(style)}"`;
      if (typeof href === "string") attributes += ` href="${escapeHtml(href)}"`;
      if (Array.isArray(rel)) attributes += ` rel="${escapeHtml(rel.join(" "))}"`;
      if (typeof target === "string") attributes += ` target="${escapeHtml(target)}"`;
      output += `<${node.tagName}${attributes}>${serialize(node.children)}</${node.tagName}>`;
    }
  }
  return output;
}

/** Serialize a tree from sanitizeCitationHtml. */
export function citationHastToHtml(root: Root): string {
  return serialize(root.children as ElementContent[]);
}

/** Sanitize an HTML string from citeproc and serialize it back. */
export function sanitizeCitationHtmlString(html: string): string {
  return citationHastToHtml(sanitizeCitationHtml(html));
}

/** Plain text of formatted citation HTML (for titles and accessible names). */
export function citationHtmlToText(html: string): string {
  const collect = (nodes: ElementContent[]): string => nodes.map((node) => node.type === "text" ? node.value : node.type === "element" ? collect(node.children) : "").join("");
  return collect(sanitizeCitationHtml(html).children as ElementContent[]);
}
