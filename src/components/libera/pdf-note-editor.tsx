"use client";

import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Placeholder } from "@tiptap/extensions";
import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createAnnotationMarkdownExtensions } from "@/lib/pdf-annotation-markdown";

// Serializing Markdown walks the whole document; coalesce it while typing.
const CHANGE_DEBOUNCE_MS = 160;

export type NoteCaret = { x: number; y: number };

export type PdfNoteEditorHandle = {
  getMarkdown: () => string;
};

type PdfNoteEditorProps = {
  caret?: NoteCaret;
  documentPath: string;
  handleRef: RefObject<PdfNoteEditorHandle | null>;
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onEscape: () => void;
};

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
  onChange,
  onEscape,
}: PdfNoteEditorProps) {
  const callbacksRef = useRef({ onChange, onEscape });
  const pendingRef = useRef<number | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // Mount-time values: later prop changes must not reset the document.
  const [initial] = useState(() => ({ caret, markdown: initialMarkdown }));
  const extensions = useMemo(
    () => [
      ...createAnnotationMarkdownExtensions(documentPath),
      Placeholder.configure({ placeholder: "Write a note… Markdown works" }),
    ],
    [documentPath],
  );

  useLayoutEffect(() => {
    callbacksRef.current = { onChange, onEscape };
  }, [onChange, onEscape]);

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
      handleKeyDown(_view, event) {
        if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
          event.preventDefault();
          callbacksRef.current.onEscape();
          return true;
        }

        return false;
      },
    },
    onCreate({ editor: createdEditor }) {
      const point = initial.caret;
      let position: number | undefined;

      try {
        // Start typing where the note was clicked; resting HTML and the editor
        // share typography, so the coordinates map onto the same text.
        position = point
          ? createdEditor.view.posAtCoords({ left: point.x, top: point.y })?.pos
          : undefined;
      } catch {
        position = undefined;
      }

      createdEditor.commands.focus(position ?? "end", { scrollIntoView: false });
    },
    onUpdate({ editor: updatedEditor }) {
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current);
      }

      pendingRef.current = window.setTimeout(() => {
        pendingRef.current = null;
        callbacksRef.current.onChange(updatedEditor.getMarkdown());
      }, CHANGE_DEBOUNCE_MS);
    },
  });

  useLayoutEffect(() => {
    const readMarkdown = () => {
      try {
        return editor.getMarkdown();
      } catch {
        return initial.markdown;
      }
    };

    handleRef.current = { getMarkdown: readMarkdown };
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
  }, [editor, handleRef, initial]);

  return <EditorContent className="pdf-note-editor-host" editor={editor} />;
}
