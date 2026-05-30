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

  if (BLOCKQUOTE_REGEX.test(line)) {
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
