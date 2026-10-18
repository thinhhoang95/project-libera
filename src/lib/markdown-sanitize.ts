// Allowlist sanitizer for rendered Markdown and note HTML (collaboration map
// §10: content from collaborators is untrusted).
//
// rehype-sanitize is not installed, so this is a small hast-tree sanitizer
// used as a rehype plugin (preview, preview worker, slides, export) and,
// through sanitizeHtmlFragment, on HTML strings that end up in innerHTML
// (resting PDF notes).
//
// The allowlist is exactly what Libera's own pipeline produces: Markdown and
// GFM elements, Libera's colour, highlight, underline, text-style and box
// syntax (data-* attributes, `<u>`, `<mark>`, spans), KaTeX's HTML, MathML
// and SVG output, and the TipTap schema's note HTML. Everything else goes:
//
// - script, style, iframe, object, embed, forms and similar are dropped with
//   their content; other unknown elements are unwrapped (their text stays);
// - attributes not on the list are dropped, which removes every on* handler;
// - link URLs keep the protocols react-markdown allows (http, https, mailto,
//   irc, ircs, xmpp) or are relative; anything else (javascript:, data:,
//   vbscript:, file:) becomes an empty href;
// - `style` survives only without url(), expression(), imports, bindings,
//   escapes or fixed positioning;
// - raw HTML nodes become text, as react-markdown already renders them.
//
// Image sources depend on trust. Local notes keep what they always allowed
// (relative and absolute paths, http(s), pasted PNG/JPEG/GIF/WebP data
// URLs). Shared documents allow only https and local asset URLs, so a
// collaborator cannot make every reader's machine fetch an http:// or
// arbitrary same-origin URL; a blocked image is shown as its alt text.

import type { Element, ElementContent, Nodes, Parents, Properties, Root, RootContent } from "hast";
import { fromHtmlIsomorphic } from "hast-util-from-html-isomorphic";
import { find, html as htmlSchema, svg as svgSchema } from "property-information";

export type ContentTrust = "local" | "shared";

export interface SanitizeOptions {
  /** "shared" for documents from a shared notebook (stricter images). Default "local". */
  trust?: ContentTrust;
}

/** Dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "noscript",
  "noembed",
  "noframes",
  "template",
  "textarea",
  "select",
  "option",
  "optgroup",
  "button",
  "form",
  "fieldset",
  "base",
  "link",
  "meta",
  "title",
  "head",
  "xmp",
  "plaintext",
  "dialog",
  "portal",
  "fencedframe",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "map",
  "area",
  "param",
  "foreignobject",
  "use",
  "image",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "handler",
  "listener",
  "annotation-xml",
]);

const HTML_ELEMENTS = [
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del",
  "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i",
  "img", "input", "ins", "kbd", "label", "li", "mark", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp",
  "section", "small", "span", "strike", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
];
// KaTeX's MathML output.
const MATHML_ELEMENTS = [
  "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "ms", "mtext", "mspace", "msup", "msub", "msubsup",
  "mfrac", "msqrt", "mroot", "mstyle", "mtable", "mtr", "mtd", "mlabeledtr", "mover", "munder", "munderover",
  "mpadded", "mphantom", "menclose", "merror", "mmultiscripts", "mprescripts", "none",
];
// KaTeX draws radicals, arrows and braces as inline SVG paths.
const SVG_ELEMENTS = ["svg", "path", "line", "rect", "g"];

const ALLOWED_ELEMENTS = new Set([...HTML_ELEMENTS, ...MATHML_ELEMENTS, ...SVG_ELEMENTS]);
const SVG_ELEMENTS_SET = new Set(SVG_ELEMENTS);

/** Attribute names (lowercase) allowed on any element; plus aria-* and data-*. */
const ALLOWED_ATTRIBUTES = new Set([
  // global
  "class", "id", "title", "lang", "dir", "role", "style", "hidden", "translate",
  // HTML elements on the list
  "href", "target", "rel", "src", "alt", "width", "height", "type", "checked", "disabled", "align", "valign",
  "colspan", "rowspan", "colwidth", "scope", "span", "start", "reversed", "value", "datetime", "open",
  // MathML (KaTeX)
  "xmlns", "display", "encoding", "mathvariant", "stretchy", "fence", "separator", "lspace", "rspace", "minsize",
  "maxsize", "movablelimits", "symmetric", "largeop", "accent", "accentunder", "depth", "voffset", "linethickness",
  "notation", "columnalign", "rowalign", "columnspacing", "rowspacing", "columnlines", "rowlines", "frame",
  "framespacing", "equalrows", "equalcolumns", "displaystyle", "scriptlevel", "mathcolor", "mathbackground",
  "mathsize", "side", "rowspan", "columnspan",
  // SVG (KaTeX)
  "viewbox", "preserveaspectratio", "d", "x", "y", "x1", "y1", "x2", "y2", "fill", "fill-rule", "stroke",
  "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "transform",
]);

const SAFE_LINK_PROTOCOL = /^(?:https?|ircs?|mailto|xmpp)$/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
const UNSAFE_STYLE = /url\s*\(|image-set\s*\(|expression\s*\(|javascript:|vbscript:|@import|behaviou?r\s*:|-moz-binding|\\|position\s*:\s*(?:fixed|sticky)|<|>/i;
/** Images from a shared document: https or the Markdown asset route. */
const SHARED_IMAGE_PATH = /^\/api\/markdown-assets\//;

/**
 * react-markdown's defaultUrlTransform rule, so local links render exactly as
 * before: a URL with a scheme is kept only for safe protocols; relative URLs
 * (no colon before the first /, ? or #) are kept.
 */
export function safeLinkUrl(url: string): string {
  const colon = url.indexOf(":");
  const question = url.indexOf("?");
  const hash = url.indexOf("#");
  const slash = url.indexOf("/");
  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash) ||
    SAFE_LINK_PROTOCOL.test(url.slice(0, colon))
  ) {
    return url;
  }
  return "";
}

function hasScheme(url: string): boolean {
  const colon = url.indexOf(":");
  if (colon === -1) return false;
  const before = url.slice(0, colon);
  return !/[/?#]/.test(before);
}

/** The image URL to keep, or null to block the image. */
export function safeImageUrl(url: string, trust: ContentTrust): string | null {
  const value = url.trim();
  // Exactly the renderer's previous urlTransform for src (markdown-renderer.tsx).
  if (trust === "local") return SAFE_DATA_IMAGE.test(url) ? url : safeLinkUrl(url);
  if (/^https:\/\//i.test(value)) return url;
  if (SHARED_IMAGE_PATH.test(value)) return url;
  // A relative path resolves to the notebook's asset route; scheme-relative
  // (//host), absolute and backslash paths do not.
  if (value === "" || hasScheme(value) || value.startsWith("/") || value.startsWith("\\")) return null;
  return url;
}

export function isSafeStyle(style: string): boolean {
  return !UNSAFE_STYLE.test(style);
}

function attributeName(key: string, inSvg: boolean): string {
  return find(inSvg ? svgSchema : htmlSchema, key).attribute.toLowerCase();
}

function attributeAllowed(name: string): boolean {
  if (name.startsWith("on")) return false;
  if (name.startsWith("data-") || name.startsWith("aria-")) return /^[a-z0-9_.:-]+$/.test(name);
  return ALLOWED_ATTRIBUTES.has(name);
}

function propertyText(value: Properties[string]): string {
  if (Array.isArray(value)) return value.join(" ");
  return value === null || value === undefined ? "" : String(value);
}

function blockedImage(node: Element): Element {
  const alt = propertyText(node.properties.alt).trim();
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: ["markdown-blocked-image"],
      title: "Image not shown: shared notebooks show only https images and their own files.",
    },
    children: [{ type: "text", value: alt ? `[${alt}]` : "[image]" }],
  };
}

/** Cleans one element in place; returns its replacement, or null to drop it, or "unwrap". */
function cleanElement(node: Element, inSvg: boolean, trust: ContentTrust): Element | null | "unwrap" {
  const tag = node.tagName.toLowerCase();
  if (DROP_WITH_CONTENT.has(tag)) return null;
  if (!ALLOWED_ELEMENTS.has(tag)) return "unwrap";
  // Inside <svg> only KaTeX's drawing elements (no svg <a>, no HTML).
  if (inSvg && !SVG_ELEMENTS_SET.has(tag)) return "unwrap";
  if (tag === "input") {
    // Task-list checkboxes only.
    if (propertyText(node.properties.type).toLowerCase() !== "checkbox") return null;
  }
  const properties: Properties = {};
  for (const [key, value] of Object.entries(node.properties)) {
    // `false` stays: it renders as no attribute, and keeps the tree identical.
    if (value === undefined || value === null) continue;
    const name = attributeName(key, inSvg);
    if (!attributeAllowed(name)) continue;
    if (name === "href") {
      if (tag !== "a") continue;
      properties[key] = safeLinkUrl(propertyText(value));
      continue;
    }
    if (name === "src") {
      if (tag !== "img") continue;
      const safe = safeImageUrl(propertyText(value), trust);
      if (safe === null) return blockedImage(node);
      properties[key] = safe;
      continue;
    }
    if (name === "target") {
      // Links may open a new window, never a named or parent frame.
      if (tag === "a" && propertyText(value) === "_blank") properties[key] = value;
      continue;
    }
    if (name === "style") {
      if (isSafeStyle(propertyText(value))) properties[key] = value;
      continue;
    }
    if ((name === "type" && tag !== "input" && tag !== "ol" && tag !== "li") || (name === "value" && tag !== "li")) continue;
    properties[key] = value;
  }
  if (tag === "img" && properties.src === undefined && trust === "shared") return blockedImage(node);
  node.properties = properties;
  return node;
}

function cleanChildren(parent: Parents, inSvg: boolean, trust: ContentTrust): void {
  const output: RootContent[] = [];
  for (const child of parent.children as RootContent[]) {
    switch (child.type) {
      case "text":
        output.push(child);
        break;
      case "raw":
        // Raw HTML from Markdown is never interpreted: shown as text, as react-markdown does.
        output.push({ type: "text", value: child.value });
        break;
      case "element": {
        const svg = inSvg || child.tagName.toLowerCase() === "svg";
        const cleaned = cleanElement(child, svg, trust);
        if (cleaned === null) break;
        if (cleaned === "unwrap") {
          cleanChildren(child, svg, trust);
          output.push(...(child.children as RootContent[]));
          break;
        }
        if (cleaned === child) cleanChildren(child, svg, trust);
        output.push(cleaned);
        break;
      }
      default:
        // comment, doctype: nothing to show.
        break;
    }
  }
  (parent as { children: RootContent[] }).children = output;
}

/** Sanitizes a hast tree in place and returns it. */
export function sanitizeHast<T extends Root | Element>(tree: T, options: SanitizeOptions = {}): T {
  cleanChildren(tree, tree.type === "element" && tree.tagName.toLowerCase() === "svg", options.trust ?? "local");
  return tree;
}

/** rehype plugin: `.use(rehypeLiberaSanitize, { trust })` after every plugin that adds elements. */
export function rehypeLiberaSanitize(options: SanitizeOptions = {}) {
  return (tree: Root) => {
    sanitizeHast(tree, options);
  };
}

// ---------------------------------------------------------------- HTML strings

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/ /g, "&nbsp;");
}

function serializeAttributes(node: Element, inSvg: boolean): string {
  let output = "";
  for (const [key, value] of Object.entries(node.properties)) {
    if (value === undefined || value === null || value === false) continue;
    const info = find(inSvg ? svgSchema : htmlSchema, key);
    if (value === true) {
      output += ` ${info.attribute}=""`;
      continue;
    }
    const text = Array.isArray(value) ? value.join(info.commaSeparated ? ", " : " ") : String(value);
    output += ` ${info.attribute}="${escapeAttribute(text)}"`;
  }
  return output;
}

function serialize(nodes: readonly (RootContent | ElementContent)[], inSvg: boolean): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") output += escapeText(node.value);
    else if (node.type === "element") {
      const svg = inSvg || node.tagName === "svg";
      output += `<${node.tagName}${serializeAttributes(node, svg)}>`;
      if (VOID_ELEMENTS.has(node.tagName) && !svg) continue;
      output += `${serialize(node.children, svg)}</${node.tagName}>`;
    }
  }
  return output;
}

/** Serializes a (sanitized) hast tree to HTML. */
export function hastToHtml(tree: Nodes): string {
  if (tree.type === "root") return serialize(tree.children, false);
  return serialize([tree as RootContent], false);
}

/**
 * Sanitizes an HTML fragment for innerHTML: parsed inertly (DOMParser in the
 * browser, parse5 in Node), cleaned with the same allowlist, serialized back.
 */
export function sanitizeHtmlFragment(html: string, options: SanitizeOptions = {}): string {
  const tree = fromHtmlIsomorphic(html, { fragment: true });
  return hastToHtml(sanitizeHast(tree, options));
}
