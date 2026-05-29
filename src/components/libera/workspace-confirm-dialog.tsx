import { AlertTriangle } from "lucide-react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { WorkspaceConfirmDialogState } from "@/components/libera/types";

type WorkspaceConfirmDialogProps = {
  dialog: WorkspaceConfirmDialogState | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
};

function getDialogContent(dialog: WorkspaceConfirmDialogState) {
  switch (dialog.mode) {
    case "close-tab":
      return {
        title: "Close unsaved note",
        description: `${dialog.fileName} has unsaved edits.`,
        confirmLabel: "Close without saving",
        destructive: true,
      };
    case "delete-file":
      return {
        title: "Delete file",
        description: `Delete ${dialog.file.name}?`,
        confirmLabel: "Delete file",
        destructive: true,
      };
    case "delete-folder":
      return {
        title: "Delete folder",
        description: `Delete ${dialog.folder.name} and everything inside it?`,
        confirmLabel: "Delete folder",
        destructive: true,
      };
    case "delete-notebook":
      return {
        title: "Delete notebook",
        description: `Delete ${dialog.notebook} and all files inside it?`,
        confirmLabel: "Delete notebook",
        destructive: true,
      };
    case "move-file-node":
    case "move-file-folder":
      return {
        title: "Move unsaved file",
        description: `${dialog.file.name} has unsaved edits.`,
        confirmLabel: "Move without saving",
        destructive: false,
      };
  }
}

export function WorkspaceConfirmDialog({
  dialog,
  submitting,
  onClose,
  onConfirm,
}: WorkspaceConfirmDialogProps) {
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
            className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
              content.destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
            type="button"
            disabled={submitting}
            onClick={() => void onConfirm()}
          >
            {submitting ? "Working" : content.confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex gap-3 rounded-lg border border-border bg-muted px-3 py-3 text-sm text-foreground">
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <p>This action cannot be undone automatically.</p>
      </div>
    </ModalDialog>
  );
}
