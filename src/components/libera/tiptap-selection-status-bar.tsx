"use client";

import { useEffect, useState, type ComponentProps } from "react";
import type { Editor } from "@tiptap/core";
import { MarkdownStatusBar } from "@/components/libera/markdown-status-bar";

/** How long the selection must stay still before its text is extracted and counted. */
export const SELECTION_TEXT_DELAY_MS = 150;

type StatusBarProps = Omit<ComponentProps<typeof MarkdownStatusBar>, "selectedText">;

/**
 * The Visual editor's status bar. The selected text lives here, not in the
 * editor component: every step of a drag would otherwise re-render the whole
 * editor. A collapsed selection clears the counts at once; a range is read
 * once, after it has stopped changing.
 */
export function TiptapSelectionStatusBar({ editor, ...props }: StatusBarProps & { editor: Editor | null }) {
  const [selectedText, setSelectedText] = useState("");
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      timer = undefined;
      if (editor.state.selection.empty) {
        setSelectedText("");
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (editor.isDestroyed) return;
        const current = editor.state.selection;
        setSelectedText(current.empty ? "" : editor.state.doc.textBetween(current.from, current.to, "\n"));
      }, SELECTION_TEXT_DELAY_MS);
    };
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("selectionUpdate", update);
      clearTimeout(timer);
    };
  }, [editor]);
  return <MarkdownStatusBar {...props} selectedText={selectedText} />;
}
