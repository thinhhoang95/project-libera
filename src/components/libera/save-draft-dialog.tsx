"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { OpenTab } from "@/components/libera/types";
import type { LiberaTree, LiberaTreeNode } from "@/lib/types";

export function SaveDraftDialog({ tab, tree, error, submitting, onClose, onSubmit }: {
  tab: OpenTab;
  tree: LiberaTree;
  error: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (name: string, directory: string) => Promise<void>;
}) {
  const t = useTranslations("saveDraftDialog");
  const tCommon = useTranslations("common");
  const directories: string[] = [];
  function collect(nodes: LiberaTreeNode[]) {
    for (const node of nodes) {
      if (node.kind === "folder") { directories.push(node.path); collect(node.children); }
    }
  }
  for (const notebook of tree.notebooks) {
    directories.push(notebook.name);
    collect(notebook.children);
  }
  const [name, setName] = useState(tab.file.name);
  const [directory, setDirectory] = useState(directories.includes(tab.saveDirectory ?? "") ? tab.saveDirectory! : "");
  const fieldClass = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

  return (
    <ModalDialog open title={t("title")} description={t("description")} onClose={onClose}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void onSubmit(name, directory); }}>
        <fieldset disabled={submitting} className="space-y-4 disabled:opacity-60">
          <label className="block text-sm font-medium">
            {t("fileName")}
            <input autoFocus required className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} onFocus={(event) => event.target.select()} />
          </label>
          <label className="block text-sm font-medium">
            {t("saveTo")}
            <select className={fieldClass} value={directory} onChange={(event) => setDirectory(event.target.value)}>
              <option value="">{t("independentFile")}</option>
              {directories.map((path) => <option key={path} value={path}>{path}</option>)}
            </select>
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="libera-dialog-actions flex justify-end gap-2 pt-2">
            <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm" onClick={onClose}>{tCommon("cancel")}</button>
            <button type="submit" className="libera-dialog-primary"><span className="libera-btn-label">{submitting ? tCommon("saving") : tCommon("save")}</span></button>
          </div>
        </fieldset>
      </form>
    </ModalDialog>
  );
}
