import { useState } from "react";
import { useTranslations } from "next-intl";
import type { FormEvent } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import { DEFAULT_NEW_FOLDER_NAME, suggestedCopyName } from "@/components/libera/default-names";
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

function parentPathForFilePath(filePath: string, notebook: string) {
  const parts = filePath.split("/");
  return parts.slice(0, -1).join("/") || notebook;
}

function getDialogContent(dialog: WorkspaceInputDialogState, t: ReturnType<typeof useTranslations>) {
  switch (dialog.mode) {
    case "create-folder":
      return {
        title: t("newFolderTitle"),
        description: t("createFolderDescription", { parentPath: dialog.parentPath }),
        submitLabel: t("createFolderSubmit"),
        initialValues: {
          name: DEFAULT_NEW_FOLDER_NAME,
          destinationDirectory: "",
          destinationName: "",
        },
      };
    case "copy-file":
      return {
        title: t("copyFileTitle"),
        description: t("copyFileDescription", { name: dialog.file.name }),
        submitLabel: t("copyFileSubmit"),
        initialValues: {
          name: "",
          destinationDirectory: parentPathForFilePath(dialog.file.path, dialog.file.notebook),
          destinationName: suggestedCopyName(dialog.file.name),
        },
      };
    case "move-file":
      return {
        title: t("moveFileTitle"),
        description: t("moveFileDescription", { name: dialog.file.name }),
        submitLabel: t("moveFileSubmit"),
        initialValues: {
          name: "",
          destinationDirectory: parentPathForFilePath(dialog.file.path, dialog.file.notebook),
          destinationName: "",
        },
      };
    case "rename-file":
      return {
        title: t("renameFileTitle"),
        description: t("renameFileDescription", { path: dialog.file.path }),
        submitLabel: t("renameFileSubmit"),
        initialValues: {
          name: dialog.file.name,
          destinationDirectory: "",
          destinationName: "",
        },
      };
    case "rename-folder":
      return {
        title: t("renameFolderTitle"),
        description: t("renameFolderDescription", { path: dialog.folder.path }),
        submitLabel: t("renameFolderSubmit"),
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
  const t = useTranslations("workspaceInputDialog");
  if (!dialog) {
    return null;
  }

  const content = getDialogContent(dialog, t);

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
            {t("cancel")}
          </button>
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            form="workspace-input-dialog-form"
            type="submit"
            disabled={submitting}
          >
            {submitting ? t("saving") : content.submitLabel}
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
  const t = useTranslations("workspaceInputDialog");
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
            {t("destinationPathLabel")}
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
            {t("copyFileNameLabel")}
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
            {t("nameLabel")}
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
