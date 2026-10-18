"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { Editor } from "@tiptap/core";

export const TIPTAP_DRAFT_DELAY_MS = 250;
export type RegisterEditorDraft = (tabId: string, read: () => string) => () => void;

/**
 * A shared tab's content: the Visual bridge keeps ProseMirror and the shared
 * Y.Text in step, so this hook neither publishes drafts nor replaces the
 * document. `text` reads the shared text (the tab's draft).
 */
export type SharedTiptapDraft = { text: () => string };

// ProseMirror owns the live document. Serialize only after a typing pause or
// when a consumer (save, review, tab switch, export) needs an exact snapshot.
export function useTiptapDraft(
  editor: Editor | null,
  value: string,
  lastValueRef: RefObject<string>,
  onChange: (markdown: string) => void,
  onRegisterDraft?: (read: () => string) => () => void,
  shared?: SharedTiptapDraft | null,
) {
  const current = useRef({ editor, onChange });
  const pending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => { current.current = { editor, onChange }; }, [editor, onChange]);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = false;
  }, []);

  const sharedRef = useRef(shared);
  useLayoutEffect(() => { sharedRef.current = shared; }, [shared]);
  const isShared = !!shared;

  const read = useCallback(() => {
    const sharedDraft = sharedRef.current;
    if (sharedDraft) {
      lastValueRef.current = sharedDraft.text();
      return lastValueRef.current;
    }
    const { editor: live, onChange: publish } = current.current;
    if (pending.current && live && !live.isDestroyed) {
      const markdown = live.getMarkdown();
      cancel();
      if (markdown !== lastValueRef.current) {
        lastValueRef.current = markdown;
        publish(markdown);
      }
    }
    return lastValueRef.current;
  }, [cancel, lastValueRef]);

  const replace = useCallback((markdown: string) => {
    // Never a whole-document setContent on a shared tab: the workspace
    // applied the new text to the Y.Text and the bridge brings it in.
    if (sharedRef.current) return;
    cancel();
    lastValueRef.current = markdown;
    current.current.editor?.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
  }, [cancel, lastValueRef]);

  useLayoutEffect(() => {
    if (!editor || isShared) return;
    const schedule = () => {
      pending.current = true;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        // Do not serialize intermediate IME input or disturb its selection.
        if (editor.view.composing) schedule();
        else read();
      }, TIPTAP_DRAFT_DELAY_MS);
    };
    editor.on("update", schedule);
    editor.on("blur", read);
    window.addEventListener("pagehide", read);
    const unregister = onRegisterDraft?.(read);
    return () => {
      read();
      cancel();
      unregister?.();
      editor.off("update", schedule);
      editor.off("blur", read);
      window.removeEventListener("pagehide", read);
    };
  }, [editor, read, cancel, onRegisterDraft, isShared]);

  useLayoutEffect(() => {
    // Parent echoes must not reset selection/history or cancel newer typing.
    if (editor && !isShared && value !== lastValueRef.current) replace(value);
  }, [editor, value, lastValueRef, replace, isShared]);

  return { read, replace, pending };
}
