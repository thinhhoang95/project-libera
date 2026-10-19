"use client";

// Reconciliation view (collaboration map §7.3): a shared file changed on disk
// while the shared document changed too. Neither side was overwritten; the
// user compares the three texts and keeps a merged result, which the host
// applies to the document as their edits and writes back to the file.
//
// The comparison is a read-only @codemirror/merge view over one pair at a
// time (base ↔ disk, base ↔ shared, disk ↔ shared): three panes side by side
// do not fit next to an editor. The merged text is a plain textarea so it
// works with every input method and screen reader.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { useEffect, useId, useRef, useState } from "react";

import type { Reconciliation } from "@/lib/collab/local-api";
import { resolveReconciliation } from "./reconcile-api";

type Pair = "disk" | "shared" | "both";

const PAIRS: Array<{ id: Pair; label: string; a: keyof Texts; b: keyof Texts; aLabel: string; bLabel: string }> = [
  { id: "disk", label: "Changes on disk", a: "base", b: "disk", aLabel: "Last synced", bLabel: "File on disk" },
  { id: "shared", label: "Changes in the shared document", a: "base", b: "shared", aLabel: "Last synced", bLabel: "Shared document" },
  { id: "both", label: "Disk and shared side by side", a: "disk", b: "shared", aLabel: "File on disk", bLabel: "Shared document" },
];

type Texts = Pick<Reconciliation, "base" | "disk" | "shared">;

const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping];

function MergeComparison({ a, b, label }: { a: string; b: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const view = new MergeView({
      a: { doc: a, extensions: readOnly },
      b: { doc: b, extensions: readOnly },
      parent,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    return () => view.destroy();
  }, [a, b]);
  return <div ref={host} role="region" aria-label={label} className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-background text-sm [&_.cm-mergeView]:min-h-24" />;
}

export function ReconcileView({
  reconciliation,
  onResolved,
  onCancel,
}: {
  reconciliation: Reconciliation;
  /** Called with the kept text after the host applied it. */
  onResolved?: (result: { docId: string; text: string }) => void;
  onCancel?: () => void;
}) {
  const [pair, setPair] = useState<Pair>("both");
  const [merged, setMerged] = useState(reconciliation.shared);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const mergedId = useId();
  const descriptionId = useId();
  const current = PAIRS.find((candidate) => candidate.id === pair) ?? PAIRS[2];
  const texts: Texts = reconciliation;

  async function keep(text: string) {
    setSubmitting(true);
    setError("");
    try {
      const result = await resolveReconciliation(reconciliation.id, text);
      onResolved?.(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The merged text could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  const buttonClass = "rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-60";

  return (
    <section className="space-y-4" aria-labelledby={`${mergedId}-title`} aria-describedby={descriptionId}>
      <header className="space-y-1">
        <h2 id={`${mergedId}-title`} className="text-base font-semibold">
          Reconcile {reconciliation.path}
        </h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          This file was changed on disk while the shared document changed too. Nothing was overwritten. Choose what to keep;
          it is saved to the shared document as your edit and written back to the file.
        </p>
      </header>

      <div role="group" aria-label="Compare" className="flex flex-wrap gap-2">
        {PAIRS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={`${buttonClass} ${candidate.id === pair ? "bg-accent font-medium" : ""}`}
            aria-pressed={candidate.id === pair}
            onClick={() => setPair(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs font-medium text-muted-foreground" aria-hidden="true">
        <span>{current.aLabel}</span>
        <span>{current.bLabel}</span>
      </div>
      <MergeComparison a={texts[current.a]} b={texts[current.b]} label={`${current.aLabel} compared with ${current.bLabel}`} />

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void keep(merged);
        }}
      >
        <fieldset disabled={submitting} className="space-y-2 disabled:opacity-60">
          <label htmlFor={mergedId} className="block text-sm font-medium">
            Merged result
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => setMerged(reconciliation.disk)}>
              Start from the file on disk
            </button>
            <button type="button" className={buttonClass} onClick={() => setMerged(reconciliation.shared)}>
              Start from the shared document
            </button>
          </div>
          <textarea
            id={mergedId}
            className="h-64 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
            spellCheck={false}
            value={merged}
            onChange={(event) => setMerged(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="libera-dialog-actions flex justify-end gap-2 pt-2">
            {onCancel ? (
              <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm" onClick={onCancel}>
                Later
              </button>
            ) : null}
            <button type="submit" className="libera-dialog-primary">
              {submitting ? "Saving…" : "Keep merged text"}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
