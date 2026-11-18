import { useTranslations } from "next-intl";
import { useState } from "react";
import type { FormEvent } from "react";
import { BookOpen } from "lucide-react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type {
  NotebookGroupDialogState,
  NotebookGroupFormValues,
} from "@/components/libera/types";
import type { LiberaTree, LiberaTreeNode } from "@/lib/types";

function countNotebookContents(nodes: LiberaTreeNode[]): { notes: number; files: number } {
  return nodes.reduce((counts, node) => {
    if (node.kind === "folder") {
      const nested = countNotebookContents(node.children);
      counts.notes += nested.notes;
      counts.files += nested.files;
    } else if (node.fileType === "markdown") {
      counts.notes += 1;
    } else {
      counts.files += 1;
    }
    return counts;
  }, { notes: 0, files: 0 });
}

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
  const t = useTranslations("notebookGroupDialog");
  const tCommon = useTranslations("common");
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
      sectioned
      title={dialog.mode === "create" ? t("createGroupTitle") : t("editGroupTitle")}
      description={t("description")}
      panelClassName="max-w-[640px]"
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
            form="notebook-group-dialog-form"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? t("saving")
              : dialog.mode === "create"
                ? t("createGroup")
                : t("saveChanges")}
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
  const t = useTranslations("notebookGroupDialog");
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
      <div className="libera-dialog-section space-y-4">
      <div>
        <label className="block text-sm font-medium text-foreground" htmlFor="group-title">
          {t("groupNameLabel")}
        </label>
        <input
          id="group-title"
          placeholder={t("groupNamePlaceholder")}
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
          {t("descriptionLabel")}
        </label>
        <textarea
          id="group-description"
          placeholder={t("descriptionPlaceholder")}
          className="mt-1 min-h-20 w-full resize-y rounded-xl border border-input px-3 py-2 text-sm outline-none transition focus:border-ring"
          value={values.description}
          onChange={(event) =>
            setValues((current) => ({ ...current, description: event.target.value }))
          }
        />
      </div>
      </div>

      <div className="libera-dialog-section">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-accent"><BookOpen aria-hidden className="h-6 w-6" /></span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold tracking-tight">{t("chooseNotebooks")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("chooseNotebooksHint")}</p>
          </div>
          <div className="text-right text-xs">
            <p className="text-accent" aria-live="polite">{t("selectedCount", { count: values.notebookNames.length })}</p>
            <p className="mt-1 text-muted-foreground">{t("notebooksAvailable", { count: notebooks.length })}</p>
          </div>
        </div>
        {notebooks.length ? (
          <div className="max-h-72 overflow-auto rounded-xl border border-border">
            {notebooks.map((notebook) => {
              const counts = countNotebookContents(notebook.children);
              return (
              <label
                key={notebook.name}
                className="flex cursor-pointer items-center gap-4 border-b border-border px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted has-[:checked]:bg-muted"
              >
                <input
                  className="h-4 w-4 rounded border-input"
                  type="checkbox"
                  checked={selectedNotebookNames.has(notebook.name)}
                  onChange={() => toggleNotebook(notebook.name)}
                />
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base shadow-sm"
                  style={{ backgroundColor: notebook.color, color: "#ffffff" }}
                >
                  {notebook.emoji}
                </span>
                <span className="min-w-0">
                  <span className="block truncate">{notebook.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t("noteFileCounts", counts)}</span>
                </span>
              </label>
            ); })}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-input px-4 py-6 text-sm text-muted-foreground">
            {t("noNotebooks")}
          </div>
        )}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
