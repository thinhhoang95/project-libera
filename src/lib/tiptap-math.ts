import { InputRule } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics';
import { mathMarkerPairs, matchMath, escapedAt, type MathMarkerSettings } from './math-markers';

export function createMathExtensions(settings: MathMarkerSettings = {}) {
  const pairs = mathMarkerPairs(settings);
  return [InlineMath, BlockMath].map((extension, index) => {
    const display = index === 1;
    const name = display ? 'blockMath' : 'inlineMath';
    const relevant = pairs.filter(pair => pair.display === display);
    return extension.extend({
      addAttributes() {
        return { ...this.parent?.(), mathOpen: { default: null }, mathClose: { default: null } };
      },
      parseMarkdown(token) {
        return { type: name, attrs: { latex: token.latex, mathOpen: token.open, mathClose: token.close } };
      },
      renderMarkdown(node) {
        const open = node.attrs?.mathOpen ?? relevant[0]?.open ?? (display ? '$$' : '$');
        const close = node.attrs?.mathClose ?? relevant[0]?.close ?? open;
        return display ? `${open}\n${node.attrs?.latex ?? ''}\n${close}` : `${open}${node.attrs?.latex ?? ''}${close}`;
      },
      markdownTokenizer: {
        name, level: display ? 'block' : 'inline',
        start(source) {
          for (let i = 0; i < source.length; i++) {
            if (display && i > 0 && source[i - 1] !== '\n') continue;
            if (matchMath(source.slice(i), pairs, display)) return i;
          }
          return -1;
        },
        tokenize(source) {
          const match = matchMath(source, pairs, display);
          if (match) return { type: name, ...match };
        },
      },
      addProseMirrorPlugins() {
        if (display) return this.parent?.() ?? [];
        return [...(this.parent?.() ?? []), new Plugin({ props: {
          transformPasted: slice => {
            const schema = this.editor.schema;
            function convert(fragment: Fragment): Fragment {
              const result: ProseMirrorNode[] = [];
              fragment.forEach(node => {
                if (node.type.spec.code || node.marks.some(mark => mark.type.spec.code)) { result.push(node); return; }
                if (node.isText) {
                  const text = node.text!;
                  let start = 0;
                  for (let i = 0; i < text.length; i++) {
                    if (escapedAt(text, i)) continue;
                    const match = matchMath(text.slice(i), pairs, false);
                    if (!match) continue;
                    if (i > start) result.push(schema.text(text.slice(start, i), node.marks));
                    result.push(schema.nodes.inlineMath.create({ latex: match.latex, mathOpen: match.open, mathClose: match.close }, null, node.marks));
                    i += match.raw.length - 1;
                    start = i + 1;
                  }
                  if (start < text.length) result.push(schema.text(text.slice(start), node.marks));
                } else if (node.type.name === 'paragraph' && node.content.content.every(child => child.isText || child.type.name === 'hardBreak')) {
                  const text = node.textBetween(0, node.content.size, '', '\n');
                  const block = matchMath(text, pairs, true);
                  if (block && block.raw.length === text.trimEnd().length) {
                    result.push(schema.nodes.blockMath.create({ latex: block.latex, mathOpen: block.open, mathClose: block.close }));
                  } else result.push(node.copy(convert(node.content)));
                } else result.push(node.copy(convert(node.content)));
              });
              return Fragment.fromArray(result);
            }
            const content = convert(slice.content);
            // Math atoms cannot retain the open paragraph depth of an HTML slice.
            const maxOpen = Slice.maxOpen(content);
            return new Slice(content, Math.min(slice.openStart, maxOpen.openStart), Math.min(slice.openEnd, maxOpen.openEnd));
          },
        } })];
      },
      addInputRules() {
        return [new InputRule({
          find: text => {
            for (let i = 0; i < text.length; i++) {
              if (display && i !== 0) break;
              if (escapedAt(text, i) || (i > 0 && text[i] === '$' && text[i - 1] === '$')) continue;
              const match = matchMath(text.slice(i), pairs, display);
              if (match && i + match.raw.length === text.length) return { index: i, text: match.raw, data: match };
            }
            return null;
          },
          handler: ({ state, range, match }) => {
            const parsed = matchMath(match[0], pairs, display);
            if (!parsed) return;
            const node = this.type.create({ latex: parsed.latex, mathOpen: parsed.open, mathClose: parsed.close });
            if (display) {
              const from = state.doc.resolve(range.from);
              if (from.parent.isTextblock && range.from === from.start() && range.to === from.end() && from.node(-1).canReplaceWith(from.index(-1), from.indexAfter(-1), this.type)) {
                state.tr.replaceWith(from.before(), from.after(), node);
                return;
              }
              return null;
            }
            state.tr.replaceWith(range.from, range.to, node);
          },
        })];
      },
    });
  });
}
