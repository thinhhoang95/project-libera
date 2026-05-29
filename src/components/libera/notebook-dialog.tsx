import { useState } from "react";
import type { FormEvent } from "react";
import { Check, Palette } from "lucide-react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { NotebookDialogState, NotebookFormValues } from "@/components/libera/types";

const NOTEBOOK_COLORS = [
  "#64748b",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

type NotebookDialogProps = {
  dialog: NotebookDialogState | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: NotebookFormValues) => Promise<void>;
};

export function NotebookDialog({
  dialog,
  submitting,
  onClose,
  onSubmit,
}: NotebookDialogProps) {
  if (!dialog) {
    return null;
  }

  const initialValues =
    dialog.mode === "edit"
      ? {
          name: dialog.notebook.name,
          color: dialog.notebook.color,
          emoji: dialog.notebook.emoji,
        }
      : {
          name: "",
          color: NOTEBOOK_COLORS[0],
          emoji: "📓",
        };

  return (
    <ModalDialog
      open
      title={dialog.mode === "create" ? "New notebook" : "Edit notebook"}
      description="Choose a name, color, and emoji for this notebook."
      onClose={onClose}
      footer={
        <>
          <button
            className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium hover:bg-muted"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            form="notebook-dialog-form"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "Saving" : dialog.mode === "create" ? "Create notebook" : "Save changes"}
          </button>
        </>
      }
    >
      <NotebookDialogForm
        key={dialog.mode === "edit" ? `edit:${dialog.notebook.path}` : "create"}
        error={dialog.error}
        initialValues={initialValues}
        onSubmit={onSubmit}
      />
    </ModalDialog>
  );
}

function NotebookDialogForm({
  error,
  initialValues,
  onSubmit,
}: {
  error?: string;
  initialValues: NotebookFormValues;
  onSubmit: (values: NotebookFormValues) => Promise<void>;
}) {
  const [values, setValues] = useState(initialValues);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(values);
  }

  return (
    <form className="space-y-4" id="notebook-dialog-form" onSubmit={handleSubmit}>
      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor="notebook-name">
          Name
        </label>
        <input
          id="notebook-name"
          className="mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring"
          value={values.name}
          onChange={(event) =>
            setValues((current) => ({ ...current, name: event.target.value }))
          }
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor="notebook-emoji">
          Emoji
        </label>
        <input
          id="notebook-emoji"
          className="mt-1 h-10 w-24 rounded-xl border border-input px-3 text-center text-lg outline-none transition focus:border-ring"
          value={values.emoji}
          maxLength={4}
          onChange={(event) =>
            setValues((current) => ({ ...current, emoji: event.target.value }))
          }
        />
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
          <Palette aria-hidden className="h-4 w-4" />
          Color
        </div>
        <div className="flex flex-wrap gap-2">
          {NOTEBOOK_COLORS.map((color) => (
            <button
              key={color}
              aria-label={`Select notebook color ${color}`}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border"
              style={{ backgroundColor: color }}
              type="button"
              onClick={() => setValues((current) => ({ ...current, color }))}
            >
              {values.color === color ? (
                <Check aria-hidden className="h-4 w-4 text-white drop-shadow" />
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
