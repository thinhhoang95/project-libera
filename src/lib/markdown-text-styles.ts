// Only these numeric presentation attributes are accepted from Markdown HTML.
// Raw HTML remains disabled in the preview.
export function markdownTextStyleAttributes(value: string) {
  const font = /data-font-size="(\d+(?:\.\d+)?)"/.exec(value)?.[1];
  const line = /data-line-height="(\d+(?:\.\d+)?)"/.exec(value)?.[1];
  return {
    fontSize: font && +font >= 8 && +font <= 96 ? `${font}px` : undefined,
    lineHeight: line && +line >= 1 && +line <= 3 ? line : undefined,
  };
}

type AstNode = {
  type?: string;
  value?: string;
  children?: AstNode[];
  data?: { hName: string; hProperties: Record<string, string> };
};

export function remarkMarkdownTextStyles() {
  function transform(node: AstNode) {
    if (!node.children || ["code", "inlineCode", "math", "inlineMath"].includes(node.type ?? "")) return;
    const result: AstNode[] = [];
    const stack: { opener: AstNode; children: AstNode[]; properties: Record<string, string> }[] = [];
    const target = () => stack.at(-1)?.children ?? result;
    for (const child of node.children) {
      if (child.type === "html" && /^<span\s+data-(?:font-size|line-height)=/.test(child.value ?? "")) {
        const styles = markdownTextStyleAttributes(child.value ?? "");
        const properties: Record<string, string> = {};
        if (styles.fontSize) properties["data-font-size"] = styles.fontSize.replace("px", "");
        if (styles.lineHeight) properties["data-line-height"] = styles.lineHeight;
        stack.push({ opener: child, children: [], properties });
      } else if (child.type === "html" && child.value === "</span>" && stack.length) {
        const span = stack.pop()!;
        target().push({ type: "liberaTextStyle", children: span.children, data: { hName: "span", hProperties: span.properties } });
      } else {
        target().push(child);
      }
    }
    while (stack.length) {
      const unclosed = stack.pop()!;
      target().push(unclosed.opener, ...unclosed.children);
    }
    node.children = result;
    result.forEach(transform);
  }
  return transform;
}
