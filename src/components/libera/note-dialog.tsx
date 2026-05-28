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
  if (!dialog) {
    return null;
  }

  return (
    <ModalDialog
      open
      title="New note"
      description={`Create a Markdown note in ${dialog.notebook}.`}
      onClose={onClose}
      footer={
        <>
          <button
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-md bg-zinc-950 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            form="note-dialog-form"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "Creating" : "Create note"}
          </button>
        </>
      }
    >
      <NoteDialogForm
        key={dialog.notebook}
        error={dialog.error}
        initialValues={{ name: "Untitled.md" }}
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
  const [values, setValues] = useState(initialValues);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(values);
  }

  return (
    <form className="space-y-4" id="note-dialog-form" onSubmit={handleSubmit}>
      <div>
        <label className="block text-sm font-medium text-zinc-700" htmlFor="note-name">
          Name
        </label>
        <input
          id="note-name"
          className="mt-1 h-10 w-full rounded-md border border-zinc-300 px-3 text-sm outline-none transition focus:border-zinc-950"
          value={values.name}
          onChange={(event) => setValues({ name: event.target.value })}
          autoFocus
        />
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
