"use client";

import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mathMarkerPairs, preferredMathMarkerPair, type MathMarkerPair, type MathMarkerSettings } from "@/lib/math-markers";
import { createAnnotationMarkdownExtensions } from "@/lib/pdf-annotation-markdown";
import { convertLiteralMath } from "@/lib/tiptap-math";

// Serializing Markdown walks the whole document; coalesce it while typing.
const CHANGE_DEBOUNCE_MS = 160;

export type NoteCaret = { x: number; y: number };

export type PdfNoteEditorHandle = {
  getMarkdown: () => string;
  /** Takes in text that changed outside this editor (a collaborator's). */
  adoptMarkdown: (markdown: string) => void;
};

type PdfNoteEditorProps = {
  caret?: NoteCaret;
  documentPath: string;
  handleRef: RefObject<PdfNoteEditorHandle | null>;
  initialMarkdown: string;
  mathMarkers?: MathMarkerSettings;
  onChange: (markdown: string) => void;
  onEscape: () => void;
};

/**
 * Clicking a typeset equation swaps it back to its delimited source, with the
 * LaTeX selected, so it can be edited in place.
 */
function unwrapMath(view: EditorView, node: ProseMirrorNode, pos: number, mathMarkers?: MathMarkerSettings) {
  const display = node.type.name === "blockMath";
  const latex = String(node.attrs.latex ?? "");
  const preferred = preferredMathMarkerPair(mathMarkers, display);
  const open = node.attrs.mathOpen ?? preferred?.open ?? (display ? "$$" : "$");
  const close = node.attrs.mathClose ?? preferred?.close ?? open;
  const { schema } = view.state;
  let replacement: ProseMirrorNode;
  let latexStart: number;

  if (display) {
    // Markers on their own lines, as the Markdown source has them.
    const lines = [open, ...latex.split("\n"), close];
    const content = lines.flatMap((line, index) => [
      ...(index ? [schema.nodes.hardBreak.create()] : []),
      ...(line ? [schema.text(line)] : []),
    ]);
    replacement = schema.nodes.paragraph.create(null, content);
    // Inside the paragraph, past the opening marker and its line break.
    latexStart = pos + 1 + open.length + 1;
  } else {
    replacement = schema.text(`${open}${latex}${close}`, node.marks);
    latexStart = pos + open.length;
  }

  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, replacement);
  const latexEnd = display ? latexStart + latex.length + latex.split("\n").length - 1 : latexStart + latex.length;
  tr.setSelection(TextSelection.create(tr.doc, latexStart, latexEnd));
  view.dispatch(tr);
  view.focus();
}

/**
 * Serializes the note. Equation source left as text (an equation being edited)
 * would be escaped by the Markdown serializer, so it is typeset first.
 */
function noteMarkdown(editor: Editor, pairs: MathMarkerPair[]) {
  const { doc } = editor.state;
  const typeset = doc.copy(convertLiteralMath(doc.content, editor.schema, pairs));

  return editor.markdown ? editor.markdown.serialize(typeset.toJSON()) : editor.getMarkdown();
}

/** Marks a change that came from collaborators, so it is not sent back as an edit. */
const REMOTE_TEXT_META = "liberaRemoteNoteText";

/**
 * Takes a collaborator's text into the open editor. Only the part that
 * differs is replaced, so the caret and selection map through it and the
 * person typing here keeps their place.
 */
function adoptMarkdown(editor: Editor, markdown: string) {
  if (!editor.markdown) return;
  const next = editor.schema.nodeFromJSON(editor.markdown.parse(markdown));
  const { doc } = editor.state;
  const start = doc.content.findDiffStart(next.content);
  if (start === null) return;
  const end = doc.content.findDiffEnd(next.content);
  if (!end) return;
  let { a: endOld, b: endNew } = end;
  const overlap = start - Math.min(endOld, endNew);
  if (overlap > 0) {
    endOld += overlap;
    endNew += overlap;
  }
  const transaction = editor.state.tr.replace(start, endOld, next.slice(start, endNew));
  transaction.setMeta("addToHistory", false);
  transaction.setMeta(REMOTE_TEXT_META, true);
  editor.view.dispatch(transaction);
}

/**
 * The single live editor for the note being edited. Resting notes are static
 * HTML, so a page full of notes costs no ProseMirror instances; this one does
 * not re-render React on transactions either.
 */
export function PdfNoteEditor({
  caret,
  documentPath,
  handleRef,
  initialMarkdown,
  mathMarkers,
  onChange,
  onEscape,
}: PdfNoteEditorProps) {
  const callbacksRef = useRef({ mathMarkers, onChange, onEscape });
  const pendingRef = useRef<number | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // Mount-time values: later prop changes must not reset the document.
  const [initial] = useState(() => ({ caret, markdown: initialMarkdown }));
  const pairs = useMemo(() => mathMarkerPairs(mathMarkers), [mathMarkers]);
  const pairsRef = useRef(pairs);
  const extensions = useMemo(
    () => [
      ...createAnnotationMarkdownExtensions(documentPath, mathMarkers),
      Placeholder.configure({ placeholder: "Write a note… Markdown and math work" }),
    ],
    [documentPath, mathMarkers],
  );

  useLayoutEffect(() => {
    callbacksRef.current = { mathMarkers, onChange, onEscape };
    pairsRef.current = pairs;
  }, [mathMarkers, onChange, onEscape, pairs]);

  const editor = useEditor({
    extensions,
    content: initial.markdown,
    contentType: "markdown",
    // Only ever mounted in response to user input, never during SSR.
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        "aria-label": "Text annotation",
        "aria-multiline": "true",
        class: "pdf-note-content pdf-note-editor",
        role: "textbox",
      },
      // Plain-text paste (Markdown copied from elsewhere) is parsed as
      // Markdown; rich HTML paste keeps TipTap's default handling.
      handlePaste(_view, event) {
        const data = event.clipboardData;
        const text = data?.getData("text/plain");

        if (!text || data?.types.includes("text/html") || !editorRef.current) {
          return false;
        }

        editorRef.current.commands.insertContent(text, { contentType: "markdown" });
        return true;
      },
      handleClickOn(view, _pos, node, nodePos, _event, direct) {
        if (!direct || (node.type.name !== "inlineMath" && node.type.name !== "blockMath")) {
          return false;
        }

        unwrapMath(view, node, nodePos, callbacksRef.current.mathMarkers);
        return true;
      },
      handleKeyDown(_view, event) {
        // Ctrl+S saves the file: hand over the last keystrokes first, and let it through.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && pendingRef.current !== null && editorRef.current) {
          window.clearTimeout(pendingRef.current);
          pendingRef.current = null;
          callbacksRef.current.onChange(noteMarkdown(editorRef.current, pairsRef.current));
          return false;
        }

        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          callbacksRef.current.onEscape();
          return true;
        }

        return false;
      },
    },
    onUpdate({ editor: updatedEditor, transaction }) {
      if (transaction.getMeta(REMOTE_TEXT_META)) return;
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current);
      }

      pendingRef.current = window.setTimeout(() => {
        pendingRef.current = null;
        callbacksRef.current.onChange(noteMarkdown(updatedEditor, pairsRef.current));
      }, CHANGE_DEBOUNCE_MS);
    },
  });

  useLayoutEffect(() => {
    if (!editor) return;
    let position: number | undefined;
    try {
      const point = initial.caret;
      position = point ? editor.view.posAtCoords({ left: point.x, top: point.y })?.pos : undefined;
    } catch {
      position = undefined;
    }
    // EditorContent has mounted. Focus now: onCreate and commands.focus defer
    // to a timer/frame, leaving the first keys with the viewer's shortcuts.
    const { doc } = editor.state;
    const selection = position === undefined
      ? Selection.atEnd(doc)
      : Selection.near(doc.resolve(Math.min(doc.content.size, Math.max(0, position))));
    if (!selection.eq(editor.state.selection)) editor.view.dispatch(editor.state.tr.setSelection(selection));
    editor.view.focus();
  }, [editor, initial]);

  useLayoutEffect(() => {
    const readMarkdown = () => {
      try {
        return noteMarkdown(editor, pairs);
      } catch {
        return initial.markdown;
      }
    };

    const adopt = (markdown: string) => {
      // Local keystrokes first: they merge with the collaborator's text, and
      // the merged text comes back through here.
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current);
        pendingRef.current = null;
        callbacksRef.current.onChange(readMarkdown());
        return;
      }
      if (readMarkdown() === markdown) return;
      try {
        adoptMarkdown(editor, markdown);
      } catch {
        // A note mid-way through an edit may not parse; the next change will.
      }
    };

    handleRef.current = { getMarkdown: readMarkdown, adoptMarkdown: adopt };
    editorRef.current = editor;

    return () => {
      if (handleRef.current?.getMarkdown === readMarkdown) {
        handleRef.current = null;
      }

      // Unmounted without an explicit finish (page scrolled out of the render
      // window, viewer closed): keep what was typed.
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current);
        pendingRef.current = null;
        callbacksRef.current.onChange(readMarkdown());
      }
    };
  }, [editor, handleRef, initial, pairs]);

  return <EditorContent className="pdf-note-editor-host" editor={editor} />;
}
