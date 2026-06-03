import { useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type {
  NotebookGroupDialogState,
  NotebookGroupFormValues,
} from "@/components/libera/types";
import type { LiberaTree } from "@/lib/types";

type NotebookGroupDialogProps = {
  dialog: NotebookGroupDialogState | null;
  submitting: boolean;
  tree: LiberaTree;
  onClose: () => void;
  onSubmit: (values: NotebookGroupFormValues) => Promise<void>;
};

export function NotebookGroupDialog({
  dialog,
  submitting,
  tree,
  onClose,
  onSubmit,
}: NotebookGroupDialogProps) {
  if (!dialog) {
    return null;
  }

  const initialValues =
    dialog.mode === "edit"
      ? {
          title: dialog.group.title,
          description: dialog.group.description,
          notebookNames: tree.notebooks
            .filter((notebook) => notebook.groupId === dialog.group.id)
            .map((notebook) => notebook.name),
        }
      : {
          title: "",
          description: "",
          notebookNames: [],
        };

  return (
    <ModalDialog
      open
      title={dialog.mode === "create" ? "New group" : "Edit group"}
      description="Set the group details and choose the notebooks it contains."
      panelClassName="max-w-lg"
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
            form="notebook-group-dialog-form"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? "Saving"
              : dialog.mode === "create"
                ? "Create group"
                : "Save changes"}
          </button>
        </>
      }
    >
      <NotebookGroupDialogForm
        key={dialog.mode === "edit" ? `edit:${dialog.group.id}` : "create"}
        error={dialog.error}
        initialValues={initialValues}
        tree={tree}
        onSubmit={onSubmit}
      />
    </ModalDialog>
  );
}

function NotebookGroupDialogForm({
  error,
  initialValues,
  tree,
  onSubmit,
}: {
  error?: string;
  initialValues: NotebookGroupFormValues;
  tree: LiberaTree;
  onSubmit: (values: NotebookGroupFormValues) => Promise<void>;
}) {
  const [values, setValues] = useState(initialValues);
  const selectedNotebookNames = new Set(values.notebookNames);
  const notebooks = [...tree.notebooks].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(values);
  }

  function toggleNotebook(notebookName: string) {
    setValues((current) => {
      const nextNotebookNames = new Set(current.notebookNames);

      if (nextNotebookNames.has(notebookName)) {
        nextNotebookNames.delete(notebookName);
      } else {
        nextNotebookNames.add(notebookName);
      }

      return {
        ...current,
        notebookNames: [...nextNotebookNames],
      };
    });
  }

  return (
    <form className="space-y-4" id="notebook-group-dialog-form" onSubmit={handleSubmit}>
      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor="group-title">
          Title
        </label>
        <input
          id="group-title"
          className="mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring"
          value={values.title}
          onChange={(event) =>
            setValues((current) => ({ ...current, title: event.target.value }))
          }
          autoFocus
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor="group-description">
          Description
        </label>
        <textarea
          id="group-description"
          className="mt-1 min-h-24 w-full resize-y rounded-xl border border-input px-3 py-2 text-sm outline-none transition focus:border-ring"
          value={values.description}
          onChange={(event) =>
            setValues((current) => ({ ...current, description: event.target.value }))
          }
        />
      </div>

      <div>
        <div className="mb-2 text-sm font-medium text-foreground">Notebooks</div>
        {notebooks.length ? (
          <div className="max-h-56 overflow-auto rounded-lg border border-border">
            {notebooks.map((notebook) => (
              <label
                key={notebook.name}
                className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0 hover:bg-muted"
              >
                <input
                  className="h-4 w-4 rounded border-input"
                  type="checkbox"
                  checked={selectedNotebookNames.has(notebook.name)}
                  onChange={() => toggleNotebook(notebook.name)}
                />
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs"
                  style={{ backgroundColor: notebook.color, color: "#ffffff" }}
                >
                  {notebook.emoji}
                </span>
                <span className="min-w-0 truncate">{notebook.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-input px-4 py-6 text-sm text-muted-foreground">
            No notebooks are available.
          </div>
        )}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
