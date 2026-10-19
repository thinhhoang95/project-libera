"use client";

// The Markdown Source editor on a shared tab: always the CodeMirror editor
// (the Classic textarea cannot carry a binding), in "external" mode with the
// y-codemirror.next binding injected. Its content belongs to the Y.Text, so
// `value` is only the initial text and nothing it publishes becomes a draft:
// the workspace reads the shared text directly and mirrors it for preview.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { MarkdownSourceEditor, type MarkdownSourceEditorProps } from "@/components/libera/markdown-source/markdown-source-editor";
import type { SharedCodeMirrorBinding, SharedCodeMirrorSource } from "./react-codemirror";

export type SharedMarkdownSourceEditorProps = Omit<MarkdownSourceEditorProps, "value" | "onChange" | "onRegisterDraft" | "extensions" | "documentSource" | "onViewChange"> & {
  collab: SharedCodeMirrorSource;
  onViewChange?: (view: EditorView | null) => void;
};

const ignoreDraft = () => {};

export function SharedMarkdownSourceEditor({ collab, onViewChange, ...props }: SharedMarkdownSourceEditorProps) {
  // Created in a layout effect, not in render: under Strict Mode the first
  // binding is destroyed and the editor mounts with the second.
  const [binding, setBinding] = useState<SharedCodeMirrorBinding | null>(null);
  // Read by the view callback, which runs in the child's layout effect,
  // before this component's effects see the new state.
  const bindingRef = useRef<SharedCodeMirrorBinding | null>(null);
  const viewChangeRef = useRef(onViewChange);
  useLayoutEffect(() => { viewChangeRef.current = onViewChange; });
  useLayoutEffect(() => {
    const created = collab.create();
    bindingRef.current = created;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the binding must exist before the editor's own layout effect creates the view
    setBinding(created);
    return () => {
      if (bindingRef.current === created) bindingRef.current = null;
      created.destroy();
    };
  }, [collab]);

  const handleView = useCallback((view: EditorView | null) => {
    if (view) bindingRef.current?.attach(view);
    viewChangeRef.current?.(view);
  }, []);
  const extensions = useMemo(() => (binding ? [binding.extension] : []), [binding]);

  if (!binding) return null;
  return (
    <MarkdownSourceEditor
      {...props}
      value={binding.initialText}
      documentSource="external"
      extensions={extensions}
      onChange={ignoreDraft}
      onViewChange={handleView}
    />
  );
}
