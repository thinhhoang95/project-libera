"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { TagChip, collectAllTags } from "@/components/libera/file-tags";
import type { LiberaFileNode } from "@/lib/types";

type FileTagsDialogProps = {
  dialog: { file: LiberaFileNode; error: string; submitting: boolean } | null;
  fileTags: Record<string, string[]>;
  onClose: () => void;
  onSubmit: (tags: string[]) => Promise<void>;
};

export function FileTagsDialog({ dialog, fileTags, onClose, onSubmit }: FileTagsDialogProps) {
  const t = useTranslations("fileTagsDialog");
  const tCommon = useTranslations("common");
  if (!dialog) return null;

  return (
    <ModalDialog
      open
      title={t("title")}
      description={t("description", { name: dialog.file.name })}
      onClose={onClose}
      footer={
        <>
          <button className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted" type="button" onClick={onClose}>
            {tCommon("cancel")}
          </button>
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            form="file-tags-dialog-form"
            type="submit"
            disabled={dialog.submitting}
          >
            {dialog.submitting ? t("saving") : t("saveTags")}
          </button>
        </>
      }
    >
      <FileTagsForm
        key={dialog.file.path}
        initialTags={fileTags[dialog.file.path] ?? []}
        allTags={collectAllTags(fileTags)}
        error={dialog.error}
        onSubmit={onSubmit}
      />
    </ModalDialog>
  );
}

function FileTagsForm({ initialTags, allTags, error, onSubmit }: {
  initialTags: string[];
  allTags: string[];
  error: string;
  onSubmit: (tags: string[]) => Promise<void>;
}) {
  const t = useTranslations("fileTagsDialog");
  const [tags, setTags] = useState(initialTags);
  const [draft, setDraft] = useState("");
  const has = (tag: string) => tags.some((existing) => existing.toLowerCase() === tag.toLowerCase());
  const suggestions = useMemo(() => {
    const query = draft.trim().toLowerCase();
    return allTags
      .filter((tag) => !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase()))
      .filter((tag) => !query || tag.toLowerCase().includes(query))
      .slice(0, 12);
  }, [allTags, draft, tags]);

  function addTag(value: string) {
    const tag = value.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    if (tag && !has(tag)) setTags((current) => [...current, tag]);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === "Enter" || event.key === ",") && draft.trim()) {
      event.preventDefault();
      addTag(draft);
    } else if (event.key === "Backspace" && !draft && tags.length) {
      setTags((current) => current.slice(0, -1));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A tag still being typed counts, so Save doesn't silently drop it.
    const pending = draft.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    await onSubmit(pending && !has(pending) ? [...tags, pending] : tags);
  }

  return (
    <form className="space-y-3" id="file-tags-dialog-form" onSubmit={handleSubmit}>
      <label className="block text-sm font-medium text-foreground" htmlFor="file-tags-input">{t("tags")}</label>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-input px-2 py-1.5 focus-within:border-ring">
        {tags.map((tag) => (
          <TagChip key={tag} tag={tag} onRemove={() => setTags((current) => current.filter((existing) => existing !== tag))} />
        ))}
        <input
          id="file-tags-input"
          className="min-w-24 flex-1 bg-transparent px-1 text-sm outline-none"
          placeholder={tags.length ? t("addAnotherTag") : t("typeTagPrompt")}
          value={draft}
          maxLength={40}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
      </div>
      {suggestions.length ? (
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">{t("existingTags")}</p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((tag) => (
              <button key={tag} type="button" className="rounded-full" onClick={() => addTag(tag)} aria-label={t("addTagLabel", { tag })}>
                <TagChip tag={tag} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
