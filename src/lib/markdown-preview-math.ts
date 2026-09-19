import { unified } from 'unified';
import rehypeKatex from 'rehype-katex';
import type { Element, Root, RootContent } from 'hast';
import { previewContentSignature } from './markdown-preview-patch';

const mathProcessor = unified().use(rehypeKatex);
const rendered = new Map<string, RootContent[]>();
let cachedCharacters = 0;
function isMath(node: RootContent): boolean {
  if (node.type !== 'element') return false;
  const classes = node.properties.className;
  return Array.isArray(classes) && classes.some((name) => ['language-math', 'math-display', 'math-inline'].includes(String(name)));
}

// Delegate all syntax/error handling to the same rehype-katex transformer used
// by the regular renderer. Only its immutable output is cached, with a bound.
export function cachedPreviewMath() {
  return (tree: Root) => {
    function visit(parent: Root | Element) {
      for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        const preMath = child.type === 'element' && child.tagName === 'pre' && child.children.some((node) =>
          node.type === 'element' && node.tagName === 'code' && Array.isArray(node.properties.className) && node.properties.className.includes('language-math'));
        if (isMath(child) || preMath) {
          const key = previewContentSignature(child);
          let result = rendered.get(key);
          if (!result) {
            const output = mathProcessor.runSync({ type: 'root', children: [structuredClone(child)] }) as Root;
            result = output.children;
            const size = key.length + JSON.stringify(result).length;
            if (size <= 1_000_000) {
              rendered.set(key, result);
              cachedCharacters += size;
              while (rendered.size > 256 || cachedCharacters > 4_000_000) {
                const oldest = rendered.keys().next().value!;
                cachedCharacters -= oldest.length + JSON.stringify(rendered.get(oldest)).length;
                rendered.delete(oldest);
              }
            }
          }
          // Consumers may annotate or sanitize trees; never expose the cache.
          const children = structuredClone(result);
          parent.children.splice(i, 1, ...children as Element['children']);
          i += children.length - 1;
        } else if (child.type === 'element') visit(child);
      }
    }
    visit(tree);
  };
}
