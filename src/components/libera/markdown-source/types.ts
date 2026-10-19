import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";
import type {
  MarkdownFileLinkRange,
  MarkdownFileLinkSelection,
  MarkdownImageSelection,
  OpenTab,
} from "@/components/libera/types";
import type { LiberaFileNode } from "@/lib/types";
import type { MathMarkerSettings } from "@/lib/math-markers";

/** The textarea editor's props (markdown-editor.tsx), unchanged, so the
 * workspace can mount either editor with the same callbacks, plus the seam the
 * collaboration binding needs. */
export type MarkdownSourceEditorProps = {
  activeFilePath?: string;
  files: LiberaFileNode[];
  formatting: boolean;
  fontFamily: string;
  fontSizePx: number;
  imageConverting: boolean;
  lineHeightPx: number;
  mathMarkers?: MathMarkerSettings;
  openTabs?: OpenTab[];
  smartPaste?: boolean;
  readOpenTabs?: () => OpenTab[];
  recentFiles: LiberaFileNode[];
  /** Receives a textarea-compatible adapter (see textarea-adapter.ts). */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onAiFormatSelection: (selection: { start: number; end: number }) => Promise<void>;
  onAiImageToMarkdown: (image: MarkdownImageSelection) => Promise<void>;
  onAiRewriteSelection: (selection: { start: number; end: number }, prompt: string) => Promise<void>;
  onAiWriteAt: (offset: number, prompt: string) => Promise<void>;
  onChange: (value: string) => void;
  onRegisterDraft?: (read: () => string) => () => void;
  onInsertFileLink: (selection: MarkdownFileLinkSelection, range?: MarkdownFileLinkRange) => void;
  onInsertImageFile: (file: File, selection?: { end: number; start: number }) => Promise<void>;
  onSelectionChange?: (selection: { end: number; start: number }) => void;

  /** Extra CodeMirror extensions, for example a y-codemirror.next binding.
   * Changing the array reconfigures them in place. */
  extensions?: Extension[];
  /**
   * "value" (default): `value` is the document. Outside changes are applied as
   * minimal diffs, and edits are published after a 250 ms pause.
   *
   * "external": an injected extension owns the content. `value` is only the
   * initial text and, afterwards, an intent: a new value is diffed against the
   * last published draft and rebased onto the current document, and a change
   * that would rewrite the whole document is refused. Every change, local or
   * injected, is still published through `onChange` as a derived draft.
   *
   * Fixed for the editor's lifetime; remount (key) to switch.
   */
  documentSource?: "value" | "external";
  /** Called with the view once it exists, and with null before it is destroyed. */
  onViewChange?: (view: EditorView | null) => void;
};
