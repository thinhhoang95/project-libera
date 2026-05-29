import { useState } from "react";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type {
  WorkspaceInputDialogState,
  WorkspaceInputDialogValues,
} from "@/components/libera/types";

type WorkspaceInputDialogProps = {
  dialog: WorkspaceInputDialogState | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: WorkspaceInputDialogValues) => Promise<void>;
};

function suggestedCopyName(name: string) {
  const extensionMatch = name.match(/(\.[^.]+)$/);
  const extension = extensionMatch?.[1] ?? "";
  const stem = extension ? name.slice(0, -extension.length) : name;

  return `${stem} copy${extension}`;
}

function parentPathForFilePath(filePath: string, notebook: string) {
  const parts = filePath.split("/");
  return parts.slice(0, -1).join("/") || notebook;
}

function getDialogContent(dialog: WorkspaceInputDialogState) {
  switch (dialog.mode) {
    case "create-folder":
      return {
        title: "New folder",
        description: `Create a folder in ${dialog.parentPath}.`,
        submitLabel: "Create folder",
        initialValues: {
          name: "New folder",
          destinationDirectory: "",
          destinationName: "",
        },
      };
    case "copy-file":
      return {
        title: "Copy file",
        description: `Copy ${dialog.file.name} to a notebook or folder.`,
        submitLabel: "Copy file",
        initialValues: {
          name: "",
          destinationDirectory: parentPathForFilePath(dialog.file.path, dialog.file.notebook),
          destinationName: suggestedCopyName(dialog.file.name),
        },
      };
    case "move-file":
      return {
        title: "Move file",
        description: `Move ${dialog.file.name} to a notebook or folder.`,
        submitLabel: "Move file",
        initialValues: {
          name: "",
          destinationDirectory: parentPathForFilePath(dialog.file.path, dialog.file.notebook),
          destinationName: "",
        },
      };
    case "rename-file":
      return {
        title: "Rename file",
        description: `Rename ${dialog.file.path}.`,
        submitLabel: "Rename file",
        initialValues: {
          name: dialog.file.name,
          destinationDirectory: "",
          destinationName: "",
        },
      };
    case "rename-folder":
      return {
        title: "Rename folder",
        description: `Rename ${dialog.folder.path}.`,
        submitLabel: "Rename folder",
        initialValues: {
          name: dialog.folder.name,
          destinationDirectory: "",
          destinationName: "",
        },
      };
  }
}

export function WorkspaceInputDialog({
  dialog,
  submitting,
  onClose,
  onSubmit,
}: WorkspaceInputDialogProps) {
  if (!dialog) {
    return null;
  }

  const content = getDialogContent(dialog);

  return (
    <ModalDialog
      open
      title={content.title}
      description={content.description}
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
            form="workspace-input-dialog-form"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "Saving" : content.submitLabel}
          </button>
        </>
      }
    >
      <WorkspaceInputDialogForm
        key={`${dialog.mode}:${"file" in dialog ? dialog.file.path : "folder" in dialog ? dialog.folder.path : dialog.parentPath}`}
        dialog={dialog}
        error={dialog.error}
        initialValues={content.initialValues}
        onSubmit={onSubmit}
      />
    </ModalDialog>
  );
}

function WorkspaceInputDialogForm({
  dialog,
  error,
  initialValues,
  onSubmit,
}: {
  dialog: WorkspaceInputDialogState;
  error?: string;
  initialValues: WorkspaceInputDialogValues;
  onSubmit: (values: WorkspaceInputDialogValues) => Promise<void>;
}) {
  const [values, setValues] = useState(initialValues);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(values);
  }

  return (
    <form className="space-y-4" id="workspace-input-dialog-form" onSubmit={handleSubmit}>
      {dialog.mode === "copy-file" || dialog.mode === "move-file" ? (
        <div>
          <label
            className="block text-sm font-medium text-foreground"
            htmlFor="workspace-destination-directory"
          >
            Destination notebook or folder path
          </label>
          <input
            id="workspace-destination-directory"
            className="mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring"
            value={values.destinationDirectory}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                destinationDirectory: event.target.value,
              }))
            }
            autoFocus
          />
        </div>
      ) : null}

      {dialog.mode === "copy-file" ? (
        <div>
          <label
            className="block text-sm font-medium text-foreground"
            htmlFor="workspace-destination-name"
          >
            Copy file name
          </label>
          <input
            id="workspace-destination-name"
            className="mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring"
            value={values.destinationName}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                destinationName: event.target.value,
              }))
            }
          />
        </div>
      ) : null}

      {dialog.mode === "create-folder" ||
      dialog.mode === "rename-file" ||
      dialog.mode === "rename-folder" ? (
        <div>
          <label
            className="block text-sm font-medium text-foreground"
            htmlFor="workspace-item-name"
          >
            Name
          </label>
          <input
            id="workspace-item-name"
            className="mt-1 h-10 w-full rounded-xl border border-input px-3 text-sm outline-none transition focus:border-ring"
            value={values.name}
            onChange={(event) =>
              setValues((current) => ({ ...current, name: event.target.value }))
            }
            autoFocus
          />
        </div>
      ) : null}

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
