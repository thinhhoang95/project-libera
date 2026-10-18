import { Extension, InputRule, Node, type Editor, type NodeViewRenderer, type Range } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { escapedAt } from "./math-markers";
import { CITATION_MAX_LENGTH, citationTriggerAt, parseCitationToken, serializeCitation } from "./references/citation-syntax";
import type { Citation } from "./references/types";

/* Citations in the Visual (TipTap) editor (plan.md §1.3, §4.2, §4.3).
 *
 * A citation is an inline atom node `citation` whose only attribute is `raw`,
 * the exact source token (`[see @a, p. 3]`); the parsed citation is derived
 * from it. Markdown parses into the node through a Marked inline tokenizer
 * that follows the shared grammar (`parseCitationToken`) and the scanner's
 * rules: not escaped, not after `!`, not followed by `(` or `[` (a link or a
 * reference), and never inside link text, code or math. Saving writes `raw`
 * back byte for byte, so a citation is never escaped to `\[@key\]`; an edit
 * from the popover replaces `raw` with `serializeCitation` output.
 *
 * Pasting HTML from the preview reads `span.libera-citation[data-libera-citation]`;
 * typing or pasting a complete `[@key]` in text turns it into a node.
 *
 * The `@` popup uses @tiptap/suggestion, but whether it opens is decided by
 * the shared `citationTriggerAt` on a Markdown rendering of the caret's
 * paragraph, so the three editors agree. The React parts (node view, popover,
 * popup) live in components/libera/references/tiptap-citation-view.tsx. */

export const CITATION_NODE_NAME = "citation";

// ---------------------------------------------------------------------------
// Tokens in text
// ---------------------------------------------------------------------------

/**
 * The citation token starting at `text[index]` (a `[`), or null. `before` is
 * the character before the token when it is not in `text` (a preceding
 * Markdown token). The token must parse with the shared grammar and must not
 * be escaped, follow `!`, or be followed by `(` or `[`.
 */
export function citationTokenAt(text: string, index = 0, before?: string) {
  if (text[index] !== "[") return null;
  const previous = index > 0 ? text[index - 1] : before;
  if (previous === "!" || (index > 0 && escapedAt(text, index))) return null;
  const limit = Math.min(text.length, index + CITATION_MAX_LENGTH);
  for (let end = text.indexOf("]", index + 1); end >= 0 && end < limit; end = text.indexOf("]", end + 1)) {
    const raw = text.slice(index, end + 1);
    if (!parseCitationToken(raw)) continue;
    const next = text[end + 1];
    return next === "(" || next === "[" ? null : raw;
  }
  return null;
}

/** Every citation token in a run of literal text, by the inline rules of `citationTokenAt`. */
export function findTextCitations(text: string) {
  const found: Array<{ start: number; end: number; raw: string }> = [];
  for (let index = text.indexOf("["); index >= 0; index = text.indexOf("[", index + 1)) {
    const raw = citationTokenAt(text, index);
    if (!raw) continue;
    found.push({ start: index, end: index + raw.length, raw });
    index += raw.length - 1;
  }
  return found;
}

/** The parsed citation of a node's `raw` (items empty when it no longer parses). */
export function citationOfNode(node: ProseMirrorNode): Citation {
  const raw = String(node.attrs.raw ?? "");
  return parseCitationToken(raw) ?? { items: [], raw };
}

/** Turns complete citation tokens in pasted text (outside code and links) into citation nodes. */
export function convertLiteralCitations(fragment: Fragment, schema: Schema): Fragment {
  const type = schema.nodes[CITATION_NODE_NAME];
  if (!type) return fragment;
  const result: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.type.spec.code) {
      result.push(node);
      return;
    }
    if (node.isText) {
      const text = node.text ?? "";
      const literal = node.marks.some((mark) => mark.type.spec.code || mark.type.name === "link");
      const tokens = literal || !text.includes("[@") && !text.includes("@") ? [] : findTextCitations(text);
      let last = 0;
      for (const token of tokens) {
        if (token.start > last) result.push(schema.text(text.slice(last, token.start), node.marks));
        result.push(type.create({ raw: token.raw }, null, node.marks));
        last = token.end;
      }
      if (!tokens.length) result.push(node);
      else if (last < text.length) result.push(schema.text(text.slice(last), node.marks));
      return;
    }
    result.push(node.isLeaf ? node : node.copy(convertLiteralCitations(node.content, schema)));
  });
  return Fragment.fromArray(result);
}

// ---------------------------------------------------------------------------
// The `@` trigger in a ProseMirror document
// ---------------------------------------------------------------------------

/** No math markers: TipTap keeps math in its own nodes, so paragraph text never contains math. */
const NO_MATH = { inlineMathMarkers: "", blockMathMarkers: "" };
const OBJECT = "￼";
// Literal text that Markdown would read as code, an escape or HTML is escaped when saved.
const LITERAL = /[`\\<]/g;

export type TiptapCitationTrigger = {
  /** The suggestion range: the `@` and the query after it, or from an open `[` when `insideCitation`. */
  range: Range;
  query: string;
  insideCitation: boolean;
  /** For `insideCitation`: the document text from the `[` to the `@`, e.g. `[see `. */
  open?: string;
};

/**
 * The `@` trigger at a caret, decided by the shared `citationTriggerAt` on the
 * caret's paragraph rendered as Markdown text: one character per position
 * (atoms and code-marked text as U+FFFC, hard breaks as spaces), with
 * characters that saving would escape neutralized. Null inside code blocks,
 * code marks and math (math is an atom, so the caret is never inside it).
 */
export function tiptapCitationTriggerAt($position: ResolvedPos): TiptapCitationTrigger | null {
  const parent = $position.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if ([$position.nodeBefore, $position.nodeAfter].some((node) => node?.isText && node.marks.some((mark) => mark.type.spec.code))) return null;
  const caret = $position.parentOffset;
  // Cheap check first: `@` and key characters just before the caret.
  const before = parent.textBetween(Math.max(0, caret - 260), caret, undefined, OBJECT);
  if (!before.includes("@")) return null;
  let text = "";
  parent.forEach((child) => {
    if (child.isText) text += child.marks.some((mark) => mark.type.spec.code) ? OBJECT.repeat(child.nodeSize) : (child.text ?? "").replace(LITERAL, OBJECT);
    else text += child.type.name === "hardBreak" ? " " : OBJECT.repeat(child.nodeSize);
  });
  // A leading word keeps the paragraph from reading as a heading, list or code block.
  const PREFIX = "x ";
  const trigger = citationTriggerAt(PREFIX + text, PREFIX.length + caret, { mathMarkers: NO_MATH });
  if (!trigger) return null;
  const start = $position.start();
  const at = trigger.from - PREFIX.length;
  if (trigger.insideCitation) {
    // An open `[` typed as text before the `@`: the inserted node covers it.
    let depth = 0;
    for (let index = at - 1; index >= 0 && at - index <= CITATION_MAX_LENGTH; index -= 1) {
      const char = text[index];
      if (char === "]") depth += 1;
      else if (char === "[" && !escapedAt(text, index)) {
        if (depth-- > 0) continue;
        const open = parent.textBetween(index, at, undefined, OBJECT);
        if (!open.includes(OBJECT)) return { range: { from: start + index, to: start + caret }, query: trigger.query, insideCitation: true, open };
        break;
      }
    }
  }
  return { range: { from: start + at, to: start + caret }, query: trigger.query, insideCitation: false };
}

/** The `raw` of the node a popup choice inserts at a trigger. */
export function citationRawForTrigger(trigger: Pick<TiptapCitationTrigger, "insideCitation" | "open">, key: string, pageLocator?: string) {
  // `pageLocator` cites that page: `[@key, p. 12]`.
  const item = pageLocator ? serializeCitation({ items: [{ key, locator: pageLocator, label: "page" }] }).slice(1, -1) : `@${key}`;
  if (trigger.insideCitation && trigger.open !== undefined) {
    const raw = `${trigger.open}${item}]`;
    if (parseCitationToken(raw)) return raw;
  }
  return `[${item}]`;
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

export type CitationNodeOptions = {
  /** The editor's node view (the Visual editor passes a React one); the default renders `renderHTML`. */
  nodeView: NodeViewRenderer | null;
};

export const CitationNode = Node.create<CitationNodeOptions>({
  name: CITATION_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { nodeView: null };
  },

  addAttributes() {
    return {
      raw: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-libera-citation") ?? element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  // `textBetween` and copied plain text read a citation as its source token.
  extendNodeSchema(extension) {
    return extension.name === CITATION_NODE_NAME ? { leafText: (node: ProseMirrorNode) => String(node.attrs.raw ?? "") } : {};
  },

  renderText({ node }) {
    return String(node.attrs.raw ?? "");
  },

  parseHTML() {
    return [{
      tag: "span[data-libera-citation]",
      priority: 100,
      getAttrs: (element) => parseCitationToken((element as HTMLElement).getAttribute("data-libera-citation") ?? "") ? null : false,
    }];
  },

  renderHTML({ node }) {
    const raw = String(node.attrs.raw ?? "");
    return ["span", { class: "libera-citation", "data-libera-citation": raw }, raw];
  },

  addNodeView() {
    return this.options.nodeView;
  },

  markdownTokenName: CITATION_NODE_NAME,
  markdownTokenizer: {
    name: CITATION_NODE_NAME,
    level: "inline",
    // Marked's text rule already stops before every `[`; this keeps runs short.
    start: (src: string) => src.indexOf("["),
    tokenize(src: string, tokens: Array<{ raw?: string }>) {
      // Marked hands extensions each position before its own rules, so a
      // citation is claimed before the link rule can read `[` as a link.
      const raw = citationTokenAt(src, 0, tokens.at(-1)?.raw?.slice(-1));
      return raw ? { type: CITATION_NODE_NAME, raw, tokens: [] } : undefined;
    },
  },
  parseMarkdown(token) {
    return { type: CITATION_NODE_NAME, attrs: { raw: token.raw } };
  },
  renderMarkdown(node) {
    return String(node.attrs?.raw ?? "");
  },

  addInputRules() {
    // Typing the closing `]` of a complete citation turns it into a node.
    return [new InputRule({
      find: (text) => {
        if (!text.endsWith("]")) return null;
        for (let index = text.lastIndexOf("["); index >= 0 && text.length - index <= CITATION_MAX_LENGTH; index = text.lastIndexOf("[", index - 1)) {
          if (citationTokenAt(text, index) === text.slice(index)) return { index, text: text.slice(index) };
          if (index === 0) break;
        }
        return null;
      },
      handler: ({ state, range, match }) => {
        const raw = match[0];
        const $from = state.doc.resolve(range.from);
        if ($from.marks().some((mark) => mark.type.name === "link")) return null;
        state.tr.replaceWith(range.from, range.to, this.type.create({ raw }, null, $from.marks()));
      },
    })];
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("liberaCitationPaste"),
      props: {
        transformPasted: (slice) => {
          const content = convertLiteralCitations(slice.content, this.editor.schema);
          if (content === slice.content) return slice;
          const maxOpen = Slice.maxOpen(content);
          return new Slice(content, Math.min(slice.openStart, maxOpen.openStart), Math.min(slice.openEnd, maxOpen.openEnd));
        },
      },
    })];
  },
});

/** Replace a citation node's citation (an edit from the popover): `raw` becomes the canonical token. */
export function updateCitationNode(editor: Editor, pos: number, citation: Pick<Citation, "items">) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== CITATION_NODE_NAME) return false;
  const tr = editor.state.tr;
  if (!citation.items.length) tr.delete(pos, pos + node.nodeSize);
  else {
    const raw = serializeCitation(citation);
    if (raw === node.attrs.raw) return false;
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, raw });
  }
  editor.view.dispatch(tr);
  return true;
}

// ---------------------------------------------------------------------------
// The `@` suggestion
// ---------------------------------------------------------------------------

export const citationSuggestionKey = new PluginKey("liberaCitationSuggestion");

export type CitationSuggestionState = {
  trigger: TiptapCitationTrigger;
  clientRect: (() => DOMRect | null) | null;
};

export type CitationSuggestionHandlers = {
  /** The suggestion opened, moved or changed (null: it closed). */
  onChange: (state: CitationSuggestionState | null) => void;
  /** A key while the popup is open; true when the popup used it. */
  onKeyDown: (event: KeyboardEvent) => boolean;
};

/**
 * The `@` popup's suggestion plugin. `findSuggestionMatch` defers to
 * `tiptapCitationTriggerAt`, so code, math, emails and link destinations never
 * open it; the popup itself is rendered by the editor (through `handlers`).
 */
export function createCitationSuggestion(handlers: () => CitationSuggestionHandlers) {
  let current: TiptapCitationTrigger | null = null;
  return Extension.create({
    name: "liberaCitationSuggestion",
    addProseMirrorPlugins() {
      return [Suggestion<never, never>({
        pluginKey: citationSuggestionKey,
        editor: this.editor,
        char: "@",
        allowedPrefixes: null,
        findSuggestionMatch: ({ $position }) => {
          const trigger = tiptapCitationTriggerAt($position);
          current = trigger;
          return trigger ? { range: trigger.range, query: trigger.query, text: $position.doc.textBetween(trigger.range.from, trigger.range.to, undefined, OBJECT) } : null;
        },
        render: () => {
          const publish = (props: SuggestionProps<never, never>) => {
            const trigger = current && current.range.from === props.range.from ? current : tiptapCitationTriggerAt(props.editor.state.doc.resolve(props.range.to));
            handlers().onChange(trigger ? { trigger, clientRect: props.clientRect ?? null } : null);
          };
          return {
            onStart: publish,
            onUpdate: publish,
            onExit: () => handlers().onChange(null),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => handlers().onKeyDown(event),
          };
        },
      })];
    },
  });
}

/** Close the `@` popup without changing the document. */
export function exitCitationSuggestion(editor: Editor) {
  exitSuggestion(editor.view, citationSuggestionKey);
}
