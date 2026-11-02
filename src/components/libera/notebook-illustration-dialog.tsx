"use client";

import { Check, Images, Landmark, Loader2, Shuffle, Sparkles } from "lucide-react";
import { useState } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { useNotebookIllustrationLibrary } from "@/components/libera/use-notebook-illustrations";
import type { LiberaNotebookNode } from "@/lib/types";

type NotebookIllustrationDialogProps = {
  notebook: LiberaNotebookNode;
  coverUrl: string;
  onChange: (notebook: string, illustration: string | null) => Promise<void>;
  onClose: () => void;
};

/**
 * Picks a notebook's cover from any illustration set, or hands it back to
 * the chosen set's random pick. The picked image is copied into the notebook.
 */
export function NotebookIllustrationDialog({ notebook, coverUrl, onChange, onClose }: NotebookIllustrationDialogProps) {
  const library = useNotebookIllustrationLibrary();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const selectedSet = library.sets.find((set) => set.id === library.selected) ?? library.sets[0];
  const isRandom = !notebook.illustrationPath;
  // The chosen set first, then the rest in Preferences order.
  const sets = [...library.sets].sort((a, b) => Number(b.id === library.selected) - Number(a.id === library.selected));

  async function choose(key: string, illustration: string | null) {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await onChange(notebook.name, illustration);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the illustration.");
      setBusy(null);
    }
  }

  return (
    <ModalDialog
      open
      title="Change illustration"
      description={`Choose the picture across the top of ${notebook.name}. It is copied into the notebook, so it stays even if its set is deleted.`}
      panelClassName="max-w-3xl"
      onClose={onClose}
    >
      <div className="flex max-h-[min(62vh,620px)] flex-col gap-5 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-2.5">
            <span
              aria-hidden
              className="aspect-[3/1] w-32 shrink-0 rounded-lg bg-cover bg-center"
              style={{ backgroundImage: `url("${coverUrl}")` }}
            />
            <div className="min-w-0 text-sm">
              <p className="font-semibold">Current</p>
              <p className="text-xs text-[var(--muted-foreground)]">{isRandom ? `Random from ${selectedSet?.name ?? "the chosen set"}` : "Picked for this notebook"}</p>
            </div>
          </div>
          <button
            type="button"
            disabled={isRandom || Boolean(busy)}
            onClick={() => void choose("random", null)}
            className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-2.5 text-left transition hover:border-[var(--accent)] disabled:cursor-default disabled:opacity-60 disabled:hover:border-[var(--border)]"
          >
            <span className="flex aspect-[3/1] w-32 shrink-0 items-center justify-center rounded-lg bg-[var(--muted)] text-[var(--accent)]">
              {busy === "random" ? <Loader2 aria-hidden className="h-5 w-5 animate-spin" /> : <Shuffle aria-hidden className="h-5 w-5" />}
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-semibold">Random</span>
              <span className="block text-xs text-[var(--muted-foreground)]">
                {isRandom ? "In use" : `Let ${selectedSet?.name ?? "the chosen set"} pick, and remove the copy`}
              </span>
            </span>
          </button>
        </div>

        {sets.map((set) => (
          <section key={set.id} aria-label={set.name}>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[var(--muted-foreground)]">
              {set.id === "vietnamese-monuments" ? <Landmark aria-hidden className="h-3.5 w-3.5 text-[var(--accent)]" />
                : set.builtIn ? <Sparkles aria-hidden className="h-3.5 w-3.5 text-[var(--accent)]" />
                : <Images aria-hidden className="h-3.5 w-3.5 text-[var(--accent)]" />}
              {set.name}
              <span className="font-medium normal-case tracking-normal">· {set.images.length}</span>
              {set.id === library.selected ? (
                <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] normal-case tracking-normal text-[var(--foreground)]">
                  <Check aria-hidden className="h-3 w-3" /> Chosen in Preferences
                </span>
              ) : null}
            </h3>
            {set.images.length ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {set.images.map((image, index) => {
                  const key = `${set.id}/${image.id}`;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={Boolean(busy)}
                      title={`${set.name} ${index + 1}`}
                      aria-label={`${set.name}, illustration ${index + 1}`}
                      onClick={() => void choose(key, image.url)}
                      className="group relative overflow-hidden rounded-lg outline-none ring-[var(--accent)] ring-offset-2 ring-offset-[var(--dialog-surface)] transition focus-visible:ring-2 disabled:cursor-default"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- local, authenticated images */}
                      <img src={image.url} alt="" loading="lazy" decoding="async" draggable={false} className="block aspect-[3/1] w-full object-cover transition group-hover:scale-[1.03]" />
                      {busy === key ? (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
                          <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-[var(--muted-foreground)]">This set has no illustrations.</p>
            )}
          </section>
        ))}
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      </div>
    </ModalDialog>
  );
}
