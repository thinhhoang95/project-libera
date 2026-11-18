import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { WorkspaceConfirmDialogState } from "@/components/libera/types";

type WorkspaceConfirmDialogProps = {
  dialog: WorkspaceConfirmDialogState | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
};

function getDialogContent(dialog: WorkspaceConfirmDialogState, t: ReturnType<typeof useTranslations>) {
  switch (dialog.mode) {
    case "close-tab":
      return {
        title: t("closeTabTitle"),
        description: t("closeTabDescription", { fileName: dialog.fileName }),
        confirmLabel: t("closeTabConfirm"),
        destructive: true,
      };
    case "close-tabs":
      return {
        title: t("closeTabsTitle"),
        description: t("closeTabsDescription", { dirtyTabCount: dialog.dirtyTabCount, tabCount: dialog.tabCount }),
        confirmLabel: t("closeTabsConfirm", { tabCount: dialog.tabCount }),
        destructive: true,
      };
    case "delete-file":
      return {
        title: t("deleteFileTitle"),
        description: t("deleteFileDescription", { name: dialog.file.name }),
        confirmLabel: t("deleteFileConfirm"),
        destructive: true,
      };
    case "delete-folder":
      return {
        title: t("deleteFolderTitle"),
        description: t("deleteFolderDescription", { name: dialog.folder.name }),
        confirmLabel: t("deleteFolderConfirm"),
        destructive: true,
      };
    case "delete-notebook":
      return {
        title: t("deleteNotebookTitle"),
        description: t("deleteNotebookDescription", { notebook: dialog.notebook }),
        confirmLabel: t("deleteNotebookConfirm"),
        destructive: true,
      };
    case "remove-folder":
      return {
        title: t("removeFolderTitle"),
        description: t("removeFolderDescription", { dirtyTabCount: dialog.dirtyTabCount, notebook: dialog.notebook }),
        confirmLabel: t("removeFolderConfirm"),
        destructive: true,
      };
    case "move-file-node":
    case "move-file-folder":
      return {
        title: t("moveFileTitle"),
        description: t("moveFileDescription", { name: dialog.file.name }),
        confirmLabel: t("moveFileConfirm"),
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
  const t = useTranslations("workspaceConfirmDialog");
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
            className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${
              content.destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            }`}
            type="button"
            disabled={submitting}
            onClick={() => void onConfirm()}
          >
            {submitting ? t("working") : content.confirmLabel}
          </button>
        </>
      }
    >
      <div className="flex gap-3 rounded-lg border border-border bg-muted px-3 py-3 text-sm text-foreground">
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{t("cannotBeUndone")}</p>
      </div>
    </ModalDialog>
  );
}
