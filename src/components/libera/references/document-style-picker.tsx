"use client";

import { Palette } from "lucide-react";
import { useId, useState } from "react";
import {
  isDocumentStyleSetting, readDocumentStyleForPath, requestDocumentStyleChange,
} from "@/lib/references/document-style";
import { BUNDLED_CSL_STYLES, DEFAULT_CSL_STYLE } from "@/lib/references/types";
import { useReferenceLibrary } from "./use-reference-library";

// The Document style control: the active document's own citation style
// (`citation-style` in its front matter, `$citation-style` in a slide deck;
// see references/document-style.ts), or the notebook's. Choosing a style
// writes or updates that line in the document's open draft, through the
// editor that holds it (DOCUMENT_STYLE_REQUEST_EVENT), as one undoable edit;
// "Notebook default" removes it. One element, so the References panel places
// it with a single line.

export type DocumentStylePickerProps = {
  notebook: string;
  /** Library path of the active document; untitled documents cannot be styled until saved. */
  documentPath: string | null;
  /** The active Markdown document's text (its draft), or null when none is active: nothing renders. */
  draft: string | null;
  /** The notebook's `.csl` files, offered after the bundled styles. */
  styleFiles?: readonly string[];
  className?: string;
};

function styleName(setting: string) {
  return BUNDLED_CSL_STYLES.find((style) => style.id === setting)?.label ?? setting.split("/").pop()!.replace(/\.csl$/i, "");
}

export function DocumentStylePicker({ notebook, documentPath, draft, styleFiles = [], className }: DocumentStylePickerProps) {
  const { library } = useReferenceLibrary(notebook || null);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  if (draft === null || !notebook) return null;

  const written = readDocumentStyleForPath(documentPath, draft);
  const valid = isDocumentStyleSetting(written);
  const notebookStyle = library?.style || DEFAULT_CSL_STYLE;
  const choices = [
    ...BUNDLED_CSL_STYLES.map((style) => ({ id: style.id as string, label: style.label as string })),
    ...styleFiles.filter((path) => !BUNDLED_CSL_STYLES.some((style) => style.id === path)).map((path) => ({ id: path, label: styleName(path) })),
  ];
  if (written && !choices.some((choice) => choice.id === written)) choices.push({ id: written, label: valid ? styleName(written) : `${written} (not a style)` });

  const choose = (value: string) => {
    if (!documentPath) return;
    const applied = requestDocumentStyleChange(documentPath, value || null);
    setProblem(applied ? null : "Open this document in an editor to change its style.");
  };

  return (
    <div className={className ?? "mx-3 mb-2 flex flex-col gap-1"} data-document-style-picker="">
      <label htmlFor={id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Palette aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">Document style</span>
        <select
          id={id}
          className="min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 py-1 text-xs text-foreground disabled:opacity-50"
          value={written ?? ""}
          disabled={!documentPath}
          title={documentPath ? "This document's citation style (its front matter)" : "Save the document to give it its own style"}
          onChange={(event) => choose(event.target.value)}
        >
          <option value="">Notebook default ({styleName(notebookStyle)})</option>
          {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
      </label>
      {written && !valid ? (
        <p role="status" className="text-[11px] text-destructive">“{written}” is not a bundled style or a .csl file, so the notebook’s style is used.</p>
      ) : null}
      {problem ? <p role="alert" className="text-[11px] text-destructive">{problem}</p> : null}
    </div>
  );
}
