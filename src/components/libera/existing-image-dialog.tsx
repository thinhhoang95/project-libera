"use client";

import { Image as ImageIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { encodeFilePath } from "@/components/libera/api-client";
import { ModalDialog } from "@/components/libera/modal-dialog";
import type { LiberaFileNode, LiberaNotebookNode, LiberaTreeNode } from "@/lib/types";

type ExistingImageDialogProps = {
  notebook?: LiberaNotebookNode;
  open: boolean;
  onClose: () => void;
  onSelect: (file: LiberaFileNode) => Promise<void>;
};

function collectImageFiles(nodes: LiberaTreeNode[]) {
  const images: LiberaFileNode[] = [];

  for (const node of nodes) {
    if (node.kind === "folder") {
      images.push(...collectImageFiles(node.children));
      continue;
    }

    if (node.fileType === "image") {
      images.push(node);
    }
  }

  return images;
}

function rawFileUrl(file: LiberaFileNode) {
  return `/api/files/raw/${encodeFilePath(file.path)}`;
}

export function ExistingImageDialog({
  notebook,
  open,
  onClose,
  onSelect,
}: ExistingImageDialogProps) {
  const images = useMemo(
    () => (notebook ? collectImageFiles(notebook.children) : []),
    [notebook],
  );
  const [selectedPath, setSelectedPath] = useState("");
  const selectedImage = images.find((image) => image.path === selectedPath);

  async function insertSelectedImage() {
    if (!selectedImage) {
      return;
    }

    await onSelect(selectedImage);
  }

  return (
    <ModalDialog
      open={open}
      title="Image from existing"
      description={
        notebook
          ? `Select an image from ${notebook.name}.`
          : "Select an image from the current notebook."
      }
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
            type="button"
            disabled={!selectedImage}
            onClick={() => void insertSelectedImage()}
          >
            Insert image
          </button>
        </>
      }
    >
      {images.length ? (
        <div className="grid max-h-[60vh] gap-3 overflow-auto sm:grid-cols-2">
          {images.map((image) => (
            <button
              key={image.path}
              className={`overflow-hidden rounded-md border text-left ${
                selectedPath === image.path
                  ? "border-zinc-950 ring-2 ring-zinc-950/10"
                  : "border-zinc-200 hover:border-zinc-400"
              }`}
              type="button"
              onClick={() => setSelectedPath(image.path)}
              onDoubleClick={() => void onSelect(image)}
            >
              <span className="block aspect-[4/3] bg-zinc-100">
                {/* eslint-disable-next-line @next/next/no-img-element -- Authenticated local file URLs should not use Next image optimization. */}
                <img
                  alt={image.name}
                  className="h-full w-full object-cover"
                  src={rawFileUrl(image)}
                />
              </span>
              <span className="block min-w-0 px-3 py-2">
                <span className="block truncate text-sm font-medium">{image.name}</span>
                <span className="block truncate text-xs text-zinc-500">{image.path}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-zinc-300 px-4 py-8 text-sm text-zinc-500">
          <ImageIcon aria-hidden className="h-4 w-4" />
          No images are available in this notebook.
        </div>
      )}
    </ModalDialog>
  );
}
