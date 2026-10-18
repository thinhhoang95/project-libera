import type { Root } from "mdast";
import type { Plugin } from "unified";
import { citationFrontMatterEnd } from "./references/citation-syntax";

// YAML front matter is metadata (a document's `citation-style`, say), not
// content. Markdown reads it as a thematic break and a setext heading, so the
// preview and the PDF export would show `citation-style: ieee` as a heading.
// This drops the blocks that lie inside front matter, as the citation scanner
// already skips it. Front matter counts only when its first line looks like
// a YAML key (`key: value`), so a `---` + heading + `---` written as Markdown
// keeps rendering as it did.

const YAML_KEY = /^[ \t]*[A-Za-z_][\w.-]*[ \t]*:(?:[ \t]|$)/;

/** End offset of front matter that looks like YAML, or 0. */
export function yamlFrontMatterEnd(source: string) {
  const end = citationFrontMatterEnd(source);
  if (!end) return 0;
  const first = source.slice(0, end).split(/\r\n|\r|\n/).slice(1, -1).find((line) => line.trim());
  return first === undefined || YAML_KEY.test(first) ? end : 0;
}

function hideFrontMatter(tree: Root, source: string | null) {
  if (!source?.startsWith("---")) return;
  const end = yamlFrontMatterEnd(source);
  if (end) tree.children = tree.children.filter((node) => (node.position?.end.offset ?? Infinity) > end);
}

/**
 * Remove the rendered blocks of YAML front matter (see the header). Use after
 * remark-parse, so the source is at hand (as remark-citations does);
 * otherwise it is read from the file.
 */
export const remarkHideFrontMatter: Plugin<[], Root> = function () {
  const parse = this.parser;
  if (parse) {
    this.parser = (document, file) => {
      const tree = parse(document, file) as Root;
      hideFrontMatter(tree, String(document));
      return tree;
    };
    return;
  }
  return (tree, file) => hideFrontMatter(tree, typeof file.value === "string" ? file.value : null);
};
