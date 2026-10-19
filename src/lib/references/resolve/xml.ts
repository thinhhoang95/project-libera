// Just enough XML reading for the arXiv Atom feed and PubMed efetch: the
// elements these services emit are flat and well formed, so a full parser
// (which Libera does not ship) is not needed.

function escapeTag(tag: string) {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Entities decoded, tags removed, whitespace collapsed. */
export function xmlToText(xml: string) {
  return decodeXmlEntities(xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export function decodeXmlEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

export type XmlElement = { attributes: Record<string, string>; inner: string };

function parseAttributes(open: string) {
  const attributes: Record<string, string> = {};
  for (const match of open.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

/** Every `<tag …>…</tag>` (and self-closing `<tag …/>`) in `xml`, outermost first. Same-name nesting is not supported. */
export function xmlElements(xml: string, tag: string): XmlElement[] {
  const name = escapeTag(tag);
  const pattern = new RegExp(`<${name}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`, "g");
  return [...xml.matchAll(pattern)].map((match) => ({ attributes: parseAttributes(match[1] ?? ""), inner: match[2] ?? "" }));
}

/** The text of the first `<tag>`, or undefined. */
export function xmlText(xml: string, tag: string) {
  const element = xmlElements(xml, tag)[0];
  if (!element) return undefined;
  const text = xmlToText(element.inner);
  return text || undefined;
}
