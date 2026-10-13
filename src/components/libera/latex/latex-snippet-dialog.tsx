"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { latexSnippetNameError, normalizeLatexSnippetName } from "../../../../electron/latex-snippets.cjs";
import type { LatexSnippet } from "@/lib/latex/snippets";
import { createLatexSnippet, renameLatexSnippet, useLatexSnippets } from "./latex-snippets-store";

export type LatexSnippetDialogRequest = { mode: "create"; body: string } | { mode: "rename"; snippet: LatexSnippet };

/** A free name for new code: its first environment or command, numbered when taken. */
function suggestName(body: string, snippets: LatexSnippet[]) {
  const base = (/\\begin\s*\{([A-Za-z]+)\*?\}/.exec(body)?.[1] ?? /\\([A-Za-z]+)/.exec(body)?.[1] ?? "snippet").toLowerCase();
  const taken = new Set(snippets.map((snippet) => snippet.name.toLocaleLowerCase()));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index++;
  return `${base}-${index}`;
}

export function LatexSnippetDialog({ request, onClose }: { request: LatexSnippetDialogRequest; onClose: () => void }) {
  const snippets = useLatexSnippets();
  const formId = useId();
  const [name, setName] = useState(() => request.mode === "rename" ? request.snippet.name : suggestName(request.body, snippets));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const body = request.mode === "rename" ? request.snippet.body : request.body;
  const normalized = normalizeLatexSnippetName(name);
  const nameError = latexSnippetNameError(normalized, snippets, request.mode === "rename" ? request.snippet.id : undefined);
  const unchanged = request.mode === "rename" && normalized === request.snippet.name;

  async function save() {
    setTouched(true);
    if (nameError || saving) return;
    if (unchanged) { onClose(); return; }
    setSaving(true);
    setError("");
    try {
      if (request.mode === "rename") await renameLatexSnippet(request.snippet.id, normalized);
      else await createLatexSnippet(normalized, body);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the snippet.");
      setSaving(false);
    }
  }

  return (
    <ModalDialog
      open
      title={request.mode === "rename" ? "Rename snippet" : "Add as snippet"}
      description={request.mode === "rename"
        ? "Type the new name after a slash in the editor to insert this snippet."
        : "Saved snippets are kept with your preferences. Insert them from the Snippets menu, or type /name in the editor."}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <button type="button" className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            form={formId}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={saving || (touched && !!nameError)}
          >
            {saving ? <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> : null}
            {request.mode === "rename" ? "Rename" : "Save snippet"}
          </button>
        </div>
      }
    >
      <form id={formId} className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
          Name
          <span className="flex items-center rounded-lg border border-border bg-card focus-within:ring-2 focus-within:ring-ring">
            <span aria-hidden className="pl-2.5 font-mono text-sm text-muted-foreground">/</span>
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent py-1.5 pl-0.5 pr-2.5 font-mono text-sm outline-none"
              value={name}
              maxLength={80}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={touched && !!nameError}
              aria-describedby={`${formId}-hint`}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => { setName(event.target.value); setTouched(true); setError(""); }}
            />
          </span>
          <span id={`${formId}-hint`} className={`text-xs font-normal ${touched && nameError ? "text-destructive" : "text-muted-foreground"}`}>
            {touched && nameError ? nameError : "Letters, numbers, hyphens and underscores."}
          </span>
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-foreground">LaTeX</span>
          <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-xs leading-relaxed text-foreground">{body}</pre>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </form>
    </ModalDialog>
  );
}
