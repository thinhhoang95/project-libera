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
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import type { Reconciliation } from "@/lib/collab/local-api";
import { ReconcileError, resolveReconciliation } from "./reconcile-api";

type Pair = "disk" | "shared" | "both";

type Side = "lastSynced" | "fileOnDisk" | "sharedDocument";

/** Labels are the `pairs.{id}` and `sides.{side}` messages. */
const PAIRS: Array<{ id: Pair; a: keyof Texts; b: keyof Texts; aSide: Side; bSide: Side }> = [
  { id: "disk", a: "base", b: "disk", aSide: "lastSynced", bSide: "fileOnDisk" },
  { id: "shared", a: "base", b: "shared", aSide: "lastSynced", bSide: "sharedDocument" },
  { id: "both", a: "disk", b: "shared", aSide: "fileOnDisk", bSide: "sharedDocument" },
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
  const t = useTranslations("collab.reconcile.reconcileView");
  const tCommon = useTranslations("common");
  const [reviewed] = useState(reconciliation);
  const [pair, setPair] = useState<Pair>("both");
  const [merged, setMerged] = useState(reviewed.shared);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const mergedId = useId();
  const descriptionId = useId();
  const current = PAIRS.find((candidate) => candidate.id === pair) ?? PAIRS[2];
  const texts: Texts = reviewed;

  async function keep(text: string) {
    setSubmitting(true);
    setError("");
    try {
      const result = await resolveReconciliation(reviewed.id, text, { shared: reviewed.shared, disk: reviewed.disk });
      onResolved?.(result);
    } catch (failure) {
      setError(failure instanceof ReconcileError ? failure.serverMessage || t("requestFailed", { status: failure.status }) : failure instanceof Error ? failure.message : t("saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  const buttonClass = "rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-60";

  return (
    <section className="space-y-4" aria-labelledby={`${mergedId}-title`} aria-describedby={descriptionId}>
      <header className="space-y-1">
        <h2 id={`${mergedId}-title`} className="text-base font-semibold">
          {t("title", { path: reconciliation.path })}
        </h2>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {t("description")}
        </p>
      </header>

      <div role="group" aria-label={t("compare")} className="flex flex-wrap gap-2">
        {PAIRS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={`${buttonClass} ${candidate.id === pair ? "bg-accent font-medium" : ""}`}
            aria-pressed={candidate.id === pair}
            onClick={() => setPair(candidate.id)}
          >
            {t(`pairs.${candidate.id}`)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs font-medium text-muted-foreground" aria-hidden="true">
        <span>{t(`sides.${current.aSide}`)}</span>
        <span>{t(`sides.${current.bSide}`)}</span>
      </div>
      <MergeComparison a={texts[current.a]} b={texts[current.b]} label={t("comparedWith", { a: t(`sides.${current.aSide}`), b: t(`sides.${current.bSide}`) })} />

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void keep(merged);
        }}
      >
        <fieldset disabled={submitting} className="space-y-2 disabled:opacity-60">
          <label htmlFor={mergedId} className="block text-sm font-medium">
            {t("mergedResult")}
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => setMerged(reviewed.disk)}>
              {t("startFromDisk")}
            </button>
            <button type="button" className={buttonClass} onClick={() => setMerged(reviewed.shared)}>
              {t("startFromShared")}
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
                {t("later")}
              </button>
            ) : null}
            <button type="submit" className="libera-dialog-primary">
              <span className="libera-btn-label">{submitting ? tCommon("saving") : t("keepMerged")}</span>
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
