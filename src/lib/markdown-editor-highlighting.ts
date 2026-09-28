import { MARKDOWN_BOX_PREFIX } from "./markdown-boxes";

export type MarkdownEditorLineTone =
  | "blockquote"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "heading-4";

export type MarkdownEditorHighlightState = {
  fenceLength?: number;
  fenceMarker?: "`" | "~";
  inFencedCodeBlock: boolean;
};

type MarkdownEditorLineHighlight = {
  nextState: MarkdownEditorHighlightState;
  tone?: MarkdownEditorLineTone;
};

const FENCE_REGEX = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE_REGEX = /^(?: {4}|\t)/;
const BLOCKQUOTE_REGEX = /^ {0,3}>/;
const HEADING_REGEX = /^ {0,3}(#{1,6})(?:\s|$)/;

export function initialMarkdownEditorHighlightState(): MarkdownEditorHighlightState {
  return {
    inFencedCodeBlock: false,
  };
}

function getFence(line: string) {
  const match = line.match(FENCE_REGEX);

  if (!match) {
    return;
  }

  const fence = match[1];

  return {
    length: fence.length,
    marker: fence[0] as "`" | "~",
  };
}

function getHeadingTone(line: string): MarkdownEditorLineTone | undefined {
  const match = line.match(HEADING_REGEX);
  const level = match?.[1]?.length;

  if (level === 1) {
    return "heading-1";
  }

  if (level === 2) {
    return "heading-2";
  }

  if (level === 3) {
    return "heading-3";
  }

  if (level && level >= 4 && level <= 6) {
    return "heading-4";
  }
}

export function getMarkdownEditorLineHighlight(
  line: string,
  state: MarkdownEditorHighlightState,
): MarkdownEditorLineHighlight {
  const fence = getFence(line);

  if (state.inFencedCodeBlock) {
    if (
      fence &&
      fence.marker === state.fenceMarker &&
      fence.length >= (state.fenceLength ?? 3)
    ) {
      return {
        nextState: initialMarkdownEditorHighlightState(),
      };
    }

    return {
      nextState: state,
    };
  }

  if (fence) {
    return {
      nextState: {
        fenceLength: fence.length,
        fenceMarker: fence.marker,
        inFencedCodeBlock: true,
      },
    };
  }

  if (INDENTED_CODE_REGEX.test(line)) {
    return {
      nextState: state,
    };
  }

  if (BLOCKQUOTE_REGEX.test(line) || MARKDOWN_BOX_PREFIX.test(line)) {
    return {
      nextState: state,
      tone: "blockquote",
    };
  }

  return {
    nextState: state,
    tone: getHeadingTone(line),
  };
}

export type MarkdownEditorCachedLine = MarkdownEditorLineHighlight & { text: string };
const sameState = (a: MarkdownEditorHighlightState, b: MarkdownEditorHighlightState) =>
  a.inFencedCodeBlock === b.inFencedCodeBlock && a.fenceLength === b.fenceLength && a.fenceMarker === b.fenceMarker;

// Retain line identities across insertions/deletions. Only tokenize changed
// lines and the suffix whose incoming fence state has actually changed.
export function createMarkdownEditorLineIndex() {
  let value: string | undefined;
  let lines: MarkdownEditorCachedLine[] = [];
  return {
    update(nextValue: string) {
      if (value === nextValue) return lines;
      const text = nextValue.split('\n');
      let prefix = 0, suffix = 0;
      while (prefix < text.length && prefix < lines.length && text[prefix] === lines[prefix].text) prefix++;
      while (suffix < text.length - prefix && suffix < lines.length - prefix && text[text.length - 1 - suffix] === lines[lines.length - 1 - suffix].text) suffix++;
      const next = lines.slice(0, prefix);
      let state = next.at(-1)?.nextState ?? initialMarkdownEditorHighlightState();
      for (let i = prefix; i < text.length; i++) {
        const oldIndex = i - text.length + lines.length;
        if (i >= text.length - suffix && sameState(state, lines[oldIndex - 1]?.nextState ?? initialMarkdownEditorHighlightState())) {
          for (let j = oldIndex; j < lines.length; j++) next.push(lines[j]);
          break;
        }
        const line = { text: text[i], ...getMarkdownEditorLineHighlight(text[i], state) };
        next.push(line);
        state = line.nextState;
      }
      value = nextValue;
      lines = next;
      return lines;
    },
  };
}
