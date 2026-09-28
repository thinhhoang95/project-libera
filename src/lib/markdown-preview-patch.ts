import type { Root } from 'hast';

export type PreviewSourcePosition = { id: string; start: string; end: string };
type Node = Root['children'][number];

// Position metadata changes independently of the rendered content. Keep exact
// current source coordinates without invalidating every later React subtree.
export function previewContentSignature(node: Node) {
  return JSON.stringify(node, (key, value) =>
    key === 'position' || key === 'data-source-start' || key === 'data-source-end' || key === 'data-preview-source-id' ? undefined : value);
}

export function createMarkdownPreviewCache() {
  let sequence = 0;
  let previous: { id: string; signature: string }[] = [];
  return {
    patch(tree: Root) {
      const available = new Map<string, number[]>();
      previous.forEach((entry, index) => {
        const indexes = available.get(entry.signature) ?? [];
        indexes.push(index);
        available.set(entry.signature, indexes);
      });
      const cursors = new Map<string, number>();
      const sources: PreviewSourcePosition[] = [];
      const next: typeof previous = [];
      const children = tree.children.map((node): Node | number => {
        const signature = previewContentSignature(node);
        const cursor = cursors.get(signature) ?? 0;
        const oldIndex = available.get(signature)?.[cursor];
        cursors.set(signature, cursor + 1);
        const id = oldIndex === undefined ? `b${++sequence}` : previous[oldIndex].id;
        next.push({ id, signature });
        let sourceIndex = 0;
        function indexSources(current: Node) {
          if (current.type === 'element') {
            const start = current.properties['data-source-start'];
            const end = current.properties['data-source-end'];
            if (start !== undefined && end !== undefined) {
              const sourceId = `${id}:${sourceIndex++}`;
              sources.push({ id: sourceId, start: String(start), end: String(end) });
              // Only new nodes cross the boundary. Reused nodes keep these IDs.
              if (oldIndex === undefined) current.properties['data-preview-source-id'] = sourceId;
            }
            current.children.forEach(indexSources);
          }
        }
        indexSources(node);
        return oldIndex === undefined ? node : oldIndex;
      });
      previous = next;
      return { children, sources };
    },
  };
}
