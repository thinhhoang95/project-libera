import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export type MarkdownHeadingAnchor = {
  level: number;
  line: number;
  offset: number;
  slug: string;
  text: string;
};

type MarkdownAstNode = {
  children?: MarkdownAstNode[];
  depth?: number;
  position?: { start?: { line?: number; offset?: number } };
  type?: string;
  value?: string;
};

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function nodeText(node: MarkdownAstNode): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "inlineMath") {
    return node.value ?? "";
  }

  return node.children?.map(nodeText).join("") ?? "";
}

// GitHub-compatible heading slugs, so anchors written for GitHub, VS Code or
// other Markdown tools resolve here too.
export function slugifyMarkdownHeading(text: string) {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Returns a slug function that suffixes repeated titles with -1, -2, … like GitHub. */
export function createMarkdownHeadingSlugger() {
  const used = new Map<string, number>();

  return (text: string) => {
    const base = slugifyMarkdownHeading(text);
    let slug = base;
    let count = used.get(base) ?? 0;

    while (used.has(slug)) {
      count += 1;
      slug = `${base}-${count}`;
    }

    used.set(base, count);
    if (!used.has(slug)) used.set(slug, 0);
    return slug;
  };
}

export function markdownHeadingAnchors(markdown: string): MarkdownHeadingAnchor[] {
  const anchors: MarkdownHeadingAnchor[] = [];
  const slugger = createMarkdownHeadingSlugger();

  function visit(node: MarkdownAstNode) {
    const offset = node.position?.start?.offset;

    if (node.type === "heading" && typeof offset === "number") {
      const text = nodeText(node).replace(/\s+/g, " ").trim();
      const slug = slugger(text);

      if (text) {
        anchors.push({
          level: node.depth ?? 1,
          line: node.position?.start?.line ?? 1,
          offset,
          slug,
          text,
        });
      }
      return;
    }

    node.children?.forEach(visit);
  }

  visit(parser.parse(markdown) as MarkdownAstNode);
  return anchors;
}

export function markdownHeadingHref(anchor: Pick<MarkdownHeadingAnchor, "slug">) {
  return `#${encodeURI(anchor.slug)}`;
}

export function decodeMarkdownHeadingHash(hash: string) {
  const value = hash.replace(/^#/, "");

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Finds the heading a `#fragment` points to; also accepts the heading text itself. */
export function findMarkdownHeadingAnchorIndex(anchors: MarkdownHeadingAnchor[], hash: string) {
  const fragment = decodeMarkdownHeadingHash(hash);

  if (!fragment) {
    return -1;
  }

  const exact = anchors.findIndex((anchor) => anchor.slug === fragment);
  const normalized = slugifyMarkdownHeading(fragment);

  return exact >= 0 ? exact : anchors.findIndex((anchor) => anchor.slug === normalized);
}

export function findMarkdownHeadingAnchor(markdown: string, hash: string) {
  const anchors = markdownHeadingAnchors(markdown);

  return anchors[findMarkdownHeadingAnchorIndex(anchors, hash)] ?? null;
}

export function filterMarkdownHeadingAnchors(anchors: MarkdownHeadingAnchor[], query: string) {
  const normalized = query.replace(/^#/, "").trim().toLocaleLowerCase();

  if (!normalized) {
    return anchors;
  }

  return anchors.filter(
    (anchor) =>
      anchor.text.toLocaleLowerCase().includes(normalized) ||
      anchor.slug.includes(normalized),
  );
}
