import type { Element } from "hast";
import type { Root, RootContent } from "mdast";
import type { Handler, Handlers } from "mdast-util-to-hast";
import type { Plugin } from "unified";
import type { LiberaCitationNode } from "./remark-citations";

// Citations and the bibliography in rendered Markdown (the "Rendered citation
// DOM" contract in docs/references/lanes.md).
//
// remarkBibliography runs after remarkCitations and the source map. A
// paragraph whose text is exactly `:::bibliography` + newline + `:::` becomes
// a `liberaBibliography` node; without such a marker the node is appended at
// the end when the document cites anything. Only the first marker counts.
//
// citationRehypeHandlers (pass them to remark-rehype) turn the mdast nodes
// into the contract's elements:
//
// - a `liberaCitation` → `<span class="libera-citation"
//   data-libera-citation="RAW">RAW</span>` with its data-source-start/-end,
//   plus `data-libera-narrative=""` for a narrative citation (`@key`).
//   `data-citation` (the parsed citation, JSON) is for the renderer and the
//   preview worker; the chip does not put it in the DOM. Whether a narrative
//   candidate is a citation at all depends on the library, so the chip
//   decides (an unresolved one renders as plain text);
// - a `liberaBibliography` → `<section class="libera-bibliography"
//   data-libera-bibliography="">`, filled by the renderer, with
//   `data-bibliography-placement` ("marker" or "end").
//
// The elements get their final names here rather than custom `libera-*`
// names, because the preview's allowlist sanitizer (markdown-sanitize.ts)
// unwraps unknown elements; it keeps spans, sections, classes and data-*.

export const BIBLIOGRAPHY_MARKER = /^:::bibliography[ \t]*\r?\n[ \t]*:::[ \t]*$/;

export type BibliographyPlacement = "marker" | "end";

export type LiberaBibliographyNode = {
  type: "liberaBibliography";
  placement: BibliographyPlacement;
  position?: Root["position"];
  data: { hName: "libera-bibliography"; hProperties?: Record<string, string> };
};

type TreeNode = {
  type: string;
  value?: string;
  children?: TreeNode[];
  position?: Root["position"];
  data?: { hProperties?: Record<string, unknown> };
};

function sourceProperties(node: TreeNode, keys: string[]) {
  const properties: Record<string, string> = {};
  for (const key of keys) {
    const value = node.data?.hProperties?.[key];
    if (typeof value === "string") properties[key] = value;
  }
  return properties;
}

function bibliographyNode(placement: BibliographyPlacement, from?: TreeNode): LiberaBibliographyNode {
  return {
    type: "liberaBibliography",
    placement,
    position: from?.position,
    data: { hName: "libera-bibliography", hProperties: from ? sourceProperties(from, ["data-source-start", "data-source-end", "data-source-block"]) : {} },
  };
}

function paragraphText(node: TreeNode) {
  if (!node.children?.length || !node.children.every((child) => child.type === "text")) return null;
  return node.children.map((child) => child.value ?? "").join("");
}

/** Place the document's bibliography (see the header). */
export const remarkBibliography: Plugin<[], Root> = function () {
  return (tree) => {
    let citations = 0;
    let marker = false;
    const visit = (parent: TreeNode) => {
      const children = parent.children;
      if (!children) return;
      children.forEach((child, index) => {
        if (child.type === "liberaCitation") {
          citations += 1;
          return;
        }
        if (!marker && child.type === "paragraph") {
          const text = paragraphText(child);
          if (text !== null && BIBLIOGRAPHY_MARKER.test(text)) {
            marker = true;
            children[index] = bibliographyNode("marker", child) as unknown as TreeNode;
            return;
          }
        }
        visit(child);
      });
    };
    visit(tree as unknown as TreeNode);
    if (!marker && citations > 0) tree.children.push(bibliographyNode("end") as unknown as RootContent);
  };
};

const liberaCitation: Handler = (state, node: LiberaCitationNode) => {
  const raw = node.citation?.raw ?? node.value;
  const result: Element = {
    type: "element",
    tagName: "span",
    properties: {
      className: ["libera-citation"],
      "data-libera-citation": raw,
      ...(node.citation?.narrative ? { "data-libera-narrative": "" } : {}),
      "data-citation": JSON.stringify(node.citation),
      ...sourceProperties(node as unknown as TreeNode, ["data-source-start", "data-source-end"]),
    },
    children: [{ type: "text", value: raw }],
  };
  state.patch(node as never, result);
  return result;
};

const liberaBibliography: Handler = (state, node: LiberaBibliographyNode) => {
  const result: Element = {
    type: "element",
    tagName: "section",
    properties: {
      className: ["libera-bibliography"],
      "data-libera-bibliography": "",
      "data-bibliography-placement": node.placement,
      ...(node.data.hProperties ?? {}),
    },
    children: [],
  };
  state.patch(node as never, result);
  return result;
};

/** remark-rehype handlers for citations and the bibliography; every renderer of markdownRemarkPlugins passes them. */
export const citationRehypeHandlers = { liberaCitation, liberaBibliography } as unknown as Handlers;
