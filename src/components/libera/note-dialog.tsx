import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { NoteDialogState, NoteFormValues } from "@/components/libera/types";

type NoteDialogProps = {
  dialog: NoteDialogState | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: NoteFormValues) => Promise<void>;
};

export function NoteDialog({
  dialog,
  submitting,
  onClose,
  onSubmit,
}: NoteDialogProps) {
  const t = useTranslations("noteDialog");
  const tCommon = useTranslations("common");
  if (!dialog) {
    return null;
  }

  const mode = dialog.mode === "slides" || dialog.mode === "latex" || dialog.mode === "text" ? dialog.mode : "note";

  return (
    <ModalDialog
      open
      title={t(`title.${mode}`)}
      description={t(`description.${mode}`, { location: dialog.parentPath ?? dialog.notebook })}
      onClose={onClose}
      footer={
        <>
          <button
            className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted"
            type="button"
            onClick={onClose}
          >
            {tCommon("cancel")}
          </button>
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            form="note-dialog-form"
            type="submit"
            disabled={submitting}
          >
            {submitting ? t("creating") : t(`create.${mode}`)}
          </button>
        </>
      }
    >
      <NoteDialogForm
        key={`${dialog.notebook}:${dialog.parentPath ?? ""}:${dialog.mode}`}
        error={dialog.error}
        initialValues={{
          name: dialog.mode === "slides" ? "Untitled.slides.md" : dialog.mode === "latex" ? "Untitled.tex" : dialog.mode === "text" ? "Untitled.txt" : "Untitled.md",
        }}
        onSubmit={onSubmit}
      />
    </ModalDialog>
  );
}

function NoteDialogForm({
  error,
  initialValues,
  onSubmit,
}: {
  error?: string;
  initialValues: NoteFormValues;
  onSubmit: (values: NoteFormValues) => Promise<void>;
}) {
  const t = useTranslations("noteDialog");
  const [values, setValues] = useState(initialValues);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(values);
  }

  return (
    <form className="space-y-4" id="note-dialog-form" onSubmit={handleSubmit}>
      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor="note-name">
          {t("nameLabel")}
        </label>
        <input
          id="note-name"
          className="mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring"
          value={values.name}
          onChange={(event) => setValues({ name: event.target.value })}
          autoFocus
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
