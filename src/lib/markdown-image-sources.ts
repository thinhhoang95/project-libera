import { unified } from "unified";
import remarkParse from "remark-parse";
import { decodeNamedCharacterReference } from "decode-named-character-reference";

type Node = {
  type: string;
  url?: string;
  identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
};
type ImageSource = { source: string; start: number; end: number };
const parser = unified().use(remarkParse);

function decodeAttribute(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (original, entity: string) => {
    if (!entity.startsWith("#")) return decodeNamedCharacterReference(entity) || original;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}

/** Locate the destination without changing alt text, titles or surrounding Markdown. */
function destinationRange(text: string, definition: boolean) {
  let index = definition ? 1 : 2;
  let brackets = 1;
  for (; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === "[") brackets++;
    else if (text[index] === "]" && --brackets === 0) break;
  }
  index += 2; // `]:` for a definition, `](` for an inline image.
  while (/\s/.test(text[index] ?? "") && index < text.length) index++;
  const angle = text[index] === "<";
  const start = angle ? ++index : index;
  let parentheses = 0;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") { index++; continue; }
    if (angle) { if (char === ">") break; }
    else if (/\s/.test(char) || (char === ")" && parentheses === 0)) break;
    else if (char === "(") parentheses++;
    else if (char === ")") parentheses--;
  }
  return { start, end: index };
}

function imageOccurrences(markdown: string): ImageSource[] {
  const root = parser.parse(markdown) as Node;
  const definitions = new Map<string, Node>();
  const occurrences: ImageSource[] = [];
  function walk(node: Node, visit: (node: Node) => void) {
    visit(node);
    node.children?.forEach((child) => walk(child, visit));
  }
  walk(root, (node) => {
    if (node.type === "definition" && node.identifier && !definitions.has(node.identifier.toUpperCase())) {
      definitions.set(node.identifier.toUpperCase(), node);
    }
  });
  walk(root, (node) => {
    const target = node.type === "image" ? node
      : node.type === "imageReference" && node.identifier ? definitions.get(node.identifier.toUpperCase()) : undefined;
    if (target?.url && target.position) {
      const offset = target.position.start.offset ?? 0;
      const range = destinationRange(markdown.slice(offset, target.position.end.offset), target.type === "definition");
      occurrences.push({ source: target.url, start: offset + range.start, end: offset + range.end });
    }
    if (node.type === "html" && node.position) {
      const offset = node.position.start.offset ?? 0;
      const html = markdown.slice(offset, node.position.end.offset);
      const tags = /<!--[\s\S]*?-->|<(script|style|pre|code)\b[\s\S]*?<\/\1\s*>|<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
      for (const tag of html.matchAll(tags)) {
        if (!/^<img\b/i.test(tag[0])) continue;
        const attributes = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        for (const attribute of tag[0].slice(4).matchAll(attributes)) {
          if (attribute[1].toLowerCase() !== "src" || !attribute[0].includes("=")) continue;
          const raw = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
          const valueOffset = attribute.index! + attribute[0].indexOf("=") + 1;
          const prefix = attribute[0].slice(attribute[0].indexOf("=") + 1).match(/^\s*["']?/)![0];
          const start = offset + tag.index! + 4 + valueOffset + prefix.length;
          occurrences.push({ source: decodeAttribute(raw), start, end: start + raw.length });
          break;
        }
      }
    }
  });
  return occurrences;
}

/** Includes reference images and HTML images, and excludes code examples. */
export function markdownImageSources(markdown: string) {
  return [...new Set(imageOccurrences(markdown).map((image) => image.source))];
}

export function rewriteMarkdownImageSources(markdown: string, sources: Record<string, string>) {
  if (!Object.keys(sources).length) return markdown;
  const edits = new Map<number, ImageSource>();
  for (const image of imageOccurrences(markdown)) {
    if (Object.hasOwn(sources, image.source)) edits.set(image.start, image);
  }
  for (const image of [...edits.values()].sort((a, b) => b.start - a.start)) {
    markdown = markdown.slice(0, image.start) + sources[image.source] + markdown.slice(image.end);
  }
  return markdown;
}
