"use client";

import { useEffect, useMemo, useState } from "react";
import { folderOptions } from "@/components/libera/image-generation-panel";
import { announceImageSaved, imageFile, subscribeSaveToNotebook, type ImageSaveSource } from "@/components/libera/image-save";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { LiberaFileNode, LiberaTree } from "@/lib/types";

const FOLDER_STORAGE_KEY = "libera.saveImage.folder";

function readStoredFolder() {
  try { return window.localStorage.getItem(FOLDER_STORAGE_KEY) ?? ""; } catch { return ""; }
}

/** Picks a notebook folder for an image a viewer asked to save there (requestSaveToNotebook). */
export function SaveImageToNotebookDialog({ tree, onUpload }: {
  tree: LiberaTree;
  onUpload: (notebook: string, files: File[], destinationPath: string, options: { throwOnError: true }) => Promise<LiberaFileNode[]>;
}) {
  const [source, setSource] = useState<ImageSaveSource | null>(null);

  useEffect(() => subscribeSaveToNotebook(setSource), []);

  if (!source) return null;
  return <SaveImageForm key={source.src} source={source} tree={tree} onUpload={onUpload} onClose={() => setSource(null)} />;
}

function SaveImageForm({ source, tree, onUpload, onClose }: {
  source: ImageSaveSource;
  tree: LiberaTree;
  onUpload: (notebook: string, files: File[], destinationPath: string, options: { throwOnError: true }) => Promise<LiberaFileNode[]>;
  onClose: () => void;
}) {
  const folders = useMemo(() => folderOptions(tree), [tree]);
  const [name, setName] = useState(source.name);
  const [folder, setFolder] = useState(() => {
    const stored = readStoredFolder();
    return folders.some((option) => option.path === stored) ? stored : folders[0]?.path ?? "";
  });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fieldClass = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

  async function submit() {
    const fileName = name.trim();
    if (!fileName || !folder) return;
    setSubmitting(true);
    setError("");
    try {
      const file = await imageFile({ ...source, name: fileName });
      const uploaded = await onUpload(folder.split("/")[0], [file], folder, { throwOnError: true });
      if (!uploaded.length) throw new Error("Could not save the image.");
      try { window.localStorage.setItem(FOLDER_STORAGE_KEY, folder); } catch { /* storage unavailable */ }
      announceImageSaved(source.src, `Saved to ${folder.replaceAll("/", " / ")}`);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the image.");
      setSubmitting(false);
    }
  }

  return (
    <ModalDialog open title="Save to notebook folder" description="Save a copy of this image into a notebook." onClose={onClose}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset disabled={submitting} className="space-y-4 disabled:opacity-60">
          <label className="block text-sm font-medium">
            File name
            <input autoFocus required className={fieldClass} value={name} onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.target.setSelectionRange(0, event.target.value.lastIndexOf(".") > 0 ? event.target.value.lastIndexOf(".") : event.target.value.length)} />
          </label>
          <label className="block text-sm font-medium">
            Folder
            <select required className={fieldClass} value={folder} onChange={(event) => setFolder(event.target.value)}>
              {folders.length ? null : <option value="">No notebooks yet</option>}
              {folders.map((option) => <option key={option.path} value={option.path}>{option.label}</option>)}
            </select>
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div className="libera-dialog-actions flex justify-end gap-2 pt-2">
            <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
            <button type="submit" className="libera-dialog-primary" disabled={!folder || !name.trim()}>{submitting ? "Saving…" : "Save"}</button>
          </div>
        </fieldset>
      </form>
    </ModalDialog>
  );
}
