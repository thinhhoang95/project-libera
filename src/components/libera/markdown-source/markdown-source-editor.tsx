"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect, useState, type RefObject } from "react";
import { CodeMirrorTextareaAdapter } from "@/lib/markdown-codemirror/textarea-adapter";
import type { MarkdownSourceEditorProps } from "./types";

export type { MarkdownSourceEditorProps } from "./types";

// CodeMirror's Markdown grammar and code-block languages load only when a note
// opens in this editor, as the LaTeX and code editors do.
const MarkdownCodeMirrorEditor = dynamic(
  () => import("./markdown-codemirror-editor").then((module) => module.MarkdownCodeMirrorEditor),
  {
    ssr: false,
    loading: () => <div className="flex min-h-0 min-w-0 items-center justify-center border-b border-border bg-card text-sm text-muted-foreground lg:border-b-0 lg:border-r">Loading editor…</div>,
  },
);

/**
 * The CodeMirror Markdown Source editor ("Source editor: CodeMirror (beta)").
 *
 * The textarea-compatible adapter is created here, synchronously, rather than
 * in the lazily loaded editor: the workspace copies the pane's textarea ref in
 * a layout effect when the pane mounts, and restores selection and scroll in
 * the next frames, all before the editor chunk can have loaded. The adapter
 * keeps those requests until the view attaches.
 */
export function MarkdownSourceEditor(props: MarkdownSourceEditorProps) {
  const { textareaRef, value } = props;
  const [adapter] = useState(() => new CodeMirrorTextareaAdapter(value));

  useLayoutEffect(() => {
    const ref = textareaRef as RefObject<HTMLTextAreaElement | null>;
    const handle = adapter.asTextarea();
    ref.current = handle;
    return () => {
      if (ref.current === handle) ref.current = null;
    };
  }, [adapter, textareaRef]);

  // Until the view exists, the adapter answers with the latest draft.
  useLayoutEffect(() => {
    adapter.setDetachedValue(value);
  }, [adapter, value]);

  return <MarkdownCodeMirrorEditor {...props} adapter={adapter} />;
}
