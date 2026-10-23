import type { Element, ElementContent, Root, RootContent } from "hast";

/**
 * Bold text that opens a paragraph or list item ("**Term:** explanation",
 * "- **Step one** …", "1. **Setup** …") is a lead-in. It gets this class so
 * globals.css can give it the heading accent from Preferences → Markdown.
 */
export const LEAD_IN_CLASS = "libera-lead-in";

function isBlank(node: ElementContent) {
  return node.type === "comment" || (node.type === "text" && !node.value.trim());
}

/** The first child that shows text; a task list's checkbox is skipped. */
function firstContent(element: Element) {
  return element.children.find((child) =>
    !isBlank(child) && !(child.type === "element" && child.tagName === "input"));
}

function markLeadIns(node: Root | RootContent) {
  if (node.type !== "root" && node.type !== "element") return;
  if (node.type === "element" && (node.tagName === "p" || node.tagName === "li")) {
    const first = firstContent(node);
    if (first?.type === "element" && first.tagName === "strong") {
      const className = first.properties.className;
      const classes = Array.isArray(className) ? className : typeof className === "string" ? className.split(" ") : [];
      if (!classes.includes(LEAD_IN_CLASS)) first.properties.className = [...classes, LEAD_IN_CLASS];
    }
  }
  for (const child of node.children) markLeadIns(child);
}

/** Rehype plugin for rendered Markdown; runs after sanitizing. */
export function rehypeBoldLeadIns() {
  return (tree: Root) => markLeadIns(tree);
}
